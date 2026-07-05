/**
 * Planner phase B — the packet budget estimator, its compile() warning surface,
 * and registry behaviors not covered by svm-target.test.ts (signer flag
 * OR-merge, merge combined with helper-function interning order).
 *
 * Budget fixtures are hand-computed from the v0 wire math documented in
 * planner/budget.ts; each fixture's comment names every term. Plans without a
 * signer meta (and without the reserved 'payer' ref) count ONE extra
 * instruction account index — the SDK appends the fee payer as the in-list
 * signer the engine requires.
 */
import { compile } from '../src/index.js';
import { estimatePacket, stagingTransactionCount } from '../src/planner/index.js';
import type { AccountPlan } from '../src/planner/index.js';

const compileSvm = (src: string) => compile(src, { target: 'svm' });
const planWith = (n: number): AccountPlan => ({
  metas: Array.from({ length: n }, (_, i) => ({ ref: `a${i}`, writable: false, signer: false })),
});

describe('planner — estimatePacket wire math (inline)', () => {
  it('0 metas, 100-byte bytecode: hand-computed v0 estimate, no warnings', () => {
    expect(estimatePacket(planWith(0), 100)).toEqual({
      mode: 'inline',
      bytecodeBytes: 100,
      instructionDataBytes: 108, // 8 discriminator + 100
      staticAccountKeys: 5, // payer + engine program + 3 PDAs
      // 65 signatures (1 + 64x1) + 197 message (1 version + 3 header + 1 count + 5x32 keys + 32 blockhash)
      // + 116 instructions (1 count + 1 program-id + 1 count + 3 PDA indices + 1 appended-signer index
      // + 1 data len + 108 data) + 1 empty ALT
      messageBytes: 379,
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
    // + 942 instructions (1 + 1 + 1 + 29 indices (28 + appended signer) + 2 data len (908 >= 128) + 908 data) + 1 empty ALT
    expect(b.messageBytes).toBe(2005);
    expect(b.overflowBytes).toBe(773);
    expect(b.accountLocks).toBe(30); // under the lock cap: only the packet warning
    expect(b.warnings).toEqual([
      'transaction exceeds the 1232-byte packet by 773 bytes; stage the bytecode (execute_from_account), use address lookup tables, or trim bytecode',
    ]);
  });

  it('lookupAddresses shift keys out of the static section (locks unchanged)', () => {
    const direct = estimatePacket(planWith(25), 100);
    const viaAlt = estimatePacket(planWith(25), 100, { lookupTables: 1, lookupAddresses: 20 });

    expect(direct.staticAccountKeys).toBe(30);
    expect(direct.messageBytes).toBe(1204); // 65 + 997 + 141 (1+1+1+29+1+108) + 1
    expect(viaAlt.staticAccountKeys).toBe(10); // 5 fixed + (25 - 20) non-ALT metas
    expect(viaAlt.accountLocks).toBe(30); // locks count ALT-resolved accounts too
    // each shifted key trades 32 static-key bytes for a 1-byte ALT index; the table itself adds 34
    expect(viaAlt.messageBytes).toBe(direct.messageBytes - 20 * 32 + 20 + 34); // = 618
    expect(viaAlt.warnings).toEqual([]);
  });

  it('65 locks warn even when the packet fits (ALT-resolved)', () => {
    const b = estimatePacket(planWith(60), 100, { lookupTables: 1, lookupAddresses: 60 });

    expect(b.accountLocks).toBe(65); // 5 static + 60 ALT-resolved
    expect(b.messageBytes).toBe(533); // 65 + 197 + 176 (1+1+1+64+1+108) + 95 (1 + 34 + 60)
    expect(b.overflowBytes).toBe(0);
    expect(b.warnings).toEqual(['account locks (65) exceed the runtime cap of 64']);
  });

  it('both warnings surface together, packet first', () => {
    const b = estimatePacket(planWith(60), 900);

    // 65 + 2117 (1+3+1 + 65x32 + 32) + 977 (1 + 1 + 1 + 64 + 2 + 908) + 1 = 3160
    expect(b.messageBytes).toBe(3160);
    expect(b.warnings).toEqual([
      'transaction exceeds the 1232-byte packet by 1928 bytes; stage the bytecode (execute_from_account), use address lookup tables, or trim bytecode',
      'account locks (65) exceed the runtime cap of 64',
    ]);
  });

  it('plan-declared signer metas raise the default signature count (and suppress the appended signer)', () => {
    const plan: AccountPlan = { metas: [{ ref: 'delegate', writable: false, signer: true }] };
    const b = estimatePacket(plan, 900);

    // 2 signatures — fee payer + the plan-declared signer: 129 (1 + 64x2)
    // + 229 message (1+3+1 + 6x32 + 32) + 917 instructions (1 + 1 + 1 + 4 indices
    // + 2 data len + 908 data) + 1 empty ALT = 1276 — 44 over the packet
    expect(b.messageBytes).toBe(1276);
    expect(b.overflowBytes).toBe(44);
    expect(b.warnings).toEqual([
      'transaction exceeds the 1232-byte packet by 44 bytes; stage the bytecode (execute_from_account), use address lookup tables, or trim bytecode',
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
    // BOTH metas; no appended signer — the payer ref is one) + 1 data len + 108 data) + 1 empty ALT
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
    // + 239 instructions (1 + 1 + 1 + 127 indices + 1 data len + 108 data) + 1 empty ALT
    expect(b.messageBytes).toBe(4439);
  });

  it('per-table index-count prefix grows to 2 bytes at 128 ALT-resolved addresses', () => {
    const b = estimatePacket(planWith(130), 100, { lookupTables: 1, lookupAddresses: 128 });

    // 65 signatures + 261 message (1+3+1 + 7x32 + 32) + 247 instructions
    // (1 + 1 + 2 (compact account count >= 128) + 134 indices + 1 data len + 108 data)
    // + 164 ALT (1 + 32 + 2 (compact index count >= 128) + 1 + 128 indices)
    expect(b.messageBytes).toBe(737);
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

describe('planner — estimatePacket staged mode', () => {
  // The plan shape a staged compile produces: reserved args (writable) at user
  // index 0 and the payer signer at index 1, then the user refs.
  const stagedPlan = (n: number): AccountPlan => ({
    metas: [
      { ref: 'args', writable: true, signer: false },
      { ref: 'payer', writable: false, signer: true },
      ...planWith(n).metas,
    ],
  });

  it('16 KB of bytecode fits trivially: data is disc + hash pin, not the program', () => {
    const b = estimatePacket(stagedPlan(0), 16 * 1024, { mode: 'staged' });

    expect(b.mode).toBe('staged');
    expect(b.bytecodeBytes).toBe(16384);
    expect(b.instructionDataBytes).toBe(40); // 8 discriminator + 32-byte content-hash pin
    expect(b.staticAccountKeys).toBe(7); // payer + program + buffer + 3 memory PDAs + args meta
    // 65 signatures + 261 message (1+3+1 + 7x32 + 32) + 50 instructions
    // (1 + 1 + 1 + 6 indices (buffer + 3 PDAs + args + payer) + 1 data len + 40 data) + 1 empty ALT
    expect(b.messageBytes).toBe(377);
    expect(b.overflowBytes).toBe(0);
    expect(b.accountLocks).toBe(7);
    expect(b.stagingTxs).toBe(20); // 1 init + 17 writes + 1 finalize + 1 execute
    expect(b.warnings).toEqual([]);
  });

  it('pins the staging tx totals: 8/12/20 for 4/8/16 KB', () => {
    expect(stagingTransactionCount(4 * 1024)).toBe(8);
    expect(stagingTransactionCount(8 * 1024)).toBe(12);
    expect(stagingTransactionCount(16 * 1024)).toBe(20);
    expect(estimatePacket(stagedPlan(0), 4 * 1024, { mode: 'staged' }).stagingTxs).toBe(8);
    expect(estimatePacket(stagedPlan(0), 8 * 1024, { mode: 'staged' }).stagingTxs).toBe(12);
  });

  it('warns past the 65,535-byte buffer capacity — the staged code ceiling', () => {
    const b = estimatePacket(stagedPlan(0), 70_000, { mode: 'staged' });

    expect(b.warnings).toEqual(['bytecode (70000 bytes) exceeds the staged buffer capacity of 65535 bytes']);
  });

  it('inline vs staged on the same oversized program: only inline overflows the packet', () => {
    const plan = stagedPlan(2);
    const inline = estimatePacket(plan, 5_000);
    const staged = estimatePacket(plan, 5_000, { mode: 'staged' });

    expect(inline.overflowBytes).toBeGreaterThan(0);
    expect(staged.overflowBytes).toBe(0);
    expect(staged.instructionDataBytes).toBe(40);
  });

  it('account locks still warn in staged mode (the buffer adds one)', () => {
    const b = estimatePacket(stagedPlan(58), 100, { mode: 'staged', lookupTables: 1, lookupAddresses: 58 });

    // 6 fixed (incl. buffer) + args + 58 ALT-resolved user metas = 65 locks,
    // with the keys shifted out of the static section so only the lock cap warns.
    expect(b.accountLocks).toBe(65);
    expect(b.warnings).toEqual(['account locks (65) exceed the runtime cap of 64']);
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
        /^transaction exceeds the 1232-byte packet by \d+ bytes; stage the bytecode \(execute_from_account\), use address lookup tables, or trim bytecode$/,
      ),
    ]);
  });

  it('the same oversized program compiles warning-free as staged', () => {
    const body = Array.from({ length: 250 }, (_, i) => `storage.tWrite(${i}, 42);`).join('\n');
    const r = compile(`function main() { ${body} }`, { target: 'svm', staged: true });

    expect(r.warnings).toEqual([]);
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
