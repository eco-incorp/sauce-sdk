import { type Address, type Hex } from "viem";
import { type DecodedSettleProgram, type SettleFailureCode } from "./decode.js";
export type CheckStatus = "pass" | "fail" | "unchecked";
export type CheckSeverity = "blocking" | "advisory";
/**
 * WHAT KIND of thing a check proves — the ALLOW-LIST `structurallyValid` derives from (see its
 * computation below), replacing a hand-maintained id-EXCLUSION-list (`c.id === 'body.hash'`) that
 * had to be updated by hand every time a new non-shape check was added, and would silently sink
 * `structurallyValid` for one that wasn't (as `producer.rederivedBodyHash` — `kind:'authenticity'`
 * — would have, under the old id-list rule, since it is `blocking` but not a wire-shape fact):
 *   - `'shape'`         — the wire is well-formed/canonical. Feeds `structurallyValid`.
 *   - `'authenticity'`  — whether this body is our audited template (`body.hash`,
 *     `producer.rederivedBodyHash`). Feeds `authentic`, never `structurallyValid`.
 *   - `'intent'`        — a comparison against caller-declared expectation. Feeds
 *     `intentReconciled`/`verdict`, never `structurallyValid`/`authentic` directly.
 *   - `'informational'` — never gates anything (`template.status`, `serverEcho.bodyHash`).
 */
export type CheckKind = "shape" | "authenticity" | "intent" | "informational";
export interface VerifyCheck {
    /** Stable, dot-namespaced id — safe to key a UI row on. */
    id: string;
    /** One human line. */
    title: string;
    status: CheckStatus;
    severity: CheckSeverity;
    /** See `CheckKind`'s doc — which derived field this check feeds, if any. */
    kind: CheckKind;
    /** WHAT was compared, in words. */
    compared: string;
    /** Rendered expected value (or a sentence when there is no single value, e.g. "any accepted template"). */
    expected: string;
    /** Rendered actual value. */
    actual: string;
    /** What this check proves — AND, explicitly, what it does NOT prove. */
    proves: string;
}
/** There is no number to show for a full-balance sweep — the amount IS "whatever the Pot holds
 *  at cook time", so this is a literal enum, not a numeric field. */
export type EffectAmount = "ENTIRE_POT_BALANCE";
export interface SettleEffect {
    position: number;
    token: Address;
    isFloorToken: boolean;
    amount: EffectAmount;
    to: Address;
    note: string;
}
export interface Disclosure {
    id: string;
    title: string;
    text: string;
}
/** Which root a report's authenticity check consulted. Always a first-class field, and now a
 *  CLOSED, two-value type — no string a caller passes can move it:
 *  - `'pinned'` — a body hash was computed AND compared against `SETTLE_TEMPLATES`, this
 *    package's own constant. This is the ONLY way `authentic` can ever be `true`.
 *  - `'none'`   — the program never decoded far enough to have a body hash at all (there was
 *    nothing to authenticate against anything).
 *
 *  An earlier revision of this type also carried `'caller'`/`'rederived'` — labels attached to a
 *  hash or table the CALLER supplied via `opts`. Both are DELETED, along with the `opts.templates`/
 *  `opts.expectedBodyHash`/`opts.hashSourceLabel` fields that produced them: a caller who controls
 *  both the program bytes and the table/hash checked against them can trivially construct a match
 *  with arbitrary, non-audited bytes, and no label attached to that match (however it's spelled)
 *  changes that fact. See `internal/root-testing.ts`'s header for the trust-boundary statement this
 *  deletion enforces, and `VerifyOpts.rederivedBodyHash` for the replacement a producer that
 *  genuinely recompiles its own output should use instead — a CROSS-CHECK that can only ever
 *  narrow `authentic` toward `false`, never establish it. */
export type HashSource = "pinned" | "none";
/** WHAT THE CALLER DISCLOSED about how `declaredIntent` was formed — see this module's header
 *  doc. This is a caller-supplied LABEL, not a verified fact: this module has no way to observe
 *  whether `declaredIntent` was actually formed independently of `program`, only whether the
 *  caller SAID so via `opts.intentSourceLabel`. `'server-echo'` CAPS `verdict` at
 *  `INTENT_UNCHECKED` even when every intent field matches — see `deriveVerdict`'s doc: a
 *  self-disclosed tautology (the same request that produced `program` also produced `expect`) must
 *  never read as an independently-confirmed match. `'caller'` is simply the DEFAULT when no label
 *  is given — it is NOT evidence of independence, and treating it as such is the exact mistake the
 *  FULL_BALANCE_SWEEP disclosure now calls out explicitly. */
export type IntentSource = "caller" | "server-echo" | "none";
/**
 * The single machine-gateable field. See `SettleReportEnvelope.verdict`'s doc for the full
 * derivation and what each outcome does/does not prove.
 */
export type SettleVerdict = "MALFORMED" | "NOT_OUR_TEMPLATE" | "INTENT_UNCHECKED" | "INTENT_MISMATCH" | "MATCHES_DECLARED_INTENT";
/** Whether a producer's own independently-recomputed body hash (`opts.rederivedBodyHash`) agrees
 *  with what this report itself computed from `program`. `'absent'` when the opt wasn't supplied —
 *  never rendered as a failure. See `VerifyOpts.rederivedBodyHash`'s doc for the full contract. */
export type Rederivation = "absent" | "agrees" | "disagrees";
export interface VerifyOpts {
    /** Accept a `superseded` (but not `revoked`) template as authentic. Default `true` — see this
     *  package's template-rotation design: a stale partner pin can only ever admit an OLDER version
     *  of our own audited body, never arbitrary behavior (the failure direction is availability, not
     *  safety). Set `false` for a strict deployment that must be on the current template. */
    acceptSuperseded?: boolean;
    /** The `bodyHash` an api response echoed alongside the same program — admitted ONLY as the
     *  informational `serverEcho.bodyHash` check (comparing a program to a hash shipped beside it
     *  is self-certification and proves nothing on its own; this exists purely to surface version
     *  skew between what the caller computed and what the server thinks it sent). MUST be a string
     *  — a non-string value is treated as "not supplied" rather than thrown on. Never feeds
     *  `authentic` — see `rederivedBodyHash` for the ONLY hash opt that does (and only downward). */
    serverEchoBodyHash?: Hex;
    /**
     * A CROSS-CHECK, not a credential — the inverted contract deliberately distinguishes this from
     * the deleted `expectedBodyHash`/`hashSourceLabel:'rederived'` pair. This is for a producer that
     * ACTUALLY recompiled the template it is now reporting on (e.g. the recipes package's
     * `reportOwnSettleProgram`, which passes its own `settleBodyHashV12()`) and wants that fact
     * disclosed and CHECKED — never asserted at face value:
     *   - It can only ever push `authentic` toward `false`, never establish it: `authentic` is
     *     ALWAYS decided first, purely from `body.hash` against `SETTLE_TEMPLATES` (see
     *     `internal/root-testing.ts`). This opt is compared SEPARATELY, against the program's OWN
     *     computed body hash (R vs. the report's own P) — never against the table.
     *   - Agreement (`rederivation:'agrees'`) changes nothing: a genuine producer's hash, by
     *     construction, already matches whatever the table independently decided.
     *   - Disagreement (`rederivation:'disagrees'`) FORCES `authentic:false` with
     *     `failureCode:'PRODUCER_HASH_DIVERGED'`, regardless of what the table-only decision was —
     *     a producer whose own recompiled hash doesn't match what it's reporting on is telling this
     *     report something is wrong with ITSELF, distinct from "the pinned table rejected this
     *     body". A hostile caller supplying junk here only ever harms their own report — this can
     *     never authenticate an otherwise-rejected body, only reject an otherwise-accepted one.
     *  MUST be a string — a non-string value is treated as "not supplied" (`rederivation:'absent'`).
     */
    rederivedBodyHash?: Hex;
    /** ONLY meaningful on `verifySettleProgram` (ignored by `inspectSettleProgram`, which always
     *  reports `intentSource:'none'`). Self-disclosure that `expect` is itself derived from the SAME
     *  request/data that produced the program being checked — e.g. a server building its own
     *  "expectation" from the parameters it just compiled with. Defaults to `'caller'` — that default
     *  is a LABEL, not a claim: it does NOT mean the expectation is independently-formed, only that
     *  no `'server-echo'` disclosure was made. Set `'server-echo'` so a report never implies an
     *  independent check ran when it did not — see `IntentSource`'s doc; `verdict` is CAPPED at
     *  `INTENT_UNCHECKED` under this label even on a full field match (see `deriveVerdict`). Genuine
     *  independence (forming `declaredIntent` from your own intent, before ever seeing `program`) is
     *  a property of YOUR process that this module cannot observe or verify under either label. */
    intentSourceLabel?: "caller" | "server-echo";
    /** ECHO-ONLY on `inspectSettleProgram` (ignored by `verifySettleProgram`, which always echoes
     *  its own required `expect` argument instead). Lets a server that has no independent
     *  expectation of its own still hand a downstream consumer the request-derived intent it
     *  compiled against — populating `declaredIntent` on the returned report — WITHOUT that
     *  consumer ever being told a reconciliation happened: `intentSource` stays `'none'` and
     *  `verdict` stays `INTENT_UNCHECKED` regardless of this opt. This is the replacement for the
     *  old `reportOwnSettleProgram` pattern of spreading `declaredIntent` onto an already-built
     *  report by hand after the fact — the SAME value, but produced by this module instead of
     *  mutated in afterward. */
    declaredIntent?: SettleExpectation;
}
export interface SettleExpectation {
    /** REQUIRED, nonzero. The entire hazard this surface guards is a caller-chosen recipient — a
     *  gate that lets you omit the one field that closes it is not a gate. Callers with genuinely
     *  no expectation should call `inspectSettleProgram` instead, which reports the same decode
     *  with the intent checks simply absent — visibly, not silently. */
    recipient: Address;
    /** Exact token list, order-sensitive (position 0 is the floor token). Mutually usable with
     *  `allowTokens`; if both are given, `tokens` (the stricter check) wins. MUST be an array — a
     *  non-array value is a `fail`, never a thrown exception. */
    tokens?: Address[];
    /** Looser alternative to `tokens`: every decoded token must be a member of this set,
     *  order-free. Ignored when `tokens` is also supplied. MUST be an array — a non-array value is
     *  a `fail`, never a thrown exception.
     *
     *  ⚠ `allowTokens` alone does NOT pin WHICH member sits at position 0 — the settle wire's floor
     *  token is POSITIONAL (`tokens[0]`, see `intent.floorToken`), and reordering the SAME allowed
     *  set moves the floor onto a different token without failing this check. Whenever the DECODED
     *  program itself carries a nonzero `minOut` floor, either supply `floorToken` (or the
     *  stricter, order-sensitive `tokens` list) too, or `intentReconciled` cannot be `true` — see
     *  `intent.floorToken`'s doc below; this is keyed on the PROGRAM's own floor claim, not on
     *  whether you happened to ask about `minOut`.
     *
     *  ⚠ CONTAINMENT PROVES A SUBSET, NEVER AN EQUALITY. A decoded token list that uses only SOME
     *  of `allowTokens` still passes this check — a program that never sweeps one of the tokens you
     *  allowed (its real balance left stranded, undelivered to `recipient`) is indistinguishable,
     *  under `allowTokens` alone, from one that swept everything you expected. Because of that,
     *  `allowTokens`-only reconciliation is NEVER, by itself, eligible to make `intentReconciled`
     *  `true` / `verdict` `MATCHES_DECLARED_INTENT` — the check still catches a token OUTSIDE the
     *  allowed set (`'fail'`), but a clean containment result caps out at `INTENT_UNCHECKED`, not an
     *  affirmative match. Supply the exact, order-sensitive `tokens` list whenever you need the
     *  affirmative verdict. */
    allowTokens?: Address[];
    /** Exact required `minOut`. */
    minOut?: bigint;
    /** Floor-on-the-floor: decoded `minOut` must be `>= minMinOut`. Ignored when `minOut` is also
     *  supplied (the exact check subsumes it). */
    minMinOut?: bigint;
    /** Exact required floor token — `decoded.tokens[0]` (== `decoded.floorToken`), the ONE token
     *  `minOut` is actually checked against (see FLOOR_IS_LEVEL_NOT_DELTA). Redundant (but harmless)
     *  alongside an exact `tokens` list, which already pins position 0; REQUIRED for
     *  `intentReconciled:true` whenever the DECODED program carries a nonzero `minOut` and the
     *  token identity is otherwise expressed only via the order-free `allowTokens` (or not
     *  expressed at all) — see `allowTokens`'s doc above. */
    floorToken?: Address;
}
/** Echo of the expectation actually supplied — `null` for `inspectSettleProgram` (there is never
 *  one). Present so a downstream consumer can perform its OWN reconciliation against `decoded`
 *  instead of trusting a report whose `intentSource` is `'server-echo'`/`'none'`. */
export type DeclaredIntent = SettleExpectation;
/** One swept token, restructured out of `effects[]` without the placeholder amount/note strings —
 *  the machine-readable twin of the FULL_BALANCE_SWEEP disclosure. */
export interface SweepScopeEntry {
    position: number;
    token: Address;
    isFloorToken: boolean;
    to: Address;
}
export interface SweepScope {
    /** Always `true` — every listed token moves at its ENTIRE current Pot balance, never a trade
     *  delta. See the FULL_BALANCE_SWEEP disclosure. A literal constant so a consumer can branch on
     *  it without parsing prose. */
    unbounded: true;
    /** Always `'BALANCE_LEVEL'` — the sweep reads a balance LEVEL at cook time, never a pre/post
     *  delta. */
    basis: "BALANCE_LEVEL";
    /** Empty unless `structurallyValid && authentic` — a behavioral claim about a rejected or
     *  unauthenticated program would be meaningless. Identical rows to `effects[]`, restructured. */
    tokens: SweepScopeEntry[];
}
/** The machine-readable twin of the FLOOR_IS_LEVEL_NOT_DELTA disclosure — what the DECODED
 *  program itself claims about its floor, independent of whether any expectation about it was
 *  supplied or matched. */
export interface FloorClaim {
    /** Whether the decoded program carries a nonzero `minOut` floor at all. */
    present: boolean;
    /** `decoded.floorToken` — the token `minOut` is checked against. `null` when `present` is
     *  `false` or the program did not decode. */
    token: Address | null;
    /** `decoded.minOut`. `null` when `present` is `false` or the program did not decode. */
    minOut: bigint | null;
    /** Always `'BALANCE_LEVEL'` — `minOut` is checked against a whole-balance LEVEL at settle time,
     *  never a pre/post-swap delta. See FLOOR_IS_LEVEL_NOT_DELTA. */
    basis: "BALANCE_LEVEL";
    /** Always `false` — an UNSPLIT cook's floor is a DELTA (`outBal - outBal0`); this floor is a
     *  LEVEL. They are never the same guarantee — this field exists so a consumer can branch on
     *  that fact instead of relying on prose to say so. */
    comparableToUnsplitFloor: false;
}
export interface SettleReportEnvelope {
    /**
     * THE SINGLE MACHINE-GATEABLE FIELD. Its NAME states its own relativity — no reader can mistake
     * "these bytes are well-formed" or "the server echoed its own request back to itself" for "this
     * matches what an independent party asked for":
     *
     *   - `MALFORMED`               — `structurallyValid` is `false`: a blocking shape/body-size
     *                                 check failed.
     *   - `NOT_OUR_TEMPLATE`        — `structurallyValid` is `true` but `authentic` is `false`:
     *                                 `body.hash` matches no accepted template.
     *   - `INTENT_UNCHECKED`        — `structurallyValid && authentic`, but `intentReconciled` is
     *                                 `null`: either NO expectation was ever supplied
     *                                 (`inspectSettleProgram`, ALWAYS this case), or a REQUIRED
     *                                 identity check (the settle floor's target token, whenever the
     *                                 decoded program carries a nonzero `minOut`) was left unpinned.
     *                                 NEVER read this as "safe" — this is the exact verdict a
     *                                 cook-proven 777e18 drain reports, because a program that sweeps
     *                                 an unrelated token to an attacker's address is, byte-for-byte,
     *                                 our audited template — the bytes alone cannot refute it.
     *   - `INTENT_MISMATCH`         — `intentReconciled` is `false`: every required intent
     *                                 comparison actually ran and at least one did not match.
     *   - `MATCHES_DECLARED_INTENT` — `intentReconciled` is `true` AND `intentSource` is `'caller'`:
     *                                 every required intent comparison ran and ALL matched the
     *                                 `declaredIntent` you passed in. This proves ONLY that
     *                                 agreement — it is NOT proof that `declaredIntent` was formed
     *                                 independently of `program` (this module cannot observe that;
     *                                 see the `intentSource` doc above and the FULL_BALANCE_SWEEP
     *                                 disclosure). It is meaningful ONLY when the caller itself
     *                                 authored `declaredIntent`, before ever seeing `program`, from
     *                                 the caller's own prior intent.
     *                                 `intentSource:'server-echo'` CAPS this outcome to
     *                                 `INTENT_UNCHECKED` even on a full field match — see
     *                                 `deriveVerdict`'s doc: a self-disclosed tautology (the same
     *                                 request produced both `program` and `expect`) must never read
     *                                 as an independently-confirmed match. `intentSource:'none'`
     *                                 (`inspectSettleProgram`, always) can never reach this outcome
     *                                 at all — `intentReconciled` is structurally never `true` there.
     */
    verdict: SettleVerdict;
    /** `true`/`false`/`null` twin of `verdict`'s intent half. `null` — not fully compared (no
     *  expectation supplied, a required identity check left unpinned, or `intentSource` was
     *  `'server-echo'` and got capped — see `deriveVerdict`). `false` — fully compared, at least one
     *  field did not match. `true` — fully compared, every field matched, AND `intentSource` was
     *  `'caller'`. ALWAYS `null` for `inspectSettleProgram`. */
    intentReconciled: boolean | null;
    /** WHO authored `declaredIntent` — see this module's header doc and `IntentSource`. */
    intentSource: IntentSource;
    /** The expectation actually supplied, verbatim — `null` for `inspectSettleProgram` UNLESS
     *  `opts.declaredIntent` was supplied (a pure ECHO in that case — never reconciled, `intentSource`
     *  stays `'none'` regardless). Lets a downstream consumer reconcile `decoded` against its OWN
     *  copy of intent rather than trusting a self-authored comparison. */
    declaredIntent: DeclaredIntent | null;
    mode: "verify" | "inspect";
    templateId: string | null;
    templateVersion: string | null;
    hashSource: HashSource;
    /** See `VerifyOpts.rederivedBodyHash`'s doc — `'absent'` when that opt wasn't supplied,
     *  otherwise whether it agreed with this report's own computed body hash. A `'disagrees'` value
     *  co-occurs with `authentic:false` and `failureCode:'PRODUCER_HASH_DIVERGED'` by construction. */
    rederivation: Rederivation;
    /** Every blocking `kind:'shape'` check passes — the bytes are a well-formed, canonical
     *  `(tokens, minOut, recipient) || body[165]` wire program. Says NOTHING about whose program it
     *  is or what tokens/recipient it names. */
    structurallyValid: boolean;
    /** `body.hash` matches an entry in `SETTLE_TEMPLATES` — this package's OWN pinned constant,
     *  never a caller-supplied table or hash (see `HashSource`'s doc) — whose `status` is on the
     *  accept allow-list, AND (when supplied) `opts.rederivedBodyHash` agreed. Independent of
     *  `structurallyValid` (a malformed prologue can front an otherwise-authentic body suffix, and
     *  vice versa) and, like it, says NOTHING about tokens/recipient/minOut intent. */
    authentic: boolean;
    failureCode: SettleFailureCode | null;
    decoded: DecodedSettleProgram | null;
    checks: VerifyCheck[];
    /** Kept for back-compat — identical rows to `sweepScope.tokens`, in the older shape (with the
     *  placeholder `amount`/`note` strings). New code should read `sweepScope`. */
    effects: SettleEffect[];
    /** Machine-readable twin of the FULL_BALANCE_SWEEP disclosure. */
    sweepScope: SweepScope;
    /** Machine-readable twin of the FLOOR_IS_LEVEL_NOT_DELTA disclosure. */
    floorClaim: FloorClaim;
    disclosures: Disclosure[];
}
export type SettleInspection = SettleReportEnvelope & {
    mode: "inspect";
};
export type SettleReport = SettleReportEnvelope & {
    mode: "verify";
};
/**
 * SEE — never throws, requires no expectations. This is the "show me the validation phase" call:
 * renders EVERY check `verifySettleProgram` would (shape/body/template/producer/serverEcho AND the
 * four `intent.*` rows — see `pushIntentChecks`), with no expectation to compare against, ever.
 * Because of that, `intent.recipient`/`intent.tokens` are PERMANENTLY `'unchecked'`+`'blocking'`,
 * which makes `intentReconciled` PERMANENTLY `null` and `verdict` PERMANENTLY `INTENT_UNCHECKED`
 * (unless the bytes are malformed or inauthentic, which take priority) — this is correct, not a
 * defect: this function never has an independent expectation to reconcile against. Use
 * `structurallyValid`/`authentic` for "is this genuinely our template, well-formed" instead.
 *
 * `opts.declaredIntent`, if supplied, is echoed VERBATIM into the returned `declaredIntent` — a
 * pure echo, never reconciled: `intentSource` stays `'none'` and `verdict` stays capped at
 * `INTENT_UNCHECKED` regardless, exactly as if it had been omitted. This lets a server with no
 * independent expectation of its own still hand a downstream consumer the request-derived intent
 * it compiled against, for that consumer's OWN reconciliation — see `VerifyOpts.declaredIntent`.
 */
export declare function inspectSettleProgram(program: Hex, optsIn?: VerifyOpts): SettleInspection;
/**
 * GATE — never throws. `expect.recipient` is REQUIRED (see `SettleExpectation`). Calls
 * `pushIntentChecks` with the REAL expectation (real pass/fail comparisons, not permanently-
 * unchecked placeholders) and derives `verdict`/`intentReconciled` over the full check set.
 * `intentSource` is `'caller'` by default — pass `opts.intentSourceLabel:'server-echo'` to
 * disclose that `expect` is itself derived from the same request/data that produced `program`
 * (see `VerifyOpts.intentSourceLabel`'s doc). Under `'server-echo'`, `verdict` is CAPPED at
 * `INTENT_UNCHECKED` even on a full field match — see `deriveVerdict`.
 */
export declare function verifySettleProgram(program: Hex, expect: SettleExpectation, optsIn?: VerifyOpts): SettleReport;
/** B3: `formatSettleReport` is documented (see `jsonSafe`'s doc above) to never throw, but that
 *  guarantee used to hold only for a genuine `SettleReport`/`SettleInspection` value — a runtime
 *  caller bypassing the type system (`null`, `undefined`, `{}`, or any object missing a field this
 *  renderer assumed present) crashed immediately: `r.mode` on `null`/`undefined` before a single
 *  line was even built, `for (const c of r.checks)` on a value with no `checks` array at all. Every
 *  field this function reads is now read DEFENSIVELY — a missing/garbage container renders a
 *  placeholder instead of throwing, exactly the "guard the elements, don't just guard the
 *  container" fix `internal/root-testing.ts`'s `matchInRoot` needed for the same reason. */
export declare function formatSettleReport(r: SettleReport | SettleInspection): string;
//# sourceMappingURL=report.d.ts.map