/**
 * @eco-incorp/sauce-sdk/programs — reusable Sauce programs shipped as SOURCE.
 *
 * WHAT THIS IS FOR: a partner reproduces our bytecode with the ORDINARY compiler
 * (`@eco-incorp/sauce-sdk/compiler`), not a bespoke helper. This module exists only to answer the
 * two questions a partner genuinely cannot answer themselves — "what is the program text?" and
 * "where is this package installed?" — and then gets out of the way. Every compile option stays
 * explicit at the call site, so what you pass is what you can audit:
 *
 * ```ts
 * import { compile } from "@eco-incorp/sauce-sdk/compiler";
 * import { tokenSweepSource, SAUCE_BASE_DIRS } from "@eco-incorp/sauce-sdk/programs";
 *
 * const { bytecode } = compile(tokenSweepSource(), {
 *   baseDirs: SAUCE_BASE_DIRS,   // resolves the program's `./artifacts/IERC20.json` import
 *   target: "v12",               // the program is v12-only
 *   treeshake: true,
 *   tsSource: true,              // the source is TypeScript-annotated SauceScript
 *   args: [tokens.map(BigInt), minOut, BigInt(recipient)],
 * });
 * // bytecode[0] is byte-identical to the program we hand you.
 * ```
 *
 * Those five options are the whole contract — change any of them and the bytes change. They are
 * deliberately NOT exported as a pre-baked options object: a partner reproducing our output should
 * see the target and the arg order, not inherit them from a constant they never read.
 *
 * PREFER `tokenSweepSource()` OVER READING THE FILE YOURSELF, but both work — the raw asset is a
 * real file inside the package and is reachable by subpath if you want to hash, diff, or vendor it:
 *
 * ```ts
 * const path = fileURLToPath(import.meta.resolve("@eco-incorp/sauce-sdk/programs/token-sweep.sauce.ts"));
 * ```
 *
 * A bare `readFileSync("@eco-incorp/sauce-sdk/...")` does NOT work — `readFileSync` takes a
 * filesystem path and performs no package resolution. Use either form above.
 *
 * To go the other direction — compiled bytecode back to `(tokens, minOut, recipient)` — use
 * `@eco-incorp/sauce-sdk/verify`'s `decodeSettleProgram`, whose dependency closure is `viem` only.
 *
 * THE SVM TWIN — `svm-token-settle.sauce.ts` — is the SAME program, statement for statement, with
 * only VM mechanics differing (an account-data read instead of `balanceOf`, an SPL `Transfer` CPI
 * instead of an ERC20 call). `minOut` is a plain scalar argument there too, and applies to the FIRST
 * escrow only, exactly as the EVM floor applies to `tokens[0]`.
 *
 * The one shape the account model forces: EVM's token list is DATA, so a single static program loops
 * over it at runtime, while an SVM token account must be ATTACHED to the instruction and addressed
 * by a LITERAL index — so the escrow count is a COMPILE-TIME property and the source is generated
 * per count by `svmTokenSettleSource(n)`. It returns the exact text that gets compiled, so a partner
 * still byte-compares against source they can read. Refs come in `(tokenProgram_i, escrow_i,
 * beneficiary_i)` groups plus a shared `owner`: an SPL token account holds one mint, and a mint
 * belongs to one token program, so N mints need N destinations and may span classic SPL Token and
 * Token-2022. `svmTokenSettleRefs(n)` gives the AccountPlan order to resolve against.
 *
 * ```ts
 * import { compile } from "@eco-incorp/sauce-sdk/compiler";
 * import { svmTokenSettleSource } from "@eco-incorp/sauce-sdk/programs";
 *
 * const { bytecode, accountPlan, argsLayout } = compile(svmTokenSettleSource(2), {
 *   target: "svm",
 *   staged: true,
 *   treeshake: true,
 *   // staged mode never bakes args into the blob; only their SHAPE matters at compile time.
 *   args: [minOut, tokenProgram0, tokenProgram1],
 * });
 * // bytecode[0] is byte-identical for ANY minOut/tokenProgram values at a given escrow count.
 * ```
 *
 * There is no `decodeSvmSettleProgram` and there cannot be one: staged args are never baked into the
 * blob, so there is no prologue to parse back. `minOut` rides in the per-execution payload and the
 * account identities ride in the instruction's account list — neither is in the program.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the `token-sweep.sauce.ts` source inside THIS installed package. */
export const TOKEN_SWEEP_SOURCE_PATH: string = join(__dirname, "token-sweep.sauce.ts");

/**
 * `baseDirs` for compiling any program in this directory.
 *
 * One entry is sufficient and it is not this directory: it is the package's dist root, because what
 * needs resolving is the program's `import { IERC20 } from "./artifacts/IERC20.json"` — which lands
 * at `<dist>/artifacts/IERC20.json` (vendored from the pinned engine and shipped in this package's
 * `files` list). Measured: `[distRoot]` alone reproduces the identical bytes.
 */
export const SAUCE_BASE_DIRS: readonly string[] = [join(__dirname, "..")];

let cached: string | null = null;

/**
 * The `token-sweep.sauce.ts` program text — sweep the Pot's balance of every listed token to one
 * recipient, with a minimum-output floor on `tokens[0]`. Read once and cached.
 *
 * Returned as the raw source (not pre-stripped, not pre-compiled) so a partner can read, hash, or
 * diff exactly what gets compiled. Pass `tsSource: true` so the compiler's own front-end handles
 * the TypeScript annotations.
 */
export function tokenSweepSource(): string {
  if (cached === null) cached = readFileSync(TOKEN_SWEEP_SOURCE_PATH, "utf-8");
  return cached;
}

/** The generated program's doc header — kept in one place so every escrowCount emits it verbatim. */
const SVM_HEADER = `// svm-token-settle.sauce.ts — a STANDALONE, reusable SVM Sauce program: enforce a minimum-output
// floor on the FIRST escrow SPL token account's CURRENT balance, then sweep every listed escrow's
// whole balance to its beneficiary.
//
// This is the SVM twin of \`token-sweep.sauce.ts\`, statement for statement: read the floor token's
// balance, revert if it is below \`minOut\`, then sweep each token in turn, skipping empty ones. Only
// the VM mechanics differ — there is no Pot and no \`balanceOf\` call here: a balance lives IN the
// escrow account's own data, and moving it is an SPL Token \`Transfer\` CPI rather than an ERC20 call.
//
// GENERATED, NOT HAND-WRITTEN — by \`svmTokenSettleSource(escrowCount)\` in sdk/src/programs/index.ts.
// On EVM the token list is DATA, so one static program loops over it at runtime; on SVM a token
// account must be ATTACHED to the instruction and addressed by a LITERAL account index, so the
// escrow count is necessarily a compile-time property. The generator returns the EXACT text that
// gets compiled, so a partner still reads precisely what they byte-compare.
//
// It is deliberately NOT tied to any recipe, protocol, or product. Nothing below knows what produced
// the escrows' balances — a swap, a bridge, an airdrop, or nothing at all. Keep it that way: no
// caller-specific names, in the code OR in the revert string (which is identical to the EVM twin's).
//
// THE SHAPE: \`main(minOut, tokenProgram)\`. \`minOut\` is an ordinary scalar argument — the direct
// mirror of the EVM twin's \`minOut\` parameter — and applies to \`escrow0\` ONLY, exactly as the EVM
// floor applies to \`tokens[0]\`; every other escrow is swept unconditionally as a dust sweep. Every
// identity — which escrows, which beneficiaries, which owner authorizes, which token program to CPI
// into — binds at EXECUTION time via the AccountPlan's refs, so one compiled blob per escrowCount
// serves every mint and every escrow/beneficiary/token-program set.
//
// The refs are \`(escrow_i, beneficiary_i)\` PAIRS rather than one shared destination: EVM sends every
// token to a single \`recipient\` address, but an SPL token account holds exactly one mint, so N
// escrows of N mints need N destinations. That is the one shape difference the account model forces.
//
// ⚠ CONSTRUCTION GOTCHA, LOAD-BEARING: \`accountData("tokenProgram", 0, 0)\` is a zero-length read of
// the token program account. It looks like dead code — nothing reads its bytes — but the engine
// resolves a \`contract.call\` CPI target by scanning the instruction's ATTACHED accounts for the
// target's pubkey, so the token program must occupy an AccountPlan slot. Omit it and the compile
// still succeeds, but the Transfer CPI fails pre-flight the moment it runs.
//
// PER-ESCROW TOKEN PROGRAM, not one shared: a mint belongs to a specific token program, and N mints
// can span classic SPL Token AND Token-2022, so escrow_i is swept via its OWN \`tokenProgram_i\`. When
// every mint does share one program, pass the same value N times. (There is no way to read an
// account's pubkey as a value, so the target must be an argument.)
//
// ⚠ EACH \`tokenProgram_i\` IS TWO INDEPENDENT BINDINGS a caller makes at execution time — the scalar
// argument (the CPI target) and the account ref (so the engine can find it attached). Nothing here
// enforces they name the same program. A mismatch is a loud, atomic pre-flight CPI failure that moves
// nothing, but bind both from the same source value.
//
// KNOWN PROPERTY, DOCUMENTED AND ACCEPTED — NOT DEFENDED AGAINST: the floor and the sweeps read
// CURRENT balances, not a delta against a baseline, so a donated balance counts toward \`minOut\` and
// rides along. Same accepted property as the EVM twin — but materially EASIER to trigger here, since
// an associated token account is a public address anyone can permissionlessly transfer into. Do not
// add baseline/delta machinery; the chosen model is the escrows ending clean.
//
// u64-ONLY ARITHMETIC: \`le8\` is a 64-bit byteswap, sound because both the SPL \`amount\` field and the
// \`minOut\` argument are u64-shaped. A minOut above u64 range can never match an on-chain amount.
//
// PARTNER VERIFY: recompile \`svmTokenSettleSource(n)\` yourself with the options in
// sdk/src/programs/index.ts and byte-compare against what you were handed. There is no golden hash.
//
// THE DECODER: in staged mode compile-time args are NOT baked into the blob, so unlike the EVM twin
// there is no prologue to parse params back out of — \`minOut\` rides in the per-execution payload and
// the account identities ride in the instruction's account list, not in the program.`;

/** Absolute path to the `svm-token-settle.sauce.ts` source inside THIS installed package. That
 *  file is the CHECKED-IN N=1 instance of `svmTokenSettleSource()` — readable on its own, and
 *  pinned equal to the generator's output by `sdk/test/svm-settle.compile.test.ts` so the two can
 *  never drift. */
export const SVM_TOKEN_SETTLE_SOURCE_PATH: string = join(__dirname, "svm-token-settle.sauce.ts");

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
export function svmTokenSettleSource(escrowCount: number = 1): string {
  if (!Number.isInteger(escrowCount) || escrowCount < 1 || escrowCount > SVM_MAX_ESCROWS) {
    throw new Error(`svmTokenSettleSource: escrowCount must be an integer 1..${SVM_MAX_ESCROWS}, got ${escrowCount}`);
  }

  const params = ["minOut", ...Array.from({ length: escrowCount }, (_, i) => `tokenProgram${i}`)].join(", ");

  // Interning every token-program account up front (a zero-length read) so each Transfer CPI can
  // resolve its target from the instruction's attached accounts — see the header's gotcha note.
  const interns = Array.from({ length: escrowCount }, (_, i) => `  accountData("tokenProgram${i}", 0, 0);`).join("\n");

  const sweep = (i: number): string => `
  const bal${i} = accountUint("escrow${i}", ${SPL_AMOUNT_OFFSET}, 8);
  if (bal${i} > 0) {
    const pfx${i} = Uint8Array.from([3]);
    const amt${i} = abi.encode(le8(bal${i}));
    const data${i} = pfx${i}.concat(amt${i}.slice(24, 32));
    contract.call(tokenProgram${i}, data${i}, [
      { ref: "escrow${i}", writable: true },
      { ref: "beneficiary${i}", writable: true },
      { ref: "owner", signer: true }
    ]);
  }`;

  return `${SVM_HEADER}
/** 64-bit byte swap: the LE image of a u64 amount, MSTORE'd big-endian by abi.encode. */
function le8(x) {
  return ((x & 255) << 56) | ((x & 65280) << 40) | ((x & 16711680) << 24) | ((x & 4278190080) << 8)
    | ((x >> 8) & 4278190080) | ((x >> 24) & 16711680) | ((x >> 40) & 65280) | (x >> 56);
}

function main(${params}) {
${interns}

  const floorBal = accountUint("escrow0", ${SPL_AMOUNT_OFFSET}, 8);
  if (minOut > 0) {
    if (floorBal < minOut) {
      throw "sweep: balance below minOut";
    }
  }
${Array.from({ length: escrowCount }, (_, i) => sweep(i)).join("\n")}

  return floorBal;
}
`;
}

/** Upper bound on generated escrows — a Solana instruction can only attach so many accounts, and
 *  each escrow costs two (escrow + beneficiary) on top of `tokenProgram` and `owner`. */
export const SVM_MAX_ESCROWS = 16;

/** Offset of the SPL token account's u64 `amount` field. */
const SPL_AMOUNT_OFFSET = 64;

/**
 * The account refs a generated program interns, in AccountPlan order, for `escrowCount` escrows:
 * `tokenProgram` (readonly CPI target), then per escrow `escrow_i` (writable, read + drained) and
 * `beneficiary_i` (writable, receives it), then `owner` (readonly + signer, the escrows' authority).
 * A caller's `AccountResolution` must cover exactly these.
 */
export function svmTokenSettleRefs(escrowCount: number = 1): string[] {
  if (!Number.isInteger(escrowCount) || escrowCount < 1 || escrowCount > SVM_MAX_ESCROWS) {
    throw new Error(`svmTokenSettleRefs: escrowCount must be an integer 1..${SVM_MAX_ESCROWS}, got ${escrowCount}`);
  }

  // ORDER IS INTERN ORDER (first use), not a tidy grouping — the AccountPlan assigns each ref its
  // index the first time the program mentions it, so this must mirror the generated statement order
  // exactly or a caller's AccountResolution lands accounts in the wrong slots. In particular `owner`
  // appears after escrow0/beneficiary0 (its first use is escrow0's Transfer CPI), NOT last.
  // `svm-settle.compile.test.ts` pins this against a real compile for several escrow counts.
  const refs: string[] = [];
  for (let i = 0; i < escrowCount; i++) refs.push(`tokenProgram${i}`);
  for (let i = 0; i < escrowCount; i++) {
    refs.push(`escrow${i}`, `beneficiary${i}`);
    if (i === 0) refs.push("owner");
  }
  return refs;
}
