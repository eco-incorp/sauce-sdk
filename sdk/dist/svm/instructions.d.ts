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
/**
 * Explicit bytecode extent within a FOREIGN account: run `data[offset..offset+len]`.
 * Only meaningful on the foreign path (an account the engine does not own / cannot
 * parse as a buffer header) — it lets a consumer hold bytecode in its own program's
 * accounts without a storage program. For a MANAGED buffer the engine derives the
 * extent from the header, and accepts an explicit slice ONLY if it equals
 * `(BUFFER_HEADER_BYTES, header.len)`; omit it for managed buffers.
 */
export interface ExecuteBytecodeSlice {
    offset: number;
    len: number;
}
export interface ExecuteFromAccountInstructionInput {
    programId: Address;
    /** The bytecode account — listed FIRST and read-only. A finalized engine buffer (managed) or any other account (foreign). */
    buffer: Address;
    accounts: readonly ResolvedAccountMeta[];
    /**
     * Optional 32-byte content-hash pin (managed path): must equal the buffer's
     * stored content_sha256 or the engine rejects (BufferHashMismatch). The only
     * cross-lifecycle trust anchor — always pass it for buffers this process did
     * not stage itself. On the FOREIGN path a pin is InvalidInstruction (no stored
     * hash to compare), so pass a slice instead, not a pin.
     */
    expectedSha256?: Uint8Array;
    /**
     * Optional explicit bytecode extent for the FOREIGN path (see ExecuteBytecodeSlice).
     * Omit for a managed engine buffer.
     */
    slice?: ExecuteBytecodeSlice;
    /**
     * Per-execution payload args (already encoded — encodePayloadArgs), appended
     * after the flags byte, optional pin, and optional slice. Surfaces to the
     * bytecode through CALLDATA as the composite `buffer bytecode ++ args`.
     */
    args?: Uint8Array;
}
/**
 * Builds the staged/foreign execute instruction. Account order is
 * [code (read-only), ...user] — the code account rides FIRST so the user tail
 * (and every account index baked into compiled bytecode) is byte-identical to
 * inline execute's list. The engine dispatches on the ACCOUNT (engine-owned +
 * header-parseable ⇒ managed; anything else ⇒ foreign), never on a payload flag.
 */
export declare function buildExecuteFromAccountInstruction({ programId, buffer, accounts, expectedSha256, slice, args, }: ExecuteFromAccountInstructionInput): Instruction;
export interface ExecuteAndCloseInstructionInput {
    programId: Address;
    /** The managed engine buffer to run then reap — listed FIRST and WRITABLE (it gets resized to 0). */
    buffer: Address;
    /**
     * The user account tail. It MUST include the buffer's authority as a
     * signer+writable account (it receives the rent refund); the engine finds it
     * by key match, not by position. Managed-only — a foreign account rejects.
     */
    accounts: readonly ResolvedAccountMeta[];
    /** Optional 32-byte content-hash pin — gates the execute AND the close together (TOCTOU-free). */
    expectedSha256?: Uint8Array;
    args?: Uint8Array;
}
/**
 * Builds execute_and_close: run a managed buffer and reap it (drain rent to the
 * authority, resize to 0, reassign to system) in ONE atomic instruction. Use this
 * instead of an execute_from_account + close_buffer pair: the execute needs the
 * buffer read-only and the close needs it writable, and account writability is a
 * transaction-level property — so the pair can never share a transaction. The
 * fixed prefix stays ONE account (buffer), so baked account indices agree with
 * execute_from_account. No slice: managed only.
 */
export declare function buildExecuteAndCloseInstruction({ programId, buffer, accounts, expectedSha256, args, }: ExecuteAndCloseInstructionInput): Instruction;
export interface InitBufferInstructionsInput {
    programId: Address;
    /** Pays rent and becomes the buffer AUTHORITY (only key allowed to write/finalize/grow/close). */
    payer: Address;
    buffer: Address;
    /**
     * The 32-byte PDA seed (must match the one `deriveBufferPda` derived `buffer`
     * from). Stored in the header, so the address stays re-derivable from the
     * account alone. A caller with a natural 32-byte id (e.g. an intent hash) uses
     * it directly; a shorter id is the caller's to hash.
     */
    seed: Uint8Array;
    /** Bytecode capacity in bytes (≤ 65,535); account size = BUFFER_HEADER_BYTES + capacity. */
    capacity: number;
    /** Current account data length (0 = not created); emits only the missing growth steps. */
    currentBytes?: number;
}
/**
 * Builds the create-then-grow init sequence for a bytecode buffer. Capacity
 * ≤ ~10,128 is one instruction; a 16 KB buffer is 2 — all packable into one
 * transaction. Payload is `seed[32] ++ capacity u32 LE` (exactly 36 bytes) on
 * every step (the engine grows toward BUFFER_HEADER_BYTES + capacity per
 * invocation; at/above target is a no-op). The seed is fixed across steps — the
 * engine records it once at create and rejects a mismatch thereafter.
 */
export declare function buildInitBufferInstructions({ programId, payer, buffer, seed, capacity, currentBytes, }: InitBufferInstructionsInput): Instruction[];
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
export interface CloseBufferCheckedInstructionInput {
    programId: Address;
    /** Receives the drained rent; must sign. */
    authority: Address;
    buffer: Address;
    /**
     * 32-byte content-hash pin — the close proceeds only if it equals the buffer's
     * stored content_sha256. TOCTOU-free: guards against closing a buffer that was
     * closed and re-init'd to different bytecode at the same address since you read it.
     */
    expectedSha256: Uint8Array;
}
/** Builds close_buffer_checked — close only if the content hash still matches. */
export declare function buildCloseBufferCheckedInstruction({ programId, authority, buffer, expectedSha256, }: CloseBufferCheckedInstructionInput): Instruction;
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