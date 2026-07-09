/**
 * Planner phase B — the packet budget estimator, its compile() warning surface,
 * and registry behaviors not covered by svm-target.test.ts (signer flag
 * OR-merge, merge combined with helper-function interning order).
 *
 * Budget fixtures are hand-computed from the v0 wire math documented in
 * planner/budget.ts; each fixture's comment names every term.
 */
import { compile } from '../src/index.js';
import { estimatePacket } from '../src/planner/index.js';
import type { AccountPlan } from '../src/planner/index.js';

const compileSvm = (src: string) => compile(src, { target: 'svm' });
const planWith = (n: number): AccountPlan => ({
  metas: Array.from({ length: n }, (_, i) => ({ ref: `a${i}`, writable: false, signer: false })),
});

describe('planner — estimatePacket wire math', () => {
  it('0 metas, 100-byte bytecode: hand-computed v0 estimate, no warnings', () => {
    expect(estimatePacket(planWith(0), 100)).toEqual({
      bytecodeBytes: 100,
      instructionDataBytes: 108, // 8 discriminator + 100
      staticAccountKeys: 5, // payer + engine program + 3 PDAs
      // 65 signatures (1 + 64x1) + 197 message (1 version + 3 header + 1 count + 5x32 keys + 32 blockhash)
      // + 115 instructions (1 count + 1 program-id + 1 count + 3 indices + 1 data len + 108 data) + 1 empty ALT
      messageBytes: 378,
      limitBytes: 1232,
      overflowBytes: 0,
      accountLocks: 5,
      lockLimit: 64,
      warnings: [],
    });
  });

  it('25 metas, 900-byte bytecode: overflows the packet and warns', () => {
    const b = estimatePacket(planWith(25), 900);

    expect(b.instructionDataBytes).toBe(908);
    expect(b.staticAccountKeys).toBe(30); // 5 fixed + 25 user metas
    // 65 signatures + 997 message (1+3+1 + 30x32 + 32)
    // + 941 instructions (1 + 1 + 1 + 28 indices + 2 data len (908 >= 128) + 908 data) + 1 empty ALT
    expect(b.messageBytes).toBe(2004);
    expect(b.overflowBytes).toBe(772);
    expect(b.accountLocks).toBe(30); // under the lock cap: only the packet warning
    expect(b.warnings).toEqual([
      'transaction exceeds the 1232-byte packet by 772 bytes; use address lookup tables or trim bytecode',
    ]);
  });

  it('lookupAddresses shift keys out of the static section (locks unchanged)', () => {
    const direct = estimatePacket(planWith(25), 100);
    const viaAlt = estimatePacket(planWith(25), 100, { lookupTables: 1, lookupAddresses: 20 });

    expect(direct.staticAccountKeys).toBe(30);
    expect(direct.messageBytes).toBe(1203); // 65 + 997 + 140 (1+1+1+28+1+108) + 1
    expect(viaAlt.staticAccountKeys).toBe(10); // 5 fixed + (25 - 20) non-ALT metas
    expect(viaAlt.accountLocks).toBe(30); // locks count ALT-resolved accounts too
    // each shifted key trades 32 static-key bytes for a 1-byte ALT index; the table itself adds 34
    expect(viaAlt.messageBytes).toBe(direct.messageBytes - 20 * 32 + 20 + 34); // = 617
    expect(viaAlt.warnings).toEqual([]);
  });

  it('65 locks warn even when the packet fits (ALT-resolved)', () => {
    const b = estimatePacket(planWith(60), 100, { lookupTables: 1, lookupAddresses: 60 });

    expect(b.accountLocks).toBe(65); // 5 static + 60 ALT-resolved
    expect(b.messageBytes).toBe(532); // 65 + 197 + 175 (1+1+1+63+1+108) + 95 (1 + 34 + 60)
    expect(b.overflowBytes).toBe(0);
    expect(b.warnings).toEqual(['account locks (65) exceed the runtime cap of 64']);
  });

  it('both warnings surface together, packet first', () => {
    const b = estimatePacket(planWith(60), 900);

    // 65 + 2117 (1+3+1 + 65x32 + 32) + 976 (1 + 1 + 1 + 63 + 2 + 908) + 1 = 3159
    expect(b.messageBytes).toBe(3159);
    expect(b.warnings).toEqual([
      'transaction exceeds the 1232-byte packet by 1927 bytes; use address lookup tables or trim bytecode',
      'account locks (65) exceed the runtime cap of 64',
    ]);
  });

  it('plan-declared signer metas raise the default signature count', () => {
    const plan: AccountPlan = { metas: [{ ref: 'delegate', writable: false, signer: true }] };
    const b = estimatePacket(plan, 900);

    // 2 signatures — fee payer + the plan-declared signer: 129 (1 + 64x2)
    // + 229 message (1+3+1 + 6x32 + 32) + 917 instructions (1 + 1 + 1 + 4 indices
    // + 2 data len + 908 data) + 1 empty ALT = 1276 — 44 over the packet
    expect(b.messageBytes).toBe(1276);
    expect(b.overflowBytes).toBe(44);
    expect(b.warnings).toEqual([
      'transaction exceeds the 1232-byte packet by 44 bytes; use address lookup tables or trim bytecode',
    ]);
    // an explicit count overrides the plan-derived default (signer ref bound to the fee payer)
    expect(estimatePacket(plan, 900, { signers: 1 }).overflowBytes).toBe(0);
  });

  it("the reserved 'payer' ref adds no signature, static key, or lock — only its index byte", () => {
    const plan: AccountPlan = {
      metas: [
        { ref: 'payer', writable: true, signer: true },
        { ref: 'pool', writable: false, signer: false },
      ],
    };
    const b = estimatePacket(plan, 100);

    expect(b.staticAccountKeys).toBe(6); // 5 fixed (fee payer included) + pool only
    expect(b.accountLocks).toBe(6);
    // 65 signatures (1 + 64x1 — the payer meta IS the fee payer) + 229 message
    // (1+3+1 + 6x32 + 32) + 117 instructions (1 + 1 + 1 + 5 indices (3 PDAs +
    // BOTH metas) + 1 data len + 108 data) + 1 empty ALT
    expect(b.messageBytes).toBe(412);
    expect(b.warnings).toEqual([]);
  });

  it('prependBytes reserves headroom byte-for-byte (e.g. 40 for a ComputeBudget unit-limit prepend)', () => {
    const base = estimatePacket(planWith(0), 100);
    const withPrepend = estimatePacket(planWith(0), 100, { prependBytes: 40 });

    expect(withPrepend.messageBytes).toBe(base.messageBytes + 40);
  });

  it('key-count prefix grows to 2 bytes at 128 static keys (metas >= 123)', () => {
    const b = estimatePacket(planWith(123), 100);

    expect(b.staticAccountKeys).toBe(128);
    // 65 signatures + 4134 message (1+3+2 (compact key count >= 128) + 128x32 + 32)
    // + 238 instructions (1 + 1 + 1 + 126 indices + 1 data len + 108 data) + 1 empty ALT
    expect(b.messageBytes).toBe(4438);
  });

  it('per-table index-count prefix grows to 2 bytes at 128 ALT-resolved addresses', () => {
    const b = estimatePacket(planWith(130), 100, { lookupTables: 1, lookupAddresses: 128 });

    // 65 signatures + 261 message (1+3+1 + 7x32 + 32) + 246 instructions
    // (1 + 1 + 2 (compact account count >= 128) + 133 indices + 1 data len + 108 data)
    // + 164 ALT (1 + 32 + 2 (compact index count >= 128) + 1 + 128 indices)
    expect(b.messageBytes).toBe(736);
  });

  it('rejects lookup options inconsistent with the plan', () => {
    expect(() => estimatePacket(planWith(5), 100, { lookupTables: 1, lookupAddresses: 10 })).toThrow(
      "lookupAddresses (10) exceeds the plan's account metas (5)",
    );
    expect(() => estimatePacket(planWith(5), 100, { lookupAddresses: 3 })).toThrow(
      'lookupAddresses (3) requires lookupTables > 0, got 0',
    );
  });

  it('is pure: the same input twice yields deep-equal results and leaves the plan untouched', () => {
    const plan = planWith(3);
    const opts = { signers: 2, lookupTables: 1, lookupAddresses: 2 };

    expect(estimatePacket(plan, 500, opts)).toEqual(estimatePacket(plan, 500, opts));
    expect(plan).toEqual(planWith(3));
  });
});

describe('planner — compile() packet-budget warnings (target svm)', () => {
  it('a small zero-meta program compiles with zero warnings', () => {
    expect(compileSvm('function main() { return 42 }').warnings).toEqual([]);
  });

  it('an oversized program surfaces the overflow warning (non-fatal)', () => {
    // 250 tWrite statements x 5 bytes ([BYTE_1,42][BYTE_1,i][TSTORE]) ≈ 1250 bytes of bytecode.
    const body = Array.from({ length: 250 }, (_, i) => `storage.tWrite(${i}, 42);`).join('\n');
    const r = compileSvm(`function main() { ${body} }`);
    const budget = estimatePacket(r.accountPlan!, r.bytecode[0].length);

    expect(budget.overflowBytes).toBeGreaterThan(0);
    expect(r.warnings).toEqual(budget.warnings);
    expect(r.warnings).toEqual([
      expect.stringMatching(
        /^transaction exceeds the 1232-byte packet by \d+ bytes; use address lookup tables or trim bytecode$/,
      ),
    ]);
  });
});

describe('planner — registry merge/ordering (gaps left by svm-target.test.ts)', () => {
  it('re-interning merges the signer flag; helper-first interning fixes the order', () => {
    const r = compileSvm(`
      function readPayer() { return accountData('payer', 0, 8) }
      function main() {
        writeAccountData('vault', 0, Uint8Array.from([0x01]));
        return contract.call(7, readPayer(), [{ ref: 'payer', signer: true }, 'vault']);
      }
    `);

    // 'payer' interned first (readonly non-signer, in readPayer — helpers compile
    // before main) then merged signer by main's call list; 'vault' interned second
    // via writeAccountData (writable) and re-interned plain without losing the flag.
    expect(r.accountPlan).toEqual({
      metas: [
        { ref: 'payer', writable: false, signer: true },
        { ref: 'vault', writable: true, signer: false },
      ],
    });
  });

  it('a signer flag is sticky across later plain uses of the ref', () => {
    const r = compileSvm(`
      function main() {
        return contract.call(7, Uint8Array.from([0xaa]), [{ ref: 'payer', signer: true }, 'payer']);
      }
    `);

    expect(r.accountPlan).toEqual({ metas: [{ ref: 'payer', writable: false, signer: true }] });
  });
});
