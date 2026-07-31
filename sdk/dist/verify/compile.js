/**
 * COMPILE-FROM-SOURCE — the (B) partner capability: "did this program come from the program you
 * published?" Complements this package's `./verify` barrel (decode/authenticity/intent — "are the
 * values in this program the ones I agreed to?"): that surface reads whatever bytes a partner was
 * handed and can be run against a HOSTILE program with agreeable params; this one compiles the
 * REAL `ecoswap.settle.sauce.ts` template from source with this package's own compiler pin and
 * lets a partner byte-compare the result — proving the program is OURS, which no amount of
 * decoding the bytes you were handed can prove on its own.
 *
 * Deliberately on its OWN subpath (`@eco-incorp/sauce-sdk/verify/compile`), never re-exported from
 * `./verify`'s `index.ts`: the barrel's entire point is a `{viem}`-only dependency closure (no
 * compiler, no filesystem — see `sdk/test/verify.test.ts`'s closure walk and this repo's
 * `test/fast/settle-verify.closure.test.ts`), and compiling needs both. Import this file directly
 * when you need (B); the barrel alone still gives you all of (A).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { keccak256 } from "viem";
// Static RELATIVE specifier, not the `@eco-incorp/sauce-compiler` bare specifier the dead
// `sdk/dist/recipes/**` leftovers used (a specifier that never resolves in an installed clone —
// see this repo's deletion of that tree). `sdk/src/verify/` and `sdk/dist/verify/` sit at the
// SAME depth under the package root, so this one relative path resolves identically whether
// TypeScript is reading `../../../compiler/dist/index.js` from `src` or Node is loading the
// compiled `.js` from `dist` at runtime — no build-time rewriting needed.
import { compile as compileSauce } from "../../../compiler/dist/index.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
function toHex(bytes) {
    return ("0x" + Buffer.from(bytes).toString("hex"));
}
let cachedSourceText = null;
/** The real `ecoswap.settle.sauce.ts` template text, read once and cached — the same file
 *  `compileSettleProgram` compiles, exposed so a caller can display/diff/hash the SOURCE itself
 *  (full transparency), not just the compiled output. */
export function settleSourceText() {
    if (cachedSourceText === null) {
        cachedSourceText = readFileSync(join(__dirname, "ecoswap.settle.sauce.ts"), "utf-8");
    }
    return cachedSourceText;
}
// Memoize type-stripping exactly like `@eco-incorp/sauce-recipes`'s `ecoswap/index.ts` does: the
// solver source is a static file read from disk, so every compile hands this the SAME string.
const stripTypesCache = new Map();
function stripTypes(source) {
    const cached = stripTypesCache.get(source);
    if (cached !== undefined)
        return cached;
    const out = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    }).outputText;
    stripTypesCache.set(source, out);
    return out;
}
/**
 * Compile the settle program from source — `main(tokens, minOut, recipient)` (see
 * `ecoswap.settle.sauce.ts`'s docstring): sweeps the Pot's CURRENT balance of every listed token
 * to `recipient`, enforcing `minOut` against `tokens[0]`'s balance before any transfer runs.
 * v12-only (the settle-split composition is never lowered to v1 — v1 is not the product engine).
 *
 * This is the SAME compile `@eco-incorp/sauce-recipes`'s `compileEcoSwapSettle` runs — that
 * package delegates to this function rather than keeping a second copy, which is what makes byte
 * identity between the two packages structural (one compile path, one `baseDirs`, one ABI
 * resolution) rather than something to merely test for.
 */
export function compileSettleProgram(tokens, minOut, recipient) {
    if (tokens.length === 0) {
        throw new Error("compileSettleProgram: tokens must list at least one token (tokens[0] is the floor token)");
    }
    const recipientValue = typeof recipient === "bigint" ? recipient : BigInt(recipient);
    if (recipientValue === 0n) {
        throw new Error("compileSettleProgram: recipient is REQUIRED (nonzero) — every swept token lands there");
    }
    if (minOut < 0n) {
        throw new Error(`compileSettleProgram: minOut ${minOut} must be non-negative`);
    }
    const tokenValues = tokens.map((t) => (typeof t === "bigint" ? t : BigInt(t)));
    const source = settleSourceText();
    const jsSource = stripTypes(source);
    // baseDirs: this file's own directory (where ecoswap.settle.sauce.ts itself lives — not needed
    // for its OWN resolution, but kept for parity with the recipes package's [REPO_ROOT, __dirname]
    // shape) plus the package's `dist/artifacts/` parent, which is where the template's
    // `./artifacts/IERC20.json` import actually resolves (`sdk/dist/artifacts/IERC20.json`, already
    // vendored and shipped in this package's `files` whitelist).
    const sdkDist = join(__dirname, "..");
    const result = compileSauce(jsSource, {
        baseDirs: [__dirname, sdkDist],
        target: "v12",
        treeshake: true,
        args: [tokenValues, minOut, recipientValue],
    });
    const bytecodes = result.bytecode.map(toHex);
    const body = decodeBodyOnly(bytecodes[0]);
    return { bytecodes, source, bodyHash: keccak256(body) };
}
// Minimal local re-implementation of the (tokens, minOut, recipient) prologue skip — deliberately
// NOT importing `./decode.js`'s STRICT `decodeSettleProgram` here: that decoder rejects a
// non-minimal push / oversize word / zero recipient, any of which would make a real compile throw
// on inputs this function's own argument checks above already reject before reaching here, so the
// duplication is small and keeps this module's only cross-file dependency the compiler itself.
// Structurally identical to `@eco-incorp/sauce-recipes`'s `decodeSettleProgram`; see that
// function's docstring (`ecoswap/index.ts`) for the exact grammar.
const SETTLE_TUPLE_OP = 0x94;
function decodeMinimalPush(bytes, pos) {
    const op = bytes[pos];
    if (op === undefined || op < 0x01 || op > 0x20)
        return null;
    if (pos + 1 + op > bytes.length)
        return null;
    return { val: BigInt("0x" + bytes.subarray(pos + 1, pos + 1 + op).toString("hex")), next: pos + 1 + op };
}
function decodeBodyOnly(bytecode) {
    const bytes = Buffer.from(bytecode.slice(2), "hex");
    let pos = 0;
    for (;;) {
        const push = decodeMinimalPush(bytes, pos);
        if (!push)
            break;
        pos = push.next;
    }
    if (bytes[pos] !== SETTLE_TUPLE_OP) {
        throw new Error("compileSettleProgram: compiled output is not settle-shaped (no TUPLE opcode after token pushes)");
    }
    pos += 1; // TUPLE opcode
    pos += 1; // arity byte
    const minOutPush = decodeMinimalPush(bytes, pos);
    if (!minOutPush)
        throw new Error("compileSettleProgram: expected a minOut push after the token tuple");
    pos = minOutPush.next;
    const recipientPush = decodeMinimalPush(bytes, pos);
    if (!recipientPush)
        throw new Error("compileSettleProgram: expected a recipient push after minOut");
    pos = recipientPush.next;
    return ("0x" + bytes.subarray(pos).toString("hex"));
}
//# sourceMappingURL=compile.js.map