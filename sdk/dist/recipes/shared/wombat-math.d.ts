/**
 * Wombat Exchange (single-sided stableswap) — VERBATIM bigint replay + off-chain segment sampler.
 *
 * THE SINGLE SOURCE for Wombat swap math. Imported by BOTH:
 *   - the production `prepare.ts` (buildWombatSegments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (wombatSegments),
 * so the split is exact-on-grid vs the oracle by construction (one replay), and the per-pool
 * executed output == quotePotentialSwap(awarded share) to the wei (one atomic pool.swap).
 *
 * THE WOMBAT MATH IS OFF-CHAIN ONLY (for the SPLIT). The on-chain solver does NOT recompute the
 * coverage-ratio quote or the closed-form quadratic — it samples the curve OFF-CHAIN into
 * (capacity, effOut, marginalOI) SEGMENTS via this exact replay, consumes them as STATIC segments
 * through the existing static-segment cursor (the same machinery the merge uses for route / Curve /
 * LB / DODO / Solidly-stable segments), and EXECUTES each Wombat pool CALLBACK-FREE: an on-chain
 * `pool.quotePotentialSwap(fromToken, toToken, awardedShare)` staticcall yields the EXACT
 * potentialOutcome (the pool view == the pool swap math), the pool is approved for the awarded
 * input (Wombat PULLS via transferFrom), and `pool.swap(fromToken, toToken, awarded, minToAmount,
 * to, deadline)` lands the swap. No engine SwapPoolType is needed (Wombat is single-sided
 * stableswap, NOT xy=k, so the V2/UniV2 _swapV2 path mis-prices it). NOTE: quotePotentialSwap
 * itself REVERTS when the pool or either asset is PAUSED (Wombat pauses per-asset) — a pause
 * landing between prepare and cook therefore aborts the WHOLE cook; there is NO graceful
 * per-venue skip.
 *
 * SOURCE MIRRORED — the canonical wombat-exchange/v1-core `CoreV2.sol` + `Pool.sol`. Reproduced
 * bit-for-bit (all internal math is WAD = 1e18 signed fixed point; cash/liability are stored in WAD
 * regardless of token decimals; fromAmount is native→WAD via toWad, the quote out is WAD→native via
 * fromWad):
 *   CoreV2._swapQuoteFunc(Ax, Ay, Lx, Ly, Dx, A):           # Ax/Ay = from/to cash, Lx/Ly = from/to liability
 *     D   = Ax + Ay - A·wmul((Lx·Lx)/Ax + (Ly·Ly)/Ay)       # the invariant (a constant of the pre-state)
 *     rx_ = (Ax + Dx)·wdiv(Lx)                               # post coverage ratio of the from-asset
 *     b   = (Lx·(rx_ - A·wdiv(rx_)))/Ly - D·wdiv(Ly)         # the quadratic coefficient
 *     ry_ = _solveQuad(b, A)                                 # closed-form: (sqrt(b·b + 4·A·WAD) - b)/2
 *     Dy  = Ly·wmul(ry_) - Ay                                # ideal to-amount (WAD; negative ⇒ |Dy|)
 *   Pool._quoteFrom / quotePotentialSwap:
 *     haircut       = idealToAmount·wmul(haircutRate)        # the LP fee, taken off the OUTPUT
 *     actualToAmount = idealToAmount - haircut
 *   wmul(a,b) = round((a·b)/WAD) ; wdiv(a,b) = round((a·WAD)/b) — canonical SignedSafeMath ADDS the
 *   half-term (WAD/2, y/2) before the truncate-toward-zero divide ; _solveQuad uses an integer sqrt.
 *
 * The replay is CLOSED-FORM (one isqrt + a handful of mulDiv) — NO Newton, NO unbounded loop. It
 * runs purely on the read pool state (fromCash, toCash, fromLiability, toLiability, ampFactor,
 * haircutRate, decimals); buildWombatSegments makes NO extra RPC.
 *
 * WEI-EXACT BOUND. The SPLIT (per-pool awarded input) is EXACT-ON-GRID vs the oracle (both replay
 * the SAME buildWombatSegments grid — one source — so the awarded share matches the oracle
 * bit-for-bit). The realized dy is EXACT-IN-DY: the per-pool out for the awarded slice is
 * re-evaluated wei-exact by ONE atomic pool.quotePotentialSwap(Σ share) at execution, because the
 * pool's `quotePotentialSwap` view IS the math its `swap` enforces (Pool.swap calls the same
 * _quoteFrom). So awarded-input == oracle (exact-on-grid) and received-dy ==
 * quotePotentialSwap(awarded) (exact-in-dy) — the same standard as Curve / DODO / Solidly-stable.
 * Marginal equalization across pools is a DIAGNOSTIC (a grid bound), not the wei gate.
 *
 * Sources:
 *   https://github.com/wombat-exchange/v1-core/blob/master/contracts/wombat-core/pool/CoreV2.sol  (_swapQuoteFunc / _solveQuad)
 *   https://github.com/wombat-exchange/v1-core/blob/master/contracts/wombat-core/pool/Pool.sol      (quotePotentialSwap / _quoteFrom / swap / haircutRate / ampFactor)
 */
import { type MergeSegment } from "./segment-merge.js";
/** 2^192 — the unified out/in sqrt fixed-point scale (matches the other *-math modules' Q192). */
export declare const Q192: bigint;
/** Wombat WAD — 1e18 signed fixed point (cash/liability/amp/haircut are all WAD). */
export declare const WAD: bigint;
/** Integer square root (Babylonian) — bit-identical to the other *-math modules' `isqrt`. */
export declare function isqrt(x: bigint): bigint;
/**
 * One discovered Wombat pool, oriented for a tokenIn → tokenOut swap.
 *
 * Wombat pools are MULTI-ASSET SINGLETONS: each asset carries (cash, liability) in WAD. A 2-token
 * swap reads ONLY the from-asset and to-asset state + the pool-wide ampFactor + haircutRate. The
 * on-chain execution is CALLBACK-FREE (quotePotentialSwap staticcall + approve + pool.swap), so the
 * fields here are OFF-CHAIN ONLY — they feed buildWombatSegments (the price/capacity replay).
 *
 * `fromCash`/`fromLiability` = the tokenIn (from) asset state; `toCash`/`toLiability` = the tokenOut
 * (to) asset state; all WAD. `ampFactor`/`haircutRate` are pool-wide WAD. `decIn`/`decOut` are
 * 10**decimals of tokenIn/tokenOut (the native↔WAD scaling factors).
 */
export interface WombatPool {
    /** Pool address — the quotePotentialSwap/swap target. */
    address: `0x${string}`;
    /** tokenIn (from-asset) cash, WAD. */
    fromCash: bigint;
    /** tokenIn (from-asset) liability, WAD. */
    fromLiability: bigint;
    /** tokenOut (to-asset) cash, WAD. */
    toCash: bigint;
    /** tokenOut (to-asset) liability, WAD. */
    toLiability: bigint;
    /** Pool amplification factor A, WAD (e.g. 0.002e18 = 0.2%). */
    ampFactor: bigint;
    /** Pool haircut (LP fee) rate, WAD (e.g. 0.0001e18 = 0.01%). */
    haircutRate: bigint;
    /** 10**decimals of tokenIn (native→WAD factor). */
    decIn: bigint;
    /** 10**decimals of tokenOut (WAD→native factor). */
    decOut: bigint;
    /** The pool's tokenIn address (the from-token the swap call needs). */
    tokenIn: `0x${string}`;
    /** The pool's tokenOut address (the to-token the swap call needs). */
    tokenOut: `0x${string}`;
    /** Rounded ppm haircut fee (the price-ordering coordinate / diagnostic). */
    feePpm: number;
    /** Discovery source label. */
    source: string;
}
/**
 * quotePotentialSwap(pool, dx) — the EXACT actual tokens-out for `dx` tokenIn (native decimals),
 * INCLUDING the haircut. Mirrors Pool.quotePotentialSwap / _quoteFrom bit-for-bit:
 *   fromAmountWad = dx·1e18/decIn                       # native → WAD (toWad)
 *   idealOutWad   = swapQuoteFunc(fromCash, toCash, fromLiability, toLiability, fromAmountWad, A)
 *   haircutWad    = idealOutWad·wmul(haircutRate)       # the LP fee off the OUTPUT
 *   actualOutWad  = idealOutWad - haircutWad
 *   return actualOutWad·decOut/1e18                     # WAD → native (fromWad)
 * The realized swap output equals this to the wei (Pool.swap calls the same _quoteFrom). The
 * positive-fromAmount path only (an exact-IN swap); the negative (exact-out) branch is unused here.
 */
export declare function quotePotentialSwap(pool: WombatPool, dx: bigint): bigint;
/**
 * One sampled Wombat segment in unified out/in price space — identical shape to a Curve / LB / DODO
 * / Solidly-stable / route segment (a flat [capacity, marginalOI] slice). `capacity` is the Δinput
 * (tokenIn) for this slice, `effOut` the Δoutput, and `marginalOI` the unified out/in sqrt =
 * isqrt(effOut·2^192/capacity) — the price-ordering coordinate. Segments are emitted in DESCENDING
 * `marginalOI` order (the natural order of a convex stableswap curve: the first slice is best-priced).
 *
 * fee-adjust: marginalOI is computed from the POST-HAIRCUT dy (quotePotentialSwap already nets the
 * haircut), so it is ALREADY the fee-adjusted execution price — it enters the merge's descending-price
 * sort directly (no extra sqrtOneMinusFee multiply), exactly like Curve / LB / DODO / Solidly segments.
 */
export interface WombatSegment extends MergeSegment {
    /** Δinput (tokenIn) to traverse this slice. */
    capacity: bigint;
    /** Δoutput (tokenOut) over this slice. */
    effOut: bigint;
    /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
    marginalOI: bigint;
}
/** Default sample count per Wombat pool (M). Tunable; M≈24 tightens the grid bound. */
export declare const WOMBAT_SAMPLES: number;
/**
 * Sample a Wombat pool into M descending-marginal segments over [0, amountIn].
 *
 * Geometric-ish cumulative inputs (∝ s^2 — denser near 0 where the stableswap curve is flattest,
 * then bends), each replayed through quotePotentialSwap on the READ state (NO extra RPC — pure
 * closed-form bigint). Each increment becomes a (capacity=Δin, effOut=Δout, marginalOI) segment. The
 * samples are monotone in input so the marginals are naturally descending (a convex out(in)); a
 * non-descending slice (rounding noise near saturation, or a non-convex region past the pool's
 * effective depth) is FOLDED into the last segment (isotonic backward-merge — capacity + effOut
 * conserved, blended marginal recomputed) so the merge stays monotone price-ordered without discarding
 * liquidity. See shared/segment-merge.ts.
 *
 * Exact-on-grid: the split equalizes marginals on THIS sampled grid; the per-pool out for the awarded
 * Σ share is re-evaluated wei-exact by one atomic on-chain quotePotentialSwap(Σ share) at execution.
 * Mirrors `buildSolidlyStableSegments` / `buildCurveSegments` / `buildDodoSegments` (same squared-index
 * geometric grid + isotonic backward-merge).
 */
export declare function buildWombatSegments(pool: WombatPool, amountIn: bigint, samples?: number): WombatSegment[];
/**
 * Build one Wombat pool's QUOTE-LADDER — the SHARED curve-agnostic `buildQLLadder` recurrence
 * (curve-math.ts) driven by the bigint `quotePotentialSwap` (the post-haircut coverage-ratio replay), so
 * the oracle stays wei-exact with the on-chain solver BY CONSTRUCTION: the solver builds the IDENTICAL
 * geometric ladder live from the pool's own quotePotentialSwap view (whose out `quotePotentialSwap` mirrors
 * bit-for-bit), differencing at the SAME cumulative-input points. quotePotentialSwap is post-haircut so
 * marginalOI IS the execution price; adjNear == adjFar == marginalOI.
 */
export declare function buildWombatQLLadder(pool: WombatPool, amountIn: bigint): WombatSegment[];
//# sourceMappingURL=wombat-math.d.ts.map