/**
 * EcoSwapSVM continuous water-fill oracle — the closed-form CP marginal
 * equalization used ONLY to measure the quantized ladder's efficiency loss
 * (a report, never a gate; the exactness gate is solver-reference.ts).
 *
 * Every CP-class venue reduces to the fee-scaled constant-product form
 *   out(x) ≈ mu · (gamma·x · rOut) / (rIn + gamma·x)
 * (gamma = input-side fee retention, mu = output-side retention — the
 * adapters' continuousFees, ppm-scaled). Its post-fee marginal price is
 *   m(x) = mu·gamma·rIn·rOut / (rIn + gamma·x)²
 * and equalizing m across venues under Σx_i = A has the closed form
 *   x_i(λ) = (sqrt(mu_i·gamma_i·rIn_i·rOut_i / λ) − rIn_i) / gamma_i
 *   sqrt(1/λ) = (A + Σ rIn_i/gamma_i) / Σ sqrt(mu_i·gamma_i·rIn_i·rOut_i)/gamma_i
 * over the ACTIVE set (venues whose spot marginal clears the water level);
 * inactive venues are dropped iteratively (their x_i would go negative).
 *
 * The split solve runs in floating point (measurement precision is ample for
 * u64 magnitudes); the resulting slices are floored to lamports, topped up to
 * Σ = A on the deepest active venue, and the TOTAL is evaluated through the
 * EXACT integer quote closures — so the reported optimum is a realizable
 * integer allocation, not a real-analysis fiction.
 */
export interface ContinuousVenue {
    /** Effective input-side reserve (the adapters' depthReserves). */
    reserveIn: bigint;
    /** Effective output-side reserve. */
    reserveOut: bigint;
    /** Input-side fee retention, ppm (continuousFees.gammaPpm). */
    gammaPpm: bigint;
    /** Output-side fee retention, ppm (continuousFees.muPpm). */
    muPpm: bigint;
    /** Exact integer venue quote — evaluates the final slices. */
    quote: (x: bigint) => bigint;
}
export interface OptimalSplitResult {
    /** Continuous-optimal slices, floored to integers, summing to amountIn. */
    slices: bigint[];
    /** Σ quote(slice) through the exact integer venue math. */
    totalOut: bigint;
}
/** Continuous marginal-equalization split across the venues. */
export declare function solveOptimal(venues: readonly ContinuousVenue[], amountIn: bigint): OptimalSplitResult;
/**
 * Quantization efficiency loss of the ladder result vs the continuous
 * optimum, as a fraction of the optimal output (e.g. 0.001 = 0.1%). May be
 * slightly negative when integer rounding favors the quantized split.
 */
export declare function efficiencyLoss(optimalOut: bigint, quantizedOut: bigint): number;
//# sourceMappingURL=optimal.d.ts.map