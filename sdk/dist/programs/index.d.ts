/** Absolute path to the `token-sweep.sauce.ts` source inside THIS installed package. */
export declare const TOKEN_SWEEP_SOURCE_PATH: string;
/**
 * `baseDirs` for compiling any program in this directory.
 *
 * One entry is sufficient and it is not this directory: it is the package's dist root, because what
 * needs resolving is the program's `import { IERC20 } from "./artifacts/IERC20.json"` — which lands
 * at `<dist>/artifacts/IERC20.json` (vendored from the pinned engine and shipped in this package's
 * `files` list). Measured: `[distRoot]` alone reproduces the identical bytes.
 */
export declare const SAUCE_BASE_DIRS: readonly string[];
/**
 * The `token-sweep.sauce.ts` program text — sweep the Pot's balance of every listed token to one
 * recipient, with a minimum-output floor on `tokens[0]`. Read once and cached.
 *
 * Returned as the raw source (not pre-stripped, not pre-compiled) so a partner can read, hash, or
 * diff exactly what gets compiled. Pass `tsSource: true` so the compiler's own front-end handles
 * the TypeScript annotations.
 */
export declare function tokenSweepSource(): string;
/** Absolute path to the `svm-token-settle.sauce.ts` source inside THIS installed package. That
 *  file is the CHECKED-IN N=1 instance of `svmTokenSettleSource()` — readable on its own, and
 *  pinned equal to the generator's output by `sdk/test/svm-settle.compile.test.ts` so the two can
 *  never drift. */
export declare const SVM_TOKEN_SETTLE_SOURCE_PATH: string;
/**
 * The `svm-token-settle` program text for `escrowCount` escrows — the SVM twin of
 * `token-sweep.sauce.ts`, statement for statement, differing only where the VM forces it.
 *
 * WHY THIS IS GENERATED RATHER THAN A STATIC FILE, and why that does not weaken verification: on
 * EVM the token list is DATA (a heap array), so one static program loops over it at runtime. On SVM
 * a token account must be ATTACHED to the instruction and addressed by an account index the
 * compiler requires to be a LITERAL (`svmAccountRef`: "ref must be a string literal ref or an
 * integer index"), so the escrow count is necessarily a COMPILE-TIME property. Generating the
 * source is how every other multi-account SVM program in this SDK handles that (see the venue
 * adapters' own emitters) — and because this returns the EXACT text that gets compiled, a partner
 * still reads precisely what they are byte-comparing. Nothing is hidden behind the generator.
 *
 * The refs are `(escrow_i, beneficiary_i)` PAIRS, not one shared destination: EVM sends every token
 * to a single `recipient` address, but an SPL token account holds exactly one mint, so N escrows of
 * N different mints need N destination accounts. That is the one shape difference the account model
 * forces on the otherwise-identical logic.
 *
 * `minOut` applies to `escrow0` ONLY — the exact mirror of the EVM program's floor on `tokens[0]`.
 * Every other escrow is swept unconditionally (a dust sweep), same as EVM.
 */
export declare function svmTokenSettleSource(escrowCount?: number): string;
/** Upper bound on generated escrows — a Solana instruction can only attach so many accounts, and
 *  each escrow costs two (escrow + beneficiary) on top of `tokenProgram` and `owner`. */
export declare const SVM_MAX_ESCROWS = 16;
/**
 * The account refs a generated program interns, in AccountPlan order, for `escrowCount` escrows:
 * `tokenProgram` (readonly CPI target), then per escrow `escrow_i` (writable, read + drained) and
 * `beneficiary_i` (writable, receives it), then `owner` (readonly + signer, the escrows' authority).
 * A caller's `AccountResolution` must cover exactly these.
 */
export declare function svmTokenSettleRefs(escrowCount?: number): string[];
//# sourceMappingURL=index.d.ts.map