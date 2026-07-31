/**
 * SAUCE SETTLE PROGRAM WIRE FORMAT v1 — `ecoswap-settle` on engine target v12.
 *
 * `program := PROLOGUE || BODY`. Byte 0 is the first prologue byte — there is NO header, magic,
 * version byte, or length prefix.
 *
 * ```
 * program        := token_push{N} , TUPLE , arity , minout_push , recipient_push , body
 * token_push{N}  := N PUSHes (see wire.ts) carrying tokens REVERSED: tokens[N-1], …, tokens[0]
 * TUPLE          := 0x94              ; not a legal PUSH length (0x94 > 0x20) — the array terminator
 * arity          := one RAW byte, unsigned, MUST equal N
 * minout_push    := PUSH, uint256, value = minOut          (0 = floor disabled)
 * recipient_push := PUSH, uint160,  value = recipient      (MUST be nonzero)
 * body           := remaining bytes; EXACTLY 165 bytes; keccak256(body) is template-pinned — see
 *                    template.ts
 * ```
 *
 * The body is byte-identical for every N, every minOut, and every recipient — the template is
 * helper-free (no jump-table offsets that shift with arg count) — so byte/hash equality of the
 * SUFFIX is both necessary and sufficient to prove "this is our audited template, verbatim,
 * nothing appended". Decoding the prologue ALONE proves only that the program STARTS with that
 * shape; it cannot exclude an appended transfer, branch, or unbounded call — pair `decodeSettleProgram`
 * with a body-hash check (`inspectSettleProgram`/`verifySettleProgram`, or at minimum
 * `keccak256(decoded.body)` against `template.ts`'s pinned table) before trusting the decoded
 * values as "this is our settle program".
 *
 * THIS decoder is CANONICAL/STRICT: unlike the recipes package's original in-repo decoder (which
 * predates this package and accepted three malformed shapes — see the `SettleFailureCode` docs
 * below), every PUSH is required to be minimal-length, token/recipient pushes are capped at 20
 * bytes, and a zero recipient is rejected. A program this decoder accepts is the UNIQUE byte
 * encoding of its `(tokens, minOut, recipient)` — which is exactly what makes §5 (re-encode and
 * compare, `encodeSettleProgram`) an equivalent, cheaper alternative to this scan.
 */

import { keccak256, type Hex } from "viem";
import { SETTLE_WIRE, scanMinimalPush, encodeMinimalPush } from "./wire.js";

/** Stable failure codes — safe to `switch` on. Every one of these is a REAL rejection this
 *  decoder makes; `NON_MINIMAL_PUSH`, `OVERSIZE_ADDRESS`, and `ZERO_RECIPIENT` are the three
 *  gaps the recipes package's original decoder did NOT check (all three independently confirmed
 *  to validate `ok:true` against it). */
export type SettleFailureCode =
  | "EMPTY"
  | "TRUNCATED_PUSH"
  | "NON_MINIMAL_PUSH"
  | "OVERSIZE_ADDRESS"
  | "NOT_SETTLE_SHAPED"
  | "ARITY_MISMATCH"
  | "TRUNCATED_MINOUT"
  | "TRUNCATED_RECIPIENT"
  | "ZERO_RECIPIENT"
  | "BODY_LENGTH"
  | "BODY_HASH"
  | "TEMPLATE_REVOKED"
  | "EXPECT_RECIPIENT"
  | "EXPECT_TOKENS"
  | "EXPECT_MINOUT"
  | "EXPECT_FLOOR_TOKEN"
  /** A blocking check that was NEVER COMPARED against a caller expectation — distinct from the
   *  EXPECT_* codes above (which mean "compared and mismatched"). `inspectSettleProgram` sets this
   *  for `intent.recipient`/`intent.tokens` on EVERY call (it takes no expectation, ever — see
   *  report.ts's module doc for why that is what keeps `ok` from reading true for a program whose
   *  intent was never checked). `verifySettleProgram` sets it for `intent.floorToken` when the
   *  caller supplied `minOut`/`minMinOut` but pinned neither `floorToken` nor an exact `tokens`
   *  list — the settle floor's target token would otherwise be unverified even though a floor
   *  value was requested (see the FULL_BALANCE_SWEEP disclosure). */
  | "INTENT_UNCHECKED";

export class SettleDecodeError extends Error {
  readonly code: SettleFailureCode;
  constructor(code: SettleFailureCode, message: string) {
    super(message);
    this.name = "SettleDecodeError";
    this.code = code;
  }
}

export interface DecodedSettleProgram {
  /** The swept token list, in wire order (index 0 is the FLOOR token). */
  tokens: Address20[];
  minOut: bigint;
  recipient: Address20;
  /** `tokens[0]` — the floor token, named for readability at call sites. */
  floorToken: Address20;
  /** The constant suffix — everything after the (tokens, minOut, recipient) prologue. */
  body: Hex;
  bodyHash: Hex;
  /** Byte length of the prologue (0 .. body offset). */
  prologueSize: number;
  bodySize: number;
  programSize: number;
}

/** A 20-byte address rendered as lowercase 0x-hex — deliberately NOT `viem`'s `Address` branded
 *  type: a decoded word is not proven to be a valid address until it is range-checked (which this
 *  decoder does — `OVERSIZE_ADDRESS`), and callers that want an EIP-55 checksum should
 *  `getAddress()` it themselves. */
export type Address20 = `0x${string}`;

function toAddress(value: bigint): Address20 {
  return ("0x" + value.toString(16).padStart(40, "0")) as Address20;
}

function bytesToHexLocal(bytes: Uint8Array): Hex {
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex as Hex;
}

/** Returns `null` (never throws) on malformed hex — odd length, a non-hex character, or a
 *  non-string `hex` argument entirely (a runtime caller bypassing the type system) — so
 *  `parseSettleProgram` can report it as an `EMPTY`-coded fatal rather than throwing out of a
 *  function documented to never throw. */
function hexToBytesLocal(hex: string): Uint8Array | null {
  if (typeof hex !== "string") return null;
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Internal parse result — used by both the throwing `decodeSettleProgram` and the
 *  report-building surface in `report.ts`, which needs to keep going (and keep partial state)
 *  past a failure rather than throwing. */
export interface SettleParse {
  bytes: Uint8Array;
  /** Leading token pushes, in WIRE order (forward, not yet reversed) — empty if the very first
   *  byte wasn't a push. */
  tokenPushes: { value: bigint; offset: number; width: number }[];
  /** First hard failure encountered scanning the leading token-push run, if any. */
  tokenScanError: { code: SettleFailureCode; offset: number; message: string } | null;
  tupleOffset: number | null;
  tupleOk: boolean;
  arityOffset: number | null;
  arityByte: number | null;
  arityOk: boolean;
  minOutPush: { value: bigint; offset: number; width: number } | null;
  minOutError: { code: SettleFailureCode; offset: number; message: string } | null;
  recipientPush: { value: bigint; offset: number; width: number } | null;
  recipientError: { code: SettleFailureCode; offset: number; message: string } | null;
  recipientNonZero: boolean;
  bodyOffset: number | null;
  body: Uint8Array | null;
  bodyHash: Hex | null;
  /** The first fatal failure, in scan order — null iff the prologue is fully well-formed. */
  fatal: { code: SettleFailureCode; message: string } | null;
}

/** Best-effort single left-to-right pass — never throws. This is the shared engine both
 *  `decodeSettleProgram` (throws on `parse.fatal`) and the report builders (render every stage
 *  that DID succeed even when a later stage failed) run on top of. */
export function parseSettleProgram(program: Hex): SettleParse {
  const decodedHex = hexToBytesLocal(program);
  const bytes = decodedHex ?? new Uint8Array(0);
  const result: SettleParse = {
    bytes,
    tokenPushes: [],
    tokenScanError: null,
    tupleOffset: null,
    tupleOk: false,
    arityOffset: null,
    arityByte: null,
    arityOk: false,
    minOutPush: null,
    minOutError: null,
    recipientPush: null,
    recipientError: null,
    recipientNonZero: false,
    bodyOffset: null,
    body: null,
    bodyHash: null,
    fatal: null,
  };
  if (decodedHex === null) {
    let rendered: string;
    try {
      rendered = JSON.stringify(program).slice(0, 80);
    } catch {
      // `program` was a type JSON.stringify itself rejects (e.g. a bigint) — never throw out of a
      // function documented to always return a report.
      rendered = String(program).slice(0, 80);
    }
    result.fatal = { code: "EMPTY", message: `not a valid hex string: ${rendered}` };
    return result;
  }
  if (bytes.length === 0) {
    result.fatal = { code: "EMPTY", message: "empty program" };
    return result;
  }

  let pos = 0;
  // Leading token-push run: scan while the byte at `pos` is a legal PUSH opcode (0x01..0x20).
  // 0x94 (TUPLE_OP) is > 0x20 so the loop terminates there naturally; that termination condition
  // is what lets this be a greedy, lookahead-free scan.
  for (;;) {
    const op = bytes[pos];
    if (op === undefined || op < SETTLE_WIRE.PUSH_MIN || op > SETTLE_WIRE.PUSH_MAX) break;
    const scan = scanMinimalPush(bytes, pos, SETTLE_WIRE.ADDRESS_BYTES);
    if (!scan.ok) {
      result.tokenScanError = { code: scan.code, offset: scan.offset, message: scan.message };
      result.fatal = result.fatal ?? { code: scan.code, message: scan.message };
      return result; // cannot safely continue scanning past a malformed push
    }
    result.tokenPushes.push({ value: scan.value, offset: scan.offset, width: scan.width });
    pos = scan.next;
  }
  if (result.tokenPushes.length === 0) {
    result.fatal = { code: "NOT_SETTLE_SHAPED", message: `no leading token push found at byte 0 (got 0x${bytes[0]!.toString(16)})` };
    return result;
  }

  result.tupleOffset = pos;
  if (bytes[pos] !== SETTLE_WIRE.TUPLE_OP) {
    const got = bytes[pos];
    result.fatal = {
      code: "NOT_SETTLE_SHAPED",
      message: `expected the TUPLE opcode (0x${SETTLE_WIRE.TUPLE_OP.toString(16)}) at byte ${pos} after ${result.tokenPushes.length} token push(es), got ${got === undefined ? "end of buffer" : "0x" + got.toString(16)}`,
    };
    return result;
  }
  result.tupleOk = true;
  pos += 1;

  result.arityOffset = pos;
  const arity = bytes[pos];
  if (arity === undefined) {
    result.fatal = { code: "ARITY_MISMATCH", message: "truncated after the TUPLE opcode — no arity byte" };
    return result;
  }
  result.arityByte = arity;
  if (arity !== result.tokenPushes.length) {
    result.fatal = {
      code: "ARITY_MISMATCH",
      message: `TUPLE arity byte ${arity} does not match ${result.tokenPushes.length} leading token push(es)`,
    };
    return result;
  }
  result.arityOk = true;
  pos += 1;

  const minOutScan = scanMinimalPush(bytes, pos, SETTLE_WIRE.PUSH_MAX);
  if (!minOutScan.ok) {
    const code: SettleFailureCode = minOutScan.code === "TRUNCATED_PUSH" ? "TRUNCATED_MINOUT" : minOutScan.code;
    result.minOutError = { code, offset: minOutScan.offset, message: minOutScan.message };
    result.fatal = { code, message: `minOut: ${minOutScan.message}` };
    return result;
  }
  result.minOutPush = { value: minOutScan.value, offset: minOutScan.offset, width: minOutScan.width };
  pos = minOutScan.next;

  const recipientScan = scanMinimalPush(bytes, pos, SETTLE_WIRE.ADDRESS_BYTES);
  if (!recipientScan.ok) {
    const code: SettleFailureCode = recipientScan.code === "TRUNCATED_PUSH" ? "TRUNCATED_RECIPIENT" : recipientScan.code;
    result.recipientError = { code, offset: recipientScan.offset, message: recipientScan.message };
    result.fatal = { code, message: `recipient: ${recipientScan.message}` };
    return result;
  }
  result.recipientPush = { value: recipientScan.value, offset: recipientScan.offset, width: recipientScan.width };
  result.recipientNonZero = recipientScan.value !== 0n;
  pos = recipientScan.next;
  if (!result.recipientNonZero) {
    result.fatal = result.fatal ?? { code: "ZERO_RECIPIENT", message: "recipient push decodes to the zero address" };
    // Do NOT return — body still parses so a report can show what would-be-decoded state looked like.
  }

  result.bodyOffset = pos;
  result.body = bytes.subarray(pos);
  result.bodyHash = keccak256(bytesToHexLocal(result.body));
  if (result.fatal === null && result.body.length !== 165) {
    result.fatal = { code: "BODY_LENGTH", message: `body is ${result.body.length} bytes, expected 165` };
  }
  return result;
}

function parseToDecoded(parse: SettleParse): DecodedSettleProgram | null {
  if (parse.tokenPushes.length === 0 || !parse.tupleOk || !parse.arityOk || parse.minOutPush === null || parse.recipientPush === null || parse.body === null) {
    return null;
  }
  const tokens = parse.tokenPushes
    .slice()
    .reverse()
    .map((p) => toAddress(p.value));
  return {
    tokens,
    minOut: parse.minOutPush.value,
    recipient: toAddress(parse.recipientPush.value),
    floorToken: tokens[0]!,
    body: bytesToHexLocal(parse.body) as Hex,
    bodyHash: parse.bodyHash as Hex,
    prologueSize: parse.bodyOffset ?? 0,
    bodySize: parse.body.length,
    programSize: parse.bytes.length,
  };
}

/** Decode whenever the shape is well-formed enough to name a full `(tokens, minOut, recipient)`
 *  — even when a later, non-structural check (a nonzero-but-wrong-length body, a zero recipient)
 *  would make `decodeSettleProgram` throw. Used by the report builders so a rejected program's
 *  decoded intent is still visible to the caller debugging the rejection. */
export function bestEffortDecode(parse: SettleParse): DecodedSettleProgram | null {
  return parseToDecoded(parse);
}

/**
 * Decode a settle-shaped program back into `(tokens, minOut, recipient)`. STRICT: rejects a
 * non-minimal-length push, an oversize (>20 byte) token/recipient word, and a zero recipient —
 * see this module's docstring for why. Throws `SettleDecodeError` (carrying a stable `.code`) on
 * any of the failures in `SettleFailureCode`.
 *
 * This is a STRUCTURAL decode only — it proves the program STARTS with the settle shape and ends
 * in a well-formed 165-byte suffix. It does NOT prove the suffix is OUR audited body — pair with
 * a `bodyHash` comparison against `template.ts`'s pinned table (or use `verifySettleProgram`,
 * which does both) before trusting the decoded values as "this is our settle program".
 */
export function decodeSettleProgram(program: Hex): DecodedSettleProgram {
  const parse = parseSettleProgram(program);
  if (parse.fatal) {
    throw new SettleDecodeError(parse.fatal.code, `decodeSettleProgram: ${parse.fatal.message}`);
  }
  const decoded = parseToDecoded(parse);
  if (decoded === null) {
    // Unreachable given parse.fatal === null, but keeps the return type honest.
    throw new SettleDecodeError("NOT_SETTLE_SHAPED", "decodeSettleProgram: incomplete parse");
  }
  return decoded;
}

/**
 * §5 of the wire spec — the cheaper, EQUIVALENT alternative to scan-and-check: when the caller
 * already knows the intended `(tokens, minOut, recipient)` (the normal case — they asked for the
 * swap), encode it directly and `memcmp`/hash-compare the whole program rather than decoding.
 * Given the minimality rule this produces the UNIQUE canonical encoding, so
 * `encodeSettleProgram(...) === program` is exactly equivalent to
 * `decodeSettleProgram(program)` succeeding with those values AND the body matching the pinned
 * hash — in one comparison, with no parser exposed to a hostile input at all. This is the
 * recommended non-TypeScript (Solidity/Go/Python) implementation — see `onChainVerdict` guidance
 * in this package's docs for why an on-chain form should implement §5, not §4.
 *
 * `template` defaults to `CURRENT_SETTLE_TEMPLATE`; pass an explicit entry to encode against a
 * specific (e.g. superseded, for a rollback check) template body.
 */
export function encodeSettleProgram(tokens: readonly (bigint | `0x${string}`)[], minOut: bigint, recipient: bigint | `0x${string}`, bodyHex: Hex): Hex {
  if (tokens.length === 0) throw new RangeError("encodeSettleProgram: tokens must have at least one entry");
  if (tokens.length > SETTLE_WIRE.MAX_ARITY) throw new RangeError(`encodeSettleProgram: ${tokens.length} tokens exceeds the ${SETTLE_WIRE.MAX_ARITY} arity cap`);
  const tokenValues = tokens.map((t) => (typeof t === "bigint" ? t : BigInt(t)));
  const recipientValue = typeof recipient === "bigint" ? recipient : BigInt(recipient);
  if (recipientValue === 0n) throw new RangeError("encodeSettleProgram: recipient must be nonzero");

  const parts: Uint8Array[] = [];
  for (let i = tokenValues.length - 1; i >= 0; i--) {
    parts.push(encodeMinimalPush(tokenValues[i]!, SETTLE_WIRE.ADDRESS_BYTES));
  }
  parts.push(new Uint8Array([SETTLE_WIRE.TUPLE_OP]));
  parts.push(new Uint8Array([tokenValues.length]));
  parts.push(encodeMinimalPush(minOut, SETTLE_WIRE.PUSH_MAX));
  parts.push(encodeMinimalPush(recipientValue, SETTLE_WIRE.ADDRESS_BYTES));
  const bodyBytes = hexToBytesLocal(bodyHex);
  if (bodyBytes === null) throw new RangeError(`encodeSettleProgram: bodyHex is not valid hex: ${bodyHex}`);
  parts.push(bodyBytes);

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return bytesToHexLocal(out) as Hex;
}

export { keccak256 };
