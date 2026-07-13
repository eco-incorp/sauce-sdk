import type { Address, Instruction, TransactionSigner } from '@solana/kit';
/** Wrapped SOL mint (not exported by @solana-program/token). */
export declare const NATIVE_MINT: Address;
/**
 * RequestHeapFrame(262144) — REQUIRED on every execute/simulate transaction:
 * interpreter memory lives in the transaction's 256 KiB BPF heap frame, and a
 * transaction without the request aborts deterministically before any opcode.
 * **Add-once** beside SetComputeUnitLimit — duplicate ComputeBudget instruction
 * types fail the whole transaction (the client's execute flows attach it
 * automatically; use this when assembling transactions by hand). Buffer
 * staging transactions do not need it.
 */
export declare function buildHeapFramePrepend(bytes?: number): Instruction;
export interface ComputeBudgetPrependInput {
    unitLimit: number;
    microLamportsPerCu?: number | bigint;
}
export declare function buildComputeBudgetPrepend({ unitLimit, microLamportsPerCu }: ComputeBudgetPrependInput): Instruction[];
export interface AtaPrependInput {
    payer: TransactionSigner;
    owner: Address;
    mint: Address;
    tokenProgram?: Address;
}
/** Idempotent ATA creation — safe to prepend whether or not the ATA already exists. */
export declare function buildAtaPrepend({ payer, owner, mint, tokenProgram }: AtaPrependInput): Promise<{
    ata: Address;
    instruction: Instruction;
}>;
export interface WrapSolPrependsInput {
    payer: TransactionSigner;
    owner: Address;
    lamports: bigint;
}
/** Idempotent wSOL ATA + SOL transfer + SyncNative — wraps `lamports` into the owner's wSOL account. */
export declare function buildWrapSolPrepends({ payer, owner, lamports }: WrapSolPrependsInput): Promise<{
    wsolAta: Address;
    instructions: Instruction[];
}>;
//# sourceMappingURL=prepends.d.ts.map