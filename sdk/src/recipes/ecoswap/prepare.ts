/**
 * EcoSwap off-chain preparation.
 *
 * Reconstructs each pool's liquidity curve as per-tick "brackets" in a unified
 * out/in sqrt-price space, then builds a single global ladder sorted by
 * fee-adjusted marginal price. The on-chain solver walks that ladder once to
 * find the common marginal-price cut and executes one swap per pool.
 *
 * Pipeline:
 *   1. Discover + read ALL direct pools via the on-chain LENS (ecoswap.lens.sauce.ts)
 *      in ONE read-only eth_call cook(): factory getPool/getPair discovery, live
 *      slot0/getReserves/StateView reads, and a windowed ticks()/getTickLiquidity
 *      scan — returned as raw words (see lens.ts). v1 covers V2Standard, V3Standard
 *      and hookless UniswapV4 only. The lens is the SINGLE SOURCE OF TRUTH for
 *      survivorship: it measures each pool's IN-RANGE capacity across the crossed
 *      ticks (not spot active-L), applies the relative-depth filter on-chain, and
 *      returns ONLY survivors (no absolute floor) — prepare never re-filters.
 *   2. Apply the top-N (deepest) cap — a calldata/loop bound, not a liquidity gate.
 *   3. Build brackets from the lens reads: V3/V4 from active L + liquidityNet
 *      (buildV3Brackets); V2 as one wide bracket discretised into geometric steps
 *      (a V2 pool == a single V3 range with L = sqrt(k)).
 *   4. Routes: one lens eth_call per hop pair, then compose the two hops OFF-CHAIN
 *      via localQuote (no on-chain quote()) into route segments.
 *   5. Fee-adjust, compute per-bracket gross input capacity, sort + trim the ladder.
 *
 * RPC efficiency: the entire direct-pool discovery + state + tick read is ONE
 * eth_call (the lens); multi-hop routes add one eth_call per hop pair.
 */

import type { PublicClient, Hex } from "viem";
import { runLens, type LensPool } from "./lens.js";
import {
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
  SwapPoolType,
  BASE_CHAIN_POOL_CONFIG,
  type ChainPoolConfig,
} from "../shared/constants.js";
import {
  EcoBracketKind,
  type EcoSwapConfig,
  type EcoSwapPrepared,
  type EcoBracket,
  type EcoPool,
  type EcoRoute,
  type PoolInfo,
} from "../shared/types.js";

// ── Tunables ─────────────────────────────────────────────────

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const FEE_DENOM = 1_000_000n; // ppm
/**
 * Tick shift used to carry signed ticks as non-negative "shifted" values for the
 * adaptive frontier seeds (matches the lens OFFSET = 888000; multiple of LCM(3000)
 * and > max|tick| 887272 so shifted stays ≥0). Only used for the adaptive seeds.
 */
const OFFSET_TICK = 888000;

/**
 * RELATIVE-depth floor (bps of TOTAL IN-RANGE capacity across crossed ticks) — the
 * SOLE liquidity gate (no absolute floor). A pool's in-range capacity is the gross
 * tokenIn it can absorb walking from spot to the trade's price floor (NOT its spot
 * active-L): this is comparable across V2 (≡ a V3 range with L=√k), V3 and V4, and
 * — unlike spot-L — does not reward a narrow band of huge liquidity concentrated
 * right at spot that the trade immediately walks out of. A pool below this fraction
 * of the combined in-range depth would only ever get a dust slice — not worth a
 * swap's gas. The on-chain LENS measures this capacity and applies the filter; it is
 * the single source of truth for survivorship (prepare never re-filters). Default
 * 100 bps (1%); override with ECO_MIN_REL_BPS, or per-call via prepareEcoSwap opts.
 * 0 disables.
 */
const DEFAULT_MIN_REL_BPS = Number(process.env.ECO_MIN_REL_BPS ?? 100);
/**
 * Tick boundaries scanned per V3 pool in the swap direction (fetch window).
 * Fetched generously by the lens in one eth_call; the ladder is then TRIMMED to EXACTLY
 * the ticks the trade crosses (WS2: no safety buffer — the on-chain solver reads any
 * runtime drift LIVE), so on-chain gas/calldata scale with trade size, not this window.
 * Must be wide enough to reach the cut for the largest expected trade.
 */
const V3_TICK_STEPS = 96;
/** Geometric brackets emitted per V2 pool (also trimmed to exactly the crossed range). */
const V2_BRACKETS = 16;
/** Cap on direct pools (top-N by liquidity) — bounds on-chain loop + calldata. */
const MAX_DIRECT_POOLS = Number(process.env.ECO_MAX_POOLS ?? 12);
/**
 * Forward drift buffer (extra lens tick boundaries past the cut) for ROUTE hops ONLY.
 * Direct pools use 0 (the on-chain solver re-anchors its dn walk to the live spot and
 * reads drift live), but routes compose off-chain via localQuote and execute in one flat
 * swapV3 per hop with no live walk, so their prepared bracket curve must extend slightly
 * past the sampled amountIn.
 */
const ROUTE_DRIFT_TICKS = 2;
/** Always keep at least this many brackets (so tiny trades still split sensibly). */
const MIN_BRACKETS = 8;
/** Per-bracket price step for V2 discretisation (~0.5% per bracket in sqrt). */
const V2_SQRT_STEP_BPS = 25n; // 0.25% of sqrt → ~0.5% price per bracket
/** Input samples used to profile each multi-hop route. */
const ROUTE_SAMPLES = 6;
/** Keep at most this many routes (bytecode/gas bound). */
const MAX_ROUTES = Number(process.env.ECO_MAX_ROUTES ?? 2);
/**
 * Engine `_swapV2` hardcodes the constant-product fee at 0.3% (997/1000) for
 * EVERY V2 pool, ignoring the discovered fee tier. So all V2 brackets are pinned
 * to this fee so the off-chain capacity/marginal ladder matches what executes.
 */
const V2_FEE_PPM = 3000;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

/** Initial adaptive frontier seeds — every EcoPool starts here. For V3/V4 pools
 *  buildV3Brackets ALWAYS overwrites these with the live frontier (next un-walked
 *  boundary, near sqrt, active L, step ratio), so the on-chain streaming walk can
 *  resume past the prepared window whenever it under-fills (aStartShift>0). V2 pools
 *  keep these zeros — a V2 pool is a single wide bracket with no tick frontier, so
 *  its adaptive loop is naturally skipped (aStartShift>0 is false). */
const ADAPTIVE_SEED_INIT = {
  adaptiveStartShifted: 0n,
  adaptiveNearReal: 0n,
  adaptiveStartL: 0n,
  adaptiveStepRatio: 0n,
  // Re-anchor / drift-gate seeds — buildV3Brackets overwrites for V3/V4 pools with a
  // prepared window; V2 keeps these zeros (no drift gate, no tick frontier).
  topNearReal: 0n,
  bracketCount: 0,
} as const;

// ── Math helpers ─────────────────────────────────────────────

/** Integer square root (Babylonian). */
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

/** sqrt(1 - fee) scaled by 1e6, i.e. round(sqrt((1e6 - feePpm)/1e6) * 1e6). */
function sqrtOneMinusFeeScaled(feePpm: number): bigint {
  return isqrt(BigInt(1_000_000 - feePpm) * FEE_DENOM);
}

/** Apply the fee-adjustment to a spot out/in sqrt price. */
function feeAdjust(sqrtSpot: bigint, feePpm: number): bigint {
  return (sqrtSpot * sqrtOneMinusFeeScaled(feePpm)) / FEE_DENOM;
}

/**
 * Gross input (tokenIn units incl. fee) to traverse a bracket [sqrtFar, sqrtNear]
 * of constant liquidity L, in unified out/in space:
 *   effIn = L * 2^96 * (1/sqrtFar - 1/sqrtNear);  grossIn = effIn / (1 - fee)
 */
function bracketCapacity(L: bigint, sqrtNear: bigint, sqrtFar: bigint, feePpm: number): bigint {
  if (L <= 0n || sqrtFar <= 0n || sqrtNear <= sqrtFar) return 0n;
  const effIn = (L * Q96) / sqrtFar - (L * Q96) / sqrtNear;
  if (effIn <= 0n) return 0n;
  return (effIn * FEE_DENOM) / BigInt(1_000_000 - feePpm);
}

/** Exact Uniswap V3 TickMath.getSqrtRatioAtTick (real token1/token0 sqrt, Q96). */
function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = BigInt(tick < 0 ? -tick : tick);
  let ratio =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  const mul = (m: bigint) => {
    ratio = (ratio * m) >> 128n;
  };
  if (absTick & 0x2n) mul(0xfff97272373d413259a46990580e213an);
  if (absTick & 0x4n) mul(0xfff2e50f5f656932ef12357cf3c7fdccn);
  if (absTick & 0x8n) mul(0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if (absTick & 0x10n) mul(0xffcb9843d60f6159c9db58835c926644n);
  if (absTick & 0x20n) mul(0xff973b41fa98c081472e6896dfb254c0n);
  if (absTick & 0x40n) mul(0xff2ea16466c96a3843ec78b326b52861n);
  if (absTick & 0x80n) mul(0xfe5dee046a99a2a811c461f1969c3053n);
  if (absTick & 0x100n) mul(0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if (absTick & 0x200n) mul(0xf987a7253ac413176f2b074cf7815e54n);
  if (absTick & 0x400n) mul(0xf3392b0822b70005940c7a398e4b70f3n);
  if (absTick & 0x800n) mul(0xe7159475a2c29b7443b29c7fa6e889d9n);
  if (absTick & 0x1000n) mul(0xd097f3bdfd2022b8845ad8f792aa5825n);
  if (absTick & 0x2000n) mul(0xa9f746462d870fdf8a65dc1f90e061e5n);
  if (absTick & 0x4000n) mul(0x70d869a156d2a1b890bb3df62baf32f7n);
  if (absTick & 0x8000n) mul(0x31be135f97d08fd981231505542fcfa6n);
  if (absTick & 0x10000n) mul(0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if (absTick & 0x20000n) mul(0x5d6af8dedb81196699c329225ee604n);
  if (absTick & 0x40000n) mul(0x2216e584f5fa1ea926041bedfe98n);
  if (absTick & 0x80000n) mul(0x48a170391f7dc42444e8fa2n);
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  // sqrtPriceX96 = ratio >> 32, rounding up
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Convert a real pool sqrt (token1/token0) into unified out/in sqrt. */
function toOutIn(sqrtReal: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? sqrtReal : Q192 / sqrtReal;
}

/**
 * Next REAL sqrt one tickSpacing step in the swap direction (MULTIPLICATIVE) — the
 * exact mirror of the on-chain solver/lens `stepReal` and the oracle's `stepReal`:
 *   zeroForOne (price down): sqrt' = mulDiv(sqrt, 2^96, stepRatio)
 *   oneForZero (price up):   sqrt' = mulDiv(sqrt, stepRatio, 2^96)
 * (stepRatio = getSqrtRatioAtTick(tickSpacing).) Used to build the prepared V3/V4
 * bracket far edges so the prepared geometry == the live-walk/oracle geometry.
 */
function stepRealTs(sqrtReal: bigint, stepRatio: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? (sqrtReal * Q96) / stepRatio : (sqrtReal * stepRatio) / Q96;
}

// ── Classification ───────────────────────────────────────────

function isUsableV2(p: PoolInfo): boolean {
  // Constant-product only; Solidly *stable* pools use a different invariant.
  return p.poolType === SwapPoolType.UniV2 && !/stable/i.test(p.source);
}

function isV3Candidate(p: PoolInfo): boolean {
  return p.poolType === SwapPoolType.UniV3;
}

function isV4Candidate(p: PoolInfo): boolean {
  // Only hookless V4 pools with a StateView lens + poolId are reconstructable here.
  return p.poolType === SwapPoolType.UniV4 && !!p.poolId && !!p.stateView;
}

// ── V3 bracket construction ──────────────────────────────────

interface V3Read {
  pool: PoolInfo;
  tick: number;
  tickSpacing: number;
  activeLiquidity: bigint;
  /** liquidityNet keyed by tick index, for the scanned window. */
  net: Map<number, bigint>;
  /**
   * Forward tick boundaries the LAZY lens actually walked. buildV3Brackets STOPS
   * here so it never fabricates phantom brackets past the lens's scanned data
   * (which would assume L unchanged where the lens never read). 0 → no brackets.
   */
  scannedForward: number;
  /**
   * Reverse-drift tick boundaries the lens walked on the OPPOSITE side of spot.
   * buildV3Brackets emits this many capacity-0 brackets ABOVE spot so Phase B can
   * re-anchor if the live price has drifted against the swap. 0 → none.
   */
  scannedReverse: number;
}

/**
 * Adapt a lens-decoded V3/V4 pool into the V3Read shape `buildV3Brackets`
 * consumes. The lens already returned slot0 (sqrtPriceX96 + EXACT current tick),
 * active liquidity, and a windowed liquidityNet map keyed by signed tick — so no
 * RPC, and the bracket boundaries (base = floor(tick/ts)*ts, stepping ±ts) line
 * up exactly with the ticks the lens scanned.
 */
function lensToV3Read(p: LensPool): V3Read {
  return {
    pool: {
      address: p.address,
      tokenIn: "0x" as Hex,
      tokenOut: "0x" as Hex,
      fee: p.fee,
      poolType: p.poolType,
      priceLimited: true,
      sqrtPriceX96: p.sqrtPriceX96,
      liquidity: p.liquidity,
      source: "lens",
    },
    tick: p.tick,
    tickSpacing: p.tickSpacing,
    activeLiquidity: p.liquidity,
    net: p.net,
    scannedForward: p.scannedForward,
    scannedReverse: p.scannedReverse,
  };
}

/** Standard Uniswap-V3 fee → tickSpacing mapping (covers the discovered V3 forks). */
const TICK_SPACING_BY_FEE: Record<number, number> = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 };
function feeToTickSpacing(fee: number): number {
  return TICK_SPACING_BY_FEE[fee] ?? 60;
}

/**
 * Build out/in brackets for one V3 pool from its tick window.
 *
 * FORWARD (swap direction): the first bracket's near edge is the LIVE current
 * price; each subsequent edge is an initialized-tick boundary. Crossing a
 * boundary updates active liquidity by ±liquidityNet (− when the price moves down
 * for zeroForOne, + when it moves up for oneForZero).
 *
 * REVERSE (opposite of the swap, ABOVE spot): if the pool's live price has
 * drifted AGAINST the swap between prepare and execution, Phase B integrates from
 * the live (drifted-up) price down to the cut — a span that begins ABOVE the
 * prepare-time spot. These reverse brackets supply the liquidity for that region.
 * They carry capacity = 0 so the water-fill cut (Phase A, on-chain AND the
 * off-chain trim) IGNORES them; only Phase B's geometric re-anchoring consumes
 * them. Reverse L accumulation is the MIRROR of forward: zeroForOne reverse = price
 * UP (cross base+ts.., L += net); oneForZero reverse = price DOWN (cross base..,
 * L -= net). Walks exactly scannedReverse boundaries — never past the lens's data
 * (scannedReverse is incremented per-emit in the lens, so this bound can't fabricate
 * brackets the lens never read; load-bearing — keep in sync if the lens reverse loop
 * changes). NOTE: reverse drift only helps pools the trade already crosses (the trim
 * drops non-crossed pools entirely), same as the forward direction.
 */
function buildV3Brackets(
  r: V3Read,
  refIdx: number,
  zeroForOne: boolean,
  seed?: EcoPool,
): EcoBracket[] {
  const brackets: EcoBracket[] = [];
  const feePpm = r.pool.fee;
  const ts = r.tickSpacing;
  const base = Math.floor(r.tick / ts) * ts;
  const spotReal = r.pool.sqrtPriceX96;

  // WS2 §3.2: the capacity-0 reverse-side brackets (above spot, drift-only) are GONE.
  // Against-swap drift is now read LIVE by the on-chain solver, which re-anchors its dn
  // walk to the live spot (running it from the live tick), so prepare no longer fabricates
  // reverse brackets. The re-anchor / drift-gate seeds (topNearReal/bracketCount, stamped
  // below) are computed from the FORWARD loop + spot, so dropping the reverse scan costs
  // nothing.

  // ── Forward brackets (swap direction) ──
  // STOP at the lazy lens's scanned forward boundary — never walk past the data
  // it actually read (that would fabricate phantom brackets assuming L unchanged).
  //
  // EXACTNESS (k-way §7): step nearReal MULTIPLICATIVELY via stepReal(near, stepRatio)
  // — the SAME geometry the on-chain lens MEASURE, the solver's up/dn frontiers, AND
  // the optimal oracle (ecoswap.optimal.ts v3Segments) walk — NOT getSqrtRatioAtTick(b)
  // per boundary. getSqrtRatioAtTick and the multiplicative step diverge by a few wei
  // per step (growing); using stepReal here makes the prepared-region geometry identical
  // to the live-walk/oracle geometry EVERYWHERE, so a no-drift prepared-only fill equals
  // the oracle to the wei (and the prepared→dn seam is path-additive bit-for-bit).
  const stepRatio = getSqrtRatioAtTick(ts);
  let L = r.activeLiquidity;
  let nearReal = spotReal; // real sqrt at the near edge (starts live = spot)
  let b = zeroForOne ? base : base + ts; // first boundary tick in swap dir
  const step = zeroForOne ? -ts : ts;
  let fwdCount = 0; // forward brackets actually emitted (≤ scannedForward; re-anchor seed)
  // Per-emitted-bracket dn-frontier ENTRY snapshots. frontier[k] is the resume state
  // (shifted boundary, nearReal, L) AFTER k emitted forward brackets — used by
  // prepareEcoSwap to re-stamp the dn seed CONTIGUOUS with the kept cache after the trim
  // (see EcoPool.frontierByCount). frontier[0] is the spot seed (no brackets crossed).
  const frontier: { shifted: bigint; nearReal: bigint; L: bigint }[] = [
    { shifted: BigInt(b + OFFSET_TICK), nearReal, L },
  ];
  for (let k = 0; k < r.scannedForward; k++) {
    const farReal = stepRealTs(nearReal, stepRatio, zeroForOne);
    const near = toOutIn(nearReal, zeroForOne);
    const far = toOutIn(farReal, zeroForOne);
    const emitted = L > 0n && far > 0n && near > far;
    if (emitted) {
      brackets.push(makeBracket(EcoBracketKind.V3, refIdx, near, far, L, feePpm));
      fwdCount++;
    }
    const net = r.net.get(b) ?? 0n;
    L = zeroForOne ? L - net : L + net;
    if (L < 0n) L = 0n;
    nearReal = farReal;
    b += step;
    // Snapshot the resume state AFTER this step iff it emitted a bracket — frontier[]
    // is indexed by emitted-bracket count, so it lines up with the per-pool kept count.
    if (emitted) frontier.push({ shifted: BigInt(b + OFFSET_TICK), nearReal, L });
  }

  // ── Adaptive frontier seeds (WS4) ──
  // ALWAYS stamp the frontier for a V3/V4 pool: the streaming tick walk is always
  // available, so the on-chain solver can resume past the prepared window whenever
  // it under-fills. The forward loop stopped at the lens's scannedForward boundary.
  // Its carried (L, nearReal, b) are EXACTLY the entry state for the FIRST un-walked
  // step, so the on-chain solver resumes the streaming walk from here with NO
  // double-count: the seed's first far-edge == the last prepared bracket's far-edge
  // (path-additive). When scannedForward===0 the loop never ran, so (L, nearReal, b)
  // keep their spot-seed initial values — the unified derivation handles both cases.
  if (seed) {
    seed.adaptiveStartL = L; // active L entering the first un-walked step
    seed.adaptiveNearReal = nearReal; // MULTIPLICATIVE sqrt at the last crossed edge (or spot)
    seed.adaptiveStartShifted = BigInt(b + OFFSET_TICK); // next (un-walked) boundary, shifted
    seed.adaptiveStepRatio = stepRatio; // getSqrtRatioAtTick(ts) == lens stepRatioForSpacing
    seed.adaptiveNet = r.net; // off-chain-only net map for the oracle's mirrored walk
    seed.frontierByCount = frontier; // per-kept-count dn resume state (re-stamped post-trim)

    // Window-top / re-anchor-gate seeds (WS2 §3.1): topNearReal is the prepare-time
    // spot real sqrt — stamped == spotReal so its window-top out/in (toOutIn(spotReal))
    // exactly equals the top forward bracket's sqrtNear (built from the same spotReal,
    // first forward iteration nearReal=spotReal). It is the DRIFT GATE / re-anchor
    // trigger the solver compares the live spot against. bracketCount=0 ⇒ no window ⇒
    // the dn walk runs from the spot seed (no-bracket / quote path).
    seed.topNearReal = spotReal;
    seed.bracketCount = fwdCount;

    // Window-top seam invariant (WS2 §3.1, risk 4): toOutIn(topNearReal) must equal the
    // FIRST forward bracket's sqrtNear so the window top and the cache align exactly (no
    // overlap/sliver) — both the drift gate and the dn re-anchor reference this seam.
    // The first forward bracket is built with near=toOutIn(spotReal) (first iteration
    // nearReal=spotReal), so this holds by construction; assert when a bracket exists.
    if (fwdCount > 0) {
      const topNearOI = toOutIn(spotReal, zeroForOne);
      const firstFwd = brackets.find((bk) => bk.capacity > 0n);
      if (firstFwd && firstFwd.sqrtNear !== topNearOI) {
        throw new Error(
          `window-top seam: toOutIn(topNearReal)=${topNearOI} !== first forward bracket sqrtNear=${firstFwd.sqrtNear}`,
        );
      }
    }

    // bracket-end == adaptive-start assertions (spec §A). Only meaningful once at
    // least one forward boundary was crossed (otherwise nearReal is spot, not a
    // TickMath value, and b is the un-shifted spot boundary).
    if (r.scannedForward > 0) {
      // The forward loop's FIRST boundary is direction-dependent (zeroForOne starts
      // at base, oneForZero at base+ts — see `b` init above); anchor on the same
      // start so the assertion holds for the price-up walk, not just price-down.
      const firstBoundary = zeroForOne ? base : base + ts;
      const expectShift = BigInt(firstBoundary + OFFSET_TICK) + BigInt(step) * BigInt(r.scannedForward);
      if (seed.adaptiveStartShifted !== expectShift) {
        throw new Error(
          `adaptive seed: startShifted ${seed.adaptiveStartShifted} !== expected ${expectShift} ` +
            `(base=${base} step=${step} scannedForward=${r.scannedForward})`,
        );
      }
      // nearReal is spot stepped MULTIPLICATIVELY scannedForward times (the seed must
      // equal the last prepared bracket's far edge so the on-chain dn frontier resumes
      // path-additively). Replay the multiplicative walk and compare.
      let expectNear = spotReal;
      for (let kk = 0; kk < r.scannedForward; kk++) {
        expectNear = stepRealTs(expectNear, stepRatio, zeroForOne);
      }
      if (seed.adaptiveNearReal !== expectNear) {
        throw new Error(
          `adaptive seed: nearReal ${seed.adaptiveNearReal} !== multiplicative replay ${expectNear} ` +
            `(scannedForward=${r.scannedForward})`,
        );
      }
    }
  }

  return brackets;
}


// ── V2 bracket construction ──────────────────────────────────

/** Build discretised out/in brackets for one constant-product pool. */
function buildV2Brackets(pool: PoolInfo, refIdx: number, feePpm: number): EcoBracket[] {
  const brackets: EcoBracket[] = [];
  const L = pool.liquidity; // synthetic sqrt(k); recomputed live on-chain
  let near = pool.sqrtPriceX96; // already out/in for V2

  for (let i = 0; i < V2_BRACKETS; i++) {
    const far = near - (near * V2_SQRT_STEP_BPS) / 10_000n;
    if (far <= 0n || far >= near) break;
    brackets.push(makeBracket(EcoBracketKind.V2, refIdx, near, far, L, feePpm));
    near = far;
  }
  return brackets;
}

// ── Bracket factory (fee-adjust + capacity) ──────────────────

function makeBracket(
  kind: EcoBracketKind,
  refIdx: number,
  sqrtNear: bigint,
  sqrtFar: bigint,
  liquidity: bigint,
  feePpm: number,
): EcoBracket {
  return {
    kind,
    refIdx,
    sqrtNear,
    sqrtFar,
    liquidity,
    capacity: bracketCapacity(liquidity, sqrtNear, sqrtFar, feePpm),
    sqrtAdjNear: feeAdjust(sqrtNear, feePpm),
    sqrtAdjFar: feeAdjust(sqrtFar, feePpm),
  };
}

// ── Multi-hop route brackets ─────────────────────────────────

/** Build a single lens-pool's out/in brackets (V2 or V3/V4) for route quoting. */
function lensPoolBrackets(p: LensPool, zeroForOne: boolean, refIdx: number): EcoBracket[] {
  if (p.poolType === SwapPoolType.UniV2) {
    return buildV2Brackets(
      { sqrtPriceX96: p.sqrtPriceX96, liquidity: p.liquidity } as PoolInfo,
      refIdx,
      V2_FEE_PPM,
    );
  }
  return buildV3Brackets(lensToV3Read(p), refIdx, zeroForOne);
}

/** Adapt a LensPool to a minimal PoolInfo for the route descriptor (tokens set). */
function lensPoolToInfo(p: LensPool, tokenIn: Hex, tokenOut: Hex): PoolInfo {
  return {
    address: p.address,
    tokenIn,
    tokenOut,
    fee: p.poolType === SwapPoolType.UniV2 ? V2_FEE_PPM : p.fee,
    poolType: p.poolType,
    priceLimited: p.poolType !== SwapPoolType.UniV2,
    sqrtPriceX96: p.sqrtPriceX96,
    liquidity: p.liquidity,
    source: "lens",
    poolId: p.poolId,
    stateView: p.stateView,
    tickSpacing: p.tickSpacing,
    hooks: p.hooks,
  };
}

/**
 * Walk a single pool's out/in bracket curve consuming `amountIn` (gross tokenIn),
 * returning the tokenOut produced. Off-chain replacement for the on-chain quote()
 * RPC. Each bracket is [sqrtNear, sqrtFar] of constant L in unified out/in space;
 *   maxEffIn(bracket) = L*2^96*(1/sqrtFar - 1/sqrtNear), grossIn = effIn/(1-fee).
 * For a partial fill, solve the spot where the consumed effIn matches the budget.
 * tokenOut over a bracket from spot sNear→sLow: dOut = L*(sNear - sLow)/2^96.
 */
function localQuote(brackets: EcoBracket[], amountIn: bigint, feePpm: number): bigint {
  let budget = amountIn;
  let out = 0n;
  const oneMinusFee = BigInt(1_000_000 - feePpm);
  for (const b of brackets) {
    if (budget <= 0n) break;
    const L = b.liquidity;
    const near = b.sqrtNear;
    const far = b.sqrtFar;
    if (L <= 0n || far <= 0n || near <= far) continue;
    const grossCap = b.capacity; // gross tokenIn to traverse the whole bracket
    if (grossCap <= 0n) continue;
    if (budget >= grossCap) {
      // full bracket
      out += (L * (near - far)) / Q96;
      budget -= grossCap;
    } else {
      // partial: effIn = budget*(1-fee); solve sLow from
      //   effIn = L*2^96*(1/far' - 1/near) where far' is the partial far edge.
      const effIn = (budget * oneMinusFee) / FEE_DENOM;
      const invNear = (L * Q96) / near;
      const invLow = invNear + effIn;
      const sLow = invLow > 0n ? (L * Q96) / invLow : far;
      const clampedLow = sLow < far ? far : sLow;
      out += (L * (near - clampedLow)) / Q96;
      budget = 0n;
    }
  }
  return out;
}

/**
 * Build route segments by composing the two hops via localQuote (NO on-chain
 * quote()). Profiles cumulative input samples through hop1→hop2 and turns each
 * increment into a (capacity, marginal-sqrt) segment, mirroring the prior
 * sampled-quote shape so the on-chain solver's route handling is unchanged.
 */
function buildRouteBracketsLocal(
  hop1Brackets: EcoBracket[],
  hop2Brackets: EcoBracket[],
  refIdx: number,
  amountIn: bigint,
  hop1Fee: number,
  hop2Fee: number,
): EcoBracket[] {
  const samples: { input: bigint; out: bigint }[] = [];
  for (let s = 1; s <= ROUTE_SAMPLES; s++) {
    const input = (amountIn * BigInt(s)) / BigInt(ROUTE_SAMPLES);
    const mid = localQuote(hop1Brackets, input, hop1Fee);
    if (mid === 0n) break;
    const finalOut = localQuote(hop2Brackets, mid, hop2Fee);
    if (finalOut === 0n) break;
    samples.push({ input, out: finalOut });
  }
  if (samples.length === 0) return [];

  const brackets: EcoBracket[] = [];
  let prevIn = 0n;
  let prevOut = 0n;
  for (const sm of samples) {
    const dIn = sm.input - prevIn;
    const dOut = sm.out - prevOut;
    if (dIn > 0n && dOut > 0n) {
      const sqrtAdj = isqrt((dOut * Q192) / dIn);
      brackets.push({
        kind: EcoBracketKind.Route,
        refIdx,
        sqrtNear: sqrtAdj,
        sqrtFar: sqrtAdj,
        liquidity: 0n,
        capacity: dIn,
        sqrtAdjNear: sqrtAdj,
        sqrtAdjFar: sqrtAdj,
      });
    }
    prevIn = sm.input;
    prevOut = sm.out;
  }
  return brackets;
}

// ── Main preparation ─────────────────────────────────────────

/** Tuning knobs for off-chain preparation (overridable per call; mainly for tests). */
export interface EcoSwapPrepareOpts {
  /**
   * Drop pools whose IN-RANGE (windowed) capacity is below this many bps of the
   * Σ in-range capacity across alive pools (default DEFAULT_MIN_REL_BPS =
   * ECO_MIN_REL_BPS env or 100 = 1%). Set 0 to disable the filter and keep every
   * alive pool (used by cross-version split tests that intentionally mix
   * shallow-but-distinct AMM versions).
   */
  minRelBps?: number;
  /**
   * Override the lens forward tick window (default V3_TICK_STEPS = 96). Lets the
   * adaptive EVM test deliberately prepare a NARROW window so the prepared brackets
   * under-fill amountIn — then the always-on streaming walk resumes from the frontier
   * seed to close the gap.
   */
  maxTicks?: number;
  /**
   * Engine target for the on-chain LENS read (the discovery/state/tick eth_call cook).
   * DEFAULT "v12" — the production engine; the lens is now v12-native (its MEASURE-B
   * computation + return decode are verified on v12). The lens read is engine-agnostic in
   * VALUE (same survivors/header on either engine), so this only selects which engine the
   * read runs on; it MUST match the engine deployed at `lensCookEntry`. Set "v1" for the
   * legacy SauceRouter path.
   */
  lensTarget?: "v1" | "v12";
  /**
   * The account to simulate the read-only lens cook from. v1's SauceRouter.cook is open,
   * so the default sentinel works. On v12 the V12Pot.cook is owner-gated, so the read
   * MUST originate from the Pot owner — callers pass the cook caller here.
   */
  caller?: Hex;
}

export async function prepareEcoSwap(
  config: EcoSwapConfig,
  client: PublicClient,
  // The LENS cook entrypoint — the engine address the read-only discovery/state/tick
  // cook() runs against (matches lensTarget): the v1 SauceRouter on v1, the owner's
  // V12Pot on v12 (the lens is the only on-chain call prepare makes — no separate quote RPC).
  lensCookEntry: Hex,
  poolConfig: ChainPoolConfig = BASE_CHAIN_POOL_CONFIG,
  opts: EcoSwapPrepareOpts = {},
): Promise<EcoSwapPrepared> {
  const minRelBps = opts.minRelBps ?? DEFAULT_MIN_REL_BPS;
  const maxTicks = opts.maxTicks ?? V3_TICK_STEPS;
  const target = opts.lensTarget ?? "v12";
  const caller = opts.caller;
  const { tokenIn, tokenOut, amountIn } = config;
  const inLower = tokenIn.toLowerCase();
  const outLower = tokenOut.toLowerCase();
  const zeroForOne = inLower < outLower;
  const priceLimit = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;

  // ── Discover + read direct pools via the on-chain LENS (ONE eth_call) ──
  // Replaces ~all direct-pool discovery/state/tick/token0 RPCs: the lens runs
  // discovery + slot0/getReserves/StateView + a windowed tick scan inside ONE
  // read-only cook() eth_call and returns raw reads, decoded into LensPool[]. The
  // lens program is compiled to `target` and cooked through `lensCookEntry` (the
  // matching engine), simulated from `caller` (the Pot owner on v12).
  const lensResult = await runLens(client, lensCookEntry, poolConfig, {
    tokenIn,
    tokenOut,
    zeroForOne,
    amountIn,
    driftTicks: 0, // WS2 §3.3: no reverse/forward drift scan — the solver reads drift LIVE.
    minRelBps,
    maxTicks,
    target,
    account: caller,
  });

  // The LENS is the single source of truth for survivorship: it already applied
  // the relative-depth IN-RANGE-capacity floor on-chain and returns ONLY survivors
  // (every returned pool is a usable type — V2Standard sans Solidly-stable,
  // V3Standard, hookless V4). So prepare does NOT re-filter; it just keeps the
  // deepest top-N by spot liquidity (a calldata/loop bound, not a liquidity gate).
  const survivors = lensResult.pools;
  const usableDirect = survivors
    .slice()
    .sort((a, b) => (a.liquidity < b.liquidity ? 1 : a.liquidity > b.liquidity ? -1 : 0))
    .slice(0, MAX_DIRECT_POOLS);

  // No silent caps: surface what the lens dropped (relative-depth) and any top-N
  // truncation. Per-pool droppee detail lives on-chain now — report counts.
  const droppedByLens = lensResult.discoveredCount - lensResult.survivorCount;
  if (droppedByLens > 0) {
    console.log(
      `  EcoSwap lens dropped ${droppedByLens} shallow pool(s) (< ${minRelBps}bps of Σ in-range ` +
        `capacity, floor=${lensResult.capacityFloor} of Σ${lensResult.totalInRangeCapacity})`,
    );
  }
  if (survivors.length > MAX_DIRECT_POOLS) {
    console.log(
      `  EcoSwap capped to deepest ${MAX_DIRECT_POOLS} of ${survivors.length} survivor pools (ECO_MAX_POOLS)`,
    );
  }
  const v3Raw = usableDirect.filter((p) => p.poolType === SwapPoolType.UniV3);
  const v4Raw = usableDirect.filter((p) => p.poolType === SwapPoolType.UniV4);
  // Constant-product (Uniswap-V2-style) pools execute via the unified
  // swap(SwapParams) entry (poolType=UniV2); the on-chain solver re-anchors them
  // to live reserves. The engine's _swapV2 hardcodes the 0.3% fee.
  const v2Raw = usableDirect.filter((p) => p.poolType === SwapPoolType.UniV2);

  // ── Discover multi-hop routes (best pool per leg) — via the LENS ──
  // Each hop pair gets its OWN lens eth_call (one pool pair is one cook()); the
  // deepest pool per hop is reconstructed into brackets, and route segments are
  // composed OFF-CHAIN via localQuote (no on-chain quote() RPC). Direct prepare is
  // still ONE eth_call; routes add one eth_call per (in→base) and (base→out) pair.
  interface RouteLens {
    intermediateToken: Hex;
    hop1Pool: PoolInfo;
    hop2Pool: PoolInfo;
    hop1Brackets: EcoBracket[];
    hop2Brackets: EcoBracket[];
  }
  const routesRaw: RouteLens[] = [];
  for (const baseToken of poolConfig.baseTokens) {
    const bl = baseToken.toLowerCase();
    if (bl === inLower || bl === outLower) continue;
    const z1 = inLower < bl;
    const z2 = bl < outLower;
    // ROUTE hops keep a small forward drift buffer (ROUTE_DRIFT_TICKS): unlike DIRECT
    // pools, routes execute off-chain-composed in ONE flat swapV3 per hop with NO
    // on-chain live walk to compensate for an under-reaching window — so the prepared
    // bracket curve must extend slightly past the sampled amountIn for the off-chain
    // localQuote composition to track the real two-hop swap to truncation. (Direct
    // pools use driftTicks:0 because the solver re-anchors its dn walk and reads drift live.)
    const [hop1, hop2] = await Promise.all([
      runLens(client, lensCookEntry, poolConfig, {
        tokenIn, tokenOut: baseToken, zeroForOne: z1,
        amountIn, driftTicks: ROUTE_DRIFT_TICKS, minRelBps, maxTicks: V3_TICK_STEPS,
        target, account: caller,
      }),
      runLens(client, lensCookEntry, poolConfig, {
        tokenIn: baseToken, tokenOut, zeroForOne: z2,
        amountIn, driftTicks: ROUTE_DRIFT_TICKS, minRelBps, maxTicks: V3_TICK_STEPS,
        target, account: caller,
      }),
    ]);
    // The on-chain route handler executes BOTH hops via flat swapV3, so only V3
    // pools are valid route legs. (V2/V4 route hops would need per-hop type
    // dispatch + a richer route tuple on-chain — a documented follow-up.) Pick the
    // deepest V3 pool per hop; skip the route if either hop has no V3 pool.
    const v3Hop1 = hop1.pools.filter((p) => p.poolType === SwapPoolType.UniV3);
    const v3Hop2 = hop2.pools.filter((p) => p.poolType === SwapPoolType.UniV3);
    if (v3Hop1.length === 0 || v3Hop2.length === 0) continue;
    const best1 = v3Hop1.reduce((a, b) => (a.liquidity > b.liquidity ? a : b));
    const best2 = v3Hop2.reduce((a, b) => (a.liquidity > b.liquidity ? a : b));
    const hop1Brackets = lensPoolBrackets(best1, z1, 0);
    const hop2Brackets = lensPoolBrackets(best2, z2, 0);
    if (hop1Brackets.length === 0 || hop2Brackets.length === 0) continue;
    routesRaw.push({
      intermediateToken: baseToken,
      hop1Pool: lensPoolToInfo(best1, tokenIn, baseToken),
      hop2Pool: lensPoolToInfo(best2, baseToken, tokenOut),
      hop1Brackets,
      hop2Brackets,
    });
  }

  // ── Build pool descriptors + brackets ──
  const pools: EcoPool[] = [];
  const brackets: EcoBracket[] = [];

  // V3 (lens already returned slot0 + windowed ticks() per pool)
  for (const p of v3Raw) {
    const refIdx = pools.length;
    const pool: EcoPool = {
      poolType: p.poolType,
      address: p.address,
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      hooks: ZERO_ADDRESS,
      feePpm: p.fee,
      isV2: false,
      inIsToken0: zeroForOne, // V3 PoolKey orientation = token sort order
      stateView: ZERO_ADDRESS,
      poolId: ZERO_BYTES32,
      ...ADAPTIVE_SEED_INIT,
      source: "lens V3",
    };
    pools.push(pool);
    brackets.push(...buildV3Brackets(lensToV3Read(p), refIdx, zeroForOne, pool));
  }

  // V4 (singleton; lens read StateView slot0 + windowed getTickLiquidity)
  for (const p of v4Raw) {
    const refIdx = pools.length;
    const pool: EcoPool = {
      poolType: p.poolType,
      address: p.address, // PoolManager singleton
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      hooks: p.hooks ?? ZERO_ADDRESS,
      feePpm: p.fee,
      isV2: false,
      inIsToken0: zeroForOne,
      stateView: p.stateView,
      poolId: p.poolId,
      ...ADAPTIVE_SEED_INIT,
      source: "lens V4",
    };
    pools.push(pool);
    brackets.push(...buildV3Brackets(lensToV3Read(p), refIdx, zeroForOne, pool));
  }

  // V2 (lens returned synthetic out/in sqrt + synthetic L + inIsToken0)
  for (const p of v2Raw) {
    const refIdx = pools.length;
    pools.push({
      poolType: p.poolType,
      address: p.address,
      fee: V2_FEE_PPM, // engine _swapV2 uses 0.3% regardless of discovered tier
      tickSpacing: 0,
      hooks: ZERO_ADDRESS,
      feePpm: V2_FEE_PPM,
      isV2: true,
      inIsToken0: p.inIsToken0,
      stateView: ZERO_ADDRESS,
      poolId: ZERO_BYTES32,
      ...ADAPTIVE_SEED_INIT, // V2 has a single wide bracket — no frontier, walk skipped
      source: "lens V2",
    });
    brackets.push(
      ...buildV2Brackets(
        { sqrtPriceX96: p.sqrtPriceX96, liquidity: p.liquidity } as PoolInfo,
        refIdx,
        V2_FEE_PPM,
      ),
    );
  }

  // Routes (sampled). Keep the deepest few. Segments composed via localQuote.
  const routes: EcoRoute[] = [];
  const routeBracketSets: EcoBracket[][] = [];
  for (const r of routesRaw) {
    if (routes.length >= MAX_ROUTES) break;
    const refIdx = routes.length;
    const rb = buildRouteBracketsLocal(
      r.hop1Brackets,
      r.hop2Brackets,
      refIdx,
      amountIn,
      r.hop1Pool.fee,
      r.hop2Pool.fee,
    );
    if (rb.length === 0) continue;
    routes.push({ route: { intermediateToken: r.intermediateToken, hop1Pool: r.hop1Pool, hop2Pool: r.hop2Pool } });
    routeBracketSets.push(rb);
  }
  for (const set of routeBracketSets) brackets.push(...set);

  // The prepared brackets are a CACHE (an optimization), not a correctness dependency:
  // the on-chain solver reconstructs everything LIVE from each pool's frontier seed even
  // with an empty ladder (the no-cache / 1-RPC quote path, opts.maxTicks:0). So an empty
  // bracket set is legitimate as long as some pool survived discovery — only a TRULY empty
  // universe (no pools AND no routes) is an error.
  if (pools.length === 0 && routes.length === 0) {
    throw new Error(`No usable pools/routes for ${tokenIn} -> ${tokenOut}`);
  }

  // ── Sort the global ladder DESC by fee-adjusted near price ──
  // Tie-break EXACTLY as the optimal oracle (ecoswap.optimal.ts): adjNear DESC, then
  // adjFar DESC, then pool/route idx ASC. Two pools at the SAME fee-adjusted spot (e.g. a
  // V2 0.30% and a V4 0.30% pool both at 1:1) have IDENTICAL sqrtAdjNear on their first
  // bracket; without a deterministic secondary key the merge would consume them in an
  // arbitrary order and over/under-shoot the cut vs the oracle (the shallower-step pool
  // must go first — higher adjFar — so a coarse segment never overshoots). This makes the
  // k-way merge's prepared-cursor order bit-identical to the oracle's stable segment sort.
  brackets.sort((a, b) => {
    if (a.sqrtAdjNear !== b.sqrtAdjNear) return a.sqrtAdjNear < b.sqrtAdjNear ? 1 : -1;
    if (a.sqrtAdjFar !== b.sqrtAdjFar) return a.sqrtAdjFar < b.sqrtAdjFar ? 1 : -1;
    return a.refIdx - b.refIdx;
  });

  // ── Off-chain water-fill pre-run → trim to EXACTLY the crossed ticks ──
  // WS2 §3.2: drop the +SAFETY_TICKS past-cut buffer. Walk the sorted ladder
  // accumulating capacity until amountIn is covered; keep ONLY brackets[0..cutIdx] (the
  // ticks the trade actually crosses). Past-window with-swap drift is read LIVE by the
  // on-chain forward walk (resumed from each pool's frontier seed), and against-window
  // against-swap drift by the dn re-anchor to the live spot — so no prepared safety
  // buffer is needed.
  let covered = 0n;
  let cutIdx = brackets.length - 1;
  for (let i = 0; i < brackets.length; i++) {
    covered += brackets[i].capacity;
    if (covered >= amountIn) {
      cutIdx = i;
      break;
    }
  }

  const kept: EcoBracket[] = brackets.slice(0, cutIdx + 1);

  const trimmed =
    kept.length >= MIN_BRACKETS ? kept : brackets.slice(0, Math.min(brackets.length, MIN_BRACKETS));

  // ── Re-stamp the V3/V4 dn-frontier seed CONTIGUOUS with the kept cache ──
  // The trim above keeps only the crossed brackets, but buildV3Brackets stamped each
  // pool's dn seed at the END of the FULL lens window. After the trim a pool may keep K
  // < window brackets, so the full-window seed sits PAST the last kept bracket — a gap
  // the dn frontier would skip (it resumes too deep, mis-allocating across pools under
  // with-swap drift, the B3 trim-vs-seed gap). A pool's kept brackets are always a
  // price-descending PREFIX of its brackets (per-pool order is monotone; the global sort
  // preserves it), so re-stamp the seed from frontierByCount[K] (the resume state after K
  // emitted brackets) so the live dn walk picks up EXACTLY where the kept cache stops.
  {
    const keptCountByPool = new Map<number, number>();
    for (const b of trimmed) {
      if (b.kind === EcoBracketKind.V3) {
        keptCountByPool.set(b.refIdx, (keptCountByPool.get(b.refIdx) ?? 0) + 1);
      }
    }
    for (let pi = 0; pi < pools.length; pi++) {
      const pool = pools[pi];
      if (pool.isV2 || !pool.frontierByCount) continue;
      const k = keptCountByPool.get(pi) ?? 0;
      const snaps = pool.frontierByCount;
      // Clamp K to the snapshot range (K == fwdCount keeps the full-window seed).
      const idx = k < snaps.length ? k : snaps.length - 1;
      const snap = snaps[idx];
      pool.adaptiveStartShifted = snap.shifted;
      pool.adaptiveNearReal = snap.nearReal;
      pool.adaptiveStartL = snap.L;
      pool.bracketCount = k; // forward brackets the cache actually carries for this pool
    }
  }

  // ── V2 constant-L streaming seed (WS2 #104) ──
  // A V2 pool is a single √k curve over the ENTIRE price range, so the on-chain solver
  // can stream geometric out/in slices past its prepared window at the LIVE constant L
  // when it under-fills (with-swap / favorable drift) — the cheap analogue of the V3/V4
  // tick walk, with NO tick reads. Stamp each V2 pool's frontier = the deepest KEPT V2
  // bracket's far edge (out/in), so the forward walk resumes EXACTLY where the sweep
  // stopped (path-additive — no gap, no double-count). adaptiveStartShifted=1 is the
  // V2-walk enable flag (the solver gates the V2 branch on it); adaptiveNearReal carries
  // the out/in frontier (NOT a real sqrt — V2 streams in out/in space directly). The
  // live √k is read on-chain (getReserves), so it is NOT stamped. When a V2 pool got no
  // kept brackets (shouldn't happen — V2 always anchors a window) the flag stays 0.
  for (let pi = 0; pi < pools.length; pi++) {
    const pool = pools[pi];
    if (!pool.isV2) continue;
    let deepestFar = 0n; // smallest out/in far among this pool's kept V2 brackets (dn frontier)
    let shallowestNear = 0n; // largest out/in near among kept V2 brackets = V2 window top
    // The largest sqrtNear across ALL of this pool's brackets = the prepare-time V2
    // spot out/in (the first buildV2Brackets near). Used to assert the window-top seam.
    let spotNear = 0n;
    for (const b of brackets) {
      if (b.kind === EcoBracketKind.V2 && b.refIdx === pi) {
        if (b.sqrtNear > spotNear) spotNear = b.sqrtNear;
      }
    }
    for (const b of trimmed) {
      if (b.kind === EcoBracketKind.V2 && b.refIdx === pi) {
        if (deepestFar === 0n || b.sqrtFar < deepestFar) deepestFar = b.sqrtFar;
        if (b.sqrtNear > shallowestNear) shallowestNear = b.sqrtNear;
      }
    }
    if (deepestFar > 0n) {
      pool.adaptiveStartShifted = 1n; // V2-walk enable flag (dn frontier)
      pool.adaptiveNearReal = deepestFar; // out/in dn frontier (deepest kept far)
      // ── V2 window top (out/in) — the prepare-time V2 spot, used as the re-anchor gate ──
      // The shallowest kept V2 bracket's sqrtNear == the prepare-time V2 spot out/in.
      // Stamped into topNearReal (dual meaning vs V3/V4 — see types.ts). The on-chain
      // solver compares the LIVE V2 out/in spot to this value: on ANY drift (live != top)
      // V2 re-anchors its SINGLE constant-L geometric grid to the live spot (one continuous
      // dn stream) and stale-skips this spot-anchored prepared cache (D1). With no drift
      // (live == top) the prepared cache + the deepestFar dn seed run unchanged. So the
      // prepared region [top, deepestFar] is consumed only at the prepare-time price, and any
      // off-spot price is served entirely by the re-anchored live grid — no overlap/gap.
      pool.topNearReal = shallowestNear;
      // Seam invariant (mirror of the V3 seam assert): the shallowest kept bracket's
      // near must equal the V2 spot out/in (the first buildV2Brackets near), so the
      // window top exactly anchors the prepared region's top edge.
      if (spotNear > 0n && shallowestNear !== spotNear) {
        throw new Error(
          `V2 window-top seam: shallowestNear=${shallowestNear} !== V2 spot out/in=${spotNear} (pool ${pi})`,
        );
      }
    }
  }

  const nV4 = pools.filter((p) => p.poolType === SwapPoolType.UniV4).length;
  const nV3 = pools.filter((p) => p.poolType === SwapPoolType.UniV3).length;
  const nV2 = pools.filter((p) => p.isV2).length;
  console.log(
    `  EcoSwap prepared: ${nV3} V3, ${nV4} V4, ${nV2} V2, ${routes.length} routes, ` +
      `${trimmed.length}/${brackets.length} brackets kept (crossed only; live walk handles drift), ` +
      `coverage=${covered >= amountIn ? "full" : "partial"}`,
  );

  return {
    pools,
    routes,
    brackets: trimmed,
    zeroForOne,
    priceLimit,
    expectedInputCovered: covered,
  };
}
