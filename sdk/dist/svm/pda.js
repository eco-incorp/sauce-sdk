import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { BUFFER_SEED } from './engine.js';
function assertByteSeed(value, name) {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
        throw new Error(`${name} must be a u8 (0-255), got ${value}`);
    }
}
/**
 * Derives a bytecode buffer PDA: ["buffer", authority, [index]]. The index (not
 * a content hash) keeps the address stable across recompiles — cross-lifecycle
 * integrity is the execute hash pin, never the address alone.
 */
export async function deriveBufferPda(programId, authority, index) {
    assertByteSeed(index, 'buffer index');
    const [address, bump] = await getProgramDerivedAddress({
        programAddress: programId,
        seeds: [BUFFER_SEED, getAddressEncoder().encode(authority), new Uint8Array([index])],
    });
    return { address, bump };
}
//# sourceMappingURL=pda.js.map