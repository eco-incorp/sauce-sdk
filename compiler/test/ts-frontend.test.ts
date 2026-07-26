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
    const out = tsPartialEval(`const y = 2 + 3;`, 'f.ts');

    expect(out).toContain('const y = 5');
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
          // main + gate + used — NOT unused: the dead else-branch (and its call) was
          // folded away before acorn ever parsed the module.
          expect(result.bytecode.length).toBe(3);
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
    });
  }

  it('CompileOptions.tsSource folds the same typed dead branch at the top level', () => {
    const source = typedGateSource().replace(/export /g, '') + `\nfunction main() { return gate(); }`;

    const result = compile(source, { tsSource: true }); // treeshake defaults true; default target v1

    expect(result.bytecode.length).toBe(3); // main + gate + used — unused folded away pre-acorn
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
});
