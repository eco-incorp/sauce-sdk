// @eco-incorp/sauce-sdk/svm/verify — extract settle params from an Eco intent's SVM calls.
//
// The EVM twin (`@eco-incorp/sauce-sdk/verify`'s `extractEvmSettleFromIntent`) reads the settle program
// straight out of a `Pot.cook(bytes[])` call, because an EVM intent's `route.calls[].data` is plain ABI
// calldata. An SVM intent is one wrapper deeper: each `route.calls[].data` is the Eco **Portal**
// program's `CalldataWithAccounts` Borsh envelope — `{ calldata: { data, account_count }, accounts:
// [{ pubkey, is_signer, is_writable }] }` — where `calldata.data` is the Sauce engine's
// `execute_from_account` instruction data (`[disc][flags][pin?][slice?][args]`) and `accounts` is that
// instruction's account list. This module decodes that envelope and hands the two halves to
// `decodeSvmSettleExecution` / `verifySvmSettleExecution`, so an external partner goes from a published
// intent to `(minOut, splCount, tokenProgram0/1)` + resolved account identities with ONLY this package.
//
// WHY THIS LIVES IN THE SDK (not in a solver adapter): this surface is for partners CONSUMING Eco
// intents, who have neither the solver's internals nor its `decodeRouteCall`. So the Portal envelope
// layout is mirrored here — it is a small, stable on-chain Anchor struct (Portal program IDL), decoded
// with `@solana/kit` codecs (no new dependency). `test/svm/intent.test.ts` pins the byte layout against
// a hand-built fixture so a Portal IDL change can't drift it silently.
//
// A partner typically holds only the on-chain `route.calls` — not the solver's staged bytecode — so
// bytecode verification is OPTIONAL: without `bytecode` you get the decoded args + resolved accounts;
// with it (from `fulfillmentMetadata.svm.sauceStage.buffers[i].bytecode`) you additionally get the
// recompile-and-byte-compare genuineness proof and the pin↔bytecode tie.
import {
  addDecoderSizePrefix,
  getArrayDecoder,
  getAddressDecoder,
  getBooleanDecoder,
  getBytesDecoder,
  getStructDecoder,
  getU8Decoder,
  getU32Decoder,
} from '@solana/kit';
import type { Address } from '@solana/kit';
import {
  decodeSvmSettleExecution,
  verifySvmSettleExecution,
  type DecodedSvmSettleExecution,
  type SvmSettleExecutionVerification,
} from './verify.js';

// ── Portal CalldataWithAccounts envelope (Eco Portal program IDL) ──

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

// Borsh (Anchor): `bytes` = u32 LE length prefix + bytes; `Vec<T>` = u32 LE length + elements;
// `bool` = 1 byte; `pubkey` = 32 bytes; `u8` = 1 byte. Field order is the IDL struct order.
const calldataDecoder = getStructDecoder([
  ['data', addDecoderSizePrefix(getBytesDecoder(), getU32Decoder())],
  ['accountCount', getU8Decoder()],
]);
const accountMetaDecoder = getStructDecoder([
  ['pubkey', getAddressDecoder()],
  ['isSigner', getBooleanDecoder()],
  ['isWritable', getBooleanDecoder()],
]);
const calldataWithAccountsDecoder = getStructDecoder([
  ['calldata', calldataDecoder],
  ['accounts', getArrayDecoder(accountMetaDecoder, { size: getU32Decoder() })],
]);

/** `Uint8Array` as-is; a `0x`-prefixed hex string (the viem `Hex` form `route.calls[].data` uses); or a
 *  base64 string (the Solana convention) for anything not 0x-prefixed. */
export type BytesInput = Uint8Array | string;

function toBytes(input: BytesInput, label: string): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (typeof input !== 'string') throw new Error(`${label} must be a Uint8Array or string, got ${typeof input}`);
  if (input.startsWith('0x') || input.startsWith('0X')) {
    const hex = input.slice(2);
    if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new Error(`${label} is not valid 0x-hex`);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    return out;
  }
  // Not 0x-prefixed → base64 (Buffer is available; this module is node-side like the rest of svm/verify).
  return new Uint8Array(Buffer.from(input, 'base64'));
}

/**
 * Decodes a Portal `CalldataWithAccounts` envelope (the form of every SVM `route.calls[].data`) into the
 * wrapped instruction data and its account list. Accepts the envelope as raw bytes, `0x`-hex (the viem
 * `Hex` a call carries), or base64. Throws on a truncated / malformed envelope.
 */
export function decodePortalCalldataWithAccounts(data: BytesInput): PortalCalldataWithAccounts {
  const bytes = toBytes(data, 'portal calldata');
  const decoded = calldataWithAccountsDecoder.decode(bytes);
  return {
    // @solana/kit's bytes decoder yields a ReadonlyUint8Array — copy to a plain Uint8Array so the
    // downstream payload parser (subarray / DataView) has a mutable, standard view.
    instructionData: new Uint8Array(decoded.calldata.data),
    accountCount: decoded.calldata.accountCount,
    accounts: decoded.accounts.map((a) => ({ pubkey: a.pubkey, isSigner: a.isSigner, isWritable: a.isWritable })),
  };
}

// ── intent extraction ──

/** An intent call, duck-typed to the one field this reads. Matches eco-solver's `Call` / persisted
 *  `IntentCall` (both carry `data` as viem `Hex`). */
export interface SvmIntentCallLike {
  data: BytesInput;
}

/** An intent, duck-typed to just the SVM route calls this reads. */
export interface SvmIntentLike {
  route: { calls: readonly SvmIntentCallLike[] };
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
export function extractSvmSettleFromCalls(
  calls: readonly SvmIntentCallLike[],
  options: ExtractSvmSettleOptions = {},
): ExtractedSvmSettle | null {
  const bytecode = options.bytecode !== undefined ? toBytes(options.bytecode, 'bytecode') : undefined;

  for (let i = 0; i < calls.length; i++) {
    let envelope: PortalCalldataWithAccounts;
    try {
      envelope = decodePortalCalldataWithAccounts(calls[i]!.data);
    } catch {
      continue; // not a decodable Portal envelope — skip
    }

    try {
      const decoded =
        bytecode !== undefined
          ? verifySvmSettleExecution({ instructionData: envelope.instructionData, accounts: envelope.accounts, bytecode })
          : decodeSvmSettleExecution({ instructionData: envelope.instructionData, accounts: envelope.accounts });
      return { ...decoded, callIndex: i };
    } catch {
      continue; // a decodable envelope, but not a settle execution — skip
    }
  }
  return null;
}

/**
 * Extracts the SVM settle params + resolved account identities from an intent object — the thin
 * intent-level wrapper over `extractSvmSettleFromCalls`, and the SVM twin of `extractEvmSettleFromIntent`.
 * Duck-typed on `{ route: { calls } }`, so it takes an eco-solver `Intent` (runtime or persisted) as-is.
 * Pass `options.bytecode` (from the intent's `fulfillmentMetadata.svm.sauceStage`) to additionally verify
 * the program is genuine. `null` if the intent carries no settle execution.
 */
export function extractSvmSettleFromIntent(intent: SvmIntentLike, options: ExtractSvmSettleOptions = {}): ExtractedSvmSettle | null {
  return extractSvmSettleFromCalls(intent.route.calls, options);
}
