/**
 * Tessera V (Wintermute's TesseraSwap wrapper + private engine — a treasury-funded proactive market
 * maker) — QUOTE-LADDER (QL) model over the wrapper's LIVE tesseraSwapViewAmounts quote.
 *
 * THE SINGLE SOURCE for how a Tessera venue is modeled off-chain. Tessera is a QUOTE-LADDER family
 * (segKind 15): prepare ships ONLY a descriptor (wrapper address, tokenIn, tokenOut, fee) — NO sampled
 * segments — and the on-chain solver builds each venue's price ladder in setup from LIVE cook-time
 * `tesseraSwapViewAmounts(tokenIn, tokenOut, +xNext)[1]` quote-differencing (the SAME curve-agnostic
 * `buildQLLadder` recurrence every other QL family runs). The neutral oracle (ecoswap.optimal.ts) and the
 * cursor-faithful reference mirror it via `buildTesseraQLLadder` below, driven by a caller-supplied `getDy`
 * quote model (a bit-exact fixture replay in the local tests; a prefetched real-wrapper quote grid in the
 * prod-mirror), so solver == oracle by construction — one recurrence, one grid.
 *
 * REAL ON-CHAIN SURFACE (VERIFIED on Base blockscout — TesseraSwap, Solidity 0.8.30; SAME address on
 * Base + BSC: 0x55555522005BcAE1c2424D474BfD5ed477749E3e). The wrapper is a thin shell over a PRIVATE
 * (unverified) engine (`ITesseraEngine.swapAmount/swapAmountView`) + a token treasury:
 *   tesseraSwapViewAmounts(address tokenIn, address tokenOut, int256 amountSpecified)
 *       view returns (uint256 amountIn, uint256 amountOut)
 *     — the SIGNED-amount quote (positive = exact tokenIn, negative = exact tokenOut; the propAMM taker
 *       convention Fermi also uses). REVERT-class: an unsupported pair reverts ("T33"), a zero amount
 *       reverts ("T10"), an engine pause would revert — while an OVERSIZED amount returns (amountIn, 0)
 *       gracefully (all probed live on Base 2026-07-04). So the QL quote is PROBE-THEN-DECODE (the
 *       Fermi class), decoding [1] (the exact-in out), with q == 0 ⇒ stop.
 *   tesseraSwapWithAllowances(address tokenIn, address tokenOut, int256 amountSpecified,
 *       uint256 amountCheck, address recipient, bytes swapData)
 *     — the exec: the engine computes (amountIn, amountOut), requires amountOut >= amountCheck ("ACF")
 *       for exact-in, then the wrapper transferFrom's tokenOut from the TREASURY to the recipient and
 *       PULLS tokenIn from msg.sender via allowance (approve-first, like Fermi/Wombat/Curve — NOT
 *       transfer-first like WOOFi). `swapData` is an opaque engine argument — empty bytes on the taker
 *       path (verified working with "" in live fork swaps). PERMISSIONLESS (proven by executed fork
 *       swaps from arbitrary senders).
 *
 * PRIORITY-FEE THRESHOLD (the ship-blocker question — ANSWERED, fork-measured 2026-07-04). The engine
 * exposes `globalPrioFeeThresholddd1337() = 2 gwei` and reads it inside BOTH the quote and the swap:
 *   · the SWAP NEVER REVERTS on gas price — same-tx quote+swap executed successfully at 1 / 2 / 2+1wei /
 *     5 / 50 gwei (legacy) with amountCheck == the just-quoted out, wei-exact every time;
 *   · the QUOTE may shift slightly across the threshold (an eth_call-context probe showed −0.23 bp above
 *     2 gwei; in-tx probes quoted identically) — an MEV-spread knob, not a gate;
 *   · quote and exec read the SAME tx.gasprice, so the recipe's same-tx live-quote-as-amountCheck exec is
 *     coherent AT ANY GAS PRICE by construction. NO discovery/exec gas-price guard is needed.
 *
 * GAS-AVAILABILITY GATE (fork-measured — the ONE integration constraint): the engine requires ~18.5M gas
 * AVAILABLE at the wrapper call (quote AND swap) and BURNS ALL FORWARDED GAS when starved (a probe at a
 * 18M tx limit consumed 16.9M and reverted; at 19M+ it succeeded using only ~1.46M total; the view alone
 * shows the same gate under eth_call gas caps). An anti-starvation / anti-partial-simulation measure.
 * Consequence: a cook whose universe carries a Tessera venue MUST run with a generous gas limit
 * (≥ ~25-30M headroom recommended); the QL ladder's probe-then-decode + the exec's probe-then-decode
 * degrade a starved venue to a zero ladder / skipped exec (funds returned by the terminal refund)
 * instead of bricking the cook — but a failed probe still burns 63/64 of the remaining gas, so headroom
 * is the real protection.
 *
 * STALENESS: the engine prices off its own posted state + a feed; quotes were measured FLAT under pure
 * block.timestamp drift for ≥ ~8.5 min on a frozen fork, with a ~1% penalty cliff appearing somewhere
 * past ~10 min. Live chains never get there (the maker re-posts continuously); the prod-mirror pins
 * block.timestamp near the captured state so quotes are deterministic.
 *
 * ON-CHAIN EXECUTION is CALLBACK-FREE (the wrapper's taker path never re-enters the cooking contract;
 * `tesseraSwapWithCallback` exists but is NOT used): the solver re-reads the out for the awarded share
 * LIVE via `tesseraSwapViewAmounts(tokenIn, tokenOut, +share)[1]` (probe-then-decode), APPROVES the
 * wrapper for the input, then calls `tesseraSwapWithAllowances(tokenIn, tokenOut, +share, amountCheck,
 * self, "")` with amountCheck == the live quote — it never trips when the state is unchanged (same-tx
 * quote+swap proven wei-exact on the real Base engine).
 *
 * WEI-EXACTNESS CLASS — LIVE-WALK (the strongest): the ladder is built from LIVE cook-time quotes (no
 * prepare-time snapshot survives into the split), so the split RE-ANCHORS to any maker re-post between
 * prepare and cook, exactly like every other QL family.
 *
 * SINGLE-CONTRACT MULTI-PAIR INVENTORY: ONE wrapper serves every supported pair out of ONE treasury, so
 * the descriptor is (wrapper, tokenIn, tokenOut) and the claim key is the WRAPPER ADDRESS — see
 * prepare.ts qlVenueClaimKey (the multi-coin rule: at most one Tessera instance per cook, so one
 * inventory is never priced twice).
 *
 * Sources (VERIFIED):
 *   TesseraSwap 0x55555522005BcAE1c2424D474BfD5ed477749E3e (Base blockscout verified; same address BSC)
 *   engine (Base) 0x31e99E05fee3DCE580af777C3fD63eE1B3B40c17 (unverified; globalPrioFeeThresholddd1337)
 *   treasury (Base) 0x3dBE077e7986657E95e1CC50089f17a5a4AF0AaE (holds the payout inventory + allowance)
 */

import { buildQLLadder } from "./curve-math.js";
import type { MergeSegment } from "./segment-merge.js";

/** Tessera fee scale — feePpm is 1e6-scaled (derived from the liveness probe; no fee getter exists). */
export const TESSERA_FEE_SCALE = 10n ** 6n;

/**
 * One Tessera V venue DESCRIPTOR (the wrapper + a direct tokenIn→tokenOut leg), oriented for the swap.
 * This is ALL prepare ships (the QL family contract: descriptor-only, zero sampled values) — the
 * on-chain solver builds the ladder LIVE from tesseraSwapViewAmounts at cook.
 */
export interface TesseraVenue {
  /** Wrapper (TesseraSwap) address — the viewAmounts / swapWithAllowances / approve target. */
  address: `0x${string}`;
  /** The venue's tokenIn (the from-token the swap call needs) == the (edge) tokenIn. */
  tokenIn: `0x${string}`;
  /** The venue's tokenOut (the to-token the swap call needs) == the (edge) tokenOut. */
  tokenOut: `0x${string}`;
  /**
   * Effective per-venue fee in ppm, DERIVED from the liveness probe for price-ordering / diagnostics
   * only (the engine folds everything into the quote — there is no fee getter). 0 when unknown.
   */
  feePpm: number;
  /** Discovery source label. */
  source: string;
}

/**
 * The ORACLE/REFERENCE model of one Tessera venue: the descriptor plus a `getDy` QUOTE model — the
 * cumulative `tesseraSwapViewAmounts(tokenIn, tokenOut, +dx)[1]` out for total input `dx`. Tessera has
 * NO off-chain closed form (the engine + its feed are private), so the model is caller-supplied:
 *   - the local EVM tests replay the TesseraSwap.sol fixture math bit-for-bit, and
 *   - the prod-mirror prefetches the REAL etched wrapper's quotes at the DETERMINISTIC direct-venue QL
 *     grid (`tesseraQLGridInputs`) and answers by exact-point lookup.
 * `getDy` must return 0 where the real view reverts or quotes 0 (unsupported/oversized), so the ladder
 * self-truncates in lockstep with the on-chain probe-then-decode build.
 */
export interface TesseraPool extends TesseraVenue {
  /** Cumulative quote model: out for TOTAL input dx (post-fee; 0 ⇒ not fillable). */
  getDy: (dx: bigint) => bigint;
}

/**
 * The DETERMINISTIC cumulative input grid the QL recurrence quotes at for a ladder capped at `cap`.
 * An early `q == 0` / non-descending stop consumes a PREFIX of this grid, so prefetching quotes at
 * exactly these points fully covers every `getDy` the ladder build can ask for. Used by the
 * prod-mirror (which has no closed form) to prefetch the REAL wrapper's quotes; for a DIRECT venue
 * `cap == amountIn`. This IS `qlLadderInputs` (curve-math.ts) — the same grid the Fluid/Mento/Fermi
 * prod-mirrors prefetch at — re-exported under the Tessera name for the prefetch contract's
 * readability.
 */
export { qlLadderInputs as tesseraQLGridInputs } from "./curve-math.js";

/**
 * Build one Tessera venue's QUOTE-LADDER — the SHARED curve-agnostic `buildQLLadder` recurrence
 * (curve-math.ts) driven by the venue's `getDy` quote model, so the oracle stays wei-exact with the
 * on-chain solver by construction. The solver builds the IDENTICAL geometric ladder live from
 * `tesseraSwapViewAmounts(tokenIn, tokenOut, +xNext)[1]` (PROBE-THEN-DECODE — the view is
 * revert-class; a revert or a 0 out ⇒ the ladder self-truncates). The quote is post-fee (the engine
 * folds everything in) so marginalOI IS the execution price. Emits the same {capacity, effOut,
 * marginalOI} slices the merged sampled-segment stream consumes.
 */
export function buildTesseraQLLadder(pool: TesseraPool, amountIn: bigint): MergeSegment[] {
  return buildQLLadder((dx) => pool.getDy(dx), amountIn);
}
