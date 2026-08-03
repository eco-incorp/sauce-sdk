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
  SVM_SETTLE_CFG_BYTES,
  SVM_TOKEN_SETTLE_REFS,
  SVM_TOKEN_SETTLE_SOURCE_PATH,
  decodeSvmSettleCfg,
  encodeSvmSettleCfg,
  svmTokenSettleSource,
} from '../src/programs/index.js';

const TOKENKEG = 0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9n;
const TOKEN_2022 = 0x06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfcn;

/** THE SNIPPET — kept verbatim-equivalent to the one in `programs/index.ts`'s docstring. */
function partnerCompile(minOut: bigint, tokenProgram: bigint) {
  return compile(svmTokenSettleSource(), {
    target: 'svm',
    staged: true,
    treeshake: true,
    args: [encodeSvmSettleCfg(minOut), tokenProgram],
  });
}

describe('svm settle — partner reproducibility', () => {
  it('the documented snippet compiles: real bytecode, accountPlan, and argsLayout', () => {
    const { bytecode, accountPlan, argsLayout } = partnerCompile(0n, TOKENKEG);
    expect(bytecode[0]!.length).toBeGreaterThan(0);
    expect(accountPlan).toBeDefined();
    expect(argsLayout).toBeDefined();
  });

  it('the account plan is exactly the four documented refs, in order, with no raw indices', () => {
    const { accountPlan } = partnerCompile(0n, TOKENKEG);
    expect(accountPlan!.usesRawIndices).toBeFalsy();
    expect(accountPlan!.metas.map((m) => [m.ref, !!m.writable, !!m.signer])).toEqual([
      ['tokenProgram', false, false],
      ['escrow', true, false],
      ['beneficiary', true, false],
      ['owner', false, true],
    ]);
    expect(Object.values(SVM_TOKEN_SETTLE_REFS)).toEqual(['tokenProgram', 'escrow', 'beneficiary', 'owner']);
  });

  it('the args layout is exactly [cfg: 8 bytes @0, tokenProgram: scalar @8], programLength matching the bytecode', () => {
    const { bytecode, argsLayout } = partnerCompile(0n, TOKENKEG);
    expect(argsLayout!.mode).toBe('calldata');
    expect(argsLayout!.programLength).toBe(bytecode[0]!.length);
    expect(argsLayout!.byteLength).toBe(8 + 32);
    expect(argsLayout!.slots).toEqual([
      { arg: 0, kind: 'bytes', offset: 0, length: SVM_SETTLE_CFG_BYTES },
      { arg: 1, kind: 'scalar', offset: 8, length: 32 },
    ]);
  });

  it('★ ONE canonical blob for every floor / token program — the genericity claim, asserted', () => {
    const variants = [
      partnerCompile(0n, 0n),
      partnerCompile(12345n, 0n),
      partnerCompile(0n, TOKENKEG),
      partnerCompile(0n, TOKEN_2022),
    ];
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    const bodies = new Set(variants.map((v) => hex(v.bytecode[0]!)));
    expect(bodies.size).toBe(1);
  });
});

describe('svm settle — the shipped program source', () => {
  it('svmTokenSettleSource() returns the exact on-disk svm-token-settle.sauce.ts', () => {
    const onDisk = readFileSync(resolve(process.cwd(), 'src/programs/svm-token-settle.sauce.ts'), 'utf-8');
    expect(svmTokenSettleSource()).toBe(onDisk);
  });

  it('SVM_TOKEN_SETTLE_SOURCE_PATH names the right file and it exists', () => {
    expect(basename(SVM_TOKEN_SETTLE_SOURCE_PATH)).toBe('svm-token-settle.sauce.ts');
    expect(readFileSync(SVM_TOKEN_SETTLE_SOURCE_PATH, 'utf-8').length).toBeGreaterThan(0);
  });
});

describe('svm settle — cfg codec', () => {
  it('round-trips u64 values', () => {
    for (const v of [0n, 1n, 12345n, 2n ** 64n - 1n]) {
      expect(decodeSvmSettleCfg(encodeSvmSettleCfg(v)).minOut).toBe(v);
    }
  });

  it('rejects out-of-u64-range minOut on encode', () => {
    expect(() => encodeSvmSettleCfg(-1n)).toThrow();
    expect(() => encodeSvmSettleCfg(2n ** 64n)).toThrow();
  });

  it('rejects malformed-length cfg on decode', () => {
    expect(() => decodeSvmSettleCfg(new Uint8Array(7))).toThrow();
    expect(() => decodeSvmSettleCfg(new Uint8Array(9))).toThrow();
    expect(() => decodeSvmSettleCfg(('0x' + '00'.repeat(7)) as `0x${string}`)).toThrow();
  });

  it('pins the byte order independently of the encoder: LE fixture 0x3930000000000000 -> 12345n', () => {
    expect(decodeSvmSettleCfg('0x3930000000000000').minOut).toBe(12345n);
  });

  it('accepts raw Uint8Array input identically to 0x-hex', () => {
    const encoded = encodeSvmSettleCfg(999n);
    const bytes = new Uint8Array(Buffer.from(encoded.slice(2), 'hex'));
    expect(decodeSvmSettleCfg(bytes)).toEqual(decodeSvmSettleCfg(encoded));
  });
});
