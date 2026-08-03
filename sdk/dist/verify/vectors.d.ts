import type { Hex } from "viem";
export interface ConformanceVector {
    name: string;
    tokens: Hex[];
    minOut: bigint;
    recipient: Hex;
    /** The exact compiled program these args produce — measured by actually compiling
     *  `recipes/settle.sauce.ts` at this package's compiler pin, not hand-assembled.
     *  `sdk/test/verify.compile.test.ts` recompiles and re-checks these, so a compiler re-pin or a
     *  program edit that changes the emission turns red here rather than drifting silently. */
    program: Hex;
}
/**
 * Golden wire-format vectors — the Go/Solidity/Python conformance corpus. Each `program` was
 * obtained by actually compiling `recipes/settle.sauce.ts` with the given args (not hand-encoded),
 * so it doubles as a regression pin on the compiler's emission shape. See decode.ts's module
 * docstring for the grammar these bytes instantiate.
 *
 * `v3` is the trap vector: `Z = 0x0000000000000000000000000000000000ff00aa` has two leading zero
 * bytes, so its minimal-length PUSH is only 3 bytes wide (`03 ff00aa`), not the naive 20 — a fixed
 * 20-byte read at that offset silently misframes everything after it. `v3` also (together with
 * `v1`) pins the reversal: the FIRST push on the wire is the LAST logical token.
 */
export declare const SETTLE_VECTORS: readonly ConformanceVector[];
//# sourceMappingURL=vectors.d.ts.map