/**
 * Transpiler → v12 target: `compile(src, { target: 'v12' })`.
 *
 * Mirrors the strategy of the v1 transpiler tests: compile a SauceScript snippet
 * and assert the emitted v12 (postfix/stack) bytecode is byte-identical to an
 * equivalent hand-built `V12Saucer` chain. Both sides go through the same emitter,
 * so this pins the transpiler's lowering decisions (operand order, MSTORE
 * insertion, scalar-vs-dynamic tracking, slot-vs-stack variable access) rather
 * than hard-coding hex.
 *
 * SauceScript here is the LOCAL surface (namespaced `storage.write`, `msg.sender`,
 * `crypto.keccak256`, `contract.call`, `Math.*`), not the prototype's uppercase
 * builtins — so signed/CAST ops (no local surface) are covered by the builder unit
 * suite (saucer-v12.test.ts) instead. Multi-function (helper) cases assert against
 * captured hex (the cross-function assembly is validated end-to-end by the engine
 * execution + Solidity-parity integration suites).
 */
import { compile, V12Saucer, OPS, OPS_V12 } from '../src/index.js';
import { CompilerContext } from '../src/context.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const v12ctx = () => new CompilerContext([], {}, 'v12');
const mk = (c: CompilerContext) => new V12Saucer(c);
const compileV12 = (src: string): string => hex(compile(src, { target: 'v12' }).bytecode[0]);

interface Case {
  name: string;
  src: string;
  ref: (c: CompilerContext) => V12Saucer;
}

const cases: Record<string, Case[]> = {
  Literals: [
    { name: 'number literal', src: 'function main(){ return 42 }', ref: (c) => mk(c).int(42n) },
    { name: 'bigint literal', src: 'function main(){ return 1000000n }', ref: (c) => mk(c).int(1000000n) },
    { name: 'boolean true → 1', src: 'function main(){ return true }', ref: (c) => mk(c).int(1n) },
    { name: 'boolean false → 0', src: 'function main(){ return false }', ref: (c) => mk(c).int(0n) },
    { name: 'string (UTF-8 bytes)', src: 'function main(){ return "0xbeef" }', ref: (c) => mk(c).string('0xbeef') },
  ],

  Context: [
    { name: 'msg.sender', src: 'function main(){ return msg.sender }', ref: (c) => mk(c).msgSender() },
    { name: 'block.timestamp', src: 'function main(){ return block.timestamp }', ref: (c) => mk(c).blockTimestamp() },
    { name: 'block.chainId', src: 'function main(){ return block.chainId }', ref: (c) => mk(c).blockChainId() },
    { name: 'address.self', src: 'function main(){ return address.self }', ref: (c) => mk(c).addressSelf() },
    { name: 'gasLeft()', src: 'function main(){ return gasLeft() }', ref: (c) => mk(c).gasLeft() },
    {
      name: 'address.balanceOf(self)',
      src: 'function main(){ return address.balanceOf(address.self) }',
      ref: (c) => mk(c).balanceOf(mk(c).addressSelf()),
    },
  ],

  Arithmetic: [
    { name: 'add', src: 'function main(){ return 5 + 3 }', ref: (c) => mk(c).add(mk(c).int(5n), mk(c).int(3n)) },
    { name: 'sub (swap)', src: 'function main(){ return 5 - 3 }', ref: (c) => mk(c).sub(mk(c).int(5n), mk(c).int(3n)) },
    { name: 'mul', src: 'function main(){ return 7 * 8 }', ref: (c) => mk(c).mul(mk(c).int(7n), mk(c).int(8n)) },
    {
      name: 'div (swap)',
      src: 'function main(){ return 10 / 2 }',
      ref: (c) => mk(c).div(mk(c).int(10n), mk(c).int(2n)),
    },
    {
      name: 'mod (swap)',
      src: 'function main(){ return 10 % 3 }',
      ref: (c) => mk(c).mod(mk(c).int(10n), mk(c).int(3n)),
    },
    {
      name: 'exp (swap)',
      src: 'function main(){ return 2 ** 10 }',
      ref: (c) => mk(c).exp(mk(c).int(2n), mk(c).int(10n)),
    },
    { name: 'Math.sqrt', src: 'function main(){ return Math.sqrt(16) }', ref: (c) => mk(c).sqrt(mk(c).int(16n)) },
    {
      name: 'Math.mulDiv',
      src: 'function main(){ return Math.mulDiv(10, 20, 5) }',
      ref: (c) => mk(c).mulDiv(mk(c).int(10n), mk(c).int(20n), mk(c).int(5n)),
    },
    { name: 'Math.neg', src: 'function main(){ return Math.neg(5) }', ref: (c) => mk(c).neg(mk(c).int(5n)) },
    {
      name: 'nested (a+b)*(c-d)',
      src: 'function main(){ return (1 + 2) * (5 - 3) }',
      ref: (c) => mk(c).mul(mk(c).add(mk(c).int(1n), mk(c).int(2n)), mk(c).sub(mk(c).int(5n), mk(c).int(3n))),
    },
  ],

  Comparison: [
    { name: 'eq', src: 'function main(){ return 1 === 2 }', ref: (c) => mk(c).eq(mk(c).int(1n), mk(c).int(2n)) },
    { name: 'neq', src: 'function main(){ return 1 !== 2 }', ref: (c) => mk(c).neq(mk(c).int(1n), mk(c).int(2n)) },
    { name: 'lt (swap)', src: 'function main(){ return 1 < 9 }', ref: (c) => mk(c).lt(mk(c).int(1n), mk(c).int(9n)) },
    { name: 'gt (swap)', src: 'function main(){ return 5 > 3 }', ref: (c) => mk(c).gt(mk(c).int(5n), mk(c).int(3n)) },
    {
      name: 'lte (swap)',
      src: 'function main(){ return 1 <= 9 }',
      ref: (c) => mk(c).lte(mk(c).int(1n), mk(c).int(9n)),
    },
    {
      name: 'gte (swap)',
      src: 'function main(){ return 5 >= 3 }',
      ref: (c) => mk(c).gte(mk(c).int(5n), mk(c).int(3n)),
    },
  ],

  Bitwise: [
    {
      name: 'and',
      src: 'function main(){ return 255 & 15 }',
      ref: (c) => mk(c).bitAnd(mk(c).int(255n), mk(c).int(15n)),
    },
    { name: 'or', src: 'function main(){ return 255 | 15 }', ref: (c) => mk(c).bitOr(mk(c).int(255n), mk(c).int(15n)) },
    {
      name: 'xor',
      src: 'function main(){ return 255 ^ 15 }',
      ref: (c) => mk(c).bitXor(mk(c).int(255n), mk(c).int(15n)),
    },
    { name: 'not (~)', src: 'function main(){ return ~5 }', ref: (c) => mk(c).bitNot(mk(c).int(5n)) },
    { name: 'shl', src: 'function main(){ return 1 << 4 }', ref: (c) => mk(c).shl(mk(c).int(1n), mk(c).int(4n)) },
    { name: 'shr', src: 'function main(){ return 256 >> 4 }', ref: (c) => mk(c).shr(mk(c).int(256n), mk(c).int(4n)) },
  ],

  Logical: [
    {
      name: 'and (&&)',
      src: 'function main(){ return true && false }',
      ref: (c) => mk(c).and(mk(c).int(1n), mk(c).int(0n)),
    },
    {
      name: 'or (||)',
      src: 'function main(){ return true || false }',
      ref: (c) => mk(c).or(mk(c).int(1n), mk(c).int(0n)),
    },
    { name: 'not (!)', src: 'function main(){ return !true }', ref: (c) => mk(c).not(mk(c).int(1n)) },
  ],

  Storage: [
    {
      name: 'storage.write',
      src: 'function main(){ storage.write(0, 42) }',
      ref: (c) => mk(c).sstore(mk(c).int(0n), mk(c).int(42n)),
    },
    { name: 'storage.read', src: 'function main(){ return storage.read(0) }', ref: (c) => mk(c).sload(mk(c).int(0n)) },
    {
      name: 'storage.tWrite',
      src: 'function main(){ storage.tWrite(1, 99) }',
      ref: (c) => mk(c).tstore(mk(c).int(1n), mk(c).int(99n)),
    },
    {
      name: 'storage.tRead',
      src: 'function main(){ return storage.tRead(1) }',
      ref: (c) => mk(c).tload(mk(c).int(1n)),
    },
  ],

  Memory: [
    {
      name: 'local const scalar',
      src: 'function main(){ const x = 42; return x }',
      ref: (c) => mk(c).store('x', mk(c).int(42n)).read('x'),
    },
    {
      name: 'local let scalar',
      src: 'function main(){ let x = 42; return x }',
      ref: (c) => mk(c).store('x', mk(c).int(42n)).read('x'),
    },
  ],

  DynamicData: [
    {
      name: 'crypto.keccak256',
      src: 'function main(){ return crypto.keccak256("0xbeef") }',
      ref: (c) => mk(c).keccak256(mk(c).string('0xbeef')),
    },
    {
      name: 'abi.encode(obj)',
      src: 'function main(){ return abi.encode({ a: 1, b: 2 }) }',
      ref: (c) => mk(c).abiEncode(mk(c).tuple([mk(c).int(1n), mk(c).int(2n)])),
    },
    {
      name: 'array literal',
      src: 'function main(){ return [1, 2, 3] }',
      ref: (c) => mk(c).array([mk(c).int(1n), mk(c).int(2n), mk(c).int(3n)]),
    },
    {
      name: 'object literal → tuple',
      src: 'function main(){ const o = { a: 1, b: 2 }; return o }',
      ref: (c) =>
        mk(c)
          .store('o', mk(c).tuple([mk(c).int(1n), mk(c).int(2n)]))
          .read('o'),
    },
  ],

  ControlFlow: [
    {
      name: 'if/else statement',
      src: 'function main(){ if (1 > 0) { storage.write(0, 1) } else { storage.write(0, 2) } }',
      ref: (c) =>
        mk(c)
          .if(mk(c).gt(mk(c).int(1n), mk(c).int(0n)))
          .then(mk(c).sstore(mk(c).int(0n), mk(c).int(1n)))
          .else(mk(c).sstore(mk(c).int(0n), mk(c).int(2n))) as V12Saucer,
    },
    {
      name: 'throw (revert)',
      src: 'function main(){ throw "0x00" }',
      ref: (c) => mk(c).revert(mk(c).string('0x00')),
    },
  ],
};

// Param-mains: main params live on the stack; replicate compile()'s main-ref
// SDUP patching (realPos = depth + paramCount - paramIndex, no frame offset).
interface ParamCase {
  name: string;
  src: string;
  params: string[];
  ref: (c: CompilerContext) => V12Saucer;
}

const paramCases: ParamCase[] = [
  {
    name: 'scalar param a + 1',
    src: 'function main(a){ return a + 1 }',
    params: ['a'],
    ref: (c) => mk(c).add(mk(c).read('a'), mk(c).int(1n)),
  },
  {
    name: 'two params a + b',
    src: 'function main(a, b){ return a + b }',
    params: ['a', 'b'],
    ref: (c) => mk(c).add(mk(c).read('a'), mk(c).read('b')),
  },
  {
    name: 'address.isContract(param)',
    src: 'function main(a){ return address.isContract(a) }',
    params: ['a'],
    ref: (c) => mk(c).isContract(mk(c).read('a')),
  },
  {
    name: 'crypto.ecdsaVerify(params)',
    src: 'function main(s, h, sig){ return crypto.ecdsaVerify(s, h, sig) }',
    params: ['s', 'h', 'sig'],
    ref: (c) => mk(c).ecdsaVerify(mk(c).read('s'), mk(c).read('h'), mk(c).read('sig')),
  },
  {
    name: 'contract.call(param, 0, data)',
    src: 'function main(target){ return contract.call(target, 0, "data") }',
    params: ['target'],
    ref: (c) => mk(c).externalCall(mk(c).read('target'), mk(c).int(0n), mk(c).string('data')),
  },
];

// Multi-function cases — captured hex (assembly validated by the integration suites).
// A helper `return` now self-terminates with FUNC_RETURN (0xf3) so an EARLY return
// inside a conditional exits instead of leaking its value and falling through; the
// assembly's trailing per-helper FUNC_RETURN follows as (dead, unreachable) code.
// (In the two-helper case the inc body's extra 0xf3 also shifts dbl's CALL_FUNCTION
// jump offset 0x0011→0x0012.)
const helperCases: { name: string; src: string; hex: string }[] = [
  {
    name: 'single-arg helper + call',
    src: 'function inc(n){ return n + 1n } function main(){ return inc(5n) }',
    hex: '010599000801f200d1010121f3f3',
  },
  {
    name: 'two-arg helper + call',
    src: 'function add(a, b){ return a + b } function main(){ return add(3n, 7n) }',
    hex: '0103010799000a02f200d2d221f3f3',
  },
  {
    name: 'two helpers + nested call',
    src: 'function inc(n){ return n + 1n } function dbl(n){ return n * 2n } function main(){ return inc(dbl(5n)) }',
    hex: '01059900120199000c01f200d1010121f3f3d1010223f3f3',
  },
];

describe("Transpiler — v12 target (compile(src, { target: 'v12' }))", () => {
  for (const [category, list] of Object.entries(cases)) {
    describe(category, () => {
      for (const c of list) {
        it(c.name, () => {
          expect(compileV12(c.src)).toBe(hex(c.ref(v12ctx()).build()));
        });
      }
    });
  }

  describe('Param mains (stack params)', () => {
    for (const c of paramCases) {
      it(c.name, () => {
        const ctx = v12ctx();
        for (const n of c.params) {
          ctx.setVar(n, 'scalar', undefined, undefined, true);
          ctx.pushStack(n);
        }
        const m = c.ref(ctx);
        const bc = new Uint8Array(m.build());
        // Patch main REF sentinels (no frame-pointer offset), as assembleV12 does.
        for (const ref of m.refPositions) {
          bc[ref.position] = OPS_V12.SDUP1 + (ref.depth + c.params.length - ref.paramIndex) - 1;
        }
        expect(compileV12(c.src)).toBe(hex(bc));
      });
    }
  });

  describe('Functions (multi-function assembly)', () => {
    for (const c of helperCases) {
      it(c.name, () => {
        expect(compileV12(c.src)).toBe(c.hex);
      });
    }

    it('early return inside a helper emits its own FUNC_RETURN (no stack leak)', () => {
      // A helper with an EARLY return inside an `if` must terminate that path with
      // FUNC_RETURN (0xf3) — otherwise the value is left on the stack and execution
      // falls through into the rest of the body, leaking a stack item per call (a
      // loop of such calls → EVM "out of stack" on the v12 runtime). Both the early
      // and the tail return self-terminate, so the body carries TWO 0xf3 returns
      // (plus the assembly's trailing dead one). main is INLINED — it must NOT emit a
      // helper FUNC_RETURN, so its body has no 0xf3.
      const src =
        'function clamp(x){ if (x > 10n) { return 10n } return x } function main(){ return clamp(5n) }';
      const bc = compileV12(src);
      const funcReturns = (bc.match(/f3/g) ?? []).length;
      // 2 in-body returns (early + tail) + 1 trailing assembly FUNC_RETURN = 3.
      expect(funcReturns).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Array mutation (SET_INDEX / NEW_ARRAY)', () => {
    // Captured v12 (postfix) bytecode — the full program assembly (slot allocation,
    // store, return MSTORE) is validated end-to-end by the engine integration
    // suites; here we pin the lowering to SET_INDEX/NEW_ARRAY chains. Element
    // assignment targets a MUTABLE collection (new Array → TUPLE, or an object
    // literal → TUPLE); static packed array literals are immutable (see the guard
    // test below) so they are not valid targets.
    const arrayCases: { name: string; src: string; hex: string }[] = [
      {
        name: 'new Array(n) → [count][NEW_ARRAY]',
        src: 'function main(){ let a = new Array(3); return a }',
        hex: '01039cc3009800',
      },
      {
        name: 'arr[i] = x on new Array → SET_INDEX, postfix [value][index][array]',
        src: 'function main(){ let a = new Array(3); a[1] = 9; return a }',
        hex: '01039cc3000109010198009bc3009800',
      },
      {
        name: 'obj.field = x → SET_INDEX with field-index UINT (object literal is a TUPLE)',
        src: 'function main(){ let p = { x: 1, y: 2 }; p.x = 9; return p }',
        hex: '010201019402c3000109010098009bc3009800',
      },
      {
        name: 'compound arr[i] += y on new Array → INDEX read + SET_INDEX write',
        src: 'function main(){ let a = new Array(3); let i = 1; a[i] += 5; return a }',
        hex: '01039cc3000101c1005000980097010521500098009bc3009800',
      },
    ];

    for (const c of arrayCases) {
      it(c.name, () => {
        expect(compileV12(c.src)).toBe(c.hex);
      });
    }

    it('compound with a side-effecting index evaluates it exactly once', () => {
      // `a[f()] += 5`: the index feeds both the INDEX read and the SET_INDEX write.
      // A non-pure index is hoisted into a scratch local, so f() (CALL_FUNCTION) is
      // emitted ONCE — not duplicated into both subtrees. f()'s own body has no call.
      const bc = compile('function f(){ return 1 } function main(){ let a = new Array(3); a[f()] += 5; return a[0] }', {
        target: 'v12',
      }).bytecode[0];
      const calls = bc.filter((b) => b === OPS.CALL_FUNCTION).length;
      expect(calls).toBe(1);
    });

    it('rejects element assignment to an immutable packed array literal', () => {
      // `[1, 2, 3]` packs to a static array the engine reverts SET_INDEX on; reject
      // it at compile time and point at the mutable `new Array(n)` path.
      expect(() => compileV12('function main(){ let a = [1, 2, 3]; a[0] = 9; return a }')).toThrow(
        /array literals are immutable/,
      );
    });
  });

  describe('Statement-context stack hygiene', () => {
    it('drops a bare value-returning call result, but not when it is consumed', () => {
      // `noise(1);` as a statement returns a value that v12 must SDROP, or it leaks
      // on the stack. `noise` SETs no params, so the only SDROP source is the drop —
      // present when the result is discarded, absent when bound to a local.
      const dropped = compile('function noise(x){ return x } function main(){ noise(1); return 0 }', {
        target: 'v12',
      }).bytecode[0];
      const used = compile('function noise(x){ return x } function main(){ let y = noise(1); return y }', {
        target: 'v12',
      }).bytecode[0];

      expect(Array.from(dropped)).toContain(OPS_V12.SDROP);
      expect(Array.from(used)).not.toContain(OPS_V12.SDROP);
    });

    it('throws when main() is called (recursion into the entrypoint is unsupported)', () => {
      expect(() => compileV12('function main(){ return main() }')).toThrow(/main\(\) is not supported/);
    });
  });

  describe('Documented v12 boundaries', () => {
    it('break is not supported in v12', () => {
      expect(() => compileV12('function main(){ while (1) { break } }')).toThrow(/break.*v12/);
    });
  });

  // ── compile-time args: the no-param arg-prologue entry ──────────────────────
  // The runtime entry pushes only a stack-bottom sentinel; it does not marshal
  // main()'s params. So compile(src, { args }) synthesizes a PROLOGUE that pushes
  // the args (postfix) and falls through into main's inlined body, which reads its
  // params with the MAIN SDUP formula (no call-frame word). These tests pin the
  // structure + range; engine execution (returning the arg) is covered by the
  // dev-tools v12 EVM suite.
  describe('compile-time args (v12 arg-prologue)', () => {
    const v12 = (src: string, args: (bigint | bigint[])[]) =>
      Array.from(compile(src, { target: 'v12', args }).bytecode[0]);

    it('with no args, main is the entry — no prologue prepended (unchanged)', () => {
      // A trivial no-arg program is just `[push 1][MSTORE]` — the same bytes the
      // builder emits, with NO leading arg pushes.
      const noArgs = v12('function main(){ return 1 }', []);
      expect(noArgs).toEqual([OPS.BYTE_1, 1, OPS_V12.MSTORE]);
    });

    it('prepends an arg-push prologue and reads params with SDUP (no frame word)', () => {
      // `main(x){ return x }` with arg [42]: prologue pushes 42, then main reads it.
      // paramCount 1, paramIndex 0, depth 0 → MAIN formula SDUP1. Result MSTORE'd,
      // then STOP. (No CALL_FUNCTION — main is inlined behind the prologue.)
      const bc = v12('function main(x){ return x }', [42n]);
      expect(bc).toEqual([OPS.BYTE_1, 42, OPS_V12.SDUP1, OPS_V12.MSTORE, OPS.STOP]);
    });

    it('pushes multiple args forward (arg0 deepest) so SDUP picks the right param', () => {
      // `main(x,y){ return y }` [3,4]: prologue pushes 3 then 4 (y on top). y is
      // paramIndex 1 → MAIN formula SDUP1 (top). The deepest param (x) would be SDUP2.
      const bc = v12('function main(x,y){ return y }', [3n, 4n]);
      expect(bc).toEqual([OPS.BYTE_1, 3, OPS.BYTE_1, 4, OPS_V12.SDUP1, OPS_V12.MSTORE, OPS.STOP]);
    });

    it('builds a TUPLE arg on the stack (postfix: elements then TUPLE)', () => {
      // `main(t){ return t[1] }` [[5,9,2]]: prologue builds the tuple, then INDEX 1.
      // The arg push is the v12 tuple encoding (elements reversed by the builder,
      // then [TUPLE, 3]); leading bytes must be the tuple, last meaningful op INDEX.
      const bc = v12('function main(t){ return t[1] }', [[5n, 9n, 2n]]);
      // contains a TUPLE of 3 and an INDEX, and ends MSTORE + STOP.
      expect(bc).toContain(OPS.TUPLE);
      expect(bc[bc.indexOf(OPS.TUPLE) + 1]).toBe(3); // tuple length
      expect(bc).toContain(OPS.INDEX);
      expect(bc.slice(-2)).toEqual([OPS_V12.MSTORE, OPS.STOP]);
    });

    it('a deep multi-param main stays within the SDUP1-16 ceiling (no +1 frame word)', () => {
      // 9 params with a param read under several live locals would hit SDUP17 if main
      // were CALL_FUNCTION'd (the helper-frame +1 word) — past the EVM DUP16 limit, so
      // patchSdup would throw `REF position out of range: 17`. The fall-through prologue
      // (no frame word) keeps the deepest read at ≤16, so this must compile clean.
      const src =
        'function main(a,b,c,d,e,f,g,h,i){' +
        ' const l1=a+b; const l2=c+d; const l3=e+f; const l4=g+h; const l5=l1+l2; const l6=l3+l4;' +
        ' return a + i + l5 + l6; }';
      const args = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n];
      expect(() => compile(src, { target: 'v12', args })).not.toThrow();
    });
  });
});
