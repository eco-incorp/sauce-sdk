/**
 * THE PARTNER REPRODUCIBILITY + GENERICITY GUARD — the SVM analogue of `verify.compile.test.ts`.
 *
 * We hand partners a code snippet (see `sdk/src/programs/index.ts`'s module doc, second snippet
 * block) that compiles `svm-token-settle.sauce.ts` with the ORDINARY compiler at
 * `{ target: 'svm', staged: true, treeshake: true }` and tells them the result is byte-identical to
 * the program we hand them, REGARDLESS of the placeholder arg values passed at compile time (staged
 * mode never bakes args into the blob). This test IS that snippet, run for real, plus the structural
 * checks a partner would want before trusting the compiled AccountPlan/ArgsLayout shape.
 *
 * Options stay LITERAL below, never behind a helper — same rule `verify.compile.test.ts` states for
 * the EVM case: a partner reproducing our bytes needs to see the target/staged/treeshake/args
 * surface directly, not inherit it from a constant they never read.
 *
 * NEGATIVE CONTROL ON REPO POLICY: this file must never gain an expected-hash / expected-bytecode
 * constant. Partner verify for this program is "recompile and byte-compare against what you
 * received", never "compare against a hash we shipped" — see the module doc for why.
 */
import { readFileSync } from 'fs';
import { basename, resolve } from 'path';
import { compile } from '../../compiler/dist/index.js';
import {
  SVM_MAX_ESCROWS,
  svmTokenSettleRefs,
  SVM_TOKEN_SETTLE_SOURCE_PATH,
  svmTokenSettleSource,
} from '../src/programs/index.js';

const TOKENKEG = 0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9n;
const TOKEN_2022 = 0x06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfcn;

/** THE SNIPPET — kept verbatim-equivalent to the one in `programs/index.ts`'s docstring. */
function partnerCompile(minOut: bigint, tokenPrograms: bigint[] = [TOKENKEG]) {
  return compile(svmTokenSettleSource(tokenPrograms.length), {
    target: 'svm',
    staged: true,
    treeshake: true,
    args: [minOut, ...tokenPrograms],
  });
}

describe('svm settle — partner reproducibility', () => {
  it('the documented snippet compiles: real bytecode, accountPlan, and argsLayout', () => {
    const { bytecode, accountPlan, argsLayout } = partnerCompile(0n);
    expect(bytecode[0]!.length).toBeGreaterThan(0);
    expect(accountPlan).toBeDefined();
    expect(argsLayout).toBeDefined();
  });

  it('N=1: the account plan is exactly the four documented refs, in order, with no raw indices', () => {
    const { accountPlan } = partnerCompile(0n);
    expect(accountPlan!.usesRawIndices).toBeFalsy();
    expect(accountPlan!.metas.map((m) => [m.ref, !!m.writable, !!m.signer])).toEqual([
      ['tokenProgram0', false, false],
      ['escrow0', true, false],
      ['beneficiary0', true, false],
      ['owner', false, true],
    ]);
  });

  it('★ svmTokenSettleRefs(n) matches the compiled AccountPlan order for every n', () => {
    // Refs intern on FIRST USE, so `owner` sits after escrow0/beneficiary0 rather than last. A
    // caller builds its AccountResolution from svmTokenSettleRefs, so a wrong order here would land
    // accounts in the wrong slots — pinned against a real compile rather than asserted by eye.
    for (const n of [1, 2, 3, 5]) {
      const { accountPlan } = partnerCompile(0n, Array.from({ length: n }, () => TOKENKEG));
      expect(accountPlan!.metas.map((m) => m.ref)).toEqual(svmTokenSettleRefs(n));
    }
  });

  it('each escrow sweeps via its OWN token program — mixed classic/Token-2022 is expressible', () => {
    const { accountPlan } = partnerCompile(0n, [TOKENKEG, TOKEN_2022]);
    expect(accountPlan!.metas.map((m) => m.ref)).toEqual(svmTokenSettleRefs(2));
    // two distinct program refs, so the two escrows can CPI into different token programs
    expect(svmTokenSettleSource(2)).toContain('contract.call(tokenProgram0');
    expect(svmTokenSettleSource(2)).toContain('contract.call(tokenProgram1');
  });

  it('escrowCount is validated', () => {
    for (const bad of [0, -1, 1.5, SVM_MAX_ESCROWS + 1]) {
      expect(() => svmTokenSettleSource(bad)).toThrow();
      expect(() => svmTokenSettleRefs(bad)).toThrow();
    }
  });

  it('minOut is a plain SCALAR arg — no packed cfg blob, mirroring the EVM twin`s minOut parameter', () => {
    const { bytecode, argsLayout } = partnerCompile(0n);
    expect(argsLayout!.mode).toBe('calldata');
    expect(argsLayout!.programLength).toBe(bytecode[0]!.length);
    expect(argsLayout!.slots).toEqual([
      { arg: 0, kind: 'scalar', offset: 0, length: 32 },
      { arg: 1, kind: 'scalar', offset: 32, length: 32 },
    ]);
  });

  it('★ ONE canonical blob for every floor / token program — the genericity claim, asserted', () => {
    const variants = [
      partnerCompile(0n, [0n]),
      partnerCompile(12345n, [0n]),
      partnerCompile(0n, [TOKENKEG]),
      partnerCompile(0n, [TOKEN_2022]),
    ];
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    const bodies = new Set(variants.map((v) => hex(v.bytecode[0]!)));
    expect(bodies.size).toBe(1);
  });
});

describe('svm settle — the shipped program source', () => {
  it('svmTokenSettleSource() returns the exact on-disk svm-token-settle.sauce.ts', () => {
    const onDisk = readFileSync(resolve(process.cwd(), 'src/programs/svm-token-settle.sauce.ts'), 'utf-8');
    expect(svmTokenSettleSource(1)).toBe(onDisk);
  });

  it('SVM_TOKEN_SETTLE_SOURCE_PATH names the right file and it exists', () => {
    expect(basename(SVM_TOKEN_SETTLE_SOURCE_PATH)).toBe('svm-token-settle.sauce.ts');
    expect(readFileSync(SVM_TOKEN_SETTLE_SOURCE_PATH, 'utf-8').length).toBeGreaterThan(0);
  });
});
