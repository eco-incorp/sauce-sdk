import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { BUFFER_SEED } from './engine.js';

export interface EnginePda {
  address: Address;
  bump: number;
}

function assertByteSeed(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${name} must be a u8 (0-255), got ${value}`);
  }
}

/**
 * Derives a bytecode buffer PDA: ["buffer", authority, [index]]. The index (not
 * a content hash) keeps the address stable across recompiles — cross-lifecycle
 * integrity is the execute hash pin, never the address alone.
 */
export async function deriveBufferPda(programId: Address, authority: Address, index: number): Promise<EnginePda> {
  assertByteSeed(index, 'buffer index');

  const [address, bump] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [BUFFER_SEED, getAddressEncoder().encode(authority), new Uint8Array([index])],
  });

  return { address, bump };
}
