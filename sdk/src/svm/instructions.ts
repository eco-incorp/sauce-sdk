import { AccountRole } from '@solana/kit';
import type { Address, Instruction } from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import {
  BUFFER_HEADER_BYTES,
  BUFFER_WRITE_CHUNK_BYTES,
  CLOSE_BUFFER_DISCRIMINATOR,
  EXECUTE_DISCRIMINATOR,
  EXECUTE_FLAG_HAS_PIN,
  EXECUTE_FROM_ACCOUNT_DISCRIMINATOR,
  FINALIZE_BUFFER_DISCRIMINATOR,
  INIT_BUFFER_DISCRIMINATOR,
  MAX_BUFFER_CAPACITY,
  PDA_GROWTH_STEP,
  WRITE_BUFFER_DISCRIMINATOR,
} from './engine.js';
import type { ResolvedAccountMeta } from './resolve.js';

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

export interface ExecuteInstructionInput {
  programId: Address;
  bytecode: Uint8Array;
  accounts: readonly ResolvedAccountMeta[];
}

/**
 * Builds the engine execute instruction. The account list IS the user-account
 * index space: accounts[i] is user index i (no fixed prefix — interpreter
 * memory lives in the transaction's heap frame, not accounts). MSG_SENDER is
 * the first in-list signer, resolved LAZILY: a signerless list is valid unless
 * the program reads MSG_SENDER/TX_ORIGIN (NoSigner then). Every transaction
 * carrying this instruction MUST also carry RequestHeapFrame(262144) — see
 * buildHeapFramePrepend.
 */
export function buildExecuteInstruction({ programId, bytecode, accounts }: ExecuteInstructionInput): Instruction {
  return {
    programAddress: programId,
    accounts: [...accounts],
    data: withDiscriminator(EXECUTE_DISCRIMINATOR, bytecode),
  };
}

export interface ExecuteFromAccountInstructionInput {
  programId: Address;
  /** The finalized bytecode buffer — listed FIRST and read-only (mandated by the engine). */
  buffer: Address;
  accounts: readonly ResolvedAccountMeta[];
  /**
   * Optional 32-byte content-hash pin: must equal the buffer's stored
   * content_sha256 or the engine rejects (BufferHashMismatch). The only
   * cross-lifecycle trust anchor — always pass it for buffers this process
   * did not stage itself (close→re-init legitimately reuses the address).
   */
  expectedSha256?: Uint8Array;
  /**
   * Per-execution payload args (already encoded — encodePayloadArgs), appended
   * after the flags byte and optional pin. Surfaces to the bytecode through
   * CALLDATA as the composite `buffer bytecode ++ args`.
   */
  args?: Uint8Array;
}

/**
 * Builds the staged execute instruction. Account order is
 * [buffer (read-only), ...user] — the buffer rides FIRST so the user tail (and
 * every account index baked into compiled bytecode) is byte-identical to
 * inline execute's list. Data is the v2 payload grammar
 * [discriminator][flags: u8][pin: 32B iff flags & 0x01][args…] — the flags
 * byte is REQUIRED (an empty payload is InvalidInstruction), so the minimal
 * pinless, argless payload is [0x00].
 */
export function buildExecuteFromAccountInstruction({
  programId,
  buffer,
  accounts,
  expectedSha256,
  args,
}: ExecuteFromAccountInstructionInput): Instruction {
  if (expectedSha256 !== undefined && expectedSha256.length !== 32) {
    throw new Error(`expectedSha256 must be exactly 32 bytes, got ${expectedSha256.length}`);
  }

  const flags = expectedSha256 === undefined ? 0x00 : EXECUTE_FLAG_HAS_PIN;

  return {
    programAddress: programId,
    accounts: [{ address: buffer, role: AccountRole.READONLY }, ...accounts],
    data: withDiscriminator(
      EXECUTE_FROM_ACCOUNT_DISCRIMINATOR,
      [flags],
      expectedSha256 ?? new Uint8Array(0),
      args ?? new Uint8Array(0),
    ),
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

  // Fresh objects per step, with fresh data arrays, so mutating one returned
  // instruction cannot corrupt the others.
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
