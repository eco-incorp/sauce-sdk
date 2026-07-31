import type { Hex } from "viem";
import type { TemplateEntry } from "../template.js";
import type { SettleFailureCode } from "../decode.js";
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
export declare function authenticateBodyAgainstRoot(bodyHash: Hex | null, acceptSuperseded: boolean, root: readonly TemplateEntry[]): AuthenticateResult;
//# sourceMappingURL=root-testing.d.ts.map