/**
 * Shared stable-curve Newton helpers for the LADDER (adapter v2) families —
 * saber-stableswap and meteora-damm-v1-stable declare these through their
 * `helpers()` and the EcoSwapSVM codegen dedupes them by name.
 *
 * stableD is byte-identical math to the solswap generator's helper (ann =
 * amp·2 inside, ≤ 256 iterations, converged when successive estimates differ
 * by ≤ 1, floor division; Math.mulDiv carries the d³-scale products). The
 * `break`-less sentinel-loop convention is the repo's compiler-surface rule:
 * `diff` starts at 2 (> 1, guaranteeing the first pass) and the convergence
 * check rides in the loop condition.
 *
 * stableYW is the warm-startable Newton y: identical to the venues' own
 * compute_y EXCEPT the iteration starts from a caller-provided y0 instead of
 * the hardcoded d. Passing y0 = d IS the venue's cold iteration, so the
 * FINAL (predicted-output) quote always calls it with y0 = d — venue-exact
 * by construction. Ladder rungs pass the previous rung's y: the fixed point
 * is approached from above either way (larger cumulative input ⇒ smaller y,
 * so y_prev ≥ y*), which cuts the Newton iterations to ~1-2 per rung — the
 * difference between a stable slot fitting the CU budget or not (see
 * recipes/ecoswap/svm/budget.ts). The warm-vs-cold oracle unit asserts the
 * chain reproduces the cold values on the fixture universe; even where an
 * exotic pool might wobble a rung by a lamport, both sides of the
 * lamport-exact gate (fragment and TS mirror) compute the SAME chain, so
 * exactness is unconditional — only rung-election quality could shift, never
 * the venue-exact final quotes.
 */
export interface SvmHelperFn {
    name: string;
    source: string;
}
export declare const STABLE_D_HELPER: SvmHelperFn;
export declare const STABLE_YW_HELPER: SvmHelperFn;
/** TS mirror of stableD — Newton invariant, floor division, ≤ 256 rounds, |Δ| ≤ 1 convergence. */
export declare function stableComputeD(amp: bigint, xa: bigint, xb: bigint): bigint;
/** TS mirror of stableYW — Newton y from y0 (y0 = d is the venues' cold compute_y). */
export declare function stableComputeYWarm(amp: bigint, x: bigint, d: bigint, y0: bigint): bigint;
//# sourceMappingURL=stable-helpers.d.ts.map