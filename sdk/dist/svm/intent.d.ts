import type { Address } from '@solana/kit';
import { type DecodedSvmSettleExecution, type SvmSettleExecutionVerification } from './verify.js';
/** One attached account, as the Portal `SerializableAccountMeta` struct serializes it. */
export interface PortalAccountMeta {
    pubkey: Address;
    isSigner: boolean;
    isWritable: boolean;
}
/** The decoded Portal `CalldataWithAccounts` envelope: the wrapped CPI instruction data and its accounts. */
export interface PortalCalldataWithAccounts {
    /** The wrapped instruction data — for a Sauce call, the `execute_from_account` payload. */
    instructionData: Uint8Array;
    /** The `account_count` the envelope declares (Portal's own count of the wrapped accounts). */
    accountCount: number;
    /** The attached account metas, in order. */
    accounts: PortalAccountMeta[];
}
/** `Uint8Array` as-is; a `0x`-prefixed hex string (the viem `Hex` form `route.calls[].data` uses); or a
 *  base64 string (the Solana convention) for anything not 0x-prefixed. */
export type BytesInput = Uint8Array | string;
/**
 * Decodes a Portal `CalldataWithAccounts` envelope (the form of every SVM `route.calls[].data`) into the
 * wrapped instruction data and its account list. Accepts the envelope as raw bytes, `0x`-hex (the viem
 * `Hex` a call carries), or base64. Throws on a truncated / malformed envelope.
 */
export declare function decodePortalCalldataWithAccounts(data: BytesInput): PortalCalldataWithAccounts;
/** An intent call, duck-typed to the one field this reads. Matches eco-solver's `Call` / persisted
 *  `IntentCall` (both carry `data` as viem `Hex`). */
export interface SvmIntentCallLike {
    data: BytesInput;
}
/** An intent, duck-typed to just the SVM route calls this reads. */
export interface SvmIntentLike {
    route: {
        calls: readonly SvmIntentCallLike[];
    };
}
export interface ExtractSvmSettleOptions {
    /** The staged settle bytecode (`sauceStage.buffers[settleIdx].bytecode`), as bytes / base64 / 0x-hex.
     *  When supplied, the result is verified (genuineness + pin↔bytecode); when omitted, args + accounts
     *  are still fully decoded from the call alone. */
    bytecode?: BytesInput;
}
/** The decoded settle for a call — always the full `decodeSvmSettleExecution` result, extended with the
 *  call's index; when `bytecode` was supplied it additionally carries the verify fields. */
export type ExtractedSvmSettle = (DecodedSvmSettleExecution | SvmSettleExecutionVerification) & {
    /** Index of the `route.calls[]` entry the settle execution was found in. */
    callIndex: number;
};
/**
 * Scans SVM intent calls and returns the settle execution from the first call that decodes as one — the
 * SVM twin of `extractEvmSettleFromCalls`. Each call is a Portal envelope; the settle call is found by
 * CONTENT (its wrapped instruction decodes cleanly as a settle execution — right account count, a
 * 128-byte settle args tail), so a swap call or a non-Sauce call is skipped, not misread. Returns `null`
 * if no call carries a settle execution.
 */
export declare function extractSvmSettleFromCalls(calls: readonly SvmIntentCallLike[], options?: ExtractSvmSettleOptions): ExtractedSvmSettle | null;
/**
 * Extracts the SVM settle params + resolved account identities from an intent object — the thin
 * intent-level wrapper over `extractSvmSettleFromCalls`, and the SVM twin of `extractEvmSettleFromIntent`.
 * Duck-typed on `{ route: { calls } }`, so it takes an eco-solver `Intent` (runtime or persisted) as-is.
 * Pass `options.bytecode` (from the intent's `fulfillmentMetadata.svm.sauceStage`) to additionally verify
 * the program is genuine. `null` if the intent carries no settle execution.
 */
export declare function extractSvmSettleFromIntent(intent: SvmIntentLike, options?: ExtractSvmSettleOptions): ExtractedSvmSettle | null;
//# sourceMappingURL=intent.d.ts.map