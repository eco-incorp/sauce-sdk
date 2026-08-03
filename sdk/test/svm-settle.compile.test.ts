/**
 * THE PARTNER REPRODUCIBILITY + GENERICITY GUARD for the SVM `settle` recipe — the SVM analogue of
 * `verify.compile.test.ts`.
 *
 * We hand partners a snippet (see `sdk/src/svm/recipes/index.ts`'s module doc) that compiles the SVM
 * `settle.sauce.ts` with the ORDINARY compiler at `{ target: 'svm', staged: true, treeshake: true }`
 * and tells them the result is byte-identical to the program we hand them, REGARDLESS of the
 * placeholder arg values passed at compile time (staged mode never bakes args into the blob). This
 * test IS that snippet, run for real, plus the structural checks a partner would want before
 * trusting the compiled AccountPlan / ArgsLayout shape.
 *
 * Options stay LITERAL below, never behind a helper — a partner reproducing our bytes needs to see
 * the target/staged/treeshake/args surface directly. NEGATIVE CONTROL ON REPO POLICY: this file must
 * never gain an expected-hash / expected-bytecode constant — partner verify is "recompile and
 * byte-compare against what you received", never "compare against a hash we shipped".
 */
import { readFileSync } from 'fs';
import { basename, resolve } from 'path';
import { compile } from '../../compiler/dist/index.js';
import {
  SVM_MAX_ESCROWS,
  SVM_SETTLE_SOURCE_PATH,
  svmSettleRefs,
  svmSettleSource,
} from '../src/svm/index.js';

// Real token-program ids, only as sample arg values — the blob never bakes them in (staged).
const TOKENKEG = 0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9n;
const TOKEN_2022 = 0x06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfcn;

/** THE SNIPPET — kept verbatim-equivalent to the one in `svm/recipes/index.ts`'s docstring.
 *  `main(minOut, splCount, tokenProgram0, tokenProgram1)`; args are placeholders in staged mode. */
function partnerCompile(escrowCount = 1, args: bigint[] = [0n, 0n, TOKENKEG, TOKENKEG]) {
  return compile(svmSettleSource(escrowCount), {
    target: 'svm',
    staged: true,
    treeshake: true,
    args,
  });
}

describe('svm settle — partner reproducibility', () => {
  it('the documented snippet compiles: real bytecode, accountPlan, and argsLayout', () => {
    const { bytecode, accountPlan, argsLayout } = partnerCompile();
    expect(bytecode[0]!.length).toBeGreaterThan(0);
    expect(accountPlan).toBeDefined();
    expect(argsLayout).toBeDefined();
  });

  it('N=1: the account plan is the documented refs, in order, with the right roles, no raw indices', () => {
    const { accountPlan } = partnerCompile(1);
    expect(accountPlan!.usesRawIndices).toBeFalsy();
    expect(accountPlan!.metas.map((m) => [m.ref, !!m.writable, !!m.signer])).toEqual([
      ['tokenProgram0', false, false],
      ['tokenProgram1', false, false],
      ['escrow0', true, false], // source, drained
      ['mint0', false, false], //  read for decimals by TransferChecked
      ['dest0', true, false], //   recipient's ATA, receives
      ['owner', false, true], //   authority that signs the transfer
    ]);
  });

  it('★ svmSettleRefs(n) matches the compiled AccountPlan order for every n', () => {
    // Refs intern on FIRST USE, so `owner` sits right after escrow0's trio, not last. A caller
    // builds its AccountResolution from svmSettleRefs, so a wrong order would land accounts in the
    // wrong slots — pinned against a real compile rather than asserted by eye.
    for (const n of [1, 2, 3, 5, SVM_MAX_ESCROWS]) {
      const { accountPlan } = partnerCompile(n);
      expect(accountPlan!.metas.map((m) => m.ref)).toEqual(svmSettleRefs(n));
    }
  });

  it('per escrow attaches (escrow, mint, dest); mint is there because TransferChecked (ix 12) reads its decimals', () => {
    const src = svmSettleSource(2);
    expect(src).toContain('Uint8Array.from([12])'); // TransferChecked discriminator, not legacy 3
    expect(src).toContain('accountUint("mint0", 44, 1)'); // decimals read on-chain from the mint
    expect(src).toContain('accountUint("mint1", 44, 1)');
    // both token programs are attached so `splCount` can route each escrow at runtime
    expect(src).toContain('accountData("tokenProgram0", 0, 0)');
    expect(src).toContain('accountData("tokenProgram1", 0, 0)');
    expect(src).toContain('tp0 = 0 < splCount ? tokenProgram0 : tokenProgram1');
  });

  it('escrowCount is validated', () => {
    for (const bad of [0, -1, 1.5, SVM_MAX_ESCROWS + 1]) {
      expect(() => svmSettleSource(bad)).toThrow();
      expect(() => svmSettleRefs(bad)).toThrow();
    }
  });

  it('args are four plain SCALARs — minOut, splCount, tokenProgram0, tokenProgram1', () => {
    const { bytecode, argsLayout } = partnerCompile(1);
    expect(argsLayout!.mode).toBe('calldata');
    expect(argsLayout!.programLength).toBe(bytecode[0]!.length);
    expect(argsLayout!.slots).toEqual([
      { arg: 0, kind: 'scalar', offset: 0, length: 32 },
      { arg: 1, kind: 'scalar', offset: 32, length: 32 },
      { arg: 2, kind: 'scalar', offset: 64, length: 32 },
      { arg: 3, kind: 'scalar', offset: 96, length: 32 },
    ]);
  });

  it('★ ONE canonical blob per escrow count — the genericity claim, asserted across arg values', () => {
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    const variants = [
      partnerCompile(3, [0n, 0n, TOKENKEG, TOKENKEG]), // all classic
      partnerCompile(3, [12345n, 2n, TOKENKEG, TOKEN_2022]), // 2 classic + 1 Token-2022, with a floor
      partnerCompile(3, [1n << 40n, 1n, TOKEN_2022, TOKENKEG]), // any split, any programs
    ];
    const bodies = new Set(variants.map((v) => hex(v.bytecode[0]!)));
    expect(bodies.size).toBe(1);
  });
});

describe('svm settle — the shipped program source', () => {
  it('svmSettleSource(1) returns the exact on-disk settle.sauce.ts', () => {
    const onDisk = readFileSync(resolve(process.cwd(), 'src/svm/recipes/settle.sauce.ts'), 'utf-8');
    expect(svmSettleSource(1)).toBe(onDisk);
  });

  it('SVM_SETTLE_SOURCE_PATH names the right file and it exists', () => {
    expect(basename(SVM_SETTLE_SOURCE_PATH)).toBe('settle.sauce.ts');
    expect(readFileSync(SVM_SETTLE_SOURCE_PATH, 'utf-8').length).toBeGreaterThan(0);
  });
});
