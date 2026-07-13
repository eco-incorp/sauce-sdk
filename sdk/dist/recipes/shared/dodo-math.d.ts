/**
 * DODO V2 PMM (Proactive Market Maker) — VERBATIM bigint replay + off-chain segment sampler.
 *
 * THE SINGLE SOURCE for DODO V2 math. Imported by BOTH:
 *   - the production `prepare.ts` (buildDodoSegments / buildDodoBrackets), and
 *   - the neutral oracle `ecoswap.optimal.ts` (dodoSegments),
 * so the split is exact-on-grid vs the oracle by construction (one replay), and the per-pool
 * executed output == querySell*(awarded share) to the wei (one atomic engine swap → _swapDODOV2).
 *
 * THE PMM MATH IS OFF-CHAIN ONLY. The on-chain solver does NOT recompute the PMM integral. The
 * guide price `i` is POOL STATE (read live from `getPMMStateForCall()`), NOT an exogenous oracle
 * feed — so the curve is a deterministic function of the read state (unlike WOOFi/Fermi, whose
 * price is an off-chain feed and which are therefore out of the wei-exact charter). prepare samples
 * DODO into (capacity, effOut, marginalOI) SEGMENTS via this exact closed-form replay; the on-chain
 * solver consumes them as STATIC segments through the existing static-segment cursor (the same
 * machinery the merge already uses for route / Curve / LB segments), and EXECUTES each DODO pool via
 * swap(SwapParams{poolType:5 (DODOV2), pool, tokenIn, tokenOut, amountSpecified:neg}) → the live
 * `_swapDODOV2` path, which resolves base/quote orientation ON-CHAIN (it reads the pool's
 * `_BASE_TOKEN_()` and calls `sellBase`/`sellQuote`). No engine change.
 *
 * CLOSED-FORM, NO UNBOUNDED LOOP. The PMM output is a closed-form integral (a quadratic solve and a
 * fair-amount integral), NOT a Newton iteration — so the replay is a fixed sequence of bigint ops
 * (the only loop is `isqrt`, Babylonian, bounded). This is the property the feasibility doc flags as
 * the reason DODO is tractable on the wei-exact bar.
 *
 * SOURCE MIRRORED — DODO V2 `PMMPricing` + `DODOMath` + `DecimalMath` (the canonical
 * DODOEX/contractV2 libraries; the same math the DVM/DSP/DPP pools run):
 *   - `DODOMath._GeneralIntegrate(V0, V1, V2, i, k)` — the R!=ONE fair-amount integral.
 *     `fairAmount = i·(V1−V2)` RAW (1e36-ish units), `V0V0V1V2 = divFloor(V0²/V1, V2)`, one final
 *     `/(1e36)` — plus the `k==0` shortcut and the `V0 > 0` require.
 *   - `DODOMath._SolveQuadraticFunctionForTrade(V0, V1, delta, i, k)` — the sell-side quadratic:
 *     solves for the NEW counter-reserve `V2 = divCeil(−b + √(b²+4(1−k)kV0²), 2(1−k))` and returns
 *     the RECEIVE amount `V1 − V2` (0 when `V2 > V1`), with the `k==0` (`min(i·delta, V1)`) and
 *     `k==ONE` (closed-form `V1·temp/(temp+ONE)`, uint256-overflow-guarded temp) special cases.
 *     `b` is accumulated in RAW units (`part2 = kV0²/V1 + i·delta` vs `(1−k)V1`) and divided by
 *     ONE once, AFTER the signed subtraction.
 *   - `PMMPricing.sellBaseToken` / `sellQuoteToken` — the R-state dispatch (ONE / ABOVE_ONE /
 *     BELOW_ONE) and the boundary-crossing two-part integration (integrate back to R==ONE, then
 *     `_ROneSell*` the remainder). The quadratic legs pass the RAW pay amount + `i` (or `1/i`)
 *     straight through — there is NO pre-multiplied `mulFloor(i, pay)` step.
 *   - `DecimalMath`: ONE = 1e18; mulFloor(a,b)=a*b/1e18; divFloor(a,b)=a*1e18/b;
 *     divCeil(a,b)=ceil(a*1e18/b); reciprocalFloor(t)=1e36/t. Reproduced bit-for-bit so the
 *     off-chain `effOut` equals the engine `_swapDODOV2` realized output to the wei.
 *   - Fees: `receiveAmount` is netted by the LP fee then the MT fee, both `mulFloor(receiveAmount,
 *     rate)` with the rate 1e18-scaled (`_LP_FEE_RATE_` + the MT fee-rate model). The combined fee
 *     is read once at quote time and treated as fixed over the trade (the same snapshot assumption
 *     the recipe makes for V3 tiers / LB base fee).
 *
 * The replay runs purely on the read pool state (i/K/B/Q/B0/Q0/R + the two fee rates);
 * buildDodoSegments makes NO extra RPC.
 *
 * Sources:
 *   https://github.com/DODOEX/contractV2/blob/main/contracts/lib/PMMPricing.sol
 *   https://github.com/DODOEX/contractV2/blob/main/contracts/lib/DODOMath.sol
 *   https://github.com/DODOEX/contractV2/blob/main/contracts/lib/DecimalMath.sol
 */
import { type MergeSegment } from "./segment-merge.js";
/** 2^192 — the unified out/in sqrt fixed-point scale (matches ecoswap.math / curve-math / lb-math Q192). */
export declare const Q192: bigint;
/** DODO DecimalMath ONE — 1e18 fixed point. */
export declare const DODO_ONE: bigint;
/** Integer square root (Babylonian) — bit-identical to curve-math / lb-math / ecoswap.math `isqrt`. */
export declare function isqrt(x: bigint): bigint;
/**
 * `_GeneralIntegrate(V0, V1, V2, i, k)` — DODOMath verbatim.
 *
 *   require(V0 > 0)                      // TARGET_IS_ZERO — replayed as 0 (the pool reverts)
 *   fairAmount = i * (V1 - V2)           // RAW i·delta — NOT mulFloor'd
 *   if k == 0: return fairAmount / ONE
 *   V0V0V1V2   = divFloor(V0*V0/V1, V2)
 *   penalty    = mulFloor(k, V0V0V1V2)
 *   return (ONE - k + penalty) * fairAmount / ONE2
 *
 * The integral of the PMM marginal price over [V2, V1] with reference reserve V0 and slippage k.
 * The single final /1e36 (instead of two staged /1e18 floors) is load-bearing for wei-exactness.
 */
export declare function generalIntegrate(V0: bigint, V1: bigint, V2: bigint, i: bigint, k: bigint): bigint;
/**
 * `_SolveQuadraticFunctionForTrade(V0, V1, delta, i, k)` — DODOMath verbatim. Solves the PMM
 * quadratic for the NEW counter-reserve V2 and returns the RECEIVE amount `V1 - V2` (what the
 * trader gets out), NOT V2 itself.
 *
 *   require(V0 > 0); delta == 0 → 0
 *   k == 0   → min(mulFloor(i, delta), V1)
 *   k == ONE → temp = i*delta*V1/(V0*V0)  (uint256-overflow-guarded: falls back to
 *              delta*V1/V0*i/V0 when idelta*V1 wraps); return V1*temp/(temp+ONE)
 *   else:
 *     part2 = k*V0/V1*V0 + i*delta        // RAW (1e18·token) units
 *     bAbs  = (ONE - k) * V1              // RAW
 *     bSig  = part2 > bAbs (b positive); bAbs = |bAbs - part2| / ONE   // ONE divide AFTER the sub
 *     squareRoot = sqrt( bAbs² + mulFloor((ONE-k)*4, mulFloor(k, V0)*V0) )
 *     numerator  = bSig ? squareRoot - bAbs (revert if 0) : bAbs + squareRoot
 *     V2 = divCeil(numerator, (ONE - k)*2)   // divCeil UNCONDITIONALLY
 *     return V2 > V1 ? 0 : V1 - V2
 *
 * Note `.sqrt()` here is the plain integer sqrt of a 1e18-scaled square (`bAbs²` and the penalty
 * term are already in (1e18)² units, so the integer sqrt lands back in 1e18 units). The contract's
 * reverts (V0 == 0, numerator == 0) are replayed as 0 — a pool whose querySell* would revert
 * contributes no output, so the sampler awards it nothing.
 */
export declare function solveQuadraticForTrade(V0: bigint, V1: bigint, delta: bigint, i: bigint, k: bigint): bigint;
/** R-state — `PMMPricing.RState` (0 = ONE, 1 = ABOVE_ONE, 2 = BELOW_ONE). */
export declare const enum RState {
    ONE = 0,
    ABOVE_ONE = 1,
    BELOW_ONE = 2
}
/** The raw PMM state a DODO V2 pool reports from `getPMMStateForCall()`. */
export interface DodoPmmState {
    /** Guide price i (1e18-scaled): quote-per-base mid-price. POOL STATE (not an external feed). */
    i: bigint;
    /** Slippage coefficient K (1e18-scaled; 0 = constant price, 1e18 = constant-product-like). */
    K: bigint;
    /** Current base reserve B (base-token units). */
    B: bigint;
    /** Current quote reserve Q (quote-token units). */
    Q: bigint;
    /** Target base reserve B0. */
    B0: bigint;
    /** Target quote reserve Q0. */
    Q0: bigint;
    /** R-state (ONE / ABOVE_ONE / BELOW_ONE). */
    R: RState;
}
/**
 * One discovered DODO V2 pool, oriented for a tokenIn → tokenOut swap.
 *
 * The engine `_swapDODOV2` resolves base/quote orientation ON-CHAIN (it reads the pool's
 * `_BASE_TOKEN_()` and calls sellBase or sellQuote), so the on-chain SwapParams carry ONLY
 * {pool, tokenIn, tokenOut, amountSpecified, payer, recipient}. The fields here are OFF-CHAIN
 * ONLY — they feed buildDodoSegments (the price/capacity replay). `sellBase` tags which side of
 * the PMM this swap traverses (tokenIn == the pool's base token): selling base → quote, else
 * selling quote → base. `feeRate` is the COMBINED LP+MT fee (1e18-scaled), applied to the gross
 * receive amount as the pool does (two sequential mulFloor deductions collapse to one because
 * floor(floor(x·(1-lp))·(1-mt)) is reproduced exactly by netting in the same order — see getDy).
 */
export interface DodoPool {
    /** Always SwapPoolType.DODOV2 (=5) — execution dispatches via swap(SwapParams{poolType:5}). */
    poolType: number;
    /** Pool address — the swap(SwapParams{poolType:5, pool}) target / sellBase/sellQuote contract. */
    address: `0x${string}`;
    /** The pool's base token (DODO `_BASE_TOKEN_()`). Orientation reference. */
    baseToken: `0x${string}`;
    /** The pool's quote token. */
    quoteToken: `0x${string}`;
    /** true => tokenIn == baseToken (sell base → quote); false => tokenIn == quoteToken (sell quote → base). */
    sellBase: boolean;
    /** Guide price i (1e18-scaled) — POOL STATE from getPMMStateForCall. */
    i: bigint;
    /** Slippage coefficient K (1e18-scaled). */
    K: bigint;
    /** Current base reserve B. */
    B: bigint;
    /** Current quote reserve Q. */
    Q: bigint;
    /** Target base reserve B0. */
    B0: bigint;
    /** Target quote reserve Q0. */
    Q0: bigint;
    /** R-state (ONE / ABOVE_ONE / BELOW_ONE). */
    R: RState;
    /** LP fee rate (1e18-scaled; pool `_LP_FEE_RATE_`). */
    lpFeeRate: bigint;
    /** MT (maintainer) fee rate (1e18-scaled; the pool's MT fee-rate model for the caller). */
    mtFeeRate: bigint;
    /** Rounded ppm fee (the price-ordering coordinate / diagnostics; lpFeeRate+mtFeeRate → ppm). */
    feePpm: number;
    /** Discovery source label. */
    source: string;
}
/**
 * `querySellBase` / `querySellQuote` net of fees — the exact tokens-out for `payAmount` tokenIn,
 * INCLUDING the LP and MT fees. Mirrors DVMTrader.querySell* bit-for-bit:
 *
 *   receiveAmount = PMMPricing.sell{Base,Quote}Token(state, payAmount)   # gross
 *   lpFee = mulFloor(receiveAmount, lpFeeRate)
 *   mtFee = mulFloor(receiveAmount, mtFeeRate)
 *   return receiveAmount - lpFee - mtFee
 *
 * (DVMTrader subtracts the lp fee and the mt fee, each `mulFloor(receiveAmount, rate)`, from the
 * SAME gross `receiveAmount` — so the net is `gross - floor(gross·lp) - floor(gross·mt)`, NOT a
 * sequential compounding. Reproduced in that exact order so the off-chain out equals the engine
 * `_swapDODOV2` realized output to the wei.)
 */
export declare function getDy(pool: DodoPool, payAmount: bigint): bigint;
/**
 * One sampled DODO segment in unified out/in price space — identical shape to a Curve / LB / route
 * segment (a flat [capacity, marginalOI] slice). `capacity` is the Δinput (tokenIn) for this slice,
 * `effOut` the Δoutput, and `marginalOI` the unified out/in sqrt = isqrt(effOut * 2^192 / capacity)
 * — the price-ordering coordinate. Segments are emitted in DESCENDING `marginalOI` order (the
 * natural order of a convex PMM curve: the first marginal slice is the best-priced).
 *
 * fee-adjust: marginalOI is computed from the POST-FEE dy (getDy already nets the LP+MT fee), so it
 * is ALREADY the fee-adjusted execution price — it enters the merge's descending-price sort directly
 * (no extra sqrtOneMinusFee multiply, the fee is baked into dy), exactly like Curve / LB segments.
 */
export interface DodoSegment extends MergeSegment {
    /** Δinput (tokenIn) to traverse this slice. */
    capacity: bigint;
    /** Δoutput (tokenOut) over this slice. */
    effOut: bigint;
    /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
    marginalOI: bigint;
}
/** Default sample count per DODO pool (M). Tunable; M≈24 tightens the grid bound. */
export declare const DODO_SAMPLES: number;
/**
 * Sample a DODO V2 pool into M descending-marginal segments over [0, amountIn].
 *
 * Geometric-ish cumulative inputs (denser near 0 where the PMM curve is steepest), each replayed
 * through getDy (querySell*) on the READ state (NO extra RPC — pure bigint, closed-form). Each
 * increment becomes a (capacity=Δin, effOut=Δout, marginalOI) segment. The samples are monotone in
 * input so the marginals are naturally descending (a convex out(in)); a non-descending slice
 * (rounding noise near saturation, or a non-convex region past an R-state boundary) is FOLDED into the
 * last segment (isotonic backward-merge — capacity + effOut conserved, blended marginal recomputed) so
 * the merge stays monotone price-ordered without discarding liquidity. See shared/segment-merge.ts.
 *
 * Exact-on-grid: the split equalizes marginals on THIS sampled grid; the per-pool dy for the awarded
 * Σ share is re-evaluated wei-exact by one atomic querySell*(Σ share) at execution (the engine
 * `_swapDODOV2`). M≈24 (default) keeps the grid bound `O(curvature·maxSlice)` negligible. Mirrors
 * `buildCurveSegments` (same squared-index geometric grid + isotonic backward-merge).
 */
export declare function buildDodoSegments(pool: DodoPool, amountIn: bigint, samples?: number): DodoSegment[];
/**
 * Build one DODO V2 pool's QUOTE-LADDER — the SHARED curve-agnostic `buildQLLadder` recurrence
 * (curve-math.ts) driven by the bigint `getDy` (the querySell* net-of-fee replay), so the oracle stays
 * wei-exact with the on-chain solver BY CONSTRUCTION: the solver builds the IDENTICAL geometric ladder
 * live from the pool's own querySellBase/querySellQuote view (whose net-of-LP+MT out equals `getDy` to the
 * wei — the Lane-0-corrected contractV2 math), differencing at the SAME cumulative-input points. getDy is
 * post-fee so marginalOI IS the execution price; adjNear == adjFar == marginalOI. Directional orientation
 * (sellBase/sellQuote) is carried on the DodoPool (`sellBase`), matching the qd[1] isSellBase descriptor.
 */
export declare function buildDodoQLLadder(pool: DodoPool, amountIn: bigint): DodoSegment[];
/** Round a DODO combined 1e18-scaled fee (lp+mt) to ppm (the price-ordering coordinate / diagnostics). */
export declare function dodoFeeToPpm(lpFeeRate: bigint, mtFeeRate: bigint): number;
//# sourceMappingURL=dodo-math.d.ts.map