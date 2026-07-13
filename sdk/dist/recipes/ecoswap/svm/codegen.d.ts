import type { Address } from '@solana/kit';
import type { AccountPlan, ArgsLayout } from '@eco-incorp/sauce-compiler';
import type { LadderSwapTemplate, PoolConfig, SvmVenueLadderV2, SwapUser, VenueAccount } from '../../../svm/venues/types.js';
export interface EcoSwapSvmSlot {
    adapter: SvmVenueLadderV2;
    cfg: PoolConfig;
    /**
     * Ladder rungs for this slot (default: the adapter's defaultRungs, else
     * QL_S). Fixed into the SHAPE — the budgeter picks it, the mirror
     * replicates it from the prepared slots, never from runtime CU.
     */
    rungs?: number;
    /**
     * Test/integration hook: replaces the venue swap CPI while the quote stays
     * live (e.g. an SPL-transfer stand-in paying the predicted output when no
     * venue binary is deployed). Changes the shape key.
     */
    swapOverride?: LadderSwapTemplate;
}
export interface GenerateEcoSwapSvmInput {
    slots: EcoSwapSvmSlot[];
    user: SwapUser;
    /**
     * The GasLeft safety floor (CU): when set, the program throws `"cu"`
     * before any work if the remaining compute budget is below it. A pure
     * function of the shape (the budgeter's modeled cost) — see the
     * determinism rule above.
     */
    cuFloor?: number;
}
export interface GeneratedEcoSwapSvm {
    source: string;
    /** The staged blob — stage once (hash-pinned), execute per trade with fresh args. */
    bytecode: Uint8Array;
    argsLayout: ArgsLayout;
    /** Ordered plan; adapter-resolved refs carry their pubkey, user refs stay open. */
    accountPlan: AccountPlan;
    /** Shape discriminant: pool sets sharing it reuse the identical blob. */
    shapeKey: string;
    /** Resolved per-slot ladder rungs (slot order) — feed solver-reference. */
    rungs: number[];
    /** Byte length of the packed cfg arg (encodeEcoSwapSvmTrade must match). */
    cfgByteLength: number;
    warnings: string[];
}
export declare const hexLiteral: (bytes: Uint8Array) => string;
export declare const progRef: (slot: number) => string;
/** 64-bit byte swap: the LE image of a u64 amount, MSTORE'd big-endian by abi.encode. */
export declare const LE8_HELPER: string;
export declare function accountEntry(account: VenueAccount): string;
/** Records ref → address; a ref claiming two different addresses is a config error. */
export declare function bindAddress(addressByRef: Map<string, string>, ref: string, address: Address | undefined): void;
/** Resolves a slot's ladder depth: explicit > adapter default > QL_S; bounds-checked. */
export declare function resolveSlotRungs(slot: Pick<EcoSwapSvmSlot, 'adapter' | 'rungs'>): number;
/**
 * Encodes the per-trade cfg bytes for a shape: u64 LE words
 * [amountIn][minOut] then per slot [enable][...params]. Slot order and
 * param counts must match the generate() call that produced the blob —
 * cfgByteLength pins the total.
 */
export declare function encodeEcoSwapSvmTrade(slots: readonly {
    params: readonly bigint[];
    enabled?: boolean;
}[], amountIn: bigint, minOut: bigint): `0x${string}`;
/** Collects and dedupes the slots' helper functions; one name = one source. */
export declare function collectHelpers(slots: readonly EcoSwapSvmSlot[]): string[];
export declare function quoteMode(adapter: SvmVenueLadderV2): 'expression' | 'statements';
/**
 * Shape discriminant for blob reuse: family slots (rung-count-suffixed when
 * off the Phase-0 default QL_S) + any swap overrides.
 */
export declare function ecoSwapSvmShapeKey(slots: readonly EcoSwapSvmSlot[]): string;
/** Generates and compiles the staged solver blob for one shape. */
export declare function generateEcoSwapSvm(input: GenerateEcoSwapSvmInput): GeneratedEcoSwapSvm;
//# sourceMappingURL=codegen.d.ts.map