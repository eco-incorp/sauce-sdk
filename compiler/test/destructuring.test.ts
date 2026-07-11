import { compile } from '../src/index.js';
import { OPS } from '../src/saucer/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Array destructuring of multi-output contract-call returns:
//   const [price, tick] = pool.slot0();
// lowers to ONE external call whose RAW returndata lands in a hidden heap temp,
// with each bound element re-decoded at its store site — the decoded tuple is
// never stored in a variable (its descriptor does not survive a v1 round-trip).
// Shape B (`const s = pool.slot0()` + `s[k]`) keeps its store byte-identical,
// but the indexed reads — previously a guaranteed runtime
// SauceInvalidOperationArgs(INDEX) fault on v1 — are now compile errors that
// point at destructuring.
const poolAbi = [
  {
    type: 'function' as const,
    name: 'slot0',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
    stateMutability: 'view' as const,
  },
  {
    type: 'function' as const,
    name: 'getPair',
    inputs: [],
    outputs: [
      { name: 'a', type: 'uint256' },
      { name: 'b', type: 'uint256' },
    ],
    stateMutability: 'view' as const,
  },
  {
    type: 'function' as const,
    name: 'fee',
    inputs: [],
    outputs: [{ name: '', type: 'uint24' }],
    stateMutability: 'view' as const,
  },
  {
    type: 'function' as const,
    name: 'meta',
    inputs: [],
    outputs: [
      { name: 'n', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    stateMutability: 'view' as const,
  },
  {
    type: 'function' as const,
    name: 'list',
    inputs: [],
    outputs: [
      { name: 'n', type: 'uint256' },
      { name: 'xs', type: 'uint256[]' },
    ],
    stateMutability: 'view' as const,
  },
  {
    type: 'function' as const,
    name: 'wrap',
    inputs: [],
    outputs: [
      { name: 'nonce', type: 'uint256' },
      {
        name: 't',
        type: 'tuple',
        components: [
          { name: 'v', type: 'uint256' },
          { name: 'd', type: 'bytes' },
        ],
      },
    ],
    stateMutability: 'view' as const,
  },
  {
    type: 'function' as const,
    name: 'poke',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable' as const,
  },
  {
    type: 'function' as const,
    name: 'bump',
    inputs: [],
    outputs: [
      { name: 'counter', type: 'uint256' },
      { name: 'twice', type: 'uint256' },
    ],
    stateMutability: 'nonpayable' as const,
  },
  {
    type: 'function' as const,
    name: 'calc',
    inputs: [{ name: 'x', type: 'uint256' }],
    outputs: [
      { name: 'lo', type: 'uint256' },
      { name: 'hi', type: 'uint256' },
    ],
    stateMutability: 'view' as const,
  },
];

let tmpDir: string;
let baseDirs: string[];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauce-destructuring-'));
  fs.writeFileSync(path.join(tmpDir, 'Pool.json'), JSON.stringify({ abi: poolAbi }));
  baseDirs = [tmpDir];
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const IMPORT = 'import { Pool } from "./Pool.json";';

const count = (bytecode: Uint8Array, op: number): number => bytecode.filter((b) => b === op).length;

// Opcode-count DIFFERENTIALS between equivalent programs are robust against a
// selector byte colliding with an opcode value: both programs embed the same
// selectors, so collisions cancel.
describe('array destructuring — happy paths (v1)', () => {
  it('binds 2 of 7 outputs with a single external call', () => {
    const destructured = compile(
      `${IMPORT}
       function main() {
         const [price, tick] = Pool.at(1).slot0();
         return price + tick;
       }`,
      { baseDirs },
    ).bytecode[0];
    const doubleCall = compile(
      `${IMPORT}
       function main() {
         return Pool.at(1).slot0()[0] + Pool.at(1).slot0()[1];
       }`,
      { baseDirs },
    ).bytecode[0];

    // one STATIC instead of two
    expect(count(doubleCall, OPS.STATIC) - count(destructured, OPS.STATIC)).toBe(1);
    // raw returndata parked in a heap temp
    expect(count(destructured, OPS.WRITE_HEAP)).toBeGreaterThanOrEqual(1);
    // one re-decode per bound element
    expect(count(destructured, OPS.ABI_DECODE)).toBe(2);
  });

  it('binds all 7 outputs', () => {
    const { bytecode } = compile(
      `${IMPORT}
       function main() {
         const [a, b, c, d, e, f, g] = Pool.at(1).slot0();
         return a + b + c + d + e + f + g;
       }`,
      { baseDirs },
    );

    expect(count(bytecode[0], OPS.ABI_DECODE)).toBe(7);
  });

  it('supports holes and partial bindings', () => {
    const { bytecode } = compile(
      `${IMPORT}
       function main() {
         const [, tick] = Pool.at(1).slot0();
         return tick;
       }`,
      { baseDirs },
    );

    expect(count(bytecode[0], OPS.ABI_DECODE)).toBe(1);
  });

  it('destructures a single-output method', () => {
    expect(() =>
      compile(
        `${IMPORT}
         function main() {
           const [f] = Pool.at(1).fee();
           return f;
         }`,
        { baseDirs },
      ),
    ).not.toThrow();
  });

  it('evaluates a holes-only pattern for its side effects', () => {
    const { bytecode } = compile(
      `${IMPORT}
       function main() {
         const [,] = Pool.at(1).bump();
         return 0;
       }`,
      { baseDirs },
    );

    // nonpayable → CALL; emitted despite zero bindings
    expect(count(bytecode[0], OPS.CALL)).toBeGreaterThanOrEqual(1);
    expect(count(bytecode[0], OPS.ABI_DECODE)).toBe(0);
  });

  it('works with a variable-bound contract', () => {
    expect(() =>
      compile(
        `${IMPORT}
         function main() {
           const pool = Pool.at(1);
           const [a, b] = pool.getPair();
           return a + b;
         }`,
        { baseDirs },
      ),
    ).not.toThrow();
  });

  it('works with .view() bindings', () => {
    expect(() =>
      compile(
        `${IMPORT}
         function main() {
           const [a, b] = Pool.view(1).getPair();
           return a + b;
         }`,
        { baseDirs },
      ),
    ).not.toThrow();
  });

  it('allows a hole over a nested-tuple output', () => {
    expect(() =>
      compile(
        `${IMPORT}
         function main() {
           const [nonce] = Pool.at(1).wrap();
           return nonce;
         }`,
        { baseDirs },
      ),
    ).not.toThrow();
  });

  it('binds dynamic components (bytes, arrays) as heap values', () => {
    expect(() =>
      compile(
        `${IMPORT}
         function main() {
           const [n, data] = Pool.at(1).meta();
           const [m, xs] = Pool.at(1).list();
           return n + data.length + m + xs[0] + xs.length;
         }`,
        { baseDirs },
      ),
    ).not.toThrow();
  });

  it('compiles for v12 with the same one-call shape', () => {
    const destructured = compile(
      `${IMPORT}
       function main() {
         const [price, tick] = Pool.at(1).slot0();
         return price + tick;
       }`,
      { baseDirs, target: 'v12' },
    ).bytecode[0];
    const doubleCall = compile(
      `${IMPORT}
       function main() {
         return Pool.at(1).slot0()[0] + Pool.at(1).slot0()[1];
       }`,
      { baseDirs, target: 'v12' },
    ).bytecode[0];

    expect(count(doubleCall, OPS.STATIC) - count(destructured, OPS.STATIC)).toBe(1);
    expect(count(destructured, OPS.ABI_DECODE)).toBe(2);
  });

  it('keeps a helper reachable when treeshaking (init args are walked)', () => {
    expect(() =>
      compile(
        `${IMPORT}
         function helper() { return 3; }
         function main() {
           const [lo, hi] = Pool.at(1).calc(helper());
           return lo + hi;
         }`,
        { baseDirs, treeshake: true },
      ),
    ).not.toThrow();
  });
});

describe('array destructuring — rejected shapes', () => {
  const compileMain = (body: string, target?: 'v1' | 'v12' | 'svm') =>
    compile(`${IMPORT} function main() { ${body} }`, { baseDirs, target });

  it('rejects a non-call initializer', () => {
    expect(() => compileMain('const [a, b] = [1, 2]; return a;')).toThrow(
      /array destructuring requires a contract method call initializer/,
    );
  });

  it('rejects an identifier initializer', () => {
    expect(() => compileMain('const x = 1; const [a] = x; return a;')).toThrow(
      /array destructuring requires a contract method call initializer/,
    );
  });

  it('rejects a user-function initializer', () => {
    expect(() =>
      compile(`${IMPORT} function two() { return 2; } function main() { const [a] = two(); return a; }`, {
        baseDirs,
      }),
    ).toThrow(/array destructuring requires a contract method call initializer/);
  });

  it('rejects a .catch() chain initializer', () => {
    expect(() => compileMain('const [a, b] = Pool.at(1).getPair().catch(() => { return 0; }); return a;')).toThrow(
      /cannot destructure a \.catch\(\) chain/,
    );
  });

  it('rejects a zero-output method', () => {
    expect(() => compileMain('const [a] = Pool.at(1).poke(); return a;')).toThrow(
      /cannot destructure Pool\.poke\(\): it returns no outputs/,
    );
  });

  it('rejects more elements than outputs', () => {
    expect(() => compileMain('const [a, b, c] = Pool.at(1).getPair(); return a;')).toThrow(
      /cannot destructure 2 output\(s\) of Pool\.getPair\(\) into 3 element\(s\)/,
    );
  });

  it('rejects rest elements', () => {
    expect(() => compileMain('const [a, ...rest] = Pool.at(1).slot0(); return a;')).toThrow(
      /not implemented: rest element in array destructuring/,
    );
  });

  it('rejects nested patterns', () => {
    expect(() => compileMain('const [a, [b]] = Pool.at(1).getPair(); return a;')).toThrow(
      /not implemented: ArrayPattern in array destructuring/,
    );
  });

  it('rejects binding a nested-tuple output', () => {
    expect(() => compileMain('const [nonce, t] = Pool.at(1).wrap(); return nonce;')).toThrow(
      /a nested tuple cannot be stored in a variable/,
    );
  });

  it('reports an unknown method by name', () => {
    expect(() => compileMain('const [a] = Pool.at(1).nope(); return a;')).toThrow(
      /Unknown method "nope" on contract "Pool"/,
    );
  });

  it('rejects duplicate names in the pattern (acorn parse error)', () => {
    expect(() => compileMain('const [a, a] = Pool.at(1).getPair(); return a;')).toThrow(/already been declared/);
  });

  it('still rejects object patterns', () => {
    expect(() => compileMain('const { a } = Pool.at(1).getPair(); return a;')).toThrow(
      /not implemented: ObjectPattern/,
    );
  });

  it('errors cleanly on target svm (no typed bindings there)', () => {
    expect(() => compileMain('const [a, b] = Pool.at(1).getPair(); return a;', 'svm')).toThrow(
      /contract bindings are not supported on target 'svm'/,
    );
  });
});

// Shape B (`const s = pool.slot0()` + `s[k]`) previously compiled on v1 and then
// faulted at runtime with SauceInvalidOperationArgs(INDEX) — the decoded tuple's
// descriptor does not survive the variable round-trip. The STORE (and bare reads
// of the variable — shipping protocol functions like arrakis/pendle `return` the
// stored result directly) keep compiling byte-identically; only the reads that
// were guaranteed runtime faults become compile errors pointing at destructuring.
describe('shape B — multi-output call result stored in a variable (v1 guard)', () => {
  const compileMain = (body: string, target?: 'v1' | 'v12') =>
    compile(`${IMPORT} function main() { ${body} }`, { baseDirs, target });

  it('rejects an indexed read (was a guaranteed runtime INDEX fault)', () => {
    expect(() => compileMain('const s = Pool.at(1).slot0(); return s[0] + s[6];')).toThrow(
      /cannot index 's'.*destructure the call instead/,
    );
  });

  it('rejects a computed indexed read', () => {
    expect(() =>
      compileMain(
        'const s = Pool.at(1).slot0(); let sum = 0; for (let i = 0; i < 3; i++) { sum += s[i]; } return sum;',
      ),
    ).toThrow(/cannot index 's'/);
  });

  it('rejects element assignment', () => {
    expect(() => compileMain('const s = Pool.at(1).slot0(); s[0] = 1; return 0;')).toThrow(
      /cannot assign to a component of 's'/,
    );
  });

  it('rejects compound element assignment', () => {
    expect(() => compileMain('const s = Pool.at(1).slot0(); s[0] += 1; return 0;')).toThrow(
      /cannot assign to a component of 's'/,
    );
  });

  it('keeps bare reads compiling (arrakis/pendle `return result` shape)', () => {
    expect(() => compileMain('const s = Pool.at(1).getPair(); return s;')).not.toThrow();
  });

  it('keeps the variable-bound protocol shape compiling', () => {
    expect(() => compileMain('const pool = Pool.at(1); const result = pool.getPair(); return result;')).not.toThrow();
  });

  it('clears the tag on reassignment (indexing works again)', () => {
    expect(() => compileMain('let s = Pool.at(1).slot0(); s = [1, 2, 3]; return s[0];')).not.toThrow();
  });

  it('re-tags on reassignment with another multi-output call', () => {
    expect(() => compileMain('let s = [1, 2]; s = Pool.at(1).slot0(); return s[0];')).toThrow(/cannot index 's'/);
  });

  it('leaves single-output call stores untouched (indexing stays legal)', () => {
    expect(() => compileMain('const f = Pool.at(1).fee(); return f;')).not.toThrow();
  });

  it('leaves inline chained indexing untouched (shape A)', () => {
    expect(() => compileMain('return Pool.at(1).slot0()[0] + Pool.at(1).wrap()[1][0];')).not.toThrow();
  });

  it('keeps the v12 lowering fully unchanged (stores AND indexed reads work)', () => {
    const v12 = compileMain('const s = Pool.at(1).slot0(); return s[0] + s[6];', 'v12').bytecode[0];

    // v12 decodes ONCE at the call site — the stored tuple survives its
    // round-trip there, so no guard applies.
    expect(count(v12, OPS.ABI_DECODE)).toBe(1);
  });
});
