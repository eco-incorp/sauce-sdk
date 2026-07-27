import { cook } from './utils.js';

// Real-EVM proof for the "Local `new Array(n)` construction folding" ts-frontend pass
// (compiler/src/ts-frontend.ts): the unit tests in test/ts-frontend.test.ts prove the compiled
// bytecode SHAPE (no NEW_ARRAY/SET_INDEX/INDEX opcodes remain); these prove the compiled
// bytecode's VALUE, by actually executing it via cook() against a real deployed engine on
// anvil — the area at real risk here is slot/frame allocation (deleting a `new Array`
// declaration changes v1 ALLOCATE counts), not just "does it parse".
describe('integration: local new Array(n) construction folding (ts-frontend)', () => {
  it('the motivating probe: unrolled-loop construction + a read returns the correct value', () => {
    const source = `
      function main(): Uint256 {
        const arr = new Array(3);
        for (let i = 0n; i < 3n; i++) {
          arr[i] = i * 2n;
        }
        return arr[1];
      }
    `;

    expect(BigInt(cook(source, { tsSource: true }))).toBe(2n);
  });

  it('a plain-number counter unroll (the synthesized-NumericLiteral fallback) returns the correct value', () => {
    const source = `
      function main() {
        const arr = new Array(3);
        for (let i = 0; i < 3; i++) {
          arr[i] = i * 2;
        }
        return arr[1];
      }
    `;

    expect(BigInt(cook(source, { tsSource: true }))).toBe(2n);
  });

  it('the `while`-counting idiom construction returns the correct value', () => {
    const source = `
      function main() {
        const arr = new Array(3);
        let i = 0n;
        while (i < 3n) { arr[i] = i * 10n; i++; }
        return arr[2];
      }
    `;

    expect(BigInt(cook(source, { tsSource: true }))).toBe(20n);
  });

  it('an accumulator loop over a folded array (fed into the LOCAL scalar pass) returns the correct sum', () => {
    const source = `
      function main() {
        const fees = new Array(3);
        fees[0] = 100n;
        fees[1] = 500n;
        fees[2] = 3000n;
        let total = 0n;
        for (let i = 0n; i < 3n; i++) { total += fees[i]; }
        return total;
      }
    `;

    expect(BigInt(cook(source, { tsSource: true }))).toBe(3600n);
  });

  it('out-of-order writes return the correct sum', () => {
    const source = `
      function main() {
        const arr = new Array(3);
        arr[2] = 30n;
        arr[0] = 10n;
        arr[1] = 20n;
        return arr[0] + arr[1] + arr[2];
      }
    `;

    expect(BigInt(cook(source, { tsSource: true }))).toBe(60n);
  });

  it('two independent arrays, constructions INTERLEAVED, both return the correct sum', () => {
    const source = `
      function main() {
        const a = new Array(2);
        const b = new Array(2);
        a[0] = 1n;
        b[0] = 10n;
        a[1] = 2n;
        b[1] = 20n;
        return a[0] + a[1] + b[0] + b[1];
      }
    `;

    expect(BigInt(cook(source, { tsSource: true }))).toBe(33n);
  });

  it('a read index via a top-level const returns the correct value', () => {
    const source = `
      const K = 1n;
      function main() {
        const arr = new Array(3);
        arr[0] = 10n;
        arr[1] = 20n;
        arr[2] = 30n;
        return arr[K];
      }
    `;

    expect(BigInt(cook(source, { tsSource: true }))).toBe(20n);
  });

  // Equivalence harness: for both a FOLDING fixture and a DECLINING fixture, the identical
  // source must return the SAME value whether compiled through the ts-frontend (tsSource:
  // true, this feature folds it away entirely) or through plain acorn (no tsSource — this
  // feature never runs, the array stays a real runtime NEW_ARRAY/SET_INDEX/INDEX heap
  // allocation) — proving a decline path never silently changes the executed VALUE, and a
  // fold never changes it either, only the bytecode shape.
  //
  // NOTE: an aliasing fixture (`const b = arr;`) and a call-argument fixture (`helper(arr)`)
  // were deliberately tried here and DROPPED — both DO correctly decline to fold (confirmed:
  // `compile(src, {tsSource:true})` and `compile(src)` emit byte-identical bytecode either
  // way), but BOTH revert at real EVM execution with `SauceInvalidOperationArgs(INDEX)`
  // regardless of tsSource — a genuine, PRE-EXISTING gap in the base compiler's handling of a
  // heap-array descriptor escaping its own declaring scope (across a second variable, or a
  // function-call boundary), wholly unrelated to this feature (this pass never touches either
  // fixture — the identical revert with tsSource on AND off is the proof). Out of scope here.
  describe('equivalence: cook(tsSource) === cook(plain), fold and decline alike', () => {
    const fixtures: Record<string, string> = {
      'folds (straight-line writes)': `
        function main() {
          const a = new Array(2);
          a[0] = 5n;
          a[1] = 7n;
          return a[1];
        }
      `,
      'folds (accumulator via unrolled loop)': `
        function main() {
          const fees = new Array(3);
          fees[0] = 100n;
          fees[1] = 500n;
          fees[2] = 3000n;
          let total = 0n;
          for (let i = 0n; i < 3n; i++) { total += fees[i]; }
          return total;
        }
      `,
      'declines (partial writes — a hole)': `
        function main() {
          const arr = new Array(3);
          arr[0] = 1n;
          arr[1] = 2n;
          return arr[0] + arr[1];
        }
      `,
      'declines (non-constant read index)': `
        function main(n: Uint256) {
          const arr = new Array(3);
          arr[0] = 10n;
          arr[1] = 20n;
          arr[2] = 30n;
          return arr[n];
        }
      `,
      'declines (rebinding)': `
        function main() {
          let arr = new Array(2);
          arr[0] = 1n;
          arr[1] = 2n;
          arr = new Array(2);
          arr[0] = 9n;
          arr[1] = 9n;
          return arr[0] + arr[1];
        }
      `,
    };

    for (const [label, source] of Object.entries(fixtures)) {
      it(label, () => {
        const args = source.includes('main(n') ? [1n] : [];
        const folded = cook(source, { tsSource: true, args });
        const plain = cook(source.replace(/: Uint256/g, ''), { args });

        expect(folded).toBe(plain);
      });
    }
  });
});
