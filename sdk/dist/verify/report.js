import { getAddress } from "viem";
import { parseSettleProgram, bestEffortDecode } from "./decode.js";
import { SETTLE_TEMPLATES, CURRENT_SETTLE_TEMPLATE } from "./template.js";
// ── Disclosures — ALWAYS present, on success as well as failure. Stable ids so a UI can render
// them as a permanent banner rather than an error state. ────────────────────────────────────────
const DISCLOSURES = [
    {
        id: "FULL_BALANCE_SWEEP",
        title: "This program sweeps the ENTIRE current Pot balance of every listed token — not a trade delta.",
        text: "The settle half moves the Pot's FULL current balance of every listed token, and the token list is " +
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
        text: "The settle floor reads the Pot's CURRENT whole balance of tokens[0], where an unsplit (non-settle) " +
            "cook floors on (outBal - outBal0). A pre-existing or donated stash of the floor token counts toward " +
            "the settle floor and is never excluded — so a passing intent.minOut check is evidence that the " +
            "Pot's balance clears the floor, NOT evidence that this specific trade produced that amount.",
    },
];
function toAddress20(value) {
    return getAddress("0x" + value.toString(16).padStart(40, "0"));
}
function renderAddr(a) {
    try {
        const v = typeof a === "bigint" ? a : BigInt(a);
        return getAddress("0x" + v.toString(16).padStart(40, "0"));
    }
    catch {
        return String(a);
    }
}
/** `BigInt(x)` throws (`TypeError`/`SyntaxError`) on a garbage `x` — every `expect.*` field is
 *  caller-controlled and only TYPED as `Address`/`bigint`, so a runtime caller that bypasses the
 *  type system (the exact scenario `verifySettleProgram`'s own recipient-required guard already
 *  anticipates) can otherwise crash a function documented to "never throw". Returns `null` on any
 *  parse failure instead — callers treat `null` as "cannot possibly match", i.e. a clean `'fail'`,
 *  never an unchecked exception. */
function safeBigInt(v) {
    if (v === undefined || v === null)
        return null;
    if (typeof v === "bigint")
        return v;
    try {
        return BigInt(v);
    }
    catch {
        return null;
    }
}
function matchTemplate(hash, templates) {
    const norm = hash.toLowerCase();
    return templates.find((t) => t.bodyHash.toLowerCase() === norm);
}
function push(build, check, code) {
    build.checks.push(check);
    if (build.failureCode === null && check.severity === "blocking" && check.status !== "pass" && code) {
        build.failureCode = code;
    }
}
/** Shared engine behind both `inspectSettleProgram` and `verifySettleProgram` — builds every
 *  check that does NOT depend on caller expectations (shape/body/template/serverEcho), plus the
 *  decoded value. Both entry points then call `pushIntentChecks` (with `null` or a real
 *  expectation respectively) and `buildEffects` on top of what this returns. */
function buildBase(program, opts) {
    const parse = parseSettleProgram(program);
    const decoded = bestEffortDecode(parse);
    const build = { checks: [], failureCode: null };
    const templates = opts.templates ?? SETTLE_TEMPLATES;
    // shape.pushes — the leading token-push run (and, by extension, the minOut/recipient pushes
    // that follow it) all present and untruncated.
    //
    // The branch below tests `parse.fatal?.code === "NOT_SETTLE_SHAPED"` — NOT `parse.tokenPushes.
    // length === 0` (the pre-fix condition). Both are true when byte 0 isn't a push opcode at all
    // (the genuine NOT_SETTLE_SHAPED case), but `tokenPushes.length === 0` is ALSO true whenever the
    // very FIRST token push fails a scan (a non-minimal push, an oversize address, or a plain
    // truncation AT POSITION 0 — e.g. a single-token settle program with a malformed leading push):
    // the scan loop returns immediately on that failure, before ever recording a push. Testing the
    // array length there misattributed a real NON_MINIMAL_PUSH/OVERSIZE_ADDRESS to the generic
    // NOT_SETTLE_SHAPED code and, worse, made `shape.canonical` below render 'unchecked' instead of
    // the actual 'fail' — the SPECIFIC canonicality check the wire spec (§9) publishes as a stable,
    // switchable failure code was silently skipped for exactly the input it exists to catch.
    // `parse.fatal.code` carries the TRUE reason regardless of scan position, so testing it directly
    // is both correct and simpler.
    const truncationCode = parse.fatal?.code === "EMPTY"
        ? "EMPTY"
        : parse.fatal?.code === "NOT_SETTLE_SHAPED"
            ? "NOT_SETTLE_SHAPED"
            : parse.tokenScanError?.code === "TRUNCATED_PUSH"
                ? "TRUNCATED_PUSH"
                : (parse.minOutError?.code === "TRUNCATED_MINOUT" ? "TRUNCATED_MINOUT" : null) ??
                    (parse.recipientError?.code === "TRUNCATED_RECIPIENT" ? "TRUNCATED_RECIPIENT" : null);
    push(build, {
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
    }, truncationCode ?? undefined);
    // shape.canonical — minimality + the 20-byte address cap (§6 of the wire spec — the three
    // gaps the recipes package's original decoder accepted).
    const canonError = (parse.tokenScanError?.code === "NON_MINIMAL_PUSH" || parse.tokenScanError?.code === "OVERSIZE_ADDRESS" ? parse.tokenScanError : null) ??
        (parse.minOutError?.code === "NON_MINIMAL_PUSH" ? parse.minOutError : null) ??
        (parse.recipientError?.code === "NON_MINIMAL_PUSH" || parse.recipientError?.code === "OVERSIZE_ADDRESS" ? parse.recipientError : null);
    const canonUnchecked = truncationCode !== null;
    push(build, {
        id: "shape.canonical",
        title: "Every push is minimal-length; token/recipient pushes are ≤20 bytes.",
        status: canonUnchecked ? "unchecked" : canonError ? "fail" : "pass",
        severity: "blocking",
        compared: "each push's declared width against the minimal-length rule (no leading zero byte) and, for token/recipient slots, a 20-byte cap",
        expected: "no leading-zero, non-minimal pushes; no token/recipient push wider than 20 bytes",
        actual: canonUnchecked ? "not evaluated — an earlier truncation prevented a full scan" : canonError ? canonError.message : "all pushes minimal and correctly sized",
        proves: "the encoding is the UNIQUE canonical form of its decoded value (no alternate byte string decodes to the same tokens/minOut/recipient). Rejects a non-minimal push and an oversized (>20 byte) address word — two shapes a naive decoder accepts as ok:true.",
    }, canonError?.code);
    // shape.tuple
    const tupleUnchecked = parse.tokenPushes.length === 0 || truncationCode !== null;
    const tupleFail = !tupleUnchecked && !parse.tupleOk;
    push(build, {
        id: "shape.tuple",
        title: "The byte after the token pushes is the TUPLE opcode (0x94).",
        status: tupleUnchecked ? "unchecked" : tupleFail ? "fail" : "pass",
        severity: "blocking",
        compared: `byte at offset ${parse.tupleOffset ?? "n/a"} against 0x94`,
        expected: "0x94",
        actual: tupleUnchecked ? "not reached" : tupleFail ? (parse.fatal?.message ?? "mismatch") : "0x94",
        proves: "the token array is closed by the compiler's TUPLE-build opcode — the shape a settle program's array argument always compiles to.",
    }, tupleFail ? "NOT_SETTLE_SHAPED" : undefined);
    // shape.arity
    const arityUnchecked = !parse.tupleOk;
    const arityFail = !arityUnchecked && !parse.arityOk;
    push(build, {
        id: "shape.arity",
        title: "The TUPLE arity byte equals the number of leading token pushes.",
        status: arityUnchecked ? "unchecked" : arityFail ? "fail" : "pass",
        severity: "blocking",
        compared: `arity byte (${parse.arityByte ?? "n/a"}) against the ${parse.tokenPushes.length} pushes scanned`,
        expected: `${parse.tokenPushes.length}`,
        actual: arityUnchecked ? "not reached" : String(parse.arityByte ?? "missing"),
        proves: "the token array's declared length matches what was actually pushed — a mismatch here means the array is truncated or padded relative to its own header.",
    }, arityFail ? "ARITY_MISMATCH" : undefined);
    // shape.recipientNonZero
    const recipUnchecked = parse.recipientPush === null;
    const recipFail = !recipUnchecked && !parse.recipientNonZero;
    push(build, {
        id: "shape.recipientNonZero",
        title: "The recipient decodes to a nonzero address.",
        status: recipUnchecked ? "unchecked" : recipFail ? "fail" : "pass",
        severity: "blocking",
        compared: "decoded recipient word against 0",
        expected: "nonzero",
        actual: recipUnchecked ? "not reached" : recipFail ? "0x0000000000000000000000000000000000000000" : renderAddr(parse.recipientPush.value),
        proves: "every swept token has a real destination. A zero recipient is a program that (depending on the runtime's zero-address semantics) either reverts or burns the swept tokens — never intended.",
    }, recipFail ? "ZERO_RECIPIENT" : undefined);
    // body.size
    const bodyUnchecked = parse.body === null;
    const bodySize = parse.body?.length ?? null;
    const bodySizeFail = !bodyUnchecked && bodySize !== 165;
    push(build, {
        id: "body.size",
        title: "The constant body suffix is exactly 165 bytes.",
        status: bodyUnchecked ? "unchecked" : bodySizeFail ? "fail" : "pass",
        severity: "blocking",
        compared: "suffix byte length against 165",
        expected: "165",
        actual: bodyUnchecked ? "not reached" : String(bodySize),
        proves: "a length mismatch alone (before even hashing) proves this is not our template body — cheaper and clearer than an opaque hash mismatch.",
    }, bodySizeFail ? "BODY_LENGTH" : undefined);
    // body.hash / template.status / authenticity decision
    const actualHash = parse.bodyHash;
    const tableMatch = actualHash ? matchTemplate(actualHash, templates) : undefined;
    let hashSource = "pinned";
    let authenticated = false;
    let bodyHashStatus = "unchecked";
    let bodyHashCode;
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
        }
        else {
            // The trust root consulted here is `templates` (declared above as `opts.templates ??
            // SETTLE_TEMPLATES`) — when the CALLER supplied `opts.templates`, the table itself is
            // caller-controlled even though no single `expectedBodyHash` was given, so the authenticity
            // decision did NOT trust this package's own pinned table. Label it 'caller' — NOT 'pinned' —
            // so a forwarded report never misattributes an override table's verdict to our own root.
            hashSource = opts.templates !== undefined ? "caller" : "pinned";
            if (!tableMatch) {
                authenticated = false;
                bodyHashStatus = "fail";
                bodyHashCode = "BODY_HASH";
            }
            else if (tableMatch.status === "revoked") {
                authenticated = false;
                bodyHashStatus = "fail";
                bodyHashCode = "TEMPLATE_REVOKED";
            }
            else if (tableMatch.status === "superseded") {
                authenticated = opts.acceptSuperseded !== false;
                bodyHashStatus = authenticated ? "pass" : "fail";
                bodyHashCode = authenticated ? undefined : "BODY_HASH";
            }
            else {
                authenticated = true;
                bodyHashStatus = "pass";
            }
            bodyHashActual = actualHash;
            bodyHashExpected = tableMatch ? tableMatch.bodyHash : `${CURRENT_SETTLE_TEMPLATE.bodyHash} (or another accepted table entry)`;
        }
    }
    push(build, {
        id: "body.hash",
        title: "keccak256 of the 165-byte body matches an accepted template — this is our audited program, verbatim.",
        status: bodyHashStatus,
        severity: "blocking",
        compared: "keccak256 of the constant body suffix",
        expected: bodyHashExpected,
        actual: bodyHashActual,
        proves: "this is our audited template verbatim — nothing appended, no extra branch or call after the prologue. Does NOT constrain WHICH tokens are listed or WHOSE recipient is set — see the intent.* checks and the FULL_BALANCE_SWEEP disclosure.",
    }, bodyHashCode);
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
        proves: "version skew between this program and the package's current template — informational; a superseded-but-accepted match is still authentic (see body.hash), this only flags that you're on an older audited version.",
    });
    // NOTE: `intent.floorToken` (and `intent.recipient`/`intent.tokens`/`intent.minOut`) are pushed
    // by `pushIntentChecks` below — NOT here. `buildBase` is expectation-blind (it has no `expect`
    // parameter — `inspectSettleProgram` never has one to give it), so every check that depends on
    // whether an expectation was supplied lives in the one function both entry points call after
    // this returns. See that function's doc for why `intent.floorToken` used to manufacture a `pass`
    // here with nothing to compare against.
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
            proves: "NOT a security check — comparing a program to a hash shipped alongside that program is self-certification. This exists solely to surface version skew between what you computed and what the server believes it sent.",
        });
    }
    else {
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
    // `structurallyValid`: every blocking check EXCEPT body.hash passes — i.e. the bytes are a
    // well-formed, canonical `(tokens, minOut, recipient) || body[165]` wire program, independent of
    // WHOSE program it is or whether the body matches our template. `authentic` (== the `authenticated`
    // local above) is body.hash ALONE — the body matches an accepted template entry. Neither says
    // anything about intent (tokens/recipient/minOut) — see `pushIntentChecks`' doc for that half.
    const structurallyValid = build.checks.every((c) => c.severity !== "blocking" || c.id === "body.hash" || c.status === "pass");
    return { build, decoded, templateId, templateVersion, hashSource, authenticated, structurallyValid };
}
/** Build `effects[]` — a BEHAVIORAL claim ("this program, if cooked, moves these tokens"), so it
 *  is gated on `structurallyValid && authentic` (this IS our audited template, well-formed,
 *  decodable), NOT on the full report `ok` (which also folds in `intent.*` — a caller's WRONG
 *  expected recipient/tokens doesn't change what the bytecode actually does, it only fails the
 *  comparison) and NOT on `authenticated`/body-hash alone as before: `parseSettleProgram` keeps
 *  parsing the body (to show a rejected program's would-be state) even after a ZERO_RECIPIENT
 *  fatal, so an authenticated-but-structurally-rejected program (e.g. a zero recipient) used to
 *  still emit effect rows claiming a real transfer to `0x000…000` — a behavioral claim about a
 *  program THIS report structurally rejected. `inspectSettleProgram`'s permanently-unchecked
 *  `intent.*` (see `pushIntentChecks`) therefore does NOT suppress effects — "see what this
 *  program does" is exactly inspect's job, and remains available whenever the bytes genuinely are
 *  our template. */
function buildEffects(decoded, structurallyValid, authentic) {
    const effects = [];
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
/**
 * Push the four `intent.*` checks — `recipient`/`tokens`/`minOut`/`floorToken` — the ONE place
 * both entry points build them, so `checks[]` is IDENTICAL in shape between `inspectSettleProgram`
 * and `verifySettleProgram`: every check the report format supports is ALWAYS present with a real
 * status, never omitted by mode (this is what `api/README.md`'s "one row per check ... never
 * omitted" claim actually requires, and what makes `inspectSettleProgram`'s inability to check
 * intent VISIBLE — a permanent 'unchecked' row — rather than the check simply not existing).
 *
 * `expect === null` is `inspectSettleProgram`'s call — there is NO expectation, ever, so:
 *   - `intent.recipient` / `intent.tokens` render `'unchecked'` + `'blocking'` (code
 *     `INTENT_UNCHECKED`) — NEVER `'pass'`, because passing would claim an assurance inspect
 *     cannot provide. This is what makes `ok` permanently `false` for `inspectSettleProgram` (see
 *     the module doc) — a designed consequence, not a special case bolted onto `ok` itself.
 *   - `intent.minOut` / `intent.floorToken` render `'unchecked'` + `'advisory'` — informational
 *     only (mirrors `verifySettleProgram`'s own "neither minOut field supplied" case below; a
 *     floor was never claimed, so there is nothing to forcibly fail).
 *
 * `expect !== null` is `verifySettleProgram`'s call — `expect.recipient` is guaranteed present
 * (enforced at that function's entry). The one NEW behavior versus the pre-existing per-field
 * logic: `intent.floorToken`.
 *   - Supplied (`expect.floorToken !== undefined`): a REAL, blocking pass/fail comparison against
 *     `decoded.floorToken` (== `decoded.tokens[0]`).
 *   - NOT supplied, but the caller supplied `minOut`/`minMinOut` AND did not pin position 0 via an
 *     EXACT `tokens` list (only `allowTokens`, or no token expectation at all): this FORCES
 *     `'unchecked'` + `'blocking'` (code `INTENT_UNCHECKED`) — a `minOut` expectation is a claim
 *     about a SPECIFIC token's balance, and `allowTokens` is order-free by design (§ its own doc),
 *     so without `floorToken` (or an exact `tokens` list) the floor's target is UNVERIFIED even
 *     though the caller asked about it. This is the fix for the exact exploit it closes: `verify
 *     (prog, {recipient, allowTokens:[OUT,IN], minOut})` used to return `ok:true` for BOTH the
 *     honest `[OUT,IN]` program and an attacker's `[IN,OUT]` — permuting the SAME allowed set moves
 *     the floor onto the leftover input while `intent.tokens`/`intent.minOut` both still pass. The
 *     report now REFUSES `ok:true` for either UNTIL the caller pins the floor's identity — at which
 *     point the honest program passes and the attacker's fails (`decoded.floorToken` differs).
 *   - NOT supplied, `minOut`/`minMinOut` not supplied either (or position already pinned via exact
 *     `tokens`): `'unchecked'` + `'advisory'` — informational, does not gate `ok` (an exact `tokens`
 *     list already order-pins position 0 via `intent.tokens`, so no additional gate is needed).
 */
function pushIntentChecks(build, decoded, expect) {
    const e = expect ?? {};
    // intent.recipient
    if (expect === null) {
        push(build, {
            id: "intent.recipient",
            title: "Decoded recipient matches the expected recipient.",
            status: "unchecked",
            severity: "blocking",
            compared: "decoded recipient vs. expect.recipient",
            expected: "(inspectSettleProgram takes no expectation — call verifySettleProgram with expect.recipient to check this)",
            actual: decoded ? renderAddr(decoded.recipient) : "not reached",
            proves: "the destination of every swept token, including the floor token's overflow above minOut.",
        }, "INTENT_UNCHECKED");
    }
    else {
        const expectRecip = safeBigInt(e.recipient);
        const recipMatch = decoded !== null && expectRecip !== null && BigInt(decoded.recipient) === expectRecip;
        push(build, {
            id: "intent.recipient",
            title: "Decoded recipient matches the expected recipient.",
            status: decoded === null ? "unchecked" : recipMatch ? "pass" : "fail",
            severity: "blocking",
            compared: "decoded recipient vs. expect.recipient",
            expected: renderAddr(e.recipient),
            actual: decoded ? renderAddr(decoded.recipient) : "not reached",
            proves: "the destination of every swept token, including the floor token's overflow above minOut.",
        }, decoded === null ? undefined : recipMatch ? undefined : "EXPECT_RECIPIENT");
    }
    // intent.tokens — blocking always; unchecked (forcing ok:false) when neither tokens nor
    // allowTokens is supplied (including inspect's permanent no-expectation case). `tokens` (exact,
    // order-sensitive) takes precedence over `allowTokens` (containment) when both are given.
    let tokensStatus;
    let tokensExpected;
    let tokensActual;
    let tokensCode;
    if (e.tokens !== undefined) {
        tokensExpected = `[${e.tokens.map(renderAddr).join(", ")}] (exact, in order)`;
        if (decoded === null) {
            tokensStatus = "unchecked";
            tokensActual = "not reached";
        }
        else {
            const want = e.tokens.map((t) => safeBigInt(t));
            const got = decoded.tokens.map((t) => BigInt(t));
            const same = want.length === got.length && want.every((w, i) => w !== null && w === got[i]);
            tokensStatus = same ? "pass" : "fail";
            tokensActual = `[${decoded.tokens.map(renderAddr).join(", ")}]`;
            tokensCode = same ? undefined : "EXPECT_TOKENS";
        }
    }
    else if (e.allowTokens !== undefined) {
        const allowSet = new Set(e.allowTokens.map((t) => safeBigInt(t)).filter((v) => v !== null));
        tokensExpected = `every decoded token ∈ {${e.allowTokens.map(renderAddr).join(", ")}}`;
        if (decoded === null) {
            tokensStatus = "unchecked";
            tokensActual = "not reached";
        }
        else {
            const outside = decoded.tokens.filter((t) => !allowSet.has(BigInt(t)));
            tokensStatus = outside.length === 0 ? "pass" : "fail";
            tokensActual = outside.length === 0 ? `[${decoded.tokens.map(renderAddr).join(", ")}] — all allowed` : `contains disallowed token(s): [${outside.map(renderAddr).join(", ")}]`;
            tokensCode = outside.length === 0 ? undefined : "EXPECT_TOKENS";
        }
    }
    else {
        tokensStatus = "unchecked";
        tokensExpected =
            expect === null
                ? "(inspectSettleProgram takes no expectation — call verifySettleProgram with expect.tokens/allowTokens to check this)"
                : "(neither expect.tokens nor expect.allowTokens supplied)";
        tokensActual = decoded ? `[${decoded.tokens.map(renderAddr).join(", ")}] — NOT compared against anything` : "not reached";
        tokensCode = "INTENT_UNCHECKED";
    }
    push(build, {
        id: "intent.tokens",
        title: "Decoded token list matches the expected list (or stays within the allowed set).",
        status: tokensStatus,
        severity: "blocking",
        compared: "decoded token list vs. expect.tokens / expect.allowTokens",
        expected: tokensExpected,
        actual: tokensActual,
        proves: "the FULL_BALANCE_SWEEP hazard's actual scope: which tokens leave the Pot at their whole balance. An unchecked status here means NOTHING about the token list was verified — treat that as a failure, not a pass.",
    }, tokensCode);
    // intent.minOut — advisory+unchecked when neither minOut nor minMinOut is supplied (including
    // inspect's permanent no-expectation case); becomes blocking (pass/fail) once either is.
    const minOutSupplied = e.minOut !== undefined || e.minMinOut !== undefined;
    let minOutStatus;
    let minOutActual;
    let minOutExpected;
    let minOutCode;
    if (!minOutSupplied) {
        minOutStatus = "unchecked";
        minOutExpected =
            expect === null
                ? "(inspectSettleProgram takes no expectation — call verifySettleProgram with expect.minOut/minMinOut to check this)"
                : "(neither expect.minOut nor expect.minMinOut supplied)";
        minOutActual = decoded ? String(decoded.minOut) : "not reached";
    }
    else if (decoded === null) {
        minOutStatus = "unchecked";
        minOutExpected = e.minOut !== undefined ? `== ${e.minOut}` : `>= ${e.minMinOut}`;
        minOutActual = "not reached";
    }
    else if (e.minOut !== undefined) {
        const pass = decoded.minOut === e.minOut;
        minOutStatus = pass ? "pass" : "fail";
        minOutExpected = `== ${e.minOut}`;
        minOutActual = String(decoded.minOut);
        minOutCode = pass ? undefined : "EXPECT_MINOUT";
    }
    else {
        const pass = decoded.minOut >= e.minMinOut;
        minOutStatus = pass ? "pass" : "fail";
        minOutExpected = `>= ${e.minMinOut}`;
        minOutActual = String(decoded.minOut);
        minOutCode = pass ? undefined : "EXPECT_MINOUT";
    }
    push(build, {
        id: "intent.minOut",
        title: "Decoded minOut matches (or clears) the expected floor.",
        status: minOutStatus,
        severity: minOutSupplied ? "blocking" : "advisory",
        compared: "decoded minOut vs. expect.minOut (exact) or expect.minMinOut (floor)",
        expected: minOutExpected,
        actual: minOutActual,
        proves: "minOut is checked against the Pot's WHOLE floor-token balance at settle time, not this trade's delta (see FLOOR_IS_LEVEL_NOT_DELTA) — a pass here is not proof this trade alone produced the amount.",
    }, minOutCode);
    // intent.floorToken — see this function's doc for the forfeiture rule. `tokens[0]` is the ONLY
    // token `minOut` is ever checked against (FLOOR_IS_LEVEL_NOT_DELTA), and it is POSITIONAL, so
    // `allowTokens` (order-free by definition) can never itself pin it.
    const positionPinned = e.tokens !== undefined; // an exact, order-sensitive list already covers position 0
    const forfeited = expect !== null && !positionPinned && minOutSupplied; // a floor was claimed with no way to name its token
    let floorStatus;
    let floorSeverity;
    let floorExpected;
    let floorCode;
    if (e.floorToken !== undefined) {
        const expectFloor = safeBigInt(e.floorToken);
        const floorMatch = decoded !== null && expectFloor !== null && BigInt(decoded.floorToken) === expectFloor;
        floorStatus = decoded === null ? "unchecked" : floorMatch ? "pass" : "fail";
        floorSeverity = "blocking";
        floorExpected = renderAddr(e.floorToken);
        floorCode = decoded === null ? undefined : floorMatch ? undefined : "EXPECT_FLOOR_TOKEN";
    }
    else if (forfeited) {
        floorStatus = "unchecked";
        floorSeverity = "blocking";
        floorExpected =
            "(minOut/minMinOut was supplied, but the floor token's identity was pinned by neither expect.floorToken nor an exact expect.tokens list — allowTokens is order-free and cannot pin position 0, so the floor's target is UNVERIFIED; this report cannot claim ok:true until one of those is supplied)";
        floorCode = "INTENT_UNCHECKED";
    }
    else {
        floorStatus = "unchecked";
        floorSeverity = "advisory";
        floorExpected =
            expect === null
                ? "(inspectSettleProgram takes no expectation — call verifySettleProgram with expect.floorToken to check this)"
                : "(no expect.floorToken supplied, and no minOut/minMinOut floor was claimed that would need one)";
    }
    push(build, {
        id: "intent.floorToken",
        title: "tokens[0] is the floor token — checked before any transfer runs.",
        status: floorStatus,
        severity: floorSeverity,
        compared: "position 0 of the decoded token list vs. expect.floorToken",
        expected: floorExpected,
        actual: decoded ? renderAddr(decoded.floorToken) : "not reached",
        proves: "which token's Pot balance the minOut floor is checked against. Reversing the token list by mistake (or permuting an allowTokens-only set) silently swaps this to the wrong token — an 'unchecked' status here means minOut's target token was NOT verified, and forces ok:false whenever a floor was actually claimed (severity:'blocking').",
    }, floorCode);
}
/**
 * SEE — never throws, requires no expectations. This is the "show me the validation phase" call:
 * renders EVERY check `verifySettleProgram` would (shape/body/template/serverEcho AND the four
 * `intent.*` rows — see `pushIntentChecks`), with no expectation to compare against, ever. Because
 * of that, `intent.recipient`/`intent.tokens` are PERMANENTLY `'unchecked'`+`'blocking'`, which
 * makes this function's `ok` PERMANENTLY `false` — see the module doc for why that is correct, not
 * a defect: `ok` is a gate result, and this function never gates anything. Use
 * `structurallyValid`/`authentic` for "is this genuinely our template, well-formed" instead.
 */
export function inspectSettleProgram(program, opts = {}) {
    const { build, decoded, templateId, templateVersion, hashSource, structurallyValid, authenticated } = buildBase(program, opts);
    pushIntentChecks(build, decoded, null);
    const ok = build.checks.every((c) => c.severity !== "blocking" || c.status === "pass");
    return {
        ok,
        mode: "inspect",
        templateId,
        templateVersion,
        hashSource,
        structurallyValid,
        authentic: authenticated,
        failureCode: build.failureCode,
        decoded,
        checks: build.checks,
        effects: buildEffects(decoded, structurallyValid, authenticated),
        disclosures: DISCLOSURES.slice(),
    };
}
/**
 * GATE — never throws. `expect.recipient` is REQUIRED (see `SettleExpectation`). Calls
 * `pushIntentChecks` with the REAL expectation (real pass/fail comparisons, not permanently-
 * unchecked placeholders) and derives `ok` over the full check set.
 */
export function verifySettleProgram(program, expect, opts = {}) {
    if (!expect || expect.recipient === undefined || expect.recipient === null) {
        throw new TypeError("verifySettleProgram: expect.recipient is REQUIRED (a runtime caller bypassed the type system)");
    }
    const { build, decoded, templateId, templateVersion, hashSource, structurallyValid, authenticated } = buildBase(program, opts);
    pushIntentChecks(build, decoded, expect);
    const ok = build.checks.every((c) => c.severity !== "blocking" || c.status === "pass");
    return {
        ok,
        mode: "verify",
        templateId,
        templateVersion,
        hashSource,
        structurallyValid,
        authentic: authenticated,
        failureCode: build.failureCode,
        decoded,
        checks: build.checks,
        effects: buildEffects(decoded, structurallyValid, authenticated),
        disclosures: DISCLOSURES.slice(),
    };
}
const STATUS_GLYPH = { pass: "✓", fail: "✗", unchecked: "·" };
/** Render a report as fixed-width plain text — checks, then effects, then disclosures. This is
 *  the deliverable a partner pastes into a support ticket: "seeing the validation phase" is a
 *  `console.log`, not a JSON-schema exercise. */
export function formatSettleReport(r) {
    const lines = [];
    lines.push(`SETTLE PROGRAM REPORT — mode=${r.mode} ok=${r.ok} structurallyValid=${r.structurallyValid} authentic=${r.authentic} ` +
        `template=${r.templateId ?? "?"}@${r.templateVersion ?? "?"} hashSource=${r.hashSource}`);
    if (r.mode === "inspect") {
        lines.push("  (inspect mode NEVER checks intent — ok is permanently false here; read structurallyValid/authentic and checks[] instead)");
    }
    if (r.failureCode)
        lines.push(`  failureCode: ${r.failureCode}`);
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
        lines.push("  (none — program is not both structurally valid AND authentic; no behavioral claim can be made)");
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
//# sourceMappingURL=report.js.map