import { AccountRole } from '@solana/kit';
import type { Address, Instruction } from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import {
  EXECUTE_DISCRIMINATOR,
  INIT_FRAMES_DISCRIMINATOR,
  INIT_HEAP_DISCRIMINATOR,
  INIT_STACK_DISCRIMINATOR,
  PDA_FRAMES_BYTES,
  PDA_GROWTH_STEP,
  PDA_HEAP_BYTES,
  PDA_STACK_BYTES,
} from './engine.js';
import type { EnginePdas } from './pda.js';
import type { ResolvedAccountMeta } from './resolve.js';

/** Current data lengths of the engine PDAs (0 or absent = not created yet). */
export interface EnginePdaSizes {
  stack?: number;
  heap?: number;
  frames?: number;
}

function growInstructions(
  programId: Address,
  payer: Address,
  pda: Address,
  discriminator: Uint8Array,
  targetBytes: number,
  currentBytes: number,
): Instruction[] {
  const missing = Math.max(0, targetBytes - currentBytes);
  const steps = Math.ceil(missing / PDA_GROWTH_STEP);

  // Fresh objects per step, with data copied off the exported discriminator
  // constant, so mutating one returned instruction cannot corrupt the others.
  return Array.from({ length: steps }, (): Instruction => ({
    programAddress: programId,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: pda, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: discriminator.slice(),
  }));
}

/**
 * Builds the grow-to-size init sequence for the three engine PDAs. Each PDA
 * grows at most 10240 bytes per instruction, so a fresh deployment needs
 * ceil(33793/10240)=4 stack + 7 heap + 7 frames = 18 instructions — all of
 * which fit in one transaction. Re-running at full size is a no-op (engine
 * init is idempotent), so over-sending is safe. Pass `currentSizes` (from
 * getAccountInfo) to emit only the missing growth steps.
 */
export function buildInitInstructions(
  programId: Address,
  pdas: EnginePdas,
  payer: Address,
  currentSizes: EnginePdaSizes = {},
): Instruction[] {
  return [
    ...growInstructions(programId, payer, pdas.stack.address, INIT_STACK_DISCRIMINATOR, PDA_STACK_BYTES, currentSizes.stack ?? 0),
    ...growInstructions(programId, payer, pdas.heap.address, INIT_HEAP_DISCRIMINATOR, PDA_HEAP_BYTES, currentSizes.heap ?? 0),
    ...growInstructions(programId, payer, pdas.frames.address, INIT_FRAMES_DISCRIMINATOR, PDA_FRAMES_BYTES, currentSizes.frames ?? 0),
  ];
}

export interface ExecuteInstructionInput {
  programId: Address;
  pdas: EnginePdas;
  bytecode: Uint8Array;
  accounts: readonly ResolvedAccountMeta[];
}

/**
 * Builds the engine execute instruction. Two laws bind the account list:
 * - user-account index 0 = instruction account 3 (the engine addresses
 *   SLOAD/SSTORE/CALL indices relative to the accounts after the 3 PDAs);
 * - MSG_SENDER = the first signer in the FULL instruction account list, so a
 *   program that reads MSG_SENDER must include the payer meta among the user
 *   accounts (resolveAccounts' PAYER_REF does this).
 */
export function buildExecuteInstruction({ programId, pdas, bytecode, accounts }: ExecuteInstructionInput): Instruction {
  const data = new Uint8Array(EXECUTE_DISCRIMINATOR.length + bytecode.length);
  data.set(EXECUTE_DISCRIMINATOR, 0);
  data.set(bytecode, EXECUTE_DISCRIMINATOR.length);

  return {
    programAddress: programId,
    accounts: [
      { address: pdas.stack.address, role: AccountRole.WRITABLE },
      { address: pdas.heap.address, role: AccountRole.WRITABLE },
      { address: pdas.frames.address, role: AccountRole.WRITABLE },
      ...accounts,
    ],
    data,
  };
}
