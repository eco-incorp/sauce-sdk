/**
 * Constants mirrored from the SVM engine crate (sauce repo, svm/programs/engine).
 * That crate is the single source of truth — any change there must be reflected
 * here, byte for byte.
 *
 * Discriminators are Anchor-style: sha256("global:<instruction_name>")[..8].
 */

export const EXECUTE_DISCRIMINATOR = new Uint8Array([0x82, 0xdd, 0xf2, 0x9a, 0x0d, 0xc1, 0xbd, 0x1d]);
export const INIT_STACK_DISCRIMINATOR = new Uint8Array([0xe2, 0x74, 0x1c, 0x78, 0x56, 0x04, 0x15, 0xbc]);
export const INIT_HEAP_DISCRIMINATOR = new Uint8Array([0x7b, 0x3e, 0x07, 0x35, 0xfa, 0x4d, 0x90, 0x67]);
export const INIT_FRAMES_DISCRIMINATOR = new Uint8Array([0xed, 0x41, 0x89, 0x2a, 0x39, 0xba, 0x12, 0x8d]);

/** PDA seeds — each engine PDA is derived from a single literal seed. */
export type EnginePdaSeed = 'stack' | 'heap' | 'frames';
export const STACK_SEED: EnginePdaSeed = 'stack';
export const HEAP_SEED: EnginePdaSeed = 'heap';
export const FRAMES_SEED: EnginePdaSeed = 'frames';

/** Full PDA sizes: 1 bump byte + payload (stack 1024*33, heap u16::MAX, frames 4*(256+256)*33). */
export const PDA_STACK_BYTES = 33793;
export const PDA_HEAP_BYTES = 65536;
export const PDA_FRAMES_BYTES = 67585;
/** MAX_PERMITTED_DATA_INCREASE — max account growth per init instruction invocation. */
export const PDA_GROWTH_STEP = 10240;

export const MAX_RETURN_DATA = 1024;
export const MAX_CPI_ACCOUNTS = 64;
export const ENGINE_GAS_LIMIT_CU = 1_400_000;

/**
 * Synthetic CHAIN_ID values reported by the engine's CHAIN_ID opcode. The
 * devnet id is what a default `cargo build-sbf` build reports — localnet and
 * LiteSVM runs use it too; mainnet requires building with `--features mainnet`.
 */
export const ENGINE_CHAIN_IDS = {
  mainnet: 1399811149n,
  devnet: 1399811150n,
} as const;
