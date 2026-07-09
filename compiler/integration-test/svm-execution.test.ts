/**
 * SVM engine execution through THIS compiler: `target: 'svm'` bytecode built by
 * compile() runs on the real SVM engine in LiteSVM — the SVM twin of the
 * cast/anvil cook() harness (utils.ts). Covers pure compute, accountData/
 * writeAccountData over account data, revert payloads, CPI (system transfer +
 * pre-flight catch) and the chain context divergences (MSG_SENDER = payer,
 * synthetic CHAIN_ID).
 *
 * Requires the engine .so built by cargo build-sbf (SAUCE_ENGINE_SO or the
 * sauce checkout's svm/target/deploy/engine.so). CI has no engine.so, so the
 * whole suite skips there — same pattern as the v12 suites.
 */
import { getAddressCodec } from '@solana/kit';
import { compile } from '../src/index.js';
import { canRunSvm, randomSvmAddress, startSvm, svmCook, svmHex, svmUint, SYSTEM_PROGRAM } from './svm-utils.js';
import type { SvmCookResult, SvmHarness } from './svm-utils.js';

const describeSvm = canRunSvm() ? describe : describe.skip;

const expectFail = (r: SvmCookResult): { revertData?: Uint8Array; err: string; logs: string[] } => {
  if (r.ok) throw new Error('expected the transaction to fail, but it succeeded');

  return r;
};

describeSvm('integration: svm pure compute', () => {
  let h: SvmHarness;

  beforeAll(async () => {
    h = await startSvm();
  });

  const cases: { name: string; src: string; expected: bigint }[] = [
    { name: 'arithmetic precedence', src: 'function main() { return 3 + 4 * 5 }', expected: 23n },
    { name: 'division and modulo', src: 'function main() { return (17 / 5) * 5 + (17 % 5) }', expected: 17n },
    { name: 'exponentiation', src: 'function main() { return 2 ** 10 }', expected: 1024n },
    {
      // Trailing zero byte in the 32-byte word — guards the return-data path
      // against trailing-zero truncation.
      name: 'scalar with trailing zero byte',
      src: 'function main() { return 256 }',
      expected: 256n,
    },
    { name: 'sqrt truncates', src: 'function main() { return Math.sqrt(10) }', expected: 3n },
    { name: 'mulDiv', src: 'function main() { return Math.mulDiv(100, 50, 25) }', expected: 200n },
    {
      name: 'mulDiv full precision (no intermediate overflow)',
      src: 'function main() { return Math.mulDiv(2 ** 255, 2, 2 ** 255) }',
      expected: 2n,
    },
    {
      name: 'negative intermediate (NEG encoding)',
      src: 'function main() { const a = -5; return a + 10 }',
      expected: 5n,
    },
    { name: 'bitwise and/or/xor', src: 'function main() { return (0xf0 & 0xff) | (0x0f ^ 0x03) }', expected: 0xfcn },
    { name: 'shifts', src: 'function main() { return (1 << 8) + (256 >> 4) }', expected: 272n },
    {
      // Ternaries must sit directly in an assignment (transpiler constraint).
      name: 'ternary',
      src: 'function main() { let x = 5 > 3 ? 20 : 30; let y = x > 10 ? x + 1 : 0; return y }',
      expected: 21n,
    },
    {
      name: 'if/else',
      src: 'function main() { let r = 0; if (5 > 3) { r = 1 } else { r = 2 } return r }',
      expected: 1n,
    },
    {
      name: 'for loop accumulation',
      src: 'function main() { let s = 0; for (let i = 0; i < 5; i++) { s += i } return s }',
      expected: 10n,
    },
    {
      // break/continue are not supported on the v12 dialect yet — plain while.
      name: 'while loop',
      src: 'function main() { let s = 0; let i = 0; while (i < 5) { s += i; i++ } return s }',
      expected: 10n,
    },
    {
      name: 'nested loops',
      src: 'function main() { let s = 0; for (let i = 0; i < 3; i++) { for (let j = 0; j < 4; j++) { s += 1 } } return s }',
      expected: 12n,
    },
    {
      name: 'function with params',
      src: 'function add(a, b) { return a + b }\nfunction main() { return add(3, 7) }',
      expected: 10n,
    },
    {
      name: 'nested function calls',
      src: 'function f(x) { return x + 1 }\nfunction g(x) { return x * 2 }\nfunction main() { return f(g(3)) }',
      expected: 7n,
    },
    {
      // Helpers with locals force distinct frame strides (SDUP depth paths).
      name: 'two helpers with locals (SDUP stride paths)',
      src: 'function inc(x) { const y = x + 1; return y }\nfunction dbl(x) { let z = x * 2; return z }\nfunction main() { let a = inc(3); let b = dbl(4); return a + b }',
      expected: 12n,
    },
    {
      name: 'unused call result dropped',
      src: 'function noise(x) { return x + 1 }\nfunction main() { noise(41); return 7 }',
      expected: 7n,
    },
    {
      name: 'string concat length',
      src: 'function main() { const a = "hello"; const b = "world"; return a.concat(b).length }',
      expected: 10n,
    },
    { name: 'string char code', src: 'function main() { const s = "abc"; return s[1] }', expected: 98n },
    {
      name: 'bytes slice',
      src: 'function main() { const b = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]); const s = b.slice(1, 3); return s.length * 256 + s[0] }',
      expected: 2n * 256n + 0xbbn,
    },
    {
      name: 'array literal index + loop sum',
      src: 'function main() { const arr = [1, 2, 3, 4, 5]; let s = 0; for (let i = 0; i < arr.length; i++) { s += arr[i] } return s }',
      expected: 15n,
    },
    {
      name: 'new Array + set index (NEW_ARRAY/SET_INDEX)',
      src: 'function main() { let a = new Array(3); a[1] = 99; return a[1] + a[0] }',
      expected: 99n,
    },
    {
      name: 'array compound assignment',
      src: 'function main() { let a = new Array(3); a[0] = 4; a[0] += 10; return a[0] }',
      expected: 14n,
    },
    {
      name: 'tuple field set (object literal)',
      src: 'function main() { let p = { x: 5, y: 9 }; p.x = 42; return p.x + p.y }',
      expected: 51n,
    },
    {
      name: 'abi encode/decode round-trip',
      src: 'function main() { const d = abi.decode(abi.encode(1, 2, 3), "uint256", "uint256", "uint256"); return d[0] + d[1] + d[2] }',
      expected: 6n,
    },
  ];

  for (const { name, src, expected } of cases) {
    it(name, async () => {
      expect(svmUint(await svmCook(h, src))).toBe(expected);
    });
  }

  it('compile-time args reach main (arg-prologue path)', async () => {
    const r = await svmCook(h, 'function main(a, b) { return a * b }', { args: [6n, 7n] });

    expect(svmUint(r)).toBe(42n);
  });
});

describeSvm('integration: svm accountData / writeAccountData', () => {
  let h: SvmHarness;

  beforeAll(async () => {
    h = await startSvm();
  });

  it('reads an [offset, len] slice of fixture bytes', async () => {
    const fixture = Uint8Array.from({ length: 64 }, (_, i) => i);
    const r = await svmCook(h, `function main() { return accountData('pool', 4, 8) }`, {
      accounts: [{ ref: 'pool', data: fixture }],
    });

    expect(svmHex(r)).toBe('0x0405060708090a0b');
  });

  it('decodes a 32-byte read to a scalar and computes on it', async () => {
    const fixture = new Uint8Array(64);
    fixture[31] = 42; // word at offset 0 = 42 (big-endian)
    const src = `function main() { const d = abi.decode(accountData('pool', 0, 32), "uint256"); return d[0] + 1 }`;
    const r = await svmCook(h, src, { accounts: [{ ref: 'pool', data: fixture }] });

    expect(svmUint(r)).toBe(43n);
  });

  it('indexes single bytes out of account data', async () => {
    const r = await svmCook(h, `function main() { const d = accountData('pool', 2, 3); return d[1] }`, {
      accounts: [{ ref: 'pool', data: Uint8Array.from([0, 0, 0xaa, 0xbb, 0xcc]) }],
    });

    expect(svmUint(r)).toBe(0xbbn);
  });

  it('out-of-bounds read fails the transaction', async () => {
    const r = await svmCook(h, `function main() { return accountData('pool', 60, 8) }`, {
      accounts: [{ ref: 'pool', data: new Uint8Array(64) }],
    });

    expectFail(r);
  });

  it('writeAccountData into ANY engine-owned account is refused (ProtectedAccount)', async () => {
    // Wave D: every engine-owned target is bytecode-unwritable, unconditionally
    // — that is what keeps finalized buffers unscribblable from any transaction.
    const r = await svmCook(h, `function main() { writeAccountData('vault', 40, Uint8Array.from([0xde, 0xad])) }`, {
      accounts: [{ ref: 'vault', data: new Uint8Array(64) }], // engine-owned by default
    });

    expect(expectFail(r).logs.join('\n')).toContain(`Program ${h.programId} invoke`);
  });

  it('writeAccountData to a foreign-owned writable account fails at the runtime wall', async () => {
    // The engine performs the write, then the runtime rejects the data
    // modification (the engine does not own the account) — so SSTORE has NO
    // effectively-writable target class on SVM; it stays in the ISA for fork
    // parity and a future sanctioned scratch class.
    const r = await svmCook(h, `function main() { writeAccountData('vault', 8, Uint8Array.from([0x01])) }`, {
      accounts: [{ ref: 'vault', data: new Uint8Array(64), owner: SYSTEM_PROGRAM }],
    });

    expectFail(r);
  });

  it('plan meta order IS the user-account index space (refs resolve by name, not position)', async () => {
    // First-use order interns 'a' at plan index 0 and 'b' at 1; the accounts
    // are PROVIDED in reversed order — each read must still hit its own
    // fixture, proving svmCook places metas by plan index, not list position.
    const src = `function main() { const a = accountData('a', 0, 1); const b = accountData('b', 0, 1); return a[0] * 256 + b[0] }`;
    const r = await svmCook(h, src, {
      accounts: [
        { ref: 'b', data: Uint8Array.from([0xbb]) },
        { ref: 'a', data: Uint8Array.from([0xaa]) },
      ],
    });

    expect(svmUint(r)).toBe(0xaabbn);
  });

  it('raw positional indices map to the provided account order', async () => {
    // Raw mode: the plan is empty and the provided accounts ARE user indices
    // 0..n-1 in list order (the payer is appended after them). Each raw read
    // must hit its own fixture — the success-path proof of the raw mapping.
    const src =
      'function main() { const a = accountData(0, 0, 1); const b = accountData(1, 0, 1); return a[0] * 256 + b[0] }';
    const r = await svmCook(h, src, {
      accounts: [
        { ref: 'first', data: Uint8Array.from([0x11]) },
        { ref: 'second', data: Uint8Array.from([0x22]) },
      ],
    });

    expect(svmUint(r)).toBe(0x1122n);
  });

  it('raw-index write to a writable engine-owned account is refused too (same wall)', async () => {
    const vault = randomSvmAddress();
    const r = await svmCook(h, 'function main() { writeAccountData(0, 36, Uint8Array.from([0xbe, 0xef])) }', {
      accounts: [{ ref: 'vault', address: vault, data: new Uint8Array(48), writable: true }],
    });

    expectFail(r);
  });

  it('write to a non-writable account fails the transaction', async () => {
    // Raw index 0 = the first provided account, passed with a READONLY meta
    // (raw mode: the caller owns the ordering and the flags).
    const r = await svmCook(h, 'function main() { writeAccountData(0, 0, Uint8Array.from([0x01])) }', {
      accounts: [{ ref: 'target', data: new Uint8Array(8) }],
    });

    // Engine data-path errors all surface as InvalidInstructionData, so the
    // logs only pin that the failure happened inside the engine program.
    expect(expectFail(r).logs.join('\n')).toContain(`Program ${h.programId} invoke`);
  });
});

describeSvm('integration: svm uint / accountUint (CAST_LE 0x55)', () => {
  let h: SvmHarness;

  beforeAll(async () => {
    h = await startSvm();
  });

  it('accountUint reads a u64 LE field at a non-zero offset in ONE op (CAST_LE, never CAST_BE)', async () => {
    const src = `function main() { return accountUint('pool', 16, 8) }`;
    // The LE read must not lean on a byte-reverse + CAST_BE chain: the emitted
    // bytecode carries CAST_LE (0x55) and no CAST_BE (0x54) anywhere.
    const { bytecode } = compile(src, { target: 'svm' });

    expect(bytecode[0]).toContain(0x55);
    expect(bytecode[0]).not.toContain(0x54);

    const data = new Uint8Array(64);
    data.set([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01], 16); // 0x0102030405060708 stored LE

    const r = await svmCook(h, src, { accounts: [{ ref: 'pool', data }] });

    expect(svmUint(r)).toBe(0x0102030405060708n);
  });

  it('SPL-token amount pattern: u64 LE at offset 64 of a 165-byte account', async () => {
    // SPL token account layout: mint(32) + owner(32) + amount u64 LE at 64.
    const amount = 123_456_789n;
    const data = new Uint8Array(165);
    new DataView(data.buffer).setBigUint64(64, amount, true);

    const r = await svmCook(h, `function main() { return accountUint('token', 64, 8) }`, {
      accounts: [{ ref: 'token', data }],
    });

    expect(svmUint(r)).toBe(amount);
  });

  it('uint(bytes literal) diverges from v12 in EXACTLY the cast byte and evaluates LE on-chain', async () => {
    const src = 'function main() { return uint(Uint8Array.from([0x01, 0x02])) }';
    const svmBytes = compile(src, { target: 'svm' }).bytecode[0];
    const v12Bytes = compile(src, { target: 'v12' }).bytecode[0];

    // Same source, same shape — the ONLY diverging byte is the platform-native
    // cast: CAST_LE (0x55) on svm where v12 emits CAST_BE (0x54).
    expect(svmBytes.length).toBe(v12Bytes.length);
    const diffs = [...svmBytes].flatMap((b, i) => (b !== v12Bytes[i] ? [i] : []));
    expect(diffs).toHaveLength(1);
    expect(svmBytes[diffs[0]]).toBe(0x55);
    expect(v12Bytes[diffs[0]]).toBe(0x54);
    // byte[0] is least significant: [0x01, 0x02] → 0x0201 (0x0102 would mean a BE read).
    expect(svmUint(await svmCook(h, src))).toBe(0x0201n);
  });
});

describeSvm('integration: svm revert paths', () => {
  let h: SvmHarness;

  beforeAll(async () => {
    h = await startSvm();
  });

  it('throw with a payload: tx fails and revertData carries the payload', async () => {
    const r = await svmCook(h, 'function main() { throw "fail" }');

    expect(Buffer.from(expectFail(r).revertData ?? new Uint8Array()).toString('utf8')).toBe('fail');
  });

  it('minOut-style require: reverts under the floor, passes at it', async () => {
    const src = 'function main(out, minOut) { if (out < minOut) { throw "minOut" } return out }';
    const below = await svmCook(h, src, { args: [100n, 200n] });

    expect(Buffer.from(expectFail(below).revertData ?? new Uint8Array()).toString('utf8')).toBe('minOut');

    const at = await svmCook(h, src, { args: [200n, 200n] });

    expect(svmUint(at)).toBe(200n);
  });
});

describeSvm('integration: svm contract.call (CPI)', () => {
  let h: SvmHarness;

  beforeAll(async () => {
    h = await startSvm();
  });

  it('system transfer CPI moves lamports payer → recipient', async () => {
    const recipient = randomSvmAddress();
    const amount = 1_000_000n; // 0x0f4240
    // SystemInstruction::Transfer: u32 LE discriminant 2 + u64 LE lamports.
    // Target scalar 0 = 32 zero bytes = the system program id; the program's
    // account is attached via the unplanned 'system' ref (present in the user
    // list, never referenced by index).
    const src = `function main() {
      contract.call(0, Uint8Array.from([2, 0, 0, 0, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]), [
        { ref: 'payer', writable: true, signer: true },
        { ref: 'recipient', writable: true },
      ]);
    }`;
    // svmCook creates the recipient with 1 SOL, so the post-balance is
    // creation amount + transferred amount.
    const funded = 1_000_000_000n;
    const r = await svmCook(h, src, {
      accounts: [
        { ref: 'recipient', address: recipient, lamports: funded, owner: SYSTEM_PROGRAM },
        { ref: 'system', address: SYSTEM_PROGRAM },
      ],
    });

    expect(r.ok).toBe(true);
    expect(h.svm.getBalance(recipient)).toBe(funded + amount);
  });

  it("reserved 'payer' ref maps the payer into its PLAN slot, not appended", async () => {
    // Intern 'recipient' FIRST (plan index 0) with a zero-length read, so
    // 'payer' lands at plan index 1 — the CALL accounts array becomes [1, 0].
    // If the harness appended the payer instead of mapping it in place, user
    // index 1 would be the wrong account and the transfer could not move
    // lamports from the payer.
    const recipient = randomSvmAddress();
    const amount = 2_000_000n; // 0x1e8480
    const funded = 1_000_000_000n;
    const src = `function main() {
      accountData('recipient', 0, 0);
      contract.call(0, Uint8Array.from([2, 0, 0, 0, 0x80, 0x84, 0x1e, 0, 0, 0, 0, 0]), [
        { ref: 'payer', writable: true, signer: true },
        { ref: 'recipient', writable: true },
      ]);
    }`;
    const r = await svmCook(h, src, {
      accounts: [
        { ref: 'recipient', address: recipient, lamports: funded, owner: SYSTEM_PROGRAM },
        { ref: 'system', address: SYSTEM_PROGRAM },
      ],
    });

    expect(r.ok).toBe(true);
    expect(h.svm.getBalance(recipient)).toBe(funded + amount);
  });

  it('catch on a SUCCEEDING call skips the handler (transfer still lands)', async () => {
    // CATCH's success path SKIPS the handler bytes via the compiler-emitted
    // skip immediate — a wrong skip count would run the handler (r = 99) or
    // land mid-instruction and fail the tx.
    const recipient = randomSvmAddress();
    const amount = 3_000_000n; // 0x2dc6c0
    const funded = 1_000_000_000n;
    const src = `function main() {
      let r = 1;
      contract.call(0, Uint8Array.from([2, 0, 0, 0, 0xc0, 0xc6, 0x2d, 0, 0, 0, 0, 0]), [
        { ref: 'payer', writable: true, signer: true },
        { ref: 'recipient', writable: true },
      ]).catch(() => { r = 99; });
      return r;
    }`;
    const res = await svmCook(h, src, {
      accounts: [
        { ref: 'recipient', address: recipient, lamports: funded, owner: SYSTEM_PROGRAM },
        { ref: 'system', address: SYSTEM_PROGRAM },
      ],
    });

    expect(svmUint(res)).toBe(1n);
    expect(h.svm.getBalance(recipient)).toBe(funded + amount);
  });

  it('pre-flight failure (target program not attached): catch handler runs, tx ok', async () => {
    const src = `function main() {
      let r = 1;
      contract.call(7, Uint8Array.from([0xaa]), ['pool']).catch(() => { r = 42; });
      return r;
    }`;
    const res = await svmCook(h, src, { accounts: [{ ref: 'pool' }] });

    expect(svmUint(res)).toBe(42n);
  });
});

describeSvm('integration: svm chain context', () => {
  let h: SvmHarness;

  beforeAll(async () => {
    h = await startSvm();
  });

  it('msg.sender returns the payer address', async () => {
    const r = await svmCook(h, 'function main() { return msg.sender }');
    const payerBytes = getAddressCodec().encode(h.payer.address);

    expect(svmHex(r)).toBe('0x' + Buffer.from(payerBytes).toString('hex'));
  });

  it('block.chainId returns the synthetic devnet chain id', async () => {
    // Default (non-mainnet) engine build reports 1399811150.
    expect(svmUint(await svmCook(h, 'function main() { return block.chainId }'))).toBe(1399811150n);
  });
});
