import type { Address, Commitment, Instruction, TransactionSigner } from '@solana/kit';
import type { PacketBudget } from '@eco-incorp/sauce-compiler';
import type { EnsuredLookupTable, SauceSvmClient, StagedBuffer } from '../../../svm/client.js';
import type { SendExecuteResult } from '../../../svm/send.js';
import type { AccountResolution } from '../../../svm/resolve.js';
import type { BatchAccountLoader } from '../../../svm/loader.js';
import type { AccountLoader, LadderSwapTemplate, SwapUser } from '../../../svm/venues/types.js';
import type { GeneratedEcoSwapSvm } from './codegen.js';
import type { GeneratedEcoSwapSvmRoute } from './route.js';
import type { RouteReferenceResult, SolverReferenceResult } from './solver-reference.js';
export { encodeEcoSwapSvmTrade, ecoSwapSvmShapeKey, generateEcoSwapSvm, resolveSlotRungs } from './codegen.js';
export type { EcoSwapSvmSlot, GenerateEcoSwapSvmInput, GeneratedEcoSwapSvm } from './codegen.js';
export { DEFAULT_INTER_REF, ecoSwapSvmRouteShapeKey, generateEcoSwapSvmRoute, MAX_LEG_SLOTS, MAX_ROUTE_SLOTS, } from './route.js';
export type { GenerateEcoSwapSvmRouteInput, GeneratedEcoSwapSvmRoute } from './route.js';
export { buildLadder, ladderGrid, routeReference, solveReference, MAX_RUNGS, MIN_RUNGS, QL_S } from './solver-reference.js';
export type { LadderRung, RouteReferenceResult, SolverReferenceResult, SolverSlotInput } from './solver-reference.js';
export { efficiencyLoss, solveOptimal } from './optimal.js';
export type { ContinuousVenue, OptimalSplitResult } from './optimal.js';
export { CU_ADMISSION_BUDGET, CU_BASE, CU_FAMILIES, CU_TRANSACTION_CAP, CU_TWO_HOP, defaultRungsFor, estimateRouteCu, estimateShapeCu, familyCuCoefficients, planLadders, planRouteLadders, } from './budget.js';
export type { BudgetSlotInput, FamilyCuCoefficients, LadderPlan, RouteLadderPlan } from './budget.js';
/** Default relative-depth floor: drop pools below 1% of the summed depth. */
export declare const ECO_SVM_MIN_REL_BPS = 100;
/**
 * Structural slot cap — the codegen template width. The EFFECTIVE slot count
 * is CU-budgeter-driven (budget.ts): the deepest ECO_SVM_MAX_SLOTS
 * depth-survivors enter admission, and the budgeter degrades ladder rungs /
 * drops tail slots until the shape's modeled cost fits the compute budget.
 */
export declare const ECO_SVM_MAX_SLOTS = 4;
type LadderVenueSlug = 'raydium-cp-swap' | 'raydium-amm-v4' | 'pumpswap' | 'orca-legacy-token-swap' | 'orca-whirlpool' | 'raydium-clmm' | 'meteora-dlmm' | 'manifest' | 'meteora-damm-v2' | 'saber-stableswap' | 'meteora-damm-v1-stable' | 'obric-v2';
export interface EcoSwapSvmPoolSpec {
    venue: LadderVenueSlug;
    pool: Address;
    /**
     * exactIn side, per family: raydium-cp-swap '0to1' (default) | '1to0';
     * raydium-amm-v4 'coinToPc' (default) | 'pcToCoin'; pumpswap 'quoteToBase'
     * (default) | 'baseToQuote'; meteora-damm-v2 and orca-whirlpool 'aToB'
     * (default) | 'bToA'; raydium-clmm '0to1' (default) | '1to0'; meteora-dlmm 'xToY' (default, swap_for_y) | 'yToX'; manifest 'baseIn' (default, sell base) | 'quoteIn'
     * (buy base); saber-stableswap and meteora-damm-v1-stable only 'AtoB';
     * obric-v2 'xToY' (default, mintX in) | 'yToX'.
     */
    direction?: string;
    /** Test/integration hook: replace the venue swap CPI (the quote stays live). */
    swapOverride?: LadderSwapTemplate;
}
export interface QuoteEcoSwapSvmConfig {
    amountIn: bigint;
    /** Candidate pools in preference order (merge ties keep the earliest slot). 1..4 after filtering. */
    pools: EcoSwapSvmPoolSpec[];
    /** Single-account source (fixtures / custom RPC binding). One of load/loadMany is required. */
    load?: AccountLoader;
    /**
     * Batched source (e.g. kitBatchAccountLoader(rpc)): the prepare coalesces
     * into getMultipleAccounts sweeps chunked at 100, and pool-account owners
     * are verified against each family's program id.
     */
    loadMany?: BatchAccountLoader;
    /** Relative-depth floor in bps of ΣL (default 100 = 1%; 0 disables). */
    minRelBps?: number;
    /**
     * CU admission budget for the budgeter (default CU_ADMISSION_BUDGET =
     * the 1.4M cap minus 15% model headroom). Raising it past the cap forces
     * heavier shapes through — the codegen GasLeft floor still guards them.
     */
    cuBudget?: number;
    /**
     * Unix seconds the time-dependent reference quotes evaluate at (amp ramps,
     * locked-profit decay). Defaults to the wall clock; the lamport-exact e2e
     * gate pins it to the harness cluster clock. The fragments always read the
     * REAL Clock sysvar — a stale `now` only staleness-shifts the off-chain
     * quote, covered by minOut like any other drift.
     */
    now?: bigint;
}
export interface EcoSwapSvmConfig extends QuoteEcoSwapSvmConfig {
    /** Minimum realized outAta delta, inclusive — enforced pre-CPI on the prediction and post-CPI on the delta. */
    minOut: bigint;
    /** User-side account refs, resolved by the caller when sending. */
    user: SwapUser;
}
export interface EcoSwapSvmPreparedSlot {
    venue: LadderVenueSlug;
    pool: Address;
    /** Per-trade param words (encodeEcoSwapSvmTrade order). */
    params: bigint[];
    /** Depth metric used by the relative filter: isqrt(reserveIn * reserveOut). */
    depth: bigint;
    /** Budgeter-assigned ladder rungs — part of the shape. */
    rungs: number;
}
export interface EcoSwapSvmDroppedPool {
    pool: Address;
    venue: LadderVenueSlug;
    depth: bigint;
    /** What dropped it: the relative-depth filter, the structural slot cap, or the CU budget. */
    reason: 'depth' | 'slots' | 'budget';
}
export interface EcoSwapSvmQuote extends SolverReferenceResult {
    /** Post-filter slot assignment (slots[i] backs slice i). */
    slots: EcoSwapSvmPreparedSlot[];
    /** Pools dropped by the depth filter / slot cap / CU budget. */
    dropped: EcoSwapSvmDroppedPool[];
    /** Modeled CU of the admitted shape (the codegen GasLeft floor). */
    estimatedCu: number;
    /** Budgeter degradations/drops, packet-budgeter style. */
    warnings: string[];
}
export interface EcoSwapSvmOutput extends GeneratedEcoSwapSvm {
    /** sha256 of the staged blob — the execute pin (stageBuffer recomputes and verifies on-chain). */
    sha256: Uint8Array;
    /** Post-filter slots, in blob order. */
    slots: EcoSwapSvmPreparedSlot[];
    /** Encoded cfg arg for THIS trade (amountIn/minOut baked); re-encode via encodeTrade for others. */
    argValues: [`0x${string}`];
    /** Reference solve on the fetch-time account bytes (the user-facing quote). */
    quote: EcoSwapSvmQuote;
    /** Re-encodes the cfg arg for a new trade on the SAME staged blob (stage once, trade many). */
    encodeTrade: (amountIn: bigint, minOut: bigint) => [`0x${string}`];
}
/** Floor integer square root (Newton), for the CP depth metric L = isqrt(rIn·rOut). */
export declare function bigintSqrt(value: bigint): bigint;
/**
 * The user-facing quote: fetch the candidates' account bytes once through
 * the loader, run the exact solver mirror — zero simulation, zero execution.
 * Lamport-identical to what the staged blob would compute on the same bytes.
 */
export declare function quoteEcoSwapSvm(config: QuoteEcoSwapSvmConfig): Promise<EcoSwapSvmQuote>;
/**
 * Prepare + compile: candidate gates → depth filter → CU budgeter → slot
 * assignment → shape codegen → staged compile. The blob serves ANY pool set
 * matching its shapeKey — per-trade values ride the payload args, pool
 * accounts rebind through the resolution map.
 */
export declare function ecoSwapSvm(config: EcoSwapSvmConfig): Promise<EcoSwapSvmOutput>;
/**
 * Stage the blob once into buffer `index` (init → chunked writes → the
 * on-chain sha256-gated finalize). The returned StagedBuffer carries the
 * content-hash pin every execute uses.
 */
export declare function stageEcoSwapSvm(client: SauceSvmClient, index: number, output: Pick<EcoSwapSvmOutput, 'bytecode'>): Promise<StagedBuffer>;
/**
 * A prepared address lookup table for one EcoSwapSVM universe (shape + pool
 * set + user). Returned by prepareAltForUniverse and handed to
 * executeEcoSwapSvm's `alt` option; reusable across every trade on that
 * universe, like the staged blob.
 */
export type EcoSwapSvmAlt = EnsuredLookupTable;
/**
 * The lookup-table address set for a staged trade: the buffer plus every
 * NON-SIGNER account in the resolved plan (venue pools/vaults/programs + the
 * user's token accounts), deduped. Signers (the owner / fee payer) MUST stay
 * static message accounts — they cannot be looked up. These keys are stable
 * across trades on a given (shape, pool set, user), so the ALT built over them
 * is reusable per universe like the staged blob.
 */
export declare function selectEcoSwapSvmAltAddresses(output: Pick<EcoSwapSvmOutput, 'accountPlan'>, staged: StagedBuffer | Address, resolution: AccountResolution, payerAddress: Address): Address[];
export interface EcoSwapSvmPacketOptions {
    /**
     * Resolution + payer to ALSO model the ALT-compressed estimate (the plan's
     * non-signer metas move to the table). Without them only `raw` is returned.
     */
    resolution?: AccountResolution;
    payerAddress?: Address;
    /** Prepend bytes beyond RequestHeapFrame (the 'auto' CU-limit prepend ≈ 8). Default 8. */
    prependBytes?: number;
}
export interface EcoSwapSvmPacketBudget {
    /** Raw (no-ALT) staged v0 packet estimate — check `raw.overflowBytes > 0`. */
    raw: PacketBudget;
    /** ALT-compressed estimate (only when resolution + payerAddress are given). */
    withAlt?: PacketBudget;
}
/**
 * Models the staged execute_from_account v0 packet for a compiled shape (the
 * compiler's estimatePacket over the shape's argsLayout byte length). With a
 * resolution + payer it also models the ALT-compressed packet, moving the
 * non-signer metas to one lookup table. This estimate counts plan METAS (not
 * deduped addresses), so it is CONSERVATIVE — the real message dedups repeated
 * addresses (shared token/venue programs, mints), so a shape it flags near the
 * limit may still fit raw; building an ALT is always safe. The account-LOCK
 * count is invariant to the ALT (locks = static keys + resolved addresses):
 * the table shrinks BYTES, never the 64-lock cap.
 */
export declare function ecoSwapSvmPacketBudget(output: Pick<EcoSwapSvmOutput, 'accountPlan' | 'bytecode' | 'argsLayout'>, opts?: EcoSwapSvmPacketOptions): EcoSwapSvmPacketBudget;
export interface PrepareAltOptions {
    /**
     * Reuse and EXTEND this table (idempotent) instead of creating a fresh one —
     * only the addresses it does not already hold are appended. Pass the
     * lookupTableAddress a previous prepareAltForUniverse returned to grow one
     * table across universes that share a payer.
     */
    existingTable?: Address;
    commitment?: Commitment;
}
/**
 * Idempotent create-(or-extend)-and-warm-up of the lookup table for a staged
 * EcoSwapSVM universe. Selects the buffer + non-signer plan accounts
 * (selectEcoSwapSvmAltAddresses), builds/extends the table through the client
 * (waiting for it to activate), and returns it in the shape executeEcoSwapSvm's
 * `alt` option consumes. Call it ONCE per universe and reuse the result across
 * every trade — the account set is as stable as the staged blob. Only worth
 * doing when the raw packet would overflow (ecoSwapSvmPacketBudget); a
 * within-budget shape needs no ALT.
 */
export declare function prepareAltForUniverse(client: SauceSvmClient, staged: StagedBuffer | Address, output: Pick<EcoSwapSvmOutput, 'accountPlan'>, resolution: AccountResolution, opts?: PrepareAltOptions): Promise<EcoSwapSvmAlt>;
export interface ExecuteEcoSwapSvmOpts {
    /**
     * A prepared lookup table (prepareAltForUniverse) — the execute goes out as a
     * v0 transaction compressed against it, shrinking the packet below the
     * 1,232-byte limit for shapes whose account list would otherwise overflow.
     * Absent = a plain v0 transaction (the account keys ride the message inline).
     * The staged blob, hash pin and payload-args path are identical either way;
     * only the transaction assembly changes.
     */
    alt?: EcoSwapSvmAlt;
}
/**
 * One trade = ONE execute_from_account instruction: the staged blob,
 * hash-pinned, with this trade's cfg bytes as payload args. `resolution`
 * binds the user refs (outAta/inAta/owner — plus, for pumpswap buy slots,
 * the caller-derived user volume accumulator PDA); adapter-resolved refs are
 * already stamped on the plan. Pass `opts.alt` (from prepareAltForUniverse) to
 * send the transaction compressed against an address lookup table when the raw
 * account list would overflow the 1,232-byte packet — RequestHeapFrame stays
 * add-once and signerless simulate is unaffected (the ALT only reshapes the
 * account KEYS section, never the signer set or the 64-lock cap).
 */
export declare function executeEcoSwapSvm(client: SauceSvmClient, staged: StagedBuffer | Address, output: EcoSwapSvmOutput, resolution: AccountResolution, trade?: {
    amountIn: bigint;
    minOut: bigint;
}, opts?: ExecuteEcoSwapSvmOpts): Promise<SendExecuteResult>;
export interface QuoteRouteEcoSwapSvmConfig {
    amountIn: bigint;
    /** leg-0 candidate pools (A → X), preference order — 1..MAX_LEG_SLOTS after filtering. */
    leg0Pools: EcoSwapSvmPoolSpec[];
    /** leg-1 candidate pools (X → B), preference order. */
    leg1Pools: EcoSwapSvmPoolSpec[];
    /** Single-account source (fixtures / custom RPC binding). One of load/loadMany is required. */
    load?: AccountLoader;
    /** Batched source (e.g. kitBatchAccountLoader(rpc)) — the prepare coalesces into getMultipleAccounts sweeps. */
    loadMany?: BatchAccountLoader;
    /** Relative-depth floor in bps of ΣL, applied PER LEG (default 100 = 1%; 0 disables). */
    minRelBps?: number;
    /** Combined-route CU admission budget (default CU_ADMISSION_BUDGET); raising it forces heavier routes. */
    cuBudget?: number;
    /** Unix seconds the time-dependent reference quotes evaluate at (default wall clock). */
    now?: bigint;
    /** Intermediate-token (X) ATA ref, resolved by the caller (default 'user:inter'). */
    interRef?: string;
}
export interface RouteEcoSwapSvmConfig extends QuoteRouteEcoSwapSvmConfig {
    /** Minimum realized outAta (B) delta, inclusive — enforced pre-CPI on the leg-1 prediction and post-CPI on the delta. */
    minOut: bigint;
    /** User-side account refs (inAta = token A, outAta = token B, owner). */
    user: SwapUser;
}
export interface EcoSwapSvmRouteQuote extends RouteReferenceResult {
    /** Post-filter leg-0 slot assignment (slots back leg0.slices in order). */
    leg0Slots: EcoSwapSvmPreparedSlot[];
    /** Post-filter leg-1 slot assignment. */
    leg1Slots: EcoSwapSvmPreparedSlot[];
    /** Pools dropped by the per-leg depth filter / slot cap / route CU budget. */
    dropped: EcoSwapSvmDroppedPool[];
    /** Modeled route CU of the admitted shape (the codegen GasLeft floor). */
    estimatedCu: number;
    /** Budgeter degradations/drops, packet-budgeter style. */
    warnings: string[];
}
export interface EcoSwapSvmRouteOutput extends GeneratedEcoSwapSvmRoute {
    /** sha256 of the staged blob — the execute pin. */
    sha256: Uint8Array;
    /** The intermediate-token ATA ref this blob's leg-0 out / leg-1 in resolve to. */
    interRef: string;
    /** Post-filter leg-0 prepared slots, in blob order. */
    leg0Slots: EcoSwapSvmPreparedSlot[];
    /** Post-filter leg-1 prepared slots. */
    leg1Slots: EcoSwapSvmPreparedSlot[];
    /** Flat prepared slots (leg-0, then leg-1) — the cfg / returndata order. */
    slots: EcoSwapSvmPreparedSlot[];
    /** Encoded cfg arg for THIS trade; re-encode via encodeTrade for others. */
    argValues: [`0x${string}`];
    /** Composed route reference over the fetch-time bytes (the user-facing quote). */
    quote: EcoSwapSvmRouteQuote;
    /** Re-encodes the cfg arg for a new trade on the SAME staged route blob. */
    encodeTrade: (amountIn: bigint, minOut: bigint) => [`0x${string}`];
}
/**
 * The user-facing ROUTE quote: fetch both legs' candidate bytes once through
 * the loader, run the composed lamport-exact mirror (routeReference) — zero
 * simulation. `intermediate` == the on-chain realizedX, `totalOut` == realizedB
 * (absent drift). Lamport-identical to what the staged route blob computes on
 * the same bytes.
 */
export declare function quoteRouteEcoSwapSvm(config: QuoteRouteEcoSwapSvmConfig): Promise<EcoSwapSvmRouteQuote>;
/**
 * Prepare + compile a 2-hop route: per-leg candidate gates → per-leg depth
 * filter → route CU budgeter → leg slot assignment → route codegen (the
 * compute-exec-compute-exec solver) → staged compile. The blob serves ANY pool
 * set matching its route shapeKey; per-trade values ride the payload args, pool
 * accounts (both legs) + the intermediate ATA rebind through the resolution map.
 */
export declare function routeEcoSwapSvm(config: RouteEcoSwapSvmConfig): Promise<EcoSwapSvmRouteOutput>;
/** Stage a route blob once (init → chunked writes → sha256-gated finalize). */
export declare function stageRouteEcoSwapSvm(client: SauceSvmClient, index: number, output: Pick<EcoSwapSvmRouteOutput, 'bytecode'>): Promise<StagedBuffer>;
/**
 * Idempotent create of the intermediate-token (X) ATA for `owner` — the sole
 * intermediate custody (the engine never signs). Prepend it beside the
 * heap-frame + CU-limit prepends on the route execute, exactly like the
 * wSOL-wrap prepend, and resolve the blob's `interRef` to the returned `ata`.
 */
export declare function buildRouteInterAtaPrepend(input: {
    payer: TransactionSigner;
    owner: Address;
    mint: Address;
    tokenProgram?: Address;
}): Promise<{
    ata: Address;
    instruction: Instruction;
}>;
export interface ExecuteRouteEcoSwapSvmOpts extends ExecuteEcoSwapSvmOpts {
    /**
     * Extra prepends (add-once, beside the client's heap-frame + CU-limit) — the
     * idempotent intermediate-ATA create belongs here (buildRouteInterAtaPrepend).
     */
    prepends?: readonly Instruction[];
}
/**
 * One route trade = ONE execute_from_account instruction: the staged route
 * blob, hash-pinned, with this trade's cfg bytes as payload args. `resolution`
 * binds the user refs (inAta = A, outAta = B, owner, and the interRef = the
 * intermediate ATA). Pass `opts.alt` (routes ~double the account list — an ALT
 * is effectively mandatory) and `opts.prepends` (the intermediate-ATA create).
 */
export declare function executeRouteEcoSwapSvm(client: SauceSvmClient, staged: StagedBuffer | Address, output: EcoSwapSvmRouteOutput, resolution: AccountResolution, trade?: {
    amountIn: bigint;
    minOut: bigint;
}, opts?: ExecuteRouteEcoSwapSvmOpts): Promise<SendExecuteResult>;
//# sourceMappingURL=index.d.ts.map