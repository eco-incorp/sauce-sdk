/**
 * Maverick V2 (bin-based directional AMM) — VERBATIM bigint replay + off-chain segment sampler.
 *
 * THE SINGLE SOURCE for Maverick V2 swap math. Imported by BOTH:
 *   - the production `prepare.ts` (buildMaverickSegments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (maverickSegments),
 * so the split is exact-on-grid vs the oracle by construction (one replay), and the per-pool
 * executed dy == the on-chain quoter calculateSwap(awarded share) to the wei (one atomic engine
 * swap → _swapMaverickV2, verified in the EVM test).
 *
 * THE BIN MATH IS OFF-CHAIN ONLY (for the SPLIT). Maverick's bins do NOT map to the drift-invariant
 * liquidityNet tick walk (bin liquidity is re-derived per tick from (reserveA,reserveB) and the
 * pool has dynamic-distribution kinds), so Maverick is a SAMPLED-SEGMENT source (like DODO/Curve):
 * prepare samples the curve into monotone descending-marginal segments for the split, and execution
 * goes through the ENGINE (SwapPoolType.MaverickV2 = 7 → _swapMaverickV2 → pool.swap +
 * maverickV2SwapCallback). Maverick is a CALLBACK pool (the pool re-enters maverickV2SwapCallback
 * mid-swap to pull input), so it MUST execute through the engine Router — it can NOT be executed
 * callback-free the way Solidly/Wombat/Euler are. The on-chain solver never recomputes the bin math;
 * it consumes the STATIC segments through the existing static-segment cursor and dispatches on
 * segKind 8.
 *
 * SOURCE MIRRORED — the canonical Maverick V2 on-chain math, bit-for-bit from the REAL deployed
 * Solidity (NOT the yldfi/ParaSwap port, which diverged on the tick-cross drain input): `TickMath` +
 * `Math` from maverickprotocol/v2-common, and `SwapMath` (computeSwapExactIn +
 * `_remainingBinInputSpaceGivenOutput`) from the audited MaverickV2 PoolLib. The drain input is the
 * RESERVE-EXTRACTION input (_remainingBinInputSpaceGivenOutput), NOT the price-edge input the port used:
 * getTickL is a documented lower bound (the *1e9 sits OUTSIDE the sqrt), so L·(edge − price) != the
 * tick's stored reserve, and only the reserve-extraction form is wei-exact vs the on-chain
 * MaverickV2Quoter.calculateSwap on every crossed tick (verified across sizes AND both directions on the
 * real BSC USDT/USDC pool at two blocks — see the validation note below). The integer routines
 * reproduced here:
 *   - `tickSqrtPrice(tickSpacing, tick)`  — the 1.0001^(tick·tickSpacing) sqrt-price ladder (the
 *     Uniswap-style 128.128 pow shifted to 1e18 fixed point).
 *   - `getTickL(reserveA, reserveB, sqrtLower, sqrtUpper)` — the per-tick liquidity L from the tick's
 *     (reserveA, reserveB) and its sqrt-price bounds (the concentrated-liquidity quadratic).
 *   - `computeSwapExactIn(sqrtPrice, tickData, amountIn, tokenAIn, fee, protocolFeeD3, sqrtLower,
 *     sqrtUpper)` — the WITHIN-TICK swap (drain-or-partial, directional fee, protocol-fee net, end
 *     price + output). tokenA-in: endSqrtP = in/L + sqrtP ; tokenB-in: endSqrtP = L/(in + L/sqrtP).
 *   - `simulateSwapExactIn` — the multi-tick walk (walk one tick at a time in the swap direction,
 *     draining each tick's available output until amountIn is consumed or the tick limit hit).
 * All fixed point is 1e18 (`ONE`); the fee is 1e18-scaled DIRECTIONAL (feeAIn charged on tokenA-in,
 * feeBIn on tokenB-in); protocolFeeD3 is a 3-decimal (per-mille) protocol fee proportion.
 *
 * The replay runs purely on the read pool state (activeTick / poolSqrtPrice / protocolFeeRatioD3 +
 * the per-tick (reserveA,reserveB) around the active tick + the two directional fees + tickSpacing);
 * buildMaverickSegments makes NO extra RPC. The tick walk is BOUNDED (a fixed tick-search limit),
 * so there is no unbounded loop.
 *
 * WEI-EXACT BOUND. The SPLIT (per-pool awarded input) is EXACT-ON-GRID vs the oracle (both replay the
 * SAME buildMaverickSegments grid — one source — so the awarded share matches the oracle bit-for-bit).
 * The realized dy is EXACT: the per-pool out for the awarded slice is the ENGINE swap, which the EVM
 * test asserts == the on-chain MaverickV2Quoter.calculateSwap(awarded) to the wei (the same
 * on-chain-view-is-the-swap-math standard as DODO's querySell* / Solidly's getAmountOut). The sampler
 * drives only the SPLIT; the realized dy is the engine swap.
 *
 * DECIMALS: this math operates in Maverick's internal 1e18-normalized (D18) units — sqrtPrice, L and the
 * tick reserves are all D18. For an 18/18-decimal pool (the wei-exact-validated BSC USDT/USDC target) the
 * raw token amounts ARE D18, so no scaling is needed. A MIXED-decimal pool (e.g. a 6-decimal token) must
 * have its reserves AND the swap amount scaled to D18 (×10^(18−decimals)) before entering this math and
 * the output scaled back — that normalization is the discovery/caller's responsibility (as it is for
 * Curve/Balancer/Wombat), NOT this library's; discoverMaverickV2PoolsTyped currently feeds RAW reserves,
 * which is correct only for 18/18 pools (see the recipe TODO).
 *
 * Sources:
 *   https://docs.mav.xyz/technical-reference/maverick-v2/v2-contracts/maverick-v2-amm-contracts/poollib/swapmath
 *   https://github.com/maverickprotocol/v2-common/blob/main/contracts/libraries/TickMath.sol
 *   https://github.com/maverickprotocol/v2-common/blob/main/contracts/libraries/Math.sol
 *   MaverickV2 PoolLib.SwapMath (audited; Omniscia maverick-protocol-amm-implementation, SwapMath-SMH)
 */
import { type MergeSegment } from "./segment-merge.js";
/** 2^192 — the unified out/in sqrt fixed-point scale (matches ecoswap.math / dodo-math / curve-math Q192). */
export declare const Q192: bigint;
/** Maverick fixed-point ONE — 1e18. */
export declare const MAV_ONE = 1000000000000000000n;
/** Integer square root (Babylonian) — bit-identical to dodo-math / curve-math / ecoswap.math `isqrt`. */
export declare function isqrt(x: bigint): bigint;
/**
 * tickSqrtPrice(tickSpacing, tick) — the sqrt price at the LOWER edge of `tick` (1e18 fixed point),
 * mirroring Maverick TickMath.tickSqrtPrice: the Uniswap 128.128 pow of 1.0001^(|tick|·tickSpacing),
 * inverted for a positive tick, scaled to 1e18. `1.0001^tickSpacing` is the bin width.
 */
export declare function tickSqrtPrice(tickSpacing: number, tick: number): bigint;
/** The sqrt-price bounds [lower, upper] of `tick` (its lower edge and the next tick's lower edge). */
export declare function tickSqrtPrices(tickSpacing: number, tick: number): {
    sqrtLowerPrice: bigint;
    sqrtUpperPrice: bigint;
};
/**
 * getTickL(reserveA, reserveB, sqrtLower, sqrtUpper) — the tick's concentrated-liquidity L from its
 * (reserveA, reserveB) and its sqrt-price bounds, mirroring Maverick TickMath.getTickL bit-for-bit
 * (the precision-bump + quadratic root). L is the coefficient in the within-tick swap formulas.
 */
export declare function getTickL(reserveA: bigint, reserveB: bigint, sqrtLowerTickPrice: bigint, sqrtUpperTickPrice: bigint): bigint;
/**
 * getSqrtPrice(reserveA, reserveB, sqrtLower, sqrtUpper, L) — the current sqrt price WITHIN a tick
 * from its reserves and L, mirroring Maverick TickMath.getSqrtPrice. Used to seed the walk's starting
 * price from the active tick's reserves (clamped to the tick bounds).
 */
export declare function getSqrtPrice(reserveA: bigint, reserveB: bigint, sqrtLowerTickPrice: bigint, sqrtUpperTickPrice: bigint, liquidity: bigint): bigint;
interface TickDataInput {
    currentReserveA: bigint;
    currentReserveB: bigint;
    currentLiquidity: bigint;
}
interface SwapTickResult {
    deltaInErc: bigint;
    deltaOutErc: bigint;
    excess: bigint;
    endSqrtPrice: bigint;
    swappedToMaxPrice: boolean;
}
/**
 * computeSwapExactIn — the WITHIN-TICK swap for `amountIn` tokenIn, mirroring Maverick
 * SwapMath.computeSwapExactIn + computeEndPrice bit-for-bit. Returns the erc-scale input consumed
 * (deltaInErc, INCLUDING the fee), the output paid (deltaOutErc), the un-consumed excess (drives the
 * tick walk), the end sqrt price, and whether the tick fully drained (swappedToMaxPrice).
 *   tokenA-in : endSqrtP = sqrtP + in/L                   (price rises)
 *   tokenB-in : endSqrtP = 1/(in/L + 1/sqrtP) = L/(in + L/sqrtP)   (price falls)
 * `fee` is the DIRECTIONAL 1e18-scaled swap fee (feeAIn for tokenA-in, feeBIn for tokenB-in).
 */
export declare function computeSwapExactIn(sqrtPrice: bigint, tickData: TickDataInput, amountIn: bigint, tokenAIn: boolean, fee: bigint, protocolFeeD3: bigint, sqrtLowerTickPrice: bigint, sqrtUpperTickPrice: bigint): SwapTickResult;
/** One tick's live reserves (reserveA, reserveB) for the swap walk (from pool.getTick(tick)). */
export interface MaverickTick {
    tick: number;
    reserveA: bigint;
    reserveB: bigint;
}
/**
 * One discovered Maverick V2 pool, oriented for a tokenIn → tokenOut swap.
 *
 * The engine `_swapMaverickV2` resolves the swap direction ON-CHAIN (it reads the pool's `tokenA()`
 * and sets `tokenAIn = (tokenIn == tokenA)`), and calls `pool.swap(recipient, SwapParams{amount,
 * tokenAIn, exactOutput:false, tickLimit: per-direction full-range}, "")` (see the ENGINE tickLimit
 * note below — ../sauce PR #193). So the on-chain SwapParams carry ONLY {pool,
 * tokenIn, tokenOut, amountSpecified, payer, recipient}. The fields here are OFF-CHAIN ONLY — they
 * feed buildMaverickSegments (the price/capacity replay). `tokenAIn` tags the direction (tokenIn ==
 * tokenA ⇒ tokenA is the input ⇒ price rises through ticks; else tokenB-in ⇒ price falls). `fee` is
 * the DIRECTIONAL fee for THIS direction (feeAIn if tokenAIn, else feeBIn). `ticks` are the live
 * per-tick reserves around the active tick, in ASCENDING tick order.
 *
 * ENGINE tickLimit. The FIXED engine (../sauce PR #193) passes a per-direction FULL-RANGE tickLimit —
 * `type(int32).max` for a tokenA-in (price-rising) swap, `type(int32).min` for a tokenB-in (price-falling)
 * swap — i.e. Maverick's "no limit" sentinel. The swap fills across the WHOLE live tick book, bounded only
 * by available liquidity, for ANY active-tick side (the fill may cross tick 0 freely). buildMaverickSegments
 * applies the SAME full-range per-direction bound in its walk (`engineTickLimit(tokenAIn)`), so the sampler
 * and the engine agree bit-for-bit — and discovery surfaces every liquid pool regardless of active-tick side
 * (the OLD `tickLimit: 0` cap + its discovery gate are gone).
 */
export interface MaverickPool {
    /** Always SwapPoolType.MaverickV2 (=7) — execution dispatches via swap(SwapParams{poolType:7}). */
    poolType: number;
    /** Pool address — the swap(SwapParams{poolType:7, pool}) target. */
    address: `0x${string}`;
    /** true => tokenIn == the pool's tokenA (tokenA is the input; price rises). Engine resolves on-chain. */
    tokenAIn: boolean;
    /** Live active tick (State.activeTick). Seeds the walk's starting tick. */
    activeTick: number;
    /** Live pool sqrt price (1e18) — the walk's starting price within the active tick. */
    poolSqrtPrice: bigint;
    /** Bin width exponent: 1.0001^tickSpacing is the bin width (pool.tickSpacing()). */
    tickSpacing: number;
    /** DIRECTIONAL swap fee for THIS direction (1e18-scaled; feeAIn if tokenAIn, else feeBIn). */
    fee: bigint;
    /** Protocol fee proportion (3-decimal / per-mille; State.protocolFeeRatioD3). */
    protocolFeeD3: bigint;
    /** Live per-tick reserves around the active tick, ASCENDING tick order (from getTick). */
    ticks: MaverickTick[];
    /** Rounded ppm fee (the price-ordering coordinate / diagnostic). */
    feePpm: number;
    /** Discovery source label. */
    source: string;
}
/**
 * The engine's per-direction FULL-RANGE swap tick limit. The FIXED `_swapMaverickV2` (../sauce PR #193)
 * passes `tickLimit: tokenAIn ? type(int32).max : type(int32).min`, i.e. no artificial cap — a tokenA-in
 * swap walks UP unbounded (up to int32.max) and a tokenB-in swap walks DOWN unbounded (down to int32.min),
 * bounded only by available liquidity / MAX_TICK. The sampler applies the SAME per-direction bound so its
 * output matches the engine even when the fill crosses tick 0.
 *
 * (Historical: the OLD engine hardcoded `tickLimit: 0`, capping every swap at tick 0 and dropping pools on
 * the far side of 0. Both vestiges — the discovery gate and this cap — were removed once the engine went
 * full-range.)
 */
export declare const MAVERICK_ENGINE_TICK_LIMIT_MAX = 2147483647;
export declare const MAVERICK_ENGINE_TICK_LIMIT_MIN = -2147483648;
/** The engine tickLimit for a given swap direction (full range). tokenA-in walks UP → max; tokenB-in DOWN → min. */
export declare function engineTickLimit(tokenAIn: boolean): number;
/**
 * Max ladder slices the LIVE bin-WALK emits per pool — the shared budget the ORACLE
 * (buildMaverickWalkLadder) and the on-chain solver's segKind-8 QL walk BOTH cap at, so the two build
 * the IDENTICAL slice set (solver == oracle by construction). It EQUALS the on-chain QL slice budget
 * `QL_S` in ecoswap.sauce.ts (both 8): the merged-stream capacity `MS_CAP = segs + qlv·QL_S` reserves
 * exactly QL_S rows per QL venue, so a Maverick venue emitting ≤ this many slices never overflows it.
 * A trade whose reachable depth spans more than this many crossed ticks fills only the first
 * MAVERICK_WALK_MAX_SEGMENTS ticks in the priced split (the rest is left for other venues / the guarded
 * terminal refund) — safe (the exec never over-asks) and consistent between the two sides.
 */
export declare const MAVERICK_WALK_MAX_SEGMENTS = 8;
/**
 * Walk the pool's live ticks in the swap direction, replaying `computeSwapExactIn` per tick, and
 * return the exact tokens-out for `amountIn` tokenIn AND the tokenIn actually consumed (which may be
 * LESS than `amountIn` when the tick limit / available liquidity binds). Mirrors Maverick
 * `Pool.swap`'s tick loop (via the yldfi `simulateSwapExactIn` reference) with the ENGINE's per-direction
 * FULL-RANGE tickLimit (type(int32).max/min — ../sauce PR #193).
 *
 * Direction: tokenA-in walks tick UP (+1 per step), price rises; tokenB-in walks tick DOWN (-1),
 * price falls. The default `tickLimit` is the engine's full-range bound FOR THIS DIRECTION
 * (`engineTickLimit(tokenAIn)`), so the walk is bounded only by liquidity / MAX_TICK — matching how the
 * full-range engine swap terminates, INCLUDING when the fill crosses tick 0. So `getDy` returns exactly
 * what the engine swap consumes/pays.
 */
export declare function simulateMaverickExactIn(pool: MaverickPool, amountIn: bigint, tickLimit?: number): {
    amountIn: bigint;
    amountOut: bigint;
};
/**
 * buildMaverickWalkLadder(pool, amountIn) — the LIVE bin-WALK ladder: walk the tick book from the live
 * active tick/price, emitting ONE segment per crossed tick (capacity = deltaInErc, effOut = deltaOutErc,
 * marginalOI = the QL slice head isqrt(effOut·2^192/capacity)), until the input is consumed, a slice
 * prices non-descending, or a tick runs dry.
 *
 * STATUS — WIRED (the segKind-8 LIVE-walk). This ladder is the TS source-of-truth for Maverick's on-chain
 * live-walk: the neutral oracle (ecoswap.optimal.ts maverickSegments) consumes THIS ladder, and the
 * on-chain solver's segKind-8 QL branch (ecoswap.sauce.ts) replays THIS EXACT per-tick loop from LIVE
 * getState()/getTick() state — ONE source ⇒ solver == oracle by construction (its standalone twin
 * test/harness/maverick-onchain-walk.reference.ts.txt is proven wei-exact, Δ=0, vs the real
 * MaverickV2Quoter on both v1 and v12). prepare ships Maverick descriptor-only (pool + direction +
 * tickSpacing); index.ts buildQLVenues emits the segKind-8 QL row; the walk reads fee + activeTick +
 * per-tick reserves LIVE. Unlike the geometric sampler (`buildMaverickSegments`, retained for the
 * math-test known-answer vectors) this walks the REAL bin boundaries, so each segment is a genuine tick
 * crossing (the active tick's partial slice from the live price to its edge, then full-drain slices). The
 * emit is capped at MAVERICK_WALK_MAX_SEGMENTS to match the on-chain merged-stream reservation.
 *
 * The stop semantics MATCH the shared QL ladder (`buildQLLadder`) and the on-chain QL emit guard: stop on
 * a zero slice, a non-descending head (a Maverick bin book walked in the swap direction is naturally
 * descending — price worsens monotonically per tick — so this only trips on the terminal edge), and cap
 * cumulative input at amountIn. No isotonic backward-merge (that is the geometric sampler's device for
 * bin-straddling samples; a per-tick walk emits at monotone-worsening price directly).
 */
export declare function buildMaverickWalkLadder(pool: MaverickPool, amountIn: bigint, maxSegments?: number): MaverickSegment[];
/**
 * getDy(pool, amountIn) — the EXACT tokens-out the Maverick pool pays for `amountIn` tokenIn, walking
 * the live tick book with the engine's per-direction full-range tickLimit. This is the sampler's per-slice
 * output AND the value the EVM test cross-checks against the on-chain MaverickV2Quoter.calculateSwap(amountIn).
 * The realized dy from the engine swap equals this (the quoter IS the swap math).
 */
export declare function getDy(pool: MaverickPool, amountIn: bigint): bigint;
/**
 * maxInput(pool) — the largest tokenIn the pool can absorb under the engine's full-range tickLimit (the
 * point at which the walk stops consuming — now bounded only by liquidity / MAX_TICK, not tick 0). prepare
 * caps the sampled range at this so no segment promises depth the engine swap cannot fill (a tokenIn slice
 * beyond it would be left unspent + terminal-refunded).
 */
export declare function maxInput(pool: MaverickPool, probe: bigint): bigint;
/**
 * One sampled Maverick segment in unified out/in price space — identical shape to a Curve / DODO /
 * route segment (a flat [capacity, marginalOI] slice). `capacity` is the Δinput (tokenIn) for this
 * slice, `effOut` the Δoutput, `marginalOI` the unified out/in sqrt = isqrt(effOut·2^192/capacity)
 * — the price-ordering coordinate. Segments are emitted in DESCENDING `marginalOI` order (the natural
 * order of a convex curve: the first marginal slice is the best-priced). marginalOI is computed from
 * the POST-FEE dy (getDy nets the directional fee), so it is ALREADY the fee-adjusted execution price
 * — it enters the merge's descending sort directly, exactly like Curve / DODO segments.
 */
export interface MaverickSegment extends MergeSegment {
    /** Δinput (tokenIn) to traverse this slice. */
    capacity: bigint;
    /** Δoutput (tokenOut) over this slice. */
    effOut: bigint;
    /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
    marginalOI: bigint;
}
/** Default sample count per Maverick pool (M). Tunable; M≈24 tightens the grid bound. */
export declare const MAVERICK_SAMPLES: number;
/**
 * Sample a Maverick V2 pool into M descending-marginal segments over [0, min(amountIn, maxInput)].
 *
 * BOUND BY THE TICK-LIMIT DEPTH: the sampled range is capped at the pool's `maxInput` (the tokenIn the
 * engine swap can consume before it runs out of liquidity — the full-range tickLimit no longer stops it
 * at tick 0) so no segment promises depth the engine cannot fill. Geometric-ish cumulative inputs
 * (∝ s^2 — denser near 0 where the curve is steepest), each
 * replayed through getDy on the READ tick book (NO extra RPC — pure bigint). Each increment becomes a
 * (capacity=Δin, effOut=Δout, marginalOI) segment. The bin book is NOT globally convex, so a slice
 * that crosses into a deeper bin can price BETTER than the last band (a non-descending marginal); such
 * a slice is FOLDED into the last segment (isotonic backward-merge — capacity + effOut conserved,
 * blended marginal recomputed) so the merge stays monotone price-ordered without discarding the
 * past-cliff bin liquidity. See shared/segment-merge.ts.
 *
 * Exact-on-grid: the split equalizes marginals on THIS sampled grid; the per-pool dy for the awarded Σ
 * share is realized wei-exact by ONE atomic engine swap (_swapMaverickV2) at execution, cross-checked
 * against the on-chain quoter. Mirrors `buildDodoSegments` / `buildCurveSegments` (same squared-index
 * geometric grid + isotonic backward-merge).
 */
export declare function buildMaverickSegments(pool: MaverickPool, amountIn: bigint, samples?: number): MaverickSegment[];
/** Round a Maverick directional fee (1e18-scaled, e.g. 1e15 = 0.1%) to a ppm fee (price-ordering coord). */
export declare function maverickFeeToPpm(feeWad: bigint): number;
export {};
//# sourceMappingURL=maverick-math.d.ts.map