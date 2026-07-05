/**
 * Constants mirrored from the SVM engine crate (sauce repo, svm/programs/engine).
 * That crate is the single source of truth — any change there must be reflected
 * here, byte for byte.
 *
 * Discriminators are Anchor-style: sha256("global:<instruction_name>")[..8].
 */

// ── instruction discriminators (all 11) ──

export const EXECUTE_DISCRIMINATOR = new Uint8Array([0x82, 0xdd, 0xf2, 0x9a, 0x0d, 0xc1, 0xbd, 0x1d]);
export const EXECUTE_FROM_ACCOUNT_DISCRIMINATOR = new Uint8Array([0x71, 0x2c, 0xd5, 0x72, 0x82, 0x95, 0x58, 0xc3]);
export const INIT_STACK_DISCRIMINATOR = new Uint8Array([0xe2, 0x74, 0x1c, 0x78, 0x56, 0x04, 0x15, 0xbc]);
export const INIT_HEAP_DISCRIMINATOR = new Uint8Array([0x7b, 0x3e, 0x07, 0x35, 0xfa, 0x4d, 0x90, 0x67]);
export const INIT_FRAMES_DISCRIMINATOR = new Uint8Array([0xed, 0x41, 0x89, 0x2a, 0x39, 0xba, 0x12, 0x8d]);
export const INIT_ARGS_DISCRIMINATOR = new Uint8Array([0x19, 0x57, 0xf3, 0x3c, 0xec, 0xdd, 0x25, 0xd5]);
export const CLOSE_MEMORY_DISCRIMINATOR = new Uint8Array([0x34, 0x8b, 0xf4, 0xd3, 0x18, 0x44, 0x08, 0xaa]);
export const INIT_BUFFER_DISCRIMINATOR = new Uint8Array([0x7b, 0xd3, 0xe9, 0xd2, 0xa6, 0x8b, 0xda, 0x3c]);
export const WRITE_BUFFER_DISCRIMINATOR = new Uint8Array([0xa4, 0xc2, 0x45, 0x9a, 0x4b, 0xa9, 0xe4, 0x55]);
export const FINALIZE_BUFFER_DISCRIMINATOR = new Uint8Array([0x21, 0x9c, 0x88, 0xb1, 0x14, 0xc3, 0x7a, 0x43]);
export const CLOSE_BUFFER_DISCRIMINATOR = new Uint8Array([0x2e, 0x72, 0xb3, 0x3a, 0x39, 0x2d, 0xc2, 0xac]);

// ── PDA seeds ──

/**
 * Memory PDA seeds. Every memory PDA is derived per (owner, session):
 * [seed, owner_pubkey, [session: u8]] — the owner is the execute instruction's
 * FIRST in-list signer, the session a u8 discriminant (SDK default 0).
 */
export type EnginePdaSeed = 'stack' | 'heap' | 'frames' | 'args';
export const STACK_SEED: EnginePdaSeed = 'stack';
export const HEAP_SEED: EnginePdaSeed = 'heap';
export const FRAMES_SEED: EnginePdaSeed = 'frames';
export const ARGS_SEED: EnginePdaSeed = 'args';
/** Bytecode buffer seed: ["buffer", authority_pubkey, [index: u8]]. */
export const BUFFER_SEED = 'buffer';

// ── memory PDA layout ──

/** Every engine-owned PDA starts with a [kind, bump, session] header. */
export const PDA_HEADER_BYTES = 3;

/** Kind bytes (header byte 0) — the SSTORE write-protection discriminant. */
export const KIND_STACK = 1;
export const KIND_HEAP = 2;
export const KIND_FRAMES = 3;
export const KIND_ARGS = 4;
export const KIND_BUFFER = 5;

/** Full PDA sizes: 3-byte header + payload (stack 1024*33, heap u16::MAX, frames 4*(256+256)*33). */
export const PDA_STACK_BYTES = 33795;
export const PDA_HEAP_BYTES = 65538;
export const PDA_FRAMES_BYTES = 67587;
/** Args PDA: a full 32-byte reserved header word + the 8,192-byte arg region. */
export const PDA_ARGS_BYTES = 8224;
/**
 * First bytecode-writable byte of the args PDA: SSTORE into an engine-owned
 * account is permitted ONLY for KIND_ARGS at offsets ≥ 32; everything else is
 * ProtectedAccount. Staged arg slots are laid out from here.
 */
export const ARGS_REGION_OFFSET = 32;
/** MAX_PERMITTED_DATA_INCREASE — max account growth per init instruction invocation. */
export const PDA_GROWTH_STEP = 10240;

// ── bytecode buffer layout (staged execution) ──

/**
 * Buffer account: an 80-byte header, then the bytecode region
 * (capacity = data_len − 80, never persisted).
 *
 *   offset  size  field
 *   0       1     kind            KIND_BUFFER
 *   1       1     bump            PDA bump seed
 *   2       1     version         BUFFER_VERSION
 *   3       1     flags           bit0 = finalized; bits 1-7 reserved (zero)
 *   4       1     index           the u8 seed discriminant
 *   5       3     reserved        zeroed
 *   8       32    authority       controls write/finalize/grow/close
 *   40      4     len             u32 LE — finalized bytecode length
 *   44      4     bytecode_epoch  u32 LE — BYTECODE_FORMAT_EPOCH at finalize
 *   48      32    content_sha256  sha256 of data[80..80+len]
 *   80      cap   bytecode
 */
export const BUFFER_HEADER_BYTES = 80;
export const BUFFER_VERSION = 1;
export const FLAG_FINALIZED = 0x01;
export const BUFFER_OFFSET_VERSION = 2;
export const BUFFER_OFFSET_FLAGS = 3;
export const BUFFER_OFFSET_INDEX = 4;
export const BUFFER_OFFSET_AUTHORITY = 8;
export const BUFFER_OFFSET_LEN = 40;
export const BUFFER_OFFSET_EPOCH = 44;
export const BUFFER_OFFSET_HASH = 48;

/**
 * u16::MAX — the last pc a 16-bit CALL_FUNCTION return address / JUMP_2 /
 * CALLDATA length can reach; a larger program could never execute.
 */
export const MAX_BUFFER_CAPACITY = 65535;

/**
 * Version of the bytecode format the engine executes; finalize stamps it into
 * the buffer and execute_from_account asserts it (BufferEpochMismatch means:
 * recompile + re-stage).
 */
export const BYTECODE_FORMAT_EPOCH = 1;

/**
 * The SDK's staging write chunk. The hard packet ceiling for a minimal
 * write_buffer transaction is ≈ 1,016 bytes of chunk; 1,000 leaves margin for
 * compute-budget prepends / address-table variance. At this chunk a 4/8/16 KB
 * program stages-and-executes in 8/12/20 transactions.
 */
export const BUFFER_WRITE_CHUNK_BYTES = 1000;

// ── execution limits ──

export const MAX_RETURN_DATA = 1024;
export const MAX_CPI_ACCOUNTS = 64;
export const ENGINE_GAS_LIMIT_CU = 1_400_000;

/**
 * Measured staged-minus-inline CU premium on identical bytecode (buffer
 * validation: one create_program_address, the header parse, the hash-pin
 * compare, the buffer's loaded-accounts contribution). Informational — the
 * engine's cu_budget suite pins it under a 5,000 CU ceiling.
 */
export const STAGED_EXECUTE_CU_PREMIUM = 2194;

/**
 * Synthetic CHAIN_ID values reported by the engine's CHAIN_ID opcode. The
 * devnet id is what a default `cargo build-sbf` build reports — localnet and
 * LiteSVM runs use it too; mainnet requires building with `--features mainnet`.
 */
export const ENGINE_CHAIN_IDS = {
  mainnet: 1399811149n,
  devnet: 1399811150n,
} as const;
