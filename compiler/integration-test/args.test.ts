import { cook } from './utils.js';

describe('integration: args', () => {
  it('passes a single bigint arg to main', () => {
    expect(BigInt(cook('function main(x) { return x; }', { args: [42n] }))).toBe(42n);
  });

  it('passes multiple bigint args to main', () => {
    expect(BigInt(cook('function main(a, b) { return a + b; }', { args: [10n, 20n] }))).toBe(30n);
  });

  it('passes a large bigint arg', () => {
    const large = 2n ** 128n;

    expect(BigInt(cook('function main(x) { return x; }', { args: [large] }))).toBe(large);
  });

  it('passes args with helper functions', () => {
    expect(
      BigInt(
        cook('function double(x) { return x * 2; }\nfunction main(n) { return double(n); }', {
          args: [7n],
        }),
      ),
    ).toBe(14n);
  });

  it('uses args in arithmetic', () => {
    expect(BigInt(cook('function main(a, b) { return a * b + 1; }', { args: [5n, 10n] }))).toBe(51n);
  });

  it('uses args in control flow', () => {
    expect(
      BigInt(
        cook('function main(x) { if (x > 100) { return 1; } return 0; }', {
          args: [200n],
        }),
      ),
    ).toBe(1n);
  });

  it('uses args in a loop', () => {
    expect(
      BigInt(
        cook('function main(n) { let sum = 0; for (let i = 1; i <= n; i++) { sum += i; } return sum; }', {
          args: [10n],
        }),
      ),
    ).toBe(55n);
  });

  it('passes a hex string arg as dynamic bytes', () => {
    expect(
      BigInt(
        cook('function main(data) { return data.length; }', {
          args: ['0xaabbccdd'],
        }),
      ),
    ).toBe(4n);
  });

  it('passes mixed scalar and dynamic args', () => {
    expect(
      BigInt(
        cook('function main(x, data) { return x + data.length; }', {
          args: [10n, '0xaabbccdd'],
        }),
      ),
    ).toBe(14n);
  });

  it('passes array arg as dynamic tuple', () => {
    expect(
      BigInt(
        cook('function main(arr) { return arr[0] + arr[1]; }', {
          args: [[10n, 20n]],
        }),
      ),
    ).toBe(30n);
  });
});
