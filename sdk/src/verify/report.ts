import { getAddress, type Address, type Hex } from "viem";
import { parseSettleProgram, bestEffortDecode, type DecodedSettleProgram, type SettleFailureCode } from "./decode.js";
import { SETTLE_TEMPLATES, CURRENT_SETTLE_TEMPLATE } from "./template.js";
import { authenticateBodyAgainstRoot } from "./internal/root-testing.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE VISIBLE VALIDATION SURFACE.
//
// `validateSettleProgram`-style callers historically got `{ok:false, reason:string}` — one
// boolean and one prose sentence. A LATER revision of this module replaced that with `{ok:
// boolean, checks[], effects[], disclosures[]}` — but `ok` is GONE from this revision entirely,
// because it turned out to be un-substantiable: a single boolean fuses a byte-fact ("this is our
// audited template") with a caller-authored EXPECTATION ("these are the tokens/recipient I
// wanted"), and its truth silently depends on WHO authored that expectation. Measured: a server
// that builds its own "expectation" from the SAME request that produced the bytecode gets
// `ok:true` on a cook-proven 777e18 drain — the check never independently confirmed anything, it
// just compared a value to itself.
//
// This module now reports FIVE things instead of one boolean:
//   - `structurallyValid` — every blocking `kind:'shape'` check passes (a well-formed, canonical
//     wire program). Says nothing about whose program it is.
//   - `authentic`         — `body.hash` matches an entry in `SETTLE_TEMPLATES` — this package's
//     OWN pinned constant, never a caller-supplied table (this IS our audited body, verbatim).
//     THE TRUST BOUNDARY: there is no parameter anywhere on this surface through which a caller
//     can supply or influence the table `authentic` is checked against — see
//     `internal/root-testing.ts`'s header for why, and why an earlier revision of this module
//     (which took `opts.templates`/`opts.expectedBodyHash` and let a caller's own table or hash
//     authenticate their own forgery) was wrong at the design level, not just in its edge cases.
//     Independent of `structurallyValid`, says nothing about intent.
//   - `intentSource`      — `'none'` (no expectation was ever supplied — `inspectSettleProgram`,
//     ALWAYS), `'caller'` (the DEFAULT for `verifySettleProgram` — the caller supplied SOME
//     `declaredIntent`; this is a disclosure of the FIELD'S DEFAULT VALUE, not a verified fact
//     about how that expectation was formed), or `'server-echo'` (the caller has DISCLOSED, via
//     `opts.intentSourceLabel`, that the expectation is itself derived from the same request that
//     produced this program — self-certifying). Neither value is proof of independence: this
//     module cannot observe whether a caller formed `declaredIntent` from its own prior intent or
//     copied it back out of the very program being checked — that only `'server-echo'` bothers to
//     disclose is a caller CHOICE, not something verified. Treat `intentSource` as non-load-bearing
//     metadata always — see the FULL_BALANCE_SWEEP disclosure below.
//   - `intentReconciled`  — `null` (an expectation was never supplied, OR a required identity
//     check — e.g. the settle floor's target token — was left unpinned: NOT fully compared),
//     `false` (fully compared, at least one field did not match), `true` (fully compared, all
//     matched).
//   - `verdict`           — the ONE machine-gateable field, folding the three booleans above into
//     five named outcomes (`MALFORMED` / `NOT_OUR_TEMPLATE` / `INTENT_UNCHECKED` /
//     `INTENT_MISMATCH` / `MATCHES_DECLARED_INTENT`) whose NAME states its own relativity — no
//     badge or log-grep can read `INTENT_UNCHECKED` as an all-clear the way a bare `ok:true`
//     could. See `SettleReportEnvelope.verdict`'s doc for the exact derivation.
//
// Every check the mode supports is ALWAYS present with a status — an expectation the caller did
// not supply appears as `status:'unchecked'`. Silence is exactly the failure mode this surface
// exists to remove.
//
// Two entry points because "see" and "gate" are different jobs — but BOTH render the FULL,
// IDENTICAL check set (`shape.*`, `body.*`, `template.status`, `serverEcho.bodyHash`, AND
// `intent.recipient`/`intent.tokens`/`intent.minOut`/`intent.floorToken`). Nothing is ever omitted
// from `checks[]` by mode — see `pushIntentChecks` below, the ONE function both entry points call:
//   - `inspectSettleProgram` needs no expectations — it calls `pushIntentChecks(build, decoded,
//     null)`. Because there is NEVER an expectation to compare in this mode, `intent.recipient`/
//     `intent.tokens` render PERMANENTLY `'unchecked'`+`'blocking'` (never `'pass'`) — which makes
//     `intentReconciled` PERMANENTLY `null` and `verdict` PERMANENTLY `INTENT_UNCHECKED` (barring a
//     structural/authenticity rejection, which takes priority). This is deliberate, not a bug: a
//     caller that wants "is this at least genuinely our template" reads `structurallyValid`/
//     `authentic` instead — `verdict` never claims an intent match inspect cannot provide.
//   - `verifySettleProgram` REQUIRES `expect.recipient` (the whole hazard this guards is a
//     caller-chosen recipient — see the FULL_BALANCE_SWEEP disclosure below) and calls
//     `pushIntentChecks(build, decoded, expect)`, which does the REAL comparisons.
// ─────────────────────────────────────────────────────────────────────────────────────────────

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

export type SettleInspection = SettleReportEnvelope & { mode: "inspect" };
export type SettleReport = SettleReportEnvelope & { mode: "verify" };

// ── Disclosures — ALWAYS present, on success as well as failure. Stable ids so a UI can render
// them as a permanent banner rather than an error state. ────────────────────────────────────────
const DISCLOSURES: readonly Disclosure[] = [
  {
    id: "FULL_BALANCE_SWEEP",
    title: "This program sweeps the ENTIRE current Pot balance of every listed token — not a trade delta.",
    text:
      "The settle half moves the Pot's FULL current balance of every listed token, and the token list is " +
      "caller-chosen. A dust swap naming an unrelated token emits a program that moves that token's whole " +
      "balance to a caller-chosen recipient (cook-proven at 777e18 of a third party's parked balance). " +
      "Cooking is owner-gated, so this is not a public drain — it bites an operator whose relayer cooks " +
      "/swap output it did not originate. A passing body.hash check does NOT make this safe, and " +
      "neither does `verdict:'MATCHES_DECLARED_INTENT'` by itself: that verdict proves ONLY that the " +
      "decoded recipient, tokens and floor token equal the values you passed as `declaredIntent` — " +
      "nothing about who formed `declaredIntent`, or when. It is meaningful ONLY if YOU authored " +
      "`declaredIntent`, in your own process, from your own intent, BEFORE you ever saw this program. " +
      "`intentSource` is a caller-supplied DISCLOSURE of how `declaredIntent` claims to have been " +
      "formed — it is NOT something this module verifies or can verify. Independence is a property of " +
      "your own process, invisible to this library, and `intentSource:'caller'` is simply the DEFAULT " +
      "value, trivially true of any expectation regardless of who or what built it. Treat " +
      "`intentSource` as non-load-bearing metadata, never as proof of independence. Reconciling the " +
      "token list and recipient against your own pre-formed intent before cooking is your " +
      "responsibility, not this validator's. See `sweepScope` for the machine-readable form.",
  },
  {
    id: "FLOOR_IS_LEVEL_NOT_DELTA",
    title: "minOut is checked against a whole-balance LEVEL, not a pre/post-swap DELTA.",
    text:
      "The settle floor reads the Pot's CURRENT whole balance of tokens[0], where an unsplit (non-settle) " +
      "cook floors on (outBal - outBal0). A pre-existing or donated stash of the floor token counts toward " +
      "the settle floor and is never excluded — so a matched `intent.minOut` check is evidence that the " +
      "Pot's balance clears the floor, NOT evidence that this specific trade produced that amount. See " +
      "`floorClaim` (`comparableToUnsplitFloor:false`, always) for the machine-readable form — the split " +
      "and unsplit floors are never the same guarantee.",
  },
];

function toAddress20(value: bigint): Address {
  return getAddress("0x" + value.toString(16).padStart(40, "0"));
}

function renderAddr(a: Address | `0x${string}` | bigint): string {
  try {
    const v = typeof a === "bigint" ? a : BigInt(a);
    return getAddress("0x" + v.toString(16).padStart(40, "0"));
  } catch {
    return String(a);
  }
}

/** `BigInt(x)` throws (`TypeError`/`SyntaxError`) on a garbage `x` — every `expect.*` field is
 *  caller-controlled and only TYPED as `Address`/`bigint`, so a runtime caller that bypasses the
 *  type system (the exact scenario `verifySettleProgram`'s own recipient-required guard already
 *  anticipates) can otherwise crash a function documented to "never throw". Returns `null` on any
 *  parse failure instead — callers treat `null` as "cannot possibly match", i.e. a clean `'fail'`,
 *  never an unchecked exception. */
function safeBigInt(v: bigint | `0x${string}` | undefined): bigint | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint") return v;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

/** Wraps `authenticateBodyAgainstRoot` with `SETTLE_TEMPLATES` as the root — see this function's
 *  own doc AND `internal/root-testing.ts`'s header for why THIS is the one and only production
 *  call site of that function, and why no parameter anywhere on this module's public surface can
 *  change which table it's called with. */
function authenticateBody(bodyHash: Hex | null, acceptSuperseded: boolean) {
  return authenticateBodyAgainstRoot(bodyHash, acceptSuperseded, SETTLE_TEMPLATES);
}

interface CheckBuild {
  checks: VerifyCheck[];
  failureCode: SettleFailureCode | null;
}

function push(build: CheckBuild, check: VerifyCheck, code?: SettleFailureCode): void {
  build.checks.push(check);
  if (build.failureCode === null && check.severity === "blocking" && check.status !== "pass" && code) {
    build.failureCode = code;
  }
}

/**
 * `verdict` derivation — the ONE place this mapping is made, so nobody re-derives it differently.
 * See `SettleReportEnvelope.verdict`'s doc for what each outcome does/does not prove.
 *
 * `intentSource === 'server-echo'` CAPS a would-be `MATCHES_DECLARED_INTENT` down to
 * `INTENT_UNCHECKED` — never down to `INTENT_MISMATCH` (the values genuinely agree; what's missing
 * is INDEPENDENCE, not agreement, so the "not yet proven safe" verdict is the honest one, same as
 * an omitted expectation). This is the fix for the disclosed-but-unenforced half of the
 * FULL_BALANCE_SWEEP safety sentence: that text names `MATCHES_DECLARED_INTENT` from an
 * "independently-formed (`intentSource:'caller'`)" expectation as the only safe read — but
 * `intentSource:'server-echo'` used to still be able to REACH `MATCHES_DECLARED_INTENT` on a full
 * field match, contradicting the sentence's own qualifier at the type level, not just in prose.
 */
function deriveVerdict(structurallyValid: boolean, authentic: boolean, intentReconciled: boolean | null, intentSource: IntentSource): SettleVerdict {
  if (!structurallyValid) return "MALFORMED";
  if (!authentic) return "NOT_OUR_TEMPLATE";
  if (intentReconciled === true) return intentSource === "server-echo" ? "INTENT_UNCHECKED" : "MATCHES_DECLARED_INTENT";
  if (intentReconciled === false) return "INTENT_MISMATCH";
  return "INTENT_UNCHECKED";
}

/**
 * B2 — THE INVARIANT: any field a consumer can gate on must be false-or-null whenever `verdict` is
 * not the one fully-affirmative outcome (`MATCHES_DECLARED_INTENT`).
 *
 * `pushIntentChecks` computes its OWN, independent comparison of `decoded` against `expect` — but
 * `decoded` is a BEST-EFFORT parse that can populate real-looking tokens/recipient/minOut even when
 * the program is `MALFORMED` (e.g. a truncated body) or `NOT_OUR_TEMPLATE` (e.g. a forged body that
 * happens to share a genuine program's prologue). That raw comparison can therefore independently
 * read `true` in exactly the cases `verdict` says "not proven safe" — a REAL prior defect: a
 * forged-but-prologue-identical body reported `verdict:NOT_OUR_TEMPLATE` while `intentReconciled`
 * still read `true`, and a truncated body reported `verdict:MALFORMED` with the same leak. Returning
 * that raw value verbatim in the envelope reintroduced the deleted `ok` boolean's exact failure —
 * fused-and-tautological — one field over.
 *
 * The fix is structural, not a per-case patch: the PUBLICLY-EXPOSED `intentReconciled` is ALWAYS
 * derived FROM `verdict` (this function), NEVER returned as `pushIntentChecks`' raw value directly.
 * That makes divergence between the two impossible by construction, and is the pattern any FUTURE
 * gateable field must follow — derive from `verdict`, never compute and expose independently.
 * `test/verify.test.ts`'s "B2" suite enumerates every current gateable field across all four
 * non-affirmative verdicts specifically so a field that skips this pattern fails loudly.
 */
function gateIntentReconciled(verdict: SettleVerdict): boolean | null {
  if (verdict === "MATCHES_DECLARED_INTENT") return true;
  if (verdict === "INTENT_MISMATCH") return false;
  return null; // MALFORMED / NOT_OUR_TEMPLATE / INTENT_UNCHECKED — never affirmatively "true"
}

/** A runtime caller that bypasses the type system entirely (passes `null`/a non-object as `opts`)
 *  must not crash a function documented to never throw — the default parameter (`opts: VerifyOpts
 *  = {}`) only covers `undefined`, not an explicit `null`/garbage value. R3: this guard used to
 *  live ONLY inside `buildBase`'s own local scope, so it protected every check `buildBase` builds
 *  but NOT a caller who dereferences `opts.*` again in the ENTRY POINT after `buildBase` returns —
 *  exactly what `verifySettleProgram` does for `opts.intentSourceLabel`. Both entry points now
 *  call this SAME function before touching `opts` at all, so the guard is uniform everywhere
 *  `opts` is read, not just where `buildBase` happens to read it. */
function normalizeOpts(optsIn: VerifyOpts | null | undefined): VerifyOpts {
  return optsIn && typeof optsIn === "object" ? optsIn : {};
}

/** Shared engine behind both `inspectSettleProgram` and `verifySettleProgram` — builds every
 *  check that does NOT depend on caller expectations (shape/body/template/producer/serverEcho),
 *  plus the decoded value. Both entry points then call `pushIntentChecks` (with `null` or a real
 *  expectation respectively) and `buildEffects` on top of what this returns. */
function buildBase(
  program: Hex,
  optsIn: VerifyOpts,
): {
  build: CheckBuild;
  decoded: DecodedSettleProgram | null;
  templateId: string | null;
  templateVersion: string | null;
  hashSource: HashSource;
  rederivation: Rederivation;
  authenticated: boolean;
  structurallyValid: boolean;
} {
  const opts: VerifyOpts = normalizeOpts(optsIn);

  const parse = parseSettleProgram(program);
  const decoded = bestEffortDecode(parse);
  const build: CheckBuild = { checks: [], failureCode: null };

  // `opts.rederivedBodyHash`/`opts.serverEchoBodyHash` are both caller-controlled and only TYPED
  // as `Hex` — a runtime caller bypassing the type system (a number instead of a hex string) must
  // be treated as "not supplied" rather than crash a `.toLowerCase()` call on a value that has
  // neither. NOTE: there is deliberately no analogous `templates`/`expectedBodyHash` extraction
  // here anymore — see `HashSource`'s doc and `internal/root-testing.ts`'s header for why no
  // caller-reachable value can influence which table `authentic` is decided against.
  const rederivedBodyHash = typeof opts.rederivedBodyHash === "string" ? opts.rederivedBodyHash : undefined;
  const serverEchoBodyHash = typeof opts.serverEchoBodyHash === "string" ? opts.serverEchoBodyHash : undefined;

  // shape.pushes — did the FULL leading prologue scan (at least one token push, TUPLE, arity,
  // minOut, recipient) complete AT ALL, regardless of whether an individual push was CANONICAL
  // (that is `shape.canonical`'s separate concern below) or of the zero-recipient/body-length
  // checks that legitimately run only AFTER a complete scan. `pushesIncomplete` is exhaustive: the
  // strict scanner (wire.ts) aborts immediately on ANY push failure — canonical or not — so an
  // incomplete run means SOME push in the leading sequence was rejected, for ANY reason.
  //
  // Previously this check tested only a narrow subset of "truncation" codes and rendered 'pass'
  // with the literal text "...all well-formed" for a program whose FIRST push was non-minimal or
  // oversize (neither code was in that narrow set) — misleading wording for a program this report
  // otherwise correctly rejects via `shape.canonical`/`structurallyValid`. Using `pushesIncomplete`
  // (whether every stage through `recipientPush` was actually recorded) instead of an enumerated
  // code list is both correct and exhaustive by construction.
  const pushesIncomplete = parse.tokenPushes.length === 0 || !parse.tupleOk || !parse.arityOk || parse.minOutPush === null || parse.recipientPush === null;
  push(
    build,
    {
      id: "shape.pushes",
      title: "Leading minimal-length integer pushes found (the reversed token array, minOut, recipient).",
      status: pushesIncomplete ? "fail" : "pass",
      severity: "blocking",
      kind: "shape",
      compared: "byte 0 onward against the PUSH opcode range 0x01..0x20, tracking width/offset per push",
      expected: "at least one well-formed, untruncated push run reaching a minOut push and a recipient push",
      actual: pushesIncomplete ? (parse.fatal?.message ?? "the leading push run did not complete") : `${parse.tokenPushes.length} token push(es) + minOut + recipient, all well-formed`,
      proves: "the program's leading bytes are a complete, in-bounds sequence of integer pushes. Does NOT prove the values are addresses, or that a template follows.",
    },
    pushesIncomplete ? (parse.fatal?.code ?? "NOT_SETTLE_SHAPED") : undefined,
  );

  // The OLDER, narrower "truncation" code set — kept, UNCHANGED, purely because `shape.canonical`/
  // `shape.tuple` below key their own `unchecked` gating on it (see those checks' own history —
  // not something this fix touches).
  const truncationCode: SettleFailureCode | null =
    parse.fatal?.code === "EMPTY"
      ? "EMPTY"
      : parse.fatal?.code === "NOT_SETTLE_SHAPED"
        ? "NOT_SETTLE_SHAPED"
        : parse.tokenScanError?.code === "TRUNCATED_PUSH"
          ? "TRUNCATED_PUSH"
          : (parse.minOutError?.code === "TRUNCATED_MINOUT" ? "TRUNCATED_MINOUT" : null) ?? (parse.recipientError?.code === "TRUNCATED_RECIPIENT" ? "TRUNCATED_RECIPIENT" : null);

  // shape.canonical — minimality + the 20-byte address cap (§6 of the wire spec — the three
  // gaps the recipes package's original decoder accepted).
  const canonError =
    (parse.tokenScanError?.code === "NON_MINIMAL_PUSH" || parse.tokenScanError?.code === "OVERSIZE_ADDRESS" ? parse.tokenScanError : null) ??
    (parse.minOutError?.code === "NON_MINIMAL_PUSH" ? parse.minOutError : null) ??
    (parse.recipientError?.code === "NON_MINIMAL_PUSH" || parse.recipientError?.code === "OVERSIZE_ADDRESS" ? parse.recipientError : null);
  const canonUnchecked = truncationCode !== null;
  push(
    build,
    {
      id: "shape.canonical",
      title: "Every push is minimal-length; token/recipient pushes are ≤20 bytes.",
      status: canonUnchecked ? "unchecked" : canonError ? "fail" : "pass",
      severity: "blocking",
      kind: "shape",
      compared: "each push's declared width against the minimal-length rule (no leading zero byte) and, for token/recipient slots, a 20-byte cap",
      expected: "no leading-zero, non-minimal pushes; no token/recipient push wider than 20 bytes",
      actual: canonUnchecked ? "not evaluated — an earlier truncation prevented a full scan" : canonError ? canonError.message : "all pushes minimal and correctly sized",
      proves:
        "the encoding is the UNIQUE canonical form of its decoded value (no alternate byte string decodes to the same tokens/minOut/recipient). Rejects a non-minimal push and an oversized (>20 byte) address word — two shapes a naive decoder accepts without complaint.",
    },
    canonError?.code,
  );

  // shape.tuple
  const tupleUnchecked = parse.tokenPushes.length === 0 || truncationCode !== null;
  const tupleFail = !tupleUnchecked && !parse.tupleOk;
  push(
    build,
    {
      id: "shape.tuple",
      title: "The byte after the token pushes is the TUPLE opcode (0x94).",
      status: tupleUnchecked ? "unchecked" : tupleFail ? "fail" : "pass",
      severity: "blocking",
      kind: "shape",
      compared: `byte at offset ${parse.tupleOffset ?? "n/a"} against 0x94`,
      expected: "0x94",
      actual: tupleUnchecked ? "not reached" : tupleFail ? (parse.fatal?.message ?? "mismatch") : "0x94",
      proves: "the token array is closed by the compiler's TUPLE-build opcode — the shape a settle program's array argument always compiles to.",
    },
    tupleFail ? "NOT_SETTLE_SHAPED" : undefined,
  );

  // shape.arity
  const arityUnchecked = !parse.tupleOk;
  const arityFail = !arityUnchecked && !parse.arityOk;
  push(
    build,
    {
      id: "shape.arity",
      title: "The TUPLE arity byte equals the number of leading token pushes.",
      status: arityUnchecked ? "unchecked" : arityFail ? "fail" : "pass",
      severity: "blocking",
      kind: "shape",
      compared: `arity byte (${parse.arityByte ?? "n/a"}) against the ${parse.tokenPushes.length} pushes scanned`,
      expected: `${parse.tokenPushes.length}`,
      actual: arityUnchecked ? "not reached" : String(parse.arityByte ?? "missing"),
      proves: "the token array's declared length matches what was actually pushed — a mismatch here means the array is truncated or padded relative to its own header.",
    },
    arityFail ? "ARITY_MISMATCH" : undefined,
  );

  // shape.recipientNonZero
  const recipUnchecked = parse.recipientPush === null;
  const recipFail = !recipUnchecked && !parse.recipientNonZero;
  push(
    build,
    {
      id: "shape.recipientNonZero",
      title: "The recipient decodes to a nonzero address.",
      status: recipUnchecked ? "unchecked" : recipFail ? "fail" : "pass",
      severity: "blocking",
      kind: "shape",
      compared: "decoded recipient word against 0",
      expected: "nonzero",
      actual: recipUnchecked ? "not reached" : recipFail ? "0x0000000000000000000000000000000000000000" : renderAddr(parse.recipientPush!.value),
      proves: "every swept token has a real destination. A zero recipient is a program that (depending on the runtime's zero-address semantics) either reverts or burns the swept tokens — never intended.",
    },
    recipFail ? "ZERO_RECIPIENT" : undefined,
  );

  // body.size — wired to `CURRENT_SETTLE_TEMPLATE.bodySize` rather than a bare `165` literal: the
  // template's byte size is a fact `template.ts` already owns, and duplicating it here as a second
  // hand-maintained constant is exactly the kind of copy that can silently drift from the root.
  const bodyUnchecked = parse.body === null;
  const bodySize = parse.body?.length ?? null;
  const bodySizeFail = !bodyUnchecked && bodySize !== CURRENT_SETTLE_TEMPLATE.bodySize;
  push(
    build,
    {
      id: "body.size",
      title: `The constant body suffix is exactly ${CURRENT_SETTLE_TEMPLATE.bodySize} bytes.`,
      status: bodyUnchecked ? "unchecked" : bodySizeFail ? "fail" : "pass",
      severity: "blocking",
      kind: "shape",
      compared: `suffix byte length against ${CURRENT_SETTLE_TEMPLATE.bodySize}`,
      expected: `${CURRENT_SETTLE_TEMPLATE.bodySize}`,
      actual: bodyUnchecked ? "not reached" : String(bodySize),
      proves: "a length mismatch alone (before even hashing) proves this is not our template body — cheaper and clearer than an opaque hash mismatch.",
    },
    bodySizeFail ? "BODY_LENGTH" : undefined,
  );

  // body.hash — THE authenticity decision. `authenticateBody` is the ONLY producer of `authentic`;
  // there is no branch here reachable by any `opts.*` field, because there is no field left that
  // can supply a table or a bypass hash — see `HashSource`'s doc.
  const actualHash = parse.bodyHash;
  const authResult = authenticateBody(actualHash, opts.acceptSuperseded !== false);
  const hashSource: HashSource = actualHash ? "pinned" : "none";
  let authenticated = authResult.authentic;
  const bodyHashStatus: CheckStatus = !actualHash ? "unchecked" : authenticated ? "pass" : "fail";
  const bodyHashActual = actualHash ?? "not reached";
  const bodyHashExpected = authResult.entry ? authResult.entry.bodyHash : `${CURRENT_SETTLE_TEMPLATE.bodyHash} (or another accepted table entry)`;
  push(
    build,
    {
      id: "body.hash",
      title: `keccak256 of the ${CURRENT_SETTLE_TEMPLATE.bodySize}-byte body matches an entry in SETTLE_TEMPLATES — this is our audited program, verbatim.`,
      status: bodyHashStatus,
      severity: "blocking",
      kind: "authenticity",
      compared: "keccak256 of the constant body suffix against this package's own SETTLE_TEMPLATES (never a caller-supplied value)",
      expected: bodyHashExpected,
      actual: bodyHashActual,
      proves:
        "this is our audited template verbatim — nothing appended, no extra branch or call after the prologue. Does NOT constrain WHICH tokens are listed or WHOSE recipient is set — see the intent.* checks and the FULL_BALANCE_SWEEP disclosure.",
    },
    authenticated ? undefined : authResult.code,
  );

  // `templateId` is `null` — NEVER `CURRENT_SETTLE_TEMPLATE.id` — when no table entry matches this
  // body hash. The old fallback silently reported the CURRENT template's id for a program that
  // matched NO entry at all (a forged/foreign body), misrepresenting a `NOT_OUR_TEMPLATE` program
  // as if it named a real (if outdated) template. `authenticated ⟹ templateId !== null` holds by
  // construction: `authenticateBody` only ever returns `authentic:true` alongside a matched entry
  // whose `id` is a real, non-empty string (see its fail-closed guard).
  const templateId = authResult.entry?.id ?? null;
  const templateVersion = authResult.entry?.version ?? null;
  push(build, {
    id: "template.status",
    title: "Which template version this body matches, and whether it is current.",
    status: !actualHash ? "unchecked" : !authResult.entry ? "unchecked" : authResult.entry.status === "current" ? "pass" : "fail",
    severity: "advisory",
    kind: "informational",
    compared: "matched table entry's status field",
    expected: `${CURRENT_SETTLE_TEMPLATE.id}@${CURRENT_SETTLE_TEMPLATE.version} (current)`,
    actual: !actualHash ? "not reached" : !authResult.entry ? "no table entry matches this body hash" : `${authResult.entry.id}@${authResult.entry.version} (${authResult.entry.status})`,
    proves:
      "version skew between this program and the package's current template — informational; a superseded-but-accepted match is still authentic (see body.hash), this only flags that you're on an older audited version.",
  });

  // producer.rederivedBodyHash — see `VerifyOpts.rederivedBodyHash`'s doc. A CROSS-CHECK against
  // this report's OWN computed `actualHash` (R vs. P) — never against the templates table (P vs.
  // the table is exactly what `body.hash` above already did; comparing R to the table too would be
  // redundant given R-vs-P and P-vs-table). Absent entirely (rendered `'unchecked'`+`'advisory'`,
  // never blocking) when the opt wasn't supplied — this check must never manufacture a failure out
  // of silence. Present and mismatching FORCES `authenticated` false, with a code distinct from
  // `BODY_HASH` so a reader can tell "the pinned table rejected this body" apart from "the
  // producer's own recompiled hash disagrees with what it's reporting on".
  let rederivation: Rederivation = "absent";
  if (rederivedBodyHash !== undefined) {
    rederivation = actualHash !== null && actualHash.toLowerCase() === rederivedBodyHash.toLowerCase() ? "agrees" : "disagrees";
    const diverged = rederivation === "disagrees";
    if (diverged) authenticated = false;
    push(
      build,
      {
        id: "producer.rederivedBodyHash",
        title: "The producer's own independently-recompiled body hash agrees with this report's computed body hash.",
        status: actualHash === null ? "unchecked" : diverged ? "fail" : "pass",
        severity: "blocking",
        kind: "authenticity",
        compared: "locally computed keccak256(body) vs. opts.rederivedBodyHash",
        expected: rederivedBodyHash,
        actual: actualHash ?? "not reached",
        proves:
          "the caller's own recompile of the template it is reporting on matches what this program actually contains — a cross-check on the PRODUCER, never a substitute for (or a way to bypass) the body.hash match against SETTLE_TEMPLATES above.",
      },
      diverged ? "PRODUCER_HASH_DIVERGED" : undefined,
    );
  } else {
    push(build, {
      id: "producer.rederivedBodyHash",
      title: "The producer's own independently-recompiled body hash agrees with this report's computed body hash.",
      status: "unchecked",
      severity: "advisory",
      kind: "authenticity",
      compared: "locally computed keccak256(body) vs. opts.rederivedBodyHash",
      expected: "(not supplied)",
      actual: "not compared",
      proves: "nothing yet — opts.rederivedBodyHash was not supplied; see its doc.",
    });
  }

  // NOTE: `intent.floorToken` (and `intent.recipient`/`intent.tokens`/`intent.minOut`) are pushed
  // by `pushIntentChecks` below — NOT here. `buildBase` is expectation-blind (it has no `expect`
  // parameter — `inspectSettleProgram` never has one to give it), so every check that depends on
  // whether an expectation was supplied lives in the one function both entry points call after
  // this returns.

  // serverEcho.bodyHash — informational ONLY, never gates verdict, never the expected value.
  if (serverEchoBodyHash !== undefined) {
    const match = actualHash !== null && actualHash.toLowerCase() === serverEchoBodyHash.toLowerCase();
    push(build, {
      id: "serverEcho.bodyHash",
      title: "Locally computed body hash vs. the hash a server echoed alongside this same program.",
      status: actualHash ? (match ? "pass" : "fail") : "unchecked",
      severity: "advisory",
      kind: "informational",
      compared: "locally computed keccak256(body) vs. opts.serverEchoBodyHash",
      expected: serverEchoBodyHash,
      actual: actualHash ?? "not reached",
      proves:
        "NOT a security check — comparing a program to a hash shipped alongside that program is self-certification. This exists solely to surface version skew between what you computed and what the server believes it sent.",
    });
  } else {
    push(build, {
      id: "serverEcho.bodyHash",
      title: "Locally computed body hash vs. the hash a server echoed alongside this same program.",
      status: "unchecked",
      severity: "advisory",
      kind: "informational",
      compared: "locally computed keccak256(body) vs. opts.serverEchoBodyHash",
      expected: "(not supplied)",
      actual: "not compared",
      proves: "NOT a security check — informational only; see above.",
    });
  }

  // `structurallyValid`: every blocking check whose `kind` is `'shape'` passes — i.e. the bytes are
  // a well-formed, canonical `(tokens, minOut, recipient) || body[165]` wire program, independent
  // of WHOSE program it is or whether the body matches our template. This is an ALLOW-LIST over
  // `kind`, not a hand-maintained id-exclusion-list — a new blocking non-shape check (like
  // `producer.rederivedBodyHash` above) is automatically excluded by construction, rather than
  // needing its id added to a list by hand (and silently sinking `structurallyValid` until someone
  // remembers to). `authentic` (== `authenticated`) is decided separately, above. Neither says
  // anything about intent (tokens/recipient/minOut) — see `pushIntentChecks`' doc for that half.
  const structurallyValid = build.checks.every((c) => !(c.kind === "shape" && c.severity === "blocking") || c.status === "pass");

  return { build, decoded, templateId, templateVersion, hashSource, rederivation, authenticated, structurallyValid };
}

/** Build `effects[]` — a BEHAVIORAL claim ("this program, if cooked, moves these tokens"), so it
 *  is gated on `structurallyValid && authentic` (this IS our audited template, well-formed,
 *  decodable), NOT on `verdict`/`intentReconciled` (which also fold in intent — a caller's WRONG
 *  expected recipient/tokens doesn't change what the bytecode actually does, it only fails the
 *  comparison) and NOT on `authenticated`/body-hash alone: `parseSettleProgram` keeps parsing the
 *  body (to show a rejected program's would-be state) even after a ZERO_RECIPIENT fatal, so an
 *  authenticated-but-structurally-rejected program (e.g. a zero recipient) would otherwise still
 *  emit effect rows claiming a real transfer to `0x000…000` — a behavioral claim about a program
 *  this report structurally rejected. `inspectSettleProgram`'s permanently-unchecked `intent.*`
 *  (see `pushIntentChecks`) therefore does NOT suppress effects/sweepScope — "see what this
 *  program does" is exactly inspect's job, and remains available whenever the bytes genuinely are
 *  our template. */
function buildEffects(decoded: DecodedSettleProgram | null, structurallyValid: boolean, authentic: boolean): SettleEffect[] {
  const effects: SettleEffect[] = [];
  if (decoded && structurallyValid && authentic) {
    decoded.tokens.forEach((t, i) => {
      effects.push({
        position: i,
        token: getAddress(t),
        isFloorToken: i === 0,
        amount: "ENTIRE_POT_BALANCE",
        to: getAddress(decoded.recipient),
        note: i === 0
          ? "the Pot's FULL current balance of this token (the floor token, checked >= minOut BEFORE any transfer), not this trade's output"
          : "the Pot's FULL current balance of this token, not this trade's output",
      });
    });
  }
  return effects;
}

function buildSweepScope(effects: SettleEffect[]): SweepScope {
  return {
    unbounded: true,
    basis: "BALANCE_LEVEL",
    tokens: effects.map((e) => ({ position: e.position, token: e.token, isFloorToken: e.isFloorToken, to: e.to })),
  };
}

/** `floorClaim` describes what the DECODED PROLOGUE claims about its own floor — independent of
 *  `structurallyValid`/`authentic` (the prologue can be read even when the body doesn't
 *  authenticate) and independent of whether any expectation about it was supplied or matched
 *  (that is `intent.floorToken`'s job). */
function buildFloorClaim(decoded: DecodedSettleProgram | null): FloorClaim {
  const present = decoded !== null && decoded.minOut > 0n;
  return {
    present,
    token: present ? getAddress(decoded!.floorToken) : null,
    minOut: present ? decoded!.minOut : null,
    basis: "BALANCE_LEVEL",
    comparableToUnsplitFloor: false,
  };
}

/**
 * Push the four `intent.*` checks — `recipient`/`tokens`/`minOut`/`floorToken` — the ONE place
 * both entry points build them, so `checks[]` is IDENTICAL in shape between `inspectSettleProgram`
 * and `verifySettleProgram`: every check the report format supports is ALWAYS present with a real
 * status, never omitted by mode. Returns `intentReconciled` — see `SettleReportEnvelope`'s doc for
 * exactly what its three values mean; the derivation lives HERE (not duplicated at either call
 * site): `null` whenever no expectation was supplied at all, OR whenever ANY check this function
 * treats as `severity:'blocking'` for this call rendered `'unchecked'` (not fully compared);
 * `false` when every blocking check WAS compared and at least one is `'fail'`; `true` only when
 * every blocking check was compared and all are `'pass'`.
 *
 * `expect === null` is `inspectSettleProgram`'s call — there is NO expectation, ever, so:
 *   - `intent.recipient` / `intent.tokens` render `'unchecked'` + `'blocking'` (code
 *     `INTENT_UNCHECKED`) — NEVER `'pass'`, because passing would claim an assurance inspect
 *     cannot provide. This is what makes `intentReconciled` permanently `null` for
 *     `inspectSettleProgram`.
 *   - `intent.minOut` / `intent.floorToken` render `'unchecked'` + `'advisory'` — informational
 *     only (mirrors `verifySettleProgram`'s own "neither minOut field supplied" case below; a
 *     floor was never claimed by the CALLER, so there is nothing to forcibly fail — though see
 *     `intent.floorToken`'s own severity rule below, which is keyed on the PROGRAM's floor claim,
 *     not the caller's).
 *
 * `expect !== null` is `verifySettleProgram`'s call — `expect.recipient` is guaranteed present
 * (enforced at that function's entry). `expect.tokens`/`expect.allowTokens` MUST be arrays; a
 * runtime caller that bypasses the type system (a bare address string, say) gets a `'fail'`, never
 * a thrown exception (see `safeBigInt`'s doc for the scalar analogue).
 *
 * `intent.floorToken`'s forfeiture rule is keyed on the PROGRAM's own floor claim
 * (`decoded.minOut > 0n`), NOT on whether the caller happened to supply `expect.minOut`/
 * `expect.minMinOut`. `tokens[0]` is the ONLY token `minOut` is ever checked against
 * (FLOOR_IS_LEVEL_NOT_DELTA), and it is POSITIONAL, so `allowTokens` (order-free by definition) can
 * never itself pin it:
 *   - Supplied (`expect.floorToken !== undefined`): a REAL, blocking pass/fail comparison against
 *     `decoded.floorToken` (== `decoded.tokens[0]`).
 *   - NOT supplied, but the DECODED program carries a nonzero `minOut` AND the caller did not pin
 *     position 0 via an EXACT `tokens` list (only `allowTokens`, or no token expectation at all):
 *     this FORCES `'unchecked'` + `'blocking'` (code `INTENT_UNCHECKED`) regardless of whether the
 *     caller ever asked about `minOut` at all — a program's OWN floor claim is what creates the
 *     hazard, not the caller's curiosity about it. This is the fix for the exact exploit it
 *     closes: `verify(prog, {recipient, allowTokens:[OUT,IN]})` — no `minOut` expectation supplied
 *     — used to leave `intent.floorToken` `'unchecked'`+`'advisory'` (informational only) for BOTH
 *     the honest `[OUT,IN]` program and an attacker's `[IN,OUT]` reordering, because the old rule
 *     keyed off the CALLER's `minOut` claim rather than the PROGRAM's. Permuting the SAME allowed
 *     set moves the floor onto the leftover input while `intent.tokens` still passes either way.
 *   - NOT supplied, and EITHER the program carries no floor (`decoded.minOut === 0n`) OR position
 *     is already pinned via an exact `tokens` list: `'unchecked'` + `'advisory'` — informational,
 *     does not gate reconciliation.
 */
function pushIntentChecks(build: CheckBuild, decoded: DecodedSettleProgram | null, expect: SettleExpectation | null): boolean | null {
  const e: Partial<SettleExpectation> = expect ?? {};

  // intent.recipient
  if (expect === null) {
    push(
      build,
      {
        id: "intent.recipient",
        title: "Decoded recipient matches the expected recipient.",
        status: "unchecked",
        severity: "blocking",
        kind: "intent",
        compared: "decoded recipient vs. expect.recipient",
        expected: "(inspectSettleProgram takes no expectation — call verifySettleProgram with expect.recipient to check this)",
        actual: decoded ? renderAddr(decoded.recipient) : "not reached",
        proves: "the destination of every swept token, including the floor token's overflow above minOut.",
      },
      "INTENT_UNCHECKED",
    );
  } else {
    const expectRecip = safeBigInt(e.recipient);
    const recipMatch = decoded !== null && expectRecip !== null && BigInt(decoded.recipient) === expectRecip;
    push(
      build,
      {
        id: "intent.recipient",
        title: "Decoded recipient matches the expected recipient.",
        status: decoded === null ? "unchecked" : recipMatch ? "pass" : "fail",
        severity: "blocking",
        kind: "intent",
        compared: "decoded recipient vs. expect.recipient",
        expected: renderAddr(e.recipient!),
        actual: decoded ? renderAddr(decoded.recipient) : "not reached",
        proves: "the destination of every swept token, including the floor token's overflow above minOut.",
      },
      decoded === null ? undefined : recipMatch ? undefined : "EXPECT_RECIPIENT",
    );
  }

  // intent.tokens — blocking always; unchecked when neither tokens nor allowTokens is supplied
  // (including inspect's permanent no-expectation case). `tokens` (exact, order-sensitive) takes
  // precedence over `allowTokens` (containment) when both are given. Both MUST be arrays — a
  // runtime caller supplying a bare address string instead (bypassing the type system) gets a
  // 'fail', never a thrown `.map is not a function`.
  const tokensArr = Array.isArray(e.tokens) ? e.tokens : undefined;
  const tokensGivenInvalid = e.tokens !== undefined && tokensArr === undefined;
  const allowArr = Array.isArray(e.allowTokens) ? e.allowTokens : undefined;
  const allowGivenInvalid = e.allowTokens !== undefined && allowArr === undefined;

  let tokensStatus: CheckStatus;
  let tokensExpected: string;
  let tokensActual: string;
  let tokensCode: SettleFailureCode | undefined;
  // R1: a containment ('pass') result on the `allowTokens` branch below proves the decoded set is
  // a SUBSET of `allowTokens` — it never proves the decoded set is what the caller actually
  // wanted, because a program that sweeps only SOME of the allowed tokens (stranding the rest,
  // undelivered) is indistinguishable from one that swept everything expected.
  // `tokensContainmentPass` records exactly that case so the reconciliation derivation below can
  // refuse to let it alone produce `intentReconciled:true` — see `deriveVerdict`'s doc and the
  // `allowTokens` doc on `SettleExpectation`. A genuine violation (a token truly outside the
  // allowed set) is UNAFFECTED — it still fails here, same as before this fix.
  let tokensContainmentPass = false;
  if (tokensArr !== undefined || tokensGivenInvalid) {
    if (tokensGivenInvalid) {
      tokensStatus = "fail";
      tokensExpected = "an array (a runtime caller supplied a non-array expect.tokens, bypassing the type system)";
      tokensActual = decoded ? `[${decoded.tokens.map(renderAddr).join(", ")}]` : "not reached";
      tokensCode = "EXPECT_TOKENS";
    } else {
      tokensExpected = `[${tokensArr!.map(renderAddr).join(", ")}] (exact, in order)`;
      if (decoded === null) {
        tokensStatus = "unchecked";
        tokensActual = "not reached";
      } else {
        const want = tokensArr!.map((t) => safeBigInt(t));
        const got = decoded.tokens.map((t) => BigInt(t));
        const same = want.length === got.length && want.every((w, i) => w !== null && w === got[i]);
        tokensStatus = same ? "pass" : "fail";
        tokensActual = `[${decoded.tokens.map(renderAddr).join(", ")}]`;
        tokensCode = same ? undefined : "EXPECT_TOKENS";
      }
    }
  } else if (allowArr !== undefined || allowGivenInvalid) {
    if (allowGivenInvalid) {
      tokensStatus = "fail";
      tokensExpected = "an array (a runtime caller supplied a non-array expect.allowTokens, bypassing the type system)";
      tokensActual = decoded ? `[${decoded.tokens.map(renderAddr).join(", ")}]` : "not reached";
      tokensCode = "EXPECT_TOKENS";
    } else {
      const allowSet = new Set(allowArr!.map((t) => safeBigInt(t)).filter((v): v is bigint => v !== null));
      tokensExpected = `every decoded token ∈ {${allowArr!.map(renderAddr).join(", ")}}`;
      if (decoded === null) {
        tokensStatus = "unchecked";
        tokensActual = "not reached";
      } else {
        const outside = decoded.tokens.filter((t) => !allowSet.has(BigInt(t)));
        tokensStatus = outside.length === 0 ? "pass" : "fail";
        tokensContainmentPass = outside.length === 0;
        tokensActual = outside.length === 0
          ? `[${decoded.tokens.map(renderAddr).join(", ")}] — all allowed, but NOT proven to be the FULL expected set (containment only)`
          : `contains disallowed token(s): [${outside.map(renderAddr).join(", ")}]`;
        tokensCode = outside.length === 0 ? undefined : "EXPECT_TOKENS";
      }
    }
  } else {
    tokensStatus = "unchecked";
    tokensExpected =
      expect === null
        ? "(inspectSettleProgram takes no expectation — call verifySettleProgram with expect.tokens/allowTokens to check this)"
        : "(neither expect.tokens nor expect.allowTokens supplied)";
    tokensActual = decoded ? `[${decoded.tokens.map(renderAddr).join(", ")}] — NOT compared against anything` : "not reached";
    tokensCode = "INTENT_UNCHECKED";
  }
  push(
    build,
    {
      id: "intent.tokens",
      title: "Decoded token list matches the expected list (or stays within the allowed set).",
      status: tokensStatus,
      severity: "blocking",
      kind: "intent",
      compared: "decoded token list vs. expect.tokens / expect.allowTokens",
      expected: tokensExpected,
      actual: tokensActual,
      proves: tokensContainmentPass
        ? "ONLY that no decoded token falls outside the allowed set — a SUBSET relation, never an equality. A program that sweeps just some of the allowed tokens (stranding the rest, undelivered to recipient) passes this exact same way a fully-expected sweep would. NOT sufficient, alone, for an affirmative (MATCHES_DECLARED_INTENT) verdict — see intentReconciled."
        : "the FULL_BALANCE_SWEEP hazard's actual scope: which tokens leave the Pot at their whole balance. An unchecked status here means NOTHING about the token list was verified — treat that as unreconciled, not as a pass.",
    },
    tokensCode,
  );

  // intent.minOut — advisory+unchecked when neither minOut nor minMinOut is supplied (including
  // inspect's permanent no-expectation case); becomes blocking (pass/fail) once either is. This is
  // the CALLER's curiosity about the value — `intent.floorToken` below is the separate, PROGRAM-
  // keyed identity check.
  const minOutSupplied = e.minOut !== undefined || e.minMinOut !== undefined;
  let minOutStatus: CheckStatus;
  let minOutActual: string;
  let minOutExpected: string;
  let minOutCode: SettleFailureCode | undefined;
  if (!minOutSupplied) {
    minOutStatus = "unchecked";
    minOutExpected =
      expect === null
        ? "(inspectSettleProgram takes no expectation — call verifySettleProgram with expect.minOut/minMinOut to check this)"
        : "(neither expect.minOut nor expect.minMinOut supplied)";
    minOutActual = decoded ? String(decoded.minOut) : "not reached";
  } else if (decoded === null) {
    minOutStatus = "unchecked";
    minOutExpected = e.minOut !== undefined ? `== ${e.minOut}` : `>= ${e.minMinOut}`;
    minOutActual = "not reached";
  } else if (e.minOut !== undefined) {
    const pass = decoded.minOut === e.minOut;
    minOutStatus = pass ? "pass" : "fail";
    minOutExpected = `== ${e.minOut}`;
    minOutActual = String(decoded.minOut);
    minOutCode = pass ? undefined : "EXPECT_MINOUT";
  } else {
    const pass = decoded.minOut >= e.minMinOut!;
    minOutStatus = pass ? "pass" : "fail";
    minOutExpected = `>= ${e.minMinOut}`;
    minOutActual = String(decoded.minOut);
    minOutCode = pass ? undefined : "EXPECT_MINOUT";
  }
  push(
    build,
    {
      id: "intent.minOut",
      title: "Decoded minOut matches (or clears) the expected floor.",
      status: minOutStatus,
      severity: minOutSupplied ? "blocking" : "advisory",
      kind: "intent",
      compared: "decoded minOut vs. expect.minOut (exact) or expect.minMinOut (floor)",
      expected: minOutExpected,
      actual: minOutActual,
      proves:
        "minOut is checked against the Pot's WHOLE floor-token balance at settle time, not this trade's delta (see FLOOR_IS_LEVEL_NOT_DELTA) — a pass here is not proof this trade alone produced the amount.",
    },
    minOutCode,
  );

  // intent.floorToken — see this function's doc for the forfeiture rule (KEYED ON THE PROGRAM'S
  // OWN FLOOR CLAIM, not the caller's minOut curiosity). `tokens[0]` is the ONLY token `minOut` is
  // ever checked against (FLOOR_IS_LEVEL_NOT_DELTA), and it is POSITIONAL, so `allowTokens`
  // (order-free by definition) can never itself pin it.
  const positionPinned = tokensArr !== undefined; // an exact, order-sensitive list already covers position 0
  const programHasFloor = decoded !== null && decoded.minOut > 0n; // the PROGRAM's own claim — not the caller's
  const forfeited = expect !== null && !positionPinned && programHasFloor;
  let floorStatus: CheckStatus;
  let floorSeverity: CheckSeverity;
  let floorExpected: string;
  let floorCode: SettleFailureCode | undefined;
  if (e.floorToken !== undefined) {
    const expectFloor = safeBigInt(e.floorToken);
    const floorMatch = decoded !== null && expectFloor !== null && BigInt(decoded.floorToken) === expectFloor;
    floorStatus = decoded === null ? "unchecked" : floorMatch ? "pass" : "fail";
    floorSeverity = "blocking";
    floorExpected = renderAddr(e.floorToken);
    floorCode = decoded === null ? undefined : floorMatch ? undefined : "EXPECT_FLOOR_TOKEN";
  } else if (forfeited) {
    floorStatus = "unchecked";
    floorSeverity = "blocking";
    floorExpected =
      `(the decoded program carries a nonzero minOut floor (${decoded!.minOut}) but its target token's identity was pinned by neither expect.floorToken nor an exact expect.tokens list — allowTokens is order-free and cannot pin position 0, so the floor's target is UNVERIFIED regardless of whether you asked about minOut; intent cannot be reconciled until one of those is supplied)`;
    floorCode = "INTENT_UNCHECKED";
  } else {
    floorStatus = "unchecked";
    floorSeverity = "advisory";
    floorExpected =
      expect === null
        ? "(inspectSettleProgram takes no expectation — call verifySettleProgram with expect.floorToken to check this)"
        : "(no expect.floorToken supplied, and either the program carries no minOut floor or position 0 is already pinned via an exact expect.tokens list)";
  }
  push(
    build,
    {
      id: "intent.floorToken",
      title: "tokens[0] is the floor token — checked before any transfer runs.",
      status: floorStatus,
      severity: floorSeverity,
      kind: "intent",
      compared: "position 0 of the decoded token list vs. expect.floorToken",
      expected: floorExpected,
      actual: decoded ? renderAddr(decoded.floorToken) : "not reached",
      proves:
        "which token's Pot balance the minOut floor is checked against. Reversing the token list by mistake (or permuting an allowTokens-only set) silently swaps this to the wrong token — an 'unchecked' status here means minOut's target token was NOT verified, and blocks intent reconciliation whenever the program actually carries a floor (severity:'blocking').",
    },
    floorCode,
  );

  // `intentReconciled` derivation — see this function's doc. `null` unless an expectation was
  // supplied AND the program decoded AND every check this call treats as blocking was actually
  // compared (no 'unchecked' among them).
  if (expect === null || decoded === null) return null;
  const byId = new Map(build.checks.map((c) => [c.id, c] as const));
  const relevant: CheckStatus[] = [byId.get("intent.recipient")!.status, byId.get("intent.tokens")!.status];
  const minOutCheck = byId.get("intent.minOut")!;
  if (minOutCheck.severity === "blocking") relevant.push(minOutCheck.status);
  const floorTokenCheck = byId.get("intent.floorToken")!;
  if (floorTokenCheck.severity === "blocking") relevant.push(floorTokenCheck.status);
  if (relevant.includes("unchecked")) return null;
  if (relevant.includes("fail")) return false;
  // R1: a clean `allowTokens` containment result is NOT eligible, by itself, to make
  // intentReconciled `true` — it proved a subset, never an equality (see `tokensContainmentPass`'s
  // doc above). Every other relevant check passed, so this is not a mismatch either — it caps out
  // at "not fully reconciled", the same outcome an omitted expectation produces.
  if (tokensContainmentPass) return null;
  return true;
}

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
export function inspectSettleProgram(program: Hex, optsIn: VerifyOpts = {}): SettleInspection {
  const opts = normalizeOpts(optsIn);
  const { build, decoded, templateId, templateVersion, hashSource, rederivation, structurallyValid, authenticated } = buildBase(program, opts);
  const rawIntentReconciled = pushIntentChecks(build, decoded, null);
  const verdict = deriveVerdict(structurallyValid, authenticated, rawIntentReconciled, "none");
  // B2: NEVER expose `rawIntentReconciled` directly — see `gateIntentReconciled`'s doc. The public
  // field is derived FROM `verdict`, so it cannot leak `true`/`false` past a MALFORMED/
  // NOT_OUR_TEMPLATE verdict even when the raw (best-effort-decode-based) comparison would.
  const intentReconciled = gateIntentReconciled(verdict);
  const effects = buildEffects(decoded, structurallyValid, authenticated);
  return {
    verdict,
    intentReconciled,
    intentSource: "none",
    declaredIntent: opts.declaredIntent ?? null,
    mode: "inspect",
    templateId,
    templateVersion,
    hashSource,
    rederivation,
    structurallyValid,
    authentic: authenticated,
    failureCode: build.failureCode,
    decoded,
    checks: build.checks,
    effects,
    sweepScope: buildSweepScope(effects),
    floorClaim: buildFloorClaim(decoded),
    disclosures: DISCLOSURES.slice(),
  };
}

/**
 * GATE — never throws. `expect.recipient` is REQUIRED (see `SettleExpectation`). Calls
 * `pushIntentChecks` with the REAL expectation (real pass/fail comparisons, not permanently-
 * unchecked placeholders) and derives `verdict`/`intentReconciled` over the full check set.
 * `intentSource` is `'caller'` by default — pass `opts.intentSourceLabel:'server-echo'` to
 * disclose that `expect` is itself derived from the same request/data that produced `program`
 * (see `VerifyOpts.intentSourceLabel`'s doc). Under `'server-echo'`, `verdict` is CAPPED at
 * `INTENT_UNCHECKED` even on a full field match — see `deriveVerdict`.
 */
export function verifySettleProgram(program: Hex, expect: SettleExpectation, optsIn: VerifyOpts = {}): SettleReport {
  if (!expect || expect.recipient === undefined || expect.recipient === null) {
    throw new TypeError("verifySettleProgram: expect.recipient is REQUIRED (a runtime caller bypassed the type system)");
  }
  // R3: normalize BEFORE any `opts.*` dereference in THIS function — `buildBase` re-normalizes
  // its own copy internally, but that guard never protected this function's own read of
  // `opts.intentSourceLabel` below, which used to crash on an explicit `null` (a runtime caller
  // bypassing the type system, the exact scenario this same guard already anticipates elsewhere).
  const opts = normalizeOpts(optsIn);
  const { build, decoded, templateId, templateVersion, hashSource, rederivation, structurallyValid, authenticated } = buildBase(program, opts);
  const rawIntentReconciled = pushIntentChecks(build, decoded, expect);
  const intentSource: IntentSource = opts.intentSourceLabel === "server-echo" ? "server-echo" : "caller";
  const verdict = deriveVerdict(structurallyValid, authenticated, rawIntentReconciled, intentSource);
  // B2: see `gateIntentReconciled`'s doc — the public field is derived FROM `verdict`, never the
  // raw comparison, so it cannot leak past a MALFORMED/NOT_OUR_TEMPLATE verdict — and, since
  // `verdict` already folds in the `intentSource:'server-echo'` cap, `intentReconciled` cannot
  // leak `true` past that cap either (it reads `null`, matching an omitted expectation).
  const intentReconciled = gateIntentReconciled(verdict);
  const effects = buildEffects(decoded, structurallyValid, authenticated);
  return {
    verdict,
    intentReconciled,
    intentSource,
    declaredIntent: expect,
    mode: "verify",
    templateId,
    templateVersion,
    hashSource,
    rederivation,
    structurallyValid,
    authentic: authenticated,
    failureCode: build.failureCode,
    decoded,
    checks: build.checks,
    effects,
    sweepScope: buildSweepScope(effects),
    floorClaim: buildFloorClaim(decoded),
    disclosures: DISCLOSURES.slice(),
  };
}

const STATUS_GLYPH: Record<CheckStatus, string> = { pass: "✓", fail: "✗", unchecked: "·" };

/** JSON.stringify chokes on `bigint` — `declaredIntent`/`floorClaim` carry them natively. A tiny
 *  local replacer so this text renderer (documented to never throw) can still show them. */
function jsonSafe(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
  } catch {
    return String(v);
  }
}

/** B3: `formatSettleReport` is documented (see `jsonSafe`'s doc above) to never throw, but that
 *  guarantee used to hold only for a genuine `SettleReport`/`SettleInspection` value — a runtime
 *  caller bypassing the type system (`null`, `undefined`, `{}`, or any object missing a field this
 *  renderer assumed present) crashed immediately: `r.mode` on `null`/`undefined` before a single
 *  line was even built, `for (const c of r.checks)` on a value with no `checks` array at all. Every
 *  field this function reads is now read DEFENSIVELY — a missing/garbage container renders a
 *  placeholder instead of throwing, exactly the "guard the elements, don't just guard the
 *  container" fix `internal/root-testing.ts`'s `matchInRoot` needed for the same reason. */
export function formatSettleReport(r: SettleReport | SettleInspection): string {
  if (r === null || r === undefined || typeof r !== "object") {
    return "SETTLE PROGRAM REPORT — INVALID: formatSettleReport was called with a non-report value (a runtime caller bypassed the type system). Nothing to render.";
  }
  const report = r as Partial<SettleReportEnvelope>;
  const lines: string[] = [];
  lines.push(
    `SETTLE PROGRAM REPORT — mode=${report.mode ?? "?"} verdict=${report.verdict ?? "?"} intentReconciled=${report.intentReconciled === null || report.intentReconciled === undefined ? "null" : report.intentReconciled} ` +
      `intentSource=${report.intentSource ?? "?"} structurallyValid=${report.structurallyValid ?? "?"} authentic=${report.authentic ?? "?"} ` +
      `template=${report.templateId ?? "?"}@${report.templateVersion ?? "?"} hashSource=${report.hashSource ?? "?"} rederivation=${report.rederivation ?? "?"}`,
  );
  if (report.mode === "inspect") {
    lines.push("  (inspect mode supplies NO expectation — intentReconciled is always null; read structurallyValid/authentic and checks[] for what IS proven)");
  }
  if (report.failureCode) lines.push(`  failureCode: ${report.failureCode}`);
  if (report.declaredIntent) lines.push(`  declaredIntent (source=${report.intentSource}): ${jsonSafe(report.declaredIntent)}`);
  lines.push("");
  lines.push("checks:");
  const checks = Array.isArray(report.checks) ? report.checks : [];
  if (checks.length === 0) lines.push("  (none — malformed input: no checks[] array present on this report)");
  for (const c of checks) {
    if (c === null || typeof c !== "object") {
      lines.push("  (skipped a malformed checks[] entry)");
      continue;
    }
    const glyph = STATUS_GLYPH[c.status as CheckStatus] ?? "?";
    lines.push(`  ${glyph} [${c.severity ?? "?"}] ${c.id ?? "?"} — ${c.title ?? "?"}`);
    lines.push(`      compared: ${c.compared ?? "?"}`);
    lines.push(`      expected: ${c.expected ?? "?"}`);
    lines.push(`      actual:   ${c.actual ?? "?"}`);
    lines.push(`      proves:   ${c.proves ?? "?"}`);
  }
  lines.push("");
  const sweepScope = report.sweepScope && typeof report.sweepScope === "object" ? report.sweepScope : undefined;
  const sweepTokens = Array.isArray(sweepScope?.tokens) ? sweepScope!.tokens : [];
  lines.push(`sweepScope: unbounded=${sweepScope?.unbounded ?? "?"} basis=${sweepScope?.basis ?? "?"} tokens(${sweepTokens.length}):`);
  if (sweepTokens.length === 0) {
    lines.push("  (none — program is not both structurally valid AND authentic; no behavioral claim can be made)");
  }
  for (const t of sweepTokens) {
    if (t === null || typeof t !== "object") {
      lines.push("  (skipped a malformed sweepScope entry)");
      continue;
    }
    lines.push(`  #${t.position ?? "?"} ${t.token ?? "?"}${t.isFloorToken ? " (FLOOR TOKEN)" : ""} -> ENTIRE_POT_BALANCE -> ${t.to ?? "?"}`);
  }
  lines.push("");
  const floorClaim = report.floorClaim && typeof report.floorClaim === "object" ? report.floorClaim : undefined;
  lines.push(
    `floorClaim: present=${floorClaim?.present ?? "?"} token=${floorClaim?.token ?? "n/a"} minOut=${floorClaim?.minOut ?? "n/a"} ` +
      `basis=${floorClaim?.basis ?? "?"} comparableToUnsplitFloor=${floorClaim?.comparableToUnsplitFloor ?? "?"}`,
  );
  lines.push("");
  lines.push("disclosures:");
  const disclosures = Array.isArray(report.disclosures) ? report.disclosures : [];
  for (const d of disclosures) {
    if (d === null || typeof d !== "object") {
      lines.push("  (skipped a malformed disclosures[] entry)");
      continue;
    }
    lines.push(`  [${d.id ?? "?"}] ${d.title ?? "?"}`);
    lines.push(`      ${d.text ?? "?"}`);
  }
  return lines.join("\n");
}
