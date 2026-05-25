import { compile } from '../src/index.js';
import { OPS } from '../src/saucer/index.js';

describe('struct', () => {
  it('compiles simple struct', () => {
    const result = compile('function main() { const s = { a: 1, b: 2 }; }');
    // ALLOCATE_HEAP, 1, WRITE_HEAP, 0, TUPLE, 2, BYTE_1, 1, BYTE_1, 2
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_HEAP, 1, OPS.WRITE_HEAP, 0, OPS.TUPLE, 2, OPS.BYTE_1, 1, OPS.BYTE_1, 2]),
    );
  });

  it('compiles struct with alphabetical ordering', () => {
    // { b: 2, a: 1 } should produce same bytecode as { a: 1, b: 2 }
    const result = compile('function main() { const s = { b: 2, a: 1 }; }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_HEAP, 1, OPS.WRITE_HEAP, 0, OPS.TUPLE, 2, OPS.BYTE_1, 1, OPS.BYTE_1, 2]),
    );
  });

  it('compiles struct with mixed types', () => {
    const result = compile('function main() { const s = { a: 1, b: "hi" }; }');
    // TUPLE with number and string: BYTE_1, 1, BYTES, 2, 'h', 'i'
    const bytes = result.bytecode[0];
    expect(bytes[4]).toBe(OPS.TUPLE);
    expect(bytes[5]).toBe(2); // 2 elements
    expect(bytes[6]).toBe(OPS.BYTE_1);
    expect(bytes[7]).toBe(1); // value 1
    expect(bytes[8]).toBe(OPS.BYTES);
    expect(bytes[9]).toBe(2); // length 2
    expect(bytes[10]).toBe(104); // 'h'
    expect(bytes[11]).toBe(105); // 'i'
  });

  it('compiles struct with shorthand syntax', () => {
    // { a } should be equivalent to { a: a }
    const result = compile('function main() { const a = 5; const s = { a }; }');
    // Should contain TUPLE with 1 element that reads variable a
    const bytes = result.bytecode[0];
    expect(bytes).toContain(OPS.TUPLE);
    expect(bytes).toContain(OPS.READ_VALUE); // reads variable a
  });

  it('compiles field access with first field', () => {
    const result = compile('function main() { const s = { a: 1, b: 2 }; const x = s.a; }');
    // Field access: INDEX, BYTE_1, 0 (field index), READ_HEAP, 0
    expect(result.bytecode[0]).toContain(OPS.INDEX);
  });

  it('compiles field access with second field', () => {
    const result = compile('function main() { const s = { a: 1, b: 2 }; const x = s.b; }');
    // Field 'b' is index 1 (alphabetical order)
    expect(result.bytecode[0]).toContain(OPS.INDEX);
  });

  it('compiles field access respecting alphabetical order', () => {
    // In { z: 1, a: 2 }, field 'a' is index 0 and 'z' is index 1
    const result = compile('function main() { const s = { z: 1, a: 2 }; const x = s.z; }');
    expect(result.bytecode[0]).toContain(OPS.INDEX);
    // z is at index 1 after sorting
  });

  it('throws for unknown field access', () => {
    expect(() => compile('function main() { const s = { a: 1 }; const x = s.foo; }')).toThrow("unknown field 'foo'");
  });

  it('compiles array of structs', () => {
    const result = compile('function main() { const arr = [{ a: 1 }, { a: 2 }]; }');
    // ARRAY, 2, TUPLE (element type), TUPLE, 1, BYTE_1, 1, TUPLE, 1, BYTE_1, 2
    const bytes = result.bytecode[0];
    expect(bytes[4]).toBe(OPS.ARRAY);
    expect(bytes[5]).toBe(2); // 2 elements
    expect(bytes[6]).toBe(OPS.TUPLE); // element type
  });

  it('compiles nested struct', () => {
    const result = compile('function main() { const s = { outer: { inner: 1 } }; }');
    expect(result.bytecode[0]).toContain(OPS.TUPLE);
  });

  it('compiles nested struct field access with WRITE_HEAP', () => {
    const result = compile(`function main() {
      const s = { outer: { inner: 99 } };
      const inner = s.outer;
    }`);
    // inner should be stored with WRITE_HEAP (dynamic), not WRITE_VALUE (scalar)
    // because s.outer is a nested struct (TUPLE), not a scalar
    const bytes = Array.from(result.bytecode[0]);
    const writeHeapCount = bytes.filter((b) => b === OPS.WRITE_HEAP).length;
    expect(writeHeapCount).toEqual(2); // s + inner
  });

  it('compiles empty struct', () => {
    const result = compile('function main() { const s = {}; }');
    // Empty tuple: TUPLE, 0
    const bytes = result.bytecode[0];
    expect(bytes).toContain(OPS.TUPLE);
    expect(bytes[5]).toBe(0); // 0 elements
  });

  it('throws for spread properties', () => {
    expect(() => compile('function main() { const a = { x: 1 }; const b = { ...a }; }')).toThrow(
      'spread properties are not supported',
    );
  });

  it('throws for array with mismatched struct fields', () => {
    expect(() => compile('function main() { const arr = [{ a: 1 }, { b: 2 }]; }')).toThrow(
      'array elements must have consistent struct fields',
    );
  });

  it('allows array with consistent struct fields', () => {
    // Should not throw - all elements have same field 'a'
    expect(() => compile('function main() { const arr = [{ a: 1 }, { a: 2 }, { a: 3 }]; }')).not.toThrow();
  });
});
