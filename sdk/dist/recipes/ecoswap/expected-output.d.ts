/**
 * Off-chain LOWER-BOUND estimate of the whole-trade tokenOut the EcoSwap split produces,
 * used ONLY to derive the on-chain solver's internal amountOutMin floor (cfg[9]). It does
 * NOT feed the split args, so it can NEVER change the wei-exact split.
 *
 * WHY A LOWER BOUND. The floor's contract is: a legitimate wei-exact fill must NEVER
 * false-revert. So `expectedTotalOut` must be <= the output the on-chain solver actually
 * realizes; then `minOut = expectedTotalOut * (10000 - slipBps) / 10000` sits strictly
 * below the true fill and only ever fires on a genuine (large) shortfall. This estimator
 * is intentionally CONSERVATIVE — it under-counts, never over-counts:
 *
 *   - Direct V3/V4 pools: walk each pool's frontier over ONLY the lens-scanned net window
 *     (the same drift-invariant nets the solver caches), valuing each constant-L slice at
 *     its EXACT over-slice output L*(nearOI-farOI)/2^96. Stopping at the window edge (never
 *     staticcalling deeper, as the solver would) can only OMIT deeper output, so the sum is
 *     a lower bound. The oracle's `v3Segments` walk is mirrored; this estimator reuses the
 *     SAME multiplicative stepReal grid, so the per-slice prices agree with the solver.
 *   - Direct V2 pools (incl. Kyber on virtual reserves): the exact constant-L geometric
 *     stream, valued per slice — bounded by a slice cap for termination.
 *   - Sampled-segment venues (Curve/LB/DODO/Solidly/Wombat/Balancer/Euler/Maverick/Crypto/
 *     WOOFi/Fermi/Fluid/Mento/Balancer-V3): each prepared bracket is a FLAT post-fee slice
 *     ({capacity, marginalOI}); its output is capacity*marginalOI^2/2^192 (exact for a flat
 *     slice). A PARTIAL fill of the crossing bracket is valued at the bracket's WORST folded
 *     sub-slice marginal (worstMarginalOI) when present — an isotonic-MERGED bracket's early
 *     sub-region is its worse-priced one, so the blended-rate linear prorate would over-credit
 *     — falling back to the linear prorate for never-merged (truly flat) slices.
 *   - Multi-hop routes: NOT counted (a route only ADDS output; omitting it lowers the floor
 *     → still a lower bound, still safe). Routes are rare and their live composition is best
 *     valued on-chain, not re-derived here.
 *
 * All venues' price-monotone slices are merged in ONE descending fee-adjusted-price order
 * (the SAME order the solver's k-way merge consumes) and water-filled up to amountIn; the
 * awarded per-slice output is summed. The result is the expected whole-trade output floor.
 *
 * TIGHTNESS CAVEAT (why the derived floor is often FAR below the nominal `slipBps` band, yet
 * still correct). The V3/V4 walk only counts boundaries present in the shipped windowed net
 * (`p.netRows`). In the common LIVE-WALK / 1-RPC quote path the lens ships NO net rows
 * (windowTop=0 ⇒ the solver staticcalls every boundary live), so `v3Slices` emits only the
 * FIRST constant-L spot slice per V3/V4 pool and then breaks at the first `!net.has(sh)`. The
 * estimate then covers only that pool's spot-slice output — a much LOWER lower bound than the
 * true fill (empirically ~50% below realized), so the derived `minOut` sits well under
 * `expected*(1 - slipBps)`. That is on the SAFE side (it can only relax the floor, never
 * false-revert a wei-exact fill), but it means the internal floor guards against a GROSS
 * shortfall, not a tight `slipBps` band, UNLESS a net-cache window is shipped (then the walk
 * extends across the windowed boundaries and the estimate tightens). Integrators wanting a tight
 * whole-trade minimum should enforce their own around cook() (or pass an explicit `opts.minOut`).
 */
import type { EcoSwapPrepared } from "../shared/types.js";
/**
 * LOWER-BOUND estimate of the whole-trade tokenOut the split produces for `amountIn`.
 * Returns 0n when nothing is estimable (no direct pools + no sampled venues) — then the
 * floor is disabled (minOut 0), which is the safe default.
 */
export declare function estimateExpectedOutput(prepared: EcoSwapPrepared, amountIn: bigint): bigint;
//# sourceMappingURL=expected-output.d.ts.map