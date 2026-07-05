/**
 * Staged-args writer — the SDK half of the compiler's staged arg ABI
 * (CompileResult.argsLayout). A staged program reads its per-execution args
 * from the caller's args PDA (user-tail index 0, offsets ≥ 32); this module
 * encodes fresh values against the layout and builds the tiny inline `execute`
 * instruction that SSTOREs them into the PDA IN THE SAME TRANSACTION as the
 * execute_from_account instruction — atomic, restage-free parameterization.
 *
 * Slot ABI (normative, mirrored from the compiler):
 * - scalar slots: 32 bytes, u256 LITTLE-ENDIAN (the prologue reads them with
 *   SLOAD + CAST_LE);
 * - bytes slots: the raw bytes, length fixed at compile time.
 *
 * Nothing durable may live in the args PDA — any transaction listing it
 * writable can scribble the region; the same-tx write+consume pattern is what
 * makes it safe.
 */
import { AccountRole } from '@solana/kit';
import type { Address, Instruction } from '@solana/kit';
import type { ArgsLayout, ArgsLayoutSlot, ArgValue } from '@eco-incorp/sauce-compiler';
import { EXECUTE_DISCRIMINATOR } from './engine.js';
import type { EnginePdas } from './pda.js';

// The handful of v12 opcode bytes the writer emits, mirrored from the engine
// ISA (svm/programs/engine/src/opcode.rs).
const OP_STOP = 0x00;
const OP_BYTE_1 = 0x01;
const OP_BYTE_2 = 0x02;
const OP_BYTES = 0x90;
const OP_BYTES_2 = 0x91;
const OP_SSTORE = 0xc5;

/** Minimal BYTE_N push of an unsigned scalar (offsets/indices — all ≤ 65535 here). */
function pushScalar(value: number): number[] {
  if (value <= 0xff) return [OP_BYTE_1, value];

  if (value <= 0xffff) return [OP_BYTE_2, (value >> 8) & 0xff, value & 0xff];

  throw new Error(`writer scalar ${value} exceeds the 2-byte push this builder emits`);
}

/** Inline BYTES literal push (BYTES_2's u16 count is big-endian, like all v12 immediates). */
function pushBytesLiteral(bytes: Uint8Array): number[] {
  if (bytes.length <= 0xff) return [OP_BYTES, bytes.length, ...bytes];

  if (bytes.length <= 0xffff) return [OP_BYTES_2, (bytes.length >> 8) & 0xff, bytes.length & 0xff, ...bytes];

  throw new Error(`bytes literal of ${bytes.length} bytes exceeds the 65535-byte BYTES_2 cap`);
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;

  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error(`invalid hex bytes value: ${hex}`);

  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

/** Encodes one runtime value against its layout slot (scalar → 32B LE, bytes → raw). */
export function encodeArgSlot(slot: ArgsLayoutSlot, value: ArgValue): Uint8Array {
  if (slot.kind === 'scalar') {
    if (typeof value !== 'bigint') {
      throw new Error(`arg ${slot.arg} is a scalar slot; got ${Array.isArray(value) ? 'array' : typeof value}`);
    }

    if (value < 0n || value >= 1n << 256n) throw new Error(`arg ${slot.arg} out of u256 range`);

    const bytes = new Uint8Array(32);
    let v = value;
    for (let i = 0; i < 32 && v > 0n; i++) {
      bytes[i] = Number(v & 0xffn);
      v >>= 8n;
    }

    return bytes;
  }

  if (typeof value !== 'string') {
    throw new Error(`arg ${slot.arg} is a bytes slot; got ${Array.isArray(value) ? 'array' : typeof value}`);
  }

  const bytes = hexToBytes(value);

  if (bytes.length !== slot.length) {
    throw new Error(`arg ${slot.arg} bytes length ${bytes.length} does not match the compiled slot length ${slot.length}`);
  }

  return bytes;
}

/**
 * Builds the args-writer bytecode: for each slot, push the encoded value as an
 * inline BYTES literal, push the slot offset, push the args-PDA account index,
 * SSTORE — then STOP. The engine permits the writes because the target is a
 * KIND_ARGS account at offsets ≥ 32.
 */
export function buildArgsWriterBytecode(layout: ArgsLayout, values: readonly ArgValue[]): Uint8Array {
  if (values.length !== layout.slots.length) {
    throw new Error(`argsLayout has ${layout.slots.length} slots but ${values.length} values were provided`);
  }

  const parts: number[] = [];
  layout.slots.forEach((slot, i) => {
    parts.push(...pushBytesLiteral(encodeArgSlot(slot, values[i])));
    parts.push(...pushScalar(slot.offset));
    parts.push(...pushScalar(layout.accountIndex));
    parts.push(OP_SSTORE);
  });
  parts.push(OP_STOP);

  return new Uint8Array(parts);
}

export interface ArgsWriteInstructionInput {
  programId: Address;
  pdas: EnginePdas;
  /** The in-list signer (memory owner) — the fee payer in the SDK flows. */
  payer: Address;
  layout: ArgsLayout;
  values: readonly ArgValue[];
}

/**
 * Builds the same-tx inline execute instruction that writes fresh args into
 * the owner's args PDA. User tail mirrors the staged convention — args PDA at
 * user index 0 (writable), the payer signer at index 1 — and the writer
 * bytecode SSTOREs against index 0, so the write lands exactly where the
 * staged program's prologue reads.
 */
export function buildArgsWriteInstruction({ programId, pdas, payer, layout, values }: ArgsWriteInstructionInput): Instruction {
  const bytecode = buildArgsWriterBytecode(layout, values);
  const data = new Uint8Array(EXECUTE_DISCRIMINATOR.length + bytecode.length);
  data.set(EXECUTE_DISCRIMINATOR, 0);
  data.set(bytecode, EXECUTE_DISCRIMINATOR.length);

  return {
    programAddress: programId,
    accounts: [
      { address: pdas.stack.address, role: AccountRole.WRITABLE },
      { address: pdas.heap.address, role: AccountRole.WRITABLE },
      { address: pdas.frames.address, role: AccountRole.WRITABLE },
      { address: pdas.args.address, role: AccountRole.WRITABLE },
      { address: payer, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };
}
