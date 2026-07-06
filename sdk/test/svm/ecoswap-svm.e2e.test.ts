/**
 * EcoSwapSVM end-to-end on the REAL engine (LiteSVM): the staged shape blob
 * executes the full live solver — read reserves in-VM, build the per-slot
 * quote ladders, run the k-way merge, patch each engaged slot's CPI
 * instruction data at runtime, one terminal realized-delta check — against
 * the raydium-cp-swap mainnet fixture plus a synthesized same-pair pumpswap
 * pool (see ecoswap-svm.fixtures.ts; the checked-in venue snapshots trade
 * different pairs, so the second WSOL/USDC pool is cloned with distinct
 * reserves — documented there).
 *
 * Venue binaries are NOT deployed (repo convention — see
 * solswap-best.e2e.test.ts): each slot's swap CPI is an SPL-token-transfer
 * STAND-IN paying exactly the slot's predicted output ({ patch: 'out' }),
 * through the same runtime calldata-patch path the real venue templates use
 * ({ patch: 'in' }, byte-identical codegen). Quotes, ladders, the merge and
 * the split are the production path against live account bytes.
 *
 * Cells:
 *   a. 2-venue split lands with both slots engaged;
 *   b. LAMPORT-EXACT gate: in-VM slices + predicted outs + realized total
 *      (returndata) == solver-reference over the same account bytes;
 *   c. drift/re-anchor: doctor one pool's reserves, re-execute the SAME
 *      staged blob with the SAME args — slices shift toward the deeper
 *      pool, still exact vs the reference on the new bytes;
 *   d. stage-once/trade-many: two more executes, different amountIn —
 *      different splits, both exact;
 *   e. minOut violation: typed revert BEFORE any CPI, nothing landed;
 *   f. efficiency: continuous water-fill (optimal.ts) vs the quantized
 *      result on the same state — loss reported, sanity-bounded;
 *   g. compute + size: full-trade CU against the 1.4M cap, blob bytes
 *      against the 65,535 staged capacity;
 *   h. adversarial 3-slot shape: two IDENTICAL pump clones tie on every
 *      rung (strict-> election keeps the earliest slot), the raydium/clone
 *      price order flips mid-merge, a clone-only trade finishes EXACTLY on
 *      a full-rung boundary (take == din[r] as remaining hits 0), and a
 *      dust trade drives the zero-capacity-rung / no-CPI-engaged path —
 *      every trade lamport-exact vs the reference.
 *
 * Requires the engine .so (SAUCE_ENGINE_SO or the sibling sauce checkout);
 * skips cleanly when absent.
 */
import { createHash } from 'node:crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { lamports } from '@solana/kit';
import type { Address } from '@solana/kit';
import { FailedTransactionMetadata } from 'litesvm';
import {
  buildComputeBudgetPrepend,
  buildExecuteFromAccountInstruction,
  buildFinalizeBufferInstruction,
  buildHeapFramePrepend,
  buildInitBufferInstructions,
  buildStagingPlan,
  buildWriteBufferInstruction,
  deriveBufferPda,
  encodePayloadArgs,
  getTransactionSize,
  pumpswapAdapter,
  pumpswapLadder,
  raydiumCpSwap,
  raydiumCpSwapLadder,
  resolveAccounts,
} from '../../src/svm/index.js';
import type { AccountLoader, LadderSwapTemplate, PumpswapPoolConfig } from '../../src/svm/index.js';
import {
  ecoSwapSvm,
  efficiencyLoss,
  encodeEcoSwapSvmTrade,
  quoteEcoSwapSvm,
  solveOptimal,
  solveReference,
} from '../../src/recipes/ecoswap/svm/index.js';
import type { EcoSwapSvmOutput, EcoSwapSvmPoolSpec } from '../../src/recipes/ecoswap/svm/index.js';
import {
  buildExecuteTransactionForHarness,
  describeSvm,
  loadFixtureAccounts,
  randomAddress,
  sendInstructions,
  setTokenAccount,
  startEngine,
  tokenAmount,
} from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';
import { loadFixtures } from './fixtures.js';
import {
  overlayLoader,
  RAYDIUM_POOL,
  synthesizePumpswapPool,
  TOKENKEG,
  USDC_MINT,
} from './ecoswap-svm.fixtures.js';
import type { SynthesizedPumpswapPool } from './ecoswap-svm.fixtures.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(bytes).digest());
const utf8 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

const AMOUNT_IN = 400_000_000n; // 0.4 SOL against ~1.8 + 3.2 SOL of CP depth
const OUT_ATA_START = 5_000_000n;
const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };

/** SPL-token transfer stand-in paying the slot's PREDICTED OUTPUT (patch: 'out'). */
const standIn = (slot: number): LadderSwapTemplate => ({
  programId: TOKENKEG,
  prefix: Uint8Array.of(3), // Transfer tag; amount u64 LE patched at runtime
  suffix: new Uint8Array(0),
  patch: 'out',
  accounts: [
    { ref: `sv${slot}`, writable: true },
    { ref: USER.outAta, writable: true },
    { ref: USER.owner, signer: true },
  ],
});

interface TradeWords {
  slices: bigint[];
  predictedOuts: bigint[];
  realized: bigint;
}

const decodeTrade = (returnData: Uint8Array, slots: number): TradeWords => {
  const word = (i: number): bigint => BigInt('0x' + Buffer.from(returnData.subarray(i * 32, (i + 1) * 32)).toString('hex'));
  expect(returnData).toHaveLength((2 * slots + 1) * 32);
  return {
    slices: Array.from({ length: slots }, (_, i) => word(i)),
    predictedOuts: Array.from({ length: slots }, (_, i) => word(slots + i)),
    realized: word(2 * slots),
  };
};

describeSvm('ecoswap-svm e2e: 2-venue live split on the real engine', () => {
  let harness: EngineHarness;
  let synth: SynthesizedPumpswapPool;
  let output: EcoSwapSvmOutput;
  let poolSpecs: EcoSwapSvmPoolSpec[];
  let buffer: Address;
  let outAta: Address;
  let liveLoader: AccountLoader;
  let baseline: TradeWords;
  let baselineCu = 0n;
  let baselineTxBytes = 0;

  const execTrade = async (args: readonly [`0x${string}`]) => {
    const accounts = resolveAccounts(output.accountPlan, { [USER.outAta]: outAta, sv0: standinVault(0), sv1: standinVault(1) }, harness.payer.address);
    const exec = buildExecuteFromAccountInstruction({
      programId: harness.programId,
      buffer,
      accounts,
      expectedSha256: output.sha256,
      args: encodePayloadArgs(output.argsLayout, args as unknown as string[]),
    });
    const tx = await buildExecuteTransactionForHarness(harness, [
      ...buildComputeBudgetPrepend({ unitLimit: 1_400_000 }),
      buildHeapFramePrepend(),
      exec,
    ]);
    const size = getTransactionSize(tx);
    const result = harness.svm.sendTransaction(tx);
    if (result instanceof FailedTransactionMetadata) {
      return {
        ok: false as const,
        err: String(result.err()),
        revertData: result.meta().returnData().data(),
        logs: result.meta().logs(),
      };
    }
    return { ok: true as const, returnData: result.returnData().data(), cu: result.computeUnitsConsumed(), txBytes: size, logs: result.logs() };
  };

  const vaults: Address[] = [];
  const standinVault = (slot: number): Address => vaults[slot];

  const liveQuoteFor = (pools: EcoSwapSvmPoolSpec[], amountIn: bigint) =>
    quoteEcoSwapSvm({ amountIn, pools, load: liveLoader });
  const liveQuote = (amountIn: bigint) => liveQuoteFor(poolSpecs, amountIn);

  beforeAll(async () => {
    harness = await startEngine(1_700_000_000n);

    // Universe: the raydium-cp mainnet fixture (~1.77 SOL / 144.7 USDC after
    // fee accumulators) + a synthesized same-pair pump pool, deeper and at a
    // marginally better spot (3.2 SOL / 262 USDC) so both venues earn slices.
    const rayFixtures = loadFixtures(join(FIXTURES, 'raydium-cp-swap'));
    const pumpFixtures = loadFixtures(join(FIXTURES, 'pumpswap'));
    synth = synthesizePumpswapPool(3_200_000_000n, 262_000_000n);

    loadFixtureAccounts(harness, [...rayFixtures, ...pumpFixtures]);
    for (const account of synth.accounts) {
      harness.svm.setAccount({
        address: account.address,
        data: account.data,
        executable: false,
        lamports: lamports(harness.svm.minimumBalanceForRentExemption(BigInt(account.data.length))),
        programAddress: account.owner,
        space: BigInt(account.data.length),
      });
    }
    outAta = setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, OUT_ATA_START);
    vaults.push(
      setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, 10n ** 12n),
      setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, 10n ** 12n),
    );

    liveLoader = async (addr) => {
      const account = harness.svm.getAccount(addr);
      return account.exists ? new Uint8Array(account.data) : null;
    };

    poolSpecs = [
      { venue: 'raydium-cp-swap', pool: RAYDIUM_POOL, swapOverride: standIn(0) },
      { venue: 'pumpswap', pool: synth.pool, direction: 'baseToQuote', swapOverride: standIn(1) },
    ];

    // Prepare against the SAME bytes the bank holds (fixtures + synth overlay).
    output = await ecoSwapSvm({
      amountIn: AMOUNT_IN,
      minOut: 1n,
      pools: poolSpecs,
      user: USER,
      load: overlayLoader([...rayFixtures, ...pumpFixtures], [synth]),
    });

    // Stage ONCE through the real buffer protocol; every trade below is one
    // execute_from_account instruction against this hash-pinned blob.
    const plan = buildStagingPlan(output.bytecode.length);
    ({ address: buffer } = await deriveBufferPda(harness.programId, harness.payer.address, 0));
    const shared = { programId: harness.programId, authority: harness.payer.address, buffer };
    let staged = await sendInstructions(
      harness,
      buildInitBufferInstructions({ programId: harness.programId, payer: harness.payer.address, buffer, index: 0, capacity: output.bytecode.length }),
    );
    if (!staged.ok) throw new Error(`init_buffer failed: ${staged.err}`);
    for (const chunk of plan.chunks) {
      staged = await sendInstructions(harness, [
        buildWriteBufferInstruction({ ...shared, offset: chunk.offset, chunk: output.bytecode.subarray(chunk.offset, chunk.offset + chunk.length) }),
      ]);
      if (!staged.ok) throw new Error(`write_buffer failed: ${staged.err}`);
    }
    staged = await sendInstructions(harness, [
      buildFinalizeBufferInstruction({ ...shared, length: output.bytecode.length, sha256: sha256(output.bytecode) }),
    ]);
    if (!staged.ok) throw new Error(`finalize_buffer failed: ${staged.err}`);
  });

  it('a. splits one swap across both venues in ONE instruction, minOut inclusive at the quote', async () => {
    // The fetch-time quote == the live quote (nothing drifted yet), and the
    // trade binds minOut exactly at the predicted total (inclusive pass).
    const quote = await liveQuote(AMOUNT_IN);
    expect(quote.slices).toEqual(output.quote.slices);
    expect(quote.totalPredicted).toBe(output.quote.totalPredicted);

    const result = await execTrade(output.encodeTrade(AMOUNT_IN, quote.totalPredicted));
    if (!result.ok) throw new Error(`trade failed: ${result.err}`);
    baseline = decodeTrade(result.returnData, 2);
    baselineCu = result.cu;
    baselineTxBytes = result.txBytes;

    expect(baseline.slices[0] > 0n && baseline.slices[1] > 0n).toBe(true); // both venues engaged
    expect(baseline.slices[0] + baseline.slices[1]).toBe(AMOUNT_IN); // conservation
    expect(baseline.realized).toBe(baseline.predictedOuts[0] + baseline.predictedOuts[1]);
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + baseline.realized);
  });

  it('b. LAMPORT-EXACT gate: in-VM slices and realized total == solver-reference on the same bytes', async () => {
    const quote = await liveQuote(AMOUNT_IN);
    expect(baseline.slices).toEqual(quote.slices);
    expect(baseline.predictedOuts).toEqual(quote.predictedOuts);
    expect(baseline.realized).toBe(quote.totalPredicted);
  });

  it('c. drift/re-anchor: same blob, SAME args — slices shift toward the deeper pool, still exact', async () => {
    // Doctor the pump pool's quote vault +50% USDC: deeper and better-priced.
    // The baseline args (minOut == the pre-drift total) still clear, because
    // the drift can only raise the pump output.
    const vault = harness.svm.getAccount(synth.quoteVault);
    if (!vault.exists) throw new Error('synth quote vault missing');
    const original = new Uint8Array(vault.data);
    const doctored = new Uint8Array(original);
    const view = new DataView(doctored.buffer);
    view.setBigUint64(64, (view.getBigUint64(64, true) * 3n) / 2n, true);
    harness.svm.setAccount({ ...vault, address: synth.quoteVault, data: doctored });

    const driftQuote = await liveQuote(AMOUNT_IN);
    const result = await execTrade(output.encodeTrade(AMOUNT_IN, output.quote.totalPredicted));
    if (!result.ok) throw new Error(`drift trade failed: ${result.err}`);
    const drift = decodeTrade(result.returnData, 2);

    // exact against the reference on the DOCTORED bytes
    expect(drift.slices).toEqual(driftQuote.slices);
    expect(drift.predictedOuts).toEqual(driftQuote.predictedOuts);
    expect(drift.realized).toBe(driftQuote.totalPredicted);
    // the split re-anchored at execute time: pump gained share, raydium shed it
    expect(drift.slices[1] > baseline.slices[1]).toBe(true);
    expect(drift.slices[0] < baseline.slices[0]).toBe(true);
    expect(drift.realized > baseline.realized).toBe(true);

    harness.svm.setAccount({ ...vault, address: synth.quoteVault, data: original }); // restore
  });

  it('d. stage-once/trade-many: different amountIn args on the same blob, each split exact', async () => {
    for (const amountIn of [100_000_000n, 250_000_000n]) {
      const quote = await liveQuote(amountIn);
      const result = await execTrade(output.encodeTrade(amountIn, quote.totalPredicted));
      if (!result.ok) throw new Error(`trade(${amountIn}) failed: ${result.err}`);
      const words = decodeTrade(result.returnData, 2);
      expect(words.slices).toEqual(quote.slices);
      expect(words.slices[0] + words.slices[1]).toBe(amountIn);
      expect(words.realized).toBe(quote.totalPredicted);
      expect(words.slices).not.toEqual(baseline.slices); // a different trade IS a different split
    }
  });

  it('e. minOut violation: typed "minOut" revert BEFORE any CPI, nothing landed', async () => {
    const before = tokenAmount(harness, outAta);
    const quote = await liveQuote(AMOUNT_IN);
    const result = await execTrade(output.encodeTrade(AMOUNT_IN, quote.totalPredicted + 1n));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(utf8(result.revertData)).toBe('minOut');
    expect(tokenAmount(harness, outAta)).toBe(before); // fully rolled back
  });

  it('f. efficiency: quantized ladder vs the continuous water-fill on the same live state', async () => {
    const rayCfg = await raydiumCpSwap.fetchPoolConfig(liveLoader, RAYDIUM_POOL);
    const pumpCfg: PumpswapPoolConfig = {
      ...(await pumpswapAdapter.fetchPoolConfig(liveLoader, synth.pool)),
      direction: 'baseToQuote',
    };
    const state: Record<string, Uint8Array> = {};
    for (const addr of [RAYDIUM_POOL, rayCfg.ammConfig, rayCfg.token0Vault, rayCfg.token1Vault, synth.baseVault, synth.quoteVault]) {
      const data = await liveLoader(addr);
      if (data === null) throw new Error(`missing live account ${addr}`);
      state[addr] = data;
    }
    const slots = [
      { adapter: raydiumCpSwapLadder, cfg: rayCfg, params: raydiumCpSwapLadder.paramsFor(rayCfg) },
      { adapter: pumpswapLadder, cfg: pumpCfg, params: pumpswapLadder.paramsFor(pumpCfg) },
    ];
    const venues = slots.map(({ adapter, cfg, params }) => ({
      ...adapter.depthReserves(cfg, state),
      ...adapter.continuousFees(cfg, state, params),
      quote: adapter.referenceQuote(cfg, state, params),
    }));

    const optimal = solveOptimal(venues, AMOUNT_IN);
    const quantized = solveReference(venues.map((v) => ({ quote: v.quote })), AMOUNT_IN);
    const loss = efficiencyLoss(optimal.totalOut, quantized.totalPredicted);
    console.log(
      `efficiency: optimal ${optimal.totalOut} (slices ${optimal.slices.join('/')})` +
        ` vs quantized ${quantized.totalPredicted} (slices ${quantized.slices.join('/')})` +
        ` — loss ${(loss * 100).toFixed(3)}% (QL_S=4 rungs; trade is ~23%/12% of the two pools' depth)`,
    );
    // Measured ~0.63% on this deliberately shallow fixture universe (the
    // trade is a double-digit share of both pools); deep production pools sit
    // orders of magnitude lower. Bound it at the brief's 1%.
    expect(loss).toBeLessThan(0.01);
    expect(loss).toBeGreaterThan(-0.005);
  });

  it('g. compute + size: full 2-venue trade CU under the 1.4M cap with headroom; blob under 65,535', async () => {
    console.log(
      `full trade: ${baselineCu} CU (cap 1,400,000) — ` +
        `blob ${output.bytecode.length} bytes (staged cap 65,535), execute tx ${baselineTxBytes} bytes, ` +
        `args ${output.cfgByteLength} bytes in one packed cfg slot`,
    );
    // Measured ~842k for the 2-venue trade (the interpreter's per-op cost
    // dominates) — the CU budgeter's per-family coefficients live in
    // budget.ts and are re-measured by ecoswap-svm.cu.e2e.test.ts. Pinned
    // with ~19% headroom so a CU regression fails loudly here before it
    // walls multi-slot trades on-cluster.
    expect(baselineCu).toBeGreaterThan(0n);
    expect(baselineCu).toBeLessThan(1_000_000n);
    expect(output.bytecode.length).toBeLessThan(65_535);
    expect(baselineTxBytes).toBeLessThanOrEqual(1232);
  });

  it('h. adversarial 3-slot shape: rung ties, mid-merge flips, a full-rung boundary finish, dust — all exact', async () => {
    // Universe: the raydium fixture + TWO pump clones with IDENTICAL
    // reserves. Identical ladders tie on every rung, so the strict-> election
    // (dOut_c·dIn_b > dOut_b·dIn_c) must keep the earliest slot each step —
    // an off-by-one in the scan order or a >= comparison shifts lamports to
    // the later clone and the exactness gate below catches it.
    const cloneA = synthesizePumpswapPool(2_400_000_000n, 195_000_000n);
    const cloneB = synthesizePumpswapPool(2_400_000_000n, 195_000_000n);
    for (const clone of [cloneA, cloneB]) {
      for (const account of clone.accounts) {
        harness.svm.setAccount({
          address: account.address,
          data: account.data,
          executable: false,
          lamports: lamports(harness.svm.minimumBalanceForRentExemption(BigInt(account.data.length))),
          programAddress: account.owner,
          space: BigInt(account.data.length),
        });
      }
    }
    const outAtaH = setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, OUT_ATA_START);
    const vaultsH = [
      setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, 10n ** 12n),
      setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, 10n ** 12n),
      setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, 10n ** 12n),
    ];

    const hPools: EcoSwapSvmPoolSpec[] = [
      { venue: 'raydium-cp-swap', pool: RAYDIUM_POOL, swapOverride: standIn(0) },
      { venue: 'pumpswap', pool: cloneA.pool, direction: 'baseToQuote', swapOverride: standIn(1) },
      { venue: 'pumpswap', pool: cloneB.pool, direction: 'baseToQuote', swapOverride: standIn(2) },
    ];
    const outputH = await ecoSwapSvm({ amountIn: 400_000_000n, minOut: 1n, pools: hPools, user: USER, load: liveLoader });
    expect(outputH.slots.map((s) => s.pool)).toEqual([RAYDIUM_POOL, cloneA.pool, cloneB.pool]);

    // Stage the 3-slot blob ONCE at buffer index 1; all three trades below
    // ride it with fresh args.
    const plan = buildStagingPlan(outputH.bytecode.length);
    const { address: bufferH } = await deriveBufferPda(harness.programId, harness.payer.address, 1);
    const shared = { programId: harness.programId, authority: harness.payer.address, buffer: bufferH };
    let staged = await sendInstructions(
      harness,
      buildInitBufferInstructions({ programId: harness.programId, payer: harness.payer.address, buffer: bufferH, index: 1, capacity: outputH.bytecode.length }),
    );
    if (!staged.ok) throw new Error(`init_buffer failed: ${staged.err}`);
    for (const chunk of plan.chunks) {
      staged = await sendInstructions(harness, [
        buildWriteBufferInstruction({ ...shared, offset: chunk.offset, chunk: outputH.bytecode.subarray(chunk.offset, chunk.offset + chunk.length) }),
      ]);
      if (!staged.ok) throw new Error(`write_buffer failed: ${staged.err}`);
    }
    staged = await sendInstructions(harness, [
      buildFinalizeBufferInstruction({ ...shared, length: outputH.bytecode.length, sha256: sha256(outputH.bytecode) }),
    ]);
    if (!staged.ok) throw new Error(`finalize_buffer failed: ${staged.err}`);

    const execH = async (args: readonly [`0x${string}`]) => {
      const accounts = resolveAccounts(
        outputH.accountPlan,
        { [USER.outAta]: outAtaH, sv0: vaultsH[0], sv1: vaultsH[1], sv2: vaultsH[2] },
        harness.payer.address,
      );
      const exec = buildExecuteFromAccountInstruction({
        programId: harness.programId,
        buffer: bufferH,
        accounts,
        expectedSha256: outputH.sha256,
        args: encodePayloadArgs(outputH.argsLayout, args as unknown as string[]),
      });
      const tx = await buildExecuteTransactionForHarness(harness, [
        ...buildComputeBudgetPrepend({ unitLimit: 1_400_000 }),
        buildHeapFramePrepend(),
        exec,
      ]);
      const result = harness.svm.sendTransaction(tx);
      if (result instanceof FailedTransactionMetadata) {
        throw new Error(`adversarial trade failed: ${String(result.err())}\n${result.meta().logs().join('\n')}`);
      }
      return { returnData: result.returnData().data(), cu: result.computeUnitsConsumed() };
    };

    // Trade 1: all three enabled. Raydium's better spot wins early rungs,
    // the deeper clones win later ones (the election flips mid-merge), and
    // the clone ties resolve to the earlier slot — pinned [100e6, 200e6,
    // 100e6] on these reserves, asserted lamport-exact vs the live mirror.
    const q1 = await liveQuoteFor(hPools, 400_000_000n);
    const r1 = await execH(outputH.encodeTrade(400_000_000n, q1.totalPredicted));
    const t1 = decodeTrade(r1.returnData, 3);
    expect(t1.slices).toEqual(q1.slices);
    expect(t1.predictedOuts).toEqual(q1.predictedOuts);
    expect(t1.realized).toBe(q1.totalPredicted);
    expect(t1.slices[0] + t1.slices[1] + t1.slices[2]).toBe(400_000_000n);
    expect(t1.slices.every((slice) => slice > 0n)).toBe(true); // the flip engaged all three
    expect(t1.slices[1] >= t1.slices[2]).toBe(true); // ties keep the earlier clone ahead
    expect(tokenAmount(harness, outAtaH)).toBe(OUT_ATA_START + t1.realized);
    console.log(`adversarial 3-slot trade: ${r1.cu} CU (cap 1,400,000), slices ${t1.slices.join('/')}`);

    // Trade 2: raydium DISABLED per-trade (born exhausted; its accounts stay
    // attached for the unconditional setup reads). 512e6 over the two
    // identical clones alternates rungs to an exact 50/50, the merge
    // finishing on a FULL rung (take == din[r] exactly as remaining hits 0 —
    // pointer advance and loop exit coincide). The disabled slot's reference
    // quote throws if touched: disabled means NEVER quoted, on both sides.
    const pumpState: Record<string, Uint8Array> = {};
    for (const addr of [cloneA.baseVault, cloneA.quoteVault, cloneB.baseVault, cloneB.quoteVault]) {
      const data = await liveLoader(addr);
      if (data === null) throw new Error(`missing clone vault ${addr}`);
      pumpState[addr] = data;
    }
    const cloneQuote = async (clone: SynthesizedPumpswapPool, params: readonly bigint[]) => {
      const cfg: PumpswapPoolConfig = {
        ...(await pumpswapAdapter.fetchPoolConfig(liveLoader, clone.pool)),
        direction: 'baseToQuote',
      };
      return pumpswapLadder.referenceQuote(cfg, pumpState, params);
    };
    const q2 = solveReference(
      [
        { quote: () => { throw new Error('disabled slot must never be quoted'); }, enabled: false },
        { quote: await cloneQuote(cloneA, outputH.slots[1].params) },
        { quote: await cloneQuote(cloneB, outputH.slots[2].params) },
      ],
      512_000_000n,
    );
    expect(q2.slices).toEqual([0n, 256_000_000n, 256_000_000n]); // exact tie alternation, boundary finish
    const r2 = await execH([
      encodeEcoSwapSvmTrade(
        [
          { params: outputH.slots[0].params, enabled: false },
          { params: outputH.slots[1].params },
          { params: outputH.slots[2].params },
        ],
        512_000_000n,
        q2.totalPredicted,
      ),
    ]);
    const t2 = decodeTrade(r2.returnData, 3);
    expect(t2.slices).toEqual(q2.slices);
    expect(t2.predictedOuts).toEqual(q2.predictedOuts);
    expect(t2.realized).toBe(q2.totalPredicted);

    // Trade 3: dust. amountIn = 3 quantizes to zero-capacity leading rungs
    // (grid 0/0/1/3); every venue quotes 0, so no CPI is engaged and the
    // realized delta is 0 — the trade still lands (minOut 0) and returns the
    // exact degenerate split.
    const q3 = await liveQuoteFor(hPools, 3n);
    expect(q3.totalPredicted).toBe(0n);
    const before3 = tokenAmount(harness, outAtaH);
    const r3 = await execH(outputH.encodeTrade(3n, 0n));
    const t3 = decodeTrade(r3.returnData, 3);
    expect(t3.slices).toEqual(q3.slices);
    expect(t3.slices[0] + t3.slices[1] + t3.slices[2]).toBe(3n);
    expect(t3.realized).toBe(0n);
    expect(tokenAmount(harness, outAtaH)).toBe(before3); // nothing landed, nothing lost
  });
});
