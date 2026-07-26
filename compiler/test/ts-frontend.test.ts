import { compile, type CompileTarget } from '../src/index.js';
import { tsPartialEval } from '../src/ts-frontend.js';
import { OPS } from '../src/saucer/ops.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// The built-in fold+strip front-end (compiler/src/ts-frontend.ts), scoped to `.ts`/
// `.sauce.ts` sources/imports only. A plain `.js`/`.sauce` module never invokes it. Three
// groups: (1) direct unit tests of `tsPartialEval` as a pure string→string function — the
// right level to exercise fold shapes acorn's hand-rolled const-eval.ts can't
// (ConditionalExpression has no case there at all) without fighting SauceScript's OWN
// separate restrictions (e.g. a ternary may only appear in assignment position); (2) loop
// unrolling; (3) integration tests through the real `compile()` pipeline, proving the wiring.
//
// IMPORTANT (found while writing these tests): ts-evaluator@2.0.0 has a real bug —
// `BigInt(node.text)` on a bare BigIntLiteral throws (`node.text` is "3n", including the
// literal's own "n" suffix, which the BigInt() *constructor* rejects) — and separately,
// it cannot evaluate bigint BINARY expressions, array/property access, or function calls
// at all without a full ts.Program/TypeChecker (out of scope here). Since SauceScript is
// bigint-only, ts-frontend.ts's PRIMARY evaluator is `tsEvalConst`, a hand-rolled bigint
// evaluator (mirrors processor/const-eval.ts, retargeted to ts.Node) — ts-evaluator is only
// a fallback for shapes it doesn't cover (bare boolean/string identifiers, ternaries,
// templates). `tryEvaluate` still wraps ts-evaluator's `evaluate()` in try/catch for
// whatever still reaches it (a template literal with a bigint substitution, e.g.) — see the
// dedicated regression tests below.

describe('tsPartialEval (direct unit tests)', () => {
  it('strips TS-only syntax (type annotations)', () => {
    const out = tsPartialEval(`function f(n: bigint): bigint { return n; }`, 'f.ts');

    expect(out).not.toContain('bigint');
    expect(out).toContain('function f(n)');
  });

  it('folds a dead if/else branch gated on a same-file const identifier', () => {
    const code = `
      const FLAG = true;
      function f() {
        if (FLAG) { return 1; } else { return 2; }
      }
    `;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('return 1');
    expect(out).not.toContain('return 2');
  });

  it("folds a ternary used as a value — a ConditionalExpression, a node kind acorn's const-eval.ts has no case for at all", () => {
    const out = tsPartialEval(`const FLAG = true;\nconst x = FLAG ? 1 : 2;`, 'f.ts');

    expect(out).toContain('const x = 1');
    expect(out).not.toContain('? 1 : 2');
  });

  it('folds literal binary arithmetic to a single literal', () => {
    // `let`, not `const`: isFoldableValueExpression's literal-arithmetic fold doesn't care
    // about declaration kind (it's a purely syntactic check on the initializer shape), and
    // `let` keeps this test immune to the const-propagation-to-reads + dead-declaration-
    // elimination pass below (which would otherwise remove this now-fully-unused `const`
    // entirely, since nothing ever reads `y`) — that behavior has its own dedicated tests.
    const out = tsPartialEval(`let y = 2 + 3;`, 'f.ts');

    expect(out).toContain('let y = 5');
    expect(out).not.toContain('2 + 3');
  });

  it('folds a bare BigInt-literal condition — tsEvalConst resolves it directly, ts-evaluator never sees it', () => {
    const code = `
      function f() {
        if (1n) { return 1n; } else { return 2n; }
      }
    `;

    // ts-evaluator@2.0.0 would throw on this (BigInt(node.text) rejects the literal's own
    // "n" suffix) — but tsEvalConst handles BigIntLiteral directly and never delegates to
    // it for this shape, so it folds correctly instead of merely failing closed.
    expect(() => tsPartialEval(code, 'f.ts')).not.toThrow();
    const out = tsPartialEval(code, 'f.ts');
    expect(out).toContain('return 1n');
    expect(out).not.toContain('return 2n');
  });

  it('still fails closed (no throw) when a bigint reaches ts-evaluator itself — e.g. inside a template literal', () => {
    // tsEvalConst has no TemplateExpression case, so this falls through to the
    // ts-evaluator fallback with a bigint substitution present — the shape that would
    // otherwise hit ts-evaluator@2.0.0's BigInt(node.text) crash. tryEvaluate's try/catch
    // must still guard this regardless of what tsEvalConst itself now covers.
    const code = 'const x = `val:${1n}`;';

    expect(() => tsPartialEval(code, 'f.ts')).not.toThrow();
  });

  it('fails closed (no throw) on a runtime-derived (parameter) condition', () => {
    const code = `function f(n) { if (n === 1) { return 1; } return 2; }`;

    expect(() => tsPartialEval(code, 'f.ts')).not.toThrow();
    const out = tsPartialEval(code, 'f.ts');
    expect(out).toContain('return 1');
    expect(out).toContain('return 2');
  });

  it('never folds a bare assignment expression — ts-evaluator "succeeds" on `a = 1` (returns 1), which would silently discard the mutation', () => {
    // Regression: `evaluate({node: <the "a = 1" BinaryExpression>})` returns success:true,
    // value:1 — the assignment's own left-hand mutation is invisible to that "value". Before
    // the fix, isFoldableValueExpression's fold path replaced `a = 1;` with bare `1;`,
    // silently dropping the assignment to `a` entirely.
    const code = `let a, b, c;\na = 1;\nb = a + 3;\nc = b + 4;\nconsole.log(c);`;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('a = 1;');
    expect(out).not.toMatch(/^\s*1;/m);
  });

  it('never folds an assignment used as an if/ternary condition (the classic footgun pattern)', () => {
    const code = `let a;\nif (a = 1) { console.log('yes'); }\nconsole.log(a);`;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('a = 1');
    expect(out).toContain('if (');
  });

  it('never folds a compound assignment (+=) expression', () => {
    const code = `let x = 0;\nx += 5;\nconsole.log(x);`;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('x += 5;');
  });
});

describe('tsPartialEval (loop unrolling)', () => {
  it('unrolls a countable ++ loop into straight-line substituted statements', () => {
    const out = tsPartialEval(`let sum = 0n;\nfor (let i = 0n; i < 5n; i++) { sum = sum + i; }`, 'f.ts');

    expect(out).not.toContain('for (');
    for (const i of [0, 1, 2, 3, 4]) expect(out).toContain(`sum = sum + ${i}n;`);
  });

  it('unrolls += and plain "i = i + step" increments the same way', () => {
    const plusEquals = tsPartialEval(`let sum = 0n;\nfor (let i = 0n; i < 3n; i += 1n) { sum = sum + i; }`, 'f.ts');
    const reassign = tsPartialEval(`let sum = 0n;\nfor (let i = 0n; i < 3n; i = i + 1n) { sum = sum + i; }`, 'f.ts');

    for (const out of [plusEquals, reassign]) {
      expect(out).not.toContain('for (');
      for (const i of [0, 1, 2]) expect(out).toContain(`sum = sum + ${i}n;`);
    }
  });

  it('unrolls a backward (countdown) loop', () => {
    const out = tsPartialEval(`let sum = 0n;\nfor (let i = 3n; i > 0n; i--) { sum = sum + i; }`, 'f.ts');

    expect(out).not.toContain('for (');
    for (const i of [3, 2, 1]) expect(out).toContain(`sum = sum + ${i}n;`);
  });

  it('cascades: a nested if inside the unrolled body folds against the substituted counter', () => {
    const out = tsPartialEval(
      `let sum = 0n;
       for (let i = 0n; i < 4n; i++) {
         if (i === 2n) { sum = sum + 100n; } else { sum = sum + i; }
       }`,
      'f.ts',
    );

    expect(out).not.toContain('for (');
    expect(out).not.toContain('if (');
    expect(out).toContain('sum = sum + 0n;');
    expect(out).toContain('sum = sum + 1n;');
    expect(out).toContain('sum = sum + 100n;'); // the i===2n iteration took the "then" branch
    expect(out).toContain('sum = sum + 3n;');
  });

  it('a same-file const bound (data known at compile time) drives the unroll', () => {
    const out = tsPartialEval(
      `const N = 4n;\nlet product = 1n;\nfor (let i = 1n; i <= N; i++) { product = product * i; }`,
      'f.ts',
    );

    expect(out).not.toContain('for (');
    for (const i of [1, 2, 3, 4]) expect(out).toContain(`product = product * ${i}n;`);
  });

  it('a zero-iteration loop is removed entirely', () => {
    const out = tsPartialEval(`let sum = 0n;\nfor (let i = 0n; i < 0n; i++) { sum = sum + i; }`, 'f.ts');

    expect(out).not.toContain('for (');
    expect(out.trim()).toBe('let sum = 0n;');
  });

  it('bails (leaves the loop as real runtime code) past the unroll cap', () => {
    const out = tsPartialEval(`let sum = 0n;\nfor (let i = 0n; i < 1000n; i++) { sum = sum + i; }`, 'f.ts');

    expect(out).toContain('for (');
  });

  it('bails on a non-constant (parameter-derived) bound', () => {
    const out = tsPartialEval(
      `function f(n) { let sum = 0n; for (let i = 0n; i < n; i++) { sum = sum + i; } return sum; }`,
      'f.ts',
    );

    expect(out).toContain('for (');
  });

  it('bails when the body contains break/continue/return', () => {
    for (const escape of ['break;', 'continue;', 'return sum;']) {
      const out = tsPartialEval(
        `let sum = 0n;\nfor (let i = 0n; i < 5n; i++) { if (i === 3n) { ${escape} } sum = sum + i; }`,
        'f.ts',
      );

      expect(out).toContain('for (');
    }
  });

  it('bails when the body shadows the counter name', () => {
    const out = tsPartialEval(`let sum = 0n;\nfor (let i = 0n; i < 3n; i++) { let i = 99n; sum = sum + i; }`, 'f.ts');

    expect(out).toContain('for (');
  });
});

describe('tsPartialEval (while-loop unrolling — the counting idiom, reusing the for-loop unroller)', () => {
  it('unrolls "let i = <const>; while (i < bound) { ...; i = i + step; }"', () => {
    const out = tsPartialEval(`let sum = 0n;\nlet i = 0n;\nwhile (i < 5n) { sum = sum + i; i = i + 1n; }`, 'f.ts');

    expect(out).not.toContain('while (');
    for (const i of [0, 1, 2, 3, 4]) expect(out).toContain(`sum = sum + ${i}n;`);
  });

  it('unrolls ++ and += increments the same way as the for-loop path', () => {
    const plusPlus = tsPartialEval(`let sum = 0n;\nlet i = 0n;\nwhile (i < 3n) { sum = sum + i; i++; }`, 'f.ts');
    const plusEquals = tsPartialEval(`let sum = 0n;\nlet i = 0n;\nwhile (i < 3n) { sum = sum + i; i += 1n; }`, 'f.ts');

    for (const out of [plusPlus, plusEquals]) {
      expect(out).not.toContain('while (');
      for (const i of [0, 1, 2]) expect(out).toContain(`sum = sum + ${i}n;`);
    }
  });

  it('unrolls a backward (countdown) while loop', () => {
    const out = tsPartialEval(`let sum = 0n;\nlet i = 3n;\nwhile (i > 0n) { sum = sum + i; i--; }`, 'f.ts');

    expect(out).not.toContain('while (');
    for (const i of [3, 2, 1]) expect(out).toContain(`sum = sum + ${i}n;`);
  });

  it('the counter declaration itself is elided — no dangling `let i` left behind', () => {
    const out = tsPartialEval(`let sum = 0n;\nlet i = 0n;\nwhile (i < 3n) { sum = sum + i; i++; }`, 'f.ts');

    expect(out).not.toContain('let i');
  });

  it('bails (keeps the loop, keeps the declaration) when the counter is read after the loop', () => {
    // Eliding `let i` would leave a dangling reference — a "found index" pattern like this
    // must NOT unroll, since i's post-loop value is observed.
    const code = `let sum = 0n;\nlet i = 0n;\nwhile (i < 5n) { sum = sum + i; i = i + 1n; }\nreturn i;`;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('while (');
    expect(out).toContain('let i');
  });

  it('bails when the counter decl is not IMMEDIATELY adjacent to the while', () => {
    const code = `let sum = 0n;\nlet i = 0n;\nsum = sum + 1n;\nwhile (i < 5n) { sum = sum + i; i = i + 1n; }`;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('while (');
  });

  it('bails on a non-constant bound, same guards as the for-loop path', () => {
    const code = `function f(n) { let sum = 0n; let i = 0n; while (i < n) { sum = sum + i; i++; } return sum; }`;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('while (');
  });

  it('cascades: a nested countdown while inside an unrolled for loop fully resolves', () => {
    const code = `
      let total = 0n;
      for (let i = 0n; i < 2n; i++) {
        let j = 0n;
        while (j < 3n) { total = total + i + j; j++; }
      }
    `;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).not.toContain('for (');
    expect(out).not.toContain('while (');
    // i=0: j=0,1,2 → "0n + 0n","0n + 1n","0n + 2n"; i=1: "1n + 0n","1n + 1n","1n + 2n"
    for (const [i, j] of [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
    ]) {
      expect(out).toContain(`total + ${i}n + ${j}n`);
    }
  });

  it('a while inside an if-branch is recognized once the branch is flattened', () => {
    const code = `let sum = 0n;\nif (true) { let i = 0n; while (i < 3n) { sum = sum + i; i++; } }`;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).not.toContain('if (');
    expect(out).not.toContain('while (');
    for (const i of [0, 1, 2]) expect(out).toContain(`sum = sum + ${i}n;`);
  });
});

// ── tsPartialEval (constant propagation to reads + dead-declaration elimination) ──
//
// The fold pass above already resolves a chained top-level `const` initializer
// (`const b = a + 3` → `const b = 4n`) but, until now, never substituted the resolved value
// into a later bare-identifier READ (`console.log(c)` stayed `console.log(c)`), and never
// removed a declaration that became fully unused as a result. These two passes (run AFTER
// fold+unroll, on ITS output) close that gap. Scope-aware: only the SAME same-file
// top-level `const`s the fold pass already tracks are ever substituted; a nested
// `let`/`const`/`var`/parameter/catch-binding/for-loop-declaration of the same name shadows
// correctly, and DCE is a simple whole-file textual reference count taken AFTER
// substitution (so a coincidentally-same-named shadowing declaration elsewhere in the file
// can keep an otherwise-dead top-level const around — harmless, never incorrect).
describe('tsPartialEval (constant propagation to reads + dead-declaration elimination)', () => {
  it('propagates a resolved const chain all the way to a bare-identifier read, eliminating every intermediate declaration', () => {
    const out = tsPartialEval(`const a = 1; const b = a + 3; const c = b + 4; console.log(c);`, 'f.ts');

    expect(out).not.toContain('const a');
    expect(out).not.toContain('const b');
    expect(out).not.toContain('const c');
    expect(out.trim()).toBe('console.log(8n);');
  });

  it('the same chain shape with let + plain reassignment is left completely alone — never substitutes the bare read, never drops the declaration (regression guard)', () => {
    // Deliberately the assignment-chain shape (matching the existing ASSIGNMENT_OPERATOR_TOKENS
    // regression test above), NOT a `let a = 1;` declaration-with-initializer chain — TS-evaluator's
    // own same-file identifier resolution already folds SOME `let` declaration-initializer
    // arithmetic today (a pre-existing, unrelated quirk of the ts-evaluator fallback, not
    // something this feature touches), but a bare-identifier READ (`console.log(c)`) and an
    // ASSIGNMENT (`b = a + 3;`) are never in `consts` (only `NodeFlags.Const` declarations are),
    // so neither this feature nor the fold pass ever substitutes or removes anything here.
    const code = `let a, b, c;\na = 1;\nb = a + 3;\nc = b + 4;\nconsole.log(c);`;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('let a, b, c;');
    expect(out).toContain('a = 1;');
    expect(out).toContain('b = a + 3;');
    expect(out).toContain('console.log(c);');
    expect(out).not.toMatch(/console\.log\(8/);
  });

  it('a same-named const declared inside a function shadows the outer one: the inner read stays a bare identifier, the outer (post-function) read still substitutes', () => {
    const code = `
      const a = 1;
      function f() {
        const a = 2;
        console.log(a);
      }
      console.log(a);
    `;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('const a = 2;');
    // Only the INNER (shadowed) read should still be a bare identifier reference.
    expect(out.match(/console\.log\(a\);/g)?.length).toBe(1);
    // The OUTER (top-level) read correctly resolves against the outer const.
    expect(out).toContain('console.log(1n);');
    // The outer declaration itself is conservatively KEPT: dead-const-elimination is a flat,
    // whole-file textual Identifier count (not scope-aware), so the inner shadowing
    // declaration/read of the same name "a" is enough to (harmlessly) keep `const a = 1;`
    // around even though every real (unshadowed) read of it was already inlined above. This
    // pins the documented behavior (ts-frontend.ts's own comment on
    // deadConstEliminationTransformer) so a future change to the scope-tracking can't silently
    // flip this either direction without a test noticing.
    expect(out).toContain('const a = 1;');
  });

  it("object-literal method/getter/setter shorthand: the method/setter's OWN parameter shadows an outer const of the same name — the param read stays a bare identifier, not the outer const's literal", () => {
    // Regression: MethodDeclaration/GetAccessorDeclaration/SetAccessorDeclaration are not
    // FunctionDeclaration/FunctionExpression/ArrowFunction (isPlainFunctionScope's 3 shapes),
    // so without dedicated handling their own parameter list never shadows the outer scope —
    // a read of the parameter would be wrongly rewritten to the outer const's literal value.
    const methodCode = `const a = 1;\nconst obj = {\n  method(a) { console.log(a); }\n};\nconsole.log(a);`;
    const methodOut = tsPartialEval(methodCode, 'f.ts');

    expect(methodOut).toContain('method(a) { console.log(a); }'); // the param read: untouched
    expect(methodOut).toContain('console.log(1n);'); // the outer (unshadowed) read: substituted

    const setterCode = `const a = 1;\nconst obj = { set prop(a) { console.log(a); } };\nconsole.log(a);`;
    const setterOut = tsPartialEval(setterCode, 'f.ts');

    expect(setterOut).toContain('set prop(a) { console.log(a); }');
    expect(setterOut).toContain('console.log(1n);');

    const getterCode = `const x = 1;\nconst obj = { get prop() { const x = 2; return x; } };\nconsole.log(x);`;
    const getterOut = tsPartialEval(getterCode, 'f.ts');

    expect(getterOut).toContain('const x = 2;');
    expect(getterOut).toContain('return x;'); // shadowed by the getter body's own `const x`
    expect(getterOut).toContain('console.log(1n);'); // the outer read still substitutes
  });

  it('object-literal method shorthand with a COMPUTED name: the computed key expression is still substituted (it is a genuine read, evaluated in the outer scope)', () => {
    const code = `const KEY = 1;\nconst obj = {\n  [KEY](a) { return a; }\n};`;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('[1n](a)');
    expect(out).not.toContain('KEY');
  });

  it('a top-level const read only via object-literal SHORTHAND (`{ a }`) is substituted AND its now-dead declaration is eliminated — the shorthand rewrite reuses the original Identifier as the new property KEY, which must not count as a phantom remaining reference', () => {
    // Regression: constPropagationTransformer's shorthand handling rewrites `{ a }` into
    // `{ a: <literal> }` by reusing `node.name` as the synthesized PropertyAssignment's key —
    // countIdentifierRefs must not mistake that label for a surviving read, or the const can
    // never be eliminated despite every real read already being inlined. This is exactly the
    // struct-literal idiom this codebase uses for router calls (PoolKey-style construction).
    const code = `const fee = 3000n;\nconst tickSpacing = 60n;\nfunction build(currency0, currency1, hooks) {\n  return { currency0, currency1, fee, tickSpacing, hooks };\n}`;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('fee: 3000n');
    expect(out).toContain('tickSpacing: 60n');
    expect(out).not.toContain('const fee');
    expect(out).not.toContain('const tickSpacing');
  });

  it('a top-level const referenced only inside a helper function has its value baked into the body, and its own now-dead declaration is removed', () => {
    const out = tsPartialEval(`const RATE = 3n;\nexport function scale(x) { return x * RATE; }`, 'f.ts');

    expect(out).not.toContain('RATE');
    expect(out).toContain('return x * 3n;');
  });

  it('a const used only as a fully-unrolled loop bound is eliminated once unrolling consumes its only reference', () => {
    const out = tsPartialEval(`const N = 4n;\nlet sum = 0n;\nfor (let i = 0n; i < N; i++) { sum = sum + i; }`, 'f.ts');

    expect(out).not.toContain('for (');
    expect(out).not.toContain('const N');
    for (const i of [0, 1, 2, 3]) expect(out).toContain(`sum = sum + ${i}n;`);
  });

  it('the same const ALSO used elsewhere (inside the unrolled body) is correctly substituted at every surviving site too', () => {
    const out = tsPartialEval(
      `const N = 4n;\nlet sum = 0n;\nfor (let i = 0n; i < N; i++) { sum = sum + N; }\nconsole.log(sum);`,
      'f.ts',
    );

    expect(out).not.toContain('for (');
    expect(out).not.toContain('const N');
    expect(out.match(/sum = sum \+ 4n;/g)?.length).toBe(4); // all 4 unrolled copies got the literal
    expect(out).toContain('console.log(sum);');
  });

  it('multiple reads of the same const across different statements are ALL substituted, and the declaration is eliminated only once every read is gone', () => {
    const out = tsPartialEval(
      `const K = 5n;\nconsole.log(K);\nconsole.log(K + 1n);\nfunction f() { return K; }`,
      'f.ts',
    );

    expect(out).not.toContain('const K');
    expect(out).toContain('console.log(5n);'); // the bare read — this feature's job
    expect(out).toContain('console.log(6n);'); // K + 1n — already folded by the EXISTING pass
    expect(out).toContain('return 5n;');
  });

  it('a const whose only use was inside a since-pruned dead if-branch is eliminated once branch-pruning removes that reference', () => {
    const out = tsPartialEval(`const SOME_CONST = 7n;\nif (false) { console.log(SOME_CONST); }`, 'f.ts');

    // The whole if-statement (the const's only use) was already pruned away by the EXISTING
    // fold pass — leaving zero references, so this pass's DCE removes the now-dead const too.
    expect(out.trim()).toBe('');
  });

  it('a const used only as a loop bound that DOES NOT unroll (past MAX_UNROLL_ITERATIONS) still gets its bound substituted into the surviving runtime loop, and is still eliminated', () => {
    // A real 3-stage interaction: foldTransformer bails on unrolling (the loop stays a real
    // `for`), constPropagationTransformer still walks INTO that surviving loop's condition and
    // substitutes the literal there, and deadConstEliminationTransformer then correctly drops
    // the now-fully-substituted `const N` declaration — leaving a genuine runtime loop with
    // its bound inlined as a literal, not a dangling reference to a removed declaration.
    const out = tsPartialEval(
      `const N = 1000n;\nlet sum = 0n;\nfor (let i = 0n; i < N; i++) { sum = sum + i; }`,
      'f.ts',
    );

    expect(out).toContain('for ('); // unrolling bailed — past the cap
    expect(out).toContain('i < 1000n'); // ...but the bound was still substituted
    expect(out).not.toContain('const N'); // ...and the now-dead declaration was still removed
  });

  it('a const used only as a loop bound that DOES NOT unroll because the body has a break/continue behaves the same way', () => {
    const out = tsPartialEval(
      `const N = 5n;\nlet sum = 0n;\nfor (let i = 0n; i < N; i++) { if (i === 2n) { break; } sum = sum + i; }`,
      'f.ts',
    );

    expect(out).toContain('for (');
    expect(out).toContain('i < 5n;');
    expect(out).not.toContain('const N');
  });
});

// ── tsPartialEval (folding a CALL to a same-file, side-effect-free, single-return function) ──
//
// `tsEvalConst` also resolves a CallExpression when its callee is a same-file top-level
// `FunctionDeclaration` whose ENTIRE body is exactly one `return <expr>;` statement, with
// zero CallExpression/NewExpression anywhere in that return expression (or in any parameter's
// default initializer) — a body that never calls anything trivially can't recurse, so no
// separate recursion analysis is needed — and every argument itself resolves to a constant.
// A folded call becomes an ordinary literal AST node at the CALL SITE ONLY: the callee's own
// `FunctionDeclaration` is never touched (it might still be called elsewhere with runtime
// args), so this composes for free with the existing const-propagation + dead-declaration-
// elimination passes below (a folded call's result is just another resolved top-level const
// value once bound to a `const NAME = <call>;` initializer) and with loop unrolling (a call
// inside an unrolled body folds independently per substituted-counter copy, since unrolling
// re-enters this same fold pass on each copy).
describe('tsPartialEval (folds a call to a same-file, side-effect-free, single-return function)', () => {
  it('folds the motivating example end to end: the call resolves to a literal, which then fully composes with const-propagation + dead-declaration elimination', () => {
    const out = tsPartialEval(`function double(x) { return x * 2n; }\nconst y = double(21n);\nconsole.log(y);`, 'f.ts');

    expect(out).toContain('function double(x)'); // the callee declaration is never eliminated
    expect(out).not.toContain('const y'); // y's own declaration is now fully dead, and removed
    expect(out).toContain('console.log(42n);'); // the call folded, then propagated all the way to the read
  });

  it('never folds a call whose body contains a NESTED call — even to another, itself-foldable function (soundness guard: no recursion analysis needed only because a zero-call body trivially cannot recurse)', () => {
    const out = tsPartialEval(
      `function inc(x) { return x + 1n; }
       function addTwice(x) { return inc(x) + 1n; }
       const z = addTwice(5n);
       console.log(z);`,
      'f.ts',
    );

    expect(out).toContain('addTwice(5n)'); // the call site is left completely untouched
    expect(out).toContain('console.log(z)'); // z never resolved, so its read stays a bare identifier
  });

  it('never folds a call whose body is more than one statement, or contains an if/loop, instead of exactly one `return <expr>;`', () => {
    const multiStatement = tsPartialEval(
      `function f(x) { let y = x; return y; }\nconst a = f(1n);\nconsole.log(a);`,
      'f.ts',
    );
    const withIf = tsPartialEval(
      `function g(x) { if (x > 0n) { return x; } return 0n; }\nconst b = g(1n);\nconsole.log(b);`,
      'f.ts',
    );

    expect(multiStatement).toContain('f(1n)');
    expect(multiStatement).toContain('console.log(a)');
    expect(withIf).toContain('g(1n)');
    expect(withIf).toContain('console.log(b)');
  });

  it('folds one call site with all-constant arguments while leaving another call site (a non-constant, parameter-derived argument) untouched — the callee declaration remains either way', () => {
    const out = tsPartialEval(
      `function double(x) { return x * 2n; }
       const a = double(3n);
       console.log(a);
       function useDouble(n) { return double(n); }`,
      'f.ts',
    );

    expect(out).toContain('function double(x)'); // still genuinely called elsewhere with a runtime arg
    expect(out).toContain('console.log(6n);'); // the constant call site: folded, propagated, decl eliminated
    expect(out).not.toContain('const a');
    expect(out).toContain('return double(n);'); // the non-constant call site: untouched, still a real call
  });

  it('folds a call whose body reads a module-level top-level const alongside its own parameter, using the already-resolved value as a lookup alongside the parameter overlay', () => {
    const out = tsPartialEval(
      `const RATE = 2n;
       function scale(x) { return x * RATE; }
       const y = scale(21n);
       console.log(y);`,
      'f.ts',
    );

    expect(out).toContain('console.log(42n);');
    expect(out).not.toContain('const y');
    expect(out).not.toContain('RATE'); // baked into scale's own body by the SEPARATE propagation pass, then eliminated
  });

  it('inside an already-unrolled loop, each copy folds the call independently with its own per-iteration counter argument', () => {
    const out = tsPartialEval(
      `function double(x) { return x * 2n; }
       for (let i = 0n; i < 3n; i++) { console.log(double(i)); }`,
      'f.ts',
    );

    expect(out).not.toContain('for (');
    expect(out).toContain('console.log(0n);');
    expect(out).toContain('console.log(2n);');
    expect(out).toContain('console.log(4n);');
  });

  it('a call omitting an argument for a parameter with a DEFAULT value evaluates that default too (a deliberate choice, not a rejection — see the ts-frontend.ts doc comment on tsEvalCall)', () => {
    const out = tsPartialEval(
      `function inc(x, step = 1n) { return x + step; }\nconst a = inc(5n);\nconsole.log(a);`,
      'f.ts',
    );

    expect(out).toContain('console.log(6n);');
    expect(out).not.toContain('const a');
  });

  it('a later default may reference an EARLIER already-bound parameter (documented left-to-right default evaluation)', () => {
    const out = tsPartialEval(
      `function f(a, b = a + 1n) { return a + b; }\nconst z = f(10n);\nconsole.log(z);`,
      'f.ts',
    );

    expect(out).toContain('console.log(21n);');
    expect(out).not.toContain('const z');
  });

  it('never folds a call to a callee reached through property access (`obj.method(...)`), only a same-file plain-identifier callee', () => {
    const out = tsPartialEval(
      `const obj = { double(x) { return x * 2n; } };\nconst a = obj.double(21n);\nconsole.log(a);`,
      'f.ts',
    );

    expect(out).toContain('obj.double(21n)');
    expect(out).toContain('console.log(a)');
  });

  it('never folds a call whose callee is a GENERATOR function — calling it yields an Iterator, never its `return`ed value', () => {
    const out = tsPartialEval(
      `function* gen() { return 7n; }\nfunction useGen() { return gen(); }\nconsole.log(useGen());`,
      'f.ts',
    );

    expect(out).toContain('gen()'); // the call site is left completely untouched
  });

  it('never folds a call whose callee is `async` — calling it yields a Promise, never its `return`ed value directly', () => {
    const out = tsPartialEval(`async function foo() { return 5n; }\nconst y = foo();\nconsole.log(y);`, 'f.ts');

    expect(out).toContain('foo()'); // the call site is left completely untouched
    expect(out).toContain('console.log(y)'); // never resolved, so its read stays a bare identifier
  });

  it("a call omitting an argument never lets an EARLIER default silently fall back to an outer const sharing a LATER (not-yet-bound) parameter's name — real JS/TS TDZ semantics mean this would actually throw at runtime, so folding must decline rather than compute the wrong value", () => {
    const out = tsPartialEval(
      `const b = 999n;\nfunction foo(a = b, b = 5n) { return a + b; }\nconst y = foo();\nconsole.log(y);`,
      'f.ts',
    );

    expect(out).toContain('foo()'); // the call site is left completely untouched
    expect(out).not.toContain('console.log(1004n)'); // NOT the outer const's value (999 + 5)
  });

  describe('soundness: a shadowed callee/identifier name is never resolved against an unrelated top-level binding', () => {
    it('never folds a call whose callee name is shadowed by a NESTED function declaration of the same name', () => {
      const out = tsPartialEval(
        `function calc(x) { return x + 1n; }
         function outer() {
           function calc(x) { return x + 100n; }
           return calc(5n);
         }
         console.log(outer());`,
        'f.ts',
      );

      // The inner `calc` call must stay untouched — folding it against the OUTER `calc`
      // would hardcode 6n (5+1) instead of leaving the real (inner) call for the compiler.
      expect(out).toContain('calc(5n)');
      expect(out).not.toContain('console.log(6n)');
    });

    it("never folds a call whose callee name is shadowed by the enclosing function's OWN parameter (the higher-order-function pattern)", () => {
      const out = tsPartialEval(
        `function greet(name) { return name + 100n; }
         function farewell(name) { return name + 999n; }
         function callIt(greet) { return greet(1n); }
         const y = callIt(farewell);
         console.log(y);`,
        'f.ts',
      );

      // `greet` inside `callIt`'s body refers to whatever's PASSED as the `greet` parameter,
      // never necessarily the top-level `greet` function — must not fold to a fixed literal.
      expect(out).toContain('greet(1n)');
    });

    it('never folds a call whose callee name is shadowed by a block-scoped `let` inside an if-branch', () => {
      const out = tsPartialEval(
        `function calc(x) { return x + 1n; }
         function outer(flag) {
           if (flag) {
             let calc = (n) => n + 999n;
             return calc(1n);
           }
           return 0n;
         }`,
        'f.ts',
      );

      expect(out).toContain('calc(1n)');
    });

    it('never folds a call shadowed by a block-scoped `let` even when the enclosing if-condition IS constant (so the branch is flattened directly into the enclosing statement list)', () => {
      const out = tsPartialEval(
        `function calc(x) { return x + 1n; }
         function outer() {
           if (true) {
             let calc = (n) => n + 999n;
             return calc(1n);
           }
           return 0n;
         }`,
        'f.ts',
      );

      expect(out).toContain('calc(1n)');
    });

    it("never folds a plain identifier/arithmetic expression whose name is shadowed by the enclosing function's OWN parameter, even when a top-level const of the exact same name exists", () => {
      const out = tsPartialEval(`const x = 999n;\nfunction f(x) { return x * 2n; }`, 'f.ts');

      // `x` inside `f`'s body is its own parameter, never the outer `const x` — the
      // multiplication must stay real runtime arithmetic, not fold to 1998n.
      expect(out).toContain('return x * 2n;');
      expect(out).not.toContain('1998');
    });
  });
});

// ── tsPartialEval (constant propagation never touches an assignment/update TARGET) ──
//
// constPropagationTransformer's substitution visitor must never replace the left side of an
// assignment (`=`/`+=`/etc.), a `++`/`--` operand, or any (possibly nested, destructuring)
// write-target position with a top-level const's literal value — doing so would either
// silently change the program's meaning or emit syntactically-invalid output (`1n = 2n;`,
// `1n++;`). This mirrors the guard `foldTransformer`/`ASSIGNMENT_OPERATOR_TOKENS` already
// applies to the (separate) folding pass, just for the propagate-to-reads pass.
describe('tsPartialEval (constant propagation never substitutes an assignment/update target)', () => {
  it('never substitutes the left side of a plain assignment, even reassigning a top-level const by name', () => {
    const out = tsPartialEval(`const a = 1n;\na = 2n;\nconsole.log(a);`, 'f.ts');

    expect(out).toContain('a = 2n;'); // NOT "1n = 2n;"
  });

  it('never substitutes the left side of a compound assignment (+=)', () => {
    const out = tsPartialEval(`const a = 1n;\nfunction main() { a += 2n; return a; }`, 'f.ts');

    expect(out).toContain('a += 2n;'); // NOT "1n += 2n;"
  });

  it('never substitutes the operand of a ++ / -- update expression (prefix or postfix)', () => {
    const postfix = tsPartialEval(`const a = 1n;\nfunction main() { a++; return a; }`, 'f.ts');
    const prefix = tsPartialEval(`const a = 1n;\nfunction main() { ++a; return a; }`, 'f.ts');

    expect(postfix).toContain('a++;'); // NOT "1n++;"
    expect(prefix).toContain('++a;'); // NOT "++1n;"
  });

  it("never substitutes a destructuring-assignment target (object or array), even reusing a top-level const's name as the shorthand target", () => {
    const objectPattern = tsPartialEval(`const a = 1n;\nlet obj = { a: 5n };\n({ a } = obj);\nconsole.log(a);`, 'f.ts');
    const arrayPattern = tsPartialEval(`const a = 1n;\nlet arr = [5n];\n[a] = arr;\nconsole.log(a);`, 'f.ts');

    expect(objectPattern).toContain('({ a } = obj);'); // NOT "({ a: 1n } = obj);"
    expect(arrayPattern).toContain('[a] = arr;'); // NOT "[1n] = arr;"
  });

  it("still substitutes genuine READS nested inside a write-target expression: a property/element-access target's object expression and computed key", () => {
    const out = tsPartialEval(
      `const IDX = 0n;\nfunction main(obj, arr) {\n  obj.x = 1n;\n  arr[IDX] = 2n;\n  return arr[IDX];\n}`,
      'f.ts',
    );

    // `arr[IDX]`'s computed key IS a genuine read — substituted both as a write target's key
    // and in the later plain read.
    expect(out).toContain('arr[0n] = 2n;');
    expect(out).toContain('return arr[0n];');
    expect(out).not.toContain('IDX');
  });
});

// ── tsPartialEval (array/object lookup-table folding) ──
//
// A top-level `const NAME = [...]` / `const NAME = {...}` whose every element/property folds
// to a bigint (the SAME `tsEvalConst`/`consts` machinery the scalar consts above already use)
// AND whose every use anywhere in the file is a plain, unshadowed, non-write, non-call
// constant-indexed read (`NAME[k]`/`NAME.prop`/`NAME["prop"]`) is folded the same way a scalar
// const's read is — each resolvable access becomes its literal element/property value, and the
// now-fully-dead declaration is removed by the SAME dead-declaration-elimination pass. A SINGLE
// disqualifying use anywhere (reachable or not) rules out the WHOLE table — never partial
// folding of an otherwise-safe access elsewhere in the same table.
describe('tsPartialEval (array/object lookup-table folding)', () => {
  it('a const array with a constant-index read folds to its literal element, and the now-dead declaration is removed', () => {
    const out = tsPartialEval(`const FEES = [500n, 3000n, 10000n];\nconsole.log(FEES[1n]);`, 'f.ts');

    expect(out).not.toContain('const FEES');
    expect(out.trim()).toBe('console.log(3000n);');
  });

  it('a const object folds both a plain property read AND a computed-string-key read, declaration removed once dead', () => {
    const out = tsPartialEval(
      `const TIERS = { low: 10n, high: 200n };\nconsole.log(TIERS.low);\nconsole.log(TIERS["high"]);`,
      'f.ts',
    );

    expect(out).not.toContain('const TIERS');
    expect(out).toContain('console.log(10n);');
    expect(out).toContain('console.log(200n);');
  });

  it('a non-constant (parameter-derived) index is left untouched, and does NOT disqualify other, provably-resolvable accesses of the same array', () => {
    const out = tsPartialEval(
      `const FEES = [1n, 2n, 3n];\nfunction f(i) { return FEES[i]; }\nconsole.log(FEES[0n]);`,
      'f.ts',
    );

    expect(out).toContain('FEES[i]'); // non-constant — left untouched
    expect(out).toContain('console.log(1n);'); // the OTHER, resolvable access still folds
    expect(out).toContain('const FEES'); // still referenced by the unresolvable access — kept
  });

  it('an out-of-bounds constant index is left untouched, and does NOT disqualify an in-bounds access elsewhere', () => {
    const out = tsPartialEval(`const FEES = [1n, 2n];\nconsole.log(FEES[5n]);\nconsole.log(FEES[0n]);`, 'f.ts');

    expect(out).toContain('FEES[5n]'); // out of bounds — left untouched
    expect(out).toContain('console.log(1n);'); // the in-bounds access still folds
  });

  it('a negative constant index is left untouched (not a valid array index), and does not disqualify other accesses', () => {
    const out = tsPartialEval(`const FEES = [1n, 2n];\nconsole.log(FEES[-1n]);\nconsole.log(FEES[0n]);`, 'f.ts');

    expect(out).toContain('FEES[-1n]');
    expect(out).toContain('console.log(1n);');
  });

  it('an unresolvable computed-key read on an object table (non-string-literal key) is left untouched, and does not disqualify a resolvable read elsewhere', () => {
    const out = tsPartialEval(
      `const TIERS = { low: 10n };\nfunction f(k) { return TIERS[k]; }\nconsole.log(TIERS.low);`,
      'f.ts',
    );

    expect(out).toContain('TIERS[k]');
    expect(out).toContain('console.log(10n);');
  });

  it('a table whose only disqualifying use sits in an unreachable if(false) branch is still disqualified — the safety scan runs on the PRE-fold source, not reachability-aware', () => {
    const code = `const ARR = [1n, 2n];\nif (false) { ARR.push(1n); }\nconsole.log(ARR[0n]);`;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('const ARR = [1n, 2n];'); // never tracked — declaration survives
    expect(out).toContain('console.log(ARR[0n]);'); // NOT folded to 1n
    expect(out).not.toContain('ARR.push'); // the dead branch itself is still pruned by foldTransformer
  });

  describe('class/namespace/enum bodies are not silently skipped by the safety scan', () => {
    // `isOutOfScopeForPropagation` treats a whole class/enum/namespace as "safe, don't even
    // descend" — correct for the scalar-const propagation passes (you can't mutate a const
    // scalar's VALUE without illegally reassigning its binding, already a hard error) but NOT
    // for a tracked array/object table: a class method or namespace function can mutate the
    // table without ever reassigning the table's own binding. `checkTableSafety` must not reuse
    // that blanket skip. (These shapes are independently rejected by the real `compile()`
    // pipeline regardless — see the `compile()` sibling test below — but `tsPartialEval` is a
    // separately exported function, so the scan must fail closed on its own too.)
    it('a class method mutating a tracked array via .push() disqualifies the whole table', () => {
      const code = `
        const ARR = [1n, 2n, 3n];
        class Foo {
          mutate() {
            ARR.push(99n);
          }
        }
        console.log(ARR[0n]);
      `;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('const ARR = [1n, 2n, 3n];');
      expect(out).toContain('console.log(ARR[0n]);'); // NOT folded to 1n
    });

    it('a class method writing through an element access (NAME[k] = ...) disqualifies the whole table', () => {
      const code = `
        const ARR = [1n, 2n];
        class Foo {
          mutate() {
            ARR[0n] = 99n;
          }
        }
        console.log(ARR[0n]);
      `;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('const ARR = [1n, 2n];');
      expect(out).toContain('console.log(ARR[0n]);'); // NOT folded to 1n
    });

    it('a namespace function mutating a tracked array disqualifies the whole table the same way', () => {
      const code = `
        const ARR = [1n, 2n];
        namespace NS {
          export function mutate() {
            ARR[0n] = 99n;
          }
        }
        console.log(ARR[0n]);
      `;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('const ARR = [1n, 2n];');
      expect(out).toContain('console.log(ARR[0n]);'); // NOT folded to 1n
    });

    it('an enum member initializer referencing a tracked array disqualifies the whole table', () => {
      const code = `
        const ARR = [1n, 2n];
        enum E {
          A = ARR.length,
        }
        console.log(ARR[0n]);
      `;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('const ARR = [1n, 2n];');
      expect(out).toContain('console.log(ARR[0n]);'); // NOT folded to 1n
    });

    it('sanity check: a class elsewhere in the file that never references the tracked name at all does not disqualify it — this is a name-scoped guard, not "any class anywhere"', () => {
      const code = `
        const ARR = [1n, 2n];
        class Unrelated {
          method() {
            return 42n;
          }
        }
        console.log(ARR[0n]);
      `;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).not.toContain('const ARR');
      expect(out).toContain('console.log(1n);');
    });
  });

  describe('disqualification — any ONE use anywhere disqualifies the WHOLE table, even otherwise-safe accesses', () => {
    it('reassignment of the identifier disqualifies every access', () => {
      const code = `const ARR = [1n, 2n];\nARR = [3n];\nconsole.log(ARR[0n]);`;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('const ARR = [1n, 2n];');
      expect(out).toContain('ARR = [3n];');
      expect(out).toContain('console.log(ARR[0n]);'); // NOT folded to 1n
    });

    it('a method call on the identifier disqualifies every access, regardless of method name (no whitelist)', () => {
      const code = `const ARR = [1n, 2n];\nARR.push(3n);\nconsole.log(ARR[0n]);`;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('const ARR = [1n, 2n];');
      expect(out).toContain('ARR.push(3n);');
      expect(out).toContain('console.log(ARR[0n]);'); // NOT folded to 1n
    });

    it('an element-access used as an assignment target disqualifies every access, including OTHER indices', () => {
      const code = `const ARR = [1n, 2n];\nARR[0n] = 5n;\nconsole.log(ARR[1n]);`;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('const ARR = [1n, 2n];');
      expect(out).toContain('ARR[0n] = 5n;');
      expect(out).toContain('console.log(ARR[1n]);'); // NOT folded to 2n
    });

    it('passing the identifier as a bare call argument disqualifies every access', () => {
      const code = `const ARR = [1n, 2n];\nconsole.log(ARR);\nconsole.log(ARR[0n]);`;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('console.log(ARR);');
      expect(out).toContain('console.log(ARR[0n]);'); // NOT folded to 1n
    });

    it('aliasing the identifier to another variable disqualifies every access', () => {
      const code = `const ARR = [1n, 2n];\nlet other = ARR;\nconsole.log(ARR[0n]);`;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('let other = ARR;');
      expect(out).toContain('console.log(ARR[0n]);');
    });

    it('spreading the identifier disqualifies every access', () => {
      const code = `const ARR = [1n, 2n];\nfunction f(...args) { return 1n; }\nf(...ARR);\nconsole.log(ARR[0n]);`;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('f(...ARR);');
      expect(out).toContain('console.log(ARR[0n]);');
    });

    it('returning the identifier from a function disqualifies every access', () => {
      const code = `const ARR = [1n, 2n];\nfunction f() { return ARR; }\nconsole.log(ARR[0n]);`;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('return ARR;');
      expect(out).toContain('console.log(ARR[0n]);');
    });

    it('a property/element access reused as a destructuring-assignment target (nested inside the pattern) disqualifies every access', () => {
      // `({ x: ARR[0n] } = obj)` — TypeScript parses a destructuring-assignment pattern with the
      // SAME node kinds as an ordinary object-literal VALUE; only climbing up to the outermost
      // `=` tells them apart. ARR[0n] here is a WRITE target (obj.x's value lands in ARR[0]).
      const code = `const ARR = [1n, 2n];\nlet obj = { x: 5n };\n({ x: ARR[0n] } = obj);\nconsole.log(ARR[1n]);`;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('({ x: ARR[0n] } = obj);');
      expect(out).toContain('console.log(ARR[1n]);'); // NOT folded to 2n
    });

    it('a PARENTHESIZED update-expression target still disqualifies (an AST parent field points at the wrapping ParenthesizedExpression, not the access itself)', () => {
      const code = `const ARR = [1n, 2n];\n(ARR[0n])++;\nconsole.log(ARR[1n]);`;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('(ARR[0n])++;');
      expect(out).toContain('console.log(ARR[1n]);'); // NOT folded to 2n
    });

    it('a PARENTHESIZED call callee still disqualifies', () => {
      const code = `const ARR = [1n, 2n];\n(ARR[0n])();\nconsole.log(ARR[1n]);`;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('(ARR[0n])();');
      expect(out).toContain('console.log(ARR[1n]);'); // NOT folded to 2n
    });

    it('a PARENTHESIZED destructuring-assignment target nested inside the pattern still disqualifies', () => {
      const code = `const ARR = [1n, 2n];\nlet obj = { x: 5n };\n({ x: (ARR[0n]) } = obj);\nconsole.log(ARR[1n]);`;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('({ x: (ARR[0n]) } = obj);');
      expect(out).toContain('console.log(ARR[1n]);'); // NOT folded to 2n
    });
  });

  it('a same-named local array in an inner function scope is a DIFFERENT binding — shadowing keeps it from being confused with the outer tracked table', () => {
    const code = `
      const ARR = [1n, 2n];
      function f() {
        const ARR = [9n, 8n];
        ARR.push(1n); // disqualifies only the INNER (shadowed) ARR
        return ARR[0n];
      }
      console.log(ARR[0n]);
    `;
    const out = tsPartialEval(code, 'f.ts');

    // The inner, shadowed ARR (mutated via push) is left completely untouched.
    expect(out).toContain('const ARR = [9n, 8n];');
    expect(out).toContain('ARR.push(1n);');
    expect(out).toContain('return ARR[0n];');
    // The OUTER (unshadowed, never mutated) table's read still resolves...
    expect(out).toContain('console.log(1n);');
    // ...but its declaration is conservatively KEPT: dead-elimination is a flat, whole-file
    // textual Identifier count (not scope-aware — same documented behavior as the scalar-const
    // shadowing test above), and the inner shadowing declaration/uses of the same name "ARR"
    // are enough to (harmlessly) keep the outer `const ARR = [1n, 2n];` around even though its
    // one real (unshadowed) read was already inlined.
    expect(out).toContain('const ARR = [1n, 2n];');
  });

  it('a nested array/object literal ("a table of tables") is never a candidate — left completely untouched (explicitly out of scope)', () => {
    const code = `const TBL = [[1n, 2n], [3n, 4n]];\nconsole.log(TBL[0n]);`;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('const TBL = [[1n, 2n], [3n, 4n]];');
    expect(out).toContain('console.log(TBL[0n]);');
  });

  it('a spread element inside the literal itself is never a candidate — left completely untouched', () => {
    const code = `const other = [9n];\nconst ARR = [...other, 1n];\nconsole.log(ARR[1n]);`;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('const ARR = [...other, 1n];');
    expect(out).toContain('console.log(ARR[1n]);');
  });

  it('an object literal with shorthand/spread/computed properties is never a candidate — left completely untouched', () => {
    const code = `const k = 1n;\nconst OBJ = { k, ...{}, [1]: 2n };\nconsole.log(OBJ.k);`;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('console.log(OBJ.k);'); // not folded — OBJ was never a candidate
  });

  it('`new Array(n)` — a completely different, heap-allocated SauceScript concept — is never treated as a lookup table', () => {
    const code = `const arr = new Array(3n);\narr[0] = 1n;\nconsole.log(arr[0]);`;
    const out = tsPartialEval(code, 'f.ts');

    expect(out).toContain('new Array(3n)');
    expect(out).toContain('console.log(arr[0]);');
  });

  it('a resolved read used as an ordinary call argument (a derived SCALAR, not the array/object itself) is safe and still folds', () => {
    const out = tsPartialEval(
      `const FEES = [1n, 2n, 3n];\nfunction useFee(x) { return x; }\nconsole.log(useFee(FEES[0n]));`,
      'f.ts',
    );

    expect(out).not.toContain('const FEES');
    expect(out).toContain('console.log(useFee(1n));');
  });

  it('a table element/property may itself reference an earlier scalar top-level const', () => {
    const out = tsPartialEval(`const BASE = 100n;\nconst FEES = [BASE, BASE + 1n];\nconsole.log(FEES[1n]);`, 'f.ts');

    expect(out).not.toContain('const FEES');
    expect(out).toContain('console.log(101n);');
  });

  it('interacts correctly with loop-unrolling: a table indexed by an unrolled loop counter folds every iteration', () => {
    const out = tsPartialEval(
      `const FEES = [10n, 20n, 30n];\nlet sum = 0n;\nfor (let i = 0n; i < 3n; i++) { sum = sum + FEES[i]; }\nconsole.log(sum);`,
      'f.ts',
    );

    expect(out).not.toContain('for (');
    expect(out).not.toContain('const FEES');
    expect(out).toContain('sum = sum + 10n;');
    expect(out).toContain('sum = sum + 20n;');
    expect(out).toContain('sum = sum + 30n;');
  });

  // ── `for (const x of ARR) {...}` unrolling over a tracked ARRAY table (stretch goal) ──
  //
  // Reuses the exact same safety infrastructure as the numeric for/while unroller
  // (MAX_UNROLL_ITERATIONS, bodyBlocksUnrolling's break/continue/return/shadowing bail,
  // substituteCounter) adapted to iterate over the table's ELEMENTS instead of an arithmetic
  // sequence. Iterating an array table is itself always a safe, read-only use (its elements are
  // immutable bigints, no aliasing risk) — so `for...of` usage never disqualifies the table from
  // its OTHER index/property folding, independent of whether this specific loop shape is one the
  // unroller can actually expand.
  describe('for-of unrolling over a tracked array table (stretch goal)', () => {
    it('unrolls a basic for-of over a tracked array, substituting the loop variable with each literal element', () => {
      const out = tsPartialEval(
        `const FEES = [10n, 20n, 30n];\nlet sum = 0n;\nfor (const fee of FEES) { sum = sum + fee; }\nconsole.log(sum);`,
        'f.ts',
      );

      expect(out).not.toContain('for (');
      expect(out).not.toContain('const FEES');
      expect(out).toContain('sum = sum + 10n;');
      expect(out).toContain('sum = sum + 20n;');
      expect(out).toContain('sum = sum + 30n;');
    });

    it('bails (leaves the for-of as real runtime code, keeps the declaration) when the body contains break/continue/return', () => {
      for (const escape of ['break;', 'continue;', 'return sum;']) {
        const out = tsPartialEval(
          `function f() {\n  const FEES = [10n, 20n, 30n];\n  let sum = 0n;\n  for (const fee of FEES) { if (fee === 20n) { ${escape} } sum = sum + fee; }\n  return sum;\n}`,
          'f.ts',
        );

        expect(out).toContain('for (const fee of FEES)');
        expect(out).toContain('const FEES');
      }
    });

    it('bails (leaves the for-of as real runtime code) when the body shadows the loop variable name', () => {
      const out = tsPartialEval(
        `const FEES = [10n, 20n];\nlet sum = 0n;\nfor (const fee of FEES) { let fee = 99n; sum = sum + fee; }\nconsole.log(sum);`,
        'f.ts',
      );

      expect(out).toContain('for (const fee of FEES)');
      expect(out).toContain('const FEES');
    });

    it('a for-of iteration over a table does not disqualify its OTHER, independent index-access reads elsewhere', () => {
      const out = tsPartialEval(
        `const FEES = [10n, 20n];\nlet sum = 0n;\nfor (const fee of FEES) { sum = sum + fee; }\nconsole.log(FEES[0n]);\nconsole.log(sum);`,
        'f.ts',
      );

      expect(out).not.toContain('for (');
      expect(out).not.toContain('const FEES');
      expect(out).toContain('console.log(10n);'); // FEES[0n]
      expect(out).toContain('sum = sum + 10n;');
      expect(out).toContain('sum = sum + 20n;');
    });

    it('a destructured loop variable (`for (const [a] of ARR)`) is left un-unrolled — the table is still tracked (iteration alone is safe) but this loop shape is declined', () => {
      const code = `const PAIRS = [1n, 2n];\nfor (const [a] of PAIRS) {\n  console.log(a);\n}`;
      const out = tsPartialEval(code, 'f.ts');

      expect(out).toContain('for (const [a] of PAIRS)');
      expect(out).toContain('const PAIRS = [1n, 2n];');
    });

    it('declines to unroll a for-of whose table exceeds MAX_UNROLL_ITERATIONS (256), leaving the loop and declaration as real runtime code — the SAME cap the numeric for/while unroller reuses', () => {
      const elements = Array.from({ length: 257 }, (_, i) => `${i}n`).join(', ');
      const out = tsPartialEval(
        `const FEES = [${elements}];\nlet sum = 0n;\nfor (const fee of FEES) { sum = sum + fee; }\nconsole.log(sum);`,
        'f.ts',
      );

      expect(out).toContain('for (const fee of FEES)');
      expect(out).toContain('const FEES');
    });

    it('cascades: a for-of unrolled inside an already-unrolled numeric for loop fully resolves both to straight-line arithmetic', () => {
      const out = tsPartialEval(
        `const FEES = [1n, 2n];\nlet sum = 0n;\nfor (let i = 0n; i < 2n; i++) {\n  for (const fee of FEES) { sum = sum + fee + i; }\n}\nconsole.log(sum);`,
        'f.ts',
      );

      expect(out).not.toContain('for (');
      expect(out).not.toContain('const FEES');
      // i=0: fee=1,2 → "+ 1n + 0n", "+ 2n + 0n"; i=1: "+ 1n + 1n", "+ 2n + 1n"
      for (const [fee, i] of [
        [1, 0],
        [2, 0],
        [1, 1],
        [2, 1],
      ]) {
        expect(out).toContain(`sum + ${fee}n + ${i}n`);
      }
    });
  });
});

// ── compile() integration: the wiring (processor/index.ts import path + index.ts top-level) ──

let tmpDir: string;

function writeMod(name: string, code: string): void {
  fs.writeFileSync(path.join(tmpDir, name), code);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauce-ts-frontend-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const targets: CompileTarget[] = ['v1', 'v12'];

// A dead branch gated on a TYPED top-level const — the `: boolean` annotation is genuine
// TS-only syntax acorn cannot even PARSE unstripped, so this fixture can only compile at
// all via the built-in front-end (or an equivalent caller-supplied transform). Once
// stripped, `FLAG` is a bare identifier — the SAME shape acorn's own const-eval already
// folds — so this test's point isn't "acorn could never fold this", it's that stripping
// and folding happen correctly together, in the right order, before acorn ever runs.
function typedGateSource(): string {
  return `
    const FLAG: boolean = true;
    export function used() { return 1n; }
    export function unused() { return 999n; }
    export function gate() {
      if (FLAG) { return used(); } else { return unused(); }
    }
  `;
}

describe('ts-frontend compile() integration', () => {
  for (const target of targets) {
    describe(`target ${target}`, () => {
      it('a .sauce.ts import with typed params/return compiles', () => {
        writeMod('m_typed.sauce.ts', `export function addOne(n: bigint): bigint { return n + 1n; }`);
        const source = `
          import { addOne } from "./m_typed";
          function main() { return addOne(2n); }
        `;

        expect(() => compile(source, { baseDirs: [tmpDir], target })).not.toThrow();
      });

      it('a .sauce.ts import with a typed dead branch folds + treeshakes end to end', () => {
        writeMod('m_gate.sauce.ts', typedGateSource());
        const source = `
          import { gate } from "./m_gate";
          function main() { return gate(); }
        `;

        const result = compile(source, { baseDirs: [tmpDir], target }); // treeshake defaults true

        if (target === 'v1') {
          // main + gate — NOT unused (the dead else-branch, and its call, folded away
          // pre-acorn) — and NOT used either: `used()` is itself a zero-arg, single-`return`,
          // no-nested-call function, so it's vacuously call-foldable ("every argument is a
          // compile-time constant" holds trivially with zero arguments) — the call-folding
          // pass above inlines `used()` directly into `gate`'s own body, so treeshaking drops
          // `used` too, since nothing calls it anymore by the time acorn ever sees the module.
          expect(result.bytecode.length).toBe(2);
        }
      });

      it('a caller-supplied transformModule overriding the built-in strip breaks the same typed fixture', () => {
        writeMod('m_gate_override.sauce.ts', typedGateSource());
        const source = `
          import { gate } from "./m_gate_override";
          function main() { return gate(); }
        `;

        // An identity transform strips nothing — proves the override really replaces the
        // built-in (which is what made the previous test's typed source parseable at all).
        expect(() => compile(source, { baseDirs: [tmpDir], target, transformModule: (code) => code })).toThrow();
      });

      it('a runtime-derived condition in a .sauce.ts import fails closed (no throw, normal branch)', () => {
        writeMod(
          'm_runtime_cond.sauce.ts',
          `export function gate2(n: bigint): bigint {
             if (n === 1n) { return 10n; }
             return 20n;
           }`,
        );
        const source = `
          import { gate2 } from "./m_runtime_cond";
          function main() { return gate2(5n); }
        `;

        expect(() => compile(source, { baseDirs: [tmpDir], target })).not.toThrow();
      });

      it('a top-level const referenced only inside an imported helper function is baked into its body before the import boundary is crossed — the plain (no ts-frontend) equivalent fails', () => {
        // `collectImportedFunctions` (processor/index.ts) only ever pulls FUNCTION
        // declarations across a source-file import boundary — a module's top-level
        // `const`s are never carried over. So a `.sauce.ts` helper referencing a top-level
        // const can ONLY compile once imported elsewhere if this feature has already baked
        // the value into the function body (and dropped the now-dead declaration) BEFORE
        // that boundary is crossed — this is what actually makes requirement 4 necessary,
        // not just a cosmetic cleanup.
        writeMod('m_rate.sauce.ts', `const RATE = 3n;\nexport function scale(x: bigint): bigint { return x * RATE; }`);
        writeMod('m_rate_plain.sauce', `const RATE = 3n;\nexport function scale(x) { return x * RATE; }`);

        const tsImportSource = `
          import { scale } from "./m_rate";
          function main() { return scale(2n); }
        `;
        const plainImportSource = `
          import { scale } from "./m_rate_plain";
          function main() { return scale(2n); }
        `;

        const result = compile(tsImportSource, { baseDirs: [tmpDir], target });

        if (target === 'v1') {
          expect(result.bytecode.length).toBe(2); // main + scale — RATE was never a function to begin with
        }

        // The plain `.sauce` sibling never runs through ts-frontend at all (no `.ts` suffix),
        // so `scale`'s body still has a bare, now cross-file-unresolvable read of RATE.
        expect(() => compile(plainImportSource, { baseDirs: [tmpDir], target })).toThrow(/undefined variable/);
      });
    });
  }

  it('CompileOptions.tsSource propagates a typed top-level const chain into a bare read, producing bytecode byte-identical to the fully-inlined literal', () => {
    const source = `
      const a: bigint = 1n;
      const b: bigint = a + 3n;
      const c: bigint = b + 4n;
      function main() { return c; }
    `;

    const result = compile(source, { tsSource: true });
    const literal = compile(`function main() { return 8n; }`);

    expect(result.bytecode.length).toBe(1);
    expect(Array.from(result.bytecode[0])).toEqual(Array.from(literal.bytecode[0]));
  });

  it('CompileOptions.tsSource folds the same typed dead branch at the top level', () => {
    const source = typedGateSource().replace(/export /g, '') + `\nfunction main() { return gate(); }`;

    const result = compile(source, { tsSource: true }); // treeshake defaults true; default target v1

    // main + gate — `used()`'s call is ALSO folded away (a zero-arg, single-`return`,
    // no-nested-call function is vacuously call-foldable), so treeshaking drops it too, same
    // as `unused` — see the matching `.sauce.ts` import test above for the full explanation.
    expect(result.bytecode.length).toBe(2);
  });

  it('without tsSource, the identical (untyped) source needs no stripping and folds via acorn itself', () => {
    // Same logic, minus the TS-only type annotation (acorn can parse this directly): the
    // bare `FLAG` identifier condition folds via acorn's OWN const-eval either way — this
    // is the control case showing tsSource is only NEEDED when real TS syntax is present.
    const source =
      typedGateSource()
        .replace(/export /g, '')
        .replace(': boolean', '') + `\nfunction main() { return gate(); }`;

    const result = compile(source); // no tsSource, no baseDirs/import — plain acorn path
    expect(result.bytecode.length).toBe(3);
  });

  it('a countable loop with tsSource compiles to straight-line bytecode — no JUMP_BACK', () => {
    const source = `
      function main() {
        let sum = 0n;
        for (let i = 0n; i < 5n; i++) { sum = sum + i; }
        return sum;
      }
    `;

    const unrolled = compile(source, { tsSource: true });
    const runtime = compile(source); // plain acorn path — a real runtime loop, JUMP_BACK present

    expect(Array.from(runtime.bytecode[0])).toContain(OPS.JUMP_BACK);
    expect(Array.from(unrolled.bytecode[0])).not.toContain(OPS.JUMP_BACK);
  });

  it('CompileOptions.tsSource unrolls a for-of over a lookup table — a construct plain acorn cannot even PARSE, not just a bytecode-shape difference', () => {
    const source = `
      const FEES = [10n, 20n, 30n];
      function main() {
        let sum = 0n;
        for (const fee of FEES) { sum = sum + fee; }
        return sum;
      }
    `;

    // Unlike the typed-branch/countable-loop cases above, plain acorn doesn't merely compile
    // this LESS efficiently — it has no ForOfStatement handling at all, so it throws outright.
    // The ts-frontend fully eliminates the for-of (and the array literal it iterated) before
    // acorn ever sees this source, which is what makes it compilable at all.
    expect(() => compile(source)).toThrow(/ForOfStatement/);

    const result = compile(source, { tsSource: true });

    expect(result.bytecode.length).toBe(1);
    expect(Array.from(result.bytecode[0])).not.toContain(OPS.JUMP_BACK);
  });

  it('a for-of over a table exceeding MAX_UNROLL_ITERATIONS fails to compile even WITH tsSource — unlike the numeric for/while unroller (which falls back to real JUMP_BACK bytecode past its cap), a declined for-of has no runtime fallback at all: acorn cannot parse ForOfStatement, so this is a hard compile failure, not merely a less-optimal one', () => {
    const elements = Array.from({ length: 257 }, (_, i) => `${i}n`).join(', ');
    const source = `
      const FEES = [${elements}];
      function main() {
        let sum = 0n;
        for (const fee of FEES) { sum = sum + fee; }
        return sum;
      }
    `;

    expect(() => compile(source, { tsSource: true })).toThrow(/ForOfStatement/);
  });

  it('a countable while loop with tsSource compiles to straight-line bytecode — no JUMP_BACK', () => {
    const source = `
      function main() {
        let sum = 0n;
        let i = 0n;
        while (i < 5n) { sum = sum + i; i = i + 1n; }
        return sum;
      }
    `;

    const unrolled = compile(source, { tsSource: true });
    const runtime = compile(source); // plain acorn path — a real runtime loop, JUMP_BACK present

    expect(Array.from(runtime.bytecode[0])).toContain(OPS.JUMP_BACK);
    expect(Array.from(unrolled.bytecode[0])).not.toContain(OPS.JUMP_BACK);
  });

  it('CompileOptions.tsSource folds a lookup-table read to bytecode byte-identical to the fully-inlined literal', () => {
    const source = `
      const FEES: bigint[] = [500n, 3000n, 10000n];
      function main() { return FEES[1n]; }
    `;

    const result = compile(source, { tsSource: true });
    const literal = compile(`function main() { return 3000n; }`);

    expect(result.bytecode.length).toBe(1);
    expect(Array.from(result.bytecode[0])).toEqual(Array.from(literal.bytecode[0]));
  });
});
