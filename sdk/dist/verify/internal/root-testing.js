/** ALLOW-LIST, never a deny-list. Only these two literal, correctly-cased strings ever
 *  authenticate — every other value (a typo, a different case, `undefined`, an empty string, a
 *  future status this function doesn't know about yet) falls through to `false`. This replaces a
 *  prior `status !== "revoked"` deny-list comparison, which meant `'REVOKED'`, `undefined`, and any
 *  unrecognized string all authenticated — a hand-maintained list of what fails, with everything
 *  unenumerated defaulting to pass, is the exact shape of bug this function must never repeat. */
function isAcceptedStatus(status, acceptSuperseded) {
    if (status === "current")
        return true;
    if (status === "superseded")
        return acceptSuperseded;
    return false;
}
/** B3-style container-vs-element guard: `root` is validated as an array by the caller, but a
 *  garbage/test-injected ELEMENT (`null`, `undefined`, `{}`, `{bodyHash: 1}`) must never throw —
 *  it simply never matches, the same "unrecognized input treated as no match" rule every other
 *  garbage-input path in this module follows. */
function matchInRoot(hash, root) {
    const norm = hash.toLowerCase();
    return root.find((t) => t !== null && typeof t === "object" && typeof t.bodyHash === "string" && t.bodyHash.toLowerCase() === norm);
}
/**
 * THE single authenticity decision, parameterized by `root` — see this file's header. `bodyHash`
 * is `null` when the program never decoded far enough to have one (an empty/malformed program);
 * that is reported as `{authentic:false, entry:null, code:undefined}` and the caller renders the
 * corresponding check as `'unchecked'`, not `'fail'`.
 *
 * FAIL-CLOSED GUARD: a prior fix asserted `authentic:true` alongside `templateId:null` could
 * "never" co-occur — an internally contradictory pair (claiming "this IS our audited template" for
 * a body matching no template at all). That assertion held only as long as every matched root row
 * was a well-formed `TemplateEntry` — a matched-but-`id`-less row (reachable only through this
 * file's test-only `root` parameter, since `SETTLE_TEMPLATES` itself is a real, well-formed table)
 * must not authenticate silently. It is forced closed here with its own distinct code so the
 * contradiction stays impossible even through the test hook that can inject a malformed root.
 */
export function authenticateBodyAgainstRoot(bodyHash, acceptSuperseded, root) {
    if (!bodyHash)
        return { authentic: false, entry: null, code: undefined };
    const entry = matchInRoot(bodyHash, root) ?? null;
    if (!entry)
        return { authentic: false, entry: null, code: "BODY_HASH" };
    if (typeof entry.id !== "string" || entry.id.length === 0) {
        return { authentic: false, entry, code: "INTERNAL_INCONSISTENT" };
    }
    if (!isAcceptedStatus(entry.status, acceptSuperseded)) {
        // `TEMPLATE_REVOKED` is kept as the specific code only for the literal `'revoked'` status
        // (matching this function's prior behavior and giving a clearer message for the expected
        // rotation path); every other rejected status — mis-cased, unknown, missing — falls back to
        // the more general `BODY_HASH` code. Either way `authentic` is `false`.
        const code = entry.status === "revoked" ? "TEMPLATE_REVOKED" : "BODY_HASH";
        return { authentic: false, entry, code };
    }
    return { authentic: true, entry, code: undefined };
}
//# sourceMappingURL=root-testing.js.map