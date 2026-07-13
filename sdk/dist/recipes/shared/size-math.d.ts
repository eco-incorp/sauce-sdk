/**
 * INTEGRAL SIZE (integral.link TwapRelayer — instant swaps from RELAYER-HELD inventory at the
 * Uniswap-V3-TWAP price, VERIFIED source: IntegralHQ/Integral-SIZE-Smart-Contracts TwapRelayer.sol)
 * — QUOTE-LADDER (QL) model over the relayer's LIVE `quoteSell` view, WITH THE [min, cap] OUT-WINDOW
 * the ladder grid must respect (the family's twist: the LOW end of the quote domain ALSO reverts).
 *
 * THE SINGLE SOURCE for how a SIZE venue is modeled off-chain. SIZE is a QUOTE-LADDER family
 * (segKind 19): prepare ships ONLY a descriptor (relayer, fromToken, toToken) — NO sampled segments
 * — and the on-chain solver builds the venue's ladder in setup from LIVE cook-time
 * `relayer.quoteSell(tokenIn, tokenOut, xNext)` quote-differencing (the SAME curve-agnostic
 * `buildQLLadder` recurrence every other QL family runs), with ONE extra per-venue prelude step: the
 * WINDOW hoist (below). The neutral oracle (ecoswap.optimal.ts) mirrors it via `buildSizeQLLadder`,
 * driven by a caller-supplied `getDy` quote model + the SAME live-derived `minIn` seed floor, so
 * solver == oracle by construction — one recurrence, one grid, one floor.
 *
 * REAL ON-CHAIN SURFACE (re-probed live on Ethereum block ~25.46M + Arbitrum block ~480.36M,
 * 2026-07-04; proxies with VERIFIED implementations; fork-EXECUTED from a random EOA):
 *
 *   TwapRelayer proxy — Ethereum 0xd17b3c9784510E33cD5B87b490E79253BcD81e2E (impl 0xaf780de0…),
 *   Arbitrum 0x3c6951FDB433b5b8442e7aa126D50fBFB54b5f42 (per the official deployment, verified live:
 *   quoteSell USDC→WETH 6000e6 → 3.3527e18 at probe):
 *
 *     quoteSell(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)
 *       — sel 0x9981d632. Nets swapFee[pair] off amountIn, prices the remainder at the pair's
 *       Uniswap-V3 TWAP (ITwapPair.oracle() → getAveragePrice via IUniswapV3Pool.observe), then
 *       `checkLimits(tokenOut, amountOut)`:
 *           require(amountOut >= getTokenLimitMin(tokenOut), 'TR03')        ← the LOW-end revert
 *           require(amountOut <= balanceOf(relayer, tokenOut) * getTokenLimitMaxMultiplier(tokenOut)
 *                   / 1e18, 'TR3A')                                          ← the inventory cap
 *       THE WINDOW IS ON THE OUT AMOUNT (probed: WETH→USDC 2e18 → ~3580 USDC < the 5000e6 USDC min
 *       → TR03 even though 2e18 ≫ the WETH min — the min is NOT on amountIn). Other revert classes:
 *       TR24 zero amount, TR17 no factory pair, TR5A pair disabled. STATICCALL-safe (a plain
 *       verified view). So the per-slice quote is PROBE-THEN-DECODE with reverts on BOTH ends of
 *       the domain.
 *
 *     quoteBuy(address tokenIn, address tokenOut, uint256 amountOut) view returns (uint256 amountIn)
 *       — sel 0x34259b1b; checkLimits(tokenOut, amountOut) then inverts the TWAP price and
 *       CEIL-divides the fee gross-up, so quoteSell(quoteBuy(minOut)) >= minOut ALWAYS (probed:
 *       quoteBuy(USDC, WETH, 1.2e18) = 2148.02e6; quoteSell at it = 1.20000000076e18 >= min;
 *       at −1e6 → TR03). THE WINDOW HOIST: the venue prelude reads
 *       minOut = getTokenLimitMin(tokenOut) then minIn = quoteBuy(tokenIn, tokenOut, minOut) — the
 *       EXACT lowest quotable input — and RAISES THE LADDER SEED to it (see the seed floor below).
 *
 *     getTokenLimitMin(address) view (pure config; ETH: WETH 1.2e18, USDC/USDT 5000e6, WBTC 7e6;
 *     ARB: WETH 4e16, USDC/USDC.e/USDT 100e6) + getTokenLimitMaxMultiplier(address) view (0.95e18
 *     both chains) — the window parameters.
 *
 *     sell(SellParams{address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin,
 *          bool wrapUnwrap, address to, uint32 submitDeadline}) payable returns (uint256 orderId)
 *       — sel 0x58d30ac9. PERMISSIONLESS approve-first: transferIn pulls EXACTLY amountIn from
 *       msg.sender (to the TwapDelay address — the relayer's hedge queue), pays the quoted out from
 *       relayer inventory to `to` (transferOut re-runs checkLimits — the SAME window binds at exec,
 *       so a SUB-MIN AWARD REVERTS TR03 AT EXEC: the exec arm MUST probe-quote first and soft-skip),
 *       and enqueues the relayer's own hedge order (prepay paid from the RELAYER's ETH balance —
 *       msg.value MUST be 0 for a non-wrap sell, TR58). Constraints probed: `to` must not be
 *       tokenIn/tokenOut/0 (TR26 — the cooking contract is fine); submitDeadline is uint32 and
 *       uint32-max IS accepted (fork-proven; the recipe passes 2^32−1). FORK-PROVEN WEI-EXACT:
 *       sell(6000 USDC→WETH) from a random EOA pulled EXACTLY 6000e6, received == same-block
 *       quoteSell to the wei, allowance residue == 0. PULL == APPROVE ALWAYS (transferIn moves the
 *       full amountIn; no partial-fill path exists in the verified source) ⇒ NO allowance-residue
 *       path (asserted anyway by the residue==0 test cells).
 *
 * ── THE WINDOW/GRID DESIGN (what this family adds to the shared ladder) ────────────────────────────
 * A plain QL grid seeds at amountIn/16; when that first slice quotes BELOW the out-min the probe
 * reverts TR03 and the ladder would be EMPTY even though the full amountIn is quotable. The fix is a
 * SEED FLOOR, hoisted LIVE per venue (live-walk charter — the descriptor carries no cached window):
 *     minOut = getTokenLimitMin(tokenOut)            (1 staticcall, probe-then-decode)
 *     minIn  = quoteBuy(tokenIn, tokenOut, minOut)   (1 staticcall, probe-then-decode — REVERTS
 *              TR3A when even the min exceeds the live inventory cap ⇒ floor stays 0 and the
 *              first slice quote reverts ⇒ a zero ladder, the venue self-drops)
 *     seed   = max(amountIn/QL_SEED_DIV, minIn)      (the buildQLLadder seedFloor parameter)
 * The geometric recurrence is otherwise UNCHANGED (xNext = cum·5/4 + seed, clamped at amountIn), so
 * the oracle mirrors it with the same floor value. Consequences, all by construction:
 *   · amountIn < minIn ⇒ the single grid point is amountIn ⇒ TR03 ⇒ zero ladder (venue self-drops);
 *   · quotes past the inventory cap revert TR3A ⇒ the ladder truncates at the last in-window point;
 *   · the ladder's slices are all ≥ minIn deep in cumulative terms, so a full-slice award is always
 *     executable.
 * SUB-MIN AWARD GUARD (the merge can still award a PARTIAL first slice < minIn when the global
 * budget exhausts mid-slice): the exec arm re-quotes quoteSell(share) PROBE-THEN-DECODE — a TR03/
 * TR3A/TR5A revert SOFT-SKIPS the venue (the share strands in tokenIn and the terminal refund
 * returns it; never a cook DoS). The refund preserves funds; the oracle-parity cells size trades so
 * awards land on whole slices, and the dedicated sub-min edge cell pins the refund behavior.
 *
 * ── COUPLING CAVEAT (documented, not a code path) ─────────────────────────────────────────────────
 * The TWAP price reads the pair's configured Uniswap-V3 pool via observe(); a cook that ALSO swaps
 * that exact V3 pool before the SIZE exec shifts the current-block interpolated observation by a few
 * wei. The exec re-quotes LIVE and uses the fresh quote as both amountOutMin and the expected out,
 * so the pair is internally coherent (never a revert); only the merge-time ladder would be a few wei
 * stale — the standard live-walk drift class, covered by the drift re-anchor cells.
 *
 * SINGLE-CONTRACT MULTI-PAIR INVENTORY (the claims shape): ONE relayer holds EVERY pair's inventory
 * (WETH+USDC+USDT out of one contract), so the claim key is the RELAYER ADDRESS (the Tessera/Elfomo
 * wrapper class) — one SIZE venue per cook, so two pairs can never double-count the shared
 * inventory.
 */
import type { Hex } from "viem";
import type { MergeSegment } from "./segment-merge.js";
/** SIZE fee scale — swapFee[pair] is 1e18-PRECISION-scaled in the source; the diagnostic feePpm is 1e6. */
export declare const SIZE_FEE_SCALE: bigint;
/** TwapRelayer PRECISION (swapFee / limitMaxMultiplier scale). */
export declare const SIZE_PRECISION: bigint;
/** The sell() submitDeadline the exec passes — uint32 max (fork-proven accepted). */
export declare const SIZE_DEADLINE_U32: bigint;
/**
 * One SIZE venue DESCRIPTOR (the chain's TwapRelayer, oriented for the swap). This is ALL prepare
 * ships — the on-chain solver hoists the LIVE [min, cap] window per venue (getTokenLimitMin +
 * quoteBuy → the seed floor) and builds the ladder LIVE from quoteSell at cook. `minIn`/`minOut`
 * are the DISCOVERY-TIME window reads — diagnostics + test plumbing ONLY (the solver re-hoists the
 * window live at cook; the live-walk charter forbids trusting a prepare-time min).
 */
export interface SizeVenue {
    /** The TwapRelayer proxy — the quoteSell/quoteBuy/sell/approve target + the claim key (single-contract multi-pair). */
    address: Hex;
    /** The venue's tokenIn (the edge from-token; the quoteSell/sell `tokenIn` arg). */
    tokenIn: Hex;
    /** The venue's tokenOut (the edge to-token). */
    tokenOut: Hex;
    /** Discovery-time getTokenLimitMin(tokenOut) — the out-window low end (diagnostics; the solver re-reads live). */
    minOut: bigint;
    /** Discovery-time quoteBuy(tokenIn, tokenOut, minOut) — the lowest quotable input (diagnostics; re-hoisted live). */
    minIn: bigint;
    /** swapFee[pair] converted to ppm (1e6) at discovery — price-ordering diagnostics (the quote is post-fee). */
    feePpm: number;
    /** Discovery source label. */
    source: string;
}
/**
 * The ORACLE/REFERENCE model of one SIZE venue: the descriptor plus a `getDy` QUOTE model — the out
 * that `relayer.quoteSell(tokenIn, tokenOut, dx)` returns for total input `dx` — plus the LIVE
 * `minIn` seed floor the solver's window hoist derives (the oracle must be given the SAME live
 * value: a fixture closed form locally, the etched relayer's own quoteBuy read in the prod-mirror).
 * `getDy` must return 0 where the real view reverts (below the out-min TR03, above the inventory
 * cap TR3A, disabled pair TR5A, zero amount TR24) — the ladder then self-truncates in lockstep with
 * the on-chain probe-then-decode build.
 */
export interface SizePool extends SizeVenue {
    /** Cumulative quote model: out for TOTAL input dx (post-fee, TWAP-priced; 0 ⇒ out-of-window/unquotable). */
    getDy: (dx: bigint) => bigint;
    /** The LIVE seed floor (quoteBuy(tokenIn, tokenOut, getTokenLimitMin(tokenOut))); 0 ⇒ no floor (dead/uncapped). */
    liveMinIn: bigint;
}
/**
 * Build one SIZE venue's QUOTE-LADDER — the SHARED `buildQLLadder` recurrence with the venue's LIVE
 * `minIn` as the SEED FLOOR (the window design above), driven by the venue's `getDy` quote model, so
 * the oracle stays wei-exact with the on-chain solver by construction. The solver builds the
 * IDENTICAL floored geometric ladder live from `quoteSell(tokenIn, tokenOut, xNext)`
 * (PROBE-THEN-DECODE — TR03/TR3A/TR5A/TR24 revert ⇒ q = 0 ⇒ the ladder self-truncates). The quote
 * is post-fee so marginalOI IS the execution price.
 */
export declare function buildSizeQLLadder(pool: SizePool, amountIn: bigint): MergeSegment[];
//# sourceMappingURL=size-math.d.ts.map