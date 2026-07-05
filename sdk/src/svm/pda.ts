import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import type { Address, ProgramDerivedAddressBump } from '@solana/kit';
import { ARGS_SEED, BUFFER_SEED, FRAMES_SEED, HEAP_SEED, STACK_SEED } from './engine.js';
import type { EnginePdaSeed } from './engine.js';

export interface EnginePda {
  address: Address;
  bump: number;
}

/** The per-(owner, session) memory set: stack, heap, frames, and the args scratch. */
export interface EnginePdas {
  stack: EnginePda;
  heap: EnginePda;
  frames: EnginePda;
  args: EnginePda;
}

function assertByteSeed(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${name} must be a u8 (0-255), got ${value}`);
  }
}

async function deriveMemoryPda(
  programId: Address,
  seed: EnginePdaSeed,
  owner: Address,
  session: number,
): Promise<readonly [Address, ProgramDerivedAddressBump]> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [seed, getAddressEncoder().encode(owner), new Uint8Array([session])],
  });
}

/**
 * Derives the four engine memory PDAs for one (owner, session). The owner MUST
 * be the account that will be the execute instruction's FIRST in-list signer —
 * the engine validates the memory set against it. Session defaults to 0 (the
 * SDK's single-session mode; rotate sessions for parallel same-owner executes).
 */
export async function deriveEnginePdas(programId: Address, owner: Address, session = 0): Promise<EnginePdas> {
  assertByteSeed(session, 'session');

  const [stack, heap, frames, args] = await Promise.all(
    ([STACK_SEED, HEAP_SEED, FRAMES_SEED, ARGS_SEED] as const).map(seed =>
      deriveMemoryPda(programId, seed, owner, session),
    ),
  );

  return {
    stack: { address: stack[0], bump: stack[1] },
    heap: { address: heap[0], bump: heap[1] },
    frames: { address: frames[0], bump: frames[1] },
    args: { address: args[0], bump: args[1] },
  };
}

/** Derives just the args PDA for one (owner, session) — the staged-args scratch. */
export async function deriveArgsPda(programId: Address, owner: Address, session = 0): Promise<EnginePda> {
  assertByteSeed(session, 'session');

  const [address, bump] = await deriveMemoryPda(programId, ARGS_SEED, owner, session);

  return { address, bump };
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
