/**
 * LIQUIDCORE (Liquid Labs liquidcore.xyz — a HyperEVM oracle-priced RFQ-style pool set with 100%
 * protocol-owned liquidity, priced off the Hyperliquid L1 spot book via READ PRECOMPILES) —
 * QUOTE-LADDER (QL) model over each POOL's LIVE `estimateSwap` view.
 *
 * THE SINGLE SOURCE for how a LiquidCore venue is modeled off-chain. LiquidCore is a QUOTE-LADDER
 * family (segKind 18): prepare ships ONLY a descriptor (pool, fromToken, toToken) — NO sampled
 * segments — and the on-chain solver builds each venue's price ladder in setup from LIVE cook-time
 * `pool.estimateSwap(tokenIn, tokenOut, xNext)` quote-differencing (the SAME curve-agnostic
 * `buildQLLadder` recurrence every other QL family runs). The neutral oracle (ecoswap.optimal.ts)
 * mirrors it via `buildLiquidCoreQLLadder` below, driven by a caller-supplied `getDy` quote model
 * (a bit-exact fixture replay in the local tests; a prefetched real-pool quote grid in the
 * prod-mirror), so solver == oracle by construction — one recurrence, one grid.
 *
 * REAL ON-CHAIN SURFACE (re-probed live on HyperEVM chainId 999, block ~39.57M, 2026-07-04; router +
 * pools are upgradeable PROXIES — implementations bytecode-probed + selector-resolved via openchain;
 * fork-EXECUTED from a random EOA on an anvil fork of the public RPC):
 *
 *   Router 0x625aC1D165c776121A52ff158e76e3544B4a0b8B (proxy; impl 0x174034A1…):
 *     getPools() view returns (address[])            — 21 entries at probe (ONE zero entry to
 *       filter; 20 live per-pair pools). ON-CHAIN enumeration exists.
 *     getPoolForPair(address, address) view returns (address) — UNORDERED (both orders return the
 *       same pool; probed W,T0 == T0,W). ONE pool per pair ⇒ the router's estimateSwap forwards to
 *       exactly that pool: router quote == pool quote IDENTICAL (probed same-call-block). Discovery
 *       uses THIS (1 RPC per pair), the descriptor targets the POOL surface.
 *     getReserves(address, address) view returns (uint256, uint256) — pair reserves via the pool.
 *     estimateSwap / swap — the same surface as the pool (forwarded).
 *
 *   Pool (per-pair proxy; e.g. WHYPE/USDT0 0xA7478A5f…, ~893 WHYPE + ~2.8k USDT0 inventory):
 *     estimateSwap(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)
 *       — selector 0x3f2f869a. STATICCALL-SAFE (verified via a raw STATICCALL wrapper: the quote
 *       computes through the precompile reads with zero writes). REVERT classes (all probed):
 *       zero amount → 0x1f2a2005; an unsupported token pair on this pool → 0xc1ab6dc1 (the ROUTER
 *       wraps its own 0x9c754bc5 for an unknown pair); a DRAINED-output pool returns 0 GRACEFULLY;
 *       an OVERSIZED amount returns a CAPPED quote gracefully (the asymptotic imbalance-fee curve:
 *       1e24 WHYPE quoted ~2115 USDT0 against a 2.8k-USDT0 inventory — output-inventory-bounded,
 *       never a revert). So the per-slice quote is PROBE-THEN-DECODE (the Fermi class): a revert ⇒
 *       q = 0 ⇒ the ladder stops; a graceful 0 (drained) stops identically.
 *     swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut)
 *       returns (uint256) — selector 0xfe029156 (+ a 5-arg swap(..., bytes32 refCode) variant,
 *       0xd132a653 — the recipe uses the 4-arg form). PERMISSIONLESS — fork-executed from a random
 *       EOA; `isPublic() == false` does NOT gate swaps (probed: a direct pool.swap on the
 *       isPublic=false WHYPE/USDC pool SUCCEEDED — the flag gates LP deposits, not takers).
 *       APPROVE-FIRST: the pool pulls tokenIn from msg.sender via transferFrom and pays tokenOut to
 *       msg.sender. THE PULL IS ALWAYS THE FULL amountIn — even a capped-output OVERSIZED swap
 *       pulls 100% of the input (fork-proven: 5000 WHYPE in → 5000 pulled, capped 2154 USDT0 out,
 *       allowance residue == 0) — so pull == approve ALWAYS and there is NO allowance-residue path
 *       (asserted anyway by the residue==0 test cells). minAmountOut is enforced (revert 0x8199f5f3
 *       at quote+1, fork-proven).
 *     getTokens() view returns (address, address) — TWO addresses, NOT an array (raw-decoded).
 *     name()/getSpotPrices()/getPoolFees()/isPublic() — diagnostics (getSpotPrices REVERTS on a
 *       zero reserve; the recipe reads none of these on the hot path).
 *
 *   ORACLE PRICING — HYPERLIQUID READ PRECOMPILES (the reason local tests MUST mock them): a traced
 *   quote STATICCALLs the BBO precompile at 0x0000000000000000000000000000000000000814-family
 *   address 0x000000000000000000000000000000000000080e with a 32-byte SPOT-PAIR INDEX and reads
 *   back (uint bid, uint ask) — TWO words. The WHYPE/USDT0 pool reads TWO indexes per quote (10107
 *   = the HYPE book AND 10166 = the USDT0 book — it crosses both against USDC); the WHYPE/USDC pool
 *   reads ONE (10107). On a plain anvil fork the precompile address has no code (empty returndata ⇒
 *   the quote reverts), so the harness etches an INPUT-KEYED mock at the precompile address (slot
 *   2·idx = bid, 2·idx+1 = ask) — with the real chain's values mirrored, the fork quote equals the
 *   real quote EXACTLY (probed: WHYPE→USDC 70486500 == 70486500).
 *
 *   ADAPTIVE IMBALANCE FEES — the quote moves with pool balance AND block state (a cross-block
 *   re-quote differs by ~2e-5 with an unchanged book), so quote == execution ONLY same-block —
 *   exactly the live-walk charter: the ladder AND the exec quote run inside ONE cook tx, so the
 *   realized fill is wei-exact vs the in-tx quote by construction (fork-proven same-block).
 *
 * WEI-EXACTNESS CLASS — LIVE-WALK (the strongest): the ladder is built from LIVE cook-time quotes
 * (no prepare-time snapshot survives into the split), so the split re-anchors to any Hyperliquid
 * book move / inventory drift between prepare and cook, like every other QL family.
 *
 * PER-PAIR INVENTORY (the claims shape): every LiquidCore pool is a per-pair proxy holding its OWN
 * two-token inventory (getPoolForPair returns exactly one pool per pair), so the claim key is the
 * POOL ADDRESS — the qlVenueClaimKey default (the Metric class, NOT the Tessera/Elfomo single-
 * wrapper class).
 */
import { buildQLLadder } from "./curve-math.js";
/** LiquidCore fee scale — the diagnostic feePpm is 1e6-scaled (the quote is post-fee; no flat fee getter exists). */
export const LIQUIDCORE_FEE_SCALE = 10n ** 6n;
/** The HyperEVM BBO read-precompile address LiquidCore pools price off (input-keyed mock target in tests). */
export const HYPEREVM_BBO_PRECOMPILE = "0x000000000000000000000000000000000000080e";
/**
 * Build one LiquidCore venue's QUOTE-LADDER — the SHARED curve-agnostic `buildQLLadder` recurrence
 * (curve-math.ts) driven by the venue's `getDy` quote model, so the oracle stays wei-exact with the
 * on-chain solver by construction. The solver builds the IDENTICAL geometric ladder live from
 * `pool.estimateSwap(tokenIn, tokenOut, xNext)` (PROBE-THEN-DECODE — the view reverts on zero/
 * unsupported inputs and returns 0 on a drained pool; either way q = 0 ⇒ the ladder self-truncates).
 * The quote is post-fee (the pool folds the spread + adaptive imbalance fee into the out), so
 * marginalOI IS the execution price. Emits the same {capacity, effOut, marginalOI} slices the
 * merged sampled-segment stream consumes.
 */
export function buildLiquidCoreQLLadder(pool, amountIn) {
    return buildQLLadder((dx) => pool.getDy(dx), amountIn);
}
//# sourceMappingURL=liquidcore-math.js.map