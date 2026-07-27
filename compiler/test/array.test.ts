import { compile } from '../src/index.js';
import { OPS } from '../src/saucer/index.js';
import { encodeArray } from '../src/saucer/array.js';
import { encodeInt } from '../src/saucer/integer.js';

describe('array', () => {
  it('compiles integer array', () => {
    const result = compile('function main() { const arr = [1, 2, 3]; }');
    // ALLOCATE_HEAP, 1, WRITE_HEAP, 0, ARRAY, length(3), type(BYTE_1), 1, 2, 3
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_HEAP, 1, OPS.WRITE_HEAP, 0, OPS.ARRAY, 3, OPS.BYTE_1, 1, 2, 3]),
    );
  });

  it('compiles array with larger integers', () => {
    const result = compile('function main() { const arr = [256, 512]; }');
    // Uses BYTE_2 type since values > 255
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_HEAP, 1, OPS.WRITE_HEAP, 0, OPS.ARRAY, 2, OPS.BYTE_2, 1, 0, 2, 0]),
    );
  });

  it('compiles empty array', () => {
    const result = compile('function main() { const arr = []; }');
    // Empty array uses BYTE_1 as placeholder type
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_HEAP, 1, OPS.WRITE_HEAP, 0, OPS.ARRAY, 0, OPS.BYTE_1]),
    );
  });

  it('normalizes mixed byte widths', () => {
    const result = compile('function main() { const arr = [1, 256]; }');
    // Both values encoded as BYTE_2 (max width needed)
    // 1 = 0x00 0x01, 256 = 0x01 0x00
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_HEAP, 1, OPS.WRITE_HEAP, 0, OPS.ARRAY, 2, OPS.BYTE_2, 0, 1, 1, 0]),
    );
  });

  it('throws for sparse array', () => {
    expect(() => compile('function main() { const arr = [1, , 3]; }')).toThrow('sparse arrays are not supported');
  });

  it('throws for spread element', () => {
    expect(() => compile('function main() { const a = [1]; const arr = [...a]; }')).toThrow(
      'spread elements in arrays are not supported',
    );
  });

  it('throws for mixed static and dynamic elements', () => {
    // Can't mix static (numbers) with dynamic (strings) in the same array
    expect(() => compile('function main() { const arr = [1, "hello"]; }')).toThrow(
      'array elements must be literals or dynamic types',
    );
  });

  it('throws for expressions in array', () => {
    // Expressions that produce scalars are not supported in arrays
    expect(() => compile('function main() { const arr = [1 + 2]; }')).toThrow(
      'array elements must be literals or dynamic types',
    );
  });

  it('compiles large array with ARRAY_2', () => {
    const elements = Array.from({ length: 256 }, (_, i) => i % 256).join(', ');
    const result = compile(`function main() { const arr = [${elements}]; }`);
    // Should use ARRAY_2 (0x93) instead of ARRAY (0x92)
    expect(result.bytecode[0][4]).toBe(OPS.ARRAY_2);
    // Length is 256 = 0x0100 in big-endian
    expect(result.bytecode[0][5]).toBe(0x01);
    expect(result.bytecode[0][6]).toBe(0x00);
  });

  it('compiles array of strings', () => {
    const result = compile('function main() { const arr = ["hello", "world"]; }');
    // ALLOCATE_HEAP, 1, WRITE_HEAP, 0, ARRAY, 2, BYTES (element type), BYTES, 5, h,e,l,l,o, BYTES, 5, w,o,r,l,d
    expect(result.bytecode[0][4]).toBe(OPS.ARRAY);
    expect(result.bytecode[0][5]).toBe(2); // length
    expect(result.bytecode[0][6]).toBe(OPS.BYTES); // element type is BYTES (dynamic)
  });

  it('compiles 2D array', () => {
    const result = compile('function main() { const arr = [[1, 2], [3, 4]]; }');
    // ALLOCATE_HEAP, 1, WRITE_HEAP, 0, ARRAY, 2, ARRAY (element type), [inner arrays...]
    expect(result.bytecode[0][4]).toBe(OPS.ARRAY);
    expect(result.bytecode[0][5]).toBe(2); // length
    expect(result.bytecode[0][6]).toBe(OPS.ARRAY); // element type is ARRAY (dynamic)
  });

  it('compiles array of Uint8Array', () => {
    const result = compile('function main() { const arr = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]; }');
    expect(result.bytecode[0][4]).toBe(OPS.ARRAY);
    expect(result.bytecode[0][5]).toBe(2); // length
    expect(result.bytecode[0][6]).toBe(OPS.BYTES); // element type is BYTES (dynamic)
  });

  // `encodeArray`'s `forcedWidth` parameter — the width-forcing mechanism the ts-frontend's
  // `return arr;` return-escape fold (see ts-frontend.ts's "Forcing uint256 element width" doc
  // note) uses to make a synthesized literal array return real ABI-decodable `uint256[N]`
  // instead of the auto-narrowed encoding an ordinary array literal gets. `encodeArray` itself
  // has no notion of ts-frontend/main()/folds — these are pure encoder-level unit tests.
  describe('encodeArray forcedWidth', () => {
    const node = (value: bigint) => ({ _bytes: encodeInt(value) });

    it('omitted forcedWidth is unchanged — auto-narrows exactly like before', () => {
      const bytes = encodeArray([node(0n), node(2n), node(4n)]);

      expect(Array.from(bytes)).toEqual([OPS.ARRAY, 3, OPS.BYTE_1, 0, 2, 4]);
    });

    it('forcedWidth widens a narrower-than-forced encoding', () => {
      const bytes = encodeArray([node(0n), node(2n), node(4n)], 32);

      expect(bytes[0]).toBe(OPS.ARRAY);
      expect(bytes[1]).toBe(3); // length
      expect(bytes[2]).toBe(OPS.BYTE_32); // forced element-type byte
      expect(bytes.length).toBe(3 + 3 * 32); // header + 3 32-byte words
      // Each element is left-zero-padded to 32 bytes, e.g. element 0 (value 2) is
      // 31 zero bytes then 0x02.
      const word1 = bytes.slice(3 + 32, 3 + 64);
      expect(Array.from(word1)).toEqual([...Array(31).fill(0), 2]);
    });

    it("forcedWidth narrower than an element's OWN natural width never truncates it (Math.max floor)", () => {
      // A 32-byte-magnitude element already needs BYTE_32 on its own — forcing width 1 must not
      // shrink the encoding and silently corrupt the value.
      const big = (1n << 256n) - 1n; // 2^256 - 1, needs the full 32 bytes
      const bytes = encodeArray([node(big)], 1);

      expect(bytes[2]).toBe(OPS.BYTE_32);
      expect(bytes.length).toBe(3 + 32);
      expect(Array.from(bytes.slice(3))).toEqual(Array(32).fill(0xff));
    });

    it('forcedWidth on a dynamic-element array throws defensively (unreachable via any real caller today)', () => {
      const dynamicNode = { _bytes: new Uint8Array([OPS.BYTES, 1, 0xff]) };

      expect(() => encodeArray([dynamicNode], 32)).toThrow('forcedWidth is only supported');
    });
  });
});
