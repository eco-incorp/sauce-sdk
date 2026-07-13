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
import { pushMonotoneSegment } from "./segment-merge.js";
import { buildQLLadder } from "./curve-math.js";
/** 2^192 — the unified out/in sqrt fixed-point scale (matches the other *-math modules' Q192). */
export const Q192 = 1n << 192n;
/** Integer square root (Babylonian) — bit-identical to the other *-math modules' `isqrt`. */
export function isqrt(x) {
    if (x <= 0n)
        return 0n;
    let z = x;
    let y = (z + 1n) / 2n;
    while (y < z) {
        z = y;
        y = (x / y + y) / 2n;
    }
    return z;
}
/** Fermi fee scale — feePpm is 1e6-scaled (0.03% = 300). */
export const FERMI_FEE_SCALE = 10n ** 6n;
/**
 * Default sample count per Fermi pool (M) — the number of `quoteAmounts` eth_calls the discovery sampler
 * issues per pool. Tunable; M≈24 tightens the grid bound at the cost of M RPCs. Also the segment count cap.
 */
export const FERMI_SAMPLES = Number(process.env.ECO_FERMI_SAMPLES ?? 24);
/**
 * Geometric-ish cumulative sample inputs over [0, amountIn] (∝ s^2 — denser near 0 where the curve is
 * flattest). These are the ladder points prepare's discovery sampler feeds to `quoteAmounts`; sharing this
 * grid keeps the oracle and prepare on the SAME cumIn points. Strictly ascending, ≤ amountIn.
 */
export function fermiSampleInputs(amountIn, samples = FERMI_SAMPLES) {
    if (amountIn <= 0n)
        return [];
    const M = BigInt(samples);
    const inputs = [];
    let prev = 0n;
    for (let s = 1; s <= samples; s++) {
        const ss = BigInt(s);
        const input = (amountIn * ss * ss) / (M * M);
        if (input > prev) {
            inputs.push(input);
            prev = input;
        }
    }
    return inputs;
}
/**
 * getAmountOut(pool, dx) — the sampled out for cumulative input `dx` by LINEAR INTERPOLATION on the pool's
 * live quote ladder (the ladder is the only Fermi state we have off-chain — the FermiSwapper exposes no
 * closed form). Exact at a ladder point; interpolated between points. Returns 0 for dx<=0 or an empty ladder.
 * This is a diagnostic / segment-partition helper, NOT a wei-exact swap-math replay — the realized out is the
 * LIVE `quoteAmounts` at execution.
 */
export function getAmountOut(pool, dx) {
    if (dx <= 0n)
        return 0n;
    const n = pool.cumIn.length;
    if (n === 0)
        return 0n;
    if (dx <= pool.cumIn[0]) {
        // Linear from origin to the first ladder point.
        return (pool.cumOut[0] * dx) / pool.cumIn[0];
    }
    for (let i = 1; i < n; i++) {
        if (dx <= pool.cumIn[i]) {
            const inLo = pool.cumIn[i - 1];
            const inHi = pool.cumIn[i];
            const outLo = pool.cumOut[i - 1];
            const outHi = pool.cumOut[i];
            const span = inHi - inLo;
            if (span <= 0n)
                return outHi;
            return outLo + ((outHi - outLo) * (dx - inLo)) / span;
        }
    }
    // Beyond the sampled range — clamp to the last (marginal flattens; the split never awards past amountIn).
    return pool.cumOut[n - 1];
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
export function buildFermiSegments(pool, amountIn, _samples = FERMI_SAMPLES) {
    if (amountIn <= 0n)
        return [];
    const n = pool.cumIn.length;
    if (n === 0)
        return [];
    const segs = [];
    let prevIn = 0n;
    let prevOut = 0n;
    for (let i = 0; i < n; i++) {
        const input = pool.cumIn[i] < amountIn ? pool.cumIn[i] : amountIn;
        if (input <= prevIn)
            continue;
        const out = getAmountOut(pool, input);
        if (out <= 0n)
            continue;
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
        if (pool.cumIn[i] >= amountIn)
            break;
    }
    return segs;
}
/**
 * Build one Fermi / propAMM pool's QUOTE-LADDER — the SHARED curve-agnostic `buildQLLadder` recurrence
 * (curve-math.ts) driven by the bigint `getAmountOut` (the LINEAR-interpolated live quote ladder), so the
 * oracle stays wei-exact with the on-chain solver BY CONSTRUCTION *provided the pool's `cumIn` samples the
 * ladder AT the geometric `qlLadderInputs(amountIn)` points* — then `getAmountOut` is EXACT at each ladder
 * point (interpolation at a sample point returns the sampled value), so the ladder reproduces the solver's
 * live `quoteAmounts(tokenIn,tokenOut,+xNext)[1]` at every step. The quote is post-fee (the router folds the
 * fee into quoteAmounts) so marginalOI IS the execution price; adjNear == adjFar == marginalOI.
 */
export function buildFermiQLLadder(pool, amountIn) {
    return buildQLLadder((dx) => getAmountOut(pool, dx), amountIn);
}
//# sourceMappingURL=fermi-math.js.map