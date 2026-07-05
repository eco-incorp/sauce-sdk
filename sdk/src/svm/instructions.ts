import { AccountRole } from '@solana/kit';
import type { Address, Instruction } from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import {
  BUFFER_HEADER_BYTES,
  BUFFER_WRITE_CHUNK_BYTES,
  CLOSE_BUFFER_DISCRIMINATOR,
  CLOSE_MEMORY_DISCRIMINATOR,
  EXECUTE_DISCRIMINATOR,
  EXECUTE_FROM_ACCOUNT_DISCRIMINATOR,
  FINALIZE_BUFFER_DISCRIMINATOR,
  INIT_ARGS_DISCRIMINATOR,
  INIT_BUFFER_DISCRIMINATOR,
  INIT_FRAMES_DISCRIMINATOR,
  INIT_HEAP_DISCRIMINATOR,
  INIT_STACK_DISCRIMINATOR,
  MAX_BUFFER_CAPACITY,
  PDA_ARGS_BYTES,
  PDA_FRAMES_BYTES,
  PDA_GROWTH_STEP,
  PDA_HEAP_BYTES,
  PDA_STACK_BYTES,
  WRITE_BUFFER_DISCRIMINATOR,
} from './engine.js';
import type { EnginePdas } from './pda.js';
import type { ResolvedAccountMeta } from './resolve.js';

/** Current data lengths of the engine PDAs (0 or absent = not created yet). */
export interface EnginePdaSizes {
  stack?: number;
  heap?: number;
  frames?: number;
  args?: number;
}

function assertU8(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${name} must be a u8 (0-255), got ${value}`);
  }
}

function u32Le(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);

  return bytes;
}

function withDiscriminator(discriminator: Uint8Array, ...parts: (Uint8Array | number[])[]): Uint8Array {
  const total = discriminator.length + parts.reduce((n, p) => n + p.length, 0);
  const data = new Uint8Array(total);
  data.set(discriminator, 0);
  let offset = discriminator.length;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }

  return data;
}

function growInstructions(
  programId: Address,
  payer: Address,
  pda: Address,
  discriminator: Uint8Array,
  session: number,
  targetBytes: number,
  currentBytes: number,
): Instruction[] {
  const missing = Math.max(0, targetBytes - currentBytes);
  const steps = Math.ceil(missing / PDA_GROWTH_STEP);

  // Fresh objects per step, with fresh data arrays, so mutating one returned
  // instruction cannot corrupt the others.
  return Array.from({ length: steps }, (): Instruction => ({
    programAddress: programId,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: pda, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: withDiscriminator(discriminator, [session]),
  }));
}

/**
 * Builds the grow-to-size init sequence for the four engine memory PDAs of one
 * (payer, session). Each PDA grows at most 10240 bytes per instruction, so a
 * fresh onboarding needs ceil(33795/10240)=4 stack + 7 heap + 7 frames +
 * 1 args = 19 instructions — all of which fit in one transaction. Each init
 * payload is the 1-byte session. Re-running at full size is a no-op (engine
 * init is idempotent), so over-sending is safe. Pass `currentSizes` (from
 * getAccountInfo) to emit only the missing growth steps. The payer is the
 * memory OWNER — only it can initialize (and close) its own set.
 */
export function buildInitInstructions(
  programId: Address,
  pdas: EnginePdas,
  payer: Address,
  currentSizes: EnginePdaSizes = {},
  session = 0,
): Instruction[] {
  assertU8(session, 'session');

  return [
    ...growInstructions(programId, payer, pdas.stack.address, INIT_STACK_DISCRIMINATOR, session, PDA_STACK_BYTES, currentSizes.stack ?? 0),
    ...growInstructions(programId, payer, pdas.heap.address, INIT_HEAP_DISCRIMINATOR, session, PDA_HEAP_BYTES, currentSizes.heap ?? 0),
    ...growInstructions(programId, payer, pdas.frames.address, INIT_FRAMES_DISCRIMINATOR, session, PDA_FRAMES_BYTES, currentSizes.frames ?? 0),
    ...growInstructions(programId, payer, pdas.args.address, INIT_ARGS_DISCRIMINATOR, session, PDA_ARGS_BYTES, currentSizes.args ?? 0),
  ];
}

export interface CloseMemoryInstructionInput {
  programId: Address;
  pdas: EnginePdas;
  /** The memory owner — must sign; receives the drained rent deposit. */
  owner: Address;
  session?: number;
}

/**
 * Drains and reaps a session's memory set, refunding the rent deposit
 * (~1.2226 SOL for a full set) to the owner. Idempotent per PDA — a partially
 * initialized (or already closed) set closes what exists and skips the rest.
 */
export function buildCloseMemoryInstruction({ programId, pdas, owner, session = 0 }: CloseMemoryInstructionInput): Instruction {
  assertU8(session, 'session');

  return {
    programAddress: programId,
    accounts: [
      { address: owner, role: AccountRole.WRITABLE_SIGNER },
      { address: pdas.stack.address, role: AccountRole.WRITABLE },
      { address: pdas.heap.address, role: AccountRole.WRITABLE },
      { address: pdas.frames.address, role: AccountRole.WRITABLE },
      { address: pdas.args.address, role: AccountRole.WRITABLE },
    ],
    data: withDiscriminator(CLOSE_MEMORY_DISCRIMINATOR, [session]),
  };
}

export interface ExecuteInstructionInput {
  programId: Address;
  pdas: EnginePdas;
  bytecode: Uint8Array;
  accounts: readonly ResolvedAccountMeta[];
}

/**
 * Builds the engine execute instruction. Three laws bind the account list:
 * - user-account index 0 = instruction account 3 (the engine addresses
 *   SLOAD/SSTORE/CALL indices relative to the accounts after the 3 memory PDAs);
 * - MSG_SENDER (and the memory OWNER the PDAs must be derived from) = the
 *   first signer in the FULL instruction account list;
 * - an in-list signer is REQUIRED — the engine fails NoSigner without one
 *   (resolveAccounts appends the fee payer when the plan declares no signer).
 */
export function buildExecuteInstruction({ programId, pdas, bytecode, accounts }: ExecuteInstructionInput): Instruction {
  return {
    programAddress: programId,
    accounts: [
      { address: pdas.stack.address, role: AccountRole.WRITABLE },
      { address: pdas.heap.address, role: AccountRole.WRITABLE },
      { address: pdas.frames.address, role: AccountRole.WRITABLE },
      ...accounts,
    ],
    data: withDiscriminator(EXECUTE_DISCRIMINATOR, bytecode),
  };
}

export interface ExecuteFromAccountInstructionInput {
  programId: Address;
  /** The finalized bytecode buffer — listed FIRST and read-only (mandated by the engine). */
  buffer: Address;
  pdas: EnginePdas;
  accounts: readonly ResolvedAccountMeta[];
  /**
   * Optional 32-byte content-hash pin: must equal the buffer's stored
   * content_sha256 or the engine rejects (BufferHashMismatch). The only
   * cross-lifecycle trust anchor — always pass it for buffers this process
   * did not stage itself (close→re-init legitimately reuses the address).
   */
  expectedSha256?: Uint8Array;
}

/**
 * Builds the staged execute instruction. Account order is
 * [buffer (read-only), stack, heap, frames, ...user] — the buffer rides FIRST
 * so the user tail (and every account index baked into compiled bytecode) is
 * byte-identical to inline execute's list.
 */
export function buildExecuteFromAccountInstruction({
  programId,
  buffer,
  pdas,
  accounts,
  expectedSha256,
}: ExecuteFromAccountInstructionInput): Instruction {
  if (expectedSha256 !== undefined && expectedSha256.length !== 32) {
    throw new Error(`expectedSha256 must be exactly 32 bytes, got ${expectedSha256.length}`);
  }

  return {
    programAddress: programId,
    accounts: [
      { address: buffer, role: AccountRole.READONLY },
      { address: pdas.stack.address, role: AccountRole.WRITABLE },
      { address: pdas.heap.address, role: AccountRole.WRITABLE },
      { address: pdas.frames.address, role: AccountRole.WRITABLE },
      ...accounts,
    ],
    data: withDiscriminator(EXECUTE_FROM_ACCOUNT_DISCRIMINATOR, expectedSha256 ?? new Uint8Array(0)),
  };
}

// ── bytecode buffer lifecycle ──

export interface InitBufferInstructionsInput {
  programId: Address;
  /** Pays rent and becomes the buffer AUTHORITY (only key allowed to write/finalize/grow/close). */
  payer: Address;
  buffer: Address;
  /** The u8 seed discriminant (up to 256 buffers per authority). */
  index: number;
  /** Bytecode capacity in bytes (≤ 65,535); account size = 80 + capacity. */
  capacity: number;
  /** Current account data length (0 = not created); emits only the missing growth steps. */
  currentBytes?: number;
}

/**
 * Builds the create-then-grow init sequence for a bytecode buffer. Capacity
 * ≤ 10,160 is one instruction; a 16 KB buffer is 2 — all packable into one
 * transaction. Payload is index u8 + capacity u32 LE on every step (the engine
 * grows toward 80 + capacity per invocation; at/above target is a no-op).
 */
export function buildInitBufferInstructions({
  programId,
  payer,
  buffer,
  index,
  capacity,
  currentBytes = 0,
}: InitBufferInstructionsInput): Instruction[] {
  assertU8(index, 'buffer index');

  if (!Number.isInteger(capacity) || capacity <= 0 || capacity > MAX_BUFFER_CAPACITY) {
    throw new Error(`buffer capacity must be 1-${MAX_BUFFER_CAPACITY} bytes, got ${capacity}`);
  }

  const targetBytes = BUFFER_HEADER_BYTES + capacity;
  const steps = Math.ceil(Math.max(0, targetBytes - currentBytes) / PDA_GROWTH_STEP);

  return Array.from({ length: steps }, (): Instruction => ({
    programAddress: programId,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: buffer, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: withDiscriminator(INIT_BUFFER_DISCRIMINATOR, [index], u32Le(capacity)),
  }));
}

export interface WriteBufferInstructionInput {
  programId: Address;
  authority: Address;
  buffer: Address;
  /** Byte offset into the bytecode region (not the account) — chunks may land in any order. */
  offset: number;
  chunk: Uint8Array;
}

export function buildWriteBufferInstruction({ programId, authority, buffer, offset, chunk }: WriteBufferInstructionInput): Instruction {
  return {
    programAddress: programId,
    accounts: [
      { address: authority, role: AccountRole.READONLY_SIGNER },
      { address: buffer, role: AccountRole.WRITABLE },
    ],
    data: withDiscriminator(WRITE_BUFFER_DISCRIMINATOR, u32Le(offset), chunk),
  };
}

export interface FinalizeBufferInstructionInput {
  programId: Address;
  authority: Address;
  buffer: Address;
  /** The exact bytecode length — the engine hashes data[80..80+length] on-chain. */
  length: number;
  /** sha256 of the bytecode; a mismatch (straggler write, hole) fails loudly, state unchanged. */
  sha256: Uint8Array;
}

export function buildFinalizeBufferInstruction({ programId, authority, buffer, length, sha256 }: FinalizeBufferInstructionInput): Instruction {
  if (sha256.length !== 32) throw new Error(`sha256 must be exactly 32 bytes, got ${sha256.length}`);

  return {
    programAddress: programId,
    accounts: [
      { address: authority, role: AccountRole.READONLY_SIGNER },
      { address: buffer, role: AccountRole.WRITABLE },
    ],
    data: withDiscriminator(FINALIZE_BUFFER_DISCRIMINATOR, u32Le(length), sha256),
  };
}

export interface CloseBufferInstructionInput {
  programId: Address;
  /** Receives the drained rent; must sign. Finalized buffers close too (the recompile path). */
  authority: Address;
  buffer: Address;
}

export function buildCloseBufferInstruction({ programId, authority, buffer }: CloseBufferInstructionInput): Instruction {
  return {
    programAddress: programId,
    accounts: [
      { address: authority, role: AccountRole.WRITABLE_SIGNER },
      { address: buffer, role: AccountRole.WRITABLE },
    ],
    data: CLOSE_BUFFER_DISCRIMINATOR.slice(),
  };
}

// ── staging plan ──

export interface StagingChunk {
  offset: number;
  length: number;
}

export interface StagingPlan {
  /** Buffer capacity to init (= the bytecode length). */
  capacity: number;
  /** init_buffer invocations to reach 80 + capacity (all fit one transaction). */
  initInstructionCount: number;
  /** write_buffer chunk schedule — one transaction per chunk. */
  chunks: StagingChunk[];
  /**
   * End-to-end transactions: 1 init tx + one per chunk + a DEDICATED finalize
   * tx (sent only after every write confirmed — landing order across
   * concurrently broadcast txs is not guaranteed; the on-chain hash gate is
   * the backstop) + the execute tx. 8/12/20 for 4/8/16 KB at the 1,000-byte chunk.
   */
  transactions: { init: number; writes: number; finalize: number; execute: number; total: number };
}

/** Mirrors the engine's staging protocol batching (spec §2.5/§6.3). */
export function buildStagingPlan(bytecodeLength: number, chunkBytes: number = BUFFER_WRITE_CHUNK_BYTES): StagingPlan {
  if (!Number.isInteger(bytecodeLength) || bytecodeLength <= 0 || bytecodeLength > MAX_BUFFER_CAPACITY) {
    throw new Error(`bytecode length must be 1-${MAX_BUFFER_CAPACITY} bytes, got ${bytecodeLength}`);
  }

  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error(`chunk size must be a positive integer, got ${chunkBytes}`);
  }

  const chunks: StagingChunk[] = [];
  for (let offset = 0; offset < bytecodeLength; offset += chunkBytes) {
    chunks.push({ offset, length: Math.min(chunkBytes, bytecodeLength - offset) });
  }

  const initInstructionCount = Math.ceil((BUFFER_HEADER_BYTES + bytecodeLength) / PDA_GROWTH_STEP);

  return {
    capacity: bytecodeLength,
    initInstructionCount,
    chunks,
    transactions: { init: 1, writes: chunks.length, finalize: 1, execute: 1, total: 1 + chunks.length + 2 },
  };
}
