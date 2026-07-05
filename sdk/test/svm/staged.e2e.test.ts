/**
 * Staged execution end-to-end on LiteSVM: the full buffer lifecycle through
 * the sdk's pure builders (init_buffer → chunked write_buffer → finalize_buffer
 * → execute_from_account → close_buffer), the same-tx args pattern (stage once,
 * execute many with different args), the hash-pin trust anchor, and the whole
 * point of staging — a program too large for the 1232-byte packet running from
 * a buffer.
 *
 * Requires the engine .so (SAUCE_ENGINE_SO or the sibling sauce checkout);
 * skips cleanly when absent (same gate as the other engine-bound suites).
 */
import { createHash } from 'node:crypto';
import { generateKeyPairSigner, lamports } from '@solana/kit';
import type { Address, Instruction } from '@solana/kit';
import { compile } from '@eco-incorp/sauce-compiler';
import {
  buildArgsWriteInstruction,
  buildCloseBufferInstruction,
  buildCloseMemoryInstruction,
  buildComputeBudgetPrepend,
  buildExecuteFromAccountInstruction,
  buildExecuteInstruction,
  buildExecuteTransaction,
  buildFinalizeBufferInstruction,
  buildInitBufferInstructions,
  buildInitInstructions,
  buildStagingPlan,
  buildWriteBufferInstruction,
  deriveBufferPda,
  deriveEnginePdas,
  getTransactionSize,
  resolveAccounts,
} from '../../src/svm/index.js';
import type { StagedArgs } from '../../src/svm/index.js';
import {
  buildExecuteTransactionForHarness,
  describeSvm,
  expectFail,
  expectOk,
  sendInstructions,
  startEngine,
  toBigInt,
} from './engine-harness.js';
import type { EngineHarness, RunResult } from './engine-harness.js';

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(bytes).digest());

/** Stages `bytecode` into buffer `index` through the real staging protocol; returns its address. */
const stageBytecode = async (harness: EngineHarness, index: number, bytecode: Uint8Array): Promise<Address> => {
  const plan = buildStagingPlan(bytecode.length);
  const { address: buffer } = await deriveBufferPda(harness.programId, harness.payer.address, index);
  const shared = { programId: harness.programId, authority: harness.payer.address, buffer };

  // init tx (all growth steps pack into one), then one tx per chunk, then the
  // DEDICATED finalize tx — every tx must clear the 1232-byte wire cap.
  const initInstructions = buildInitBufferInstructions({
    programId: harness.programId,
    payer: harness.payer.address,
    buffer,
    index,
    capacity: bytecode.length,
  });
  expect(initInstructions).toHaveLength(plan.initInstructionCount);
  expectOk(await sendInstructions(harness, initInstructions));

  for (const chunk of plan.chunks) {
    const write = buildWriteBufferInstruction({
      ...shared,
      offset: chunk.offset,
      chunk: bytecode.subarray(chunk.offset, chunk.offset + chunk.length),
    });
    const transaction = await buildExecuteTransactionForHarness(harness, [write]);
    expect(getTransactionSize(transaction)).toBeLessThanOrEqual(1232);
    expectOk(await sendInstructions(harness, [write]));
  }

  expectOk(await sendInstructions(harness, [buildFinalizeBufferInstruction({ ...shared, length: bytecode.length, sha256: sha256(bytecode) })]));

  return buffer;
};

const executeStaged = async (
  harness: EngineHarness,
  buffer: Address,
  accounts: ReturnType<typeof resolveAccounts>,
  opts: { pin?: Uint8Array; args?: StagedArgs } = {},
): Promise<RunResult> => {
  // Generous CU limit — the default 200K/tx starves multi-KB staged programs.
  const instructions: Instruction[] = [...buildComputeBudgetPrepend({ unitLimit: 1_400_000 })];

  if (opts.args) {
    instructions.push(
      buildArgsWriteInstruction({
        programId: harness.programId,
        pdas: harness.pdas,
        payer: harness.payer.address,
        layout: opts.args.layout,
        values: opts.args.values,
      }),
    );
  }

  instructions.push(
    buildExecuteFromAccountInstruction({
      programId: harness.programId,
      buffer,
      pdas: harness.pdas,
      accounts,
      expectedSha256: opts.pin,
    }),
  );

  return sendInstructions(harness, instructions);
};

describeSvm('staged e2e: buffer lifecycle (stage 4 KB → execute_from_account → close)', () => {
  let harness: EngineHarness;

  beforeAll(async () => {
    harness = await startEngine(1_700_000_000n);
  });

  it('stages a ~4 KB program in the pinned 8-tx protocol, executes it, and closes for a full refund', async () => {
    // A ~4 KB straight-line program: n x [BYTE_1 42][SDROP], then BYTE_2 0xBEEF, STOP.
    const filler = Array.from({ length: 1364 }, () => [0x01, 0x2a, 0xe0]).flat();
    const bytecode = new Uint8Array([...filler, 0x02, 0xbe, 0xef, 0x00]);
    expect(bytecode.length).toBeGreaterThan(4000);
    expect(buildStagingPlan(bytecode.length).transactions.total).toBe(8);

    const buffer = await stageBytecode(harness, 0, bytecode);
    // no plan refs: the payer signer is all the tail needs
    const accounts = resolveAccounts({ metas: [] }, {}, harness.payer.address);

    const result = expectOk(await executeStaged(harness, buffer, accounts, { pin: sha256(bytecode) }));
    expect(toBigInt(result.returnData)).toBe(0xbeefn);

    // close: rent lands back on the payer, the account is reaped
    const before = harness.svm.getBalance(harness.payer.address);
    const bufferLamports = harness.svm.getBalance(buffer);
    expect(bufferLamports).toBeGreaterThan(0n);
    expectOk(
      await sendInstructions(harness, [
        buildCloseBufferInstruction({ programId: harness.programId, authority: harness.payer.address, buffer }),
      ]),
    );
    expect(harness.svm.getBalance(buffer) ?? 0n).toBe(0n); // reaped
    expect(harness.svm.getBalance(harness.payer.address)).toBe(before + bufferLamports - 5000n); // minus the tx fee
  });

  it('rejects a wrong 32-byte hash pin (BufferHashMismatch) — the cross-lifecycle trust anchor', async () => {
    const bytecode = new Uint8Array([0x01, 0x2a, 0x00]); // BYTE_1 42, STOP
    const buffer = await stageBytecode(harness, 1, bytecode);
    const accounts = resolveAccounts({ metas: [] }, {}, harness.payer.address);

    const wrongPin = sha256(bytecode);
    wrongPin[0] ^= 0xff;
    expectFail(await executeStaged(harness, buffer, accounts, { pin: wrongPin }));

    // the correct pin (and the pinless owner path) still execute
    expect(toBigInt(expectOk(await executeStaged(harness, buffer, accounts, { pin: sha256(bytecode) })).returnData)).toBe(42n);
    expect(toBigInt(expectOk(await executeStaged(harness, buffer, accounts)).returnData)).toBe(42n);
  });
});

describeSvm('staged e2e: the same-tx args pattern (stage once, execute many)', () => {
  let harness: EngineHarness;

  beforeAll(async () => {
    harness = await startEngine(1_700_000_000n);
  });

  it('one staged buffer serves different scalar args per execution', async () => {
    // Compile-time arg VALUES are placeholders — staged mode does not bake them.
    const { bytecode, accountPlan, argsLayout } = compile('function main(a, b) { return a * 1000000 + b }', {
      target: 'svm',
      staged: true,
      args: [0n, 0n],
    });
    const buffer = await stageBytecode(harness, 2, bytecode[0]);
    const accounts = resolveAccounts(accountPlan!, { args: harness.pdas.args.address }, harness.payer.address);
    const pin = sha256(bytecode[0]);

    const first = expectOk(
      await executeStaged(harness, buffer, accounts, { pin, args: { layout: argsLayout!, values: [7n, 5n] } }),
    );
    expect(toBigInt(first.returnData)).toBe(7_000_005n);

    // Same buffer, same tx shape, different args → different result.
    const second = expectOk(
      await executeStaged(harness, buffer, accounts, { pin, args: { layout: argsLayout!, values: [123n, 456n] } }),
    );
    expect(toBigInt(second.returnData)).toBe(123_000_456n);
  });

  it('mixed scalar + bytes args ride the same pattern', async () => {
    const { bytecode, accountPlan, argsLayout } = compile('function main(a, d) { return a + d[0] }', {
      target: 'svm',
      staged: true,
      args: [0n, '0x00'],
    });
    const buffer = await stageBytecode(harness, 3, bytecode[0]);
    const accounts = resolveAccounts(accountPlan!, { args: harness.pdas.args.address }, harness.payer.address);

    const result = expectOk(
      await executeStaged(harness, buffer, accounts, {
        pin: sha256(bytecode[0]),
        args: { layout: argsLayout!, values: [10n, '0x2a'] },
      }),
    );
    expect(toBigInt(result.returnData)).toBe(52n); // 10 + 0x2a
  });
});

describeSvm('memory onboarding e2e: the real 19-ix init, execute, close_memory refund', () => {
  it('onboards a fresh owner in ONE transaction, executes, and reclaims the full deposit', async () => {
    const harness = await startEngine(1_700_000_000n);
    const owner = await generateKeyPairSigner();
    harness.svm.airdrop(owner.address, lamports(10_000_000_000n));
    const pdas = await deriveEnginePdas(harness.programId, owner.address);

    const send = async (instructions: readonly Instruction[]) => {
      harness.svm.expireBlockhash();
      const transaction = await buildExecuteTransaction({
        payer: owner,
        instructions,
        latestBlockhash: { blockhash: harness.svm.latestBlockhash(), lastValidBlockHeight: 1_000_000n },
      });
      const result = harness.svm.sendTransaction(transaction);
      if ('err' in result && typeof result.err === 'function') throw new Error(String(result.err()));
    };

    // Full onboarding: 4 stack + 7 heap + 7 frames + 1 args = 19 instructions, one tx.
    const initInstructions = buildInitInstructions(harness.programId, pdas, owner.address);
    expect(initInstructions).toHaveLength(19);
    await send(initInstructions);

    // The freshly initialized set executes (the owner is the in-list signer).
    const accounts = resolveAccounts({ metas: [] }, {}, owner.address);
    const execute = buildExecuteInstruction({
      programId: harness.programId,
      pdas,
      bytecode: new Uint8Array([0x01, 0x2a, 0x00]), // BYTE_1 42, STOP
      accounts,
    });
    await send([execute]);

    // close_memory drains all four PDAs back to the owner (minus the tx fee).
    const deposit = [pdas.stack, pdas.heap, pdas.frames, pdas.args].reduce(
      (sum, pda) => sum + (harness.svm.getBalance(pda.address) ?? 0n),
      0n,
    );
    expect(deposit).toBeGreaterThan(1_000_000_000n); // ~1.2226 SOL rent deposit
    const before = harness.svm.getBalance(owner.address);
    await send([buildCloseMemoryInstruction({ programId: harness.programId, pdas, owner: owner.address })]);
    expect(harness.svm.getBalance(owner.address)).toBe(before + deposit - 5000n);
    expect(harness.svm.getBalance(pdas.stack.address) ?? 0n).toBe(0n);
    expect(harness.svm.getBalance(pdas.args.address) ?? 0n).toBe(0n);
  });
});

describeSvm('staged e2e: a program too large for the packet runs staged — the whole point', () => {
  let harness: EngineHarness;

  beforeAll(async () => {
    harness = await startEngine(1_700_000_000n);
  });

  it('a ~2.5 KB compiled program cannot ship inline (packet overflow) but executes from a buffer', async () => {
    // 500 statements over 250 distinct keys (the engine caps transient storage
    // at 256 keys; overwrites are free) — ~2.5 KB of bytecode.
    const body = Array.from({ length: 500 }, (_, i) => `storage.tWrite(${i % 250}, ${i + 1});`).join('\n');
    const src = `function main() { ${body} return storage.tRead(249) }`;
    const staged = compile(src, { target: 'svm', staged: true });
    expect(staged.bytecode[0].length).toBeGreaterThan(1232); // cannot fit a packet even bare

    // Inline impossibility, measured on the real wire encoding: the signed
    // inline-execute transaction exceeds the 1232-byte cap (LiteSVM has no
    // wire, so the size assertion IS the impossibility proof).
    const inline = compile(src, { target: 'svm' });
    expect(inline.warnings.join('\n')).toMatch(/exceeds the 1232-byte packet/);
    expect(staged.warnings).toEqual([]);

    const buffer = await stageBytecode(harness, 4, staged.bytecode[0]);
    const accounts = resolveAccounts(staged.accountPlan!, { args: harness.pdas.args.address }, harness.payer.address);

    const result = expectOk(
      await executeStaged(harness, buffer, accounts, { pin: sha256(staged.bytecode[0]) }),
    );
    expect(toBigInt(result.returnData)).toBe(500n);
  });
});
