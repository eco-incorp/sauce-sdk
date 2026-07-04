/**
 * ElfomoFi (a vault-funded PMM priced by an on-chain pricing module) — QUOTE-LADDER (QL) model over the
 * wrapper's LIVE getAmountOut quote.
 *
 * THE SINGLE SOURCE for how an ElfomoFi venue is modeled off-chain. Elfomo is a QUOTE-LADDER family
 * (segKind 16): prepare ships ONLY a descriptor (wrapper address, tokenIn, tokenOut, fee) — NO sampled
 * segments — and the on-chain solver builds each venue's price ladder in setup from LIVE cook-time
 * `getAmountOut(tokenIn, tokenOut, xNext)` quote-differencing (the SAME curve-agnostic `buildQLLadder`
 * recurrence every other QL family runs). The neutral oracle (ecoswap.optimal.ts) and the cursor-faithful
 * reference mirror it via `buildElfomoQLLadder` below, driven by a caller-supplied `getDy` quote model
 * (a bit-exact fixture replay in the local tests; a prefetched real-wrapper quote grid in the
 * prod-mirror), so solver == oracle by construction — one recurrence, one grid.
 *
 * REAL ON-CHAIN SURFACE (VERIFIED on Base blockscout — ElfomoFi, Solidity 0.8.30; SAME address on
 * Base + BSC: 0xf0f0F0F0FB0d738452EfD03A28e8be14C76d5f73). The wrapper holds an IMMUTABLE pricing module
 * (an EIP-1967 proxy) + an IMMUTABLE vault; the pricing module prices off a continuously-published
 * oracle feed + the vault's live inventory:
 *   getAmountOut(address fromToken, address toToken, uint256 fromAmount) view returns (uint256 toAmount)
 *     — the exact-in quote (+ a getAmountIn inverse). GRACEFUL single-return (the WOOFi-tryQuery /
 *       Fluid-resolver class — probed live on Base 2026-07-04): an unsupported pair returns 0, a zero
 *       amount returns 0, a STALE oracle returns 0, and an oversized amount returns a real (collapsing-
 *       marginal) quote. So the QL quote is ONE plain staticcall per slice, q == 0 ⇒ stop — no
 *       probe-then-decode `.catch` needed.
 *   getSupportedPairs() view returns (address[2][]) — pair ENUMERATION (the natural discovery surface;
 *       a listed [tokenA, tokenB] pair quotes in BOTH directions — verified live both ways).
 *   swap(address fromToken, address toToken, int256 specifiedAmount, uint256 limitAmount,
 *       address receiver, uint256 partnerId)
 *     — the exec: positive specifiedAmount = exact input; the wrapper re-quotes via the pricing module,
 *       requires toAmount > 0 (ExecutionFailed) and toAmount >= limitAmount (InsufficientAmount), calls
 *       pricing.update(...) (quote bookkeeping), transferFrom's toToken from the VAULT to the receiver
 *       and PULLS fromToken from msg.sender via allowance (approve-first, like Fermi/Tessera/Wombat —
 *       NOT transfer-first like WOOFi). partnerId 0 = no partner. PERMISSIONLESS (verified source + an
 *       executed fork swap; same-tx quote+swap proven WEI-EXACT: quoted == received, and gas-price
 *       INSENSITIVE at 1 vs 5 gwei).
 *
 * ORACLE-STALENESS CUTOFF (fork-measured — the ONE fixture/prod-mirror constraint): the pricing module
 * reads its feed's `timestamp()` and HARD-ZEROES the quote once the feed is stale — quotes were flat at
 * +0..2 s extra staleness, decayed at +5 s and ZERO by +30 s on a frozen fork. On a live chain the
 * publisher updates every block or two, so the venue is continuously quotable; a frozen fork/prod-mirror
 * MUST pin block.timestamp to (captured feed timestamp + ≤2 s) — the graceful 0 means a stale venue
 * self-drops from the ladder (never a cook DoS). The measured decay is exogenous drift protection, not a
 * sender/gas-price gate (quotes and swaps are sender- and gas-price-insensitive; probed both).
 *
 * ON-CHAIN EXECUTION is CALLBACK-FREE (`swapWithCallback` exists but is NOT used; the taker path never
 * re-enters the cooking contract): the solver re-reads the out for the awarded share LIVE via
 * `getAmountOut(tokenIn, tokenOut, share)` (a plain staticcall, used as limitAmount), APPROVES the
 * wrapper for the input, then calls `swap(tokenIn, tokenOut, +share, limitAmount, self, 0)` — the
 * limit never trips when the state is unchanged (same-tx quote+swap proven wei-exact on the real Base
 * wrapper), and the whole-trade cfg[9] floor + terminal refund guard the exogenous residual.
 *
 * WEI-EXACTNESS CLASS — LIVE-WALK (the strongest): the ladder is built from LIVE cook-time quotes, so
 * the split RE-ANCHORS to any oracle move / vault-inventory change between prepare and cook, exactly
 * like every other QL family (the vault cap is folded into the quote — an over-inventory ask quotes a
 * collapsed marginal, and the non-descending-head guard truncates the ladder).
 *
 * SINGLE-CONTRACT MULTI-PAIR INVENTORY: ONE wrapper serves every supported pair out of ONE vault, so the
 * descriptor is (wrapper, tokenIn, tokenOut) and the claim key is the WRAPPER ADDRESS — see prepare.ts
 * qlVenueClaimKey (the multi-coin rule: at most one Elfomo instance per cook, so one inventory is never
 * priced twice).
 *
 * Sources (VERIFIED):
 *   ElfomoFi 0xf0f0F0F0FB0d738452EfD03A28e8be14C76d5f73 (Base blockscout verified; same address BSC)
 *   pricing proxy (Base) 0xFFFFffBB2D432B8ACb4c57d556C0C721A431d038 → impl 0x00E36cE204203c02a8FA18FC1cBc3818B938FbD9 (unverified impl)
 *   oracle feed (Base) 0xf9b0c8Ee13AE2fC0665764ecbdB417685dEa8081 (timestamp() staleness source)
 *   vault (Base) 0xBb1b19F138dB3925883a96FF7a304277460E0C99 (holds the payout inventory + allowance)
 */

import { buildQLLadder } from "./curve-math.js";
import type { MergeSegment } from "./segment-merge.js";

/** Elfomo fee scale — feePpm is 1e6-scaled (derived from the liveness probe; no fee getter exists). */
export const ELFOMO_FEE_SCALE = 10n ** 6n;

/**
 * One ElfomoFi venue DESCRIPTOR (the wrapper + a direct tokenIn→tokenOut leg), oriented for the swap.
 * This is ALL prepare ships (the QL family contract: descriptor-only, zero sampled values) — the
 * on-chain solver builds the ladder LIVE from getAmountOut at cook.
 */
export interface ElfomoVenue {
  /** Wrapper (ElfomoFi) address — the getAmountOut / swap / approve target. */
  address: `0x${string}`;
  /** The venue's tokenIn (the from-token the swap call needs) == the (edge) tokenIn. */
  tokenIn: `0x${string}`;
  /** The venue's tokenOut (the to-token the swap call needs) == the (edge) tokenOut. */
  tokenOut: `0x${string}`;
  /**
   * Effective per-venue fee in ppm, DERIVED from the liveness probe for price-ordering / diagnostics
   * only (the pricing module folds everything into the quote — there is no fee getter). 0 when unknown.
   */
  feePpm: number;
  /** Discovery source label. */
  source: string;
}

/**
 * The ORACLE/REFERENCE model of one Elfomo venue: the descriptor plus a `getDy` QUOTE model — the
 * cumulative `getAmountOut(tokenIn, tokenOut, dx)` out for total input `dx`. Elfomo has NO off-chain
 * closed form (the pricing module + its feed are private), so the model is caller-supplied:
 *   - the local EVM tests replay the ElfomoFi.sol fixture math bit-for-bit, and
 *   - the prod-mirror prefetches the REAL etched wrapper's quotes at the DETERMINISTIC direct-venue QL
 *     grid (`elfomoQLGridInputs`) and answers by exact-point lookup.
 * `getDy` must return 0 where the real view quotes 0 (unsupported/stale), so the ladder self-truncates
 * in lockstep with the on-chain build (the graceful single-return class).
 */
export interface ElfomoPool extends ElfomoVenue {
  /** Cumulative quote model: out for TOTAL input dx (post-fee + post-staleness; 0 ⇒ not fillable). */
  getDy: (dx: bigint) => bigint;
}

/**
 * The DETERMINISTIC cumulative input grid the QL recurrence quotes at for a ladder capped at `cap`.
 * An early `q == 0` / non-descending stop consumes a PREFIX of this grid, so prefetching quotes at
 * exactly these points fully covers every `getDy` the ladder build can ask for. Used by the
 * prod-mirror (which has no closed form) to prefetch the REAL wrapper's quotes; for a DIRECT venue
 * `cap == amountIn`. This IS `qlLadderInputs` (curve-math.ts) — the same grid the Fluid/Tessera/Mento
 * prod-mirrors prefetch at — re-exported under the Elfomo name for the prefetch contract's readability.
 */
export { qlLadderInputs as elfomoQLGridInputs } from "./curve-math.js";

/**
 * Build one Elfomo venue's QUOTE-LADDER — the SHARED curve-agnostic `buildQLLadder` recurrence
 * (curve-math.ts) driven by the venue's `getDy` quote model, so the oracle stays wei-exact with the
 * on-chain solver by construction. The solver builds the IDENTICAL geometric ladder live from
 * `getAmountOut(tokenIn, tokenOut, xNext)` (a GRACEFUL plain single-return staticcall — 0 on an
 * unsupported pair / stale feed ⇒ the ladder self-truncates, the WOOFi-tryQuery class, with NO
 * probe-then-decode). The quote is post-fee (the pricing module folds everything in) so marginalOI IS
 * the execution price. Emits the same {capacity, effOut, marginalOI} slices the merged sampled-segment
 * stream consumes.
 */
export function buildElfomoQLLadder(pool: ElfomoPool, amountIn: bigint): MergeSegment[] {
  return buildQLLadder((dx) => pool.getDy(dx), amountIn);
}
