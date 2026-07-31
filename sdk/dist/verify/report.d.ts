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
 *  - `'caller'`  — the caller supplied `opts.expectedBodyHash` directly.
 *  - `'rederived'` — the caller supplied `opts.expectedBodyHash` AND labelled it as obtained by
 *    actually recompiling the template (e.g. the recipes package's own producer-side check) —
 *    NEVER set this for a hash that merely arrived alongside the program being checked (that is
 *    self-certification — see `serverEcho.bodyHash` below for the only legitimate use of a
 *    served hash). */
export type HashSource = "pinned" | "caller" | "rederived";
export interface VerifyOpts {
    /** Override the pinned table (e.g. to test against a specific historical entry). Defaults to
     *  `SETTLE_TEMPLATES`. */
    templates?: readonly TemplateEntry[];
    /** Caller-pinned expected body hash — bypasses the table lookup for the authenticity
     *  pass/fail decision entirely (the table is still consulted for the informational
     *  `template.status` row). Sets `hashSource` to `hashSourceLabel ?? 'caller'`. */
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
     *  skew between what the caller computed and what the server thinks it sent). */
    serverEchoBodyHash?: Hex;
}
export interface SettleExpectation {
    /** REQUIRED, nonzero. The entire hazard this surface guards is a caller-chosen recipient — a
     *  gate that lets you omit the one field that closes it is not a gate. Callers with genuinely
     *  no expectation should call `inspectSettleProgram` instead, which reports the same decode
     *  with the intent checks simply absent — visibly, not silently. */
    recipient: Address;
    /** Exact token list, order-sensitive (position 0 is the floor token). Mutually usable with
     *  `allowTokens`; if both are given, `tokens` (the stricter check) wins. */
    tokens?: Address[];
    /** Looser alternative to `tokens`: every decoded token must be a member of this set,
     *  order-free. Ignored when `tokens` is also supplied.
     *
     *  ⚠ `allowTokens` alone does NOT pin WHICH member sits at position 0 — the settle wire's floor
     *  token is POSITIONAL (`tokens[0]`, see `intent.floorToken`), and reordering the SAME allowed
     *  set moves the floor onto a different token without failing this check. If you also supply
     *  `minOut`/`minMinOut`, either supply `floorToken` (or the stricter, order-sensitive `tokens`)
     *  too, or the report cannot claim `ok:true` — see `intent.floorToken`'s doc below. */
    allowTokens?: Address[];
    /** Exact required `minOut`. */
    minOut?: bigint;
    /** Floor-on-the-floor: decoded `minOut` must be `>= minMinOut`. Ignored when `minOut` is also
     *  supplied (the exact check subsumes it). */
    minMinOut?: bigint;
    /** Exact required floor token — `decoded.tokens[0]` (== `decoded.floorToken`), the ONE token
     *  `minOut` is actually checked against (see FLOOR_IS_LEVEL_NOT_DELTA). Redundant (but harmless)
     *  alongside an exact `tokens` list, which already pins position 0; REQUIRED to get `ok:true`
     *  out of a `minOut`/`minMinOut` expectation when the token identity is otherwise expressed only
     *  via the order-free `allowTokens` (or not expressed at all) — see `allowTokens`'s doc above. */
    floorToken?: Address;
}
export interface SettleReportEnvelope {
    /** `checks.every(c => c.severity !== 'blocking' || c.status === 'pass')` — see the module doc.
     *  `inspectSettleProgram` NEVER supplies an expectation, so `intent.recipient`/`intent.tokens`
     *  are PERMANENTLY `'unchecked'`+`'blocking'` there (see `pushIntentChecks`), which makes `ok`
     *  PERMANENTLY `false` for every `inspectSettleProgram` call — by design: a single boolean must
     *  never read `true` for a program whose intent was never checked, and inspect mode never checks
     *  it. Use `structurallyValid`/`authentic` below for "is this genuinely our template", and
     *  `checks`/`effects` for everything else — never treat `ok:false` from `inspectSettleProgram`
     *  as a rejection signal on its own. */
    ok: boolean;
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
    effects: SettleEffect[];
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
 * makes this function's `ok` PERMANENTLY `false` — see the module doc for why that is correct, not
 * a defect: `ok` is a gate result, and this function never gates anything. Use
 * `structurallyValid`/`authentic` for "is this genuinely our template, well-formed" instead.
 */
export declare function inspectSettleProgram(program: Hex, opts?: VerifyOpts): SettleInspection;
/**
 * GATE — never throws. `expect.recipient` is REQUIRED (see `SettleExpectation`). Calls
 * `pushIntentChecks` with the REAL expectation (real pass/fail comparisons, not permanently-
 * unchecked placeholders) and derives `ok` over the full check set.
 */
export declare function verifySettleProgram(program: Hex, expect: SettleExpectation, opts?: VerifyOpts): SettleReport;
/** Render a report as fixed-width plain text — checks, then effects, then disclosures. This is
 *  the deliverable a partner pastes into a support ticket: "seeing the validation phase" is a
 *  `console.log`, not a JSON-schema exercise. */
export declare function formatSettleReport(r: SettleReport | SettleInspection): string;
//# sourceMappingURL=report.d.ts.map