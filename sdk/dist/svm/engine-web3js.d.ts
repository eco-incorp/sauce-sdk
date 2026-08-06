import type { Instruction } from '@solana/kit';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { buildStagingPlan } from './instructions.js';
export { buildStagingPlan };
/** web3.js v1 account meta — the shape `TransactionInstruction.keys` uses. */
export interface Web3JsAccountMeta {
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
}
/**
 * Convert one kit `Instruction` to a web3.js v1 `TransactionInstruction`. Role decoding uses
 * kit's own `isSignerRole` / `isWritableRole`, so it tracks kit's `AccountRole` encoding rather
 * than assuming a bit layout. Byte-preserving: `data` is copied verbatim into a Buffer.
 */
export declare function toWeb3JsInstruction(ix: Instruction): TransactionInstruction;
export declare function buildInitBufferInstructions(params: {
    programId: PublicKey;
    payer: PublicKey;
    buffer: PublicKey;
    seed: Uint8Array;
    capacity: number;
    currentBytes?: number;
}): TransactionInstruction[];
export declare function buildWriteBufferInstruction(params: {
    programId: PublicKey;
    authority: PublicKey;
    buffer: PublicKey;
    offset: number;
    chunk: Uint8Array;
}): TransactionInstruction;
export declare function buildFinalizeBufferInstruction(params: {
    programId: PublicKey;
    authority: PublicKey;
    buffer: PublicKey;
    length: number;
    sha256: Uint8Array;
}): TransactionInstruction;
export declare function buildCloseBufferInstruction(params: {
    programId: PublicKey;
    authority: PublicKey;
    buffer: PublicKey;
}): TransactionInstruction;
export declare function buildCloseBufferCheckedInstruction(params: {
    programId: PublicKey;
    authority: PublicKey;
    buffer: PublicKey;
    expectedSha256: Uint8Array;
}): TransactionInstruction;
export declare function buildExecuteInstruction(params: {
    programId: PublicKey;
    bytecode: Uint8Array;
    accounts: readonly Web3JsAccountMeta[];
}): TransactionInstruction;
export declare function buildExecuteFromAccountInstruction(params: {
    programId: PublicKey;
    buffer: PublicKey;
    accounts: readonly Web3JsAccountMeta[];
    expectedSha256?: Uint8Array;
    slice?: {
        offset: number;
        len: number;
    };
    args?: Uint8Array;
}): TransactionInstruction;
export declare function buildExecuteAndCloseInstruction(params: {
    programId: PublicKey;
    buffer: PublicKey;
    accounts: readonly Web3JsAccountMeta[];
    expectedSha256?: Uint8Array;
    args?: Uint8Array;
}): TransactionInstruction;
/**
 * Derive a bytecode buffer PDA — the sync web3.js twin of the SDK's async kit `deriveBufferPda`
 * (`./pda.ts`). Same seed scheme `["buffer", authority, seed[32]]`, so it yields the identical
 * address; provided here because web3.js consumers stage synchronously.
 */
export declare function deriveBufferPda(programId: PublicKey, authority: PublicKey, seed: Uint8Array): PublicKey;
/**
 * sha256 of the bytecode — the content hash `finalize_buffer` pins and `execute` may verify. Sync
 * (node:crypto) so web3.js consumers compute the `sha256` argument for
 * `buildFinalizeBufferInstruction` inline; the kit client hashes the same bytes via async WebCrypto.
 */
export declare function bytecodeSha256(bytecode: Uint8Array): Uint8Array;
//# sourceMappingURL=engine-web3js.d.ts.map