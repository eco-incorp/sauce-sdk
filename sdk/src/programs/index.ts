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
 * THE SVM TWIN — `svm-token-settle.sauce.ts` — follows the identical pattern, adapted to SVM's
 * account model and compile surface. It enforces an absolute `minOut` floor on an escrow SPL token
 * account's live balance and sweeps the whole balance to a beneficiary; account identities (escrow,
 * beneficiary, owner, the SPL token program) bind at EXECUTION time via the compiled AccountPlan's
 * refs, not at compile time, so one canonical blob serves every mint/escrow/beneficiary/floor pair.
 * The whole option set is different from the EVM case (SVM target, staged mode, no baseDirs, no
 * tsSource — see the second snippet below) — spelled out literally for the same audit reason:
 *
 * ```ts
 * import { compile } from "@eco-incorp/sauce-sdk/compiler";
 * import { svmTokenSettleSource, SVM_SETTLE_CFG_BYTES, encodeSvmSettleCfg } from "@eco-incorp/sauce-sdk/programs";
 *
 * const { bytecode, accountPlan, argsLayout } = compile(svmTokenSettleSource(), {
 *   target: "svm",
 *   staged: true,
 *   treeshake: true,
 *   // placeholders — staged mode never bakes args into the blob; only their SHAPE matters here.
 *   args: [encodeSvmSettleCfg(0n), 0n],
 * });
 * // bytecode[0] is byte-identical to the program we hand you, for ANY minOut/tokenProgram —
 * // see svm-token-settle.sauce.ts's own doc for why (staged args never enter the compiled body).
 * ```
 *
 * There is no `decodeSvmSettleProgram` analogue and there cannot be one — see
 * `svm-token-settle.sauce.ts`'s own doc for why (staged compile-time args are never baked into the
 * blob, so there is no prologue to parse bytecode back out of). The only decodable settle parameter
 * — `minOut` — lives in the per-execution PAYLOAD, not the program: `encodeSvmSettleCfg`/
 * `decodeSvmSettleCfg` below are that half of the contract, and their dependency closure stays
 * node-builtins-only (pure bigint arithmetic — no viem, no `@solana/*`).
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

/** Absolute path to the `svm-token-settle.sauce.ts` source inside THIS installed package. */
export const SVM_TOKEN_SETTLE_SOURCE_PATH: string = join(__dirname, "svm-token-settle.sauce.ts");

let cachedSvm: string | null = null;

/**
 * The `svm-token-settle.sauce.ts` program text — enforce an absolute `minOut` floor on an escrow SPL
 * token account's live balance, then sweep the whole balance to a beneficiary. Read once and cached.
 *
 * Returned as the raw source (not pre-stripped, not pre-compiled) so a partner can read, hash, or
 * diff exactly what gets compiled. Unlike `tokenSweepSource()`, do NOT pass `tsSource` or `baseDirs`
 * — this source carries no TypeScript annotations and imports no JSON (see the compile snippet
 * above).
 */
export function svmTokenSettleSource(): string {
  if (cachedSvm === null) cachedSvm = readFileSync(SVM_TOKEN_SETTLE_SOURCE_PATH, "utf-8");
  return cachedSvm;
}

/** Byte length of the settle program's one cfg arg — `minOut`, u64 LITTLE-endian at [0, 8). */
export const SVM_SETTLE_CFG_BYTES: number = 8;

/**
 * The four account refs `svm-token-settle.sauce.ts` interns, in the order the compiled AccountPlan
 * carries them. A caller's `AccountResolution` (see `@eco-incorp/sauce-sdk/svm`'s `resolveAccounts`)
 * must cover exactly these — `tokenProgram` (readonly, the SPL token program CPI target),
 * `escrow` (writable, the SPL token account the floor/sweep reads and drains), `beneficiary`
 * (writable, the SPL token account that receives the swept balance), `owner` (readonly + signer,
 * the escrow's authority, who must sign the Transfer CPI).
 */
export const SVM_TOKEN_SETTLE_REFS = {
  tokenProgram: "tokenProgram",
  escrow: "escrow",
  beneficiary: "beneficiary",
  owner: "owner",
} as const;

/** Decoded settle params — the only ones that exist, since staged args are never baked into the blob. */
export interface SvmSettleCfg {
  minOut: bigint;
}

/**
 * Encodes `minOut` as the settle program's 8-byte cfg arg (u64 LITTLE-endian, byte i = `(minOut >>
 * 8i) & 0xff`) — LE because `uint()` lowers to CAST_LE on SVM (the compiler's own `uint` global is
 * target-aware: BE on EVM, LE on SVM), so the cfg word must match that on-chain read's byte order.
 * Throws on an out-of-u64-range `minOut` (negative or `>= 2**64`) rather than silently truncating —
 * `accountUint("escrow", 64, 8)`'s on-chain read is itself u64-bounded, so an out-of-range value
 * here could never be represented consistently on both sides anyway.
 *
 * `minOut: 0n` is a valid encode and means "no floor" — the unsigned on-chain comparison makes a
 * zero floor unreachable, so zero-as-disabled falls out of the arithmetic rather than being enforced
 * here.
 */
export function encodeSvmSettleCfg(minOut: bigint): `0x${string}` {
  if (minOut < 0n || minOut >= 1n << 64n) {
    throw new Error(`encodeSvmSettleCfg: minOut ${minOut} is out of u64 range`);
  }

  const bytes = new Uint8Array(SVM_SETTLE_CFG_BYTES);
  for (let i = 0; i < SVM_SETTLE_CFG_BYTES; i++) {
    bytes[i] = Number((minOut >> BigInt(8 * i)) & 0xffn);
  }

  return ("0x" + Buffer.from(bytes).toString("hex")) as `0x${string}`;
}

/**
 * The inverse of `encodeSvmSettleCfg`: the 8-byte cfg arg (raw bytes or `0x`-hex) back to `minOut`.
 * Throws on any length other than `SVM_SETTLE_CFG_BYTES`, and on malformed hex input — a shifted
 * read is exactly the failure mode this refuses to allow, never a silent coercion.
 */
export function decodeSvmSettleCfg(cfg: Uint8Array | `0x${string}`): SvmSettleCfg {
  const bytes = typeof cfg === "string" ? hexToBytesSvmSettle(cfg) : cfg;

  if (bytes.length !== SVM_SETTLE_CFG_BYTES) {
    throw new Error(`decodeSvmSettleCfg: expected ${SVM_SETTLE_CFG_BYTES} bytes, got ${bytes.length}`);
  }

  let minOut = 0n;
  for (let i = SVM_SETTLE_CFG_BYTES - 1; i >= 0; i--) {
    minOut = (minOut << 8n) | BigInt(bytes[i]!);
  }

  return { minOut };
}

function hexToBytesSvmSettle(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;

  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) {
    throw new Error(`decodeSvmSettleCfg: invalid hex bytes value: ${hex}`);
  }

  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}
