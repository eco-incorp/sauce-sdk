import type { Address, Instruction } from '@solana/kit';
import type { ResolvedAccountMeta } from './resolve.js';
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
export declare function buildExecuteInstruction({ programId, bytecode, accounts }: ExecuteInstructionInput): Instruction;
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
export declare function buildExecuteFromAccountInstruction({ programId, buffer, accounts, expectedSha256, args, }: ExecuteFromAccountInstructionInput): Instruction;
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
export declare function buildInitBufferInstructions({ programId, payer, buffer, index, capacity, currentBytes, }: InitBufferInstructionsInput): Instruction[];
export interface WriteBufferInstructionInput {
    programId: Address;
    authority: Address;
    buffer: Address;
    /** Byte offset into the bytecode region (not the account) — chunks may land in any order. */
    offset: number;
    chunk: Uint8Array;
}
export declare function buildWriteBufferInstruction({ programId, authority, buffer, offset, chunk }: WriteBufferInstructionInput): Instruction;
export interface FinalizeBufferInstructionInput {
    programId: Address;
    authority: Address;
    buffer: Address;
    /** The exact bytecode length — the engine hashes data[80..80+length] on-chain. */
    length: number;
    /** sha256 of the bytecode; a mismatch (straggler write, hole) fails loudly, state unchanged. */
    sha256: Uint8Array;
}
export declare function buildFinalizeBufferInstruction({ programId, authority, buffer, length, sha256 }: FinalizeBufferInstructionInput): Instruction;
export interface CloseBufferInstructionInput {
    programId: Address;
    /** Receives the drained rent; must sign. Finalized buffers close too (the recompile path). */
    authority: Address;
    buffer: Address;
}
export declare function buildCloseBufferInstruction({ programId, authority, buffer }: CloseBufferInstructionInput): Instruction;
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
    transactions: {
        init: number;
        writes: number;
        finalize: number;
        execute: number;
        total: number;
    };
}
/** Mirrors the engine's staging protocol batching (spec §2.5/§6.3). */
export declare function buildStagingPlan(bytecodeLength: number, chunkBytes?: number): StagingPlan;
//# sourceMappingURL=instructions.d.ts.map