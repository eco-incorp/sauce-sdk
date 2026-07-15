/**
 * v12 execution parity: TypeScript-compiled v12 bytecode runs correctly on the
 * real engine-v12 Huff runtime — the strongest compiler↔engine guarantee.
 *
 * We generate v12 programs from BOTH the `V12Saucer` builder and the
 * `compile(src, { target: 'v12' })` transpiler, write them to
 * engine-v12/test/V12-execparity/vectors.json, then run `forge test
 * V12ExecParity.t.sol --ffi`, which deploys v12/Runtime.huff and executes every
 * program, asserting the decoded result. Where the bytecode parity test proves
 * "TS builder == Solidity builder", this proves "TS output actually evaluates
 * correctly on the runtime" — including the transpiler path with no Solidity twin.
 *
 * Requires a COMPLETE engine-v12 checkout (test/V12-execparity + lib/forge-std +
 * lib/foundry-huff-neo) plus Foundry and the huff-neo compiler `hnc`. The
 * published `sauce` dep ships a trimmed engine-v12, so by default this skips;
 * point SAUCE_ENGINE_V12 at a full checkout (e.g. ../sauce/engine-v12) to run.
 *
 * Array-mutation programs (arr[i] = x / SET_INDEX / new Array(n)) execute here too:
 * the harness is generic (decodes each vector's scalar result), so a builder vector
 * (newArray + setIndex + index) and transpiler vectors (new Array, literal set, get,
 * compound +=) run on the real runtime and prove the descriptor round-trips through
 * a heap-slot store/read — not just that the bytes are well-formed.
 */
import { execSync } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compile, V12Saucer } from '../src/index.js';
import { CompilerContext } from '../src/context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_V12 = process.env.SAUCE_ENGINE_V12 ?? join(__dirname, '../node_modules/sauce/engine-v12');
const HARNESS = join(ENGINE_V12, 'test/V12-execparity/V12ExecParity.t.sol');
const FORGE_STD = join(ENGINE_V12, 'lib/forge-std');
const HUFF_NEO = join(ENGINE_V12, 'lib/foundry-huff-neo');
const VECTORS_FILE = join(ENGINE_V12, 'test/V12-execparity/vectors.json');

const canRun = (): boolean => {
  try {
    execSync('forge --version', { stdio: 'pipe' });
    execSync('hnc --version', { stdio: 'pipe' }); // huff-neo compiler for Runtime.huff

    return existsSync(HARNESS) && existsSync(FORGE_STD) && existsSync(HUFF_NEO);
  } catch {
    return false;
  }
};

const describeIfForge = canRun() ? describe : describe.skip;

const ctx = () => new CompilerContext([], {}, 'v12');
const hex = (b: Uint8Array): string => '0x' + Buffer.from(b).toString('hex');
const S = (c: CompilerContext) => new V12Saucer(c);
const U = (c: CompilerContext, v: number) => S(c).int(BigInt(v));

interface Vector {
  name: string;
  bytecodeHex: string;
  expectedKind: 'uint' | 'bool' | 'revert';
  expectedUint: number;
}

// Programs built with the V12Saucer builder directly (local slot variables).
const builderVectors: {
  name: string;
  make: (c: CompilerContext) => Uint8Array;
  expected: number;
  kind: 'uint' | 'bool';
}[] = [
  {
    name: 'add',
    make: (c) =>
      S(c)
        .store('sum', S(c).add(U(c, 100), U(c, 50)))
        .read('sum')
        .build(),
    expected: 150,
    kind: 'uint',
  },
  {
    name: 'sub',
    make: (c) =>
      S(c)
        .store('d', S(c).sub(U(c, 100), U(c, 30)))
        .read('d')
        .build(),
    expected: 70,
    kind: 'uint',
  },
  {
    name: 'mul',
    make: (c) =>
      S(c)
        .store('p', S(c).mul(U(c, 12), U(c, 5)))
        .read('p')
        .build(),
    expected: 60,
    kind: 'uint',
  },
  {
    name: 'div',
    make: (c) =>
      S(c)
        .store('q', S(c).div(U(c, 100), U(c, 4)))
        .read('q')
        .build(),
    expected: 25,
    kind: 'uint',
  },
  {
    name: 'exp',
    make: (c) =>
      S(c)
        .store('power', S(c).exp(U(c, 2), U(c, 10)))
        .read('power')
        .build(),
    expected: 1024,
    kind: 'uint',
  },
  {
    name: 'gt',
    make: (c) =>
      S(c)
        .store('cmp', S(c).gt(U(c, 10), U(c, 3)))
        .read('cmp')
        .build(),
    expected: 1,
    kind: 'bool',
  },
  {
    name: 'bitand',
    make: (c) =>
      S(c)
        .store('x', S(c).bitAnd(U(c, 12), U(c, 10)))
        .read('x')
        .build(),
    expected: 8,
    kind: 'uint',
  },
  {
    name: 'shl',
    make: (c) =>
      S(c)
        .store('x', S(c).shl(U(c, 1), U(c, 4)))
        .read('x')
        .build(),
    expected: 16,
    kind: 'uint',
  },
  {
    name: 'ifelse_true',
    make: (c) => {
      const then_ = S(c).store('r', U(c, 100));
      const else_ = S(c).store('r', U(c, 200));

      return (
        S(c)
          .if(S(c).eq(U(c, 5), U(c, 5)))
          .then(then_)
          .else(else_) as V12Saucer
      )
        .read('r')
        .build();
    },
    expected: 100,
    kind: 'uint',
  },
  {
    name: 'storage_roundtrip',
    make: (c) =>
      S(c)
        .sstore(U(c, 7), U(c, 999))
        .store('v', S(c).sload(U(c, 7)))
        .read('v')
        .build(),
    expected: 999,
    kind: 'uint',
  },
  {
    name: 'memvar',
    make: (c) =>
      S(c)
        .store('a', U(c, 10))
        .store('b', U(c, 20))
        .store('s', S(c).add(S(c).read('a'), S(c).read('b')))
        .read('s')
        .build(),
    expected: 30,
    kind: 'uint',
  },
  {
    // a = new Array(3); a[1] = 77; return a[1] — exercises NEW_ARRAY + SET_INDEX
    // (in-place mutate, descriptor written back to the heap slot) + INDEX read.
    name: 'newarray_setindex',
    make: (c) =>
      S(c)
        .store('a', S(c).newArray(U(c, 3)))
        .store('a', S(c).setIndex(S(c).read('a'), U(c, 1), U(c, 77)))
        .store('r', S(c).index(S(c).read('a'), U(c, 1)))
        .read('r')
        .build(),
    expected: 77,
    kind: 'uint',
  },
];

// Programs produced by the transpiler — the path with no Solidity twin.
const transpilerVectors: { name: string; src: string; expected: number; kind: 'uint' | 'revert' }[] = [
  {
    name: 'func_call_params',
    src: 'function add(a, b){ return a + b } function main(){ return add(10, 20) }',
    expected: 30,
    kind: 'uint',
  },
  { name: 'compile_arith', src: 'function main(){ return 7 * 8 - 6 }', expected: 50, kind: 'uint' },
  {
    name: 'compile_if_else',
    src: 'function main(){ let r = 0; if (5 > 3) { r = 1 } else { r = 2 } return r }',
    expected: 1,
    kind: 'uint',
  },
  {
    name: 'nested_call',
    src: 'function f(x){ return x + 1 } function g(x){ return x * 2 } function main(){ return f(g(3)) }',
    expected: 7,
    kind: 'uint',
  },
  {
    name: 'two_helpers',
    src: 'function inc(x){ return x + 1 } function dbl(x){ return x * 2 } function main(){ return inc(3) + dbl(4) }',
    expected: 12,
    kind: 'uint',
  },
  {
    name: 'call_3args',
    src: 'function add3(a, b, c){ return a + b + c } function main(){ return add3(10, 20, 30) }',
    expected: 60,
    kind: 'uint',
  },
  { name: 'dynamic_length', src: 'function main(){ return "0xdeadbeef".length }', expected: 10, kind: 'uint' },
  { name: 'revert_explicit', src: 'function main(){ throw "0x00" }', expected: 0, kind: 'revert' },
  {
    name: 'while_simple',
    src: 'function main(){ let i = 0; while (i < 3) { i = i + 1 } return i }',
    expected: 3,
    kind: 'uint',
  },
  {
    name: 'while_sum',
    src: 'function main(){ let s = 0; let i = 0; while (i < 5) { s = s + i; i = i + 1 } return s }',
    expected: 10,
    kind: 'uint',
  },
  {
    name: 'for_sum',
    src: 'function main(){ let s = 0; for (let i = 0; i < 5; i = i + 1) { s = s + i } return s }',
    expected: 10,
    kind: 'uint',
  },
  // ── array mutation (NEW_ARRAY / SET_INDEX) — targets must be mutable (TUPLE) ──
  {
    name: 'new_array_zero_init',
    src: 'function main(){ let a = new Array(3); return a[1] }',
    expected: 0, // NEW_ARRAY zero-initializes every slot
    kind: 'uint',
  },
  {
    name: 'array_set_get',
    src: 'function main(){ let a = new Array(3); a[1] = 99; return a[1] }',
    expected: 99, // simple SET_INDEX into a freshly-allocated array, read back
    kind: 'uint',
  },
  {
    name: 'new_array_set_get',
    src: 'function main(){ let a = new Array(3); a[2] = 42; return a[2] }',
    expected: 42, // SET_INDEX at a different slot
    kind: 'uint',
  },
  {
    name: 'array_compound_assign',
    src: 'function main(){ let a = new Array(3); a[0] = 4; a[0] += 10; return a[0] }',
    expected: 14, // compound: INDEX read + ADD + SET_INDEX write
    kind: 'uint',
  },
  {
    name: 'object_field_set',
    src: 'function main(){ let p = { x: 5, y: 9 }; p.x = 42; return p.x }',
    expected: 42, // object literal is a TUPLE (mutable) → SET_INDEX by field index
    kind: 'uint',
  },
  {
    // A bare value-returning call must be SDROP'd or it leaks on the stack and
    // corrupts the fixed-position return — so a missing drop would make this return
    // 42 (or revert) instead of 7.
    name: 'unused_call_dropped',
    src: 'function noise(x){ return x + 1 } function main(){ noise(41); return 7 }',
    expected: 7,
    kind: 'uint',
  },
];

function buildVectors(): Vector[] {
  const out: Vector[] = [];
  for (const v of builderVectors) {
    out.push({ name: v.name, bytecodeHex: hex(v.make(ctx())), expectedKind: v.kind, expectedUint: v.expected });
  }
  for (const v of transpilerVectors) {
    const bc = compile(v.src, { target: 'v12' }).bytecode[0];
    out.push({ name: v.name, bytecodeHex: hex(bc), expectedKind: v.kind, expectedUint: v.expected });
  }

  return out;
}

describeIfForge('v12 execution parity (TS bytecode on the Huff runtime)', () => {
  let vectors: Vector[];
  let forgeOutput = '';
  let forgeOk = false;

  beforeAll(() => {
    vectors = buildVectors();
    writeFileSync(VECTORS_FILE, JSON.stringify({ count: vectors.length, vectors }, null, 2) + '\n');
    try {
      forgeOutput = execSync('forge test --match-path test/V12-execparity/V12ExecParity.t.sol --ffi -vv 2>&1', {
        cwd: ENGINE_V12,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
      });
      forgeOk = true;
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      forgeOutput = err.stdout ?? err.stderr ?? err.message ?? String(e);
      forgeOk = false;
    }
  }, 300_000);

  it('generates vectors across builder and transpiler paths', () => {
    const names = new Set(vectors.map((v) => v.name));
    expect(names.has('add')).toBe(true); // builder path
    expect(names.has('func_call_params')).toBe(true); // transpiler path
    expect(names.has('nested_call')).toBe(true); // multi-helper offset accumulation
    expect(names.has('revert_explicit')).toBe(true); // revert path
    expect(names.has('for_sum')).toBe(true); // loop back-jump arithmetic
    expect(names.has('newarray_setindex')).toBe(true); // builder array mutation
    expect(names.has('array_compound_assign')).toBe(true); // transpiler array mutation
    expect(vectors.length).toBeGreaterThanOrEqual(25);
  });

  it('all vectors execute on the Huff runtime with expected results', () => {
    if (!forgeOk) throw new Error(`forge execution-parity test failed:\n${forgeOutput}`);

    expect(forgeOutput).toMatch(/Suite result: ok\./);
    expect(forgeOutput).toMatch(/ok add /);
    expect(forgeOutput).toMatch(/ok\(revert\) revert_explicit/);
    expect(forgeOutput).toMatch(/ok newarray_setindex 77/); // builder array mutation
    expect(forgeOutput).toMatch(/ok array_compound_assign 14/); // transpiler compound +=
    expect(forgeOutput).toMatch(/ok object_field_set 42/); // object-literal (TUPLE) field set
    expect(forgeOutput).toMatch(/ok unused_call_dropped 7/); // bare call result SDROP'd, stack balanced
    expect(forgeOutput).not.toMatch(/\[FAIL/);
  });
});
