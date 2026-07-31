import type { Hex } from "viem";
import type { TemplateEntry } from "../template.js";
import type { SettleFailureCode } from "../decode.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE TRUST BOUNDARY. `authenticateBodyAgainstRoot` is the ONLY function in this module that
// decides whether a body hash is "our audited template" — and it is parameterized by an explicit
// `root` table specifically so this file can stay import-only for a test (`sdk/test/verify.test.ts`
// reaches it via a relative path) while the PUBLIC surface (`../report.ts`'s `authenticateBody`)
// always calls it with `SETTLE_TEMPLATES`, the package's own pinned constant, and NOTHING a caller
// supplies. This file is NOT re-exported from `../index.ts` (the public `@eco-incorp/sauce-sdk/verify`
// barrel) and the package's `exports` map in `package.json` has no subpath reaching
// `verify/internal/*` at all — the root parameter is a CALL SHAPE only this repo's own test can
// reach, never a string or table a real caller can pass in.
//
// This is the fix for the root cause this module used to carry: `authentic` was derived from
// `opts.templates ?? SETTLE_TEMPLATES` — a table the FUNCTION PARAMETER supplied, i.e. attacker-
// controlled in exactly the same way `program`/`expect` are. A caller who could supply
// `[{bodyHash: keccak256(forgedBody)}]` authenticated their own forgery. There is now no parameter,
// anywhere on the public surface, through which a table reaches this function — `root` is fixed to
// `SETTLE_TEMPLATES` at the one production call site and nowhere else.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface AuthenticateResult {
  /** `true` iff `bodyHash` matched a root entry whose `status` is on the ALLOW-LIST below. */
  authentic: boolean;
  /** The matched root entry, if any — independent of `authentic` (a matched-but-`revoked` entry
   *  still populates this, so a report can say WHICH template a rejected body named). `null` when
   *  no entry's `bodyHash` matches at all. */
  entry: TemplateEntry | null;
  /** Present iff `authentic` is `false` and there is a specific code to report; `undefined` when
   *  `authentic` is `true` or when `bodyHash` was `null` (nothing to authenticate — the caller
   *  renders that case as `'unchecked'`, not `'fail'`). */
  code: SettleFailureCode | undefined;
}

/** ALLOW-LIST, never a deny-list. Only these two literal, correctly-cased strings ever
 *  authenticate — every other value (a typo, a different case, `undefined`, an empty string, a
 *  future status this function doesn't know about yet) falls through to `false`. This replaces a
 *  prior `status !== "revoked"` deny-list comparison, which meant `'REVOKED'`, `undefined`, and any
 *  unrecognized string all authenticated — a hand-maintained list of what fails, with everything
 *  unenumerated defaulting to pass, is the exact shape of bug this function must never repeat. */
function isAcceptedStatus(status: unknown, acceptSuperseded: boolean): boolean {
  if (status === "current") return true;
  if (status === "superseded") return acceptSuperseded;
  return false;
}

/** B3-style container-vs-element guard: `root` is validated as an array by the caller, but a
 *  garbage/test-injected ELEMENT (`null`, `undefined`, `{}`, `{bodyHash: 1}`) must never throw —
 *  it simply never matches, the same "unrecognized input treated as no match" rule every other
 *  garbage-input path in this module follows. */
function matchInRoot(hash: Hex, root: readonly TemplateEntry[]): TemplateEntry | undefined {
  const norm = hash.toLowerCase();
  return root.find(
    (t) => t !== null && typeof t === "object" && typeof (t as TemplateEntry).bodyHash === "string" && (t as TemplateEntry).bodyHash.toLowerCase() === norm,
  );
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
export function authenticateBodyAgainstRoot(bodyHash: Hex | null, acceptSuperseded: boolean, root: readonly TemplateEntry[]): AuthenticateResult {
  if (!bodyHash) return { authentic: false, entry: null, code: undefined };

  const entry = matchInRoot(bodyHash, root) ?? null;
  if (!entry) return { authentic: false, entry: null, code: "BODY_HASH" };

  if (typeof entry.id !== "string" || entry.id.length === 0) {
    return { authentic: false, entry, code: "INTERNAL_INCONSISTENT" };
  }

  if (!isAcceptedStatus(entry.status, acceptSuperseded)) {
    // `TEMPLATE_REVOKED` is kept as the specific code only for the literal `'revoked'` status
    // (matching this function's prior behavior and giving a clearer message for the expected
    // rotation path); every other rejected status — mis-cased, unknown, missing — falls back to
    // the more general `BODY_HASH` code. Either way `authentic` is `false`.
    const code: SettleFailureCode = entry.status === "revoked" ? "TEMPLATE_REVOKED" : "BODY_HASH";
    return { authentic: false, entry, code };
  }

  return { authentic: true, entry, code: undefined };
}
