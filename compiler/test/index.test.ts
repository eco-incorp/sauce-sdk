import { compile } from '../src/index.js';
import { OPS } from '../src/saucer/index.js';

describe('index', () => {
  it('compiles array index with literal', () => {
    const result = compile('function main() { const arr = [1, 2, 3]; const x = arr[0]; }');
    // ALLOCATE_VALUE, 1 (for x),
    // ALLOCATE_HEAP, 1 (for arr),
    // WRITE_HEAP, 0, ARRAY, 3, BYTE_1, 1, 2, 3,
    // WRITE_VALUE, 0, INDEX, BYTE_1, 0, READ_HEAP, 0
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([
        OPS.ALLOCATE_VALUE,
        1,
        OPS.ALLOCATE_HEAP,
        1,
        OPS.WRITE_HEAP,
        0,
        OPS.ARRAY,
        3,
        OPS.BYTE_1,
        1,
        2,
        3,
        OPS.WRITE_VALUE,
        0,
        OPS.INDEX,
        OPS.BYTE_1,
        0,
        OPS.READ_HEAP,
        0,
      ]),
    );
  });

  it('compiles string index with literal', () => {
    const result = compile('function main() { const s = "abc"; const c = s[1]; }');
    // ALLOCATE_VALUE, 1 (for c),
    // ALLOCATE_HEAP, 1 (for s),
    // WRITE_HEAP, 0, BYTES, 3, a, b, c,
    // WRITE_VALUE, 0, INDEX, BYTE_1, 1, READ_HEAP, 0
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([
        OPS.ALLOCATE_VALUE,
        1,
        OPS.ALLOCATE_HEAP,
        1,
        OPS.WRITE_HEAP,
        0,
        OPS.BYTES,
        3,
        97,
        98,
        99,
        OPS.WRITE_VALUE,
        0,
        OPS.INDEX,
        OPS.BYTE_1,
        1,
        OPS.READ_HEAP,
        0,
      ]),
    );
  });

  it('compiles length property', () => {
    const result = compile('function main() { const arr = [1, 2, 3]; const len = arr.length; }');
    // ALLOCATE_VALUE, 1 (for len),
    // ALLOCATE_HEAP, 1 (for arr),
    // WRITE_HEAP, 0, ARRAY, 3, BYTE_1, 1, 2, 3,
    // WRITE_VALUE, 0, LENGTH, READ_HEAP, 0
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([
        OPS.ALLOCATE_VALUE,
        1,
        OPS.ALLOCATE_HEAP,
        1,
        OPS.WRITE_HEAP,
        0,
        OPS.ARRAY,
        3,
        OPS.BYTE_1,
        1,
        2,
        3,
        OPS.WRITE_VALUE,
        0,
        OPS.LENGTH,
        OPS.READ_HEAP,
        0,
      ]),
    );
  });

  it('throws for unsupported property access', () => {
    expect(() => compile('function main() { const obj = [1]; const x = obj.foo; }')).toThrow(
      "property 'foo' access not supported",
    );
  });

  it('compiles array index with variable', () => {
    const result = compile('function main() { const arr = [1, 2, 3]; let i = 1; const x = arr[i]; }');
    // Should contain INDEX followed by READ_VALUE (for i) and READ_HEAP (for arr)
    expect(result.bytecode[0]).toContain(OPS.INDEX);
    expect(result.bytecode[0]).toContain(OPS.READ_VALUE);
  });

  it('compiles array index with expression', () => {
    const result = compile('function main() { const arr = [1, 2, 3]; let i = 0; const x = arr[i + 1]; }');
    // Should contain INDEX followed by ADD operation
    expect(result.bytecode[0]).toContain(OPS.INDEX);
    expect(result.bytecode[0]).toContain(OPS.ADD);
  });

  it('compiles string length', () => {
    const result = compile('function main() { const s = "hello"; const len = s.length; }');
    expect(result.bytecode[0]).toContain(OPS.LENGTH);
  });

  it('compiles bytes length', () => {
    const result = compile('function main() { const b = new Uint8Array([1, 2, 3]); const len = b.length; }');
    expect(result.bytecode[0]).toContain(OPS.LENGTH);
  });
});

describe('array mutation (v1)', () => {
  it('compiles new Array(n) → NEW_ARRAY', () => {
    const result = compile('function main() { let a = new Array(3); return a; }');
    expect(result.bytecode[0]).toContain(OPS.NEW_ARRAY);
    expect(Buffer.from(result.bytecode[0]).toString('hex')).toBe('c001c1009c0103500000');
  });

  it('throws when new Array has wrong arity', () => {
    expect(() => compile('function main() { let a = new Array(1, 2); return a; }')).toThrow(
      'new Array expects exactly 1 argument',
    );
  });

  it('compiles arr[i] = x on a new Array → SET_INDEX, prefix [value][index][array]', () => {
    const result = compile('function main() { let a = new Array(3); a[0] = 9; return a; }');
    expect(result.bytecode[0]).toContain(OPS.SET_INDEX);
    expect(Buffer.from(result.bytecode[0]).toString('hex')).toBe('c001c1009c0103c1009b010901005000500000');
  });

  it('compiles obj.field = x → SET_INDEX with field index (object literal is a TUPLE)', () => {
    const result = compile('function main() { let p = { x: 1, y: 2 }; p.x = 9; return p; }');
    expect(result.bytecode[0]).toContain(OPS.SET_INDEX);
    expect(Buffer.from(result.bytecode[0]).toString('hex')).toBe('c201c300940201010102c3009b010901009800980000');
  });

  it('compiles compound arr[i] += y on a new Array → INDEX read then SET_INDEX write', () => {
    const result = compile('function main() { let a = new Array(3); let i = 1; a[i] += 5; return a; }');
    expect(result.bytecode[0]).toContain(OPS.SET_INDEX);
    expect(result.bytecode[0]).toContain(OPS.INDEX);
    expect(result.bytecode[0]).toContain(OPS.ADD);
  });

  it('rejects element assignment to an immutable packed array literal', () => {
    // A static packed array literal is immutable — the engine reverts SET_INDEX on
    // it, so the compiler rejects the assignment up front.
    expect(() => compile('function main() { let a = [1, 2, 3]; a[0] = 9; return a; }')).toThrow(
      /array literals are immutable/,
    );
  });

  it('evaluates a side-effecting compound index exactly once', () => {
    // `a[f()] += 5` feeds the index to both the INDEX read and the SET_INDEX write.
    // A non-pure index is hoisted into a scratch local, so f() (CALL_FUNCTION) is
    // emitted ONCE across all segments — 1, not 2 (f's own body has no call).
    const result = compile(
      'function f() { return 1; } function main() { let a = new Array(3); a[f()] += 5; return a[0]; }',
    );
    const calls = result.bytecode.reduce(
      (n, seg) => n + Array.from(seg).filter((b) => b === OPS.CALL_FUNCTION).length,
      0,
    );
    expect(calls).toBe(1);
  });
});
