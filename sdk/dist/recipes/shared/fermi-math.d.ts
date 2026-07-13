/**
 * Fermi / propAMM (gattaca-com/propamm FermiSwapper — an OBRIC-style proactive AMM) — off-chain segment
 * builder over a LIVE on-chain quote ladder.
 *
 * THE SINGLE SOURCE for how a Fermi pool is turned into split segments. Imported by BOTH:
 *   - the production `prepare.ts` (buildFermiSegments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (fermiSegments),
 * so the split is exact-on-grid vs the oracle by construction (one shared ladder → one segmentation).
 *
 * REAL ON-CHAIN SURFACE. The deployed FermiSwapper does NOT expose the raw curve state (no tokenX/tokenY/
 * K()/base()/feePpm() getters) and does NOT expose a getAmountOut(uint256,address) view — that interface was
 * fabricated. Its actual surface is a SIGNED-amount router:
 *   quoteAmounts(address tokenIn, address tokenOut, int256 amountSpecified) view -> (uint256 amountIn, uint256 amountOut)
 *   fermiSwapWithAllowances(address tokenIn, address tokenOut, int256 amountSpecified, uint256 amountCheck, address recipient) -> (uint256, uint256)
 * with amountSpecified SIGNED (positive = exact tokenIn, negative = exact tokenOut) per the propAMM taker.
 * So we CANNOT read K/base and replay a closed form off-chain. Instead prepare SAMPLES the pool via a small
 * ladder of `quoteAmounts(tokenIn, tokenOut, +cumIn)` eth_calls at discovery (an RPC-per-sample sampler, no
 * closed-form snapshot), stores the resulting (cumIn, cumOut) points on the descriptor, and this module
 * builds descending-marginal segments from those points — NO further RPC, so the oracle shares them exactly.
 *
 * ON-CHAIN EXECUTION is CALLBACK-FREE (Fermi is NOT xy=k, so the engine's _swapV2 mis-prices it; the swap is
 * callback-free so it needs no engine dispatch): the solver re-reads the out for the awarded share LIVE via
 * `quoteAmounts(tokenIn, tokenOut, +share)[1]`, APPROVES the router for the input (propAMM PULLS via
 * transferFrom — approve-first, like Wombat/Curve, NOT transfer-first like WOOFi), then calls
 * `fermiSwapWithAllowances(tokenIn, tokenOut, +share, amountCheck, self)` with amountCheck == the live quote.
 *
 * WEI-EXACTNESS CLASS. This is NOT a closed-form replay — the split is priced off a LIVE on-chain QUOTE
 * ladder sampled at prepare time (a SNAPSHOT of the router's live state), so:
 *   - the SPLIT is EXACT-ON-GRID-AT-SNAPSHOT — the oracle segments the SAME sampled ladder, so solver ==
 *     oracle bit-for-bit on that grid;
 *   - per-pool EXECUTION re-reads the out via the LIVE `quoteAmounts` view and passes it as `amountCheck`,
 *     so the realized out equals the live quote for the awarded share and a bad fill is bounded by
 *     amountCheck (per pool) + the whole-trade amountOutMin + the solver's guarded terminal refund.
 * The residual is EXOGENOUS — the maker can post new params between prepare and cook (the same snapshot
 * assumption the recipe documents for the WOOFi oracle, the V3/Algebra fee, and the Balancer/Curve state).
 * This is a SNAPSHOTTED-QUOTE class, NOT the earlier (unsubstantiated) "the view IS the swap math" claim.
 *
 * Sources:
 *   https://github.com/gattaca-com/propamm            (FermiSwapper taker/quoter — quoteAmounts + fermiSwapWithAllowances)
 *   https://github.com/fahimahmedx/prop-amm           (the Obric-style curve reference: quoteXtoY/quoteYtoX)
 *   FermiSwapper 0xb1076fe3ab5e28005c7c323bac5ac06a680d452e (Etherscan verified)
 */
import { type MergeSegment } from "./segment-merge.js";
/** 2^192 — the unified out/in sqrt fixed-point scale (matches the other *-math modules' Q192). */
export declare const Q192: bigint;
/** Integer square root (Babylonian) — bit-identical to the other *-math modules' `isqrt`. */
export declare function isqrt(x: bigint): bigint;
/**
 * One discovered Fermi / propAMM pool (a FermiSwapper router + a direct tokenIn→tokenOut leg), oriented for
 * the swap. The FermiSwapper exposes NO raw curve state, so this descriptor carries a LIVE QUOTE LADDER
 * sampled at discovery — cumulative (cumIn, cumOut) points from `quoteAmounts(tokenIn, tokenOut, +cumIn)`,
 * ascending in cumIn. `buildFermiSegments` differences the ladder into descending-marginal segments with NO
 * further RPC (so the oracle shares them). All fields are OFF-CHAIN ONLY (the split); the on-chain execution
 * re-reads the exact out LIVE via `quoteAmounts`.
 */
export interface FermiPool {
    /** Router address — the quoteAmounts / fermiSwapWithAllowances / approve target. */
    address: `0x${string}`;
    /** The pool's tokenIn (the from-token the swap call needs) == the EcoSwap tokenIn. */
    tokenIn: `0x${string}`;
    /** The pool's tokenOut (the to-token the swap call needs) == the EcoSwap tokenOut. */
    tokenOut: `0x${string}`;
    /** LIVE quote ladder: ascending cumulative input samples (native tokenIn decimals). */
    cumIn: bigint[];
    /** LIVE quote ladder: the `quoteAmounts(tokenIn, tokenOut, +cumIn[i])[1]` output for each cumIn[i]. */
    cumOut: bigint[];
    /**
     * Effective per-pool fee in ppm, DERIVED from the sampled ladder for price-ordering / diagnostics only
     * (the router folds the fee into the quote — there is no feePpm() getter). 0 when unknown.
     */
    feePpm: number;
    /** Discovery source label. */
    source: string;
}
/** Fermi fee scale — feePpm is 1e6-scaled (0.03% = 300). */
export declare const FERMI_FEE_SCALE: bigint;
/**
 * Default sample count per Fermi pool (M) — the number of `quoteAmounts` eth_calls the discovery sampler
 * issues per pool. Tunable; M≈24 tightens the grid bound at the cost of M RPCs. Also the segment count cap.
 */
export declare const FERMI_SAMPLES: number;
/**
 * Geometric-ish cumulative sample inputs over [0, amountIn] (∝ s^2 — denser near 0 where the curve is
 * flattest). These are the ladder points prepare's discovery sampler feeds to `quoteAmounts`; sharing this
 * grid keeps the oracle and prepare on the SAME cumIn points. Strictly ascending, ≤ amountIn.
 */
export declare function fermiSampleInputs(amountIn: bigint, samples?: number): bigint[];
/**
 * getAmountOut(pool, dx) — the sampled out for cumulative input `dx` by LINEAR INTERPOLATION on the pool's
 * live quote ladder (the ladder is the only Fermi state we have off-chain — the FermiSwapper exposes no
 * closed form). Exact at a ladder point; interpolated between points. Returns 0 for dx<=0 or an empty ladder.
 * This is a diagnostic / segment-partition helper, NOT a wei-exact swap-math replay — the realized out is the
 * LIVE `quoteAmounts` at execution.
 */
export declare function getAmountOut(pool: FermiPool, dx: bigint): bigint;
/**
 * One sampled Fermi segment in unified out/in price space — identical shape to a Curve / DODO / WOOFi /
 * Wombat segment (a flat [capacity, marginalOI] slice). `capacity` is the Δinput (tokenIn) for this slice,
 * `effOut` the Δoutput, and `marginalOI` the unified out/in sqrt = isqrt(effOut·2^192/capacity) — the
 * price-ordering coordinate. Segments are emitted DESCENDING in `marginalOI` (the propAMM curve steepens
 * with size, so the first slice is best-priced).
 *
 * fee-adjust: marginalOI is computed from the ladder dy, which is the router's POST-FEE quote (the fee is
 * folded into `quoteAmounts`), so it is ALREADY the fee-adjusted execution price — it enters the merge's
 * descending-price sort directly, exactly like Curve / DODO / WOOFi / Wombat / Solidly segments.
 */
export interface FermiSegment extends MergeSegment {
    /** Δinput (tokenIn) to traverse this slice. */
    capacity: bigint;
    /** Δoutput (tokenOut) over this slice. */
    effOut: bigint;
    /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
    marginalOI: bigint;
}
/**
 * Build Fermi segments by DIFFERENCING the pool's pre-sampled live quote ladder (cumIn, cumOut) into
 * descending-marginal (capacity=Δin, effOut=Δout, marginalOI) slices. NO RPC (the ladder was sampled at
 * discovery) — a pure function over the descriptor, so prepare and the oracle produce identical segments
 * from the same ladder. `amountIn` caps the range (the ladder is already sampled over [0, amountIn]). A
 * non-descending slice (rounding noise, or past where the curve collapses) is FOLDED into the last segment
 * (isotonic backward-merge — capacity + effOut conserved, blended marginal recomputed) so the merge stays
 * monotone price-ordered without discarding liquidity. Mirrors `buildWooFiSegments` / `buildDodoSegments`
 * (same isotonic backward-merge). See shared/segment-merge.ts.
 */
export declare function buildFermiSegments(pool: FermiPool, amountIn: bigint, _samples?: number): FermiSegment[];
/**
 * Build one Fermi / propAMM pool's QUOTE-LADDER — the SHARED curve-agnostic `buildQLLadder` recurrence
 * (curve-math.ts) driven by the bigint `getAmountOut` (the LINEAR-interpolated live quote ladder), so the
 * oracle stays wei-exact with the on-chain solver BY CONSTRUCTION *provided the pool's `cumIn` samples the
 * ladder AT the geometric `qlLadderInputs(amountIn)` points* — then `getAmountOut` is EXACT at each ladder
 * point (interpolation at a sample point returns the sampled value), so the ladder reproduces the solver's
 * live `quoteAmounts(tokenIn,tokenOut,+xNext)[1]` at every step. The quote is post-fee (the router folds the
 * fee into quoteAmounts) so marginalOI IS the execution price; adjNear == adjFar == marginalOI.
 */
export declare function buildFermiQLLadder(pool: FermiPool, amountIn: bigint): FermiSegment[];
//# sourceMappingURL=fermi-math.d.ts.map