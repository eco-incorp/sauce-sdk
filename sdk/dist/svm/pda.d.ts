import type { Address } from '@solana/kit';
export interface EnginePda {
    address: Address;
    bump: number;
}
/**
 * Derives a bytecode buffer PDA: `["buffer", authority, seed[32]]`.
 *
 * The 32-byte caller-supplied seed replaced the old u8 index: it removes the
 * 256-buffers-per-authority cap and the slot-collision hazard, and makes staging
 * deterministic and resumable — the same (authority, seed) always yields the same
 * address, so a partially-staged buffer can be re-derived and continued. The seed
 * is stored in the buffer header, so the address stays re-derivable from the
 * account alone. Address stability across recompiles is intentional;
 * cross-lifecycle integrity is the execute hash pin, never the address.
 *
 * The seed is raw bytes on purpose (not a number): a caller with a natural 32-byte
 * id — e.g. an intent hash — passes it directly, and a caller with a shorter id
 * hashes it to 32 bytes itself (the SDK does not pick a hash for you).
 */
export declare function deriveBufferPda(programId: Address, authority: Address, seed: Uint8Array): Promise<EnginePda>;
//# sourceMappingURL=pda.d.ts.map