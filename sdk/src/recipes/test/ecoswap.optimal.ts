/**
 * EcoSwap NEUTRAL optimal-split oracle (the strict measuring stick).
 *
 * Engine- AND solver-INDEPENDENT. Unlike `ecoswap.reference.ts` (which mirrors the
 * on-chain solver's data flow: prepared brackets, the K-way / pre-fill / sweep / walk
 * structure, the off-chain `liveCurRealOverride` modeling), THIS oracle takes the TRUE
 * LIVE pool state directly — per pool: live tick + active L + the full initialized-tick
 * liquidityNet curve over the relevant range (incl. BEYOND any prepared window), fee,
 * type, and for V2 the live reserves — and computes the OPTIMAL price-ordered water-fill
 * split from scratch.
 *
 * It knows NOTHING about prepared brackets, the cache, drift overrides, or pass
 * structure. It is purely: "given the real curves, what is the optimal equalized split
 * down to the common marginal-price cut?" That makes it the independent truth the solver
 * (and the reference) must match to the wei.
 *
 * EXACTNESS — same integer math as the solver:
 *   - V3/V4 segment frontier walks the REAL sqrt MULTIPLICATIVELY via `stepReal`
 *     (NOT getSqrtRatioAtTick) — the SAME convention the on-chain solver + lens use, so
 *     multiplicative drift accrues identically over many steps.
 *   - integration in unified out/in space: effIn = L·Q96/farOI − L·Q96/nearOI (mulDiv),
 *     grossed up by FEE_DENOM/(FEE_DENOM − feePpm) PER SEGMENT (per-segment rounding).
 *   - crossing an initialized tick updates active L by ±liquidityNet (the raw-uint128
 *     sign/clamp branches copied bit-for-bit from the solver).
 *   - V2 constant-L geometric slices: far = near − near·V2_STEP_BPS/V2_STEP_DEN at √k.
 *   - the cross-pool sort key is the fee-adjusted out/in price of the segment's NEAR
 *     (entry) edge: feeAdjOI(nearOI, feePpm) — the same coordinate prepare.ts sorts on.
 *
 * GLOBAL WATER-FILL: every pool's walk is decomposed into price-monotone SEGMENTS (each
 * a [nearOI, farOI] span of constant L with a precomputed gross). All segments across all
 * pools are merged in DESCENDING fee-adjusted-near-price order; we consume each segment's
 * gross into its pool until cum reaches amountIn (the crossing segment takes the exact
 * remainder). Because segments are emitted in each pool's natural price-descending order
 * AND the merge is globally price-ordered, this is exactly the optimal equalized split:
 * the marginal (post-fee) price at the cut is the same across every engaged pool.
 *
 * Drift is handled WITHOUT any special case: the caller passes the TRUE live tick / price,
 * so a pool whose live price sits above, within, or entirely past the prepared window is
 * simply walked from its true live spot. No-bracket pools, against-swap drift, with-swap
 * drift, fully-out-of-range — all are the same code path here (walk from live spot down).
 */

import {
  Q96,
  Q192,
  FEE_DENOM,
  mulDiv,
  isqrt,
  stepReal,
  toOutIn,
  HALF128,
  MOD128,
  sqrtOneMinusFeeScaled,
  getSqrtRatioAtTick,
  V2_STEP_BPS,
  V2_STEP_DEN,
  routeHeadFold,
  routeEventN,
  type RouteLeg,
} from "./ecoswap.math";
// Curve / LB / DODO segment enumeration — the SINGLE source shared with prepare.ts
// (buildCurve/Lb/DodoBrackets). The oracle enumerates the SAME segments from true live state, so
// the split is exact-on-grid (EXACT for LB — a bin is a flat constant-sum slice).
import { buildCurveQLLadder, type CurvePool } from "../shared/curve-math.js";
import { buildCryptoSwapQLLadder, type CryptoSwapPool } from "../shared/cryptoswap-math.js";
import { buildLbQLLadder, type LbPool } from "../shared/lb-math.js";
import { buildDodoSegments, type DodoPool } from "../shared/dodo-math.js";
import { buildSolidlyStableQLLadder, type SolidlyStablePool } from "../shared/solidly-stable-math.js";
import { buildWombatSegments, type WombatPool } from "../shared/wombat-math.js";
import { buildBalancerStableSegments, type BalancerStablePool } from "../shared/balancer-stable-math.js";
import { buildEulerSwapSegments, type EulerSwapPool } from "../shared/eulerswap-math.js";
import { buildMaverickSegments, type MaverickPool } from "../shared/maverick-math.js";
import { buildWooFiQLLadder, type WooFiPool } from "../shared/woofi-math.js";
import { buildFermiSegments, type FermiPool } from "../shared/fermi-math.js";
import { buildFluidSegments, type FluidPool } from "../shared/fluid-math.js";
import { buildMentoQLLadder, type MentoPool } from "../shared/mento-math.js";
import { buildBalancerV3Segments, type BalancerV3Pool } from "../shared/balancer-v3-math.js";

// ── Input: the TRUE live pool state ──────────────────────────

/** V3/V4 pool kind (true-state oracle). */
/**
 * TRUE live state for one pool. This is what an honest observer reads on-chain right
 * before the swap — NOT prepared brackets. V3 and V4 integrate identically (StateView is
 * just a different read path), so both use `isV2: false`.
 */
export interface OptimalPool {
  /** false = V3/V4 concentrated liquidity (live ticks); true = V2 constant product. */
  isV2: boolean;
  /** parts-per-million fee (e.g. 3000 = 0.30%). V2 is pinned to 3000 (engine _swapV2). */
  feePpm: number;

  // ── V3/V4 live state ──
  /** Live REAL sqrtPriceX96 (token1/token0), Q96. Required for V3/V4. */
  sqrtPriceX96?: bigint;
  /** Live (exact) current tick. Required for V3/V4. */
  tick?: number;
  /** tickSpacing. Required for V3/V4. */
  tickSpacing?: number;
  /** Live active liquidity L at the current tick. Required for V3/V4. */
  liquidity?: bigint;
  /**
   * Full initialized-tick liquidityNet curve over the relevant range, keyed by SIGNED
   * tick (NOT shifted). Must cover every initialized boundary the trade could cross,
   * INCLUDING beyond any prepared window. Missing key ⇒ liquidityNet 0 (L unchanged).
   * Values are signed int128 (positive on add-from-below, negative on the upper edge).
   */
  net?: Map<number, bigint>;

  // ── V2 live state ──
  /** Live tokenIn-side reserve (constant product). Required for V2. */
  reserveIn?: bigint;
  /** Live tokenOut-side reserve. Required for V2. */
  reserveOut?: bigint;
  /**
   * KyberSwap Classic / DMM only: the VIRTUAL reserves the amplified constant-product curve
   * trades on. When present they OVERRIDE reserveIn/reserveOut for the V2 segment geometry
   * (L = isqrt(vReserveIn·vReserveOut), spot out/in = sqrt(vReserveOut/vReserveIn)) — a Kyber
   * pool is a V2 range on the virtual reserves. The per-pool `feePpm` is the rounded Kyber
   * fee, the SAME ppm the on-chain merge grosses by, so the split stays wei-exact. (This is
   * the "thin v2Segments variant carrying the virtual reserves" — it reuses the V2 stream
   * verbatim with the virtual reserves substituted in.)
   */
  vReserveIn?: bigint;
  /** KyberSwap Classic / DMM only: the tokenOut-side VIRTUAL reserve. */
  vReserveOut?: bigint;

  // ── Sampled-segment venue live state (Curve / LB / DODO) ──
  /**
   * Curve StableSwap pool — when present this pool is a QUOTE-LADDER (QL) venue (NOT V2/V3). The
   * oracle builds its segments via the SHARED buildCurveQLLadder replay — the IDENTICAL geometric
   * quote ladder the on-chain solver builds in setup from live get_dy — so the split is wei-exact vs
   * the solver by construction (no prepared segments). The marginal is post-fee (get_dy nets the
   * fee), so it enters the descending-price merge directly. `isV2` is ignored when `curve` is set.
   */
  curve?: CurvePool;
  /**
   * Trader Joe LB pair — when present this pool is an LB venue (NOT V2/V3/Curve). The oracle
   * enumerates its segments via the SHARED exact per-bin enumerator (buildLbSegments) from the
   * live bin reserves, so the split is EXACT (no grid error — a bin is a flat constant-sum slice).
   * The marginal is post-fee. `isV2`/`curve` are ignored when `lb` is set.
   */
  lb?: LbPool;
  /**
   * DODO V2 PMM pool — when present this pool is a DODO venue (NOT V2/V3/Curve/LB). The oracle
   * enumerates its segments via the SHARED closed-form replay (buildDodoSegments) from the live PMM
   * state, so the split is exact-on-grid vs prepare's segments. The guide price `i` is POOL STATE
   * (read live), so the curve is deterministic. The marginal is post-fee. `isV2`/`curve`/`lb` are
   * ignored when `dodo` is set.
   */
  dodo?: DodoPool;
  /**
   * Solidly STABLE (sAMM) pool — when present this pool is a QUOTE-LADDER (QL) SOLIDLY-STABLE venue (NOT
   * V2/V3/Curve/LB/DODO). The oracle builds its segments via the SHARED buildSolidlyStableQLLadder replay
   * — the IDENTICAL geometric quote ladder the on-chain solver builds in setup from live getAmountOut — so
   * the split is wei-exact vs the solver by construction (no prepared segments). The marginal is post-fee
   * (getAmountOutStable nets the fee), so it enters the descending-price merge directly. `isV2`/`curve`/
   * `lb`/`dodo` are ignored when `solidlyStable` is set.
   */
  solidlyStable?: SolidlyStablePool;
  /**
   * Wombat (single-sided stableswap) pool — when present this pool is a WOMBAT venue (NOT
   * V2/V3/Curve/LB/DODO/Solidly). The oracle enumerates its segments via the SHARED closed-form
   * coverage-ratio replay (buildWombatSegments) from the live from/to asset cash/liability + amp +
   * haircut, so the split is exact-on-grid vs prepare's segments (one replay). The marginal is
   * post-haircut (quotePotentialSwap nets the haircut), so it enters the descending-price merge
   * directly. `isV2`/`curve`/`lb`/`dodo`/`solidlyStable` are ignored when `wombat` is set.
   */
  wombat?: WombatPool;
  /**
   * Balancer V2 ComposableStable pool — when present this pool is a BALANCER-STABLE venue (NOT
   * V2/V3/Curve/LB/DODO/Solidly/Wombat). The oracle enumerates its segments via the SHARED bigint
   * StableMath replay (buildBalancerStableSegments) from the live invariant state (amp, NON-BPT
   * balances + scaling factors, fee), so the split is exact-on-grid vs prepare's segments (one replay).
   * The marginal is post-fee (getDy nets the swap fee), so it enters the descending-price merge
   * directly. `isV2`/`curve`/`lb`/`dodo`/`solidlyStable`/`wombat` are ignored when `balancer` is set.
   */
  balancer?: BalancerStablePool;
  /**
   * EulerSwap (Euler vault-backed AMM, v1+v2) pool — when present this pool is an EULERSWAP venue (NOT
   * V2/V3/Curve/LB/DODO/Solidly/Wombat/Balancer). The oracle enumerates its segments via the SHARED
   * closed-form f/fInverse curve replay (buildEulerSwapSegments) from the live reserves + static curve
   * params + fee (bounded by the vault inLimit), so the split is exact-on-grid vs prepare's segments (one
   * replay). The marginal is post-fee (computeQuote nets the fee), so it enters the descending-price merge
   * directly. `isV2`/`curve`/`lb`/`dodo`/`solidlyStable`/`wombat`/`balancer` are ignored when `eulerSwap`
   * is set.
   */
  eulerSwap?: EulerSwapPool;
  /**
   * Maverick V2 (bin-based directional AMM) pool — when present this pool is a MAVERICK venue (NOT
   * V2/V3/Curve/LB/DODO/Solidly/Wombat/Balancer/Euler). The oracle enumerates its segments via the
   * SHARED bin swap-math replay (buildMaverickSegments) from the live tick book + directional fee +
   * the engine's per-direction FULL-RANGE tickLimit (type(int32).max/min — ../sauce PR #193), so the
   * split is exact-on-grid vs prepare's segments (one replay). The
   * marginal is post-fee (getDy nets the directional fee), so it enters the descending-price merge
   * directly. `isV2`/`curve`/`lb`/`dodo`/`solidlyStable`/`wombat`/`balancer`/`eulerSwap` are ignored
   * when `maverick` is set.
   */
  maverick?: MaverickPool;
  /**
   * Curve CryptoSwap (twocrypto/tricrypto-ng volatile-asset) pool — when present this pool is a
   * QUOTE-LADDER (QL) CRYPTOSWAP venue (NOT V2/V3/Curve-stable/LB/DODO/Solidly/Wombat/Balancer/Euler/
   * Maverick). The oracle builds its segments via the SHARED buildCryptoSwapQLLadder replay — the
   * IDENTICAL geometric quote ladder the on-chain solver builds in setup from live get_dy — so the split
   * is wei-exact vs the solver by construction (no prepared segments). The CryptoSwap marginalOI is the
   * post-fee execution price (getDyCrypto nets the dynamic fee); adjNear == adjFar == marginalOI. All the
   * other venue fields are ignored when `cryptoSwap` is set.
   */
  cryptoSwap?: CryptoSwapPool;
  /**
   * WOOFi (WooPPV2 sPMM) pool — when present this pool is a QUOTE-LADDER (QL) WOOFi venue (NOT V2/V3/
   * Curve/LB/DODO/Solidly/Wombat/Balancer/Euler/Maverick/CryptoSwap). WOOFi is an ORACLE-PRICED synthetic
   * proactive market maker: the oracle builds its segments via the SHARED buildWooFiQLLadder replay — the
   * IDENTICAL geometric quote ladder the on-chain solver builds in setup from live tryQuery — so the split
   * is wei-exact vs the solver by construction (no prepared segments; the ladder prices at the LIVE oracle,
   * no snapshot). The WOOFi marginalOI is the post-fee execution price (query nets the swap fee); adjNear
   * == adjFar == marginalOI. All the other venue fields are ignored when `woofi` is set.
   */
  woofi?: WooFiPool;
  /**
   * Fermi / propAMM (gattaca-com/propamm FermiSwap — Obric-style proactive AMM) pool — when present this
   * pool is a FERMI venue (NOT V2/V3/Curve/LB/DODO/Solidly/Wombat/Balancer/Euler/Maverick/CryptoSwap/WOOFi).
   * The oracle enumerates its segments via the SHARED closed-form replay (buildFermiSegments) from the
   * SNAPSHOT K/base + fee, so the split is exact-on-grid vs prepare's segments (one replay at the SAME
   * snapshot). The Fermi marginalOI is the post-fee execution price (getAmountOut nets the swap fee); adjNear
   * == adjFar == marginalOI. All the other venue fields are ignored when `fermi` is set.
   */
  fermi?: FermiPool;
  /**
   * Fluid DEX (Instadapp fluid-contracts-public FluidDexT1 — Liquidity-Layer-backed re-centering AMM) pool
   * — when present this pool is a FLUID venue (NOT V2/V3/Curve/LB/DODO/Solidly/Wombat/Balancer/Euler/
   * Maverick/CryptoSwap/WOOFi/Fermi). The oracle enumerates its segments via the SHARED sampler
   * (buildFluidSegments) from the pool's LIVE estimateSwapIn ladder (the same (cumIn, cumOut) points prepare
   * sampled), so the split is exact-on-grid vs prepare's segments (one shared ladder). The Fluid marginalOI
   * is the post-fee + post-cap execution price (the resolver estimate nets the swap fee + utilization);
   * adjNear == adjFar == marginalOI. All the other venue fields are ignored when `fluid` is set.
   */
  fluid?: FluidPool;
  /**
   * Mento V2 (Celo mento-protocol/mento-core Broker + BiPoolManager stablecoin exchange) venue — when
   * present this pool is a MENTO venue (NOT any of the above). The oracle enumerates its segments via the
   * SHARED sampler (buildMentoSegments) from the venue's LIVE Broker getAmountOut ladder (the same
   * (cumIn, cumOut) points prepare sampled), so the split is exact-on-grid vs prepare's segments (one shared
   * ladder). The Mento marginalOI is the post-spread execution price (the Broker getAmountOut folds the
   * spread into the quote); adjNear == adjFar == marginalOI. All the other venue fields are ignored when
   * `mento` is set.
   */
  mento?: MentoPool;
  /**
   * Balancer V3 (balancer-v3-monorepo — Vault singleton + per-chain Router) venue — when present this pool
   * is a BALANCER-V3 venue (NOT any of the above). The oracle enumerates its segments via the SHARED sampler
   * (buildBalancerV3Segments) from the venue's LIVE Router querySwapSingleTokenExactIn ladder (the same
   * (cumIn, cumOut) points prepare sampled), so the split is exact-on-grid vs prepare's segments (one shared
   * ladder). The Balancer V3 marginalOI is the post-fee + post-rate execution price (the query folds the
   * static fee + any dynamic surge-hook fee + rate scaling in); adjNear == adjFar == marginalOI. All the
   * other venue fields are ignored when `balancerV3` is set.
   */
  balancerV3?: BalancerV3Pool;
}

/**
 * A multi-hop route leg — ONE hop of a route, as TRUE live state. A leg is a SET of pools the
 * leg SPLITS ACROSS (the leg-internal water-fill), each of either kind; the leg's own swap
 * direction is `zeroForOne` (a route can change direction per hop). A SINGLE-pool leg
 * (`pools.length === 1`) reduces bit-identically to the old one-pool-per-leg model.
 *
 * THE LEG-INTERNAL WATER-FILL (the k>=3 multi-pool fix). A multi-pool leg is NOT a set of
 * parallel routes sharing the downstream chain (that decomposition over-credits the shared
 * downstream depth and is correct only at k=2). It is an INTERNAL water-fill: the leg's pools
 * split so the LEG-INTERNAL post-fee marginal equalizes, and the leg's AGGREGATE throughput
 * feeds the chain. The oracle models this exactly the way the global merge models direct pools:
 * each leg pool walks its OWN constant-L bracket frontier from its true live spot, and the leg's
 * CURRENT bracket each event is its leg-internal BEST pool (highest fee-adjusted out/in near; tie
 * → higher far) — a leg-internal price-ordered merge nested inside the route event. As the cut
 * descends the leg's best pool rotates (a cheaper-fee pool drains first, a dearer one engages when
 * the cut reaches its fee-adjusted near), so over the trade the leg's liquidity is split across
 * all its pools at a common leg-internal marginal. This is INDEPENDENT of the cursor-faithful
 * reference (it derives every bracket from true live state) yet wei-exact with it BY CONSTRUCTION
 * — both share the per-step integer math AND the identical leg-internal best-pool selection +
 * `routeEventN`.
 */
export interface OptimalRouteLeg {
  /** This hop's swap direction (leg input → leg output). May differ per hop. */
  zeroForOne: boolean;
  /** The leg's pools (the leg splits across all of them via the leg-internal merge). */
  pools: OptimalPool[];
}

/**
 * A multi-hop route as a chain of LEGS, built from TRUE LIVE leg state — the oracle's
 * own route input, INDEPENDENT of EcoSwapPrepared. The route competes in the global merge
 * as ONE venue whose head is the LEFT-TO-RIGHT product fold (`routeHeadFold`) of its legs'
 * leg-internal-best fee-adjusted out/in heads; advancing the route binds whichever leg crosses
 * its tick first (conservation: leg i output == leg i+1 input), and a multi-pool leg splits
 * INTERNALLY (leg-internal merge, NOT parallel routes). N legs (k >= 2); the event loop
 * (`routeSegments`) is arbitrary-k via `routeEventN`.
 */
export interface OptimalRoute {
  legs: OptimalRouteLeg[];
}

export interface OptimalInput {
  pools: OptimalPool[];
  /** Multi-hop routes — extra venues composed from TRUE live leg state. Optional. */
  routes?: OptimalRoute[];
  amountIn: bigint;
  zeroForOne: boolean;
  /**
   * REAL-sqrt-space price limit (direction-dependent). A V3/V4 pool's walk stops once a
   * step would cross it. 0 / undefined ⇒ no limit (walk to liquidity exhaustion / cap).
   */
  priceLimit?: bigint;
}

export interface OptimalResult {
  /** Gross tokenIn assigned to pools[i] (same indexing as input.pools). */
  perPoolInput: bigint[];
  /** Gross route input (leg-1 input) assigned to routes[i] (same indexing as input.routes). */
  perRouteInput: bigint[];
  /** Σ perPoolInput + Σ perRouteInput (≤ amountIn; == amountIn when liquidity allows). */
  totalInput: bigint;
  /**
   * The common fee-adjusted out/in marginal price at the cut — the price below which no
   * pool was funded. Diagnostic / used by the equalization assertion.
   */
  cutAdjPrice: bigint;
  /** Per-pool fee-adjusted out/in marginal price reached (the cut edge each pool stopped at). */
  perPoolMarginalAdj: bigint[];
}

// ── Step / cap constants ─────────────────────────────────────

/**
 * Hard PER-POOL step budget — walked per V3/V4 pool (and, as MAX_V2_SLICES, per V2 pool).
 *
 * This is the MEASURING-STICK side of the B2 run-until-filled budget: it MUST equal the
 * on-chain solver's PER_POOL (ecoswap.sauce.ts) and the reference's PER_POOL
 * (ecoswap.solver-reference.ts) EXACTLY, so the oracle and the solver agree to the wei EVEN
 * WHEN THE CAP BINDS (a price excursion deeper than the budget truncates BOTH identically).
 *
 * 2048 ts=10 steps ≈ a 7.75× price excursion per pool — far past any realistic out-of-range
 * case — while a single pool walking the full budget on anvil costs ≈1.15e9 gas (measured),
 * comfortably under the 1.9e9 anvil cook ceiling (per-step ≈419K shallow, rising to ≈640K
 * at depth via memory/larger-value arithmetic). Larger budgets (≥3000) hit the ceiling, so
 * 2048 is the largest budget where a single pool can reach the cap and still cook.
 */
const MAX_V3_STEPS = 2048;
/** Hard safety cap on V2 geometric slices per pool — same PER_POOL budget. */
const MAX_V2_SLICES = 2048;

// ── Fee-adjust on a raw out/in price (segment sort key) ──────
//
// The cross-pool comparison key. Matches prepare.ts feeAdjust EXACTLY:
//   feeAdjust(sqrtSpot, feePpm) = sqrtSpot * sqrtOneMinusFeeScaled(feePpm) / FEE_DENOM
// (sqrtOneMinusFeeScaled = isqrt((1e6 - feePpm) * 1e6)). This is the SAME number the
// brackets carry as sqrtAdjNear, so the oracle's price ordering is bit-identical to the
// ladder the solver consumes.
function feeAdjOI(oi: bigint, feePpm: number): bigint {
  return (oi * sqrtOneMinusFeeScaled(feePpm)) / FEE_DENOM;
}

// ── A price-ordered candidate segment ────────────────────────
//
// One constant-L span of one pool: [nearOI (entry, higher price), farOI (exit, lower)]
// with the gross tokenIn (incl. fee) to traverse it fully. `adjNear` is the fee-adjusted
// near price — the sort key. Segments are produced in each pool's natural descending-price
// order, so the per-pool list is already sorted; the global merge interleaves pools.
interface Segment {
  /** "pool" ⇒ index into perPoolInput; "route" ⇒ index into perRouteInput. */
  venue: "pool" | "route";
  idx: number;
  /** fee-adjusted out/in price at the near (entry) edge — DESC sort key. */
  adjNear: bigint;
  /** fee-adjusted out/in price at the far (exit) edge — the marginal if fully consumed. */
  adjFar: bigint;
  /**
   * gross tokenIn (incl. fee) to traverse the whole segment. For a route this is the
   * route-level input (leg-1 gross input) over the event — what the merge consumes.
   */
  gross: bigint;
}

/**
 * Enumerate one V3/V4 pool's segments by walking initialized ticks in the swap direction
 * from the live spot, EXACTLY as the on-chain forward walk does (multiplicative stepReal,
 * out/in integration, per-segment fee-grossup, ±liquidityNet on each crossing).
 *
 * The first segment's near edge is the LIVE spot real sqrt; each subsequent near edge is
 * the previous far. Crossing the boundary tick updates L. Stops at the price limit, when L
 * stays 0 with no further initialized ticks reachable within the cap, or at MAX_V3_STEPS.
 */
function v3Segments(p: OptimalPool, poolIdx: number, zeroForOne: boolean, priceLimit: bigint): Segment[] {
  const segs: Segment[] = [];
  const feePpm = p.feePpm;
  // multiplicative step ratio = getSqrtRatioAtTick(tickSpacing); the solver uses the
  // SAME stepReal walk seeded from this (== prepare's adaptiveStepRatio).
  const stepRatio = getSqrtRatioAtTick(p.tickSpacing!);

  let L = p.liquidity!;
  let nearReal = p.sqrtPriceX96!; // live spot real sqrt
  const base = Math.floor(p.tick! / p.tickSpacing!) * p.tickSpacing!;
  // first boundary tick in the swap direction (signed, NOT shifted): mirrors
  // buildV3Brackets / the solver — zeroForOne crosses base first, oneForZero base+ts.
  let boundary = zeroForOne ? base : base + p.tickSpacing!;

  // The extreme initialized tick in the walk direction — once the boundary passes it AND L
  // has gone to 0, the pool can produce no further capacity, so the walk terminates early
  // (instead of spinning out the full step cap). Empty net ⇒ no boundaries ⇒ a single
  // constant-L curve, which still terminates via the L>0 / step-cap conditions.
  // Only INITIALIZED ticks (net != 0) gate exhaustion — a deep zero-net key would never
  // change L, so it must not extend the walk past the last real boundary. (No-op on
  // producible data, where every net key is nonzero; hardens the gate against a fixture
  // injecting a zero-net key.)
  const netTicks = p.net ? [...p.net.entries()].filter(([, n]) => n !== 0n).map(([t]) => t) : [];
  const haveTicks = netTicks.length > 0;
  const extremeTick = haveTicks
    ? zeroForOne
      ? Math.min(...netTicks)
      : Math.max(...netTicks)
    : 0;

  for (let k = 0; k < MAX_V3_STEPS; k++) {
    // Exhaustion: L drained to 0 and no initialized tick remains ahead → done.
    if (L === 0n && haveTicks) {
      const past = zeroForOne ? boundary < extremeTick : boundary > extremeTick;
      if (past) break;
    }
    const farReal = stepReal(nearReal, stepRatio, zeroForOne);
    // price-limit guard (REAL-sqrt space) — stop before crossing a binding limit.
    if (priceLimit > 0n) {
      if (zeroForOne) {
        if (farReal <= priceLimit) break;
      } else {
        if (farReal >= priceLimit) break;
      }
    }
    const nearOI = toOutIn(nearReal, zeroForOne);
    const farOI = toOutIn(farReal, zeroForOne);
    if (L > 0n && nearOI > farOI && farOI > 0n) {
      const effIn = mulDiv(L, Q96, farOI) - mulDiv(L, Q96, nearOI);
      if (effIn > 0n) {
        const gross = mulDiv(effIn, FEE_DENOM, FEE_DENOM - BigInt(feePpm));
        if (gross > 0n) {
          segs.push({
            venue: "pool",
            idx: poolIdx,
            adjNear: feeAdjOI(nearOI, feePpm),
            adjFar: feeAdjOI(farOI, feePpm),
            gross,
          });
        }
      }
    }
    // cross the boundary tick: update L by ±liquidityNet (raw-uint128 sign branches).
    const signedNet = (p.net?.get(boundary)) ?? 0n;
    const raw = signedNet >= 0n ? signedNet : signedNet + MOD128;
    const neg = raw >= HALF128;
    if (zeroForOne) {
      if (neg) L = L + (MOD128 - raw);
      else L = L >= raw ? L - raw : 0n;
      boundary -= p.tickSpacing!;
    } else {
      if (neg) {
        const mag = MOD128 - raw;
        L = L >= mag ? L - mag : 0n;
      } else {
        L = L + raw;
      }
      boundary += p.tickSpacing!;
    }
    nearReal = farReal;
  }
  return segs;
}

/**
 * Enumerate one V2 pool's segments as constant-L geometric out/in slices from the live
 * spot. L = √(reserveIn·reserveOut); spot out/in = √(reserveOut/reserveIn). Slices step
 * far = near − near·V2_STEP_BPS/V2_STEP_DEN at constant L, mirroring buildV2Brackets and
 * the on-chain V2 stream EXACTLY.
 */
function v2Segments(p: OptimalPool, poolIdx: number): Segment[] {
  const segs: Segment[] = [];
  // KyberSwap Classic / DMM trades on VIRTUAL reserves: when present they replace the real
  // reserves for the constant-L geometry (L = √(vIn·vOut), spot out/in = √(vOut/vIn)). The
  // step, fee-grossup and integration are byte-identical to a plain V2 pool — only the
  // reserves seeding L and the spot differ.
  const reserveIn = p.vReserveIn ?? p.reserveIn!;
  const reserveOut = p.vReserveOut ?? p.reserveOut!;
  if (reserveIn <= 0n || reserveOut <= 0n) return segs;
  const L = isqrt(reserveIn * reserveOut);
  const feePpm = p.feePpm;
  let near = isqrt((reserveOut * Q192) / reserveIn); // out/in spot sqrt
  for (let i = 0; i < MAX_V2_SLICES; i++) {
    const far = near - mulDiv(near, V2_STEP_BPS, V2_STEP_DEN);
    if (far <= 0n || far >= near) break;
    if (L > 0n) {
      const effIn = mulDiv(L, Q96, far) - mulDiv(L, Q96, near);
      if (effIn > 0n) {
        const gross = mulDiv(effIn, FEE_DENOM, FEE_DENOM - BigInt(feePpm));
        if (gross > 0n) {
          segs.push({
            venue: "pool",
            idx: poolIdx,
            adjNear: feeAdjOI(near, feePpm),
            adjFar: feeAdjOI(far, feePpm),
            gross,
          });
        }
      }
    }
    near = far;
  }
  return segs;
}

/**
 * Enumerate one Curve StableSwap pool's segments via the QUOTE-LADDER live walk (buildCurveQLLadder)
 * — the SAME geometric-slice ladder the on-chain solver builds in setup from live get_dy, replayed
 * here through the shared bigint get_dy so the oracle and solver stay wei-exact BY CONSTRUCTION (no
 * prepared segments — prepare ships only the descriptor). The Curve marginalOI is ALREADY the
 * post-fee execution price (get_dy nets the fee), so adjNear == adjFar == marginalOI: it enters the
 * descending-price merge directly with no extra fee-adjust multiply. Awarded as a "pool" venue.
 */
function curveSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  for (const s of buildCurveQLLadder(p.curve!, amountIn)) {
    segs.push({ venue: "pool", idx: poolIdx, adjNear: s.marginalOI, adjFar: s.marginalOI, gross: s.capacity });
  }
  return segs;
}

/**
 * Enumerate one Trader Joe LB pair's segments via the QUOTE-LADDER live walk (buildLbQLLadder) — the SAME
 * geometric-slice ladder the on-chain solver builds in setup from the pair's live getSwapOut(xIn, swapForY),
 * INCLUDING the amountInLeft cap semantics (each slice is bounded by the LIVE fillable bin capacity
 * effAbsorbed = xIn − amountInLeft, so the oracle == solver even when the ladder crosses the pool's last
 * fillable bin — the DoS-fix bound). marginalOI is the post-(base-)fee bin price; adjNear == adjFar ==
 * marginalOI. Awarded as a "pool" venue.
 */
function lbSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  for (const s of buildLbQLLadder(p.lb!, amountIn)) {
    segs.push({ venue: "pool", idx: poolIdx, adjNear: s.marginalOI, adjFar: s.marginalOI, gross: s.capacity });
  }
  return segs;
}

/**
 * Enumerate one DODO V2 PMM pool's segments via the SHARED closed-form replay (buildDodoSegments)
 * from the live PMM state. The amountIn caps the sampled range — the same bound prepare uses — so
 * the oracle and prepare emit the IDENTICAL segment grid, making the split exact-on-grid. The DODO
 * marginalOI is the post-fee execution price (querySell* nets the LP+MT fee); adjNear == adjFar ==
 * marginalOI. The guide price `i` is read pool state (not an exogenous feed), which is what makes
 * this oracle well-defined. Awarded as a "pool" venue.
 */
function dodoSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  for (const s of buildDodoSegments(p.dodo!, amountIn)) {
    segs.push({ venue: "pool", idx: poolIdx, adjNear: s.marginalOI, adjFar: s.marginalOI, gross: s.capacity });
  }
  return segs;
}

/**
 * Enumerate one Solidly STABLE (sAMM) pool's segments via the QUOTE-LADDER live walk
 * (buildSolidlyStableQLLadder) — the SAME geometric-slice ladder the on-chain solver builds in setup from
 * live getAmountOut, replayed here through the shared bigint getAmountOutStable so the oracle and solver
 * stay wei-exact BY CONSTRUCTION (no prepared segments — prepare ships only the descriptor). The stable
 * marginalOI is ALREADY the post-fee execution price (getAmountOut nets the fee), so adjNear == adjFar ==
 * marginalOI: it enters the descending-price merge directly with no extra fee-adjust. Awarded as a "pool" venue.
 */
function solidlyStableSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  for (const s of buildSolidlyStableQLLadder(p.solidlyStable!, amountIn)) {
    segs.push({ venue: "pool", idx: poolIdx, adjNear: s.marginalOI, adjFar: s.marginalOI, gross: s.capacity });
  }
  return segs;
}

/**
 * Enumerate one Wombat pool's segments via the SHARED closed-form replay (buildWombatSegments) from
 * the live from/to asset cash/liability + amp + haircut. The amountIn caps the sampled range — the
 * same bound prepare uses — so the oracle and prepare emit the IDENTICAL segment grid (single source),
 * making the split exact-on-grid. The Wombat marginalOI is the post-haircut execution price
 * (quotePotentialSwap nets the haircut); adjNear == adjFar == marginalOI. Awarded as a "pool" venue.
 */
function wombatSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  for (const s of buildWombatSegments(p.wombat!, amountIn)) {
    segs.push({ venue: "pool", idx: poolIdx, adjNear: s.marginalOI, adjFar: s.marginalOI, gross: s.capacity });
  }
  return segs;
}

/**
 * Enumerate one Balancer V2 ComposableStable pool's segments via the SHARED bigint StableMath replay
 * (buildBalancerStableSegments) from the live invariant state. The amountIn caps the sampled range —
 * the same bound prepare uses — so the oracle and prepare emit the IDENTICAL segment grid (single
 * source), making the split exact-on-grid. The Balancer marginalOI is the post-fee execution price
 * (getDy nets the swap fee); adjNear == adjFar == marginalOI. Awarded as a "pool" venue.
 */
function balancerStableSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  for (const s of buildBalancerStableSegments(p.balancer!, amountIn)) {
    segs.push({ venue: "pool", idx: poolIdx, adjNear: s.marginalOI, adjFar: s.marginalOI, gross: s.capacity });
  }
  return segs;
}

/**
 * Enumerate one EulerSwap (Euler vault-backed AMM, v1+v2) pool's segments via the SHARED closed-form
 * f/fInverse curve replay (buildEulerSwapSegments) from the live reserves + static curve params + fee
 * (bounded by the vault inLimit). The amountIn caps the sampled range — the same bound prepare uses — so
 * the oracle and prepare emit the IDENTICAL segment grid (single source), making the split exact-on-grid.
 * The EulerSwap marginalOI is the post-fee execution price (computeQuote nets the fee); adjNear == adjFar
 * == marginalOI. Awarded as a "pool" venue.
 */
function eulerSwapSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  for (const s of buildEulerSwapSegments(p.eulerSwap!, amountIn)) {
    segs.push({ venue: "pool", idx: poolIdx, adjNear: s.marginalOI, adjFar: s.marginalOI, gross: s.capacity });
  }
  return segs;
}

/**
 * Enumerate one Maverick V2 (bin-based directional AMM) pool's segments via the SHARED bin swap-math
 * replay (buildMaverickSegments) from the live tick book + directional fee + the engine's per-direction
 * FULL-RANGE tickLimit (type(int32).max/min — ../sauce PR #193, i.e. the pool's available liquidity)
 * depth cap. The amountIn caps the sampled range — the same bound prepare samples — so the oracle and
 * prepare emit the IDENTICAL segment grid (single source), making the split exact-on-grid. The Maverick
 * marginalOI is the post-fee execution price (getDy nets the directional fee); adjNear == adjFar ==
 * marginalOI. Awarded as a "pool" venue.
 */
function maverickSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  for (const s of buildMaverickSegments(p.maverick!, amountIn)) {
    segs.push({ venue: "pool", idx: poolIdx, adjNear: s.marginalOI, adjFar: s.marginalOI, gross: s.capacity });
  }
  return segs;
}

/**
 * Enumerate one Curve CryptoSwap (twocrypto/tricrypto-ng volatile-asset) pool's segments via the
 * QUOTE-LADDER live walk (buildCryptoSwapQLLadder) — the SAME geometric-slice ladder the on-chain solver
 * builds in setup from live get_dy, replayed here through the shared bigint getDyCrypto so the oracle and
 * solver stay wei-exact BY CONSTRUCTION (no prepared segments — prepare ships only the descriptor). The
 * CryptoSwap marginalOI is ALREADY the post-fee execution price (getDyCrypto nets the dynamic fee), so
 * adjNear == adjFar == marginalOI: it enters the descending-price merge directly with no extra fee-adjust
 * multiply. Awarded as a "pool" venue.
 */
function cryptoSwapSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  for (const s of buildCryptoSwapQLLadder(p.cryptoSwap!, amountIn)) {
    segs.push({ venue: "pool", idx: poolIdx, adjNear: s.marginalOI, adjFar: s.marginalOI, gross: s.capacity });
  }
  return segs;
}

/**
 * Enumerate one WOOFi (WooPPV2 sPMM) pool's segments via the QUOTE-LADDER live walk (buildWooFiQLLadder) —
 * the SAME geometric-slice ladder the on-chain solver builds in setup from live tryQuery, replayed here
 * through the shared bigint query so the oracle and solver stay wei-exact BY CONSTRUCTION (no prepared
 * segments — prepare ships only the descriptor). tryQuery's amountOut equals query's toAmount for any
 * feasible amount (both call the same _calc* sPMM math), so the query replay is the faithful model of the
 * on-chain ladder. The WOOFi marginalOI is ALREADY the post-fee execution price (query nets the swap fee),
 * so adjNear == adjFar == marginalOI. Because the ladder is built live it prices at the LIVE oracle (no
 * snapshot). Awarded as a "pool" venue.
 */
function wooFiSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  for (const s of buildWooFiQLLadder(p.woofi!, amountIn)) {
    segs.push({ venue: "pool", idx: poolIdx, adjNear: s.marginalOI, adjFar: s.marginalOI, gross: s.capacity });
  }
  return segs;
}

/**
 * Enumerate one Fermi / propAMM pool's segments via the SHARED sampler (buildFermiSegments) over the pool's
 * LIVE quote ladder (the same (cumIn, cumOut) points prepare sampled), so the oracle and prepare emit the
 * IDENTICAL segment grid from the SAME sampled snapshot (single source), making the split exact-on-grid. The
 * Fermi marginalOI is the post-fee execution price (the router folds the fee into the quote); adjNear ==
 * adjFar == marginalOI. Awarded as a "pool" venue.
 */
function fermiSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  for (const s of buildFermiSegments(p.fermi!, amountIn)) {
    segs.push({ venue: "pool", idx: poolIdx, adjNear: s.marginalOI, adjFar: s.marginalOI, gross: s.capacity });
  }
  return segs;
}

/**
 * Enumerate one Fluid DEX (Instadapp FluidDexT1) pool's segments via the SHARED sampler (buildFluidSegments)
 * over the pool's LIVE estimateSwapIn ladder (the same (cumIn, cumOut) points prepare sampled), so the
 * oracle and prepare emit the IDENTICAL segment grid from the SAME sampled snapshot (single source), making
 * the split exact-on-grid. The Fluid marginalOI is the post-fee + post-cap execution price (the resolver
 * estimate folds the fee + utilization into the quote); adjNear == adjFar == marginalOI. Awarded as a
 * "pool" venue.
 */
function fluidSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  for (const s of buildFluidSegments(p.fluid!, amountIn)) {
    segs.push({ venue: "pool", idx: poolIdx, adjNear: s.marginalOI, adjFar: s.marginalOI, gross: s.capacity });
  }
  return segs;
}

/**
 * Enumerate one Mento V2 (Celo Broker + BiPoolManager) venue's segments via the QUOTE-LADDER live walk
 * (buildMentoQLLadder) — the SAME geometric-slice ladder the on-chain solver builds in setup from the live
 * broker.getAmountOut view. The ladder is driven by the venue's closed-form bucket model (mentoQuoteClosed,
 * a bit-exact replay of the fixture Broker's getAmountOut), so the oracle == solver wei-exact BY
 * CONSTRUCTION (a real venue without a closed model falls back to the sampled-ladder interpolation). The
 * Mento marginalOI is the post-spread execution price (getAmountOut folds the spread into the quote);
 * adjNear == adjFar == marginalOI. Awarded as a "pool" venue.
 */
function mentoSegments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  for (const s of buildMentoQLLadder(p.mento!, amountIn)) {
    segs.push({ venue: "pool", idx: poolIdx, adjNear: s.marginalOI, adjFar: s.marginalOI, gross: s.capacity });
  }
  return segs;
}

/**
 * Enumerate one Balancer V3 (balancer-v3-monorepo — Vault + per-chain Router) venue's segments via the
 * SHARED sampler (buildBalancerV3Segments) over the venue's LIVE Router querySwapSingleTokenExactIn ladder
 * (the same (cumIn, cumOut) points prepare sampled), so the oracle and prepare emit the IDENTICAL segment
 * grid from the SAME sampled query snapshot (single source), making the split exact-on-grid. The Balancer V3
 * marginalOI is the post-fee + post-rate execution price (the query folds the static fee + any dynamic
 * surge-hook fee + rate scaling in); adjNear == adjFar == marginalOI. Awarded as a "pool" venue.
 */
function balancerV3Segments(p: OptimalPool, poolIdx: number, amountIn: bigint): Segment[] {
  const segs: Segment[] = [];
  for (const s of buildBalancerV3Segments(p.balancerV3!, amountIn)) {
    segs.push({ venue: "pool", idx: poolIdx, adjNear: s.marginalOI, adjFar: s.marginalOI, gross: s.capacity });
  }
  return segs;
}

// ── Route-leg frontier enumeration + route event walk ────────
//
// A route leg's frontier is the SAME constant-L bracket chain a direct pool walks — we reuse
// the exact per-step integer math (stepReal / toOutIn / ±liquidityNet for V3-V4, the geometric
// V2 step), but emit the RAW [nearOI, farOI, L, feePpm] brackets (RouteLeg) instead of priced
// Segments, because the route composes brackets across legs before pricing. legBrackets is the
// leg-level analogue of v3Segments/v2Segments and shares their loop structure verbatim.

/** Enumerate one leg POOL's constant-L brackets (out/in space) from its TRUE live spot. */
function legBrackets(leg: OptimalPool, z: boolean, priceLimit: bigint): RouteLeg[] {
  const out: RouteLeg[] = [];
  const feePpm = BigInt(leg.feePpm);

  if (leg.isV2) {
    const reserveIn = leg.reserveIn!;
    const reserveOut = leg.reserveOut!;
    if (reserveIn <= 0n || reserveOut <= 0n) return out;
    const L = isqrt(reserveIn * reserveOut);
    let near = isqrt((reserveOut * Q192) / reserveIn); // out/in spot sqrt
    for (let i = 0; i < MAX_V2_SLICES; i++) {
      const far = near - mulDiv(near, V2_STEP_BPS, V2_STEP_DEN);
      if (far <= 0n || far >= near) break;
      if (L > 0n) out.push({ nearOI: near, farOI: far, L, feePpm });
      near = far;
    }
    return out;
  }

  // V3/V4 leg — identical walk to v3Segments, emitting raw brackets.
  const stepRatio = getSqrtRatioAtTick(leg.tickSpacing!);
  let L = leg.liquidity!;
  let nearReal = leg.sqrtPriceX96!;
  const base = Math.floor(leg.tick! / leg.tickSpacing!) * leg.tickSpacing!;
  let boundary = z ? base : base + leg.tickSpacing!;
  const netTicks = leg.net ? [...leg.net.entries()].filter(([, n]) => n !== 0n).map(([t]) => t) : [];
  const haveTicks = netTicks.length > 0;
  const extremeTick = haveTicks ? (z ? Math.min(...netTicks) : Math.max(...netTicks)) : 0;

  for (let k = 0; k < MAX_V3_STEPS; k++) {
    if (L === 0n && haveTicks) {
      const past = z ? boundary < extremeTick : boundary > extremeTick;
      if (past) break;
    }
    const farReal = stepReal(nearReal, stepRatio, z);
    if (priceLimit > 0n) {
      if (z) {
        if (farReal <= priceLimit) break;
      } else {
        if (farReal >= priceLimit) break;
      }
    }
    const nearOI = toOutIn(nearReal, z);
    const farOI = toOutIn(farReal, z);
    if (L > 0n && nearOI > farOI && farOI > 0n) {
      out.push({ nearOI, farOI, L, feePpm });
    }
    const signedNet = leg.net?.get(boundary) ?? 0n;
    const raw = signedNet >= 0n ? signedNet : signedNet + MOD128;
    const neg = raw >= HALF128;
    if (z) {
      if (neg) L = L + (MOD128 - raw);
      else L = L >= raw ? L - raw : 0n;
      boundary -= leg.tickSpacing!;
    } else {
      if (neg) {
        const mag = MOD128 - raw;
        L = L >= mag ? L - mag : 0n;
      } else {
        L = L + raw;
      }
      boundary += leg.tickSpacing!;
    }
    nearReal = farReal;
  }
  return out;
}

/**
 * Enumerate one ROUTE's price-monotone segments by walking a price-ordered k-way merge across
 * its legs' frontiers (`legBrackets`). N-LEG (k >= 2, `routeEventN`): at each event every leg sits
 * on its current constant-L bracket; the BINDING leg (the one whose full tick-cross maps to the
 * smallest token-A input when back-propagated through the chain) crosses its own tick first, every
 * other leg partially fills (conservation: leg i out == leg i+1 in at every intermediate). The
 * bound leg advances to its next bracket; each partial leg's near becomes its event new far. The
 * route's segment carries the route-level input as `gross` and the fee-adjusted route head
 * (LEFT-TO-RIGHT product fold of the legs' fee-adjusted near / far heads via routeHeadFold) as
 * adjNear / adjFar — directly comparable to a direct pool's adjNear, so the route competes in the
 * SAME global merge.
 *
 * Reduces EXACTLY to the prior 2-hop walk at k=2 (routeEventN is a bit-identical superset of
 * routeEvent2; the per-leg cursor advance below specializes to the old `i1/i2` advance for two
 * legs — the binding leg's cursor steps, every other leg's near moves to its new far and its
 * cursor advances past any fully-crossed bracket). 3-hop lands concretely; the loop is arbitrary-k.
 */
function routeSegments(route: OptimalRoute, routeIdx: number): Segment[] {
  const segs: Segment[] = [];
  const k = route.legs.length;
  if (k < 2) return segs; // a route is at least 2 hops

  // ── Per-leg-POOL fixed bracket lists (walked once from each leg pool's true live spot) + a
  // per-leg-pool cursor + current bracket near (a partial leg pool carries an advanced near after
  // an event). A leg is a SET of pools; the leg's CURRENT bracket each event is its leg-internal
  // BEST pool (the leg-internal merge), so a multi-pool leg splits internally rather than
  // decomposing into parallel routes. A single-pool leg reduces bit-identically (one pool always
  // wins its own leg merge, so the per-leg bracket is exactly the old single-pool bracket). ──
  //
  // NO per-leg priceLimit: the swap's REAL-sqrt priceLimit is a bound on the OVERALL swap (it gates
  // the DIRECT pools via v3Segments). A route's legs are NOT individually limited by it — the
  // on-chain solver's route advance crosses a binding leg's tick with NO dlim check; a route is
  // bounded only by conservation + its participation in the global merge cut. Pass 0n (no per-leg
  // limit) to gate the oracle bit-identically to the solver/reference.
  const legPoolBrks: RouteLeg[][][] = route.legs.map((leg) =>
    leg.pools.map((p) => legBrackets(p, leg.zeroForOne, 0n)),
  );
  const legPoolFees: number[][] = route.legs.map((leg) => leg.pools.map((p) => p.feePpm));
  // per-leg-pool cursor into its bracket list + current near (advanced on a partial fill).
  const cur: number[][] = legPoolBrks.map((legBr) => legBr.map(() => 0));
  const near: bigint[][] = legPoolBrks.map((legBr) =>
    legBr.map((b) => (b.length ? b[0].nearOI : 0n)),
  );

  // A leg pool is exhausted when its cursor runs off its bracket list; a leg is dead when ALL its
  // pools are exhausted (no active pool). The route is dead when any leg is dead.
  const poolActive = (i: number, j: number): boolean => cur[i][j] < legPoolBrks[i][j].length;
  const legDead = (i: number): boolean => !legPoolBrks[i].some((_, j) => poolActive(i, j));

  // The leg-internal BEST pool: highest fee-adjusted out/in near among the leg's ACTIVE pools, ties
  // → higher fee-adjusted far (mirrors the global merge sort + the reference's routeLegBest). The
  // leg's current bracket [near, far, L, fee] is that pool's current bracket. Returns -1 if none.
  function legBestPool(i: number): number {
    let best = -1;
    let bestAdj = 0n;
    let bestFarAdj = 0n;
    for (let j = 0; j < legPoolBrks[i].length; j++) {
      if (!poolActive(i, j)) continue;
      const fee = legPoolFees[i][j];
      const nAdj = feeAdjOI(near[i][j], fee);
      if (nAdj >= bestAdj) {
        const fAdj = feeAdjOI(legPoolBrks[i][j][cur[i][j]].farOI, fee);
        if (best < 0 || nAdj > bestAdj || (nAdj === bestAdj && fAdj > bestFarAdj)) {
          bestAdj = nAdj;
          bestFarAdj = fAdj;
          best = j;
        }
      }
    }
    return best;
  }

  for (let step = 0; step < MAX_V3_STEPS; step++) {
    if (route.legs.some((_, i) => legDead(i))) break;

    // Build each leg's current RouteLeg from its leg-internal BEST pool on the FIXED live grid.
    const legBestIdx: number[] = new Array(k);
    const legs: RouteLeg[] = new Array(k);
    const adjFns: ((oi: bigint) => bigint)[] = new Array(k);
    let degenerate = false;
    for (let i = 0; i < k; i++) {
      const j = legBestPool(i);
      if (j < 0) {
        degenerate = true;
        break;
      }
      const fee = legPoolFees[i][j];
      const b = legPoolBrks[i][j][cur[i][j]];
      legBestIdx[i] = j;
      legs[i] = { nearOI: near[i][j], farOI: b.farOI, L: b.L, feePpm: BigInt(fee) };
      adjFns[i] = (oi: bigint) => feeAdjOI(oi, fee);
      if (legs[i].nearOI <= legs[i].farOI) degenerate = true;
    }
    if (degenerate) break;

    // Route head at the segment edges: product fold of the per-leg leg-internal-best fee-adjusted
    // out/in heads.
    const adjNear = routeHeadFold(legs.map((l, i) => adjFns[i](l.nearOI)));
    const ev = routeEventN(legs);
    const adjFar = routeHeadFold(ev.newFars.map((f, i) => adjFns[i](f)));

    if (ev.routeIn > 0n && adjNear > 0n) {
      segs.push({ venue: "route", idx: routeIdx, adjNear, adjFar, gross: ev.routeIn });
    }

    // Advance: in the BOUND leg the leg-internal best pool crosses its tick (next bracket); in every
    // OTHER leg the leg-internal best pool's near moves to its event new far. routeEventN guarantees
    // the partial fill fits WITHIN the bracket, so the partial near lands inside [farOI, nearOI];
    // once it reaches the far it has crossed the bracket entirely — advance that pool's cursor past
    // every bracket whose far the new near has reached, so its NEXT event sits on the bracket that
    // actually contains the near. Only the leg-internal best pool moves per event; the leg's OTHER
    // pools stay put until the cut descends to engage them (the leg-internal merge).
    for (let i = 0; i < k; i++) {
      const j = legBestIdx[i];
      if (i === ev.bindLeg) {
        cur[i][j]++;
        near[i][j] = cur[i][j] < legPoolBrks[i][j].length ? legPoolBrks[i][j][cur[i][j]].nearOI : 0n;
      } else {
        near[i][j] = ev.newFars[i];
        while (cur[i][j] < legPoolBrks[i][j].length && near[i][j] <= legPoolBrks[i][j][cur[i][j]].farOI) {
          cur[i][j]++;
        }
      }
    }
  }
  return segs;
}

/**
 * The neutral optimal split. Enumerate every pool's price-monotone segments from TRUE live
 * state, merge globally in DESCENDING fee-adjusted-near-price order, and water-fill to the
 * common cut (cum == amountIn; crossing segment takes the exact remainder).
 */
export function optimalSplit(input: OptimalInput): OptimalResult {
  const { pools, amountIn, zeroForOne } = input;
  const routes = input.routes ?? [];
  const priceLimit = input.priceLimit ?? 0n;

  const perPoolInput: bigint[] = new Array(pools.length).fill(0n);
  const perRouteInput: bigint[] = new Array(routes.length).fill(0n);
  const perPoolMarginalAdj: bigint[] = new Array(pools.length).fill(0n);

  // Enumerate all candidate segments across all pools AND routes — both produce price-monotone
  // segments tagged by venue, so they compete in ONE global price-descending merge.
  const allSegs: Segment[] = [];
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    if (p.balancerV3) {
      // Balancer V3 (Vault + per-chain Router) venue: sampled-segment enumeration via the shared sampler over
      // the venue's LIVE querySwapSingleTokenExactIn ladder (the same bound prepare samples → identical grid
      // → exact-on-grid split).
      allSegs.push(...balancerV3Segments(p, i, amountIn));
    } else if (p.mento) {
      allSegs.push(...mentoSegments(p, i, amountIn));
    } else if (p.fluid) {
      allSegs.push(...fluidSegments(p, i, amountIn));
    } else if (p.fermi) {
      allSegs.push(...fermiSegments(p, i, amountIn));
    } else if (p.woofi) {
      allSegs.push(...wooFiSegments(p, i, amountIn));
    } else if (p.cryptoSwap) {
      // Curve CryptoSwap (twocrypto/tricrypto-ng volatile-asset) venue: QUOTE-LADDER enumeration via the
      // shared buildCryptoSwapQLLadder (the IDENTICAL geometric ladder the solver builds on-chain from
      // live get_dy → wei-exact split by construction).
      allSegs.push(...cryptoSwapSegments(p, i, amountIn));
    } else if (p.maverick) {
      // Maverick V2 (bin-based directional AMM) venue: sampled-segment enumeration via the shared bin
      // swap-math replay (capped at amountIn / the engine's per-direction FULL-RANGE tickLimit depth,
      // type(int32).max/min — the same bound prepare samples → identical grid → exact-on-grid split).
      allSegs.push(...maverickSegments(p, i, amountIn));
    } else if (p.eulerSwap) {
      // EulerSwap (Euler vault-backed AMM, v1+v2) venue: sampled-segment enumeration via the shared
      // f/fInverse curve replay (capped at amountIn / the vault inLimit — the same bound prepare samples
      // → identical grid → exact-on-grid split).
      allSegs.push(...eulerSwapSegments(p, i, amountIn));
    } else if (p.balancer) {
      // Balancer V2 ComposableStable venue: sampled-segment enumeration via the shared StableMath replay
      // (capped at amountIn — the same bound prepare samples → identical grid → exact-on-grid split).
      allSegs.push(...balancerStableSegments(p, i, amountIn));
    } else if (p.wombat) {
      // Wombat (single-sided stableswap) venue: sampled-segment enumeration via the shared closed-form
      // coverage-ratio replay (capped at amountIn — the same bound prepare samples → identical grid →
      // exact-on-grid split).
      allSegs.push(...wombatSegments(p, i, amountIn));
    } else if (p.solidlyStable) {
      // Solidly STABLE (sAMM) venue: sampled-segment enumeration via the shared x3y+y3x replay (capped
      // at amountIn — the same bound prepare samples → identical grid → exact-on-grid split).
      allSegs.push(...solidlyStableSegments(p, i, amountIn));
    } else if (p.dodo) {
      // DODO V2 PMM venue: sampled-segment enumeration via the shared closed-form replay (capped at
      // amountIn — the same bound prepare samples → identical grid → exact-on-grid split).
      allSegs.push(...dodoSegments(p, i, amountIn));
    } else if (p.lb) {
      // LB venue: EXACT per-bin enumeration via the shared enumerator (capped at amountIn — the same
      // bound prepare uses → identical segment set → EXACT split, no grid error).
      allSegs.push(...lbSegments(p, i, amountIn));
    } else if (p.curve) {
      // Curve venue: sampled-segment enumeration via the shared bigint replay (capped at amountIn —
      // the same bound prepare samples → identical grid → exact-on-grid split).
      allSegs.push(...curveSegments(p, i, amountIn));
    } else if (p.isV2) {
      allSegs.push(...v2Segments(p, i));
    } else {
      allSegs.push(...v3Segments(p, i, zeroForOne, priceLimit));
    }
  }
  for (let i = 0; i < routes.length; i++) {
    allSegs.push(...routeSegments(routes[i], i));
  }

  // Global price-descending merge. A stable sort on adjNear DESC realises the optimal
  // water-fill: the best-priced segment across ALL venues is consumed first, ties broken by
  // farther (deeper) edge so a contiguous venue keeps its natural order.
  allSegs.sort((a, b) => {
    if (a.adjNear !== b.adjNear) return a.adjNear < b.adjNear ? 1 : -1;
    // tie on near price: prefer the segment with the higher far (shallower) so a venue's
    // own contiguous chain stays in order; cross-venue ties are price-equivalent anyway.
    if (a.adjFar !== b.adjFar) return a.adjFar < b.adjFar ? 1 : -1;
    // final tie: deterministic by venue then index (pools before routes).
    if (a.venue !== b.venue) return a.venue === "pool" ? -1 : 1;
    return a.idx - b.idx;
  });

  let cum = 0n;
  let cutAdjPrice = 0n;
  for (const seg of allSegs) {
    if (cum >= amountIn) break;
    let take = seg.gross;
    let crossed = false;
    if (cum + seg.gross >= amountIn) {
      take = amountIn - cum;
      crossed = true;
    }
    if (seg.venue === "pool") {
      perPoolInput[seg.idx] += take;
      // The marginal each engaged pool reaches: if the segment was fully consumed, the pool
      // has moved to (at least) the far edge; if it is the crossing segment, the cut sits
      // somewhere inside it — record adjFar as the conservative marginal (the pool's price
      // after fully draining the segment is adjFar; a partial fill lands between near & far).
      perPoolMarginalAdj[seg.idx] = seg.adjFar;
    } else {
      perRouteInput[seg.idx] += take;
    }
    cum += take;
    if (crossed) {
      cutAdjPrice = seg.adjFar;
      break;
    }
  }

  const totalInput =
    perPoolInput.reduce((a, b) => a + b, 0n) + perRouteInput.reduce((a, b) => a + b, 0n);
  return { perPoolInput, perRouteInput, totalInput, cutAdjPrice, perPoolMarginalAdj };
}
