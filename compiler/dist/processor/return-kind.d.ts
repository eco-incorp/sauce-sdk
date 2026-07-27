import type { FunctionDeclaration } from 'acorn';
import type { CompilerContext, VariableKind } from '../context.js';
/**
 * Same-file, declaration-order-INDEPENDENT analysis of every declared function's RETURN
 * storage kind — the piece `inferKindWithContext` (inference.ts) is missing to correctly
 * infer `let arr = helper();` as `dynamic` when `helper()`'s own body returns a
 * `new Array(n)`-built TUPLE (or any other dynamic-kind expression). See this repo's
 * CLAUDE.md "Same-file user-function return-kind inference" note for the full story
 * (the bug this closes, and the two already-fixed sibling bugs in the same family).
 *
 * Deliberately a FIXPOINT pre-pass, not something recorded while compiling each function's
 * body: recording kinds AS you compile is declaration-ORDER dependent — a caller declared
 * BEFORE its callee in the source would still see the callee's pre-analysis (scalar)
 * default. Seeding every function to 'scalar' and only ever PROMOTING to 'dynamic', across
 * up to `declarations.length + 1` full passes, converges regardless of declaration order
 * (including mutual/chained helper→helper calls) and terminates by construction (a
 * height-1 lattice — only one promotion per name is possible at all).
 *
 * `ctx` is the bare MODULE-level `CompilerContext` this pre-pass runs against — the same one
 * `processProgram` later compiles every function body with, but BEFORE any body has actually
 * been compiled. That is enough to resolve a `Contract.at(addr).method()` inline-chain
 * contract call (`ctx.lookupContract` is already populated by `collectImportedFunctions`'s
 * `.json`-import handling, which runs strictly before this pass) for the destructuring-
 * declarator case below, but NOT a call through a variable-bound contract (`let pool =
 * Contract.at(addr); pool.method()`) — that binding is only ever recorded on a per-function
 * CHILD context while actually compiling a body, so `ctx.lookupBoundContract` can never have
 * anything registered yet here. See `applyDestructuringKinds`'s own doc comment for how that
 * (and any other unresolvable shape) is handled — conservatively, never by under-classifying.
 */
export declare function analyzeFunctionReturnKinds(declarations: FunctionDeclaration[], ctx: CompilerContext): Map<string, VariableKind>;
//# sourceMappingURL=return-kind.d.ts.map