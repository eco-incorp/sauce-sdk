import { type Address, type Hex } from "viem";
import { type DecodedSettleProgram, type SettleFailureCode } from "./decode.js";
import { type TemplateEntry } from "./template.js";
export type CheckStatus = "pass" | "fail" | "unchecked";
export type CheckSeverity = "blocking" | "advisory";
export interface VerifyCheck {
    /** Stable, dot-namespaced id — safe to key a UI row on. */
    id: string;
    /** One human line. */
    title: string;
    status: CheckStatus;
    severity: CheckSeverity;
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
/** Which root a report's authenticity check trusted. Always a first-class field so no reader can
 *  be confused about which one was used:
 *  - `'pinned'`  — matched against this package's own `SETTLE_TEMPLATES` table (the default).
 *  - `'caller'`  — the caller supplied `opts.expectedBodyHash` directly, OR overrode `opts.templates`
 *    (a caller-controlled table is not this package's own root, even without a single explicit hash).
 *  - `'rederived'` — the caller supplied `opts.expectedBodyHash` AND labelled it as obtained by
 *    actually recompiling the template (e.g. the recipes package's own producer-side check) —
 *    NEVER set this for a hash that merely arrived alongside the program being checked (that is
 *    self-certification — see `serverEcho.bodyHash` below for the only legitimate use of a
 *    served hash). */
export type HashSource = "pinned" | "caller" | "rederived";
/** WHO authored `declaredIntent` — see this module's header doc. */
export type IntentSource = "caller" | "server-echo" | "none";
/**
 * The single machine-gateable field. See `SettleReportEnvelope.verdict`'s doc for the full
 * derivation and what each outcome does/does not prove.
 */
export type SettleVerdict = "MALFORMED" | "NOT_OUR_TEMPLATE" | "INTENT_UNCHECKED" | "INTENT_MISMATCH" | "MATCHES_DECLARED_INTENT";
export interface VerifyOpts {
    /** Override the pinned table (e.g. to test against a specific historical entry). Defaults to
     *  `SETTLE_TEMPLATES`. MUST be an array — a non-array value (a runtime caller bypassing the
     *  type system) is treated as "not supplied" rather than thrown on. */
    templates?: readonly TemplateEntry[];
    /** Caller-pinned expected body hash — bypasses the table lookup for the authenticity
     *  pass/fail decision entirely (the table is still consulted for the informational
     *  `template.status` row). Sets `hashSource` to `hashSourceLabel ?? 'caller'`. MUST be a
     *  string — a non-string value is treated as "not supplied" rather than thrown on. */
    expectedBodyHash?: Hex;
    /** Only meaningful together with `expectedBodyHash` — see `HashSource`. Defaults to `'caller'`. */
    hashSourceLabel?: "caller" | "rederived";
    /** Accept a `superseded` (but not `revoked`) template as authentic. Default `true` — see this
     *  package's template-rotation design: a stale partner pin can only ever admit an OLDER version
     *  of our own audited body, never arbitrary behavior (the failure direction is availability, not
     *  safety). Set `false` for a strict deployment that must be on the current template. */
    acceptSuperseded?: boolean;
    /** The `bodyHash` an api response echoed alongside the same program — admitted ONLY as the
     *  informational `serverEcho.bodyHash` check (comparing a program to a hash shipped beside it
     *  is self-certification and proves nothing on its own; this exists purely to surface version
     *  skew between what the caller computed and what the server thinks it sent). MUST be a string
     *  — a non-string value is treated as "not supplied" rather than thrown on. */
    serverEchoBodyHash?: Hex;
    /** ONLY meaningful on `verifySettleProgram` (ignored by `inspectSettleProgram`, which always
     *  reports `intentSource:'none'`). Self-disclosure that `expect` is itself derived from the SAME
     *  request/data that produced the program being checked — e.g. a server building its own
     *  "expectation" from the parameters it just compiled with. Defaults to `'caller'` (an
     *  independently-formed expectation). Set `'server-echo'` so a report never implies an
     *  independent check ran when it did not — see `IntentSource`'s doc. */
    intentSourceLabel?: "caller" | "server-echo";
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
     *  whether you happened to ask about `minOut`. */
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
     *   - `MATCHES_DECLARED_INTENT` — `intentReconciled` is `true`: every required intent
     *                                 comparison ran and ALL matched. The only verdict meaning
     *                                 "safe to cook against what was declared" — and even that is
     *                                 only as trustworthy as `intentSource`: a `'server-echo'` or
     *                                 `'none'` source means the declaration was not independent.
     */
    verdict: SettleVerdict;
    /** `true`/`false`/`null` twin of `verdict`'s intent half. `null` — not fully compared (no
     *  expectation supplied, or a required identity check left unpinned). `false` — fully compared,
     *  at least one field did not match. `true` — fully compared, every field matched. ALWAYS `null`
     *  for `inspectSettleProgram`. */
    intentReconciled: boolean | null;
    /** WHO authored `declaredIntent` — see this module's header doc and `IntentSource`. */
    intentSource: IntentSource;
    /** The expectation actually supplied, verbatim — `null` for `inspectSettleProgram` (there is
     *  never one). Lets a downstream consumer reconcile `decoded` against its OWN copy of intent
     *  rather than trusting a self-authored comparison. */
    declaredIntent: DeclaredIntent | null;
    mode: "verify" | "inspect";
    templateId: string | null;
    templateVersion: string | null;
    hashSource: HashSource;
    /** Every blocking check EXCEPT `body.hash` passes — the bytes are a well-formed, canonical
     *  `(tokens, minOut, recipient) || body[165]` wire program. Says NOTHING about whose program it
     *  is or what tokens/recipient it names. */
    structurallyValid: boolean;
    /** `body.hash` passes — the body matches an accepted (non-revoked) template entry. Independent
     *  of `structurallyValid` (a malformed prologue can front an otherwise-authentic body suffix,
     *  and vice versa) and, like it, says NOTHING about tokens/recipient/minOut intent. */
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
 * renders EVERY check `verifySettleProgram` would (shape/body/template/serverEcho AND the four
 * `intent.*` rows — see `pushIntentChecks`), with no expectation to compare against, ever. Because
 * of that, `intent.recipient`/`intent.tokens` are PERMANENTLY `'unchecked'`+`'blocking'`, which
 * makes `intentReconciled` PERMANENTLY `null` and `verdict` PERMANENTLY `INTENT_UNCHECKED` (unless
 * the bytes are malformed or inauthentic, which take priority) — this is correct, not a defect:
 * this function never has an independent expectation to reconcile against. Use
 * `structurallyValid`/`authentic` for "is this genuinely our template, well-formed" instead.
 */
export declare function inspectSettleProgram(program: Hex, opts?: VerifyOpts): SettleInspection;
/**
 * GATE — never throws. `expect.recipient` is REQUIRED (see `SettleExpectation`). Calls
 * `pushIntentChecks` with the REAL expectation (real pass/fail comparisons, not permanently-
 * unchecked placeholders) and derives `verdict`/`intentReconciled` over the full check set.
 * `intentSource` is `'caller'` by default — pass `opts.intentSourceLabel:'server-echo'` to
 * disclose that `expect` is itself derived from the same request/data that produced `program`
 * (see `VerifyOpts.intentSourceLabel`'s doc).
 */
export declare function verifySettleProgram(program: Hex, expect: SettleExpectation, opts?: VerifyOpts): SettleReport;
/** Render a report as fixed-width plain text — checks, then sweepScope/floorClaim, then
 *  disclosures. This is the deliverable a partner pastes into a support ticket: "seeing the
 *  validation phase" is a `console.log`, not a JSON-schema exercise. */
export declare function formatSettleReport(r: SettleReport | SettleInspection): string;
//# sourceMappingURL=report.d.ts.map