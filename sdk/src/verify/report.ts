import { getAddress, type Address, type Hex } from "viem";
import { parseSettleProgram, bestEffortDecode, type DecodedSettleProgram, type SettleFailureCode } from "./decode.js";
import { SETTLE_TEMPLATES, CURRENT_SETTLE_TEMPLATE, type TemplateEntry } from "./template.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE VISIBLE VALIDATION SURFACE.
//
// `validateSettleProgram`-style callers historically got `{ok:false, reason:string}` — one
// boolean and one prose sentence. This module replaces that with a REPORT: a list of checks, a
// list of decoded effects, and a list of standing disclosures. `ok` is a DERIVED field, never the
// product — see `deriveOk` below, stated here so nobody re-derives it differently:
//
//   ok === checks.every(c => c.severity !== 'blocking' || c.status === 'pass')
//
// Every check the mode supports is ALWAYS present with a status — an expectation the caller did
// not supply appears as `status:'unchecked'`, and if its severity is `blocking` that forces
// `ok:false`. Silence is exactly the failure mode this surface exists to remove.
//
// Two entry points because "see" and "gate" are different jobs:
//   - `inspectSettleProgram` needs no expectations and always renders everything it learned.
//   - `verifySettleProgram` REQUIRES `expect.recipient` (the whole hazard this guards is a
//     caller-chosen recipient — see the FULL_BALANCE_SWEEP disclosure below) and adds the
//     intent-comparison checks on top of everything `inspectSettleProgram` reports.
// ─────────────────────────────────────────────────────────────────────────────────────────────

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
   *  order-free. Ignored when `tokens` is also supplied. */
  allowTokens?: Address[];
  /** Exact required `minOut`. */
  minOut?: bigint;
  /** Floor-on-the-floor: decoded `minOut` must be `>= minMinOut`. Ignored when `minOut` is also
   *  supplied (the exact check subsumes it). */
  minMinOut?: bigint;
}

export interface SettleReportEnvelope {
  ok: boolean;
  mode: "verify" | "inspect";
  templateId: string | null;
  templateVersion: string | null;
  hashSource: HashSource;
  failureCode: SettleFailureCode | null;
  decoded: DecodedSettleProgram | null;
  checks: VerifyCheck[];
  effects: SettleEffect[];
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
      "/swap output it did not originate. A passing body.hash check does NOT make this safe; only the " +
      "intent.tokens and intent.recipient checks (verifySettleProgram) do — reconciling the token list and " +
      "recipient against your own intent before cooking is your responsibility, not this validator's.",
  },
  {
    id: "FLOOR_IS_LEVEL_NOT_DELTA",
    title: "minOut is checked against a whole-balance LEVEL, not a pre/post-swap DELTA.",
    text:
      "The settle floor reads the Pot's CURRENT whole balance of tokens[0], where an unsplit (non-settle) " +
      "cook floors on (outBal - outBal0). A pre-existing or donated stash of the floor token counts toward " +
      "the settle floor and is never excluded — so a passing intent.minOut check is evidence that the " +
      "Pot's balance clears the floor, NOT evidence that this specific trade produced that amount.",
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

function matchTemplate(hash: Hex, templates: readonly TemplateEntry[]): TemplateEntry | undefined {
  const norm = hash.toLowerCase();
  return templates.find((t) => t.bodyHash.toLowerCase() === norm);
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

/** Shared engine behind both `inspectSettleProgram` and `verifySettleProgram` — builds every
 *  check that does NOT depend on caller expectations (shape/body/template/floorToken/serverEcho),
 *  plus the decoded value, effects, and disclosures. `verifySettleProgram` appends the three
 *  intent.* checks on top of this. */
function buildBase(
  program: Hex,
  opts: VerifyOpts,
): {
  build: CheckBuild;
  decoded: DecodedSettleProgram | null;
  effects: SettleEffect[];
  templateId: string | null;
  templateVersion: string | null;
  hashSource: HashSource;
  authenticated: boolean;
} {
  const parse = parseSettleProgram(program);
  const decoded = bestEffortDecode(parse);
  const build: CheckBuild = { checks: [], failureCode: null };
  const templates = opts.templates ?? SETTLE_TEMPLATES;

  // shape.pushes — the leading token-push run (and, by extension, the minOut/recipient pushes
  // that follow it) all present and untruncated.
  const truncationCode: SettleFailureCode | null =
    parse.fatal?.code === "EMPTY"
      ? "EMPTY"
      : parse.tokenPushes.length === 0
        ? "NOT_SETTLE_SHAPED"
        : parse.tokenScanError?.code === "TRUNCATED_PUSH"
          ? "TRUNCATED_PUSH"
          : (parse.minOutError?.code === "TRUNCATED_MINOUT" ? "TRUNCATED_MINOUT" : null) ??
            (parse.recipientError?.code === "TRUNCATED_RECIPIENT" ? "TRUNCATED_RECIPIENT" : null);
  push(
    build,
    {
      id: "shape.pushes",
      title: "Leading minimal-length integer pushes found (the reversed token array, minOut, recipient).",
      status: truncationCode ? "fail" : "pass",
      severity: "blocking",
      compared: "byte 0 onward against the PUSH opcode range 0x01..0x20, tracking width/offset per push",
      expected: "at least one well-formed, untruncated push run",
      actual: truncationCode
        ? (parse.fatal?.message ?? "truncated push")
        : `${parse.tokenPushes.length} token push(es) + minOut + recipient, all well-formed`,
      proves: "the program's leading bytes are a complete, in-bounds sequence of integer pushes. Does NOT prove the values are addresses, or that a template follows.",
    },
    truncationCode ?? undefined,
  );

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
      compared: "each push's declared width against the minimal-length rule (no leading zero byte) and, for token/recipient slots, a 20-byte cap",
      expected: "no leading-zero, non-minimal pushes; no token/recipient push wider than 20 bytes",
      actual: canonUnchecked ? "not evaluated — an earlier truncation prevented a full scan" : canonError ? canonError.message : "all pushes minimal and correctly sized",
      proves:
        "the encoding is the UNIQUE canonical form of its decoded value (no alternate byte string decodes to the same tokens/minOut/recipient). Rejects a non-minimal push and an oversized (>20 byte) address word — two shapes a naive decoder accepts as ok:true.",
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
      compared: "decoded recipient word against 0",
      expected: "nonzero",
      actual: recipUnchecked ? "not reached" : recipFail ? "0x0000000000000000000000000000000000000000" : renderAddr(parse.recipientPush!.value),
      proves: "every swept token has a real destination. A zero recipient is a program that (depending on the runtime's zero-address semantics) either reverts or burns the swept tokens — never intended.",
    },
    recipFail ? "ZERO_RECIPIENT" : undefined,
  );

  // body.size
  const bodyUnchecked = parse.body === null;
  const bodySize = parse.body?.length ?? null;
  const bodySizeFail = !bodyUnchecked && bodySize !== 165;
  push(
    build,
    {
      id: "body.size",
      title: "The constant body suffix is exactly 165 bytes.",
      status: bodyUnchecked ? "unchecked" : bodySizeFail ? "fail" : "pass",
      severity: "blocking",
      compared: "suffix byte length against 165",
      expected: "165",
      actual: bodyUnchecked ? "not reached" : String(bodySize),
      proves: "a length mismatch alone (before even hashing) proves this is not our template body — cheaper and clearer than an opaque hash mismatch.",
    },
    bodySizeFail ? "BODY_LENGTH" : undefined,
  );

  // body.hash / template.status / authenticity decision
  const actualHash = parse.bodyHash;
  const tableMatch = actualHash ? matchTemplate(actualHash, templates) : undefined;
  let hashSource: HashSource = "pinned";
  let authenticated = false;
  let bodyHashStatus: CheckStatus = "unchecked";
  let bodyHashCode: SettleFailureCode | undefined;
  let bodyHashActual = "not reached";
  let bodyHashExpected = "any accepted (non-revoked) template body hash";

  if (actualHash) {
    if (opts.expectedBodyHash !== undefined) {
      hashSource = opts.hashSourceLabel ?? "caller";
      authenticated = actualHash.toLowerCase() === opts.expectedBodyHash.toLowerCase();
      bodyHashStatus = authenticated ? "pass" : "fail";
      bodyHashCode = authenticated ? undefined : "BODY_HASH";
      bodyHashActual = actualHash;
      bodyHashExpected = opts.expectedBodyHash;
    } else {
      hashSource = "pinned";
      if (!tableMatch) {
        authenticated = false;
        bodyHashStatus = "fail";
        bodyHashCode = "BODY_HASH";
      } else if (tableMatch.status === "revoked") {
        authenticated = false;
        bodyHashStatus = "fail";
        bodyHashCode = "TEMPLATE_REVOKED";
      } else if (tableMatch.status === "superseded") {
        authenticated = opts.acceptSuperseded !== false;
        bodyHashStatus = authenticated ? "pass" : "fail";
        bodyHashCode = authenticated ? undefined : "BODY_HASH";
      } else {
        authenticated = true;
        bodyHashStatus = "pass";
      }
      bodyHashActual = actualHash;
      bodyHashExpected = tableMatch ? tableMatch.bodyHash : `${CURRENT_SETTLE_TEMPLATE.bodyHash} (or another accepted table entry)`;
    }
  }
  push(
    build,
    {
      id: "body.hash",
      title: "keccak256 of the 165-byte body matches an accepted template — this is our audited program, verbatim.",
      status: bodyHashStatus,
      severity: "blocking",
      compared: "keccak256 of the constant body suffix",
      expected: bodyHashExpected,
      actual: bodyHashActual,
      proves:
        "this is our audited template verbatim — nothing appended, no extra branch or call after the prologue. Does NOT constrain WHICH tokens are listed or WHOSE recipient is set — see the intent.* checks and the FULL_BALANCE_SWEEP disclosure.",
    },
    bodyHashCode,
  );

  const templateId = tableMatch?.id ?? CURRENT_SETTLE_TEMPLATE.id;
  const templateVersion = tableMatch?.version ?? null;
  push(build, {
    id: "template.status",
    title: "Which template version this body matches, and whether it is current.",
    status: !actualHash ? "unchecked" : !tableMatch ? "unchecked" : tableMatch.status === "current" ? "pass" : "fail",
    severity: "advisory",
    compared: "matched table entry's status field",
    expected: `${CURRENT_SETTLE_TEMPLATE.id}@${CURRENT_SETTLE_TEMPLATE.version} (current)`,
    actual: !actualHash ? "not reached" : !tableMatch ? "no table entry matches this body hash" : `${tableMatch.id}@${tableMatch.version} (${tableMatch.status})`,
    proves:
      "version skew between this program and the package's current template — informational; a superseded-but-accepted match is still authentic (see body.hash), this only flags that you're on an older audited version.",
  });

  // intent.floorToken — informational, always available once decoded.
  push(build, {
    id: "intent.floorToken",
    title: "tokens[0] is the floor token — checked before any transfer runs.",
    status: decoded ? "pass" : "unchecked",
    severity: "advisory",
    compared: "position 0 of the decoded token list",
    expected: "(informational — no expectation to compare; the floor token is POSITIONAL, not separately named)",
    actual: decoded ? renderAddr(decoded.floorToken) : "not reached",
    proves: "which token's Pot balance the minOut floor is checked against. Reversing the token list by mistake silently swaps this to the wrong token.",
  });

  // serverEcho.bodyHash — informational ONLY, never gates ok, never the expected value.
  if (opts.serverEchoBodyHash !== undefined) {
    const match = actualHash !== null && actualHash.toLowerCase() === opts.serverEchoBodyHash.toLowerCase();
    push(build, {
      id: "serverEcho.bodyHash",
      title: "Locally computed body hash vs. the hash a server echoed alongside this same program.",
      status: actualHash ? (match ? "pass" : "fail") : "unchecked",
      severity: "advisory",
      compared: "locally computed keccak256(body) vs. opts.serverEchoBodyHash",
      expected: opts.serverEchoBodyHash,
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
      compared: "locally computed keccak256(body) vs. opts.serverEchoBodyHash",
      expected: "(not supplied)",
      actual: "not compared",
      proves: "NOT a security check — informational only; see above.",
    });
  }

  const effects: SettleEffect[] = [];
  if (decoded && authenticated) {
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

  return { build, decoded, effects, templateId, templateVersion, hashSource, authenticated };
}

/**
 * SEE — never throws, requires no expectations. This is the "show me the validation phase" call:
 * renders every shape/body/template check plus the decoded intent and the standing disclosures,
 * with no comparison against a caller's expected recipient/tokens/minOut (those checks simply
 * don't exist in this report — see `verifySettleProgram` for that).
 */
export function inspectSettleProgram(program: Hex, opts: VerifyOpts = {}): SettleInspection {
  const { build, decoded, effects, templateId, templateVersion, hashSource } = buildBase(program, opts);
  const ok = build.checks.every((c) => c.severity !== "blocking" || c.status === "pass");
  return {
    ok,
    mode: "inspect",
    templateId,
    templateVersion,
    hashSource,
    failureCode: ok ? null : build.failureCode,
    decoded,
    checks: build.checks,
    effects,
    disclosures: DISCLOSURES.slice(),
  };
}

/**
 * GATE — never throws. `expect.recipient` is REQUIRED (see `SettleExpectation`). Adds
 * `intent.recipient` / `intent.tokens` / `intent.minOut` on top of everything
 * `inspectSettleProgram` reports, and derives `ok` over the full set.
 */
export function verifySettleProgram(program: Hex, expect: SettleExpectation, opts: VerifyOpts = {}): SettleReport {
  if (!expect || expect.recipient === undefined || expect.recipient === null) {
    throw new TypeError("verifySettleProgram: expect.recipient is REQUIRED (a runtime caller bypassed the type system)");
  }
  const { build, decoded, effects, templateId, templateVersion, hashSource } = buildBase(program, opts);

  // intent.recipient — always checked (required field).
  const recipMatch = decoded !== null && BigInt(decoded.recipient) === BigInt(expect.recipient);
  push(
    build,
    {
      id: "intent.recipient",
      title: "Decoded recipient matches the expected recipient.",
      status: decoded === null ? "unchecked" : recipMatch ? "pass" : "fail",
      severity: "blocking",
      compared: "decoded recipient vs. expect.recipient",
      expected: renderAddr(expect.recipient),
      actual: decoded ? renderAddr(decoded.recipient) : "not reached",
      proves: "the destination of every swept token, including the floor token's overflow above minOut.",
    },
    decoded === null ? undefined : recipMatch ? undefined : "EXPECT_RECIPIENT",
  );

  // intent.tokens — blocking always; unchecked (forcing ok:false) when neither tokens nor
  // allowTokens is supplied. `tokens` (exact, order-sensitive) takes precedence over `allowTokens`
  // (containment) when both are given.
  let tokensStatus: CheckStatus;
  let tokensExpected: string;
  let tokensActual: string;
  let tokensCode: SettleFailureCode | undefined;
  if (expect.tokens !== undefined) {
    tokensExpected = `[${expect.tokens.map(renderAddr).join(", ")}] (exact, in order)`;
    if (decoded === null) {
      tokensStatus = "unchecked";
      tokensActual = "not reached";
    } else {
      const want = expect.tokens.map((t) => BigInt(t));
      const got = decoded.tokens.map((t) => BigInt(t));
      const same = want.length === got.length && want.every((w, i) => w === got[i]);
      tokensStatus = same ? "pass" : "fail";
      tokensActual = `[${decoded.tokens.map(renderAddr).join(", ")}]`;
      tokensCode = same ? undefined : "EXPECT_TOKENS";
    }
  } else if (expect.allowTokens !== undefined) {
    const allowSet = new Set(expect.allowTokens.map((t) => BigInt(t)));
    tokensExpected = `every decoded token ∈ {${expect.allowTokens.map(renderAddr).join(", ")}}`;
    if (decoded === null) {
      tokensStatus = "unchecked";
      tokensActual = "not reached";
    } else {
      const outside = decoded.tokens.filter((t) => !allowSet.has(BigInt(t)));
      tokensStatus = outside.length === 0 ? "pass" : "fail";
      tokensActual = outside.length === 0 ? `[${decoded.tokens.map(renderAddr).join(", ")}] — all allowed` : `contains disallowed token(s): [${outside.map(renderAddr).join(", ")}]`;
      tokensCode = outside.length === 0 ? undefined : "EXPECT_TOKENS";
    }
  } else {
    tokensStatus = "unchecked";
    tokensExpected = "(neither expect.tokens nor expect.allowTokens supplied)";
    tokensActual = decoded ? `[${decoded.tokens.map(renderAddr).join(", ")}] — NOT compared against anything` : "not reached";
    tokensCode = "EXPECT_TOKENS";
  }
  push(
    build,
    {
      id: "intent.tokens",
      title: "Decoded token list matches the expected list (or stays within the allowed set).",
      status: tokensStatus,
      severity: "blocking",
      compared: "decoded token list vs. expect.tokens / expect.allowTokens",
      expected: tokensExpected,
      actual: tokensActual,
      proves:
        "the FULL_BALANCE_SWEEP hazard's actual scope: which tokens leave the Pot at their whole balance. An unchecked status here means NOTHING about the token list was verified — treat that as a failure, not a pass.",
    },
    tokensCode,
  );

  // intent.minOut — advisory+unchecked when neither minOut nor minMinOut is supplied; becomes
  // blocking (pass/fail) once either is.
  const minOutSupplied = expect.minOut !== undefined || expect.minMinOut !== undefined;
  let minOutStatus: CheckStatus;
  let minOutActual: string;
  let minOutExpected: string;
  let minOutCode: SettleFailureCode | undefined;
  if (!minOutSupplied) {
    minOutStatus = "unchecked";
    minOutExpected = "(neither expect.minOut nor expect.minMinOut supplied)";
    minOutActual = decoded ? String(decoded.minOut) : "not reached";
  } else if (decoded === null) {
    minOutStatus = "unchecked";
    minOutExpected = expect.minOut !== undefined ? `== ${expect.minOut}` : `>= ${expect.minMinOut}`;
    minOutActual = "not reached";
  } else if (expect.minOut !== undefined) {
    const pass = decoded.minOut === expect.minOut;
    minOutStatus = pass ? "pass" : "fail";
    minOutExpected = `== ${expect.minOut}`;
    minOutActual = String(decoded.minOut);
    minOutCode = pass ? undefined : "EXPECT_MINOUT";
  } else {
    const pass = decoded.minOut >= expect.minMinOut!;
    minOutStatus = pass ? "pass" : "fail";
    minOutExpected = `>= ${expect.minMinOut}`;
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
      compared: "decoded minOut vs. expect.minOut (exact) or expect.minMinOut (floor)",
      expected: minOutExpected,
      actual: minOutActual,
      proves:
        "minOut is checked against the Pot's WHOLE floor-token balance at settle time, not this trade's delta (see FLOOR_IS_LEVEL_NOT_DELTA) — a pass here is not proof this trade alone produced the amount.",
    },
    minOutCode,
  );

  const ok = build.checks.every((c) => c.severity !== "blocking" || c.status === "pass");
  return {
    ok,
    mode: "verify",
    templateId,
    templateVersion,
    hashSource,
    failureCode: ok ? null : build.failureCode,
    decoded,
    checks: build.checks,
    effects,
    disclosures: DISCLOSURES.slice(),
  };
}

const STATUS_GLYPH: Record<CheckStatus, string> = { pass: "✓", fail: "✗", unchecked: "·" };

/** Render a report as fixed-width plain text — checks, then effects, then disclosures. This is
 *  the deliverable a partner pastes into a support ticket: "seeing the validation phase" is a
 *  `console.log`, not a JSON-schema exercise. */
export function formatSettleReport(r: SettleReport | SettleInspection): string {
  const lines: string[] = [];
  lines.push(`SETTLE PROGRAM REPORT — mode=${r.mode} ok=${r.ok} template=${r.templateId ?? "?"}@${r.templateVersion ?? "?"} hashSource=${r.hashSource}`);
  if (r.failureCode) lines.push(`  failureCode: ${r.failureCode}`);
  lines.push("");
  lines.push("checks:");
  for (const c of r.checks) {
    const glyph = STATUS_GLYPH[c.status];
    lines.push(`  ${glyph} [${c.severity}] ${c.id} — ${c.title}`);
    lines.push(`      compared: ${c.compared}`);
    lines.push(`      expected: ${c.expected}`);
    lines.push(`      actual:   ${c.actual}`);
    lines.push(`      proves:   ${c.proves}`);
  }
  lines.push("");
  lines.push(`effects (${r.effects.length}):`);
  if (r.effects.length === 0) {
    lines.push("  (none — program not authenticated as the settle template; no behavioral claim can be made)");
  }
  for (const e of r.effects) {
    lines.push(`  #${e.position} ${e.token}${e.isFloorToken ? " (FLOOR TOKEN)" : ""} -> ${e.amount} -> ${e.to}`);
    lines.push(`      ${e.note}`);
  }
  lines.push("");
  lines.push("disclosures:");
  for (const d of r.disclosures) {
    lines.push(`  [${d.id}] ${d.title}`);
    lines.push(`      ${d.text}`);
  }
  return lines.join("\n");
}
