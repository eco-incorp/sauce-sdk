import * as ts from 'typescript';
import { evaluate } from 'ts-evaluator';
// ── TypeScript front-end: fold + strip a `.ts`/`.sauce.ts` module BEFORE acorn ──
//
// Runs strictly earlier than the existing acorn pipeline: it turns TS source text into
// plain JS source text, folding provably-constant branches/expressions/loops along the
// way. Everything downstream (const-eval.ts, tree-shaking, statement.ts fold sites) is
// unchanged — it only ever sees narrower/simpler text than before, never different
// codegen for the same emitted shape.
//
// TWO evaluators, layered:
//  1. `tsEvalConst` — a hand-rolled bigint evaluator (Literal/Identifier/Unary/Binary),
//     mirroring processor/const-eval.ts's logic but retargeted to ts.Node. It exists
//     because `ts-evaluator` cannot reliably evaluate bigint arithmetic AT ALL (see the
//     crash note on `tryEvaluate` below) — and SauceScript is bigint-only, so this is the
//     PRIMARY evaluator for everything that matters here (conditions, arithmetic, and the
//     loop-unroller's bound resolution). Identifiers resolve against `consts`, every
//     same-file top-level `const NAME = <literal>` (collected once per module, in
//     declaration order, so a later const may reference an earlier one).
//  2. `tryEvaluate` (ts-evaluator) — a fallback for shapes the hand-rolled evaluator
//     doesn't cover (bare boolean/string identifiers, ternaries-as-values, templates). No
//     `ts.Program`/TypeChecker is built, so it resolves identifiers only within the same
//     source file (its own documented no-checker behavior) and cannot see into arrays/
//     object property access or function calls without one — folding across a TS import
//     boundary, or over array/object data, is out of scope here (the existing source-file
//     FUNCTION import mechanism is separate and already cross-file).
//
// A failed/unresolvable evaluation always leaves the node untouched — folding can only
// ever remove/replace something PROVABLY constant, so a runtime-derived condition or loop
// compiles exactly as if this pass didn't run.
const POLICY = {
    io: false,
    network: false,
    process: false,
    console: false,
    deterministic: true,
    maxOps: 100_000,
    maxOpDuration: 2_000,
};
/** A countable `for` loop unrolls into at most this many copies of its body. */
const MAX_UNROLL_ITERATIONS = 256;
/** Shared empty shadow set — module (top-level) scope has nothing shadowing it, and a
 * same-file top-level function's own body/defaults are evaluated fresh against this (see
 * `tsEvalCall`): its free variables can only be OTHER top-level bindings, never whatever
 * happens to be shadowed at whatever call site is being folded. */
const EMPTY_SHADOW = new Set();
function tryEvaluate(node) {
    try {
        const result = evaluate({ node, typescript: ts, environment: { preset: 'NONE' }, policy: POLICY });
        return result.success ? { success: true, value: result.value } : { success: false };
    }
    catch {
        // ts-evaluator@2.0.0 throws (rather than returning a failure result) for some node
        // shapes it can't evaluate — e.g. a bare BigIntLiteral (`BigInt(node.text)` on text
        // like "3n" is itself a SyntaxError). Folding must never crash a compile: treat a
        // thrown error the same as an unsuccessful evaluation and leave the node untouched.
        return { success: false };
    }
}
function tsEvalConst(node, consts, functions, shadowed) {
    if (ts.isParenthesizedExpression(node))
        return tsEvalConst(node.expression, consts, functions, shadowed);
    if (ts.isBigIntLiteral(node))
        return BigInt(node.text.slice(0, -1)); // strip the "n" ts-evaluator's own BigInt() call rejects
    if (ts.isNumericLiteral(node)) {
        const n = Number(node.text);
        return Number.isInteger(n) ? BigInt(n) : undefined;
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword)
        return 1n;
    if (node.kind === ts.SyntaxKind.FalseKeyword)
        return 0n;
    // A name reserved by ANY enclosing scope between this node and the top level (a parameter,
    // a nested function/let/const/var/catch-binding of the same name, …) can never be resolved
    // against the top-level `consts` map — the identifier refers to THAT binding at runtime,
    // never necessarily the same-named top-level const, so this must fail closed (undefined)
    // rather than guess. See `foldTransformer`'s scope-introducing branches, which grow
    // `shadowed` on the way down (mirroring `constPropagationTransformer`'s own shadow tracking).
    if (ts.isIdentifier(node))
        return shadowed.has(node.text) ? undefined : consts.get(node.text);
    if (ts.isPrefixUnaryExpression(node))
        return tsEvalUnary(node, consts, functions, shadowed);
    if (ts.isBinaryExpression(node))
        return tsEvalBinary(node, consts, functions, shadowed);
    if (ts.isCallExpression(node))
        return tsEvalCall(node, consts, functions, shadowed);
    return undefined;
}
function tsEvalUnary(node, consts, functions, shadowed) {
    const v = tsEvalConst(node.operand, consts, functions, shadowed);
    if (v === undefined)
        return undefined;
    switch (node.operator) {
        case ts.SyntaxKind.MinusToken:
            return -v;
        case ts.SyntaxKind.PlusToken:
            return v;
        case ts.SyntaxKind.TildeToken:
            return ~v;
        case ts.SyntaxKind.ExclamationToken:
            return v === 0n ? 1n : 0n;
        default:
            return undefined;
    }
}
function tsEvalBinary(node, consts, functions, shadowed) {
    const op = node.operatorToken.kind;
    // Short-circuit && / ||, matching const-eval.ts: a known-falsy left collapses `&&`, a
    // known-truthy left collapses `||`, even when the right side isn't itself constant.
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        const left = tsEvalConst(node.left, consts, functions, shadowed);
        const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
        if (left !== undefined && (isAnd ? left === 0n : left !== 0n))
            return isAnd ? 0n : 1n;
        const right = tsEvalConst(node.right, consts, functions, shadowed);
        if (left === undefined || right === undefined)
            return undefined;
        return (isAnd ? left !== 0n && right !== 0n : left !== 0n || right !== 0n) ? 1n : 0n;
    }
    const a = tsEvalConst(node.left, consts, functions, shadowed);
    const b = tsEvalConst(node.right, consts, functions, shadowed);
    if (a === undefined || b === undefined)
        return undefined;
    switch (op) {
        case ts.SyntaxKind.PlusToken:
            return a + b;
        case ts.SyntaxKind.MinusToken:
            return a - b;
        case ts.SyntaxKind.AsteriskToken:
            return a * b;
        case ts.SyntaxKind.SlashToken:
            return b === 0n ? undefined : a / b;
        case ts.SyntaxKind.PercentToken:
            return b === 0n ? undefined : a % b;
        case ts.SyntaxKind.AsteriskAsteriskToken:
            return b < 0n ? undefined : a ** b;
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
        case ts.SyntaxKind.EqualsEqualsToken:
            return a === b ? 1n : 0n;
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        case ts.SyntaxKind.ExclamationEqualsToken:
            return a !== b ? 1n : 0n;
        case ts.SyntaxKind.LessThanToken:
            return a < b ? 1n : 0n;
        case ts.SyntaxKind.LessThanEqualsToken:
            return a <= b ? 1n : 0n;
        case ts.SyntaxKind.GreaterThanToken:
            return a > b ? 1n : 0n;
        case ts.SyntaxKind.GreaterThanEqualsToken:
            return a >= b ? 1n : 0n;
        case ts.SyntaxKind.AmpersandToken:
            return a & b;
        case ts.SyntaxKind.BarToken:
            return a | b;
        case ts.SyntaxKind.CaretToken:
            return a ^ b;
        case ts.SyntaxKind.LessThanLessThanToken:
            return a << b;
        case ts.SyntaxKind.GreaterThanGreaterThanToken:
            return a >> b;
        default:
            return undefined;
    }
}
// `collectTopLevelConsts` (real `const` only) has grown into `analyzeTopLevelConsts`, defined
// further down (after the shadow-tracking helpers it now shares with `substituteConstReads`) —
// see the "effectively-const `let`/`var` detection" section below for the full story.
/**
 * True if a CallExpression or NewExpression occurs anywhere in `node`, including `node`
 * itself. A same-file top-level function is only ever a call-folding candidate when its body
 * contains ZERO of these anywhere (see `foldableReturnExpr`) — a body that never calls
 * anything trivially can't recurse (so no separate recursion analysis is needed) and can't
 * reach a side effect through a nested call either, which is the entire soundness argument
 * for folding the call away.
 */
function containsCallOrNew(node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node))
        return true;
    let found = false;
    ts.forEachChild(node, (child) => {
        if (!found && containsCallOrNew(child))
            found = true;
    });
    return found;
}
/**
 * The narrow shape a same-file top-level function must have before a CALL to it can ever
 * fold (see `tsEvalCall`): it is neither a generator nor `async` (calling either never
 * yields its `return`ed value directly — a generator returns an Iterator, `async` returns a
 * Promise — so folding straight to the resolved literal would be a genuine semantic
 * divergence from what the source actually does when run), its ENTIRE body is exactly one
 * `return <expr>;` statement (no other statements, no bare `return;`), every parameter is a
 * plain identifier (no destructuring, no rest), and neither the return expression nor any
 * parameter's default initializer contains a CallExpression/NewExpression anywhere. Returns
 * the return expression when eligible, `undefined` otherwise — fails closed, same convention
 * as every other check in this evaluator, so an ineligible function simply leaves every call
 * to it untouched rather than throwing or guessing.
 */
function foldableReturnExpr(fn) {
    if (fn.asteriskToken)
        return undefined; // generator — calling it returns an Iterator, never its `return`ed value
    if (ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword))
        return undefined; // async — returns a Promise
    if (!fn.body || fn.body.statements.length !== 1)
        return undefined;
    const [stmt] = fn.body.statements;
    if (!ts.isReturnStatement(stmt) || !stmt.expression)
        return undefined;
    if (containsCallOrNew(stmt.expression))
        return undefined;
    for (const param of fn.parameters) {
        if (!ts.isIdentifier(param.name) || param.dotDotDotToken)
            return undefined; // no destructuring/rest params
        if (param.initializer && containsCallOrNew(param.initializer))
            return undefined;
    }
    return stmt.expression;
}
/**
 * Folds a CALL to a same-file, side-effect-free, single-`return`-expression top-level
 * function (`foldableReturnExpr`) when every argument itself resolves to a compile-time
 * constant. Parameters are bound as a temporary overlay ON TOP OF `consts` (a fresh `Map`
 * copy — the caller's own `consts` is never mutated) and the return expression is evaluated
 * through the SAME `tsEvalConst` machinery, so a body that reads a module-level `const`
 * alongside its own parameter(s) resolves correctly (the overlay simply shadows a same-named
 * outer const, exactly like a real parameter would at runtime). The callee's own body/
 * defaults are evaluated against a FRESH (empty) shadow set, never the caller's `shadowed` —
 * a top-level function's free variables can only be other same-file top-level bindings,
 * never whatever happens to be shadowed at whatever call site is being folded.
 *
 * The callee identifier itself must resolve to the top-level function map entry UNSHADOWED:
 * if anything between the call site and the top level (a parameter, a nested function/let/
 * const of the same name, …) rebinds the same name, the call site's callee refers to THAT
 * binding at runtime — never necessarily the top-level function of the same name — so this
 * declines to fold rather than guess which one was meant (see `foldTransformer`'s
 * scope-introducing branches, which grow `shadowed` on the way down).
 *
 * A call that omits an argument for a parameter with a default initializer evaluates that
 * default instead — deliberately handled (not rejected): defaults are evaluated left to
 * right, so a later default may reference an earlier already-bound parameter, matching real
 * JS call semantics, and `foldableReturnExpr` already guarantees a default itself contains no
 * nested call. Every one of the callee's OWN parameter names is excluded from the overlay's
 * initial seed (before any are individually bound below) — real JS/TS parameter-list scoping
 * puts every parameter name (including ones bound LATER in the same list) in its own TDZ for
 * the whole parameter list, so an earlier default referencing a later (or its own,
 * not-yet-bound) parameter name throws at runtime rather than silently reading an outer
 * const of the same name; excluding those names up front reproduces that (the reference
 * simply fails to resolve, declining the fold, instead of reading the wrong value). Any other
 * mismatch — an unknown callee, a callee that isn't a plain identifier (e.g. `obj.method()`),
 * a callee whose body isn't the exact eligible shape, too many arguments, or any argument (or
 * used default) that doesn't itself resolve to a constant — returns `undefined`, leaving the
 * call site completely untouched.
 */
function tsEvalCall(node, consts, functions, shadowed) {
    if (!ts.isIdentifier(node.expression))
        return undefined; // same-file plain calls only — no `obj.method()`
    const calleeName = node.expression.text;
    if (shadowed.has(calleeName))
        return undefined; // the name is rebound between here and the top level
    const fn = functions.get(calleeName);
    if (!fn)
        return undefined;
    const returnExpr = foldableReturnExpr(fn);
    if (!returnExpr)
        return undefined;
    if (node.arguments.length > fn.parameters.length)
        return undefined; // too many args — never valid
    const ownParamNames = new Set();
    for (const param of fn.parameters) {
        if (ts.isIdentifier(param.name))
            ownParamNames.add(param.name.text);
    }
    // Seed the overlay from the outer `consts`, but WITHOUT any name that's also one of the
    // callee's own parameters — that name is reserved for the whole parameter list (TDZ),
    // never the outer const of the same name, even before it's individually bound below.
    const overlay = new Map([...consts].filter(([name]) => !ownParamNames.has(name)));
    for (let i = 0; i < fn.parameters.length; i++) {
        const param = fn.parameters[i];
        const arg = node.arguments[i];
        // `arg` evaluates in the CALLER's scope (their own shadowing applies); an omitted arg's
        // default evaluates in the CALLEE's own (fresh) scope, against the overlay built so far,
        // so it can see earlier parameters already bound this call — but never an unbound later/
        // own one, which correctly fails to resolve instead of reading the outer const.
        let value;
        if (arg)
            value = tsEvalConst(arg, consts, functions, shadowed);
        else if (param.initializer)
            value = tsEvalConst(param.initializer, overlay, functions, EMPTY_SHADOW);
        if (value === undefined)
            return undefined;
        overlay.set(param.name.text, value); // guaranteed Identifier by foldableReturnExpr
    }
    return tsEvalConst(returnExpr, overlay, functions, EMPTY_SHADOW);
}
/** Every same-file top-level NAMED `function` declaration, keyed by name — hoisting-order
 * independent (unlike `consts`, which must be resolved in declaration order): a call or a
 * `const` initializer may reference a function declared anywhere else in the file, matching
 * real JS function-hoisting semantics. */
function collectTopLevelFunctions(sourceFile) {
    const functions = new Map();
    for (const stmt of sourceFile.statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name)
            functions.set(stmt.name.text, stmt);
    }
    return functions;
}
/**
 * Every JS/TS assignment-operator token — `=`, `+=`, `&&=`, etc. A BinaryExpression using
 * one of these has a SIDE EFFECT (it mutates its left operand); folding it down to "just its
 * resulting value" would silently discard that mutation. `tsEvalConst`'s own switch already
 * has no case for any of these (so it never resolves one), but `ts-evaluator`'s `evaluate()`
 * — the fallback — DOES "successfully" evaluate a bare assignment expression as if it were a
 * pure value (confirmed: `evaluate()` on `a = 1` returns `1`), so `foldExpression` must refuse
 * to consult EITHER evaluator on one of these, rather than relying on tsEvalConst's silence.
 */
const ASSIGNMENT_OPERATOR_TOKENS = new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken,
    ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.LessThanLessThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.AmpersandEqualsToken,
    ts.SyntaxKind.BarEqualsToken,
    ts.SyntaxKind.CaretEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
]);
/** Combines both evaluators: the reliable bigint path first, ts-evaluator as a fallback. */
function foldExpression(node, consts, functions, shadowed) {
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATOR_TOKENS.has(node.operatorToken.kind)) {
        return { success: false };
    }
    const hand = tsEvalConst(node, consts, functions, shadowed);
    if (hand !== undefined)
        return { success: true, value: hand };
    // A CallExpression is deliberately NEVER handed to the ts-evaluator fallback: folding a
    // call is governed entirely by `tsEvalCall`'s own hard-boundary eligibility rules above
    // (same-file, single-return, zero nested calls, constant args), and ts-evaluator's
    // no-checker `evaluate()` cannot resolve a function call at all today anyway (confirmed —
    // it fails closed on every call shape, not just the ones this evaluator declines) — but
    // relying on that behavior implicitly would silently change if a future ts-evaluator
    // version learned to interpret same-file calls itself, bypassing our eligibility checks
    // entirely. This mirrors the `ASSIGNMENT_OPERATOR_TOKENS` guard just above: fail closed by
    // construction, not by coincidence.
    if (ts.isCallExpression(node))
        return { success: false };
    return tryEvaluate(node);
}
/** A JS primitive foldable into a literal AST node (object/array/function/symbol/null/undefined are not). */
function toLiteralNode(value) {
    if (typeof value === 'boolean')
        return value ? ts.factory.createTrue() : ts.factory.createFalse();
    if (typeof value === 'string')
        return ts.factory.createStringLiteral(value);
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value < 0
            ? ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, ts.factory.createNumericLiteral(-value))
            : ts.factory.createNumericLiteral(value);
    }
    if (typeof value === 'bigint') {
        return value < 0n
            ? ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, ts.factory.createBigIntLiteral(`${-value}n`))
            : ts.factory.createBigIntLiteral(`${value}n`);
    }
    return undefined;
}
/**
 * Node kinds safe to fold to a literal wherever they're found: none of these can ever be an
 * assignment target (an lvalue), so replacing one in place is always semantically safe —
 * unlike a bare Identifier, which might be the left side of an assignment or a declaration
 * name. A CallExpression is included here too — it's likewise never an lvalue — but actually
 * folds only for the narrow same-file/single-return/constant-args shape `tsEvalCall` accepts;
 * any other call (an unresolvable callee, `console.log(...)`, a multi-statement function,
 * etc.) simply fails `foldExpression` and is left exactly as found, same as always.
 */
function isFoldableValueExpression(node) {
    return (ts.isBinaryExpression(node) ||
        ts.isPrefixUnaryExpression(node) ||
        ts.isTemplateExpression(node) ||
        ts.isCallExpression(node));
}
// ── Loop unrolling: a "countable" `for` with a constant start/bound/step becomes N copies
// of its body, the counter substituted by its literal value each time. ──
/** `i++`/`i--`/`i += step`/`i -= step` on the counter → the signed per-iteration step. */
function extractStep(incrementor, loopVar, consts, functions, shadowed) {
    if (!incrementor)
        return undefined;
    if (ts.isPostfixUnaryExpression(incrementor) || ts.isPrefixUnaryExpression(incrementor)) {
        if (!ts.isIdentifier(incrementor.operand) || incrementor.operand.text !== loopVar)
            return undefined;
        if (incrementor.operator === ts.SyntaxKind.PlusPlusToken)
            return 1n;
        if (incrementor.operator === ts.SyntaxKind.MinusMinusToken)
            return -1n;
        return undefined;
    }
    if (ts.isBinaryExpression(incrementor) && ts.isIdentifier(incrementor.left) && incrementor.left.text === loopVar) {
        const op = incrementor.operatorToken.kind;
        if (op === ts.SyntaxKind.PlusEqualsToken || op === ts.SyntaxKind.MinusEqualsToken) {
            const rhs = tsEvalConst(incrementor.right, consts, functions, shadowed);
            if (rhs === undefined)
                return undefined;
            return op === ts.SyntaxKind.PlusEqualsToken ? rhs : -rhs;
        }
        // `i = i + step` / `i = i - step` (a plain reassignment, not `+=`/`-=`) — the RHS
        // itself must be `loopVar +/- <const>`; `i = <anything else>` isn't a countable step.
        if (op === ts.SyntaxKind.EqualsToken && ts.isBinaryExpression(incrementor.right)) {
            const rhsOp = incrementor.right.operatorToken.kind;
            if ((rhsOp === ts.SyntaxKind.PlusToken || rhsOp === ts.SyntaxKind.MinusToken) &&
                ts.isIdentifier(incrementor.right.left) &&
                incrementor.right.left.text === loopVar) {
                const step = tsEvalConst(incrementor.right.right, consts, functions, shadowed);
                if (step === undefined)
                    return undefined;
                return rhsOp === ts.SyntaxKind.PlusToken ? step : -step;
            }
        }
        return undefined;
    }
    return undefined;
}
/**
 * Conservative safety guard: bail out of unrolling if the body redeclares the counter name
 * (a nested `let`/`const`/param/catch-binding shadowing it — over-approximated, we don't
 * track scopes precisely, we just decline to unroll rather than risk a wrong substitution)
 * or contains a `break`/`continue`/`return` (control flow unrolling can't simply preserve).
 * Over-conservative by construction: it may decline to unroll a few loops that are
 * technically fine, but never unrolls one that isn't.
 */
function bodyBlocksUnrolling(node, loopVar) {
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node) || ts.isReturnStatement(node))
        return true;
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
        ts.isIdentifier(node.name) &&
        node.name.text === loopVar) {
        return true;
    }
    let blocked = false;
    ts.forEachChild(node, (child) => {
        if (!blocked && bodyBlocksUnrolling(child, loopVar))
            blocked = true;
    });
    return blocked;
}
/** Replace every reference to `loopVar` in `node` with the literal `value`. */
function substituteCounter(node, loopVar, value, context) {
    const sub = (n) => ts.isIdentifier(n) && n.text === loopVar ? value : ts.visitEachChild(n, sub, context);
    return sub(node);
}
/** `decl.initializer` syntactically a BigIntLiteral (through a leading unary minus)? */
function looksBigInt(node) {
    return ts.isPrefixUnaryExpression(node) ? looksBigInt(node.operand) : ts.isBigIntLiteral(node);
}
function referencesIdentifier(node, name) {
    if (ts.isIdentifier(node) && node.text === name)
        return true;
    let found = false;
    ts.forEachChild(node, (child) => {
        if (!found && referencesIdentifier(child, name))
            found = true;
    });
    return found;
}
/**
 * The shared unroll core: given a resolved counter/bound/step/comparison and a body, expands
 * to N copies of the body with the counter substituted by its per-iteration literal — used by
 * both `for` (bounds come from its own init/condition/incrementor) and the `while` counting
 * idiom (bounds come from a preceding decl + the condition + the body's own last statement).
 */
function unrollCountingLoop(loopVar, start, cmp, bound, step, body, useBigInt, consts, functions, shadowed, context, visit) {
    const isLess = cmp === ts.SyntaxKind.LessThanToken || cmp === ts.SyntaxKind.LessThanEqualsToken;
    const isGreater = cmp === ts.SyntaxKind.GreaterThanToken || cmp === ts.SyntaxKind.GreaterThanEqualsToken;
    if (!isLess && !isGreater)
        return undefined;
    // Direction sanity: a forward (`i < / <= bound`) loop needs a positive step, a backward
    // one a negative step — the other pairing either never runs (fine, unrolls to nothing,
    // handled below) or genuinely never terminates. Bail on the latter rather than hang.
    if ((isLess && step < 0n) || (isGreater && step > 0n))
        return undefined;
    if (bodyBlocksUnrolling(body, loopVar))
        return undefined;
    const continues = (v) => {
        switch (cmp) {
            case ts.SyntaxKind.LessThanToken:
                return v < bound;
            case ts.SyntaxKind.LessThanEqualsToken:
                return v <= bound;
            case ts.SyntaxKind.GreaterThanToken:
                return v > bound;
            default:
                return v >= bound;
        }
    };
    const values = [];
    for (let v = start; continues(v); v += step) {
        if (values.length >= MAX_UNROLL_ITERATIONS)
            return undefined; // too large — leave it as real runtime code
        values.push(v);
    }
    const bodyStatements = ts.isBlock(body) ? body.statements : [body];
    return values.flatMap((v) => {
        const literal = toLiteralNode(useBigInt ? v : Number(v));
        const substituted = bodyStatements.map((s) => substituteCounter(s, loopVar, literal, context));
        return foldStatementList(substituted, consts, functions, shadowed, context, visit);
    });
}
function tryUnrollForLoop(node, consts, functions, shadowed, context, visit) {
    const init = node.initializer;
    if (!init || !ts.isVariableDeclarationList(init) || init.declarations.length !== 1)
        return undefined;
    const decl = init.declarations[0];
    if (!ts.isIdentifier(decl.name) || !decl.initializer)
        return undefined;
    const loopVar = decl.name.text;
    const start = tsEvalConst(decl.initializer, consts, functions, shadowed);
    if (start === undefined)
        return undefined;
    const cond = node.condition;
    if (!cond || !ts.isBinaryExpression(cond) || !ts.isIdentifier(cond.left) || cond.left.text !== loopVar) {
        return undefined;
    }
    const bound = tsEvalConst(cond.right, consts, functions, shadowed);
    if (bound === undefined)
        return undefined;
    const step = extractStep(node.incrementor, loopVar, consts, functions, shadowed);
    if (step === undefined || step === 0n)
        return undefined;
    return unrollCountingLoop(loopVar, start, cond.operatorToken.kind, bound, step, node.statement, looksBigInt(decl.initializer), consts, functions, shadowed, context, visit);
}
/**
 * A `while` loop has no init/incrementor clauses of its own, so the countable idiom must be
 * spelled as a separate preceding counter declaration plus an increment as the body's own
 * last statement: `let i = <const>; while (i <cmp> bound) { ...; i++; }`. `rest` is every
 * statement AFTER the while in the same list — since eliding `prev` removes `loopVar` from
 * the enclosing scope entirely, this only fires when nothing after the loop still reads it
 * (a post-loop use of the counter, e.g. a "found index" pattern, must keep the loop as-is).
 */
function tryUnrollCountingWhile(prev, whileStmt, rest, consts, functions, shadowed, context, visit) {
    if (!ts.isVariableStatement(prev) || prev.declarationList.declarations.length !== 1)
        return undefined;
    const decl = prev.declarationList.declarations[0];
    if (!ts.isIdentifier(decl.name) || !decl.initializer)
        return undefined;
    const loopVar = decl.name.text;
    const start = tsEvalConst(decl.initializer, consts, functions, shadowed);
    if (start === undefined)
        return undefined;
    const cond = whileStmt.expression;
    if (!ts.isBinaryExpression(cond) || !ts.isIdentifier(cond.left) || cond.left.text !== loopVar)
        return undefined;
    const bound = tsEvalConst(cond.right, consts, functions, shadowed);
    if (bound === undefined)
        return undefined;
    const bodyStatements = whileStmt.statement
        ? ts.isBlock(whileStmt.statement)
            ? whileStmt.statement.statements
            : [whileStmt.statement]
        : [];
    const last = bodyStatements[bodyStatements.length - 1];
    if (!last || !ts.isExpressionStatement(last))
        return undefined;
    const step = extractStep(last.expression, loopVar, consts, functions, shadowed);
    if (step === undefined || step === 0n)
        return undefined;
    if (rest.some((s) => referencesIdentifier(s, loopVar)))
        return undefined;
    const innerBody = ts.factory.createBlock(bodyStatements.slice(0, -1), true); // exclude the consumed increment
    return unrollCountingLoop(loopVar, start, cond.operatorToken.kind, bound, step, innerBody, looksBigInt(decl.initializer), consts, functions, shadowed, context, visit);
}
/**
 * Visits a statement list, recognizing the `[counter decl, while (...) {...}]` pairing
 * before falling back to per-statement visiting — the natural place for this since eliding
 * the pair replaces TWO adjacent statements with N, which a single-node visitor can't express.
 */
function foldStatementList(statements, consts, functions, shadowed, context, visit) {
    const out = [];
    for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];
        const next = statements[i + 1];
        if (next && ts.isWhileStatement(next)) {
            const unrolled = tryUnrollCountingWhile(stmt, next, statements.slice(i + 2), consts, functions, shadowed, context, visit);
            if (unrolled) {
                out.push(...unrolled);
                i++; // consumed `next` (the while) too
                continue;
            }
        }
        const visited = visit(stmt, shadowed);
        if (Array.isArray(visited))
            out.push(...visited);
        else if (visited)
            out.push(visited);
    }
    return out;
}
/**
 * `foldTransformer`'s own scope tracking, mirroring `constPropagationTransformer`'s
 * (`isPlainFunctionScope`/`isMethodLikeScope`/`collectVarNames`/`collectBindingNames`/
 * `collectDirectlyDeclaredNames`, defined further below — reused as-is here; JS/TS function
 * hoisting means the declaration order in this file doesn't matter). Every scope-introducing
 * node grows a `shadowed` set of names reserved by SOMETHING between the current node and the
 * top level (a parameter, a nested function/let/const/var/catch-binding/for-loop-declaration
 * of the same name, …) — `tsEvalConst`'s Identifier case and `tsEvalCall`'s callee lookup
 * both consult this set before ever touching the top-level `consts`/`functions` maps, so a
 * shadowed name is never folded against the WRONG (top-level, unrelated) binding. Without
 * this, a nested function/parameter/block-scoped `let` sharing a name with a top-level
 * const or function would silently hijack every fold inside that scope to the outer
 * binding's value instead of the real (shadowing) one.
 */
function foldTransformer(consts, functions) {
    return (context) => {
        const visit = (node, shadowed) => {
            if (ts.isIfStatement(node)) {
                const evaluated = foldExpression(node.expression, consts, functions, shadowed);
                if (evaluated.success) {
                    const taken = Boolean(evaluated.value) ? node.thenStatement : node.elseStatement;
                    if (!taken)
                        return undefined;
                    // A taken Block replaces the IfStatement in a statement LIST (Block.statements /
                    // SourceFile.statements) — flatten its contents into that list (via foldStatementList,
                    // so a while-pairing inside the taken branch is still recognized) rather than nesting
                    // a bare Block, which the downstream SauceScript compiler's statement processor does
                    // not accept as a standalone statement. Since the Block's own contents are being
                    // flattened rather than visited via the `ts.isBlock` case below, its directly-declared
                    // names are computed here too (same as that case) so a `let`/`const`/nested `function`
                    // in the taken branch still shadows correctly once flattened.
                    if (ts.isBlock(taken)) {
                        const names = new Set(shadowed);
                        collectDirectlyDeclaredNames(taken.statements, names);
                        return foldStatementList(taken.statements, consts, functions, names, context, visit);
                    }
                    return visit(taken, shadowed);
                }
            }
            else if (ts.isConditionalExpression(node)) {
                const evaluated = foldExpression(node.condition, consts, functions, shadowed);
                if (evaluated.success) {
                    return visit(Boolean(evaluated.value) ? node.whenTrue : node.whenFalse, shadowed);
                }
            }
            else if (ts.isForStatement(node)) {
                const unrolled = tryUnrollForLoop(node, consts, functions, shadowed, context, visit);
                if (unrolled)
                    return unrolled;
                // Not unrolled (a non-constant/non-canonical bound, say) — the loop stays real
                // runtime code, but its own declared counter still shadows for the condition/
                // incrementor/body, same as any other scope-introducing node.
                const names = new Set(shadowed);
                if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
                    for (const decl of node.initializer.declarations)
                        collectBindingNames(decl.name, names);
                }
                return ts.factory.updateForStatement(node, node.initializer ? visit(node.initializer, names) : undefined, node.condition ? visit(node.condition, names) : undefined, node.incrementor ? visit(node.incrementor, names) : undefined, visit(node.statement, names));
            }
            else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
                const names = new Set(shadowed);
                if (ts.isVariableDeclarationList(node.initializer)) {
                    for (const decl of node.initializer.declarations)
                        collectBindingNames(decl.name, names);
                }
                const visitedInit = visit(node.initializer, names);
                const visitedStmt = visit(node.statement, names);
                // The iterated/enumerated expression runs in the OUTER scope, before any iteration binds.
                const visitedExpr = visit(node.expression, shadowed);
                return ts.isForOfStatement(node)
                    ? ts.factory.updateForOfStatement(node, node.awaitModifier, visitedInit, visitedExpr, visitedStmt)
                    : ts.factory.updateForInStatement(node, visitedInit, visitedExpr, visitedStmt);
            }
            else if (ts.isBlock(node)) {
                const names = new Set(shadowed);
                collectDirectlyDeclaredNames(node.statements, names);
                return ts.factory.updateBlock(node, foldStatementList(node.statements, consts, functions, names, context, visit));
            }
            else if (ts.isCatchClause(node)) {
                const names = new Set(shadowed);
                if (node.variableDeclaration)
                    collectBindingNames(node.variableDeclaration.name, names);
                return ts.factory.updateCatchClause(node, node.variableDeclaration, visit(node.block, names));
            }
            else if (isPlainFunctionScope(node)) {
                const names = new Set(shadowed);
                for (const p of node.parameters)
                    collectBindingNames(p.name, names);
                if (node.body)
                    collectVarNames(node.body, names);
                // A named function (declaration, or named function EXPRESSION) can reference itself.
                if (node.name)
                    names.add(node.name.text);
                return ts.visitEachChild(node, (child) => (child === node.name ? child : visit(child, names)), context);
            }
            else if (isMethodLikeScope(node)) {
                const names = new Set(shadowed);
                for (const p of node.parameters)
                    collectBindingNames(p.name, names);
                if (node.body)
                    collectVarNames(node.body, names);
                return ts.visitEachChild(node, (child) => {
                    if (child === node.name) {
                        // A COMPUTED key genuinely reads whatever's inside, in the OUTER scope — a
                        // method/getter/setter can't reference its own (non-computed) key as a variable.
                        return ts.isComputedPropertyName(node.name)
                            ? ts.factory.updateComputedPropertyName(node.name, visit(node.name.expression, shadowed))
                            : node.name;
                    }
                    return visit(child, names);
                }, context);
            }
            else if (isFoldableValueExpression(node)) {
                const evaluated = foldExpression(node, consts, functions, shadowed);
                const literal = evaluated.success ? toLiteralNode(evaluated.value) : undefined;
                if (literal)
                    return literal;
            }
            return ts.visitEachChild(node, (child) => visit(child, shadowed), context);
        };
        return (sourceFile) => ts.factory.updateSourceFile(sourceFile, foldStatementList(sourceFile.statements, consts, functions, new Set(), context, visit));
    };
}
// ── Constant propagation to reads + dead-declaration elimination ──
//
// The fold pass above resolves every top-level `const`'s value into `consts` up front
// (`collectTopLevelConsts`) and already folds FOLDABLE initializer expressions in place
// (`const b = a + 3` becomes `const b = 4n`) — but it never touches a bare `Identifier`
// sitting in ordinary read position (`console.log(c)` stays `console.log(c)`), because a
// bare Identifier could just as easily be an lvalue, and `isFoldableValueExpression`
// deliberately excludes it (only Binary/PrefixUnary/TemplateExpression — none of which can
// ever be an assignment target — are folded wherever found). These two passes close that
// gap, running strictly AFTER fold+unroll, on ITS OUTPUT: a loop bound consumed by
// unrolling, or a condition consumed by branch-pruning, is already gone from the tree
// before either pass below ever looks for a reference to it.
//
// 1. `constPropagationTransformer` walks the (already folded/unrolled) tree and replaces
//    every unshadowed read of a top-level const name with its resolved literal.
// 2. `deadConstEliminationTransformer` then deletes any top-level `const` declaration left
//    with ZERO remaining `Identifier` occurrences of its name anywhere in the file.
//
// Both are scope-LOCAL to the SAME `consts` map the fold pass already trusts — same-file
// top-level `const`s only. `let`/`var`/reassignment chains are untouched by construction,
// not by a special guard: `collectTopLevelConsts` only ever records `NodeFlags.Const`
// declarations, so a `let`/`var` name is simply never a key in `consts`, and a bare
// Identifier that doesn't resolve in `consts` is always left exactly as found.
//
// Shadowing is tracked precisely enough to be safe without being a general dataflow engine:
// a nested `let`/`const`/`var`/function/parameter/catch-binding/for-loop-declaration with the
// SAME name reserves that name for its entire enclosing scope, matching real JS/TS semantics
// (a block-scoped name is reserved from the top of its scope, TDZ notwithstanding —
// referencing it before the declaration is a runtime error, never a silent fall-through to
// an outer binding of the same name) — so the WHOLE scope is computed once, up front, rather
// than incrementally per-statement. `var` is additionally hoisted to its enclosing FUNCTION
// (not block) scope, matching real `var` semantics, by a separate pre-scan that doesn't cross
// nested function/class boundaries. Only same-file top-level `const`s are ever tracked this
// way — no attempt is made to extend `consts` itself to nested-scope bindings (that stays out
// of scope, same as today).
/** Every Identifier bound by a (possibly nested/destructuring) binding name. */
function collectBindingNames(name, out) {
    if (ts.isIdentifier(name)) {
        out.add(name.text);
        return;
    }
    for (const element of name.elements) {
        if (ts.isBindingElement(element))
            collectBindingNames(element.name, out);
    }
}
/** The 3 function-DECLARATION/EXPRESSION scope shapes this narrow language surface actually
 * has — no classes, but object-literal method/getter/setter shorthand (see
 * `isMethodLikeScope` below) is still ordinary TS/JS syntax a `.sauce.ts` source can contain
 * (e.g. building a router struct argument), so it gets its own parallel scope check. */
function isPlainFunctionScope(node) {
    return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}
/**
 * The node kinds TypeScript uses for object-literal (and class) method/getter/setter
 * shorthand — a separate function-like-scope family from `isPlainFunctionScope`'s three
 * shapes, since none of `ts.isFunctionDeclaration`/`isFunctionExpression`/`isArrowFunction`
 * matches a `MethodDeclaration`/`GetAccessorDeclaration`/`SetAccessorDeclaration`. Classes are
 * already fully out of scope for this feature (`isOutOfScopeForPropagation` skips
 * `ts.isClassLike` outright, without descending), so in practice this only ever matters for
 * object-literal shorthand — but the scoping rules are identical either way: the parameter
 * list reserves each parameter's name for the whole method/getter/setter body, exactly like a
 * plain function.
 */
function isMethodLikeScope(node) {
    return ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}
/**
 * Every `var`-declared name reachable from `node` WITHOUT crossing into a nested function/
 * class boundary (those are separate `var` scopes of their own) — `var` is function-scoped,
 * not block-scoped, so a `var` declared inside a nested `if`/`for`/block still reserves its
 * name for the whole enclosing function, unlike `let`/`const`.
 */
function collectVarNames(node, out) {
    ts.forEachChild(node, (child) => {
        if (isPlainFunctionScope(child) || isMethodLikeScope(child) || ts.isClassLike(child))
            return; // a separate var-scope
        if (ts.isVariableStatement(child) && !(child.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) {
            for (const decl of child.declarationList.declarations)
                collectBindingNames(decl.name, out);
        }
        collectVarNames(child, out);
    });
}
/** Names a Block/statement-list declares DIRECTLY (not through a further-nested block/function). */
function collectDirectlyDeclaredNames(statements, out) {
    for (const stmt of statements) {
        if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations)
                collectBindingNames(decl.name, out);
        }
        else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
            out.add(stmt.name.text);
        }
        else if (ts.isClassDeclaration(stmt) && stmt.name) {
            out.add(stmt.name.text);
        }
    }
}
/**
 * Node kinds that are entirely out of scope for this feature — real object/array DATA
 * processing, and TS-only declaration forms that hold no runtime value read anyway (types
 * are stripped later regardless of what this pass does to them). Left completely untouched
 * (not even recursed into): classes/enums/namespaces don't occur in this language surface
 * ("no closures/classes/async" per the compiler's own scope), and import/export specifiers
 * are pure name bindings, never a value read.
 */
function isOutOfScopeForPropagation(node) {
    return (ts.isTypeNode(node) ||
        ts.isTypeParameterDeclaration(node) ||
        ts.isClassLike(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isImportDeclaration(node) ||
        ts.isImportEqualsDeclaration(node) ||
        ts.isExportDeclaration(node) ||
        ts.isBreakStatement(node) ||
        ts.isContinueStatement(node));
}
/** Recurse into a (possibly nested/destructuring) binding NAME position — never a read. */
function substituteBindingName(name, shadowed, consts, context) {
    if (ts.isIdentifier(name))
        return name; // a binding target, never itself a read
    if (ts.isObjectBindingPattern(name)) {
        return ts.factory.updateObjectBindingPattern(name, name.elements.map((el) => substituteConstReads(el, shadowed, consts, context)));
    }
    return ts.factory.updateArrayBindingPattern(name, name.elements.map((el) => ts.isBindingElement(el) ? substituteConstReads(el, shadowed, consts, context) : el));
}
/**
 * Recurse into an ASSIGNMENT TARGET — the left side of `=`/a compound-assignment operator, or
 * a `++`/`--` operand — where TypeScript represents destructuring ASSIGNMENT (`({a} = obj)`,
 * `[a, b] = arr`) with the SAME node kinds as an ordinary object/array literal VALUE (only the
 * parse position, not the node kind, distinguishes a target from a value), so this can't reuse
 * the plain read-position visitor. A bare `Identifier` (the binding actually being written to)
 * is never substituted — that mirrors `substituteBindingName`'s "a binding target, never
 * itself a read" rule for real destructuring DECLARATIONS, just for the assignment-expression
 * shape instead. Everything nested inside that genuinely still a READ, evaluated in the outer
 * (pre-assignment) scope, IS substituted: a `PropertyAccessExpression`/`ElementAccessExpression`
 * target's object expression (and, for the latter, its computed key), a computed object-literal
 * property key, and any destructuring DEFAULT value (`{ a = 1 } = obj`, `[a = 1] = arr`).
 */
function visitAssignmentTarget(node, shadowed, consts, context) {
    const read = (n) => substituteConstReads(n, shadowed, consts, context);
    const target = (n) => visitAssignmentTarget(n, shadowed, consts, context);
    if (ts.isParenthesizedExpression(node)) {
        return ts.factory.updateParenthesizedExpression(node, target(node.expression));
    }
    if (ts.isIdentifier(node) || ts.isOmittedExpression(node))
        return node; // the write target itself, never a read
    if (ts.isPropertyAccessExpression(node)) {
        return ts.factory.updatePropertyAccessExpression(node, read(node.expression), node.name);
    }
    if (ts.isElementAccessExpression(node)) {
        return ts.factory.updateElementAccessExpression(node, read(node.expression), read(node.argumentExpression));
    }
    if (ts.isArrayLiteralExpression(node)) {
        // A destructuring-assignment array pattern (`[a, ...rest] = arr`) — each element (or the
        // rest target) recurses as a further assignment target, not a plain read.
        return ts.factory.updateArrayLiteralExpression(node, node.elements.map((el) => ts.isSpreadElement(el) ? ts.factory.updateSpreadElement(el, target(el.expression)) : target(el)));
    }
    if (ts.isObjectLiteralExpression(node)) {
        // A destructuring-assignment object pattern (`{ a, b: c, ...rest } = obj`).
        return ts.factory.updateObjectLiteralExpression(node, node.properties.map((prop) => {
            if (ts.isShorthandPropertyAssignment(prop)) {
                // `{ a }` as a target binds `a` — never a read; `{ a = 1 }`'s default IS a read,
                // evaluated in the outer (pre-assignment) scope.
                return prop.objectAssignmentInitializer
                    ? ts.factory.updateShorthandPropertyAssignment(prop, prop.name, read(prop.objectAssignmentInitializer))
                    : prop;
            }
            if (ts.isPropertyAssignment(prop)) {
                // `{ a: target }` — the key is a label (a COMPUTED key genuinely reads whatever's
                // inside), the value recurses as a further assignment target, not a plain read.
                const name = ts.isComputedPropertyName(prop.name)
                    ? ts.factory.updateComputedPropertyName(prop.name, read(prop.name.expression))
                    : prop.name;
                return ts.factory.updatePropertyAssignment(prop, name, target(prop.initializer));
            }
            if (ts.isSpreadAssignment(prop))
                return ts.factory.updateSpreadAssignment(prop, target(prop.expression));
            return prop;
        }));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        // A default inside an ARRAY pattern (`[a = 1] = arr`) parses its element as a plain `=`
        // BinaryExpression (unlike an object pattern's dedicated `objectAssignmentInitializer`
        // slot) — the left is still the write target, the right is a genuine read.
        return ts.factory.updateBinaryExpression(node, target(node.left), node.operatorToken, read(node.right));
    }
    // Any other shape here isn't a real assignment target — leave it untouched rather than guess.
    return node;
}
/**
 * The substitution visitor: replaces every unshadowed read of a top-level const name with
 * its literal, threading a growing `shadowed` set down through every scope-introducing node.
 * Falls back to generic `ts.visitEachChild` recursion (under the SAME `shadowed` set) for any
 * node kind not specially handled — safe because the only slots that are ever NOT a value
 * read (declaration/binding names, property-access member names, non-computed object-literal
 * keys, and — see the assignment/update-operator cases below — an assignment's left-hand side
 * or an update expression's operand) are exactly the ones special-cased below.
 */
function substituteConstReads(node, shadowed, consts, context) {
    const visit = (n, s = shadowed) => substituteConstReads(n, s, consts, context);
    if (isOutOfScopeForPropagation(node))
        return node;
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATOR_TOKENS.has(node.operatorToken.kind)) {
        // `a = 1`, `a += 1`, `({a} = obj)`, `[a] = arr`, … — the left side (however deeply nested
        // a destructuring-assignment pattern it is) is a WRITE target, never a read, regardless of
        // which assignment operator is used (even `+=`/etc., which also reads the current value,
        // still can't have its target replaced by a literal — you can't assign into `1n`). Only
        // the right side is substituted as an ordinary read.
        return ts.factory.updateBinaryExpression(node, visitAssignmentTarget(node.left, shadowed, consts, context), node.operatorToken, visit(node.right));
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
        // `a++`/`--a`/etc. — the operand is a write target (it's re-assigned), same rule as above.
        const operand = visitAssignmentTarget(node.operand, shadowed, consts, context);
        return ts.isPrefixUnaryExpression(node)
            ? ts.factory.updatePrefixUnaryExpression(node, operand)
            : ts.factory.updatePostfixUnaryExpression(node, operand);
    }
    if (ts.isIdentifier(node)) {
        if (shadowed.has(node.text))
            return node;
        const value = consts.get(node.text);
        if (value === undefined)
            return node;
        return toLiteralNode(value) ?? node;
    }
    if (ts.isPropertyAccessExpression(node)) {
        // `.name` (the member label after the dot) is never a variable reference.
        return ts.factory.updatePropertyAccessExpression(node, visit(node.expression), node.name);
    }
    if (ts.isElementAccessExpression(node)) {
        return ts.factory.updateElementAccessExpression(node, visit(node.expression), visit(node.argumentExpression));
    }
    if (ts.isShorthandPropertyAssignment(node)) {
        // `{ a }` — `a` is BOTH the object key and an implicit read of the variable `a`.
        // `objectAssignmentInitializer` only ever appears when this shorthand is itself a
        // DESTRUCTURING target (`({ a = 1 } = obj)`), not a value read — left alone (out of
        // scope, same as any other binding-pattern default).
        if (!node.objectAssignmentInitializer && !shadowed.has(node.name.text)) {
            const value = consts.get(node.name.text);
            const literal = value !== undefined ? toLiteralNode(value) : undefined;
            if (literal)
                return ts.factory.createPropertyAssignment(node.name, literal);
        }
        return node;
    }
    if (ts.isPropertyAssignment(node)) {
        // A non-computed key (`{ a: ... }`) is a label, not a read; a computed key
        // (`{ [a]: ... }`) genuinely reads `a`.
        const name = ts.isComputedPropertyName(node.name)
            ? ts.factory.updateComputedPropertyName(node.name, visit(node.name.expression))
            : node.name;
        return ts.factory.updatePropertyAssignment(node, name, visit(node.initializer));
    }
    if (ts.isVariableDeclaration(node)) {
        return ts.factory.updateVariableDeclaration(node, substituteBindingName(node.name, shadowed, consts, context), node.exclamationToken, node.type, node.initializer ? visit(node.initializer) : undefined);
    }
    if (ts.isBindingElement(node)) {
        return ts.factory.updateBindingElement(node, node.dotDotDotToken, node.propertyName, substituteBindingName(node.name, shadowed, consts, context), node.initializer ? visit(node.initializer) : undefined);
    }
    if (ts.isParameter(node)) {
        return ts.factory.updateParameterDeclaration(node, node.modifiers, node.dotDotDotToken, substituteBindingName(node.name, shadowed, consts, context), node.questionToken, node.type, node.initializer ? visit(node.initializer) : undefined);
    }
    if (ts.isCatchClause(node)) {
        const names = new Set(shadowed);
        if (node.variableDeclaration)
            collectBindingNames(node.variableDeclaration.name, names);
        return ts.factory.updateCatchClause(node, node.variableDeclaration, visit(node.block, names));
    }
    if (ts.isBlock(node)) {
        const names = new Set(shadowed);
        collectDirectlyDeclaredNames(node.statements, names);
        return ts.factory.updateBlock(node, node.statements.map((s) => visit(s, names)));
    }
    if (isPlainFunctionScope(node)) {
        const names = new Set(shadowed);
        for (const p of node.parameters)
            collectBindingNames(p.name, names);
        if (node.body)
            collectVarNames(node.body, names);
        // A named function (declaration, or named function EXPRESSION) can reference itself.
        if (node.name)
            names.add(node.name.text);
        const childVisitor = (child) => (child === node.name ? child : visit(child, names));
        return ts.visitEachChild(node, childVisitor, context);
    }
    if (isMethodLikeScope(node)) {
        const names = new Set(shadowed);
        for (const p of node.parameters)
            collectBindingNames(p.name, names);
        if (node.body)
            collectVarNames(node.body, names);
        // A non-computed key (`method(...)` / `get x()` / `set x(...)`) is a label, not a read —
        // unlike a named function EXPRESSION, a method/getter/setter can't reference its own key
        // as a variable, so (unlike isPlainFunctionScope above) there's no self-reference name to
        // add to `names`. A COMPUTED key (`[expr](...)`) genuinely reads whatever's inside, and
        // that expression runs in the OUTER scope — before the method's own parameter scope
        // exists — same as a computed object-literal property key (see isPropertyAssignment below).
        const childVisitor = (child) => {
            if (child === node.name) {
                return ts.isComputedPropertyName(node.name)
                    ? ts.factory.updateComputedPropertyName(node.name, visit(node.name.expression, shadowed))
                    : node.name;
            }
            return visit(child, names);
        };
        return ts.visitEachChild(node, childVisitor, context);
    }
    if (ts.isForStatement(node)) {
        const names = new Set(shadowed);
        if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
            for (const decl of node.initializer.declarations)
                collectBindingNames(decl.name, names);
        }
        return ts.factory.updateForStatement(node, node.initializer ? visit(node.initializer, names) : undefined, node.condition ? visit(node.condition, names) : undefined, node.incrementor ? visit(node.incrementor, names) : undefined, visit(node.statement, names));
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
        const names = new Set(shadowed);
        let visitedInit;
        if (ts.isVariableDeclarationList(node.initializer)) {
            for (const decl of node.initializer.declarations)
                collectBindingNames(decl.name, names);
            visitedInit = visit(node.initializer, names);
        }
        else {
            // Reusing an EXISTING binding as the loop target (`for (x of arr)`, `for (x in obj)`, or a
            // destructuring reuse `for ([x, y] of pairs)`/`for ({val: x} of arr)`) is a genuine WRITE
            // on every iteration, never a read — route it through the same assignment-target visitor
            // every other write shape in this file already uses, instead of treating it as an ordinary
            // read position (which would let a tracked const/effectively-const name get substituted
            // into the loop's own binding target).
            visitedInit = visitAssignmentTarget(node.initializer, names, consts, context);
        }
        const visitedStmt = visit(node.statement, names);
        // The iterated/enumerated expression is evaluated in the OUTER scope — it can never see
        // the loop's own declaration, regardless of TDZ (it runs once, before any iteration binds).
        const visitedExpr = visit(node.expression, shadowed);
        return ts.isForOfStatement(node)
            ? ts.factory.updateForOfStatement(node, node.awaitModifier, visitedInit, visitedExpr, visitedStmt)
            : ts.factory.updateForInStatement(node, visitedInit, visitedExpr, visitedStmt);
    }
    if (ts.isLabeledStatement(node)) {
        return ts.factory.updateLabeledStatement(node, node.label, visit(node.statement));
    }
    return ts.visitEachChild(node, (child) => visit(child), context);
}
// ── Effectively-const `let`/`var` detection (top-level scope only) ──
//
// A top-level `let`/`var` that is WRITTEN EXACTLY ONCE across its entire (shadow-respecting)
// visible scope is semantically indistinguishable from a `const` — nothing downstream can ever
// observe a second value, so folding it into the exact same `consts` map real top-level
// `const`s already use is just as sound (the standard "effectively final" analysis — the same
// rule Java applies to lambda capture). Two shapes are recognized, both scoped to TOP-LEVEL
// declarations only (the identical scope boundary real `const` tracking already uses — a
// function-local/nested-scope `let` is out of scope here, same as before):
//
//  1. PRIMARY — `let x = <init>;` (or `var`) where `x` is never written again anywhere in the
//     file. Handled by `analyzeTopLevelConsts` below in exactly the same pass, and exactly the
//     same way, as a real top-level `const` — added to `consts`, later eliminated by
//     `deadConstEliminationTransformer` once every read has been substituted away.
//  2. STRETCH — the two-statement idiom `let x; x = <init>;` (a bare predeclaration —
//     `NodeFlags.Let`/`Var`, no initializer — immediately... not necessarily ADJACENT, but
//     both statements are direct, unconditional members of the SAME top-level statement list,
//     e.g. the multi-declarator `let a, b, c;` followed by three separate later top-level
//     assignments). Recognized ONLY when the declaration and its sole assignment are both
//     direct `sourceFile.statements` entries (never nested inside an `if`/`for`/`while`/
//     function/block) — a conditional or nested assignment is never even considered, let alone
//     folded. This is a genuinely new kind of elimination: it removes a STATEMENT PAIR (the
//     predeclaration's now-empty declarator + its one assignment statement), not a single
//     declarator — handled by `deadConstEliminationTransformer` alongside (but structurally
//     distinct from) the existing single-declaration removal.
//
// CRITICAL SOUNDNESS RULE: "written exactly once/never again" is a flat SYNTACTIC count of
// every assignment/compound-assignment/update-expression/destructuring-assignment target
// anywhere in the file that resolves (respecting lexical shadowing) to that top-level binding —
// NOT a reachability analysis. A second write inside an `if`/loop/function that might never
// execute at runtime still counts and still disqualifies the name; this is the conservative,
// sound rule the task requires (a syntactic "does ANY write exist" check), mirroring how the
// existing scope-shadowing analysis above is already computed once, up front, per scope.
//
// Interaction with the existing while-loop-unroll pairing (`foldStatementList` /
// `tryUnrollCountingWhile`, which ALSO recognizes an adjacent `[counter decl, while] `
// statement pair): a genuine loop counter is, by construction, written again inside the loop
// body (its own increment) — so PRIMARY's "zero further writes" check always disqualifies it
// before it can ever reach `consts`, regardless of whether the counter is declared with or
// without an initializer. STRETCH only ever matches a NO-initializer predeclaration, which
// `tryUnrollCountingWhile`'s `prev` shape never accepts anyway (it requires `decl.initializer`).
// And since `consts` here is fully precomputed ONCE, before `foldTransformer` (and therefore the
// while-unroll pass) ever runs, there is no ordering race between the two mechanisms — a name
// can only ever be claimed by one of them, decided purely by whether it's ever written again.
/**
 * Every bare-Identifier WRITE TARGET reachable from a (possibly nested/destructuring)
 * assignment-target expression — the same recursive shape `visitAssignmentTarget` above already
 * walks (a destructuring-assignment pattern reuses ordinary object/array-literal node kinds), but
 * this COLLECTS rather than substitutes: reports every leaf Identifier actually being written to.
 * A `PropertyAccessExpression`/`ElementAccessExpression` target (`obj.x = …`) writes a PROPERTY
 * of `obj`, never the variable `obj` itself — mirroring `visitAssignmentTarget`'s treatment of
 * that position as a nested READ (irrelevant here: a read is never a write).
 */
function collectAssignmentTargetIdentifiers(node, report) {
    if (ts.isParenthesizedExpression(node)) {
        collectAssignmentTargetIdentifiers(node.expression, report);
        return;
    }
    if (ts.isIdentifier(node)) {
        report(node.text);
        return;
    }
    if (ts.isOmittedExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        return; // a property write, or a hole in an array pattern — never a variable write
    }
    if (ts.isArrayLiteralExpression(node)) {
        for (const el of node.elements) {
            collectAssignmentTargetIdentifiers(ts.isSpreadElement(el) ? el.expression : el, report);
        }
        return;
    }
    if (ts.isObjectLiteralExpression(node)) {
        for (const prop of node.properties) {
            if (ts.isShorthandPropertyAssignment(prop))
                report(prop.name.text); // `{ a }` as a target writes `a`
            else if (ts.isPropertyAssignment(prop))
                collectAssignmentTargetIdentifiers(prop.initializer, report);
            else if (ts.isSpreadAssignment(prop))
                collectAssignmentTargetIdentifiers(prop.expression, report);
        }
        return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        // A destructuring default (`[a = 1] = arr`) — the LEFT is still the real target.
        collectAssignmentTargetIdentifiers(node.left, report);
    }
}
/**
 * For every name in `candidateNames`, how many times it is WRITTEN to (assignment target,
 * compound-assignment target, or `++`/`--` operand) anywhere in `root` — respecting the SAME
 * lexical-shadowing rules `substituteConstReads` already applies (a nested re-declaration of the
 * same name reserves it for that inner scope, so a write inside a shadowing scope doesn't count
 * against the outer binding of the same spelling). This mirrors `substituteConstReads`'s own
 * scope-threading shape (Block/CatchClause/ForStatement/ForIn/ForOf/plain-function/method-like)
 * exactly, but COUNTS instead of substituting — see the module comment above for why a flat
 * syntactic count (not reachability) is the correct, conservative rule here.
 */
function collectWriteCounts(root, candidateNames) {
    const counts = new Map();
    const bump = (name) => {
        if (!candidateNames.has(name))
            return;
        counts.set(name, (counts.get(name) ?? 0) + 1);
    };
    const reportIfUnshadowed = (shadowed) => (name) => {
        if (!shadowed.has(name))
            bump(name);
    };
    const visit = (node, shadowed) => {
        if (isOutOfScopeForPropagation(node))
            return;
        if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATOR_TOKENS.has(node.operatorToken.kind)) {
            collectAssignmentTargetIdentifiers(node.left, reportIfUnshadowed(shadowed));
            visit(node.right, shadowed);
            return;
        }
        if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
            (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
            collectAssignmentTargetIdentifiers(node.operand, reportIfUnshadowed(shadowed));
            return;
        }
        if (ts.isCatchClause(node)) {
            const names = new Set(shadowed);
            if (node.variableDeclaration)
                collectBindingNames(node.variableDeclaration.name, names);
            visit(node.block, names);
            return;
        }
        if (ts.isBlock(node)) {
            const names = new Set(shadowed);
            collectDirectlyDeclaredNames(node.statements, names);
            for (const s of node.statements)
                visit(s, names);
            return;
        }
        if (isPlainFunctionScope(node)) {
            const names = new Set(shadowed);
            for (const p of node.parameters)
                collectBindingNames(p.name, names);
            if (node.body)
                collectVarNames(node.body, names);
            if (node.name)
                names.add(node.name.text);
            ts.forEachChild(node, (child) => {
                if (child !== node.name)
                    visit(child, names);
            });
            return;
        }
        if (isMethodLikeScope(node)) {
            const names = new Set(shadowed);
            for (const p of node.parameters)
                collectBindingNames(p.name, names);
            if (node.body)
                collectVarNames(node.body, names);
            ts.forEachChild(node, (child) => visit(child, child === node.name ? shadowed : names));
            return;
        }
        if (ts.isForStatement(node)) {
            const names = new Set(shadowed);
            if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
                for (const decl of node.initializer.declarations)
                    collectBindingNames(decl.name, names);
            }
            if (node.initializer)
                visit(node.initializer, names);
            if (node.condition)
                visit(node.condition, names);
            if (node.incrementor)
                visit(node.incrementor, names);
            visit(node.statement, names);
            return;
        }
        if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
            const names = new Set(shadowed);
            if (ts.isVariableDeclarationList(node.initializer)) {
                for (const decl of node.initializer.declarations)
                    collectBindingNames(decl.name, names);
            }
            else {
                // Reusing an EXISTING top-level `let`/`var` as the loop target (`for (x of arr)`,
                // `for (x in obj)`, or a destructuring reuse `for ([x, y] of pairs)`/`for ({val: x} of
                // arr)`) is a genuine WRITE on every iteration — route it through the same
                // assignment-target collector every other write shape in this file already uses, so it
                // counts as (at least) a second write and can never be folded as effectively-const.
                collectAssignmentTargetIdentifiers(node.initializer, reportIfUnshadowed(shadowed));
            }
            visit(node.initializer, names);
            visit(node.statement, names);
            visit(node.expression, shadowed); // the iterated/enumerated expression runs in the OUTER scope
            return;
        }
        ts.forEachChild(node, (child) => visit(child, shadowed));
    };
    visit(root, new Set());
    return counts;
}
/** Every top-level `let`/`var` declared name (never `const`) — the candidate universe for
 * effectively-const detection, matching the same top-level-only scope boundary real `const`
 * tracking already uses. */
function collectTopLevelMutableNames(sourceFile) {
    const names = new Set();
    for (const stmt of sourceFile.statements) {
        if (!ts.isVariableStatement(stmt))
            continue;
        if (stmt.declarationList.flags & ts.NodeFlags.Const)
            continue;
        for (const decl of stmt.declarationList.declarations) {
            if (ts.isIdentifier(decl.name))
                names.add(decl.name.text);
        }
    }
    return names;
}
/** If `stmt` is exactly a bare `name = <expr>;` ExpressionStatement, its target `name` —
 * otherwise `undefined`. Used only to recognize a STRETCH pair's resolving assignment. */
function simpleAssignmentTargetName(stmt) {
    if (!ts.isExpressionStatement(stmt))
        return undefined;
    const expr = stmt.expression;
    if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
        return undefined;
    return ts.isIdentifier(expr.left) ? expr.left.text : undefined;
}
function analyzeTopLevelConsts(sourceFile, functions) {
    const consts = new Map();
    const primaryNames = new Set();
    const pairNames = new Set();
    const mutableNames = collectTopLevelMutableNames(sourceFile);
    const writeCounts = collectWriteCounts(sourceFile, mutableNames);
    // Names predeclared (no initializer) by a top-level `let`/`var` not yet resolved, awaiting
    // their sole later top-level assignment statement — the STRETCH idiom in progress. Tracked
    // as a plain Set here (not a statement reference): once matched, all this local pass needs
    // is "yes, a predeclaration for this name exists earlier in the file".
    const pendingPredecl = new Set();
    for (const stmt of sourceFile.statements) {
        // STRETCH soundness: `let x;` genuinely makes `x` readable (as `undefined`) from that point
        // forward — a real value, distinct from whatever `x` is later assigned. Any statement OTHER
        // than a pending name's own resolving assignment that references it is therefore a read of
        // that still-unassigned state; folding the name would let `constPropagationTransformer`
        // (which substitutes every unshadowed read file-wide, with no notion of statement order)
        // silently replace that read with the FUTURE value. Poison (permanently disqualify) any
        // pending name referenced by any statement that isn't its own resolving assignment — this
        // also covers a pending name read from inside another statement's initializer/expression
        // (e.g. `let x; let y = x + 1; x = 5;`), which would otherwise let `foldTransformer` (using
        // the final, order-blind `consts` map) fold `y`'s initializer using `x`'s eventual value.
        const resolvingName = simpleAssignmentTargetName(stmt);
        if (pendingPredecl.size > 0) {
            for (const name of [...pendingPredecl]) {
                if (name !== resolvingName && referencesIdentifier(stmt, name))
                    pendingPredecl.delete(name);
            }
        }
        if (ts.isVariableStatement(stmt)) {
            const isConst = Boolean(stmt.declarationList.flags & ts.NodeFlags.Const);
            for (const decl of stmt.declarationList.declarations) {
                if (!ts.isIdentifier(decl.name))
                    continue;
                const name = decl.name.text;
                if (isConst) {
                    if (!decl.initializer)
                        continue;
                    const value = tsEvalConst(decl.initializer, consts, functions, EMPTY_SHADOW);
                    if (value !== undefined)
                        consts.set(name, value);
                    continue;
                }
                if (decl.initializer) {
                    if ((writeCounts.get(name) ?? 0) > 0)
                        continue; // written again somewhere — not effectively const
                    const value = tsEvalConst(decl.initializer, consts, functions, EMPTY_SHADOW);
                    if (value === undefined)
                        continue;
                    consts.set(name, value);
                    primaryNames.add(name);
                }
                else {
                    pendingPredecl.add(name); // no initializer: only a STRETCH candidate
                }
            }
            continue;
        }
        if (!ts.isExpressionStatement(stmt))
            continue;
        const expr = stmt.expression;
        if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
            continue;
        if (!ts.isIdentifier(expr.left))
            continue;
        const name = expr.left.text;
        if (!pendingPredecl.has(name))
            continue;
        pendingPredecl.delete(name); // this IS the name's one recognized write, resolvable or not
        if (writeCounts.get(name) !== 1)
            continue; // a write exists elsewhere too — not sound to fold
        const value = tsEvalConst(expr.right, consts, functions, EMPTY_SHADOW);
        if (value === undefined)
            continue;
        consts.set(name, value);
        pairNames.add(name);
    }
    return { consts, primaryNames, pairNames };
}
/**
 * Structurally RE-DERIVES, from whatever tree currently holds it, a STRETCH pair name's two
 * statements (the no-initializer predeclaration + its sole top-level assignment) and their
 * non-read name nodes — the same shape `analyzeTopLevelConsts` itself matched, just re-applied
 * fresh. Never relies on a node reference carried in from elsewhere: by the time
 * `deadConstEliminationTransformer` runs, `foldTransformer`/`constPropagationTransformer` have
 * already rebuilt at least the assignment statement for any pair whose RHS was itself foldable
 * (e.g. `b = a + 3` → `b = 4n`), so a node identity captured any earlier would already be stale.
 */
function findPairStatements(sourceFile, name) {
    let declStatement;
    let declName;
    let assignStatement;
    let assignTargetName;
    for (const stmt of sourceFile.statements) {
        if (ts.isVariableStatement(stmt) && !(stmt.declarationList.flags & ts.NodeFlags.Const)) {
            for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.name.text === name && !decl.initializer) {
                    declStatement = stmt;
                    declName = decl.name;
                }
            }
        }
        else if (ts.isExpressionStatement(stmt)) {
            const expr = stmt.expression;
            if (ts.isBinaryExpression(expr) &&
                expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(expr.left) &&
                expr.left.text === name) {
                assignStatement = stmt;
                assignTargetName = expr.left;
            }
        }
    }
    if (!declStatement || !declName || !assignStatement || !assignTargetName)
        return undefined;
    return { declStatement, declName, assignStatement, assignTargetName };
}
function constPropagationTransformer(consts) {
    return (context) => {
        return (sourceFile) => {
            const statements = sourceFile.statements.map((stmt) => substituteConstReads(stmt, new Set(), consts, context));
            return ts.factory.updateSourceFile(sourceFile, statements);
        };
    };
}
/**
 * How many `Identifier`s named `name` occur in `root`, ignoring any node in `exclude` — and
 * ignoring LABEL positions the same way `substituteConstReads` itself already does (a
 * non-computed `PropertyAssignment`/`ShorthandPropertyAssignment` key is never a variable
 * read), so a struct-literal shorthand read that pass already substituted away (`{ a }` →
 * `{ a: <literal> }`, reusing the original `a` Identifier as the new key) doesn't count as a
 * phantom "still referenced" use of the const whose value was just inlined there. A surviving
 * (not-rewritten) `ShorthandPropertyAssignment` can never itself be a genuine unshadowed read
 * of a tracked top-level const either — if it were, `constPropagationTransformer` would
 * already have converted it — so its key is excluded too; only a destructuring default
 * (`objectAssignmentInitializer`) is still walked, since that IS a real read. `exclude` is a
 * SET (not a single node) because the STRETCH two-statement idiom has TWO non-read occurrences
 * to ignore — the predeclaration's own name AND the sole assignment's LHS target — where a
 * real `const`/PRIMARY `let` only ever has the one declarator name.
 */
function countIdentifierRefs(root, name, exclude) {
    let count = 0;
    const walk = (node) => {
        if (exclude.has(node))
            return;
        if (ts.isIdentifier(node) && node.text === name) {
            count++;
            return;
        }
        if (ts.isPropertyAssignment(node)) {
            if (ts.isComputedPropertyName(node.name))
                walk(node.name);
            walk(node.initializer);
            return;
        }
        if (ts.isShorthandPropertyAssignment(node)) {
            if (node.objectAssignmentInitializer)
                walk(node.objectAssignmentInitializer);
            return;
        }
        ts.forEachChild(node, walk);
    };
    walk(root);
    return count;
}
/** Every array element must itself resolve via `tsEvalConst` — no spreads, no nested tables. */
function foldArrayLiteralElements(lit, consts, functions) {
    const out = [];
    for (const el of lit.elements) {
        if (ts.isSpreadElement(el) || ts.isArrayLiteralExpression(el) || ts.isObjectLiteralExpression(el))
            return undefined;
        const value = tsEvalConst(el, consts, functions, EMPTY_SHADOW);
        if (value === undefined)
            return undefined;
        out.push(value);
    }
    return out;
}
/**
 * Every property must be a plain (non-computed) `key: value` / `"key": value` assignment whose
 * value itself resolves via `tsEvalConst` — no shorthand/spread/method/getter/setter, no computed
 * keys, no nested tables.
 */
function foldObjectLiteralProps(lit, consts, functions) {
    const out = new Map();
    for (const prop of lit.properties) {
        if (!ts.isPropertyAssignment(prop) || ts.isComputedPropertyName(prop.name))
            return undefined;
        if (ts.isArrayLiteralExpression(prop.initializer) || ts.isObjectLiteralExpression(prop.initializer))
            return undefined;
        const key = ts.isIdentifier(prop.name)
            ? prop.name.text
            : ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name)
                ? prop.name.text
                : undefined;
        if (key === undefined)
            return undefined;
        const value = tsEvalConst(prop.initializer, consts, functions, EMPTY_SHADOW);
        if (value === undefined)
            return undefined;
        out.set(key, value);
    }
    return out;
}
/**
 * The OUTERMOST node representing the same logical value as `node` — `node` itself, or (if
 * `node` sits directly inside one or more `(parens)`) the outermost of those wrapping
 * `ParenthesizedExpression`s. Needed because an AST parent field (`BinaryExpression.left`,
 * `CallExpression.expression`, a `PropertyAssignment.initializer`, ...) points at whatever its
 * DIRECT child is — for `(ARR.foo)++`, the `PostfixUnaryExpression`'s `.operand` is the
 * `ParenthesizedExpression`, NOT the inner `PropertyAccessExpression` — so comparing a field
 * against `node` directly would silently miss a parenthesized write/call target. Every
 * `isTableAccessUnsafeUsage` field-identity check below compares against THIS, not the raw node.
 */
function outermostParenWrapper(node) {
    let current = node;
    while (current.parent && ts.isParenthesizedExpression(current.parent))
        current = current.parent;
    return current;
}
/**
 * True if `access` (a `NAME.prop`/`NAME[k]` access already known to have `NAME` as its base) sits
 * anywhere a WRITE or a CALL could happen: a call/new callee, a `delete` operand, an update
 * (`++`/`--`) operand, a plain/compound-assignment target, or — climbing up through the
 * object/array-literal "pattern" node shapes TypeScript reuses for destructuring assignment —
 * nested (however deeply) inside a pattern that is itself the target of `=` or a for-of/for-in
 * loop's per-iteration binding. The climb is what catches `({ k: NAME.x } = obj)` / `[NAME.x] =
 * arr`: a destructuring-assignment pattern parses with the exact same node kinds as an ordinary
 * object/array-literal VALUE, so only the OUTERMOST wrapper (an assignment's left side, or a
 * for-of/for-in binding) tells a target apart from a read — a single immediate-parent check
 * would miss it. Every step re-wraps through `outermostParenWrapper` so an arbitrarily
 * parenthesized target (`(ARR.foo)++`, `({ x: (ARR.y) } = obj)`, ...) is still caught.
 */
function isTableAccessUnsafeUsage(access) {
    const wrapped = outermostParenWrapper(access);
    const immediateParent = wrapped.parent;
    if (immediateParent && ts.isCallExpression(immediateParent) && immediateParent.expression === wrapped)
        return true;
    if (immediateParent && ts.isNewExpression(immediateParent) && immediateParent.expression === wrapped)
        return true;
    if (immediateParent && ts.isDeleteExpression(immediateParent) && immediateParent.expression === wrapped)
        return true;
    if (immediateParent &&
        (ts.isPrefixUnaryExpression(immediateParent) || ts.isPostfixUnaryExpression(immediateParent)) &&
        (immediateParent.operator === ts.SyntaxKind.PlusPlusToken ||
            immediateParent.operator === ts.SyntaxKind.MinusMinusToken) &&
        immediateParent.operand === wrapped) {
        return true;
    }
    let current = access;
    for (;;) {
        const w = outermostParenWrapper(current);
        const parent = w.parent;
        if (!parent)
            return false;
        if (ts.isBinaryExpression(parent) &&
            parent.left === w &&
            ASSIGNMENT_OPERATOR_TOKENS.has(parent.operatorToken.kind)) {
            return true;
        }
        if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === w)
            return true;
        if (ts.isPropertyAssignment(parent) && parent.initializer === w) {
            current = parent;
            continue;
        }
        if ((ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) && parent.expression === w) {
            current = parent;
            continue;
        }
        if (ts.isArrayLiteralExpression(parent) || ts.isObjectLiteralExpression(parent)) {
            current = parent;
            continue;
        }
        return false;
    }
}
/**
 * True if the Identifier `id` (already known to be an unshadowed reference to a tracked table
 * name) is used in the ONE safe shape this feature ever folds: immediately the base of a
 * property/element access that is not itself a write/call target. Anything else — a bare
 * argument, an alias, a return, a spread, the table's own name being reassigned/updated, a
 * method call, an element/property WRITE — falls through to `false`. This is an ALLOWLIST (only
 * the recognized-safe shape passes), not a blocklist, so an unrecognized shape fails closed.
 */
function isSafeTableRead(id) {
    const parent = id.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === id)
        return !isTableAccessUnsafeUsage(parent);
    if (ts.isElementAccessExpression(parent) && parent.expression === id)
        return !isTableAccessUnsafeUsage(parent);
    return false;
}
/**
 * `id` is the (unshadowed) iterated-expression identifier of a `for (x of id) {...}` loop — a
 * safe, read-only, non-aliasing use for an ARRAY table specifically (`kind` is checked by the
 * caller): its elements are bigints, primitive values with no aliasing/mutation risk, so
 * iterating them can never itself escape or mutate the array, regardless of whether the STRETCH
 * for-of UNROLL below can actually unroll this particular loop shape — an unrollable-shape
 * failure just leaves the loop as real runtime code, iterating the (still fully tracked, still
 * correctly-folded-elsewhere) array unchanged. A `for await...of` is excluded out of caution
 * (this narrow language surface has no async, but fail closed regardless).
 */
function isForOfIterableExpression(id) {
    const parent = id.parent;
    return ts.isForOfStatement(parent) && parent.expression === id && !parent.awaitModifier;
}
/**
 * Whole-file, shadow-aware safety scan for the tracked table `name` (of table-kind `kind`):
 * returns `false` the moment ANY occurrence of the (unshadowed) identifier isn't a safe read
 * (`isSafeTableRead`) or — for an array table only — a safe for-of iteration
 * (`isForOfIterableExpression`) — a single disqualifying use anywhere (reachable or not) rules
 * out the whole table. `exclude` is the declaration's own name node (a binding, never itself a
 * "use"). Shadowing is tracked with the EXACT same rules as `substituteConstReads` (reusing its
 * own helper functions), so a same-named inner declaration's occurrences are skipped entirely —
 * they refer to a different binding, not this table, and neither disqualify it nor participate
 * in `checkTableSafety`'s scan.
 *
 * Deliberately does NOT reuse `isOutOfScopeForPropagation`'s blanket "class/enum/module → skip
 * entirely, don't even descend" for THIS scan: that skip is sound for scalar constant
 * propagation (a const's *value* can't be mutated from inside one of these without illegally
 * reassigning the binding itself, already a hard error) but not for a tracked ARRAY/OBJECT
 * table — a class method, or a namespace function, can legally call a mutating method on (or
 * write through) an outer const table without ever reassigning the table's own binding, and
 * that occurrence must not be invisible to this scan. These node kinds aren't part of the
 * supported base language surface ("no closures/classes/async"), and a real class/namespace
 * anywhere in a source is independently rejected before `compile()` ever reaches this feature's
 * output — but `tsPartialEval` is itself a separately exported function, so this fails closed
 * on its own rather than leaning on that upstream gate: encountering one of these node kinds
 * disqualifies the table outright the moment the tracked name occurs ANYWHERE inside it (not a
 * "safe read" recheck — this scanner doesn't attempt to precisely re-derive scoping/aliasing
 * inside a node shape it otherwise never has to reason about, so it conservatively treats any
 * textual occurrence as disqualifying rather than risk missing a real one).
 */
function checkTableSafety(node, name, kind, shadowed, exclude) {
    if (node === exclude)
        return true;
    if (ts.isClassLike(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
        return !referencesIdentifier(node, name);
    }
    if (isOutOfScopeForPropagation(node))
        return true;
    if (ts.isIdentifier(node) && node.text === name) {
        if (shadowed.has(name))
            return true;
        return isSafeTableRead(node) || (kind === 'array' && isForOfIterableExpression(node));
    }
    if (ts.isBlock(node)) {
        const names = new Set(shadowed);
        collectDirectlyDeclaredNames(node.statements, names);
        return node.statements.every((s) => checkTableSafety(s, name, kind, names, exclude));
    }
    if (isPlainFunctionScope(node)) {
        const names = new Set(shadowed);
        for (const p of node.parameters)
            collectBindingNames(p.name, names);
        if (node.body)
            collectVarNames(node.body, names);
        if (node.name)
            names.add(node.name.text);
        let ok = true;
        ts.forEachChild(node, (child) => {
            if (child === node.name)
                return;
            if (!checkTableSafety(child, name, kind, names, exclude))
                ok = false;
        });
        return ok;
    }
    if (isMethodLikeScope(node)) {
        const names = new Set(shadowed);
        for (const p of node.parameters)
            collectBindingNames(p.name, names);
        if (node.body)
            collectVarNames(node.body, names);
        let ok = true;
        ts.forEachChild(node, (child) => {
            if (child === node.name) {
                if (ts.isComputedPropertyName(node.name) &&
                    !checkTableSafety(node.name.expression, name, kind, shadowed, exclude)) {
                    ok = false;
                }
                return;
            }
            if (!checkTableSafety(child, name, kind, names, exclude))
                ok = false;
        });
        return ok;
    }
    if (ts.isForStatement(node)) {
        const names = new Set(shadowed);
        if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
            for (const decl of node.initializer.declarations)
                collectBindingNames(decl.name, names);
        }
        let ok = true;
        if (node.initializer && !checkTableSafety(node.initializer, name, kind, names, exclude))
            ok = false;
        if (node.condition && !checkTableSafety(node.condition, name, kind, names, exclude))
            ok = false;
        if (node.incrementor && !checkTableSafety(node.incrementor, name, kind, names, exclude))
            ok = false;
        if (!checkTableSafety(node.statement, name, kind, names, exclude))
            ok = false;
        return ok;
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
        const names = new Set(shadowed);
        if (ts.isVariableDeclarationList(node.initializer)) {
            for (const decl of node.initializer.declarations)
                collectBindingNames(decl.name, names);
        }
        let ok = checkTableSafety(node.expression, name, kind, shadowed, exclude); // the iterated expr: outer scope
        if (!checkTableSafety(node.initializer, name, kind, names, exclude))
            ok = false;
        if (!checkTableSafety(node.statement, name, kind, names, exclude))
            ok = false;
        return ok;
    }
    if (ts.isCatchClause(node)) {
        const names = new Set(shadowed);
        if (node.variableDeclaration)
            collectBindingNames(node.variableDeclaration.name, names);
        return checkTableSafety(node.block, name, kind, names, exclude);
    }
    let ok = true;
    ts.forEachChild(node, (child) => {
        if (!checkTableSafety(child, name, kind, shadowed, exclude))
            ok = false;
    });
    return ok;
}
/**
 * Every same-file top-level `const NAME = [<foldable>, ...] / { key: <foldable>, ... }` that
 * passes BOTH soundness gates: (1) every element/property folds to a bigint via `tsEvalConst`
 * (so `consts` — the scalar top-level consts, collected first — may be referenced by a table's
 * elements, but a table may never reference another table), and (2) the whole-file
 * `checkTableSafety` scan finds zero disqualifying uses of the name. A literal failing either
 * gate is simply never added here — `tableFoldTransformer` only ever touches names present in
 * this map, so anything not tracked is left byte-for-byte untouched, same as before this
 * feature existed.
 */
function collectTopLevelTables(sourceFile, consts, functions) {
    const tables = new Map();
    for (const stmt of sourceFile.statements) {
        if (!ts.isVariableStatement(stmt))
            continue;
        if (!(stmt.declarationList.flags & ts.NodeFlags.Const))
            continue;
        for (const decl of stmt.declarationList.declarations) {
            if (!ts.isIdentifier(decl.name) || !decl.initializer)
                continue;
            const name = decl.name.text;
            const init = decl.initializer;
            let entry;
            if (ts.isArrayLiteralExpression(init)) {
                const elements = foldArrayLiteralElements(init, consts, functions);
                if (elements)
                    entry = { kind: 'array', elements };
            }
            else if (ts.isObjectLiteralExpression(init)) {
                const props = foldObjectLiteralProps(init, consts, functions);
                if (props)
                    entry = { kind: 'object', props };
            }
            if (!entry)
                continue; // not a fully-foldable literal — never a candidate, left completely alone
            if (checkTableSafety(sourceFile, name, entry.kind, new Set(), decl.name))
                tables.set(name, entry);
        }
    }
    return tables;
}
/** Resolve a single `NAME[k]` / `NAME.prop` / `NAME["prop"]` access to its literal element/property value, if provable. */
function foldTableAccess(node, table, consts, functions, shadowed) {
    if (ts.isPropertyAccessExpression(node)) {
        if (table.kind !== 'object')
            return undefined;
        const value = table.props.get(node.name.text);
        return value !== undefined ? toLiteralNode(value) : undefined;
    }
    if (table.kind === 'array') {
        const index = tsEvalConst(node.argumentExpression, consts, functions, shadowed);
        if (index === undefined || index < 0n || index >= BigInt(table.elements.length))
            return undefined;
        return toLiteralNode(table.elements[Number(index)]);
    }
    // Object table via a computed key — only a literal string (`TABLE["key"]`) is resolved; any
    // other computed-key shape is left untouched (this table has no OTHER disqualifying uses, so
    // this single unresolvable access simply stays as real runtime code, same as an out-of-bounds
    // array index).
    if (!ts.isStringLiteralLike(node.argumentExpression))
        return undefined;
    const value = table.props.get(node.argumentExpression.text);
    return value !== undefined ? toLiteralNode(value) : undefined;
}
/**
 * The table-folding transformer: shadow-aware (identical scope rules to
 * `constPropagationTransformer`/`substituteConstReads`, reusing the same helpers), replaces every
 * resolvable `NAME[k]`/`NAME.prop`/`NAME["prop"]` access — where `NAME` is an unshadowed
 * reference to a tracked table — with its literal value. A resolvable access is always safe to
 * fold outright (never a write/call target): `collectTopLevelTables`'s `checkTableSafety` gate
 * already proved zero such uses exist anywhere for a tracked name, and `foldTableAccess` itself
 * re-checks boundedness/constancy per access — this transformer additionally re-derives
 * `isTableAccessUnsafeUsage` per access as a second, independent guard (the same "belt and
 * suspenders" double-check this file already applies to the assignment-operator guard).
 */
/**
 * `for (const x of ARR) { ... }` where `ARR` is a tracked ARRAY table unrolls into one copy of
 * the body per element, the loop variable substituted by its literal value — the STRETCH-GOAL
 * counterpart of `unrollCountingLoop` above, adapted to iterate over TABLE ELEMENTS instead of
 * an arithmetic sequence, reusing the exact same safety infrastructure: `MAX_UNROLL_ITERATIONS`
 * (capped by element count, no need to count up to it — the length is already known),
 * `bodyBlocksUnrolling` (break/continue/return/counter-shadowing bail — "counter" here is the
 * loop variable), and `substituteCounter`. Declines (returns `undefined`, leaving the loop as
 * real runtime code) on: `for await...of`, a destructured loop variable (`for (const [a,b] of
 * ARR)` — out of scope, only a single plain identifier is supported), a shadowed or non-array-
 * table iterated expression, or a body that `bodyBlocksUnrolling` rejects. `reprocess` re-enters
 * the SAME statement-list visiting (`visitStatementList`) on each unrolled copy so a nested
 * `if`/loop/table-access keyed on the loop variable cascades to a fully-resolved literal per
 * iteration, exactly like the numeric unroller's own `foldStatementList` re-entry.
 */
function tryUnrollForOfArrayTable(node, tables, shadowed, context, reprocess) {
    if (node.awaitModifier)
        return undefined; // for-await — out of scope
    if (!ts.isIdentifier(node.expression) || shadowed.has(node.expression.text))
        return undefined;
    const table = tables.get(node.expression.text);
    if (!table || table.kind !== 'array')
        return undefined; // only an ARRAY table has an iteration order
    if (!ts.isVariableDeclarationList(node.initializer) || node.initializer.declarations.length !== 1)
        return undefined;
    const decl = node.initializer.declarations[0];
    if (!ts.isIdentifier(decl.name))
        return undefined; // a destructured loop variable — out of scope, decline
    const loopVar = decl.name.text;
    if (table.elements.length > MAX_UNROLL_ITERATIONS)
        return undefined;
    if (bodyBlocksUnrolling(node.statement, loopVar))
        return undefined;
    const bodyStatements = ts.isBlock(node.statement) ? node.statement.statements : [node.statement];
    return table.elements.flatMap((value) => {
        const literal = toLiteralNode(value);
        const substituted = bodyStatements.map((s) => substituteCounter(s, loopVar, literal, context));
        return reprocess(substituted, shadowed);
    });
}
/**
 * Visits a statement list for `tableFoldTransformer`, recognizing an unrollable `for...of` over
 * a tracked array table before falling back to the ordinary per-statement `visit` — the natural
 * place for this (mirroring `foldStatementList` above) since eliding one `ForOfStatement` in
 * favor of N unrolled copies replaces ONE list entry with MANY, which a single-node visitor
 * (`ts.visitEachChild`'s single-slot callback contract) cannot express. Kept as a SEPARATE
 * function from the single-node `visit` specifically so the unroll attempt only ever fires from
 * a genuine statement-LIST position (`Block.statements` / `SourceFile.statements`) — a for-of
 * loop sitting in a single-statement slot (e.g. the un-braced body of an outer `for`/`if`) is
 * conservatively left un-unrolled (falls through to `visit`'s own, ordinary — shadow-aware,
 * non-unrolling — `ForOfStatement` handling) rather than risk returning an array where exactly
 * one `ts.Statement` is structurally required.
 */
function visitStatementList(statements, visit, shadowed, tables, context) {
    const reprocess = (stmts, s) => visitStatementList(stmts, visit, s, tables, context);
    return statements.flatMap((stmt) => {
        if (ts.isForOfStatement(stmt)) {
            const unrolled = tryUnrollForOfArrayTable(stmt, tables, shadowed, context, reprocess);
            if (unrolled)
                return unrolled;
        }
        return [visit(stmt, shadowed)];
    });
}
function tableFoldTransformer(tables, consts, functions) {
    return (context) => {
        const visit = (node, shadowed) => {
            if (isOutOfScopeForPropagation(node))
                return node;
            if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
                ts.isIdentifier(node.expression) &&
                !shadowed.has(node.expression.text) &&
                tables.has(node.expression.text) &&
                !isTableAccessUnsafeUsage(node)) {
                const table = tables.get(node.expression.text);
                const literal = foldTableAccess(node, table, consts, functions, shadowed);
                if (literal)
                    return literal;
            }
            if (ts.isBlock(node)) {
                const names = new Set(shadowed);
                collectDirectlyDeclaredNames(node.statements, names);
                return ts.factory.updateBlock(node, visitStatementList(node.statements, visit, names, tables, context));
            }
            if (isPlainFunctionScope(node)) {
                const names = new Set(shadowed);
                for (const p of node.parameters)
                    collectBindingNames(p.name, names);
                if (node.body)
                    collectVarNames(node.body, names);
                if (node.name)
                    names.add(node.name.text);
                const childVisitor = (child) => (child === node.name ? child : visit(child, names));
                return ts.visitEachChild(node, childVisitor, context);
            }
            if (isMethodLikeScope(node)) {
                const names = new Set(shadowed);
                for (const p of node.parameters)
                    collectBindingNames(p.name, names);
                if (node.body)
                    collectVarNames(node.body, names);
                const childVisitor = (child) => {
                    if (child === node.name) {
                        return ts.isComputedPropertyName(node.name)
                            ? ts.factory.updateComputedPropertyName(node.name, visit(node.name.expression, shadowed))
                            : node.name;
                    }
                    return visit(child, names);
                };
                return ts.visitEachChild(node, childVisitor, context);
            }
            if (ts.isForStatement(node)) {
                const names = new Set(shadowed);
                if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
                    for (const decl of node.initializer.declarations)
                        collectBindingNames(decl.name, names);
                }
                return ts.factory.updateForStatement(node, node.initializer ? visit(node.initializer, names) : undefined, node.condition ? visit(node.condition, names) : undefined, node.incrementor ? visit(node.incrementor, names) : undefined, visit(node.statement, names));
            }
            if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
                const names = new Set(shadowed);
                if (ts.isVariableDeclarationList(node.initializer)) {
                    for (const decl of node.initializer.declarations)
                        collectBindingNames(decl.name, names);
                }
                const visitedInit = visit(node.initializer, names);
                const visitedStmt = visit(node.statement, names);
                const visitedExpr = visit(node.expression, shadowed); // outer scope
                return ts.isForOfStatement(node)
                    ? ts.factory.updateForOfStatement(node, node.awaitModifier, visitedInit, visitedExpr, visitedStmt)
                    : ts.factory.updateForInStatement(node, visitedInit, visitedExpr, visitedStmt);
            }
            if (ts.isCatchClause(node)) {
                const names = new Set(shadowed);
                if (node.variableDeclaration)
                    collectBindingNames(node.variableDeclaration.name, names);
                return ts.factory.updateCatchClause(node, node.variableDeclaration, visit(node.block, names));
            }
            return ts.visitEachChild(node, (child) => visit(child, shadowed), context);
        };
        return (sourceFile) => ts.factory.updateSourceFile(sourceFile, visitStatementList(sourceFile.statements, visit, new Set(), tables, context));
    };
}
/**
 * Removes any top-level `const` (or effectively-const PRIMARY `let`/`var`, or array/object
 * lookup-table declaration tracked in `tables`) whose name has zero remaining `Identifier`
 * occurrences anywhere in the (already-substituted) file — and, for a STRETCH pair, removes
 * its sole assignment statement too once the same holds. Deliberately a flat, whole-file
 * textual count — NOT scope-aware — matching `constPropagationTransformer`'s own guarantee
 * that it already replaced every reachable, unshadowed reference with a literal (and
 * `tableFoldTransformer`'s equivalent guarantee for a table's every resolvable access): by
 * this point, any occurrence still in the tree is either a shadowing inner declaration of the
 * SAME name (a coincidental false-positive "still referenced" that simply keeps this
 * otherwise-dead declaration around, harmlessly) or a genuine remaining use this pass
 * correctly declines to touch.
 *
 * DCE-of-a-PAIR design decision: once a STRETCH name becomes fully dead, BOTH its
 * predeclaration's (now-empty) declarator and its one assignment statement are removed
 * together, in this same pass — not left as an orphaned `let x;` (a declaration with no
 * initializer and no further use is exactly as dead as the assignment that gave it its only
 * value) and not deferred to a separate pass (nothing downstream should ever see a naked
 * `let x;` this transformer chain itself introduced by only removing half the pair).
 */
function deadConstEliminationTransformer(consts, primaryNames, pairNames, tables) {
    return (_context) => {
        return (sourceFile) => {
            // Real const + PRIMARY let/var: a single declarator, found directly (identity is safe
            // here — these node references come from THIS SAME `sourceFile`, never carried in).
            const declNameNodes = new Map();
            for (const stmt of sourceFile.statements) {
                if (!ts.isVariableStatement(stmt))
                    continue;
                const isConst = Boolean(stmt.declarationList.flags & ts.NodeFlags.Const);
                for (const decl of stmt.declarationList.declarations) {
                    if (!ts.isIdentifier(decl.name) || declNameNodes.has(decl.name.text))
                        continue;
                    const name = decl.name.text;
                    const tracked = isConst ? consts.has(name) || tables.has(name) : primaryNames.has(name);
                    if (tracked)
                        declNameNodes.set(name, decl.name);
                }
            }
            // STRETCH pairs: re-derived structurally, fresh, from this same `sourceFile` — see
            // `findPairStatements`'s own comment for why a carried-in node reference can't be used.
            const pairInfo = new Map();
            for (const name of pairNames) {
                const found = findPairStatements(sourceFile, name);
                if (found)
                    pairInfo.set(name, found);
            }
            if (declNameNodes.size === 0 && pairInfo.size === 0)
                return sourceFile;
            const eliminable = new Set();
            for (const [name, nameNode] of declNameNodes) {
                if (countIdentifierRefs(sourceFile, name, new Set([nameNode])) === 0)
                    eliminable.add(name);
            }
            for (const [name, info] of pairInfo) {
                const exclude = new Set([info.declName, info.assignTargetName]);
                if (countIdentifierRefs(sourceFile, name, exclude) === 0)
                    eliminable.add(name);
            }
            if (eliminable.size === 0)
                return sourceFile;
            const statements = sourceFile.statements.flatMap((stmt) => {
                // A STRETCH pair's assignment statement is removed OUTRIGHT once its name is dead.
                for (const [name, info] of pairInfo) {
                    if (eliminable.has(name) && info.assignStatement === stmt)
                        return [];
                }
                if (!ts.isVariableStatement(stmt))
                    return [stmt];
                const isConst = Boolean(stmt.declarationList.flags & ts.NodeFlags.Const);
                const kept = stmt.declarationList.declarations.filter((decl) => {
                    if (!ts.isIdentifier(decl.name))
                        return true;
                    const name = decl.name.text;
                    if (isConst)
                        return !((consts.has(name) || tables.has(name)) && eliminable.has(name));
                    if (primaryNames.has(name))
                        return !eliminable.has(name);
                    const pair = pairInfo.get(name);
                    if (pair && pair.declStatement === stmt)
                        return !eliminable.has(name);
                    return true;
                });
                if (kept.length === stmt.declarationList.declarations.length)
                    return [stmt];
                if (kept.length === 0)
                    return [];
                return [
                    ts.factory.updateVariableStatement(stmt, stmt.modifiers, ts.factory.updateVariableDeclarationList(stmt.declarationList, kept)),
                ];
            });
            return ts.factory.updateSourceFile(sourceFile, statements);
        };
    };
}
/**
 * Fold provably-constant branches/expressions/loops in a `.ts`/`.sauce.ts` module and
 * strip types, returning plain JS text ready for `acorn.parse`. Pure function of its input
 * text.
 */
export function tsPartialEval(code, filePath) {
    const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const functions = collectTopLevelFunctions(sourceFile);
    const { consts, primaryNames, pairNames } = analyzeTopLevelConsts(sourceFile, functions);
    // Table candidacy + the whole-file soundness scan run on the ORIGINAL, pre-fold source: a
    // disqualifying use must count even if it sits in a branch `foldTransformer` would otherwise
    // prune away (see the "Array/object lookup-table folding" section above).
    const tables = collectTopLevelTables(sourceFile, consts, functions);
    const result = ts.transpileModule(code, {
        fileName: filePath,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        transformers: {
            before: [
                foldTransformer(consts, functions),
                // Runs AFTER foldTransformer so an index/key that only becomes a literal once a loop
                // unrolls (e.g. `TABLE[i]` inside a `for` that unrolls `i` to a literal per iteration)
                // is still resolvable.
                tableFoldTransformer(tables, consts, functions),
                constPropagationTransformer(consts),
                deadConstEliminationTransformer(consts, primaryNames, pairNames, tables),
            ],
        },
    });
    return result.outputText;
}
