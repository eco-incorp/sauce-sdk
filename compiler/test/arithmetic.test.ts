import { compile } from '../src/index.js';
import { OPS } from '../src/saucer/index.js';

describe('arithmetic', () => {
  it('compiles addition', () => {
    const result = compile('function main() { const x = 1 + 2; }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.ADD, OPS.BYTE_1, 1, OPS.BYTE_1, 2]),
    );
  });

  it('compiles subtraction', () => {
    const result = compile('function main() { const x = 5 - 3; }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.SUB, OPS.BYTE_1, 5, OPS.BYTE_1, 3]),
    );
  });

  it('compiles multiplication', () => {
    const result = compile('function main() { const x = 3 * 4; }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.MUL, OPS.BYTE_1, 3, OPS.BYTE_1, 4]),
    );
  });

  it('compiles division', () => {
    const result = compile('function main() { const x = 10 / 2; }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.DIV, OPS.BYTE_1, 10, OPS.BYTE_1, 2]),
    );
  });

  it('compiles modulo', () => {
    const result = compile('function main() { const x = 10 % 3; }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.MOD, OPS.BYTE_1, 10, OPS.BYTE_1, 3]),
    );
  });

  it('compiles nested expressions', () => {
    const result = compile('function main() { const x = (1 + 2) * 3; }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([
        OPS.ALLOCATE_VALUE,
        1,
        OPS.WRITE_VALUE,
        0,
        OPS.MUL,
        OPS.ADD,
        OPS.BYTE_1,
        1,
        OPS.BYTE_1,
        2,
        OPS.BYTE_1,
        3,
      ]),
    );
  });

  it('compiles with variables', () => {
    const result = compile('function main() { const a = 5; const b = a + 3; }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([
        OPS.ALLOCATE_VALUE,
        2,
        OPS.WRITE_VALUE,
        0,
        OPS.BYTE_1,
        5,
        OPS.WRITE_VALUE,
        1,
        OPS.ADD,
        OPS.READ_VALUE,
        0,
        OPS.BYTE_1,
        3,
      ]),
    );
  });

  it('compiles exponentiation', () => {
    const result = compile('function main() { const x = 2 ** 8; }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.EXP, OPS.BYTE_1, 2, OPS.BYTE_1, 8]),
    );
  });

  it('compiles Math.sqrt', () => {
    const result = compile('function main() { const x = Math.sqrt(16); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([OPS.ALLOCATE_VALUE, 1, OPS.WRITE_VALUE, 0, OPS.SQRT, OPS.BYTE_1, 16]),
    );
  });

  it('compiles Math.sqrt with variable', () => {
    const result = compile('function main() { const a = 25; const b = Math.sqrt(a); }');
    expect(result.bytecode[0]).toEqual(
      new Uint8Array([
        OPS.ALLOCATE_VALUE,
        2,
        OPS.WRITE_VALUE,
        0,
        OPS.BYTE_1,
        25,
        OPS.WRITE_VALUE,
        1,
        OPS.SQRT,
        OPS.READ_VALUE,
        0,
      ]),
    );
  });

  it('throws on >>>', () => {
    expect(() => compile('function main() { const x = 1 >>> 2; }')).toThrow('use >> instead of >>>');
  });
});
