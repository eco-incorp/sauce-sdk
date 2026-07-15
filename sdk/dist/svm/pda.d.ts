import type { Address } from '@solana/kit';
export interface EnginePda {
    address: Address;
    bump: number;
}
/**
 * Derives a bytecode buffer PDA: ["buffer", authority, [index]]. The index (not
 * a content hash) keeps the address stable across recompiles — cross-lifecycle
 * integrity is the execute hash pin, never the address alone.
 */
export declare function deriveBufferPda(programId: Address, authority: Address, index: number): Promise<EnginePda>;
//# sourceMappingURL=pda.d.ts.map