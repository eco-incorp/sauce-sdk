/**
 * EcoSwap recipe entry point.
 *
 * Off-chain:  build each pool's per-pool NET CACHE (drift-invariant tick depth) +
 *             the static route segments.
 * On-chain:   ONE price-ordered merge where every pool walks a single frontier from
 *             its LIVE spot (reusing the cache for net), then one swap per pool (one
 *             per hop for routes) — equal post-fee marginal price = synchronized
 *             minimal slippage, no per-pool price-limit needed.
 */
import { type Hex } from "viem";
import { type EcoSwapPrepareOpts } from "./prepare.js";
import { type ChainPoolConfig } from "../shared/constants.js";
import { type EcoSwapConfig, type EcoSwapPrepared } from "../shared/types.js";
export interface EcoSwapOutput {
    bytecodes: Hex[];
    prepared: EcoSwapPrepared;
    source: string;
}
/**
 * Build the FLAT POOL UNIVERSE + the SCALAR ROUTING layout + the FULL qlv descriptor array
 * (direct QL rows THEN route-leg QL rows).
 *
 * The universe is `[...prepared.pools, ...legPools]`: every route-leg pool is APPENDED after
 * the direct pools, with each leg's pools laid CONTIGUOUSLY so a leg is a `[base, base+count)`
 * slice of universe indices. A pool that is ALSO a direct pool (same address) is DEDUPED to its
 * single direct-pool universe index (one shared frontier, seeded/stepped once) rather than
 * appended again — so a leg pool's universe index can point back into the direct-pool prefix.
 *
 * `buildPoolsAndNetCache` is reused VERBATIM over the assembled universe (a leg pool is
 * byte-identical to a direct pool on-chain), producing the `poolTuples`/`netCache` args.
 *
 * `routing` is one flat SCALAR tuple per route, depth-2 read on-chain, uniform 5-field stride:
 *   routing[r] = [legCount, {poolBase, poolCount, qlvBase, qlvCount, inter} × legCount]
 * where for leg L: pools are universe indices `[poolBase, poolBase+poolCount)` (rt[1+5L]/
 * rt[2+5L]; poolCount MAY be 0 for an all-QL leg), QL venues are GLOBAL qlv row indices
 * `[qlvBase, qlvBase+qlvCount)` (rt[3+5L]/rt[4+5L]; 0/0 for a pool-only leg — prepare emits
 * pool-only legs today), and `interL` (rt[5+5L]) is the INTERMEDIATE token AFTER leg L
 * (== legL.hopOut). The FINAL leg's `interL` is 0 (unused — its out is tokenOut). The derived
 * reads keep the old symmetry: legIn(L>0) = rt[5L], legOut(L<legCount−1) = rt[5+5L]. N-hop
 * needs no shape change.
 *
 * `directCount` = `prepared.pools.length` — how many leading universe entries are DIRECT venues
 * (the on-chain merge scans `[0, directCount)` as direct pools; entries `[directCount, …)` are
 * leg-only pools reached solely via `routing`). It is carried in the `cfg` bundle.
 *
 * `qlvRows` = [ALL direct rows (buildQLVenues, today's family-concatenation order), THEN one
 * 12-column row per route-leg QL venue] — leg rows are grouped contiguously per (route, leg)
 * and sorted (routeIdx asc, legIdx asc), each carrying qd[10]=routeIdx / qd[11]=legIdx and
 * refIdx (qd[5]) = its GLOBAL qlv index (informational — leg rows never touch the per-family
 * direct accumulators). `directQlvCount` = the direct-row prefix length, carried as cfg[12]:
 * the solver ladders/sorts ONLY rows [0, directQlvCount) into the direct merged stream.
 * The ORDERING CONTRACT is asserted below — the solver's msSorted machinery silently depends
 * on it (a violated order would let the direct-stream insertion sort scramble a leg venue's
 * contiguous ms-row region: silent corruption, the stride-change hazard class).
 *
 * Per-pool swap direction is derived on-chain from each pool tuple's `inIsToken0` field [7]
 * (== that pool's `zeroForOne`). A leg pool whose leg direction `zHop` differs from the route's
 * overall direction therefore needs [7] stamped with the LEG's `zHop` — done in prepare when the
 * leg pool's `EcoPool.inIsToken0` is set; the universe build does not re-derive it. Leg QL
 * venue descriptors are likewise direction-stamped for their EDGE pair in prepare/discovery.
 */
export declare function buildUniverseRoutingAndQlv(prepared: EcoSwapPrepared): {
    poolTuples: bigint[][];
    netCache: bigint[][];
    routing: bigint[][];
    directCount: number;
    qlvRows: bigint[][];
    directQlvCount: number;
};
/**
 * Compile-time protocol-presence defines for ecoswap.sauce.ts conditional compilation.
 *
 * Each HAS_* flag gates the per-protocol-SEPARABLE on-chain code (Curve/LB/DODO/Solidly/Kyber/
 * V2/V4/routes). Passed as `defines` with `treeshake:true` so a cook carries ONLY the protocols
 * its prepared universe actually contains — an all-UniV3 swap drops the Curve/Solidly/DODO/LB/
 * Kyber/route bytecode (and any helper reachable only from a dropped branch). The type-agnostic
 * k-way merge core + the live V3/V4 frontier walk are unguarded (always on), so there is no
 * HAS_V3 guard — V3 is the merge-core default path (HAS_V3 is still emitted for symmetry/clarity).
 *
 * SAFETY: a flag is `true` whenever the prepared data carries that protocol's pools/segments, so
 * live code is NEVER dropped. The `||`-over-legs/universe reductions default a flag to `true` if
 * the corresponding prepared field is present.
 */
export declare function protocolDefines(prepared: EcoSwapPrepared): Record<string, boolean>;
/**
 * Assemble the on-chain solver's compiler-arg array from a `prepared` universe — the SINGLE source
 * of truth for the `main(cfg, pools, netCache, routing, segs, qlv)` argument shape (6 top-level
 * args: the 13-scalar cfg bundle + the five nested tuple arrays; `segs` is the VESTIGIAL static
 * stream, always [] — see EMPTY_SEGS). `ecoSwap` feeds this straight into `compile()`; the
 * gas-measurement tests import it so their hand-fed args can never drift from the production shape
 * (the historical staleness this replaces). `minOut` is taken from `prepared` (0 on a
 * floor-disabled prepare); a read-only quote overrides cfg[9] to 0 separately. `qlv` carries the
 * direct rows THEN the route-leg rows ((routeIdx, legIdx)-ordered — asserted by the builder);
 * cfg[12] = directQlvCount marks the boundary.
 */
export declare function buildSolverArgs(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, prepared: EcoSwapPrepared): unknown[];
/**
 * Prepare and compile an EcoSwap.
 *
 * @param config - Swap configuration (tokenIn, tokenOut, amountIn)
 * @param rpcUrl - RPC URL for the chain
 * @param cookEntry - The engine cook() entrypoint the on-chain LENS read runs against —
 *   the SAME engine as the swap: the SauceRouter on v1, the owner's V12Pot on v12. The
 *   lens is engine-agnostic in VALUE; running it on the matched engine keeps prepare and
 *   the swap consistent. (`ecoSwap` only COMPILES the solver; the test/caller cooks it
 *   separately through this same cookEntry.)
 * @param caller - Address that will call cook() (for transferFrom). Also the lens-read
 *   account — required on v12 (the V12Pot.cook is owner-gated → must be the Pot owner).
 * @param poolConfig - Optional chain pool-discovery config (factories/fee tiers/
 *   base tokens). Omitted → prepareEcoSwap defaults to BASE_CHAIN_POOL_CONFIG,
 *   preserving prior behavior. Lets tests point discovery at local pools.
 * @param target - Bytecode target: "v1" (prefix, Solidity Router) or "v12" (postfix,
 *   Huff runtime). Default "v1". Selects BOTH the on-chain solver compilation AND the
 *   LENS read engine (the lens is now v12-native; it cooks on `cookEntry` as `target`).
 */
export declare function ecoSwap(config: EcoSwapConfig, rpcUrl: string, cookEntry: Hex, caller: Hex, poolConfig?: ChainPoolConfig, opts?: EcoSwapPrepareOpts & {
    solverFile?: string;
}, target?: "v1" | "v12"): Promise<EcoSwapOutput>;
/** ERC-20 storage layout: the slot of the `balanceOf` mapping and the `allowance` mapping. */
export interface Erc20Slots {
    /** Slot index of `mapping(address => uint256) balanceOf`. */
    balanceSlot: bigint;
    /** Slot index of `mapping(address => mapping(address => uint256)) allowance`. */
    allowanceSlot: bigint;
}
/** OZ-standard ERC20 layout (`_balances` slot 0, `_allowances` slot 1). */
export declare const OZ_ERC20_SLOTS: Erc20Slots;
export interface QuoteEcoSwapResult {
    /** Realized tokenOut the swap WOULD produce for `amountIn` (the quote). */
    amountOut: bigint;
    /** The prepared state used (pools + per-pool net caches, routes, route segments). */
    prepared: EcoSwapPrepared;
}
/**
 * 1-RPC EcoSwap QUOTE via eth_call state override (no on-chain solver change, no funding).
 *
 * Runs the SAME compiled, verified solver read-only through `cook()`, but injects the
 * caller's tokenIn balance + the cook-entry's allowance into the eth_call's `stateOverride`
 * — so `transferFrom` + the swaps execute call-locally (rolled back) and the solver's
 * returned tokenOut (`outBal`) is decoded as the quote. This is the agreed alternative to
 * a `quoteOnly` solver param, which is infeasible on v12 (a 10th scalar param overflows
 * the SDUP16 reference window, and bundling scalars into a cfg tuple multiplies live slots
 * across the solver's many tick staticcalls → frame-base MemoryOOG). The realized output is
 * STRICTLY BETTER than the `cum` the spec's quoteOnly would have returned.
 *
 * Works with NO prepared net cache: pass `opts.noBrackets = true` and each pool's window
 * bounds clear (windowTop=0), so the unified walk staticcalls every boundary from the live
 * spot (the no-cache full-live walk, 1-RPC quote).
 *
 * @param cookEntry  the engine cook entrypoint the QUOTE eth_call runs against (v1
 *                   SauceRouter / v12 Pot) — the swap target AND the allowance spender.
 * @param caller     the account the quote is FOR (its balance/allowance are overridden).
 *                   On v12 this MUST be the Pot owner (the Pot's cook is owner-gated).
 * @param opts.lensRouter the address the PREPARE lens read cooks against — ALWAYS a v1
 *                   SauceRouter (the lens is engine-agnostic and v1-only at runtime; on v12
 *                   pass the v12 stack's own SauceRouter, NOT the Pot). Defaults to
 *                   `cookEntry` (correct on v1 where they coincide).
 * @param opts.target solver bytecode target ("v1"|"v12"); the cook return decode is
 *                   per-engine (v1 wraps the bytes envelope, the v12 Pot returns raw).
 * @param opts.erc20Slots tokenIn's storage layout (defaults to OZ-standard 0/1); the local
 *                   test token (MintableERC20) uses 4/5.
 */
export declare function quoteEcoSwap(config: EcoSwapConfig, rpcUrl: string, cookEntry: Hex, caller: Hex, poolConfig?: ChainPoolConfig, opts?: EcoSwapPrepareOpts & {
    noBrackets?: boolean;
    erc20Slots?: Erc20Slots;
    target?: "v1" | "v12";
    lensRouter?: Hex;
}): Promise<QuoteEcoSwapResult>;
//# sourceMappingURL=index.d.ts.map