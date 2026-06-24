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
import { compile, V12Saucer, OPS_V12 } from '../src/index.js';
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
const helperCases: { name: string; src: string; hex: string }[] = [
  {
    name: 'single-arg helper + call',
    src: 'function inc(n){ return n + 1n } function main(){ return inc(5n) }',
    hex: '010599000801f200d1010121f3',
  },
  {
    name: 'two-arg helper + call',
    src: 'function add(a, b){ return a + b } function main(){ return add(3n, 7n) }',
    hex: '0103010799000a02f200d2d221f3',
  },
  {
    name: 'two helpers + nested call',
    src: 'function inc(n){ return n + 1n } function dbl(n){ return n * 2n } function main(){ return inc(dbl(5n)) }',
    hex: '01059900110199000c01f200d1010121f3d1010223f3',
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
  });

  describe('Array mutation (SET_INDEX / NEW_ARRAY)', () => {
    // Captured v12 (postfix) bytecode — the full program assembly (slot
    // allocation, store, return MSTORE) is validated end-to-end by the engine
    // integration suites; here we pin the lowering to SET_INDEX/NEW_ARRAY chains.
    const arrayCases: { name: string; src: string; hex: string }[] = [
      {
        name: 'new Array(n) → [count][NEW_ARRAY]',
        src: 'function main(){ let a = new Array(3); return a }',
        hex: '01039cc3009800',
      },
      {
        name: 'arr[i] = x → SET_INDEX, postfix [value][index][array]',
        src: 'function main(){ let a = [1, 2, 3]; a[0] = 9; return a }',
        hex: '920301010203c3000109010098009bc3009800',
      },
      {
        name: 'obj.field = x → SET_INDEX with field-index UINT',
        src: 'function main(){ let p = { x: 1, y: 2 }; p.x = 9; return p }',
        hex: '010201019402c3000109010098009bc3009800',
      },
      {
        name: 'compound arr[i] += y → INDEX read + SET_INDEX write',
        src: 'function main(){ let a = [1, 2, 3]; let i = 1; a[i] += 5; return a }',
        hex: '920301010203c3000101c1005000980097010521500098009bc3009800',
      },
    ];

    for (const c of arrayCases) {
      it(c.name, () => {
        expect(compileV12(c.src)).toBe(c.hex);
      });
    }
  });

  describe('Documented v12 boundaries', () => {
    it('break is not supported in v12', () => {
      expect(() => compileV12('function main(){ while (1) { break } }')).toThrow(/break.*v12/);
    });
  });
});
