/**
 * Isotonic backward-merge for sampled-source segment ladders (pool-adjacent-violators / PAV).
 *
 * THE SINGLE SOURCE for the "keep the segment ladder monotone descending" step every sampled-source
 * builder (`buildXSegments`) runs. Imported by ALL 13 sampled-source math modules (curve, cryptoswap,
 * solidly-stable, wombat, balancer-stable, eulerswap, maverick, woofi, fermi, fluid, lb, dodo, mento),
 * so a builder's ladder is IDENTICAL in prepare.ts, the neutral oracle (ecoswap.optimal.ts) and the
 * cursor-faithful reference (ecoswap.solver-reference.ts) — the wei-exact gate (solver == oracle to the
 * wei) holds by construction because there is ONE ladder.
 *
 * WHY MERGE, NOT DROP. The k-way price-ordered merge the solver runs REQUIRES a monotone-descending
 * marginal ladder (each successive slice must be no better priced than the last, so the merge can walk
 * one price frontier). A convex source (V2/V3/Curve near peg) samples naturally descending, so the old
 * guard just DROPPED the rare non-descending slice (rounding noise near saturation) and moved on. But a
 * DISCRETE / non-convex source — LB bins, a DODO R-state boundary, Maverick bins, CryptoSwap near an
 * imbalance boundary — is NOT globally convex: crossing into a deeper region can RAISE the marginal
 * (the price gets better again on the far side of a gap). The engine fills THROUGH that region, so
 * DROPPING the slice (and, in the old code, silently every slice behind it that was still monotone) told
 * the split that liquidity did not exist → the split UNDER-filled the pool vs what the engine executes.
 *
 * The MERGE preserves the liquidity: a slice whose marginal violates the descending invariant is folded
 * INTO the current last segment (sum capacity, sum effOut, recompute the blended marginal), and the
 * merge CASCADES backward (keep merging the last two while the ladder is still non-monotone) until the
 * whole ladder is again monotone descending. Total Σcapacity and ΣeffOut are CONSERVED (no wei of
 * liquidity discarded) — a blended segment simply spans a wider input band at its (lower) blended
 * marginal. The blended marginal uses the EXACT same formula the builders use for a single slice:
 *
 *   marginalOI = isqrt(effOut · 2^192 / capacity)
 *
 * so a merged segment is indistinguishable in shape from an un-merged one ({capacity, effOut, marginalOI}
 * unchanged). Because the split awards input by equalizing marginals across all pools' segments and then
 * the ENGINE re-quotes the awarded per-pool Σ share wei-exact (each source's realized dy == its own
 * on-chain quote of the awarded share), a coarser (merged) segment band changes only HOW the split is
 * expressed, not the per-pool awarded total — and the oracle consumes the identical band, so
 * solver == oracle to the wei is preserved.
 */
/** 2^192 — the unified out/in sqrt fixed-point scale (matches every *-math module's Q192). */
export declare const Q192: bigint;
/** Integer square root (Babylonian) — bit-identical to every *-math module's local `isqrt`. */
export declare function isqrt(x: bigint): bigint;
/** The uniform sampled-source slice shape every `buildXSegments` emits (capacity/effOut/marginalOI). */
export interface MergeSegment {
    /** Δinput (tokenIn) to traverse this slice. */
    capacity: bigint;
    /** Δoutput (tokenOut) over this slice. */
    effOut: bigint;
    /** Unified out/in marginal price for this slice = isqrt(effOut · 2^192 / capacity). */
    marginalOI: bigint;
    /**
     * OFF-CHAIN-ONLY metadata (never part of the on-chain segment tuple, never read by the solver):
     * the WORST (lowest) original sub-slice marginal folded into this segment — == `marginalOI` for a
     * segment that was never merged. A merged segment's blended `marginalOI` averages a worse-priced
     * early sub-region with a better-priced deep one, so anything valuing a PARTIAL fill of the
     * segment (the minOut estimator's crossing-slice proration) must use THIS rate to stay a lower
     * bound — proration at the blended rate over-credits the early region. Maintained by
     * `pushMonotoneSegment` (min-propagated through fold cascades).
     */
    worstMarginalOI?: bigint;
}
/**
 * Push one sampled slice into `segs`, keeping the ladder MONOTONE DESCENDING in marginalOI via an
 * isotonic backward merge (pool-adjacent-violators) — the liquidity-preserving replacement for the old
 * strictly-descending DROP guard. Semantics:
 *
 *   - Skip a degenerate slice (marginalOI <= 0 — no priced liquidity). Nothing is discarded: a slice
 *     with capacity>0 but marginalOI==0 rounds to zero out-per-in and carries no fillable price, exactly
 *     as the old guard treated it.
 *   - If `segs` is empty OR the new slice's marginalOI is <= the last segment's, APPEND it (the common,
 *     already-descending case — bit-for-bit identical to the old guard's append branch).
 *   - Otherwise the new slice VIOLATES the descending invariant (a deeper region priced better than the
 *     last band — a discrete cliff). FOLD it into the last segment (sum capacity/effOut, recompute the
 *     blended marginal) instead of dropping it, then CASCADE backward: while the ladder still has a
 *     violation at the tail (the merged tail now prices better than the segment before it), fold the
 *     last two together. The loop terminates (each fold reduces the segment count by one).
 *
 * Total Σcapacity and ΣeffOut over `segs` after the call == before + (cap, eff): NO liquidity discarded.
 * Each segment additionally carries `worstMarginalOI` — the min original sub-slice marginal it folded
 * (== its own `marginalOI` when never folded) — off-chain metadata for lower-bound partial valuation.
 */
export declare function pushMonotoneSegment(segs: MergeSegment[], cap: bigint, eff: bigint, marginalOI: bigint): void;
//# sourceMappingURL=segment-merge.d.ts.map