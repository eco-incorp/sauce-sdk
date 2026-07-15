/**
 * Constants mirrored from the SVM engine crate (sauce repo, svm/programs/engine).
 * That crate is the single source of truth — any change there must be reflected
 * here, byte for byte.
 *
 * Discriminators are Anchor-style: sha256("global:<instruction_name>")[..8].
 */

// ── instruction discriminators (all 6) ──

export const EXECUTE_DISCRIMINATOR = new Uint8Array([0x82, 0xdd, 0xf2, 0x9a, 0x0d, 0xc1, 0xbd, 0x1d]);
export const EXECUTE_FROM_ACCOUNT_DISCRIMINATOR = new Uint8Array([0x71, 0x2c, 0xd5, 0x72, 0x82, 0x95, 0x58, 0xc3]);
export const INIT_BUFFER_DISCRIMINATOR = new Uint8Array([0x7b, 0xd3, 0xe9, 0xd2, 0xa6, 0x8b, 0xda, 0x3c]);
export const WRITE_BUFFER_DISCRIMINATOR = new Uint8Array([0xa4, 0xc2, 0x45, 0x9a, 0x4b, 0xa9, 0xe4, 0x55]);
export const FINALIZE_BUFFER_DISCRIMINATOR = new Uint8Array([0x21, 0x9c, 0x88, 0xb1, 0x14, 0xc3, 0x7a, 0x43]);
export const CLOSE_BUFFER_DISCRIMINATOR = new Uint8Array([0x2e, 0x72, 0xb3, 0x3a, 0x39, 0x2d, 0xc2, 0xac]);

/**
 * execute_from_account payload flag bit 0: a 32-byte content-hash pin follows
 * the flags byte. Bits 1-7 are reserved and must be zero. The flags byte is
 * REQUIRED — an empty payload is InvalidInstruction (one canonical encoding
 * per meaning): the minimal pinless, argless payload is [0x00].
 */
export const EXECUTE_FLAG_HAS_PIN = 0x01;

// ── interpreter memory (BPF heap frame) ──

/**
 * The 256 KiB BPF heap frame every execute transaction MUST request:
 * interpreter memory (operand stack, heap, frames) lives above the default
 * 32 KiB Rust bump arena, not in accounts. Attach RequestHeapFrame(262144)
 * beside SetComputeUnitLimit on every execute/simulate transaction —
 * **add-once**: duplicate ComputeBudget instruction types fail the whole
 * transaction. A transaction without it aborts deterministically (SBF
 * AccessViolation) before any opcode runs. Buffer staging transactions do
 * not need it — their instructions never touch interpreter memory.
 */
export const HEAP_FRAME_BYTES = 262_144;

/** CU cost of the heap-frame request, charged per program invocation in the transaction. */
export const HEAP_FRAME_CU_PER_INVOCATION = 56;

/**
 * Wire cost of the RequestHeapFrame instruction: 8 bytes beside an existing
 * ComputeBudget instruction (the program key and count byte are already paid),
 * 9 standalone. Measured — engine tests/cu_budget.rs.
 */
export const REQUEST_HEAP_FRAME_WIRE_BYTES = 9;

// ── PDA seeds ──

/** Bytecode buffer seed: ["buffer", authority_pubkey, [index: u8]]. */
export const BUFFER_SEED = 'buffer';

/** Buffer header byte 0 (the engine's account-kind discriminant). */
export const KIND_BUFFER = 5;

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
 * CALLDATA length can reach; a larger program could never execute. Also the
 * ceiling of the CALLDATA composite `buffer bytecode ++ payload args`.
 */
export const MAX_BUFFER_CAPACITY = 65535;

/**
 * Version of the bytecode format the engine executes; finalize stamps it into
 * the buffer and execute_from_account asserts it (BufferEpochMismatch means:
 * recompile + re-stage). Epoch 2 = Wave D (heap-frame memory — the memory-PDA
 * account prefix is gone, so every account index baked into older bytecode
 * resolves differently; all epoch-1 buffers are dead).
 */
export const BYTECODE_FORMAT_EPOCH = 2;

/** MAX_PERMITTED_DATA_INCREASE — max account growth per init_buffer invocation. */
export const PDA_GROWTH_STEP = 10240;

/**
 * The SDK's staging write chunk. The hard packet ceiling for a minimal
 * write_buffer transaction is ≈ 1,016 bytes of chunk; 1,000 leaves margin for
 * compute-budget prepends / address-table variance. At this chunk a 4/8/16 KB
 * program stages-and-executes in 8/12/20 transactions.
 */
export const BUFFER_WRITE_CHUNK_BYTES = 1000;

// ── packet budgets (measured, engine tests/payload_args.rs) ──

/**
 * Fixed wire cost of the staged execute transaction (legacy shape): signature,
 * message overhead, both ComputeBudget instructions, the pinned
 * execute_from_account instruction, buffer + payer accounts — 293 bytes plus
 * 33 per extra user account (32-byte key + 1-byte index).
 */
export const STAGED_PACKET_FIXED_BYTES = 293;
export const STAGED_PACKET_BYTES_PER_ACCOUNT = 33;

/**
 * Payload-args budget of a pinned staged execute in the 1,232-byte packet with
 * `extraAccounts` user accounts beyond the payer: 939 − 33·N (+32 unpinned).
 * Bigger args belong in a second buffer used as a data account, read on-chain
 * with accountData.
 */
export function stagedArgsBudget(extraAccounts: number): number {
  return 1232 - STAGED_PACKET_FIXED_BYTES - STAGED_PACKET_BYTES_PER_ACCOUNT * extraAccounts;
}

// ── execution limits ──

export const MAX_RETURN_DATA = 1024;
export const MAX_CPI_ACCOUNTS = 64;
export const ENGINE_GAS_LIMIT_CU = 1_400_000;

/**
 * Measured staged-minus-inline CU premium on identical bytecode (buffer
 * validation: one create_program_address, the header parse, the hash-pin
 * compare, the payload-args parse, the buffer's loaded-accounts contribution).
 * Informational — the engine's cu_budget suite pins it under a 5,000 CU
 * ceiling; a staged 16 KB (or max-capacity) program executes in ~194,978 CU.
 */
export const STAGED_EXECUTE_CU_PREMIUM = 2216;

/**
 * Synthetic CHAIN_ID values reported by the engine's CHAIN_ID opcode. The
 * devnet id is what a default `cargo build-sbf` build reports — localnet and
 * LiteSVM runs use it too; mainnet requires building with `--features mainnet`.
 */
export const ENGINE_CHAIN_IDS = {
  mainnet: 1399811149n,
  devnet: 1399811150n,
} as const;
