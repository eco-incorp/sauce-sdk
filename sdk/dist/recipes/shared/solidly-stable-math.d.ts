/**
 * Solidly STABLE (sAMM) — VERBATIM bigint replay + off-chain segment sampler.
 *
 * THE SINGLE SOURCE for Solidly stable-pool math. Imported by BOTH:
 *   - the production `prepare.ts` (buildSolidlyStableSegments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (solidlyStableSegments),
 * so the split is exact-on-grid vs the oracle by construction (one replay), and the per-pool
 * executed output == getAmountOut(awarded share) to the wei (one atomic pool.swap).
 *
 * THE STABLE MATH IS OFF-CHAIN ONLY (for the SPLIT). The on-chain solver does NOT recompute the
 * x3y+y3x invariant or the bounded Newton — it samples the curve OFF-CHAIN into (capacity, effOut,
 * marginalOI) SEGMENTS via this exact replay, consumes them as STATIC segments through the existing
 * static-segment cursor (the same machinery the merge uses for route / Curve / LB / DODO segments),
 * and EXECUTES each stable pool CALLBACK-FREE: an on-chain `pool.getAmountOut(awardedShare, tokenIn)`
 * staticcall yields the EXACT amountOut (the pool view == the pool swap math), the awarded input is
 * transferred to the pool, and `pool.swap(amount0Out, amount1Out, to, "")` lands the swap. No engine
 * SwapPoolType is needed (stable pools are NOT xy=k, so the V2/UniV2 _swapV2 path mis-prices them).
 *
 * SOURCE MIRRORED — the canonical Velodrome / Aerodrome / Thena / Ramses `Pair.sol` STABLE branch
 * (the `stable == true` sAMM). Reproduced bit-for-bit:
 *   - reserves normalised to 1e18 via token decimals: x = reserve0·1e18/dec0, y = reserve1·1e18/dec1
 *     (dec = 10**decimals).
 *   - the invariant k(x,y) = (x·y/1e18)·(x·x/1e18 + y·y/1e18)/1e18   (= x3y + y3x scaled).
 *   - getAmountOut: amountIn -= amountIn·feePpm/1e6 (the pool/factory fee), then normalise the
 *     net amountIn and the reserves, compute xy = k(x0n,y0n) with (reserveA,reserveB) oriented by
 *     tokenIn, set y = reserveB − get_y(amountInN + reserveA, xy, reserveB), and DENORMALISE y back
 *     to tokenOut decimals.
 *   - get_y(x0, xy, y): BOUNDED Newton (≤255 iterations, exactly the pool loop bound) with ±1
 *     convergence (the first f term divides the (y·y/1e18·y)/1e18 cube BEFORE the x0 multiply, then
 *     /1e18 — the exact `Pair.sol` / fixture `SolidlyStablePool.sol` grouping):
 *       f(x0,y) = x0·((y·y/1e18·y)/1e18)/1e18 + (x0·x0/1e18·x0/1e18)·y/1e18
 *       d(x0,y) = 3·x0·(y·y/1e18)/1e18 + (x0·x0/1e18·x0/1e18)
 *       if f < xy: y += (xy − f)·1e18/d   else: y −= (f − xy)·1e18/d ; break when |dy| <= 1.
 *
 * The replay is BOUNDED (255-iteration Newton, exactly the pool's loop bound) — no unbounded loops.
 * It runs purely on the read pool state (reserves / decimals / fee); buildSolidlyStableSegments makes
 * NO extra RPC.
 *
 * WEI-EXACT BOUND. The SPLIT (per-pool awarded input) is EXACT-ON-GRID vs the oracle (both replay the
 * SAME buildSolidlyStableSegments grid — one source — so the awarded share matches the oracle
 * bit-for-bit). The realized dy is EXACT-IN-DY: the per-pool out for the awarded slice is
 * re-evaluated wei-exact by ONE atomic pool.getAmountOut(Σ share) at execution, because the pool's
 * `getAmountOut` view IS the math its `swap` enforces. So awarded-input == oracle (exact-on-grid) and
 * received-dy == getAmountOut(awarded) (exact-in-dy) — the same standard as Curve/DODO.
 *
 * Sources:
 *   https://github.com/velodrome-finance/contracts/blob/main/contracts/Pool.sol  (_k / _get_y / getAmountOut)
 *   https://github.com/aerodrome-finance/contracts (sAMM Pool.sol — identical math)
 */
import { type MergeSegment } from "./segment-merge.js";
/** 2^192 — the unified out/in sqrt fixed-point scale (matches curve-math / dodo-math / ecoswap.math Q192). */
export declare const Q192: bigint;
/** Solidly DecimalMath ONE — 1e18 fixed point (the reserve-normalisation unit). */
export declare const SOLIDLY_ONE: bigint;
/** ppm fee denominator (the pool/factory fee is in ppm — e.g. 100 = 0.01%, the canonical sAMM tier). */
export declare const FEE_DENOM_PPM = 1000000n;
/** Integer square root (Babylonian) — bit-identical to curve-math / dodo-math / ecoswap.math `isqrt`. */
export declare function isqrt(x: bigint): bigint;
/**
 * One discovered Solidly STABLE pool, oriented for a tokenIn → tokenOut swap.
 *
 * The on-chain execution is CALLBACK-FREE (getAmountOut staticcall + transfer + pool.swap), so the
 * fields here are OFF-CHAIN ONLY — they feed buildSolidlyStableSegments (the price/capacity replay).
 * `reserveIn`/`reserveOut` are the RAW (native-decimals) reserves oriented by tokenIn; `decIn`/`decOut`
 * are 10**decimals for the respective token (the normalisation factors). `token0` + `inIsToken0` orient
 * the pool's swap output slot at execution. `feePpm` is the pool/factory stable swap fee (ppm).
 */
export interface SolidlyStablePool {
    /** Pool address — the getAmountOut/swap target. */
    address: `0x${string}`;
    /** RAW tokenIn-side reserve (native decimals). */
    reserveIn: bigint;
    /** RAW tokenOut-side reserve (native decimals). */
    reserveOut: bigint;
    /** 10**decimals of tokenIn (the normalisation factor for the IN reserve). */
    decIn: bigint;
    /** 10**decimals of tokenOut. */
    decOut: bigint;
    /** The pool's token0 (lower-sorted token) — orients the swap output slot. */
    token0: `0x${string}`;
    /** true => tokenIn is token0 (output is amount1Out); false => tokenIn is token1 (output is amount0Out). */
    inIsToken0: boolean;
    /** Stable swap fee in ppm (e.g. 100 = 0.01%). */
    feePpm: number;
    /** Discovery source label. */
    source: string;
}
/**
 * getAmountOut(amountIn, tokenIn) — the exact tokens-out for `dx` tokenIn, INCLUDING the swap fee.
 * Mirrors the canonical Velodrome/Aerodrome sAMM `getAmountOut` bit-for-bit:
 *   amountIn -= amountIn·feePpm/1e6                                # net fee off the input
 *   xy = k(x0n, y0n)                                               # the invariant on NORMALISED reserves
 *   (reserveA, reserveB) oriented by tokenIn (in-side, out-side)   # both normalised to 1e18
 *   amountInN = amountIn·1e18/decIn                                # net input normalised
 *   y = reserveB − get_y(amountInN + reserveA, xy, reserveB)       # new out-reserve drop, normalised
 *   return y·decOut/1e18                                           # denormalised to tokenOut decimals
 *
 * REVERT-DOMAIN NOTE. This bigint replay is unbounded-precision, so it NEVER overflows — it returns 0 only
 * on a non-positive input, degenerate reserves, or SATURATION (yNew >= y0n ⇒ the out-reserve fully drained).
 * The on-chain getAmountOut (checked Solidity ≥0.8) can instead REVERT on uint256 overflow at an EXTREME
 * input, and the solver's PROBE-THEN-DECODE Solidly branch treats that revert as a stop (ok=0 ⇒ q=0). The
 * two agree wei-exact across the model's domain — which spans every realistic trade — because saturation
 * fires at an input on the RESERVE scale, orders of magnitude BELOW the input that would overflow the
 * x3y+y3x arithmetic: the off-chain ladder always stops (return 0) before reaching the on-chain revert
 * boundary, and the whole-trade amountOutMin floor bounds any residual. The exact overflow input is
 * fork-implementation-specific (a Solidly fork's _get_y grouping decides which product overflows first), so
 * it is deliberately NOT modeled here — a single off-chain overflow model could not match every fork
 * bit-for-bit and would risk breaking the solver==oracle lockstep it aimed to protect.
 */
export declare function getAmountOutStable(pool: SolidlyStablePool, dx: bigint): bigint;
/**
 * One sampled Solidly-stable segment in unified out/in price space — identical shape to a Curve / LB
 * / DODO / route segment (a flat [capacity, marginalOI] slice). `capacity` is the Δinput (tokenIn) for
 * this slice, `effOut` the Δoutput, and `marginalOI` the unified out/in sqrt = isqrt(effOut·2^192/capacity)
 * — the price-ordering coordinate. Segments are emitted in DESCENDING `marginalOI` order (the natural
 * order of a convex stable curve: the first marginal slice is the best-priced).
 *
 * fee-adjust: marginalOI is computed from the POST-FEE dy (getAmountOutStable already nets the fee), so
 * it is ALREADY the fee-adjusted execution price — it enters the merge's descending-price sort directly
 * (no extra sqrtOneMinusFee multiply, the fee is baked into dy), exactly like Curve / LB / DODO segments.
 */
export interface SolidlyStableSegment extends MergeSegment {
    /** Δinput (tokenIn) to traverse this slice. */
    capacity: bigint;
    /** Δoutput (tokenOut) over this slice. */
    effOut: bigint;
    /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
    marginalOI: bigint;
}
/** Default sample count per stable pool (M). Tunable; M≈24 tightens the grid bound. */
export declare const SOLIDLY_STABLE_SAMPLES: number;
/**
 * Sample a Solidly STABLE pool into M descending-marginal segments over [0, amountIn].
 *
 * Geometric-ish cumulative inputs (∝ s^2 — denser near 0 where the stable curve is flattest then
 * bends), each replayed through getAmountOutStable on the READ state (NO extra RPC — pure bigint,
 * bounded Newton). Each increment becomes a (capacity=Δin, effOut=Δout, marginalOI) segment. The
 * samples are monotone in input so the marginals are naturally descending (a convex out(in)); a
 * non-descending slice (rounding noise near saturation, or a non-convex region past the pool's
 * effective depth) is FOLDED into the last segment (isotonic backward-merge — capacity + effOut
 * conserved, blended marginal recomputed) so the merge stays monotone price-ordered without discarding
 * liquidity. See shared/segment-merge.ts.
 *
 * Exact-on-grid: the split equalizes marginals on THIS sampled grid; the per-pool out for the awarded
 * Σ share is re-evaluated wei-exact by one atomic on-chain getAmountOut(Σ share) at execution. M≈24
 * (default) keeps the grid bound `O(curvature·maxSlice)` negligible near peg. Mirrors
 * `buildCurveSegments` / `buildDodoSegments` (same squared-index geometric grid + isotonic
 * backward-merge).
 */
/**
 * Build one Solidly STABLE pool's QUOTE-LADDER — the SHARED curve-agnostic `buildQLLadder` recurrence
 * (curve-math.ts) driven by the bigint `getAmountOutStable`, so the oracle stays wei-exact with the
 * on-chain solver by construction (the solver builds the IDENTICAL geometric ladder live from the pool's
 * own getAmountOut; getAmountOutStable == that view to the wei). The ladder recurrence is IDENTICAL to
 * Curve's — ONLY the underlying getDy model differs (x3y+y3x bounded-Newton vs StableSwap). getAmountOut
 * is post-fee (it nets the pool fee) so marginalOI IS the execution price. Emits the same {capacity,
 * effOut, marginalOI} slices the static-segment cursor consumes.
 */
export declare function buildSolidlyStableQLLadder(pool: SolidlyStablePool, amountIn: bigint): SolidlyStableSegment[];
export declare function buildSolidlyStableSegments(pool: SolidlyStablePool, amountIn: bigint, samples?: number): SolidlyStableSegment[];
//# sourceMappingURL=solidly-stable-math.d.ts.map