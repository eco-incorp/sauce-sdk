import { compile } from '../src/index.js';
import { OPS } from '../src/saucer/index.js';

/**
 * Same-file user-function RETURN-kind inference (`processor/return-kind.ts` +
 * `inference.ts`'s `inferKindWithContext`): `let arr = helper();` — a PLAIN
 * (non-destructured) variable bound to a same-file function's call result — and plain
 * aliasing of an existing dynamic local (`let b = a;`, no call at all) must both infer
 * `dynamic` (HEAP) storage when the source is provably dynamic, exactly like a direct
 * `new Array(n)`/array-literal/object-literal initializer already does. Before this fix
 * both silently fell back to `scalar` (VALUE) storage, discarding the value's TUPLE/heap
 * descriptor — see CLAUDE.md's "Same-file user-function return-kind inference" note, and
 * integration-test/function-return-kind.test.ts for the real-EVM-execution proof (this
 * file only pins the compiled bytecode SHAPE).
 */
describe('return-kind inference: helper() return value stored in a variable', () => {
  it('infers dynamic (HEAP) storage for `let arr = helper();` when helper() returns a new Array(n)', () => {
    const result = compile(`
      function helper() {
        const arr = new Array(3);
        arr[0] = 1n;
        arr[1] = 2n;
        arr[2] = 3n;
        return arr;
      }
      function main() {
        let arr = helper();
        arr[0] = 42n;
        return arr[0] + arr[1] * 10n;
      }
    `);

    expect(Array.from(result.bytecode[0])).toEqual([
      OPS.ALLOCATE_HEAP,
      1,
      OPS.WRITE_HEAP,
      0, // const arr = new Array(3);
      OPS.NEW_ARRAY,
      OPS.BYTE_1,
      3,
      OPS.WRITE_HEAP,
      0, // arr[0] = 1n;
      OPS.SET_INDEX,
      OPS.BYTE_1,
      1,
      OPS.BYTE_1,
      0,
      OPS.READ_HEAP,
      0,
      OPS.WRITE_HEAP,
      0, // arr[1] = 2n;
      OPS.SET_INDEX,
      OPS.BYTE_1,
      2,
      OPS.BYTE_1,
      1,
      OPS.READ_HEAP,
      0,
      OPS.WRITE_HEAP,
      0, // arr[2] = 3n;
      OPS.SET_INDEX,
      OPS.BYTE_1,
      3,
      OPS.BYTE_1,
      2,
      OPS.READ_HEAP,
      0,
      OPS.READ_HEAP,
      0, // return arr;
      OPS.STOP,
    ]);

    // main(): `let arr = helper();` now round-trips through ALLOCATE_HEAP/WRITE_HEAP/
    // READ_HEAP end to end — no WRITE_VALUE/READ_VALUE for `arr` anywhere. Before this fix
    // this was `ALLOCATE_VALUE 1 / WRITE_VALUE 0 <- CALL_FUNCTION …` (scalar), which
    // discards the TUPLE descriptor and reverts SET_INDEX/INDEX at real execution.
    expect(Array.from(result.bytecode[1])).toEqual([
      OPS.ALLOCATE_HEAP,
      1,
      OPS.WRITE_HEAP,
      0, // let arr = helper();
      OPS.CALL_FUNCTION,
      0,
      0,
      OPS.WRITE_HEAP,
      0, // arr[0] = 42n;
      OPS.SET_INDEX,
      OPS.BYTE_1,
      42,
      OPS.BYTE_1,
      0,
      OPS.READ_HEAP,
      0,
      OPS.ADD,
      OPS.INDEX,
      OPS.BYTE_1,
      0,
      OPS.READ_HEAP,
      0, // arr[0]
      OPS.MUL,
      OPS.INDEX,
      OPS.BYTE_1,
      1,
      OPS.READ_HEAP,
      0, // arr[1]
      OPS.BYTE_1,
      10,
      OPS.STOP,
    ]);

    expect(result.bytecode[1]).not.toContain(OPS.WRITE_VALUE);
    expect(result.bytecode[1]).not.toContain(OPS.READ_VALUE);
  });

  it('infers dynamic for plain ALIASING of an existing dynamic local (`let b = a;`) — no function call at all', () => {
    const result = compile(`
      function main() {
        const a = new Array(3);
        a[0] = 7n;
        let b = a;
        b[1] = 9n;
        return b[1];
      }
    `);

    expect(Array.from(result.bytecode[0])).toEqual([
      OPS.ALLOCATE_HEAP,
      2,
      OPS.WRITE_HEAP,
      0, // const a = new Array(3);
      OPS.NEW_ARRAY,
      OPS.BYTE_1,
      3,
      OPS.WRITE_HEAP,
      0, // a[0] = 7n;
      OPS.SET_INDEX,
      OPS.BYTE_1,
      7,
      OPS.BYTE_1,
      0,
      OPS.READ_HEAP,
      0,
      OPS.WRITE_HEAP,
      1, // let b = a;   <- WRITE_HEAP, not WRITE_VALUE: this is the aliasing fix
      OPS.READ_HEAP,
      0,
      OPS.WRITE_HEAP,
      1, // b[1] = 9n;
      OPS.SET_INDEX,
      OPS.BYTE_1,
      9,
      OPS.BYTE_1,
      1,
      OPS.READ_HEAP,
      1,
      OPS.INDEX,
      OPS.BYTE_1,
      1,
      OPS.READ_HEAP,
      1, // return b[1];
      OPS.STOP,
    ]);
  });

  it('declaration order is irrelevant: the callee declared AFTER its caller compiles to the IDENTICAL bytecode', () => {
    const calleeFirst = compile(`
      function helper() {
        const arr = new Array(3);
        arr[0] = 1n;
        arr[1] = 2n;
        arr[2] = 3n;
        return arr;
      }
      function main() {
        let arr = helper();
        arr[0] = 42n;
        return arr[0] + arr[1] * 10n;
      }
    `);
    const callerFirst = compile(`
      function main() {
        let arr = helper();
        arr[0] = 42n;
        return arr[0] + arr[1] * 10n;
      }
      function helper() {
        const arr = new Array(3);
        arr[0] = 1n;
        arr[1] = 2n;
        arr[2] = 3n;
        return arr;
      }
    `);

    expect(callerFirst.bytecode.map((b) => Array.from(b))).toEqual(calleeFirst.bytecode.map((b) => Array.from(b)));
  });

  it('a 3-level forward-reference CHAIN (a calls b calls c; c is the only one directly dynamic) still infers dynamic all the way up', () => {
    // This is the shape that DISTINGUISHES the fixpoint pre-pass from a naive single
    // top-to-bottom pass: `a` depends on `b`'s kind, `b` depends on `c`'s kind, and only
    // `c` is directly dynamic — a single pass processing declarations in source order
    // (a, b, c) would see `b` and `c` still 'scalar' when it analyzes `a`. `d` is the
    // actual observable proof point: it stores `a()`'s result in a variable and mutates
    // an element, which only compiles to a HEAP round-trip if the WHOLE chain correctly
    // resolved to dynamic.
    const result = compile(`
      function a() { return b(); }
      function b() { return c(); }
      function c() { return new Array(2); }
      function d() {
        let z = a();
        z[0] = 5n;
        return z[0];
      }
      function main() { return d(); }
    `);

    const dIndex = 3; // declarations (minus main) in source order: a, b, c, d
    expect(Array.from(result.bytecode[dIndex])).toEqual(
      expect.arrayContaining([OPS.ALLOCATE_HEAP, OPS.WRITE_HEAP, OPS.READ_HEAP]),
    );
    expect(result.bytecode[dIndex]).not.toContain(OPS.WRITE_VALUE);
  });

  it('a mixed-return function (one path scalar, one path dynamic) is classified dynamic — the caller gets HEAP storage', () => {
    const result = compile(`
      function helper(cond) {
        if (cond === 1n) {
          const arr = new Array(2);
          arr[0] = 10n;
          arr[1] = 20n;
          return arr;
        }
        return 5n;
      }
      function main() {
        let x = helper(1n);
        x[0] = 99n;
        return x[0] + x[1];
      }
    `);

    expect(Array.from(result.bytecode[1])).toEqual([
      OPS.ALLOCATE_HEAP,
      1,
      OPS.WRITE_HEAP,
      0, // let x = helper(1n);
      OPS.CALL_FUNCTION,
      0,
      1,
      OPS.BYTE_1,
      1,
      OPS.WRITE_HEAP,
      0, // x[0] = 99n;
      OPS.SET_INDEX,
      OPS.BYTE_1,
      99,
      OPS.BYTE_1,
      0,
      OPS.READ_HEAP,
      0,
      OPS.ADD,
      OPS.INDEX,
      OPS.BYTE_1,
      0,
      OPS.READ_HEAP,
      0, // x[0]
      OPS.INDEX,
      OPS.BYTE_1,
      1,
      OPS.READ_HEAP,
      0, // x[1]
      OPS.STOP,
    ]);
  });

  it('NEGATIVE CONTROL: a scalar-returning helper compiles to byte-identical, unaffected (scalar/VALUE-slot) bytecode', () => {
    const result = compile(`
      function twice(x) { return x * 2n; }
      function main() { let v = twice(21n); return v + 1n; }
    `);

    expect(Array.from(result.bytecode[0])).toEqual([
      OPS.ALLOCATE_VALUE,
      1,
      OPS.MUL,
      OPS.READ_VALUE,
      0,
      OPS.BYTE_1,
      2,
      OPS.STOP,
    ]);
    expect(Array.from(result.bytecode[1])).toEqual([
      OPS.ALLOCATE_VALUE,
      1,
      OPS.WRITE_VALUE,
      0,
      OPS.CALL_FUNCTION,
      0,
      1,
      OPS.BYTE_1,
      21,
      OPS.ADD,
      OPS.READ_VALUE,
      0,
      OPS.BYTE_1,
      1,
      OPS.STOP,
    ]);
    expect(result.bytecode[1]).not.toContain(OPS.ALLOCATE_HEAP);
  });

  it('infers dynamic (HEAP) storage when a helper DESTRUCTURES a dynamic-typed ABI output and returns it bare', () => {
    // FINDING fix: analyzeFunctionReturnKinds's walkStatement VariableDeclaration case
    // previously only handled `declarator.id.type === 'Identifier'` — a `const [n, xs] =
    // Contract.method();` ArrayPattern declarator was silently skipped, so `xs` never
    // entered the pass's own `locals` map even though the REAL compiler
    // (processDestructuringDeclaration/abiOutputKind) correctly tracks `xs` as `dynamic`
    // for a `uint256[]` ABI output. `return xs;` then fell through kindOfExpr's
    // `locals.get(name) ?? 'scalar'` default, so `helper`'s registered return kind was
    // wrongly 'scalar' and `main()`'s `let arr = helper();` stored via WRITE_VALUE instead
    // of WRITE_HEAP — see integration-test/audit-return-kind.test.ts's "A7 FINDING" for the
    // real-EVM revert this caused before the fix (`panic: arithmetic underflow or overflow`).
    const contracts = {
      Pool: {
        abi: [
          {
            type: 'function',
            name: 'list',
            inputs: [],
            outputs: [
              { name: 'n', type: 'uint256' },
              { name: 'xs', type: 'uint256[]' },
            ],
            stateMutability: 'view',
          },
        ] as const,
      },
    };

    const result = compile(
      `
        function helper() {
          const [n, xs] = Pool.at(1).list();
          return xs;
        }
        function main() {
          let arr = helper();
          return arr[0];
        }
      `,
      { contracts: contracts as never },
    );

    const mainBytecode = result.bytecode[result.bytecode.length - 1];

    // Fixed: `arr` is now dynamic (HEAP) storage — no WRITE_VALUE/READ_VALUE for it at all.
    expect(mainBytecode).not.toContain(OPS.WRITE_VALUE);
    expect(Array.from(mainBytecode)).toEqual(
      expect.arrayContaining([OPS.ALLOCATE_HEAP, OPS.WRITE_HEAP, OPS.READ_HEAP]),
    );
  });

  it('a helper destructuring a SCALAR-only ABI output and returning it bare stays scalar (negative control)', () => {
    const contracts = {
      Pool: {
        abi: [
          {
            type: 'function',
            name: 'slot0',
            inputs: [],
            outputs: [
              { name: 'price', type: 'uint256' },
              { name: 'tick', type: 'uint256' },
            ],
            stateMutability: 'view',
          },
        ] as const,
      },
    };

    const result = compile(
      `
        function helper() {
          const [price, tick] = Pool.at(1).slot0();
          return tick;
        }
        function main() {
          let t = helper();
          return t + 1n;
        }
      `,
      { contracts: contracts as never },
    );

    const mainBytecode = result.bytecode[result.bytecode.length - 1];

    expect(mainBytecode).not.toContain(OPS.ALLOCATE_HEAP);
  });

  it('does not disturb the multiOutputCall guard: destructuring a multi-output call still works, and indexing a scalar-stored multi-output result still throws', () => {
    const contracts = {
      Pool: {
        abi: [
          {
            type: 'function',
            name: 'slot0',
            inputs: [],
            outputs: [
              { name: 'price', type: 'uint256' },
              { name: 'tick', type: 'uint256' },
            ],
            stateMutability: 'view',
          },
        ] as const,
      },
    };

    expect(() =>
      compile('function main() { const [price, tick] = Pool.at(1).slot0(); return price + tick; }', {
        contracts: contracts as never,
      }),
    ).not.toThrow();

    expect(() =>
      compile('function main() { const s = Pool.at(1).slot0(); return s[0]; }', { contracts: contracts as never }),
    ).toThrow(/multi-output call result stored in a variable/);
  });
});
