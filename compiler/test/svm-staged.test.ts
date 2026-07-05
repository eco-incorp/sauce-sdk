/**
 * Staged svm compilation (execute_from_account) — the staged arg lowering
 * (SLOAD + CAST_LE off the args PDA instead of baked literals), the argsLayout
 * writer contract, the reserved account-plan slots, and the staged-mode gates.
 * Byte fixtures follow the house style: hex string + a comment decoding them.
 */
import { compile } from '../src/index.js';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('staged svm — arg lowering (byte-exact, 2-arg program in both modes)', () => {
  const src = 'function main(a, b) { return a + b }';

  it('inline mode bakes the literal args into the prologue', () => {
    const r = compile(src, { target: 'svm', args: [7n, 5n] });

    // [BYTE_1 07][BYTE_1 05] — the baked values — then main: [SDUP2][SDUP2][ADD][MSTORE][STOP]
    expect(hex(r.bytecode[0])).toBe('01070105d1d121f200');
    expect(r.argsLayout).toBeUndefined();
  });

  it('staged mode reads each arg from the args PDA: [len 32][offset][index 0][SLOAD][CAST_LE]', () => {
    const r = compile(src, { target: 'svm', staged: true, args: [7n, 5n] });

    // arg0: [BYTE_1 20][BYTE_1 20][BYTE_1 00][SLOAD 81][CAST_LE 55]  (32 bytes at offset 32, account 0)
    // arg1: [BYTE_1 20][BYTE_1 40][BYTE_1 00][SLOAD 81][CAST_LE 55]  (32 bytes at offset 64)
    // main body unchanged: [SDUP2][SDUP2][ADD][MSTORE][STOP]
    expect(hex(r.bytecode[0])).toBe('01200120010081550120014001008155d1d121f200');
    expect(r.argsLayout).toEqual({
      accountIndex: 0,
      regionOffset: 32,
      byteLength: 64,
      slots: [
        { arg: 0, kind: 'scalar', offset: 32, length: 32 },
        { arg: 1, kind: 'scalar', offset: 64, length: 32 },
      ],
    });
  });

  it('the arg VALUES do not change the staged bytecode — one buffer serves every argument set', () => {
    const a = compile(src, { target: 'svm', staged: true, args: [7n, 5n] });
    const b = compile(src, { target: 'svm', staged: true, args: [123456789n, 987654321n] });

    expect(hex(a.bytecode[0])).toBe(hex(b.bytecode[0]));
  });

  it('a bytes arg reads its slot WITHOUT CAST_LE (Bytes descriptor, like the inline literal)', () => {
    const src = 'function main(d) { return d }';
    const inline = compile(src, { target: 'svm', args: ['0xdeadbeef'] });
    const staged = compile(src, { target: 'svm', staged: true, args: ['0xdeadbeef'] });

    // inline: [BYTES 90][len 04][de ad be ef] then [SDUP1][MSTORE][STOP]
    expect(hex(inline.bytecode[0])).toBe('9004deadbeefd0f200');
    // staged: [BYTE_1 04][BYTE_1 20][BYTE_1 00][SLOAD] — 4 bytes at offset 32, no cast
    expect(hex(staged.bytecode[0])).toBe('01040120010081d0f200');
    expect(staged.argsLayout).toEqual({
      accountIndex: 0,
      regionOffset: 32,
      byteLength: 32,
      slots: [{ arg: 0, kind: 'bytes', offset: 32, length: 4 }],
    });
  });

  it('slots stride 32-byte-aligned: a 40-byte bytes arg advances the next slot by 64', () => {
    const r = compile('function main(a, d, b) { return a + b }', {
      target: 'svm',
      staged: true,
      args: [1n, '0x' + 'ab'.repeat(40), 2n],
    });

    expect(r.argsLayout).toEqual({
      accountIndex: 0,
      regionOffset: 32,
      byteLength: 128,
      slots: [
        { arg: 0, kind: 'scalar', offset: 32, length: 32 },
        { arg: 1, kind: 'bytes', offset: 64, length: 40 },
        { arg: 2, kind: 'scalar', offset: 128, length: 32 },
      ],
    });
  });

  it('a no-arg staged program still carries an (empty) argsLayout', () => {
    const r = compile('function main() { return 1 }', { target: 'svm', staged: true });

    expect(r.argsLayout).toEqual({ accountIndex: 0, regionOffset: 32, byteLength: 0, slots: [] });
  });
});

describe('staged svm — account plan reservation', () => {
  it("reserves 'args' (writable) at user index 0 and 'payer' (signer) at index 1", () => {
    const r = compile('function main(a) { return a }', { target: 'svm', staged: true, args: [1n] });

    expect(r.accountPlan).toEqual({
      metas: [
        { ref: 'args', writable: true, signer: false },
        { ref: 'payer', writable: false, signer: true },
      ],
    });
  });

  it('user refs intern from index 2, after the reserved slots', () => {
    const r = compile("function main() { return accountData('pool', 0, 8) }", { target: 'svm', staged: true });

    expect(r.accountPlan!.metas.map((m) => m.ref)).toEqual(['args', 'payer', 'pool']);
  });

  it('a raw-index staged program still compiles (reservation does not lock the registry mode)', () => {
    const r = compile('function main() { return accountData(0, 0, 8) }', { target: 'svm', staged: true });

    // The caller owns the whole ordering in raw mode; the staged convention
    // (args at user index 0) is theirs to honor.
    expect(r.accountPlan!.usesRawIndices).toBe(true);
  });
});

describe('staged svm — gates and validation', () => {
  it('rejects staged with a non-svm target', () => {
    expect(() => compile('function main() { return 1 }', { target: 'v12', staged: true })).toThrow(
      "staged compilation requires target 'svm', got 'v12'",
    );
    expect(() => compile('function main() { return 1 }', { staged: true })).toThrow(
      "staged compilation requires target 'svm', got 'v1'",
    );
  });

  it('rejects msg.data (CALLDATA would copy the whole staged program to the heap)', () => {
    const src = 'function main() { const d = msg.data; return d[0] }';

    expect(() => compile(src, { target: 'svm', staged: true })).toThrow(
      /msg\.data is not supported in staged svm mode/,
    );
    // inline svm keeps it
    expect(() => compile(src, { target: 'svm' })).not.toThrow();
  });

  it('rejects array args (ABI-encode to bytes instead)', () => {
    expect(() => compile('function main(a) { return a }', { target: 'svm', staged: true, args: [[1n, 2n]] })).toThrow(
      'staged svm args do not support array values (arg 0)',
    );
  });

  it('rejects an arg set that overflows the 8,192-byte args region', () => {
    const args = Array.from({ length: 257 }, () => 1n); // 257 x 32 = 8,224 > 8,192
    const params = Array.from({ length: 257 }, (_, i) => `p${i}`).join(', ');

    expect(() => compile(`function main(${params}) { return p0 }`, { target: 'svm', staged: true, args })).toThrow(
      'staged svm args need 8224 bytes; the args PDA region holds 8192',
    );
  });

  it('staged bytecode is budgeted against the staged packet shape (no bytecode-size warning)', () => {
    const body = Array.from({ length: 250 }, (_, i) => `storage.tWrite(${i}, 42);`).join('\n');
    const inline = compile(`function main() { ${body} }`, { target: 'svm' });
    const staged = compile(`function main() { ${body} }`, { target: 'svm', staged: true });

    expect(inline.warnings.length).toBeGreaterThan(0);
    expect(staged.warnings).toEqual([]);
  });
});
