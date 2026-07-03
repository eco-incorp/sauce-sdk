/**
 * Off-chain LOWER-BOUND estimate of the whole-trade tokenOut the EcoSwap split produces,
 * used ONLY to derive the on-chain solver's internal amountOutMin floor (cfg[9]). It does
 * NOT feed the split args, so it can NEVER change the wei-exact split.
 *
 * WHY A LOWER BOUND. The floor's contract is: a legitimate wei-exact fill must NEVER
 * false-revert. So `expectedTotalOut` must be <= the output the on-chain solver actually
 * realizes; then `minOut = expectedTotalOut * (10000 - slipBps) / 10000` sits strictly
 * below the true fill and only ever fires on a genuine (large) shortfall. This estimator
 * is intentionally CONSERVATIVE — it under-counts, never over-counts:
 *
 *   - Direct V3/V4 pools: walk each pool's frontier over ONLY the lens-scanned net window
 *     (the same drift-invariant nets the solver caches), valuing each constant-L slice at
 *     its EXACT over-slice output L*(nearOI-farOI)/2^96. Stopping at the window edge (never
 *     staticcalling deeper, as the solver would) can only OMIT deeper output, so the sum is
 *     a lower bound. The oracle's `v3Segments` walk is mirrored; this estimator reuses the
 *     SAME multiplicative stepReal grid, so the per-slice prices agree with the solver.
 *   - Direct V2 pools (incl. Kyber on virtual reserves): the exact constant-L geometric
 *     stream, valued per slice — bounded by a slice cap for termination.
 *   - Sampled-segment venues (Curve/LB/DODO/Solidly/Wombat/Balancer/Euler/Maverick/Crypto/
 *     WOOFi/Fermi/Fluid/Mento/Balancer-V3): each prepared bracket is a FLAT post-fee slice
 *     ({capacity, marginalOI}); its output is capacity*marginalOI^2/2^192 (exact for a flat
 *     slice), prorated on a partial fill.
 *   - Multi-hop routes: NOT counted (a route only ADDS output; omitting it lowers the floor
 *     → still a lower bound, still safe). Routes are rare and their live composition is best
 *     valued on-chain, not re-derived here.
 *
 * All venues' price-monotone slices are merged in ONE descending fee-adjusted-price order
 * (the SAME order the solver's k-way merge consumes) and water-filled up to amountIn; the
 * awarded per-slice output is summed. The result is the expected whole-trade output floor.
 *
 * TIGHTNESS CAVEAT (why the derived floor is often FAR below the nominal `slipBps` band, yet
 * still correct). The V3/V4 walk only counts boundaries present in the shipped windowed net
 * (`p.netRows`). In the common LIVE-WALK / 1-RPC quote path the lens ships NO net rows
 * (windowTop=0 ⇒ the solver staticcalls every boundary live), so `v3Slices` emits only the
 * FIRST constant-L spot slice per V3/V4 pool and then breaks at the first `!net.has(sh)`. The
 * estimate then covers only that pool's spot-slice output — a much LOWER lower bound than the
 * true fill (empirically ~50% below realized), so the derived `minOut` sits well under
 * `expected*(1 - slipBps)`. That is on the SAFE side (it can only relax the floor, never
 * false-revert a wei-exact fill), but it means the internal floor guards against a GROSS
 * shortfall, not a tight `slipBps` band, UNLESS a net-cache window is shipped (then the walk
 * extends across the windowed boundaries and the estimate tightens). Integrators wanting a tight
 * whole-trade minimum should enforce their own around cook() (or pass an explicit `opts.minOut`).
 */

import type { EcoSwapPrepared, EcoPool } from "../shared/types.js";

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const FEE_DENOM = 1_000_000n;
const V2_STEP_BPS = 25n;
const V2_STEP_DEN = 10_000n;
const HALF128 = 1n << 127n;
const MOD128 = 1n << 128n;
// Per-pool slice cap — matches the solver/oracle PER_POOL budget so the estimator's walk
// terminates the same way (it never needs to exceed what the solver could fill).
const MAX_SLICES = 2048;

function isqrt(x: bigint): bigint {
  if (x <= 0n) return 0n;
  let z = x;
  let y = (z + 1n) / 2n;
  while (y < z) {
    z = y;
    y = (x / y + y) / 2n;
  }
  return z;
}

function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  return (a * b) / c;
}

/** sqrt(1 - fee) scaled by 1e6 — the SAME fee-adjust the merge sorts on (matches prepare/oracle). */
function sqrtOneMinusFeeScaled(feePpm: number): bigint {
  return isqrt(BigInt(1_000_000 - feePpm) * FEE_DENOM);
}

function feeAdjOI(oi: bigint, feePpm: number): bigint {
  return (oi * sqrtOneMinusFeeScaled(feePpm)) / FEE_DENOM;
}

/** Convert a real pool sqrt (token1/token0) into unified out/in sqrt — mirrors the solver. */
function toOutIn(sqrtReal: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? sqrtReal : Q192 / sqrtReal;
}

/** Next REAL sqrt one tickSpacing step in the swap direction (multiplicative) — mirrors the solver. */
function stepReal(sqrtReal: bigint, stepRatio: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? mulDiv(sqrtReal, Q96, stepRatio) : mulDiv(sqrtReal, stepRatio, Q96);
}

/** One price-monotone slice competing in the global descending-price merge. */
interface Slice {
  /** fee-adjusted out/in price at the near edge — DESC sort key. */
  adjNear: bigint;
  /** fee-adjusted out/in price at the far edge — the near-tie break. */
  adjFar: bigint;
  /** gross tokenIn (incl. fee) to fully traverse this slice. */
  gross: bigint;
  /** tokenOut produced by fully traversing this slice. */
  effOut: bigint;
}

/**
 * Enumerate a direct V3/V4 pool's frontier slices over the lens-scanned net window. Mirrors
 * the oracle's `v3Segments` (multiplicative stepReal, out/in integration, ±liquidityNet) but
 * uses ONLY the windowed `net` prepare shipped (`netRows` shifted-tick → rawNet) — stopping at
 * the window edge, which can only omit deeper output (lower bound). effOut is the EXACT
 * over-slice output L*(nearOI-farOI)/2^96.
 */
function v3Slices(p: EcoPool, out: Slice[]): void {
  const ts = p.tickSpacing;
  const stepRatio = p.stepRatio ?? 0n;
  const spot = p.spotNearReal ?? 0n;
  const liveL = p.spotActiveL ?? 0n;
  // spotTickShifted is the AUTHORITATIVE first boundary (shifted) prepare stamps — it ALREADY
  // includes the +ts for oneForZero (stampPoolCache: spotBoundary = zeroForOne ? base : base+ts),
  // so it is used verbatim (do NOT re-add ts).
  if (ts <= 0 || stepRatio <= 0n || spot <= 0n || p.spotTickShifted === undefined) return;
  const zfo = p.inIsToken0;
  const feePpm = p.feePpm;
  // Windowed net map: shifted tick -> raw uint128 net (as the solver reads it from netCache).
  const net = new Map<bigint, bigint>();
  for (const r of p.netRows ?? []) net.set(r.shiftedTick, r.rawNet);

  let L = liveL;
  let nearReal = spot;
  let sh = p.spotTickShifted;

  for (let k = 0; k < MAX_SLICES; k++) {
    const farReal = stepReal(nearReal, stepRatio, zfo);
    const nearOI = toOutIn(nearReal, zfo);
    const farOI = toOutIn(farReal, zfo);
    if (L > 0n && nearOI > farOI && farOI > 0n) {
      const effIn = mulDiv(L, Q96, farOI) - mulDiv(L, Q96, nearOI);
      if (effIn > 0n) {
        const gross = mulDiv(effIn, FEE_DENOM, FEE_DENOM - BigInt(feePpm));
        const effOut = mulDiv(L, nearOI - farOI, Q96);
        if (gross > 0n && effOut > 0n) {
          out.push({
            adjNear: feeAdjOI(nearOI, feePpm),
            adjFar: feeAdjOI(farOI, feePpm),
            gross,
            effOut,
          });
        }
      }
    }
    // Boundary net — ONLY from the window (undefined ⇒ we've walked past the shipped data → stop:
    // walking on with an unknown net would guess liquidity we can't verify, risking over-count).
    if (!net.has(sh)) break;
    const raw = net.get(sh)!;
    const neg = raw >= HALF128;
    if (zfo) {
      if (neg) L = L + (MOD128 - raw);
      else L = L >= raw ? L - raw : 0n;
      sh = sh - BigInt(ts);
    } else {
      if (neg) {
        const mag = MOD128 - raw;
        L = L >= mag ? L - mag : 0n;
      } else {
        L = L + raw;
      }
      sh = sh + BigInt(ts);
    }
    nearReal = farReal;
  }
}

/** Enumerate a direct V2 pool's constant-L geometric slices (Kyber uses the virtual reserves). */
function v2Slices(p: EcoPool, out: Slice[]): void {
  const spot = p.spotNearReal ?? 0n; // for V2 prepare seeds the out/in spot here
  const L = p.spotActiveL ?? 0n; // and L = isqrt(reserveIn*reserveOut) here
  if (spot <= 0n || L <= 0n) return;
  const feePpm = p.feePpm;
  let near = spot;
  for (let i = 0; i < MAX_SLICES; i++) {
    const far = near - mulDiv(near, V2_STEP_BPS, V2_STEP_DEN);
    if (far <= 0n || far >= near) break;
    const effIn = mulDiv(L, Q96, far) - mulDiv(L, Q96, near);
    if (effIn > 0n) {
      const gross = mulDiv(effIn, FEE_DENOM, FEE_DENOM - BigInt(feePpm));
      const effOut = mulDiv(L, near - far, Q96);
      if (gross > 0n && effOut > 0n) {
        out.push({ adjNear: feeAdjOI(near, feePpm), adjFar: feeAdjOI(far, feePpm), gross, effOut });
      }
    }
    near = far;
  }
}

/**
 * LOWER-BOUND estimate of the whole-trade tokenOut the split produces for `amountIn`.
 * Returns 0n when nothing is estimable (no direct pools + no sampled venues) — then the
 * floor is disabled (minOut 0), which is the safe default.
 */
export function estimateExpectedOutput(prepared: EcoSwapPrepared, amountIn: bigint): bigint {
  if (amountIn <= 0n) return 0n;
  const slices: Slice[] = [];

  // Direct pools (universe prefix) — V3/V4 walk the windowed net; V2/Kyber stream constant-L.
  // Route-leg pools are NOT walked here (routes are omitted from the estimate → lower bound).
  for (const p of prepared.pools) {
    if (p.isV2) v2Slices(p, slices);
    else v3Slices(p, slices);
  }

  // Sampled-segment venues — each prepared bracket is a FLAT post-fee slice: sqrtAdjNear ==
  // sqrtAdjFar == marginalOI, capacity = gross tokenIn. Exact over-slice output = capacity *
  // marginalOI^2 / 2^192 (out = in * price^2 in unified out/in space). Routes never appear in
  // `brackets` (always []); every bracket here is a sampled-source segment.
  for (const b of prepared.brackets) {
    const m = b.sqrtAdjNear;
    if (b.capacity > 0n && m > 0n) {
      const effOut = mulDiv(b.capacity, m * m, Q192);
      if (effOut > 0n) {
        slices.push({ adjNear: m, adjFar: b.sqrtAdjFar, gross: b.capacity, effOut });
      }
    }
  }

  if (slices.length === 0) return 0n;

  // Global price-descending merge (adjNear DESC, then adjFar DESC) — the SAME order the on-chain
  // k-way merge and the neutral oracle consume, so the water-filled prefix matches the solver's
  // awarded set (to the wei on the priced path; conservative where the window truncates).
  slices.sort((a, b) => {
    if (a.adjNear !== b.adjNear) return a.adjNear < b.adjNear ? 1 : -1;
    if (a.adjFar !== b.adjFar) return a.adjFar < b.adjFar ? 1 : -1;
    return 0;
  });

  let cum = 0n;
  let out = 0n;
  for (const s of slices) {
    if (cum >= amountIn) break;
    if (s.gross <= 0n) continue;
    if (cum + s.gross <= amountIn) {
      cum += s.gross;
      out += s.effOut;
    } else {
      // Partial fill of the crossing slice — prorate the output linearly by input fraction
      // (a flat slice is exact; a V3 slice's true partial output is slightly higher near the
      // entry, so the linear prorate is a lower bound → still safe).
      const take = amountIn - cum;
      out += mulDiv(s.effOut, take, s.gross);
      cum = amountIn;
      break;
    }
  }
  return out;
}
