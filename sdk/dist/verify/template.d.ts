import type { Hex } from "viem";
export type TemplateStatus = "current" | "superseded" | "revoked";
export interface TemplateEntry {
    /** Stable identifier for the settle-program family this row describes. Only `"ecoswap-settle"`
     *  exists today. */
    id: string;
    /** Monotonically increasing per `id`, bumped on any change to the emitted body. */
    version: string;
    /** keccak256 of the compiled program's constant 165-byte body (everything after the
     *  `(tokens, minOut, recipient)` prologue — see decode.ts). This is the sole authenticity root:
     *  a program whose body hashes to this value is, byte-for-byte, this audited template. */
    bodyHash: Hex;
    /** Byte length of the body this hash covers — pinned alongside the hash purely so a length
     *  mismatch produces a clearer failure (`BODY_LENGTH`) than an opaque hash mismatch. */
    bodySize: number;
    /** The `sauce-sdk` commit SHA whose compiler pin produced this hash — provenance, not a
     *  functional input to verification. */
    compilerSha: string;
    status: TemplateStatus;
    /** ISO-ish "since" marker — informational. */
    since: string;
    notes: string;
}
/**
 * PINNED authenticity table for `ecoswap-settle` v12 program bodies.
 *
 * This is a PINNED CONSTANT, not a re-derivation: a partner's verification is one `keccak256` and
 * a 32-byte compare against this table — no compiler, no filesystem, no recipes checkout. The
 * value below was obtained by compiling the real `token-sweep.sauce.ts` template against this
 * package's `compiler` pin and hashing the decoded body (arbitrary 1/2/3/9-token lists and
 * varying `minOut`/`recipient` all reproduce the identical 165-byte body and this identical
 * hash — the body is a function of the template and the compiler pin ONLY, never of the
 * arguments).
 *
 * The recipes package independently RE-DERIVES this same value at test time by actually compiling
 * the template (`settleBodyHashV12()`) and asserts it equals `CURRENT_SETTLE_TEMPLATE.bodyHash` —
 * see that package's `test/fast/settle-verify.pin.test.ts`. That test is what keeps this constant
 * from silently drifting: any template edit or compiler re-pin that changes the emitted body turns
 * it red until this table gains a new entry and the old one is marked `superseded`. This table
 * itself must never be hand-edited without that companion test passing against the change.
 *
 * `status` handling (see `report.ts`'s `VerifyOpts.acceptSuperseded`, default `true`): a
 * `superseded` entry still authenticates (an older, still-audited body) but is flagged via the
 * `template.status` advisory check; `revoked` never authenticates at any setting — the escape
 * hatch for a template found defective after the fact.
 *
 * FROZEN — not just `readonly`-TYPED. `readonly` is a TYPE-LEVEL annotation only: it stops the
 * compiler from letting well-typed code call `.push`/assign an index, but it does nothing at
 * runtime, and this table is re-exported from the PUBLIC `./verify` barrel (`index.ts`), reachable
 * by any consumer that imports the package. Without a runtime freeze, `SETTLE_TEMPLATES.push({id:
 * "pwn", status: "current", bodyHash: <forgedHash>, ...})` silently succeeds and a subsequent
 * `verifySettleProgram(forgedProgram, matchingExpect)` authenticates the forgery — the same class
 * of escape as monkeypatching the function, and the obvious next shape of attack now that
 * `opts.templates` (the caller-supplied-table escape) is gone. `Object.freeze` on both the array
 * AND every entry closes that: a `push`/mutation throws in strict-mode ESM, and is a silent no-op
 * otherwise — either way the table cannot change after this module first evaluates.
 *
 * Adding or rotating a template is therefore a PACKAGE VERSION BUMP — edit this literal, land the
 * change, cut a release — NEVER a runtime `push` by a consumer. `sdk/test/verify.test.ts` pins
 * `Object.isFrozen` on both the array and its one entry so this cannot silently revert.
 */
export declare const SETTLE_TEMPLATES: readonly TemplateEntry[];
/** The entry a fresh compile is expected to match. Exactly `SETTLE_TEMPLATES.find(t => t.status
 *  === 'current' && t.id === 'ecoswap-settle')` — pulled out for the common case of "the one
 *  template that exists today". */
export declare const CURRENT_SETTLE_TEMPLATE: TemplateEntry;
//# sourceMappingURL=template.d.ts.map