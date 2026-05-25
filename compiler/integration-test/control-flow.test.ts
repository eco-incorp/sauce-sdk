import { cook } from './utils.js';

describe('integration: control-flow', () => {
  it('if: true branch assigns', () => {
    expect(BigInt(cook('function main() { let x = 0; if (1 === 1) { x = 5; } return x; }'))).toBe(5n);
  });

  it('if: false branch skips', () => {
    expect(BigInt(cook('function main() { let x = 99; if (1 === 2) { x = 0; } return x; }'))).toBe(99n);
  });

  it('if-else: true branch', () => {
    expect(BigInt(cook('function main() { let x = 0; if (1 === 1) { x = 5; } else { x = 10; } return x; }'))).toBe(5n);
  });

  it('if-else: false branch', () => {
    expect(BigInt(cook('function main() { let x = 0; if (1 === 2) { x = 5; } else { x = 10; } return x; }'))).toBe(10n);
  });

  it('else-if chain: first match', () => {
    expect(
      BigInt(
        cook(
          'function main() { let x = 0; let a = 1; if (a === 1) { x = 10; } else if (a === 2) { x = 20; } else { x = 30; } return x; }',
        ),
      ),
    ).toBe(10n);
  });

  it('else-if chain: second match', () => {
    expect(
      BigInt(
        cook(
          'function main() { let x = 0; let a = 2; if (a === 1) { x = 10; } else if (a === 2) { x = 20; } else { x = 30; } return x; }',
        ),
      ),
    ).toBe(20n);
  });

  it('else-if chain: else fallthrough', () => {
    expect(
      BigInt(
        cook(
          'function main() { let x = 0; let a = 99; if (a === 1) { x = 10; } else if (a === 2) { x = 20; } else { x = 30; } return x; }',
        ),
      ),
    ).toBe(30n);
  });

  it('ternary: true branch', () => {
    expect(BigInt(cook('function main() { let x = 1 === 1 ? 42 : 0; return x; }'))).toBe(42n);
  });

  it('ternary: false branch', () => {
    expect(BigInt(cook('function main() { let x = 1 === 2 ? 42 : 99; return x; }'))).toBe(99n);
  });

  it('ternary: with variable', () => {
    expect(BigInt(cook('function main() { let a = 3; let b = a > 1 ? a : 0; return b; }'))).toBe(3n);
  });

  it('ternary: reassignment', () => {
    expect(BigInt(cook('function main() { let x = 0; x = 1 === 1 ? 77 : 33; return x; }'))).toBe(77n);
  });

  it('prefix increment: a = ++b', () => {
    expect(BigInt(cook('function main() { let b = 5; let a = ++b; return a; }'))).toBe(6n);
  });

  it('prefix increment: b is updated', () => {
    expect(BigInt(cook('function main() { let b = 5; let a = ++b; return b; }'))).toBe(6n);
  });

  it('postfix increment: a = b++', () => {
    expect(BigInt(cook('function main() { let b = 5; let a = b++; return a; }'))).toBe(5n);
  });

  it('postfix increment: b is updated', () => {
    expect(BigInt(cook('function main() { let b = 5; let a = b++; return b; }'))).toBe(6n);
  });

  it('prefix decrement: a = --b', () => {
    expect(BigInt(cook('function main() { let b = 5; let a = --b; return a; }'))).toBe(4n);
  });

  it('postfix decrement: a = b--', () => {
    expect(BigInt(cook('function main() { let b = 5; let a = b--; return a; }'))).toBe(5n);
  });

  it('nested if in loop', () => {
    expect(
      BigInt(
        cook(
          'function main() { let x = 0; for (let i = 0; i < 10; i++) { if (i < 5) { x = x + 1; } else { x = x + 10; } } return x; }',
        ),
      ),
    ).toBe(55n);
  });

  it('throw: reverts execution', () => {
    expect(() => cook('function main() { throw "error"; }')).toThrow('error');
  });

  it('throw: conditional revert when true', () => {
    expect(() => cook('function main() { if (1 === 1) { throw "fail"; } return 0; }')).toThrow('fail');
  });

  it('throw: no revert when condition false', () => {
    expect(BigInt(cook('function main() { if (1 === 2) { throw "fail"; } return 42; }'))).toBe(42n);
  });
});
