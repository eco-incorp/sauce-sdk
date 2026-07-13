/**
 * METRIC (metric.xyz — an oracle-anchored bin-curve OMM: per-pair pools quoted off a maker-posted
 * PriceProvider anchor) — QUOTE-LADDER (QL) model over the Router's LIVE `quoteSwap` view.
 *
 * THE SINGLE SOURCE for how a Metric venue is modeled off-chain. Metric is a QUOTE-LADDER family
 * (segKind 17): prepare ships ONLY a descriptor (pool, provider, router, xToY, feePpm) — NO sampled
 * segments — and the on-chain solver builds each venue's price ladder in setup from LIVE cook-time
 * `Router.quoteSwap(pool, xToY, +xNext, limit, bid, ask)` quote-differencing (the SAME curve-agnostic
 * `buildQLLadder` recurrence every other QL family runs), with `(bid, ask)` HOISTED ONCE per venue from
 * the pool's own PriceProvider (`getBidAndAskPrice()`) in the venue prelude — the TWO-STEP quote that
 * distinguishes Metric from the single-view families (the BalV2 state-read-hoist shape). The neutral
 * oracle (ecoswap.optimal.ts) mirrors it via `buildMetricQLLadder` below, driven by a caller-supplied
 * `getDy` quote model (a bit-exact fixture replay in the local tests; a prefetched real-router quote
 * grid at the frozen etched bid/ask in the prod-mirror), so solver == oracle by construction — one
 * recurrence, one grid.
 *
 * REAL ON-CHAIN SURFACE (probed live on Base 2026-07-04; ALL contracts UNVERIFIED on Basescan and
 * Blockscout — bytecode-level verification only, which is why the prod-mirror etches the genuine
 * runtime; addresses re-derived from the metric.xyz metadata API + selector-resolved via openchain):
 *
 *   PriceProvider.getBidAndAskPrice() view returns (uint128 bid, uint128 ask)
 *     — the maker-posted oracle anchor in X64 fixed-point (price = value / 2^64, decimal-adjusted:
 *       ~1765 USDC/WETH quoted as ≈1765·2^64 on the 18/6-dec Base pair). PER POOL: two same-pair pools
 *       can share one provider or carry their own. STALENESS-REVERT class: the provider REVERTS custom
 *       error 0x9a0423af when the maker's off-chain post is older than MAX_TIME_DELTA (10 s on the Base
 *       WETH/USDC provider — measured by anvil-fork time warp: fresh at the fork instant, reverting at
 *       +30 s and +2 h), and it also runs Chainlink cross-checks (setClOracle feeds, maxClDeviation =
 *       100 bps, sequencerUptimeFeed + GRACE_PERIOD 3600 s, FUTURE_TOLERANCE) that can revert
 *       independently. So the venue-prelude hoist is PROBE-THEN-DECODE: a stale/paused provider zeroes
 *       the hoisted anchor and the venue self-drops (a zero ladder), never a cook DoS.
 *
 *   Router.quoteSwap(address pool, bool xToY, int128 amountSpecified, uint128 priceLimit,
 *       uint128 bid, uint128 ask) returns (int256 amount0Delta, int256 amount1Delta)
 *     — selector 0x89aad153. Wraps the pool's own revert-carrying quote fn (0x43e280d4, the Uniswap
 *       Quoter pattern: the pool WRITES then REVERTS with the result, the router catches + decodes —
 *       recipe-invisible; the router returns cleanly). CONSEQUENCE (etched-graph-measured): the
 *       on-chain solver must call quoteSwap with a plain CALL, NOT a staticcall — under a static
 *       context the pool's pre-revert state write dies with a static-violation instead of the
 *       result-revert, the router's catch decodes garbage and the probe fails (the Fluid
 *       estimateSwapIn class; the recipe ABI marks quoteSwap nonpayable for exactly this). The write
 *       is rolled back by the pool's own revert, so the CALL is state-neutral; off-chain eth_call is
 *       not a static context, so discovery/prefetch reads are unaffected. The quote prices DIRECTLY off the CALLER-SUPPLIED (bid, ask) —
 *       verified: doubling both doubles the out — so the solver MUST thread the live provider anchor
 *       (the hoist above); the SWAP path re-reads the SAME provider in-tx, so quote and exec cohere by
 *       construction. SIGNED-DELTA convention (probed both directions): positive amountSpecified =
 *       exact-in; the IN-side delta returns POSITIVE (the amount actually CONSUMED — an OVERSIZED ask
 *       is PARTIAL-FILLED: 900 WETH in → (+87.94e18, −155.6e9), only the consumed input pulls), the
 *       OUT-side delta returns NEGATIVE (two's complement; take the absolute value): xToY ⇒
 *       (in = +amount0Delta, out = −amount1Delta), yToX ⇒ (in = +amount1Delta, out = −amount0Delta).
 *       Negative amountSpecified = exact-OUT (probed working; the recipe never uses it).
 *
 *       THE DIRECTIONAL PRICE LIMIT (the resolved reverse-direction convention — the prior probe's
 *       (0,0) was a wrong-side limit, not a broken direction): `priceLimit` bounds the post-swap
 *       price on the X64 anchor grid, Uniswap-style. xToY moves the price DOWN ⇒ the limit must sit
 *       BELOW the current price (0 = unbounded); yToX moves it UP ⇒ the limit must sit ABOVE
 *       (type(uint128).max = unbounded). A wrong-side limit returns (0, 0) GRACEFULLY (both probed);
 *       an EMPTY pool also quotes (0, 0) gracefully (probed on the zero-inventory Base pool). The
 *       quote REVERTS (a typed router error 0x90bfb865 wrapping the pool reason) on garbage anchors —
 *       bid > ask ("Mnfl") or zero bid/ask — so the per-slice quote is PROBE-THEN-DECODE (the Fermi
 *       class), decoding the negative out-delta, q == 0 ⇒ stop.
 *
 *   Router.swapExactInput(address pool, address recipient, bool xToY, uint128 amountIn,
 *       uint128 priceLimit, uint256 minAmountOut, uint256 deadline)
 *     — selector 0x4a878c1c (signature confirmed by decoding a live Base tx AND by fork execution).
 *       PERMISSIONLESS approve-first: the caller approves the ROUTER for tokenIn; the pool pays the
 *       OUT to `recipient` FIRST, then re-enters `metricOmmSwapCallback(int256,int256,bytes)` on the
 *       ROUTER (msg.sender of the pool call), which pulls tokenIn from the payer via transferFrom —
 *       THE ROUTER IMPLEMENTS THE CALLBACK ITSELF (selector 0xc3251075 in its dispatch table), so the
 *       engine needs ZERO callback work and the recipe path is CALLBACK-FREE from the cooking
 *       contract's perspective. `minAmountOut` is enforced as InsufficientOutput(actual, min)
 *       (0x2c19b8b8, fork-proven at quote+1); `deadline` is a unix timestamp (block.timestamp bound;
 *       the exec passes a far-future constant). Fork-proven WEI-EXACT both directions from a random
 *       EOA: same-block quoteSwap out == realized balance delta, and an OVERSIZED amountIn pulls only
 *       the quoted consumed input (partial fill; quote and swap agree to the wei).
 *
 *   Pool.getImmutables() — word [1] = the pool's PriceProvider, [2] = token0 (X), [3] = token1 (Y)
 *       (word [0] = the protocol config/fee contract). The exec DERIVES direction + provider on-chain
 *       from this (the Fluid derive-don't-trust rule), so a route-leg venue is edge-correct with zero
 *       extra stamping. Pools emit Swap(sender, recipient, bool exactInput, int128 amount0Delta,
 *       int128 amount1Delta, int16 newTick, uint104 newPositionInBin) — the bin-curve state moves with
 *       fills, so quotes are pool-state-dependent (drift-testable), anchored to the provider price.
 *
 * NO ON-CHAIN ENUMERATION (the resolved discovery question): getImmutables()[0] is a protocol
 * config/fee-collection contract (owner/protocolFee/collectTokens/poolDeployer — selector-resolved),
 * and its poolDeployer() exposes only a deploy entrypoint + a parameters view — NO pool count, NO
 * pool-by-index, NO pair→pool getter on either. The pool list is published off-chain
 * (api.metric.xyz/{chain}/metadata — token-gated), so discovery is KNOWN-POOL-ADDRESS config (the
 * BalancerV3/Fluid/EulerSwap pattern): `FactoryConfig.metricPools` + the per-config
 * `FactoryConfig.metricRouter` (Base runs TWO routers, each serving a disjoint pool set, so the
 * router is per-config, NOT chain-wide cfg; the descriptor carries it per venue).
 *
 * INT128 CLAMP (the resolved amountSpecified bound): amountSpecified is int128, so the ladder/exec
 * clamp the quote/swap amount at METRIC_INT128_MAX (2^127 − 1) before the call — the compiler encodes
 * uint256 args into narrower ABI slots by low-byte truncation, so an unclamped ≥ 2^127 value would
 * flip the sign / wrap silently. Above-clamp sizes behave like the oversize partial fill (the venue
 * caps; the ladder flatlines and stops); realistic trades never approach it.
 *
 * WEI-EXACTNESS CLASS — LIVE-WALK (the strongest): the ladder is built from LIVE cook-time quotes at
 * the LIVE hoisted anchor (no prepare-time snapshot survives into the split), so the split RE-ANCHORS
 * to any maker re-post AND any pool bin-state drift between prepare and cook, exactly like every other
 * QL family.
 *
 * PER-POOL INVENTORY (the claims shape — UNLIKE Tessera/Elfomo): every Metric pool is a per-pair
 * contract holding its OWN token0/token1 inventory (multiple same-pair pools coexist with distinct
 * makers/providers), so the claim key is the POOL ADDRESS — the qlVenueClaimKey default — and two
 * same-pair Metric pools are two independent venues competing in one merge.
 *
 * Sources (probed live on Base 2026-07-04, block ~48.19M; metadata via the DefiLlama-consumed API):
 *   Router (Base)   0xA6A16C00B7E9DBE1D54acEd7d6FE264fc4732eaF (+ 0x50Ef014e95D23b970b6AF711d882d33ae9B559C0)
 *   WETH/USDC pool  0x770004fE4411E42eA51a7fcAca32b267d791f3D4 (~110 WETH + ~155k USDC inventory)
 *   PriceProvider   0x69454A23b8106776B2b09fEcde04047f0d1f8f76 (MAX_TIME_DELTA=10 s, maxClDeviation=100,
 *                   GRACE_PERIOD=3600, Chainlink ETH/USD + USDC/USD + sequencer-uptime feeds traced)
 */
import type { Hex } from "viem";
import type { MergeSegment } from "./segment-merge.js";
/** Metric fee/spread scale — spread-derived feePpm is 1e6-scaled (no fee getter exists on the path). */
export declare const METRIC_FEE_SCALE: bigint;
/** The int128 clamp bound for quoteSwap/swapExactInput amount args (2^127 − 1; see the header). */
export declare const METRIC_INT128_MAX: bigint;
/** The unbounded DIRECTIONAL price limit for yToX (price rises ⇒ limit above; type(uint128).max). */
export declare const METRIC_LIMIT_MAX_U128: bigint;
/**
 * One Metric venue DESCRIPTOR (a per-pair pool + its provider + its router, oriented for the swap).
 * This is ALL prepare ships (the QL family contract: descriptor-only, zero sampled values) — the
 * on-chain solver hoists the provider anchor once per venue and builds the ladder LIVE from
 * Router.quoteSwap at cook.
 */
export interface MetricVenue {
    /** Pool address — the per-pair inventory contract (the quoteSwap/swapExactInput `pool` arg + the claim key). */
    address: Hex;
    /** The pool's PriceProvider — the venue-prelude getBidAndAskPrice() hoist target (qlv qd[6]). */
    provider: Hex;
    /** The pool's Router — the quoteSwap/swapExactInput/approve target (qlv qd[7]; per-pool, Base runs two). */
    router: Hex;
    /** Swap direction: true ⇔ tokenIn == the pool's token0 (X → Y; the quote/swap `xToY` bit, qd[1]). */
    xToY: boolean;
    /** The venue's tokenIn (the edge from-token; diagnostics — the quote keys on pool + xToY). */
    tokenIn: Hex;
    /** The venue's tokenOut (the edge to-token; diagnostics). */
    tokenOut: Hex;
    /**
     * Half the provider's relative bid/ask spread in ppm, DERIVED at discovery for price-ordering /
     * diagnostics only (the quote folds everything in — there is no fee getter). 0 when unknown.
     */
    feePpm: number;
    /** Discovery source label. */
    source: string;
}
/**
 * The ORACLE/REFERENCE model of one Metric venue: the descriptor plus a `getDy` QUOTE model — the
 * cumulative out (the ABSOLUTE value of the negative out-delta) that
 * `Router.quoteSwap(pool, xToY, +dx, limit, bid, ask)` returns for total input `dx` at the FROZEN
 * hoisted (bid, ask). Metric has NO public off-chain closed form (the pool bytecode is unverified),
 * so the model is caller-supplied:
 *   - the local EVM tests replay the MetricPool.sol fixture bin-curve bit-for-bit, and
 *   - the prod-mirror prefetches the REAL etched router's quotes at the DETERMINISTIC QL grid
 *     (`metricQLGridInputs`) with the etched provider's pinned (bid, ask) and answers by exact-point
 *     lookup.
 * `getDy` must return 0 where the real view reverts, quotes (0,0) (wrong-side limit / empty pool /
 * stale provider ⇒ the prelude zeroed the anchor) — the ladder then self-truncates in lockstep with
 * the on-chain probe-then-decode build. An OVERSIZED dx must return the PARTIAL-FILL out (the real
 * view's capped quote): the next grid point then quotes the same value, the differenced slice-out is
 * 0, and both ladders stop identically (at most one final slice carries capacity the pool cannot
 * absorb — the exec's partial fill pulls only the consumed input and the terminal refund returns the
 * rest, minAmountOut-guarded; the exec then RESETS the router allowance to 0, because a partial fill
 * leaves a residue approval on the shared cooking contract and a USDT-class tokenIn would revert the
 * NEXT cook's nonzero→nonzero approve).
 */
export interface MetricPool extends MetricVenue {
    /** Cumulative quote model: out for TOTAL input dx (post-fee, anchor-frozen; 0 ⇒ not fillable). */
    getDy: (dx: bigint) => bigint;
}
/**
 * The DETERMINISTIC cumulative input grid the QL recurrence quotes at for a ladder capped at `cap`.
 * An early `q == 0` / non-descending stop consumes a PREFIX of this grid, so prefetching quotes at
 * exactly these points fully covers every `getDy` the ladder build can ask for. Used by the
 * prod-mirror (which has no closed form) to prefetch the REAL router's quotes at the etched
 * provider's frozen (bid, ask); for a DIRECT venue `cap == amountIn`. This IS `qlLadderInputs`
 * (curve-math.ts) — the same grid the Fluid/Tessera/Elfomo prod-mirrors prefetch at — re-exported
 * under the Metric name for the prefetch contract's readability.
 */
export { qlLadderInputs as metricQLGridInputs } from "./curve-math.js";
/**
 * Build one Metric venue's QUOTE-LADDER — the SHARED curve-agnostic `buildQLLadder` recurrence
 * (curve-math.ts) driven by the venue's `getDy` quote model, so the oracle stays wei-exact with the
 * on-chain solver by construction. The solver builds the IDENTICAL geometric ladder live from
 * `Router.quoteSwap(pool, xToY, +min(xNext, METRIC_INT128_MAX), limit, bid, ask)` (PROBE-THEN-DECODE
 * — the view is revert-class on garbage anchors; a revert / a (0,0) / a flatlined partial-fill quote
 * ⇒ the ladder self-truncates), with (bid, ask) hoisted once per venue. The quote is post-fee (the
 * pool folds the spread/fee into the deltas) so marginalOI IS the execution price. Emits the same
 * {capacity, effOut, marginalOI} slices the merged sampled-segment stream consumes.
 *
 * The `getDy` input is CLAMPED at METRIC_INT128_MAX exactly like the solver clamps its quoteSwap
 * amount (the int128 encode bound), so oracle == solver stays term-by-term even for a grid point
 * past 2^127 (an amountIn > int128.max makes the top grid points clamp; the solver's quote then
 * flatlines and both ladders stop identically — pinned by the ≥2^127 clamp cell in
 * ecoswap.metric.evm.test.ts). Slice capacities stay on the UNCLAMPED grid on both sides.
 */
export declare function buildMetricQLLadder(pool: MetricPool, amountIn: bigint): MergeSegment[];
//# sourceMappingURL=metric-math.d.ts.map