import * as ts from 'typescript';
import { evaluate } from 'ts-evaluator';
import type { EvaluateOptions } from 'ts-evaluator';

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

const POLICY: NonNullable<EvaluateOptions['policy']> = {
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

function tryEvaluate(node: ts.Expression): { success: true; value: unknown } | { success: false } {
  try {
    const result = evaluate({ node, typescript: ts, environment: { preset: 'NONE' }, policy: POLICY });

    return result.success ? { success: true, value: result.value } : { success: false };
  } catch {
    // ts-evaluator@2.0.0 throws (rather than returning a failure result) for some node
    // shapes it can't evaluate — e.g. a bare BigIntLiteral (`BigInt(node.text)` on text
    // like "3n" is itself a SyntaxError). Folding must never crash a compile: treat a
    // thrown error the same as an unsuccessful evaluation and leave the node untouched.
    return { success: false };
  }
}

// ── Hand-rolled bigint constant evaluator (ts.Node analogue of processor/const-eval.ts) ──

function tsEvalConst(node: ts.Node, consts: ReadonlyMap<string, bigint>): bigint | undefined {
  if (ts.isParenthesizedExpression(node)) return tsEvalConst(node.expression, consts);

  if (ts.isBigIntLiteral(node)) return BigInt(node.text.slice(0, -1)); // strip the "n" ts-evaluator's own BigInt() call rejects

  if (ts.isNumericLiteral(node)) {
    const n = Number(node.text);

    return Number.isInteger(n) ? BigInt(n) : undefined;
  }

  if (node.kind === ts.SyntaxKind.TrueKeyword) return 1n;

  if (node.kind === ts.SyntaxKind.FalseKeyword) return 0n;

  if (ts.isIdentifier(node)) return consts.get(node.text);

  if (ts.isPrefixUnaryExpression(node)) return tsEvalUnary(node, consts);

  if (ts.isBinaryExpression(node)) return tsEvalBinary(node, consts);

  return undefined;
}

function tsEvalUnary(node: ts.PrefixUnaryExpression, consts: ReadonlyMap<string, bigint>): bigint | undefined {
  const v = tsEvalConst(node.operand, consts);

  if (v === undefined) return undefined;

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

function tsEvalBinary(node: ts.BinaryExpression, consts: ReadonlyMap<string, bigint>): bigint | undefined {
  const op = node.operatorToken.kind;

  // Short-circuit && / ||, matching const-eval.ts: a known-falsy left collapses `&&`, a
  // known-truthy left collapses `||`, even when the right side isn't itself constant.
  if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
    const left = tsEvalConst(node.left, consts);
    const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;

    if (left !== undefined && (isAnd ? left === 0n : left !== 0n)) return isAnd ? 0n : 1n;

    const right = tsEvalConst(node.right, consts);

    if (left === undefined || right === undefined) return undefined;

    return (isAnd ? left !== 0n && right !== 0n : left !== 0n || right !== 0n) ? 1n : 0n;
  }

  const a = tsEvalConst(node.left, consts);
  const b = tsEvalConst(node.right, consts);

  if (a === undefined || b === undefined) return undefined;

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
function collectTopLevelConsts(sourceFile: ts.SourceFile): Map<string, bigint> {
  const consts = new Map<string, bigint>();

  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;

    if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;

    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;

      const value = tsEvalConst(decl.initializer, consts);

      if (value !== undefined) consts.set(decl.name.text, value);
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
const ASSIGNMENT_OPERATOR_TOKENS: ReadonlySet<ts.SyntaxKind> = new Set([
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
function foldExpression(
  node: ts.Expression,
  consts: ReadonlyMap<string, bigint>,
): { success: true; value: unknown } | { success: false } {
  if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATOR_TOKENS.has(node.operatorToken.kind)) {
    return { success: false };
  }

  const hand = tsEvalConst(node, consts);

  if (hand !== undefined) return { success: true, value: hand };

  return tryEvaluate(node);
}

/** A JS primitive foldable into a literal AST node (object/array/function/symbol/null/undefined are not). */
function toLiteralNode(value: unknown): ts.Expression | undefined {
  if (typeof value === 'boolean') return value ? ts.factory.createTrue() : ts.factory.createFalse();

  if (typeof value === 'string') return ts.factory.createStringLiteral(value);

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
function isFoldableValueExpression(
  node: ts.Node,
): node is ts.BinaryExpression | ts.PrefixUnaryExpression | ts.TemplateExpression {
  return ts.isBinaryExpression(node) || ts.isPrefixUnaryExpression(node) || ts.isTemplateExpression(node);
}

// ── Loop unrolling: a "countable" `for` with a constant start/bound/step becomes N copies
// of its body, the counter substituted by its literal value each time. ──

/** `i++`/`i--`/`i += step`/`i -= step` on the counter → the signed per-iteration step. */
function extractStep(
  incrementor: ts.Expression | undefined,
  loopVar: string,
  consts: ReadonlyMap<string, bigint>,
): bigint | undefined {
  if (!incrementor) return undefined;

  if (ts.isPostfixUnaryExpression(incrementor) || ts.isPrefixUnaryExpression(incrementor)) {
    if (!ts.isIdentifier(incrementor.operand) || incrementor.operand.text !== loopVar) return undefined;

    if (incrementor.operator === ts.SyntaxKind.PlusPlusToken) return 1n;

    if (incrementor.operator === ts.SyntaxKind.MinusMinusToken) return -1n;

    return undefined;
  }

  if (ts.isBinaryExpression(incrementor) && ts.isIdentifier(incrementor.left) && incrementor.left.text === loopVar) {
    const op = incrementor.operatorToken.kind;

    if (op === ts.SyntaxKind.PlusEqualsToken || op === ts.SyntaxKind.MinusEqualsToken) {
      const rhs = tsEvalConst(incrementor.right, consts);

      if (rhs === undefined) return undefined;

      return op === ts.SyntaxKind.PlusEqualsToken ? rhs : -rhs;
    }

    // `i = i + step` / `i = i - step` (a plain reassignment, not `+=`/`-=`) — the RHS
    // itself must be `loopVar +/- <const>`; `i = <anything else>` isn't a countable step.
    if (op === ts.SyntaxKind.EqualsToken && ts.isBinaryExpression(incrementor.right)) {
      const rhsOp = incrementor.right.operatorToken.kind;

      if (
        (rhsOp === ts.SyntaxKind.PlusToken || rhsOp === ts.SyntaxKind.MinusToken) &&
        ts.isIdentifier(incrementor.right.left) &&
        incrementor.right.left.text === loopVar
      ) {
        const step = tsEvalConst(incrementor.right.right, consts);

        if (step === undefined) return undefined;

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
function bodyBlocksUnrolling(node: ts.Node, loopVar: string): boolean {
  if (ts.isBreakStatement(node) || ts.isContinueStatement(node) || ts.isReturnStatement(node)) return true;

  if (
    (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
    ts.isIdentifier(node.name) &&
    node.name.text === loopVar
  ) {
    return true;
  }

  let blocked = false;

  ts.forEachChild(node, (child) => {
    if (!blocked && bodyBlocksUnrolling(child, loopVar)) blocked = true;
  });

  return blocked;
}

/** Replace every reference to `loopVar` in `node` with the literal `value`. */
function substituteCounter(
  node: ts.Node,
  loopVar: string,
  value: ts.Expression,
  context: ts.TransformationContext,
): ts.Node {
  const sub = (n: ts.Node): ts.Node =>
    ts.isIdentifier(n) && n.text === loopVar ? value : ts.visitEachChild(n, sub, context);

  return sub(node);
}

/** `decl.initializer` syntactically a BigIntLiteral (through a leading unary minus)? */
function looksBigInt(node: ts.Expression): boolean {
  return ts.isPrefixUnaryExpression(node) ? looksBigInt(node.operand) : ts.isBigIntLiteral(node);
}

function referencesIdentifier(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node) && node.text === name) return true;

  let found = false;

  ts.forEachChild(node, (child) => {
    if (!found && referencesIdentifier(child, name)) found = true;
  });

  return found;
}

/**
 * The shared unroll core: given a resolved counter/bound/step/comparison and a body, expands
 * to N copies of the body with the counter substituted by its per-iteration literal — used by
 * both `for` (bounds come from its own init/condition/incrementor) and the `while` counting
 * idiom (bounds come from a preceding decl + the condition + the body's own last statement).
 */
function unrollCountingLoop(
  loopVar: string,
  start: bigint,
  cmp: ts.SyntaxKind,
  bound: bigint,
  step: bigint,
  body: ts.Statement,
  useBigInt: boolean,
  consts: ReadonlyMap<string, bigint>,
  context: ts.TransformationContext,
  visit: (n: ts.Node) => ts.Node | ts.Node[] | undefined,
): ts.Statement[] | undefined {
  const isLess = cmp === ts.SyntaxKind.LessThanToken || cmp === ts.SyntaxKind.LessThanEqualsToken;
  const isGreater = cmp === ts.SyntaxKind.GreaterThanToken || cmp === ts.SyntaxKind.GreaterThanEqualsToken;

  if (!isLess && !isGreater) return undefined;

  // Direction sanity: a forward (`i < / <= bound`) loop needs a positive step, a backward
  // one a negative step — the other pairing either never runs (fine, unrolls to nothing,
  // handled below) or genuinely never terminates. Bail on the latter rather than hang.
  if ((isLess && step < 0n) || (isGreater && step > 0n)) return undefined;

  if (bodyBlocksUnrolling(body, loopVar)) return undefined;

  const continues = (v: bigint): boolean => {
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

  const values: bigint[] = [];

  for (let v = start; continues(v); v += step) {
    if (values.length >= MAX_UNROLL_ITERATIONS) return undefined; // too large — leave it as real runtime code

    values.push(v);
  }

  const bodyStatements = ts.isBlock(body) ? body.statements : [body];

  return values.flatMap((v) => {
    const literal = toLiteralNode(useBigInt ? v : Number(v))!;
    const substituted = bodyStatements.map((s) => substituteCounter(s, loopVar, literal, context) as ts.Statement);

    return foldStatementList(substituted, consts, context, visit);
  });
}

function tryUnrollForLoop(
  node: ts.ForStatement,
  consts: ReadonlyMap<string, bigint>,
  context: ts.TransformationContext,
  visit: (n: ts.Node) => ts.Node | ts.Node[] | undefined,
): ts.Statement[] | undefined {
  const init = node.initializer;

  if (!init || !ts.isVariableDeclarationList(init) || init.declarations.length !== 1) return undefined;

  const decl = init.declarations[0];

  if (!ts.isIdentifier(decl.name) || !decl.initializer) return undefined;

  const loopVar = decl.name.text;
  const start = tsEvalConst(decl.initializer, consts);

  if (start === undefined) return undefined;

  const cond = node.condition;

  if (!cond || !ts.isBinaryExpression(cond) || !ts.isIdentifier(cond.left) || cond.left.text !== loopVar) {
    return undefined;
  }

  const bound = tsEvalConst(cond.right, consts);

  if (bound === undefined) return undefined;

  const step = extractStep(node.incrementor, loopVar, consts);

  if (step === undefined || step === 0n) return undefined;

  return unrollCountingLoop(
    loopVar,
    start,
    cond.operatorToken.kind,
    bound,
    step,
    node.statement,
    looksBigInt(decl.initializer),
    consts,
    context,
    visit,
  );
}

/**
 * A `while` loop has no init/incrementor clauses of its own, so the countable idiom must be
 * spelled as a separate preceding counter declaration plus an increment as the body's own
 * last statement: `let i = <const>; while (i <cmp> bound) { ...; i++; }`. `rest` is every
 * statement AFTER the while in the same list — since eliding `prev` removes `loopVar` from
 * the enclosing scope entirely, this only fires when nothing after the loop still reads it
 * (a post-loop use of the counter, e.g. a "found index" pattern, must keep the loop as-is).
 */
function tryUnrollCountingWhile(
  prev: ts.Statement,
  whileStmt: ts.WhileStatement,
  rest: readonly ts.Statement[],
  consts: ReadonlyMap<string, bigint>,
  context: ts.TransformationContext,
  visit: (n: ts.Node) => ts.Node | ts.Node[] | undefined,
): ts.Statement[] | undefined {
  if (!ts.isVariableStatement(prev) || prev.declarationList.declarations.length !== 1) return undefined;

  const decl = prev.declarationList.declarations[0];

  if (!ts.isIdentifier(decl.name) || !decl.initializer) return undefined;

  const loopVar = decl.name.text;
  const start = tsEvalConst(decl.initializer, consts);

  if (start === undefined) return undefined;

  const cond = whileStmt.expression;

  if (!ts.isBinaryExpression(cond) || !ts.isIdentifier(cond.left) || cond.left.text !== loopVar) return undefined;

  const bound = tsEvalConst(cond.right, consts);

  if (bound === undefined) return undefined;

  const bodyStatements = whileStmt.statement
    ? ts.isBlock(whileStmt.statement)
      ? whileStmt.statement.statements
      : [whileStmt.statement]
    : [];
  const last = bodyStatements[bodyStatements.length - 1];

  if (!last || !ts.isExpressionStatement(last)) return undefined;

  const step = extractStep(last.expression, loopVar, consts);

  if (step === undefined || step === 0n) return undefined;

  if (rest.some((s) => referencesIdentifier(s, loopVar))) return undefined;

  const innerBody = ts.factory.createBlock(bodyStatements.slice(0, -1), true); // exclude the consumed increment

  return unrollCountingLoop(
    loopVar,
    start,
    cond.operatorToken.kind,
    bound,
    step,
    innerBody,
    looksBigInt(decl.initializer),
    consts,
    context,
    visit,
  );
}

/**
 * Visits a statement list, recognizing the `[counter decl, while (...) {...}]` pairing
 * before falling back to per-statement visiting — the natural place for this since eliding
 * the pair replaces TWO adjacent statements with N, which a single-node visitor can't express.
 */
function foldStatementList(
  statements: readonly ts.Statement[],
  consts: ReadonlyMap<string, bigint>,
  context: ts.TransformationContext,
  visit: (n: ts.Node) => ts.Node | ts.Node[] | undefined,
): ts.Statement[] {
  const out: ts.Statement[] = [];

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

    if (Array.isArray(visited)) out.push(...(visited as ts.Statement[]));
    else if (visited) out.push(visited as ts.Statement);
  }

  return out;
}

function foldTransformer(consts: ReadonlyMap<string, bigint>) {
  return (context: ts.TransformationContext): ts.Transformer<ts.SourceFile> => {
    const visit = (node: ts.Node): ts.Node | ts.Node[] | undefined => {
      if (ts.isIfStatement(node)) {
        const evaluated = foldExpression(node.expression, consts);

        if (evaluated.success) {
          const taken = Boolean(evaluated.value) ? node.thenStatement : node.elseStatement;

          if (!taken) return undefined;

          // A taken Block replaces the IfStatement in a statement LIST (Block.statements /
          // SourceFile.statements) — flatten its contents into that list (via foldStatementList,
          // so a while-pairing inside the taken branch is still recognized) rather than nesting
          // a bare Block, which the downstream SauceScript compiler's statement processor does
          // not accept as a standalone statement.
          return ts.isBlock(taken) ? foldStatementList(taken.statements, consts, context, visit) : visit(taken);
        }
      } else if (ts.isConditionalExpression(node)) {
        const evaluated = foldExpression(node.condition, consts);

        if (evaluated.success) {
          return visit(Boolean(evaluated.value) ? node.whenTrue : node.whenFalse);
        }
      } else if (ts.isForStatement(node)) {
        const unrolled = tryUnrollForLoop(node, consts, context, visit);

        if (unrolled) return unrolled;
      } else if (ts.isBlock(node)) {
        return ts.factory.updateBlock(node, foldStatementList(node.statements, consts, context, visit));
      } else if (isFoldableValueExpression(node)) {
        const evaluated = foldExpression(node, consts);
        const literal = evaluated.success ? toLiteralNode(evaluated.value) : undefined;

        if (literal) return literal;
      }

      return ts.visitEachChild(node, visit, context);
    };

    return (sourceFile) =>
      ts.factory.updateSourceFile(sourceFile, foldStatementList(sourceFile.statements, consts, context, visit));
  };
}

/**
 * Fold provably-constant branches/expressions/loops in a `.ts`/`.sauce.ts` module and
 * strip types, returning plain JS text ready for `acorn.parse`. Pure function of its input
 * text.
 */
export function tsPartialEval(code: string, filePath: string): string {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const consts = collectTopLevelConsts(sourceFile);

  const result = ts.transpileModule(code, {
    fileName: filePath,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    transformers: { before: [foldTransformer(consts)] },
  });

  return result.outputText;
}
