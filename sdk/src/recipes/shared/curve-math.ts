/**
 * Curve StableSwap — VERBATIM bigint replay + off-chain segment sampler.
 *
 * THE SINGLE SOURCE for Curve math. Imported by BOTH:
 *   - the production `prepare.ts` (buildCurveSegments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (curveSegments),
 * so the split is exact-on-grid vs the oracle by construction (one replay), and the
 * per-pool executed `dy == get_dy(awarded share)` to the wei (one atomic exchange).
 *
 * THE CURVE MATH IS OFF-CHAIN ONLY. The on-chain solver does NOT recompute the
 * StableSwap invariant (no Newton in SauceScript). prepare samples Curve into
 * (capacity, marginalOI) SEGMENTS via this exact replay; the on-chain solver consumes
 * them as STATIC segments through the existing static-segment cursor (the same machinery
 * the merge already uses for route segments), and EXECUTES each Curve pool via the engine
 * swap(SwapParams{poolType:3, …}) → live _swapCurve (int128 coin indices i,j). No engine
 * change.
 *
 * SOURCE MIRRORED — Curve `StableSwap` plain-pool Vyper (the canonical 2..N-coin pool;
 * e.g. 3pool `0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7` and the StableSwap-NG plain
 * pool). The integer routines reproduced bit-for-bit:
 *   - `get_D(xp, amp)`           — Newton on D, bounded 255 iterations, ±1 convergence.
 *   - `get_y(i, j, x, xp, amp)`  — Newton on the new j-balance, bounded 255 iterations.
 *   - `get_dy(i, j, dx)`         — rates[]/PRECISION scaling + the 1e10-denominated fee.
 * `A_PRECISION = 100` and `Ann = A * A_PRECISION * N` is the modern plain-pool / NG
 * convention (older pools predating A_PRECISION are the A_PRECISION=1 special case — pass
 * `aPrecision: 1n`). Coin balances are scaled to a common 1e18 unit via `rates[]`
 * (rates[k] = 10**18 * PRECISION_MUL[k], where PRECISION_MUL[k] = 10**(18 - decimals[k])).
 * The swap fee is in units of 1e10 (`FEE_DENOMINATOR_CURVE = 1e10`); a pool's `fee()` is
 * already 1e10-scaled (e.g. 0.04% = 4_000_000).
 *
 * The replay is BOUNDED (255-iteration Newton, exactly Curve's loop bound) — no unbounded
 * loops. It runs purely on the read pool state (balances/rates/A/fee); buildCurveSegments
 * makes NO extra RPC.
 */

import { pushMonotoneSegment } from "./segment-merge.js";

/** 2^192 — the unified out/in sqrt fixed-point scale (matches ecoswap.math Q192). */
export const Q192 = 1n << 192n;

/** Integer square root (Babylonian) — bit-identical to prepare.ts / ecoswap.math `isqrt`. */
export function isqrt(x: bigint): bigint {
  if (x <= 0n) return 0n;
  let z = x;
  let y = (z + 1n) / 2n;
  while (y < z) {
    z = y;
    y = (x / y + y) / 2n;
  }
  return z;
}

/** Curve fee denominator — pool fees are 1e10-scaled (NOT ppm). */
export const FEE_DENOMINATOR_CURVE = 10_000_000_000n;
/** Modern plain-pool / StableSwap-NG amplification precision. Older pools: pass 1n. */
export const A_PRECISION_DEFAULT = 100n;

/**
 * One discovered Curve plain pool, oriented for a tokenIn → tokenOut swap.
 *
 * StableSwap uses int128 coin indices (i = tokenIn coin, j = tokenOut coin) — the engine
 * `_swapCurve` ABI. `balances` and `rates` are the FULL coin arrays (length N), in the
 * pool's native coin order; `i`/`j` index into them. `A` is the raw amplification the pool
 * reports from `A()` (NOT pre-multiplied by A_PRECISION — the replay multiplies). `feePpm10`
 * is the pool `fee()` in 1e10 units. CryptoSwap / uint256-index pools are OUT of scope.
 */
export interface CurvePool {
  /** Always SwapPoolType.Curve (=3) — execution dispatches via swap(SwapParams{poolType:3}). */
  poolType: number;
  /** Pool address (the StableSwap contract — exchange(i, j, dx, min_dy) target). */
  address: `0x${string}`;
  /** int128 coin index of tokenIn. */
  i: number;
  /** int128 coin index of tokenOut. */
  j: number;
  /** Amplification coefficient as reported by A() (raw — replay scales by aPrecision). */
  A: bigint;
  /** A_PRECISION (100 for modern/NG pools, 1 for legacy). */
  aPrecision: bigint;
  /** Full coin balances (native order, length N). */
  balances: bigint[];
  /**
   * Per-coin rate multipliers (length N). rates[k] scales coin k's balance into the common
   * 1e18 unit: xp[k] = balances[k] * rates[k] / 1e18. For a plain pool with no LP-rate
   * (constant rates) this is 10**18 * 10**(18 - decimals[k]).
   */
  rates: bigint[];
  /** Swap fee in 1e10 units (pool `fee()`; e.g. 4_000_000 = 0.04%). */
  feePpm10: bigint;
  /**
   * StableSwap-NG dynamic-fee multiplier (`offpeg_fee_multiplier()`, 1e10-scaled) — OPTIONAL.
   *
   * NG plain pools charge a DYNAMIC fee: the base `feePpm10` is scaled UP the further the two
   * swapped coins' post-swap balances sit off peg (imbalanced pools pay more). When this is set
   * AND exceeds `FEE_DENOMINATOR_CURVE`, `getDy` applies the NG `_dynamic_fee` formula (below) so
   * the replay is wei-exact against an NG pool's `get_dy`/`exchange`. When omitted (or ≤ the
   * denominator), `getDy` uses the FLAT `feePpm10` — the legacy/plain-pool behavior — so this is a
   * strict backward-compatible superset (a legacy pool, or the CurveStableSwap.sol test fixture,
   * needs no change). Curve `Stableswap-NG` semantics.
   */
  offpegFeeMultiplier?: bigint;
  /** Discovery source label. */
  source: string;
}

const PRECISION = 10n ** 18n;

/** xp[k] = balances[k] * rates[k] / 1e18 — balances rescaled into the common 1e18 unit. */
function xpFromBalances(balances: bigint[], rates: bigint[]): bigint[] {
  const xp = new Array<bigint>(balances.length);
  for (let k = 0; k < balances.length; k++) xp[k] = (balances[k] * rates[k]) / PRECISION;
  return xp;
}

/**
 * get_D — the StableSwap invariant D for the rescaled balances `xp` and amplification
 * `amp` (= A * A_PRECISION). Newton iteration, bounded to 255 steps, ±1 convergence.
 * Mirrors Curve `StableSwap.get_D` bit-for-bit (the A_PRECISION-aware variant):
 *
 *   Ann = amp * N
 *   D_P = D; for each x in xp: D_P = D_P * D / (x * N)
 *   D = (Ann*S/A_PRECISION + D_P*N) * D
 *        / ((Ann - A_PRECISION)*D/A_PRECISION + (N+1)*D_P)
 */
export function getD(xp: bigint[], amp: bigint, aPrecision: bigint): bigint {
  const N = BigInt(xp.length);
  let S = 0n;
  for (const x of xp) S += x;
  if (S === 0n) return 0n;

  const Ann = amp * N;
  let D = S;
  for (let it = 0; it < 255; it++) {
    let D_P = D;
    for (const x of xp) {
      // D_P = D_P * D / (x * N) — guards a zero balance exactly as the Vyper does.
      D_P = (D_P * D) / (x * N);
    }
    const Dprev = D;
    D =
      (((Ann * S) / aPrecision + D_P * N) * D) /
      (((Ann - aPrecision) * D) / aPrecision + (N + 1n) * D_P);
    // ±1 convergence — identical to Curve's `if D > Dprev: if D - Dprev <= 1: break`.
    if (D > Dprev) {
      if (D - Dprev <= 1n) break;
    } else {
      if (Dprev - D <= 1n) break;
    }
  }
  return D;
}

/**
 * get_y — given coin i moved to balance `x` (in xp units), solve for coin j's new balance
 * (xp units) holding D constant. Newton iteration, bounded 255 steps, ±1 convergence.
 * Mirrors Curve `StableSwap.get_y` bit-for-bit:
 *
 *   c = D; S_ = 0
 *   for k in N (k != j): _x = (k==i ? x : xp[k]); S_ += _x; c = c*D/(_x*N)
 *   c = c*D*A_PRECISION/(Ann*N)
 *   b = S_ + D*A_PRECISION/Ann
 *   y = D; y = (y*y + c) / (2*y + b - D)   (until ±1)
 */
export function getY(
  i: number,
  j: number,
  x: bigint,
  xp: bigint[],
  amp: bigint,
  aPrecision: bigint,
): bigint {
  const N = BigInt(xp.length);
  const D = getD(xp, amp, aPrecision);
  const Ann = amp * N;

  let c = D;
  let S_ = 0n;
  for (let k = 0; k < xp.length; k++) {
    if (k === j) continue;
    const _x = k === i ? x : xp[k];
    S_ += _x;
    c = (c * D) / (_x * N);
  }
  c = (c * D * aPrecision) / (Ann * N);
  const b = S_ + (D * aPrecision) / Ann;

  let y = D;
  for (let it = 0; it < 255; it++) {
    const yPrev = y;
    y = (y * y + c) / (2n * y + b - D);
    if (y > yPrev) {
      if (y - yPrev <= 1n) break;
    } else {
      if (yPrev - y <= 1n) break;
    }
  }
  return y;
}

/**
 * StableSwap-NG `_dynamic_fee` — the off-peg-scaled swap fee (1e10 units) for the two swapped
 * coins' post-swap balances `xpi`, `xpj` (both in the common 1e18 xp unit). Mirrors the NG Vyper:
 *
 *   if offpeg <= FEE_DENOMINATOR: return fee            # multiplier disabled ⇒ flat fee
 *   xps2 = (xpi + xpj) ** 2
 *   return (offpeg * fee) /
 *          ((offpeg - FEE_DENOMINATOR) * 4 * xpi * xpj / xps2 + FEE_DENOMINATOR)
 *
 * At peg (xpi == xpj) the `4·xpi·xpj/(xpi+xpj)²` term is 1 ⇒ the denominator is `offpeg` ⇒ the
 * result is exactly `fee`; the further off peg, the smaller that term ⇒ the larger the fee. `getDy`
 * passes the two MIDPOINTS `(xp[i]+x)/2`, `(xp[j]+y)/2` (old+new per coin), exactly as the NG Vyper.
 * The `4·a·b/(a+b)²` ratio is scale-invariant, so a common factor between the two args cancels —
 * but the args must be the OLD+NEW midpoints (what NG passes), not the new balances alone.
 */
export function dynamicFee(xpi: bigint, xpj: bigint, fee: bigint, offpeg: bigint): bigint {
  if (offpeg <= FEE_DENOMINATOR_CURVE) return fee;
  const xps2 = (xpi + xpj) * (xpi + xpj);
  return (
    (offpeg * fee) /
    (((offpeg - FEE_DENOMINATOR_CURVE) * 4n * xpi * xpj) / xps2 + FEE_DENOMINATOR_CURVE)
  );
}

/**
 * get_dy — the exact tokens-out for `dx` tokenIn (i → j), INCLUDING the swap fee.
 * Mirrors Curve `StableSwap.get_dy` bit-for-bit (the rates[]-scaled, post-`get_y` form):
 *
 *   rates = pool.rates
 *   xp    = _xp_mem(rates, balances)
 *   x     = xp[i] + dx * rates[i] / PRECISION
 *   y     = get_y(i, j, x, xp)
 *   dy    = (xp[j] - y - 1)                       # -1: round DOWN in the pool's favor
 *   fee   = _fee * dy / FEE_DENOMINATOR
 *   return (dy - fee) * PRECISION / rates[j]
 *
 * `_fee` is the FLAT `feePpm10` for a legacy/plain pool, or the NG `_dynamic_fee` (scaled by the
 * post-swap off-peg imbalance) when `offpegFeeMultiplier` is set and > FEE_DENOMINATOR — matching
 * a StableSwap-NG pool's `get_dy`/`exchange` to the wei. The `-1` and the integer fee truncation
 * are the canonical rounding; reproduced exactly so the off-chain dy equals the engine `_swapCurve`
 * exchange() output to the wei.
 */
export function getDy(pool: CurvePool, dx: bigint): bigint {
  if (dx <= 0n) return 0n;
  const amp = pool.A * pool.aPrecision;
  const xp = xpFromBalances(pool.balances, pool.rates);
  const x = xp[pool.i] + (dx * pool.rates[pool.i]) / PRECISION;
  const y = getY(pool.i, pool.j, x, xp, amp, pool.aPrecision);
  let dy = xp[pool.j] - y - 1n; // round down in the pool's favor
  if (dy <= 0n) return 0n;
  // NG dynamic fee: scale the base fee by the two swapped coins' MID off-peg imbalance — the args
  // are the (old + new)/2 midpoints per coin, exactly `_dynamic_fee((xp[i]+x)/2, (xp[j]+y)/2)` in
  // the NG Vyper (xp[i]/xp[j] are the OLD balances, x/y the NEW), NOT the post-swap balances alone.
  const feeRate =
    pool.offpegFeeMultiplier !== undefined
      ? dynamicFee(
          (xp[pool.i] + x) / 2n,
          (xp[pool.j] + y) / 2n,
          pool.feePpm10,
          pool.offpegFeeMultiplier,
        )
      : pool.feePpm10;
  const fee = (feeRate * dy) / FEE_DENOMINATOR_CURVE;
  dy = dy - fee;
  return (dy * PRECISION) / pool.rates[pool.j];
}

/**
 * One sampled Curve segment in unified out/in price space — the SAME shape the static-
 * segment merge consumes (a route segment is identical: a flat [capacity, marginalOI]
 * slice). `capacity` is the Δinput (tokenIn) for this slice, `effOut` the Δoutput, and
 * `marginalOI` the unified out/in sqrt = isqrt(Δout * 2^192 / Δin) — the price-ordering
 * coordinate. Segments are emitted in DESCENDING `marginalOI` order (the natural order of
 * a convex curve: the first marginal slice is the best-priced).
 *
 * NOTE on fee-adjust: a Curve segment's `marginalOI` is computed from the POST-FEE dy
 * (get_dy already nets the fee), so it is ALREADY the fee-adjusted execution price — it
 * enters the merge's descending-price sort directly (no extra sqrtOneMinusFee multiply, the
 * fee is baked into dy). This matches how route segments carry their fee-composed price.
 */
export interface CurveSegment {
  /** Δinput (tokenIn) to traverse this slice. */
  capacity: bigint;
  /** Δoutput (tokenOut) over this slice. */
  effOut: bigint;
  /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
  marginalOI: bigint;
}

/** Default sample count per Curve pool (M). Tunable; M≈16–32 tightens the grid bound. */
export const CURVE_SAMPLES = Number(process.env.ECO_CURVE_SAMPLES ?? 24);

/**
 * Sample a Curve pool into M descending-marginal segments over [0, amountIn].
 *
 * Geometric cumulative inputs (denser near 0 where the curve is steepest), each replayed
 * through get_dy on the READ state (NO extra RPC — pure bigint). Each increment becomes a
 * (capacity=Δin, effOut=Δout, marginalOI) segment. The samples are monotone in input so the
 * marginals are naturally descending (a convex out(in)); a non-descending slice (rounding
 * noise near the cap, or a non-convex region) is FOLDED into the last segment (isotonic
 * backward-merge — capacity + effOut conserved, blended marginal recomputed) so the merge stays
 * monotone price-ordered without discarding liquidity. See shared/segment-merge.ts.
 *
 * Exact-on-grid: the split equalizes marginals on THIS sampled grid; the per-pool dy for the
 * awarded share is re-evaluated wei-exact by one atomic get_dy(Σ share) at execution. M≈24
 * (default) keeps the grid bound `O(curvature·maxSlice)` negligible near peg.
 */
export function buildCurveSegments(
  pool: CurvePool,
  amountIn: bigint,
  samples: number = CURVE_SAMPLES,
): CurveSegment[] {
  if (amountIn <= 0n) return [];
  // Geometric cumulative grid: input_s = amountIn * (b^s - 1)/(b^M - 1) is awkward in
  // bigint; use a rational geometric spacing via squared sample index (denser near 0),
  // which is monotone increasing and concentrates resolution where the curve bends most.
  const M = BigInt(samples);
  const segs: CurveSegment[] = [];
  let prevIn = 0n;
  let prevOut = 0n;
  for (let s = 1; s <= samples; s++) {
    // cumulative input ∝ s^2 (geometric-ish: fine slices near 0, coarse near amountIn).
    const ss = BigInt(s);
    const input = (amountIn * ss * ss) / (M * M);
    if (input <= prevIn) continue;
    const out = getDy(pool, input);
    if (out <= 0n) continue;
    const dIn = input - prevIn;
    const dOut = out - prevOut;
    if (dIn > 0n && dOut > 0n) {
      const marginalOI = isqrt((dOut * Q192) / dIn);
      // Isotonic backward-merge (liquidity-preserving) — a non-descending slice is FOLDED into the
      // last segment, not dropped, so no liquidity is discarded. See shared/segment-merge.ts.
      pushMonotoneSegment(segs, dIn, dOut, marginalOI);
    }
    prevIn = input;
    prevOut = out;
  }
  return segs;
}
