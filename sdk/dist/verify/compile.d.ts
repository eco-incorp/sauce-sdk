/**
 * COMPILE-FROM-SOURCE — the (B) partner capability: "did this program come from the program you
 * published?" Complements this package's `./verify` barrel (decode/authenticity/intent — "are the
 * values in this program the ones I agreed to?"): that surface reads whatever bytes a partner was
 * handed and can be run against a HOSTILE program with agreeable params; this one compiles the
 * REAL `token-sweep.sauce.ts` template from source with this package's own compiler pin and
 * lets a partner byte-compare the result — proving the program is OURS, which no amount of
 * decoding the bytes you were handed can prove on its own.
 *
 * Deliberately on its OWN subpath (`@eco-incorp/sauce-sdk/verify/compile`), never re-exported from
 * `./verify`'s `index.ts`: the barrel's entire point is a `{viem}`-only dependency closure (no
 * compiler, no filesystem — see `sdk/test/verify.test.ts`'s closure walk and this repo's
 * `test/fast/settle-verify.closure.test.ts`), and compiling needs both. Import this file directly
 * when you need (B); the barrel alone still gives you all of (A).
 */
import { type Hex } from "viem";
/** The real `token-sweep.sauce.ts` template text, read once and cached — the same file
 *  `compileSettleProgram` compiles, exposed so a caller can display/diff/hash the SOURCE itself
 *  (full transparency), not just the compiled output. */
export declare function settleSourceText(): string;
export interface CompiledSettleProgram {
    bytecodes: Hex[];
    source: string;
    /** keccak256 of the compiled bytecode's CONSTANT BODY — everything after the (tokens, minOut,
     *  recipient) prologue (see decode.ts). Compare against `CURRENT_SETTLE_TEMPLATE.bodyHash`. */
    bodyHash: Hex;
}
/**
 * Compile the settle program from source — `main(tokens, minOut, recipient)` (see
 * `programs/token-sweep.sauce.ts`'s docstring): sweeps the Pot's CURRENT balance of every listed token
 * to `recipient`, enforcing `minOut` against `tokens[0]`'s balance before any transfer runs.
 * v12-only (the settle-split composition is never lowered to v1 — v1 is not the product engine).
 *
 * This is the SAME compile `@eco-incorp/sauce-recipes`'s `compileEcoSwapSettle` runs — that
 * package delegates to this function rather than keeping a second copy, which is what makes byte
 * identity between the two packages structural (one compile path, one `baseDirs`, one ABI
 * resolution) rather than something to merely test for.
 */
export declare function compileSettleProgram(tokens: readonly (bigint | Hex)[], minOut: bigint, recipient: bigint | Hex): CompiledSettleProgram;
//# sourceMappingURL=compile.d.ts.map