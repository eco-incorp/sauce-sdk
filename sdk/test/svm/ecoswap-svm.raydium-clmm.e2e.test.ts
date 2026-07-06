/**
 * EcoSwapSVM Raydium CLMM e2e on the REAL engine (LiteSVM): the second CLMM
 * family — the in-VM tick walk against the dumped mainnet SOL/USDC 0.04% ts=1
 * pool 3ucNos4N... (snapshot slot ~431198953) through the production staged
 * path (hash-pinned buffer, packed cfg args, SPL-transfer stand-in CPIs paying
 * the predicted output).
 *
 * Cells:
 *   a. solo 0to1 (SOL -> USDC): the walk crosses real initialized ticks in-VM
 *      — LAMPORT-EXACT vs the solver mirror;
 *   b. solo 1to0 (direction flip on the same pool), exact;
 *   c. clmm+cp split: a synthetic raydium-cp pool absorbs the tail once the
 *      CLMM window saturates — both slots engaged, cut inside the merge, exact,
 *      under the CU cap (a CP co-slot is cheap; two CLMM slots are not — see f);
 *   d. drift/re-anchor: doctor sqrt_price/tick/liquidity, the SAME blob
 *      re-anchors on the live bytes, exact;
 *   f. 2-CLMM ALT PACKET cell (whirlpool + raydium-clmm): the raw v0 tx
 *      overflows 1,232 bytes; the ALT compresses it under the limit with locks
 *      <= 64 — NOT executed (two CLMM slots exceed the 1.4M CU cap; this is the
 *      packet-shape proof, the CU wall is the separate ceiling).
 *
 * Requires the engine .so; skips cleanly when absent.
 */
import { createHash } from 'node:crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { address, lamports } from '@solana/kit';
import type { Address, AddressesByLookupTableAddress } from '@solana/kit';
import {
  buildComputeBudgetPrepend,
  buildExecuteFromAccountInstruction,
  buildExecuteTransaction,
  buildHeapFramePrepend,
  deriveBufferPda,
  encodePayloadArgs,
  getTransactionSize,
  resolveAccounts,
} from '../../src/svm/index.js';
import type { AccountBytesMap, AccountLoader, AccountResolution, LadderSwapTemplate } from '../../src/svm/index.js';
import { fetchRaydiumClmmConfig } from '../../src/svm/venues/raydium-clmm/index.js';
import { raydiumClmmLadder, raydiumSqrtPriceAtTick } from '../../src/svm/venues/raydium-clmm/ladder.js';
import { fetchOrcaWhirlpoolConfig } from '../../src/svm/venues/orca-whirlpool/index.js';
import { orcaWhirlpoolLadder } from '../../src/svm/venues/orca-whirlpool/ladder.js';
import { raydiumCpSwap, raydiumCpSwapLadder } from '../../src/svm/index.js';
import {
  ecoSwapSvm,
  ecoSwapSvmPacketBudget,
  encodeEcoSwapSvmTrade,
  generateEcoSwapSvm,
  planLadders,
  quoteEcoSwapSvm,
  selectEcoSwapSvmAltAddresses,
  solveReference,
} from '../../src/recipes/ecoswap/svm/index.js';
import type { EcoSwapSvmOutput } from '../../src/recipes/ecoswap/svm/index.js';
import { describeSvm, fabricateAlt, loadFixtureAccounts, randomAddress, setTokenAccount, startEngine, tokenAmount } from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';
import { loadFixtures } from './fixtures.js';
import { synthesizeRaydiumCpPool, syntheticMintBytes, TOKENKEG, USDC_MINT, WSOL_MINT } from './ecoswap-svm.fixtures.js';
import { synthesizeWhirlpool } from './orca-whirlpool.fixtures.js';
import { decodeEcoTrade, execEcoTrade, stageEcoBlob } from './ecoswap-svm.harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const POOL = address('3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv');
const CLOCK = 1_783_175_236n;
const OUT_ATA_START = 5_000_000n;
const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };
const PACKET_LIMIT = 1232;

const standIn = (slot: number): LadderSwapTemplate => ({
  programId: TOKENKEG,
  prefix: Uint8Array.of(3),
  suffix: new Uint8Array(0),
  patch: 'out',
  accounts: [
    { ref: `sv${slot}`, writable: true },
    { ref: USER.outAta, writable: true },
    { ref: USER.owner, signer: true },
  ],
});

describeSvm('ecoswap-svm raydium-clmm e2e: live tick walk, split, drift, ALT packet', () => {
  let harness: EngineHarness;
  let liveLoader: AccountLoader;
  let bufferIndex = 0;

  const freshOutAta = (mint: Address): Address => setTokenAccount(harness, randomAddress(), mint, harness.payer.address, OUT_ATA_START);
  const freshVault = (mint: Address): Address => setTokenAccount(harness, randomAddress(), mint, harness.payer.address, 10n ** 15n);

  const setSynth = (accounts: { address: Address; owner: Address; data: Uint8Array }[]): void => {
    for (const a of accounts) {
      harness.svm.setAccount({
        address: a.address,
        data: a.data,
        executable: false,
        lamports: lamports(harness.svm.minimumBalanceForRentExemption(BigInt(a.data.length))),
        programAddress: a.owner,
        space: BigInt(a.data.length),
      });
    }
  };

  beforeAll(async () => {
    harness = await startEngine(CLOCK);
    loadFixtureAccounts(harness, loadFixtures(join(FIXTURES, 'raydium-clmm')));
    liveLoader = async (addr) => {
      const account = harness.svm.getAccount(addr);
      return account.exists ? new Uint8Array(account.data) : null;
    };
  });

  it('a. solo 0to1: the in-VM walk over real mainnet ticks is lamport-exact vs the mirror', async () => {
    const amountIn = 1_000_000_000n; // 1 SOL — inside the ts=1 window
    const output = await ecoSwapSvm({
      amountIn,
      minOut: 1n,
      pools: [{ venue: 'raydium-clmm', pool: POOL, swapOverride: standIn(0) }],
      user: USER,
      load: liveLoader,
      now: CLOCK,
    });
    expect(output.slots.map((s) => s.venue)).toEqual(['raydium-clmm']);
    expect(output.rungs).toEqual([2]);
    expect(output.quote.slices).toEqual([amountIn]);
    expect(output.quote.totalPredicted).toBe(81_759_001n);

    const outAta = freshOutAta(USDC_MINT);
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(harness, staged, output, { [USER.outAta]: outAta, sv0: freshVault(USDC_MINT) }, output.argValues);
    if (!result.ok) throw new Error(`trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.slices).toEqual(output.quote.slices);
    expect(words.predictedOuts).toEqual(output.quote.predictedOuts);
    expect(words.realized).toBe(output.quote.totalPredicted);
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + words.realized);
    console.log(`raydium-clmm solo 0to1: ${result.cu} CU (floor ${output.quote.estimatedCu})`);
  });

  it('b. solo 1to0: direction flip on the same pool, exact', async () => {
    const amountIn = 820_000_000n; // 820 USDC
    const output = await ecoSwapSvm({
      amountIn,
      minOut: 1n,
      pools: [{ venue: 'raydium-clmm', pool: POOL, direction: '1to0', swapOverride: standIn(0) }],
      user: USER,
      load: liveLoader,
      now: CLOCK,
    });
    expect(output.shapeKey).toContain('raydium-clmm:1to0');
    expect(output.quote.totalPredicted).toBe(10_021_166_496n);

    const outAta = freshOutAta(WSOL_MINT);
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(harness, staged, output, { [USER.outAta]: outAta, sv0: freshVault(WSOL_MINT) }, output.argValues);
    if (!result.ok) throw new Error(`1to0 trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.realized).toBe(output.quote.totalPredicted);
    console.log(`raydium-clmm solo 1to0: ${result.cu} CU`);
  });

  it('c. clmm+cp split: the CLMM saturates its window, the CP slot absorbs the tail — both engaged, exact', async () => {
    // A deep synthetic raydium-cp pool priced a touch WORSE than the CLMM spot,
    // so the CLMM wins the fine early rungs (inside its ts=1 window) and the CP
    // slot absorbs everything past the CLMM's ~10-SOL capacity.
    const cp = synthesizeRaydiumCpPool(10_000_000_000_000n, 780_000_000_000n, { mint0: WSOL_MINT, mint1: USDC_MINT });
    setSynth(cp.accounts);
    const amountIn = 100_000_000_000n; // 100 SOL: rung1 (50) fits the CLMM window, rung2 (100) exhausts -> CP tail
    const poolSpecs = [
      { venue: 'raydium-clmm' as const, pool: POOL, swapOverride: standIn(0) },
      { venue: 'raydium-cp-swap' as const, pool: cp.pool, swapOverride: standIn(1) },
    ];
    const output = await ecoSwapSvm({
      amountIn,
      minOut: 1n,
      pools: poolSpecs,
      user: USER,
      load: liveLoader,
      now: CLOCK,
      minRelBps: 0,
    });
    const plan = planLadders(poolSpecs.map((s) => ({ slug: s.venue })));
    expect(output.rungs).toEqual(plan.rungs);
    const quote = await quoteEcoSwapSvm({ amountIn, pools: poolSpecs, load: liveLoader, now: CLOCK, minRelBps: 0 });
    expect(quote.slices[0] > 0n && quote.slices[1] > 0n).toBe(true);
    expect(quote.slices[0] + quote.slices[1]).toBe(amountIn);

    const outAta = freshOutAta(USDC_MINT);
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(
      harness,
      staged,
      output,
      { [USER.outAta]: outAta, sv0: freshVault(USDC_MINT), sv1: freshVault(USDC_MINT) },
      output.encodeTrade(amountIn, quote.totalPredicted),
    );
    if (!result.ok) throw new Error(`split failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 2);
    expect(words.slices).toEqual(quote.slices);
    expect(words.predictedOuts).toEqual(quote.predictedOuts);
    expect(words.realized).toBe(quote.totalPredicted);
    expect(words.slices[0] > 0n && words.slices[1] > 0n).toBe(true);
    console.log(`clmm+cp split: ${result.cu} CU, slices ${words.slices.join('/')}`);
  });

  it('d. drift/re-anchor: doctor sqrt_price/tick/liquidity, the SAME blob re-anchors on the live bytes', async () => {
    const amountIn = 1_000_000_000n;
    const output = await ecoSwapSvm({
      amountIn,
      minOut: 1n,
      pools: [{ venue: 'raydium-clmm', pool: POOL, swapOverride: standIn(0) }],
      user: USER,
      load: liveLoader,
      now: CLOCK,
    });
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const original = new Uint8Array(harness.svm.getAccount(POOL).data);

    // Move the pool one tick down (a real swap's post-state): tick -25039.
    const drifted = new Uint8Array(original);
    const writeLE = (o: number, w: number, v: bigint): void => {
      for (let i = 0; i < w; i++) drifted[o + i] = Number((v >> BigInt(8 * i)) & 0xffn);
    };
    writeLE(253, 16, raydiumSqrtPriceAtTick(-25040));
    writeLE(269, 4, BigInt.asUintN(32, -25040n));
    const acc = harness.svm.getAccount(POOL);
    harness.svm.setAccount({ ...acc, address: POOL, data: drifted });

    const state: AccountBytesMap = {};
    for (const meta of output.accountPlan.metas) {
      if (meta.pubkey === undefined) continue;
      const d = await liveLoader(address(meta.pubkey));
      if (d) state[meta.pubkey] = d;
    }
    const cfg = await fetchRaydiumClmmConfig(liveLoader, POOL);
    const drift = solveReference(
      [{ quote: raydiumClmmLadder.referenceQuote(cfg, state, output.slots[0].params), rungs: output.rungs[0] }],
      amountIn,
    );

    const outAta = freshOutAta(USDC_MINT);
    const result = await execEcoTrade(harness, staged, output, { [USER.outAta]: outAta, sv0: freshVault(USDC_MINT) }, output.encodeTrade(amountIn, drift.totalPredicted));
    if (!result.ok) throw new Error(`drift trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.realized).toBe(drift.totalPredicted);
    expect(words.predictedOuts).toEqual(drift.predictedOuts);
    harness.svm.setAccount({ ...acc, address: POOL, data: original }); // restore
    console.log(`raydium-clmm drift: realized ${words.realized} (was 81_759_001)`);
  });

  it('e. negative-net tick cross (0to1): a crossed boundary with a large NEGATIVE liquidity_net exercises the two\'s-complement add path — lamport-exact', async () => {
    // 50 SOL crosses the first ts=1 boundary (-25039). Doctoring that boundary's
    // liquidity_net to a large NEGATIVE i128 makes the cross ADD |net| to L
    // (add_delta with liquidity_net.neg() under zero_for_one -> the Q128-raw
    // branch of the fragment/mirror crossing). Both read the net LIVE from the
    // tick array, so the doctored-negative walk must be wei-exact fragment==mirror.
    const amountIn = 50_000_000_000n; // 50 SOL — inside the window, crosses >= 1 boundary
    const output = await ecoSwapSvm({
      amountIn, minOut: 1n,
      pools: [{ venue: 'raydium-clmm', pool: POOL, swapOverride: standIn(0) }],
      user: USER, load: liveLoader, now: CLOCK,
    });
    const staged = await stageEcoBlob(harness, bufferIndex++, output);

    const cfg = await fetchRaydiumClmmConfig(liveLoader, POOL);
    const boundary = cfg.windows['0to1'].boundaries[0]; // tick -25039 (crossed at 50 SOL)
    const arr = address(cfg.windows['0to1'].tickArrays[boundary.arrayIndex]);
    const acc = harness.svm.getAccount(arr);
    const original = new Uint8Array(acc.data);
    const doctored = new Uint8Array(original);
    const cell = 44 + boundary.offset * 168 + 4; // OFF_TA_TICKS + offset*TICK_LEN + OFF_TICK_LIQ_NET
    const negNet = BigInt.asUintN(128, -500_000_000_000n); // liquidity_net = -5e11 (two's-complement i128)
    for (let i = 0; i < 16; i++) doctored[cell + i] = Number((negNet >> BigInt(8 * i)) & 0xffn);
    harness.svm.setAccount({ ...acc, address: arr, data: doctored });

    const state: AccountBytesMap = {};
    for (const meta of output.accountPlan.metas) {
      if (meta.pubkey === undefined) continue;
      const d = await liveLoader(address(meta.pubkey));
      if (d) state[meta.pubkey] = d;
    }
    const crossed = solveReference(
      [{ quote: raydiumClmmLadder.referenceQuote(cfg, state, output.slots[0].params), rungs: output.rungs[0] }],
      amountIn,
    );
    // The doctored negative net MUST move the quote (the boundary is genuinely
    // crossed — else the negative-net add path would be inert).
    expect(crossed.totalPredicted).toBeGreaterThan(0n);
    expect(crossed.totalPredicted).not.toBe(output.quote.totalPredicted);

    const outAta = freshOutAta(USDC_MINT);
    const result = await execEcoTrade(harness, staged, output, { [USER.outAta]: outAta, sv0: freshVault(USDC_MINT) }, output.encodeTrade(amountIn, crossed.totalPredicted));
    if (!result.ok) throw new Error(`neg-net trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.realized).toBe(crossed.totalPredicted);
    expect(words.predictedOuts).toEqual(crossed.predictedOuts);
    harness.svm.setAccount({ ...acc, address: arr, data: original }); // restore
    console.log(`raydium-clmm neg-net cross: realized ${words.realized} (undoctored ${output.quote.totalPredicted})`);
  });

  it('f. 2-CLMM (whirlpool + raydium-clmm) overflows the raw packet; the ALT fits it under 1,232, locks <= 64', async () => {
    // A synthetic whirlpool + the real raydium-clmm: two args-heavy CLMM slots
    // (16 cfg words each) push the raw v0 tx over 1,232 bytes. The ALT is the
    // packet remedy; two CLMM slots exceed the 1.4M CU cap so this cell proves
    // the packet shape only (not executed) — the documented combined ceiling.
    loadFixtureAccounts(harness, loadFixtures(join(FIXTURES, 'orca-whirlpool')));
    const whirl = synthesizeWhirlpool({
      mintA: WSOL_MINT, mintB: USDC_MINT, tickSpacing: 64, tickCurrentIndex: 0,
      liquidity: 5_000_000_000n, feeRate: 3000, ticks: [{ tick: -128, net: 5_000_000_000n }], arrayStarts: [0, -5632],
    });
    setSynth(whirl.accounts);
    for (const [mint, dec] of [[WSOL_MINT, 9], [USDC_MINT, 6]] as [Address, number][]) {
      if (!harness.svm.getAccount(mint).exists) setSynth([{ address: mint, owner: TOKENKEG, data: syntheticMintBytes(dec) }]);
    }
    // REAL swap templates (no stand-in): two args-heavy CLMM slots with their
    // full venue account sets are what overflows the 1,232-byte raw packet.
    const whirlCfg = await fetchOrcaWhirlpoolConfig(liveLoader, whirl.pool);
    const rayCfg = await fetchRaydiumClmmConfig(liveLoader, POOL);
    const output = generateEcoSwapSvm({
      slots: [
        { adapter: orcaWhirlpoolLadder, cfg: whirlCfg },
        { adapter: raydiumClmmLadder, cfg: rayCfg },
      ],
      user: USER,
      cuFloor: 1,
    });
    const args = [encodeEcoSwapSvmTrade(
      [{ params: orcaWhirlpoolLadder.paramsFor(whirlCfg) }, { params: raydiumClmmLadder.paramsFor(rayCfg) }],
      1_000_000n,
      0n,
    )] as const;

    const { address: buffer } = await deriveBufferPda(harness.programId, harness.payer.address, bufferIndex++);
    const outAta = setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, OUT_ATA_START);
    const inAta = setTokenAccount(harness, randomAddress(), WSOL_MINT, harness.payer.address, 10n ** 12n);
    const resolution: AccountResolution = { [USER.outAta]: outAta, [USER.inAta]: inAta };

    const buildTx = async (lookupTables?: AddressesByLookupTableAddress) => {
      const accounts = resolveAccounts(output.accountPlan, resolution, harness.payer.address);
      const exec = buildExecuteFromAccountInstruction({
        programId: harness.programId,
        buffer,
        accounts,
        expectedSha256: new Uint8Array(createHash('sha256').update(output.bytecode).digest()),
        args: encodePayloadArgs(output.argsLayout, args as unknown as string[]),
      });
      harness.svm.expireBlockhash();
      return buildExecuteTransaction({
        payer: harness.payer,
        instructions: [...buildComputeBudgetPrepend({ unitLimit: 1_400_000 }), buildHeapFramePrepend(), exec],
        latestBlockhash: { blockhash: harness.svm.latestBlockhash(), lastValidBlockHeight: 1_000_000n },
        lookupTables,
      });
    };
    const rawTx = await buildTx();
    const altAddresses = selectEcoSwapSvmAltAddresses(output, buffer, resolution, harness.payer.address);
    const altTx = await buildTx(fabricateAlt(harness, altAddresses));

    expect(getTransactionSize(rawTx)).toBeGreaterThan(PACKET_LIMIT);
    expect(getTransactionSize(altTx)).toBeLessThanOrEqual(PACKET_LIMIT);
    const budget = ecoSwapSvmPacketBudget(output, { resolution, payerAddress: harness.payer.address });
    expect(budget.raw.overflowBytes).toBeGreaterThan(0);
    expect(budget.withAlt!.overflowBytes).toBe(0);
    expect(budget.withAlt!.accountLocks).toBeLessThanOrEqual(64);
    console.log(`2-CLMM: raw ${getTransactionSize(rawTx)}B -> ALT ${getTransactionSize(altTx)}B, locks ${budget.withAlt!.accountLocks}`);
  });
});
