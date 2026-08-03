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
/** Absolute path to the `svm-token-settle.sauce.ts` source inside THIS installed package. */
export declare const SVM_TOKEN_SETTLE_SOURCE_PATH: string;
/**
 * The `svm-token-settle.sauce.ts` program text — enforce an absolute `minOut` floor on an escrow SPL
 * token account's live balance, then sweep the whole balance to a beneficiary. Read once and cached.
 *
 * Returned as the raw source (not pre-stripped, not pre-compiled) so a partner can read, hash, or
 * diff exactly what gets compiled. Unlike `tokenSweepSource()`, do NOT pass `tsSource` or `baseDirs`
 * — this source carries no TypeScript annotations and imports no JSON (see the compile snippet
 * above).
 */
export declare function svmTokenSettleSource(): string;
/** Byte length of the settle program's one cfg arg — `minOut`, u64 LITTLE-endian at [0, 8). */
export declare const SVM_SETTLE_CFG_BYTES: number;
/**
 * The four account refs `svm-token-settle.sauce.ts` interns, in the order the compiled AccountPlan
 * carries them. A caller's `AccountResolution` (see `@eco-incorp/sauce-sdk/svm`'s `resolveAccounts`)
 * must cover exactly these — `tokenProgram` (readonly, the SPL token program CPI target),
 * `escrow` (writable, the SPL token account the floor/sweep reads and drains), `beneficiary`
 * (writable, the SPL token account that receives the swept balance), `owner` (readonly + signer,
 * the escrow's authority, who must sign the Transfer CPI).
 */
export declare const SVM_TOKEN_SETTLE_REFS: {
    readonly tokenProgram: "tokenProgram";
    readonly escrow: "escrow";
    readonly beneficiary: "beneficiary";
    readonly owner: "owner";
};
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
export declare function encodeSvmSettleCfg(minOut: bigint): `0x${string}`;
/**
 * The inverse of `encodeSvmSettleCfg`: the 8-byte cfg arg (raw bytes or `0x`-hex) back to `minOut`.
 * Throws on any length other than `SVM_SETTLE_CFG_BYTES`, and on malformed hex input — a shifted
 * read is exactly the failure mode this refuses to allow, never a silent coercion.
 */
export declare function decodeSvmSettleCfg(cfg: Uint8Array | `0x${string}`): SvmSettleCfg;
//# sourceMappingURL=index.d.ts.map