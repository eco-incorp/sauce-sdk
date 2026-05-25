import { compile } from '../src/index.js';

describe('program', () => {
  it('compiles empty main function', () => {
    const result = compile('function main() {}');

    expect(result.bytecode[0]).toBeInstanceOf(Uint8Array);
    expect(result.bytecode[0].length).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it('throws on missing main function', () => {
    expect(() => compile('')).toThrow('missing main() function');
  });

  it('throws on top-level statements', () => {
    expect(() => compile('const x = 1;')).toThrow('top-level statements not allowed, use function main()');
  });
});
