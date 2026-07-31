/**
 * The (B) partner capability — compile-from-source — and the deliberate CLOSURE SPLIT that keeps
 * it off the `./verify` barrel. See `sdk/src/verify/compile.ts`'s module doc for why (A) (decode/
 * authenticity) and (B) (compile/provenance) are separate, non-substitutable checks.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSettleProgram, settleSourceText } from '../src/verify/compile';
import { SETTLE_VECTORS, CURRENT_SETTLE_TEMPLATE } from '../src/verify/index';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('@eco-incorp/sauce-sdk/verify/compile — compile-from-source', () => {
  for (const v of SETTLE_VECTORS) {
    it(`compiles ${v.name} byte-for-byte identical to the pinned vector`, () => {
      const out = compileSettleProgram(v.tokens, v.minOut, v.recipient);
      expect(out.bytecodes[0]!.toLowerCase()).toBe(v.program.toLowerCase());
      expect(out.bodyHash).toBe(CURRENT_SETTLE_TEMPLATE.bodyHash);
    });
  }

  it('rejects an empty tokens list', () => {
    expect(() => compileSettleProgram([], 0n, '0x1' as `0x${string}`)).toThrow(/tokens must list at least one/);
  });

  it('rejects a zero recipient', () => {
    const [v] = SETTLE_VECTORS;
    expect(() => compileSettleProgram(v!.tokens, v!.minOut, '0x0000000000000000000000000000000000000000')).toThrow(
      /recipient is REQUIRED/,
    );
  });

  it('rejects a negative minOut', () => {
    const [v] = SETTLE_VECTORS;
    expect(() => compileSettleProgram(v!.tokens, -1n, v!.recipient)).toThrow(/non-negative/);
  });

  it('settleSourceText() returns the exact on-disk ecoswap.settle.sauce.ts', () => {
    const onDisk = readFileSync(join(__dirname, '../src/verify/ecoswap.settle.sauce.ts'), 'utf-8');
    expect(settleSourceText()).toBe(onDisk);
    expect(settleSourceText()).toContain('function main(tokens: Address[], minOut: Uint256, recipient: Address)');
  });

  it('is memoized: repeat calls return equal-content results (byte-identity is a compile PROPERTY, not a cache accident)', () => {
    const [v] = SETTLE_VECTORS;
    const a = compileSettleProgram(v!.tokens, v!.minOut, v!.recipient);
    const b = compileSettleProgram(v!.tokens, v!.minOut, v!.recipient);
    expect(a.bytecodes[0]).toBe(b.bytecodes[0]);
    expect(a.source).toBe(b.source);
  });
});

describe('the closure split: ./verify/compile must NEVER be reachable from the ./verify barrel', () => {
  it('sdk/src/verify/index.ts does not re-export compile.ts (grep-verifiable, not just untested)', () => {
    const barrel = readFileSync(join(__dirname, '../src/verify/index.ts'), 'utf-8');
    expect(barrel).not.toMatch(/compile\.js|compile['"]/);
  });

  it("compile.ts's own bare-specifier closure is NOT {viem} — it needs the compiler and the filesystem, which is exactly why it must stay off the barrel", () => {
    const src = readFileSync(join(__dirname, '../src/verify/compile.ts'), 'utf-8');
    const bareSpecifiers = new Set<string>();
    for (const m of src.matchAll(/from\s*["']([^"']+)["']/g)) {
      const spec = m[1]!;
      if (!spec.startsWith('.')) bareSpecifiers.add(spec);
    }
    // node:fs / node:path / node:url / typescript / viem are all expected here — none of them are
    // {viem}-only, which is the point: this module's closure is intentionally NOT the barrel's.
    expect(bareSpecifiers.has('node:fs')).toBe(true);
    expect(bareSpecifiers.has('typescript')).toBe(true);
    expect([...bareSpecifiers].sort()).not.toEqual(['viem']);
  });
});
