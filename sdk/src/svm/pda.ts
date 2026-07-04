import { getProgramDerivedAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { FRAMES_SEED, HEAP_SEED, STACK_SEED } from './engine.js';

export interface EnginePda {
  address: Address;
  bump: number;
}

export interface EnginePdas {
  stack: EnginePda;
  heap: EnginePda;
  frames: EnginePda;
}

/** Derives the three engine PDAs (single-seed, canonical bump) for a deployed engine program. */
export async function deriveEnginePdas(programId: Address): Promise<EnginePdas> {
  const [stack, heap, frames] = await Promise.all(
    [STACK_SEED, HEAP_SEED, FRAMES_SEED].map(seed =>
      getProgramDerivedAddress({ programAddress: programId, seeds: [seed] }),
    ),
  );

  return {
    stack: { address: stack[0], bump: stack[1] },
    heap: { address: heap[0], bump: heap[1] },
    frames: { address: frames[0], bump: frames[1] },
  };
}
