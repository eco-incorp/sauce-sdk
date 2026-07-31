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
/** Stable failure codes — safe to `switch` on. Every one of these is a REAL rejection this
 *  decoder makes; `NON_MINIMAL_PUSH`, `OVERSIZE_ADDRESS`, and `ZERO_RECIPIENT` are the three
 *  gaps the recipes package's original decoder did NOT check (all three independently confirmed
 *  to validate `ok:true` against it). */
export type SettleFailureCode = "EMPTY" | "TRUNCATED_PUSH" | "NON_MINIMAL_PUSH" | "OVERSIZE_ADDRESS" | "NOT_SETTLE_SHAPED" | "ARITY_MISMATCH" | "TRUNCATED_MINOUT" | "TRUNCATED_RECIPIENT" | "ZERO_RECIPIENT" | "BODY_LENGTH" | "BODY_HASH" | "TEMPLATE_REVOKED"
/** The pinned-root match itself was internally inconsistent (a matched entry with no `id`) —
 *  see `internal/root-testing.ts`'s fail-closed guard. Reachable only through that file's
 *  test-only `root` parameter; `SETTLE_TEMPLATES` itself never produces this. */
 | "INTERNAL_INCONSISTENT"
/** `opts.rederivedBodyHash` (the producer's own independently-recompiled hash) disagreed with
 *  this program's actual body hash — see `VerifyOpts.rederivedBodyHash`'s doc. Distinct from
 *  `BODY_HASH` (which means "the pinned table rejected this body"): this means "the producer's
 *  own cross-check disagrees with what it is reporting on". */
 | "PRODUCER_HASH_DIVERGED" | "EXPECT_RECIPIENT" | "EXPECT_TOKENS" | "EXPECT_MINOUT" | "EXPECT_FLOOR_TOKEN"
/** A blocking check that was NEVER COMPARED against a caller expectation — distinct from the
 *  EXPECT_* codes above (which mean "compared and mismatched"). `inspectSettleProgram` sets this
 *  for `intent.recipient`/`intent.tokens` on EVERY call (it takes no expectation, ever — see
 *  report.ts's module doc for why that is what keeps `ok` from reading true for a program whose
 *  intent was never checked). `verifySettleProgram` sets it for `intent.floorToken` when the
 *  caller supplied `minOut`/`minMinOut` but pinned neither `floorToken` nor an exact `tokens`
 *  list — the settle floor's target token would otherwise be unverified even though a floor
 *  value was requested (see the FULL_BALANCE_SWEEP disclosure). */
 | "INTENT_UNCHECKED";
export declare class SettleDecodeError extends Error {
    readonly code: SettleFailureCode;
    constructor(code: SettleFailureCode, message: string);
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
/** Internal parse result — used by both the throwing `decodeSettleProgram` and the
 *  report-building surface in `report.ts`, which needs to keep going (and keep partial state)
 *  past a failure rather than throwing. */
export interface SettleParse {
    bytes: Uint8Array;
    /** Leading token pushes, in WIRE order (forward, not yet reversed) — empty if the very first
     *  byte wasn't a push. */
    tokenPushes: {
        value: bigint;
        offset: number;
        width: number;
    }[];
    /** First hard failure encountered scanning the leading token-push run, if any. */
    tokenScanError: {
        code: SettleFailureCode;
        offset: number;
        message: string;
    } | null;
    tupleOffset: number | null;
    tupleOk: boolean;
    arityOffset: number | null;
    arityByte: number | null;
    arityOk: boolean;
    minOutPush: {
        value: bigint;
        offset: number;
        width: number;
    } | null;
    minOutError: {
        code: SettleFailureCode;
        offset: number;
        message: string;
    } | null;
    recipientPush: {
        value: bigint;
        offset: number;
        width: number;
    } | null;
    recipientError: {
        code: SettleFailureCode;
        offset: number;
        message: string;
    } | null;
    recipientNonZero: boolean;
    bodyOffset: number | null;
    body: Uint8Array | null;
    bodyHash: Hex | null;
    /** The first fatal failure, in scan order — null iff the prologue is fully well-formed. */
    fatal: {
        code: SettleFailureCode;
        message: string;
    } | null;
}
/** Best-effort single left-to-right pass — never throws. This is the shared engine both
 *  `decodeSettleProgram` (throws on `parse.fatal`) and the report builders (render every stage
 *  that DID succeed even when a later stage failed) run on top of. */
export declare function parseSettleProgram(program: Hex): SettleParse;
/** Decode whenever the shape is well-formed enough to name a full `(tokens, minOut, recipient)`
 *  — even when a later, non-structural check (a nonzero-but-wrong-length body, a zero recipient)
 *  would make `decodeSettleProgram` throw. Used by the report builders so a rejected program's
 *  decoded intent is still visible to the caller debugging the rejection. */
export declare function bestEffortDecode(parse: SettleParse): DecodedSettleProgram | null;
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
export declare function decodeSettleProgram(program: Hex): DecodedSettleProgram;
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
export declare function encodeSettleProgram(tokens: readonly (bigint | `0x${string}`)[], minOut: bigint, recipient: bigint | `0x${string}`, bodyHex: Hex): Hex;
export { keccak256 };
//# sourceMappingURL=decode.d.ts.map