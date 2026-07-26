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
// ── Hand-rolled bigint constant evaluator (ts.Node analogue of processor/const-eval.ts) ──
function tsEvalConst(node, consts) {
    if (ts.isParenthesizedExpression(node))
        return tsEvalConst(node.expression, consts);
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
    if (ts.isIdentifier(node))
        return consts.get(node.text);
    if (ts.isPrefixUnaryExpression(node))
        return tsEvalUnary(node, consts);
    if (ts.isBinaryExpression(node))
        return tsEvalBinary(node, consts);
    return undefined;
}
function tsEvalUnary(node, consts) {
    const v = tsEvalConst(node.operand, consts);
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
function tsEvalBinary(node, consts) {
    const op = node.operatorToken.kind;
    // Short-circuit && / ||, matching const-eval.ts: a known-falsy left collapses `&&`, a
    // known-truthy left collapses `||`, even when the right side isn't itself constant.
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        const left = tsEvalConst(node.left, consts);
        const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
        if (left !== undefined && (isAnd ? left === 0n : left !== 0n))
            return isAnd ? 0n : 1n;
        const right = tsEvalConst(node.right, consts);
        if (left === undefined || right === undefined)
            return undefined;
        return (isAnd ? left !== 0n && right !== 0n : left !== 0n || right !== 0n) ? 1n : 0n;
    }
    const a = tsEvalConst(node.left, consts);
    const b = tsEvalConst(node.right, consts);
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
/** Every same-file top-level `const NAME = <literal>`, resolved in declaration order. */
function collectTopLevelConsts(sourceFile) {
    const consts = new Map();
    for (const stmt of sourceFile.statements) {
        if (!ts.isVariableStatement(stmt))
            continue;
        if (!(stmt.declarationList.flags & ts.NodeFlags.Const))
            continue;
        for (const decl of stmt.declarationList.declarations) {
            if (!ts.isIdentifier(decl.name) || !decl.initializer)
                continue;
            const value = tsEvalConst(decl.initializer, consts);
            if (value !== undefined)
                consts.set(decl.name.text, value);
        }
    }
    return consts;
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
function foldExpression(node, consts) {
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATOR_TOKENS.has(node.operatorToken.kind)) {
        return { success: false };
    }
    const hand = tsEvalConst(node, consts);
    if (hand !== undefined)
        return { success: true, value: hand };
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
 * unlike a bare Identifier, which might be the left side of an assignment or a declaration name.
 */
function isFoldableValueExpression(node) {
    return ts.isBinaryExpression(node) || ts.isPrefixUnaryExpression(node) || ts.isTemplateExpression(node);
}
// ── Loop unrolling: a "countable" `for` with a constant start/bound/step becomes N copies
// of its body, the counter substituted by its literal value each time. ──
/** `i++`/`i--`/`i += step`/`i -= step` on the counter → the signed per-iteration step. */
function extractStep(incrementor, loopVar, consts) {
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
            const rhs = tsEvalConst(incrementor.right, consts);
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
                const step = tsEvalConst(incrementor.right.right, consts);
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
function unrollCountingLoop(loopVar, start, cmp, bound, step, body, useBigInt, consts, context, visit) {
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
        return foldStatementList(substituted, consts, context, visit);
    });
}
function tryUnrollForLoop(node, consts, context, visit) {
    const init = node.initializer;
    if (!init || !ts.isVariableDeclarationList(init) || init.declarations.length !== 1)
        return undefined;
    const decl = init.declarations[0];
    if (!ts.isIdentifier(decl.name) || !decl.initializer)
        return undefined;
    const loopVar = decl.name.text;
    const start = tsEvalConst(decl.initializer, consts);
    if (start === undefined)
        return undefined;
    const cond = node.condition;
    if (!cond || !ts.isBinaryExpression(cond) || !ts.isIdentifier(cond.left) || cond.left.text !== loopVar) {
        return undefined;
    }
    const bound = tsEvalConst(cond.right, consts);
    if (bound === undefined)
        return undefined;
    const step = extractStep(node.incrementor, loopVar, consts);
    if (step === undefined || step === 0n)
        return undefined;
    return unrollCountingLoop(loopVar, start, cond.operatorToken.kind, bound, step, node.statement, looksBigInt(decl.initializer), consts, context, visit);
}
/**
 * A `while` loop has no init/incrementor clauses of its own, so the countable idiom must be
 * spelled as a separate preceding counter declaration plus an increment as the body's own
 * last statement: `let i = <const>; while (i <cmp> bound) { ...; i++; }`. `rest` is every
 * statement AFTER the while in the same list — since eliding `prev` removes `loopVar` from
 * the enclosing scope entirely, this only fires when nothing after the loop still reads it
 * (a post-loop use of the counter, e.g. a "found index" pattern, must keep the loop as-is).
 */
function tryUnrollCountingWhile(prev, whileStmt, rest, consts, context, visit) {
    if (!ts.isVariableStatement(prev) || prev.declarationList.declarations.length !== 1)
        return undefined;
    const decl = prev.declarationList.declarations[0];
    if (!ts.isIdentifier(decl.name) || !decl.initializer)
        return undefined;
    const loopVar = decl.name.text;
    const start = tsEvalConst(decl.initializer, consts);
    if (start === undefined)
        return undefined;
    const cond = whileStmt.expression;
    if (!ts.isBinaryExpression(cond) || !ts.isIdentifier(cond.left) || cond.left.text !== loopVar)
        return undefined;
    const bound = tsEvalConst(cond.right, consts);
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
    const step = extractStep(last.expression, loopVar, consts);
    if (step === undefined || step === 0n)
        return undefined;
    if (rest.some((s) => referencesIdentifier(s, loopVar)))
        return undefined;
    const innerBody = ts.factory.createBlock(bodyStatements.slice(0, -1), true); // exclude the consumed increment
    return unrollCountingLoop(loopVar, start, cond.operatorToken.kind, bound, step, innerBody, looksBigInt(decl.initializer), consts, context, visit);
}
/**
 * Visits a statement list, recognizing the `[counter decl, while (...) {...}]` pairing
 * before falling back to per-statement visiting — the natural place for this since eliding
 * the pair replaces TWO adjacent statements with N, which a single-node visitor can't express.
 */
function foldStatementList(statements, consts, context, visit) {
    const out = [];
    for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];
        const next = statements[i + 1];
        if (next && ts.isWhileStatement(next)) {
            const unrolled = tryUnrollCountingWhile(stmt, next, statements.slice(i + 2), consts, context, visit);
            if (unrolled) {
                out.push(...unrolled);
                i++; // consumed `next` (the while) too
                continue;
            }
        }
        const visited = visit(stmt);
        if (Array.isArray(visited))
            out.push(...visited);
        else if (visited)
            out.push(visited);
    }
    return out;
}
function foldTransformer(consts) {
    return (context) => {
        const visit = (node) => {
            if (ts.isIfStatement(node)) {
                const evaluated = foldExpression(node.expression, consts);
                if (evaluated.success) {
                    const taken = Boolean(evaluated.value) ? node.thenStatement : node.elseStatement;
                    if (!taken)
                        return undefined;
                    // A taken Block replaces the IfStatement in a statement LIST (Block.statements /
                    // SourceFile.statements) — flatten its contents into that list (via foldStatementList,
                    // so a while-pairing inside the taken branch is still recognized) rather than nesting
                    // a bare Block, which the downstream SauceScript compiler's statement processor does
                    // not accept as a standalone statement.
                    return ts.isBlock(taken) ? foldStatementList(taken.statements, consts, context, visit) : visit(taken);
                }
            }
            else if (ts.isConditionalExpression(node)) {
                const evaluated = foldExpression(node.condition, consts);
                if (evaluated.success) {
                    return visit(Boolean(evaluated.value) ? node.whenTrue : node.whenFalse);
                }
            }
            else if (ts.isForStatement(node)) {
                const unrolled = tryUnrollForLoop(node, consts, context, visit);
                if (unrolled)
                    return unrolled;
            }
            else if (ts.isBlock(node)) {
                return ts.factory.updateBlock(node, foldStatementList(node.statements, consts, context, visit));
            }
            else if (isFoldableValueExpression(node)) {
                const evaluated = foldExpression(node, consts);
                const literal = evaluated.success ? toLiteralNode(evaluated.value) : undefined;
                if (literal)
                    return literal;
            }
            return ts.visitEachChild(node, visit, context);
        };
        return (sourceFile) => ts.factory.updateSourceFile(sourceFile, foldStatementList(sourceFile.statements, consts, context, visit));
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
        if (ts.isVariableDeclarationList(node.initializer)) {
            for (const decl of node.initializer.declarations)
                collectBindingNames(decl.name, names);
        }
        const visitedInit = visit(node.initializer, names);
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
function constPropagationTransformer(consts) {
    return (context) => {
        return (sourceFile) => {
            const statements = sourceFile.statements.map((stmt) => substituteConstReads(stmt, new Set(), consts, context));
            return ts.factory.updateSourceFile(sourceFile, statements);
        };
    };
}
/**
 * How many `Identifier`s named `name` occur in `root`, ignoring the node at `exclude` — and
 * ignoring LABEL positions the same way `substituteConstReads` itself already does (a
 * non-computed `PropertyAssignment`/`ShorthandPropertyAssignment` key is never a variable
 * read), so a struct-literal shorthand read that pass already substituted away (`{ a }` →
 * `{ a: <literal> }`, reusing the original `a` Identifier as the new key) doesn't count as a
 * phantom "still referenced" use of the const whose value was just inlined there. A surviving
 * (not-rewritten) `ShorthandPropertyAssignment` can never itself be a genuine unshadowed read
 * of a tracked top-level const either — if it were, `constPropagationTransformer` would
 * already have converted it — so its key is excluded too; only a destructuring default
 * (`objectAssignmentInitializer`) is still walked, since that IS a real read.
 */
function countIdentifierRefs(root, name, exclude) {
    let count = 0;
    const walk = (node) => {
        if (node === exclude)
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
/**
 * Removes any top-level `const` declaration whose name has zero remaining `Identifier`
 * occurrences anywhere in the (already-substituted) file. Deliberately a flat, whole-file
 * textual count — NOT scope-aware — matching `constPropagationTransformer`'s own guarantee
 * that it already replaced every reachable, unshadowed reference with a literal: by this
 * point, any occurrence still in the tree is either a shadowing inner declaration of the
 * SAME name (a coincidental false-positive "still referenced" that simply keeps this
 * otherwise-dead declaration around, harmlessly) or a genuine remaining use this pass
 * correctly declines to touch.
 */
function deadConstEliminationTransformer(consts) {
    return (_context) => {
        return (sourceFile) => {
            const declNameNodes = new Map();
            for (const stmt of sourceFile.statements) {
                if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const))
                    continue;
                for (const decl of stmt.declarationList.declarations) {
                    if (ts.isIdentifier(decl.name) && consts.has(decl.name.text) && !declNameNodes.has(decl.name.text)) {
                        declNameNodes.set(decl.name.text, decl.name);
                    }
                }
            }
            const eliminable = new Set();
            for (const [name, nameNode] of declNameNodes) {
                if (countIdentifierRefs(sourceFile, name, nameNode) === 0)
                    eliminable.add(name);
            }
            if (eliminable.size === 0)
                return sourceFile;
            const statements = sourceFile.statements.flatMap((stmt) => {
                if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const))
                    return [stmt];
                const kept = stmt.declarationList.declarations.filter((decl) => !(ts.isIdentifier(decl.name) && eliminable.has(decl.name.text)));
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
    const consts = collectTopLevelConsts(sourceFile);
    const result = ts.transpileModule(code, {
        fileName: filePath,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        transformers: {
            before: [foldTransformer(consts), constPropagationTransformer(consts), deadConstEliminationTransformer(consts)],
        },
    });
    return result.outputText;
}
