/**
 * EcoSwapSVM Meteora DLMM e2e on the REAL engine (LiteSVM): the first BIN
 * family — the in-VM bin walk (with the live dynamic fee) against the dumped
 * mainnet SOL/USDC bin_step=4 pair 5rCf1DM8... (snapshot slot ~431198953)
 * through the production staged path (hash-pinned buffer, packed cfg args,
 * SPL-transfer stand-in CPIs paying the predicted output).
 *
 * Cells:
 *   a. solo xToY (SOL -> USDC, swap_for_y walks down): LAMPORT-EXACT vs mirror;
 *   b. solo yToX (USDC -> SOL, walks up), exact;
 *   c. dlmm+cp split: a synthetic raydium-cp pool priced ABOVE the DLMM spot
 *      wins the fine early rungs, the deep DLMM absorbs the tail — both slots
 *      engaged, exact, under the CU cap;
 *   d. drift/re-anchor: doctor active_id + the volatility state, the SAME blob
 *      re-anchors on the live bytes (the dynamic fee tracks the live vacc).
 *
 * The cluster clock is pinned PAST the pair's last_update so update_references
 * runs the normal decay path (the fragment reads block.timestamp). Requires the
 * engine .so; skips cleanly when absent.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { address, lamports } from '@solana/kit';
import type { Address } from '@solana/kit';
import { fetchMeteoraDlmmConfig } from '../../src/svm/venues/meteora-dlmm/index.js';
import { meteoraDlmmLadder } from '../../src/svm/venues/meteora-dlmm/ladder.js';
import type { AccountBytesMap, AccountLoader, LadderSwapTemplate } from '../../src/svm/index.js';
import { ecoSwapSvm, planLadders, quoteEcoSwapSvm, solveReference } from '../../src/recipes/ecoswap/svm/index.js';
import { describeSvm, loadFixtureAccounts, randomAddress, setTokenAccount, startEngine, tokenAmount } from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';
import { loadFixtures } from './fixtures.js';
import { synthesizeRaydiumCpPool, TOKENKEG, USDC_MINT, WSOL_MINT } from './ecoswap-svm.fixtures.js';
import { decodeEcoTrade, execEcoTrade, stageEcoBlob } from './ecoswap-svm.harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PAIR = address('5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6');
const CLOCK = 1_783_355_400n; // inside the decay window (+54s) — exercises the live variable fee
const OUT_ATA_START = 5_000_000n;
const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };

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

describeSvm('ecoswap-svm meteora-dlmm e2e: live bin walk, dynamic fee, split, drift', () => {
  let harness: EngineHarness;
  let liveLoader: AccountLoader;
  let bufferIndex = 0;

  const freshOutAta = (mint: Address): Address => setTokenAccount(harness, randomAddress(), mint, harness.payer.address, OUT_ATA_START);
  const freshVault = (mint: Address): Address => setTokenAccount(harness, randomAddress(), mint, harness.payer.address, 10n ** 15n);
  const setSynth = (accounts: { address: Address; owner: Address; data: Uint8Array }[]): void => {
    for (const a of accounts) {
      harness.svm.setAccount({
        address: a.address, data: a.data, executable: false,
        lamports: lamports(harness.svm.minimumBalanceForRentExemption(BigInt(a.data.length))),
        programAddress: a.owner, space: BigInt(a.data.length),
      });
    }
  };

  beforeAll(async () => {
    harness = await startEngine(CLOCK);
    loadFixtureAccounts(harness, loadFixtures(join(FIXTURES, 'meteora-dlmm')));
    liveLoader = async (addr) => {
      const account = harness.svm.getAccount(addr);
      return account.exists ? new Uint8Array(account.data) : null;
    };
  });

  it('a. solo xToY: the in-VM bin walk (dynamic fee) is lamport-exact vs the mirror', async () => {
    const amountIn = 5_000_000_000n; // 5 SOL
    const output = await ecoSwapSvm({
      amountIn, minOut: 1n,
      pools: [{ venue: 'meteora-dlmm', pool: PAIR, swapOverride: standIn(0) }],
      user: USER, load: liveLoader, now: CLOCK,
    });
    expect(output.slots.map((s) => s.venue)).toEqual(['meteora-dlmm']);
    expect(output.rungs).toEqual([2]);
    expect(output.quote.totalPredicted).toBe(408_662_622n);

    const outAta = freshOutAta(USDC_MINT);
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(harness, staged, output, { [USER.outAta]: outAta, sv0: freshVault(USDC_MINT) }, output.argValues);
    if (!result.ok) throw new Error(`trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.slices).toEqual(output.quote.slices);
    expect(words.predictedOuts).toEqual(output.quote.predictedOuts);
    expect(words.realized).toBe(output.quote.totalPredicted);
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + words.realized);
    console.log(`dlmm solo xToY: ${result.cu} CU (floor ${output.quote.estimatedCu})`);
  });

  it('b. solo yToX: direction flip on the same pair, exact', async () => {
    const amountIn = 1_000_000_000n; // 1000 USDC
    const output = await ecoSwapSvm({
      amountIn, minOut: 1n,
      pools: [{ venue: 'meteora-dlmm', pool: PAIR, direction: 'yToX', swapOverride: standIn(0) }],
      user: USER, load: liveLoader, now: CLOCK,
    });
    expect(output.shapeKey).toContain('meteora-dlmm:yToX');
    expect(output.quote.totalPredicted).toBe(12_220_302_614n);

    const outAta = freshOutAta(WSOL_MINT);
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(harness, staged, output, { [USER.outAta]: outAta, sv0: freshVault(WSOL_MINT) }, output.argValues);
    if (!result.ok) throw new Error(`yToX trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.realized).toBe(output.quote.totalPredicted);
    console.log(`dlmm solo yToX: ${result.cu} CU`);
  });

  it('c. dlmm+cp split: a CP pool priced above spot wins early, the deep DLMM absorbs the tail — both engaged, exact', async () => {
    // Shallow CP priced ~89 USDC/SOL (above the DLMM ~81.7 spot): its fine early
    // rungs beat the DLMM, and its price falls fast so the deep DLMM takes the tail.
    const cp = synthesizeRaydiumCpPool(1_000_000_000_000n, 89_000_000_000n, { mint0: WSOL_MINT, mint1: USDC_MINT });
    setSynth(cp.accounts);
    const amountIn = 100_000_000_000n; // 100 SOL
    const poolSpecs = [
      { venue: 'meteora-dlmm' as const, pool: PAIR, swapOverride: standIn(0) },
      { venue: 'raydium-cp-swap' as const, pool: cp.pool, swapOverride: standIn(1) },
    ];
    const output = await ecoSwapSvm({ amountIn, minOut: 1n, pools: poolSpecs, user: USER, load: liveLoader, now: CLOCK, minRelBps: 0 });
    const plan = planLadders(poolSpecs.map((s) => ({ slug: s.venue })));
    expect(output.rungs).toEqual(plan.rungs);
    const quote = await quoteEcoSwapSvm({ amountIn, pools: poolSpecs, load: liveLoader, now: CLOCK, minRelBps: 0 });
    expect(quote.slices[0] > 0n && quote.slices[1] > 0n).toBe(true);
    expect(quote.slices[0] + quote.slices[1]).toBe(amountIn);

    const outAta = freshOutAta(USDC_MINT);
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(
      harness, staged, output,
      { [USER.outAta]: outAta, sv0: freshVault(USDC_MINT), sv1: freshVault(USDC_MINT) },
      output.encodeTrade(amountIn, quote.totalPredicted),
    );
    if (!result.ok) throw new Error(`split failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 2);
    expect(words.slices).toEqual(quote.slices);
    expect(words.predictedOuts).toEqual(quote.predictedOuts);
    expect(words.realized).toBe(quote.totalPredicted);
    expect(words.slices[0] > 0n && words.slices[1] > 0n).toBe(true);
    console.log(`dlmm+cp split: ${result.cu} CU, slices ${words.slices.join('/')}`);
  });

  it('d. drift/re-anchor: doctor active_id + volatility state, the SAME blob re-anchors, exact', async () => {
    const amountIn = 5_000_000_000n;
    const output = await ecoSwapSvm({
      amountIn, minOut: 1n,
      pools: [{ venue: 'meteora-dlmm', pool: PAIR, swapOverride: standIn(0) }],
      user: USER, load: liveLoader, now: CLOCK,
    });
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const original = new Uint8Array(harness.svm.getAccount(PAIR).data);

    // Move active_id down one bin and bump the volatility accumulator — a real
    // post-swap state; the shipped bins behind the new active_id are skipped.
    // Offsets are ABSOLUTE (struct + 8 anchor disc): active_id@76 (struct 68),
    // volatility_accumulator@40 (struct 32) — matching OFF_ACTIVE_ID /
    // OFF_VOLATILITY_ACC the fragment and referenceQuote read.
    const drifted = new Uint8Array(original);
    const writeLE = (o: number, w: number, v: bigint): void => {
      for (let i = 0; i < w; i++) drifted[o + i] = Number((v >> BigInt(8 * i)) & 0xffn);
    };
    writeLE(76, 4, BigInt.asUintN(32, -6261n)); // active_id (abs 76)
    writeLE(40, 4, 20000n); // volatility_accumulator (abs 40)
    const acc = harness.svm.getAccount(PAIR);
    harness.svm.setAccount({ ...acc, address: PAIR, data: drifted });

    const state: AccountBytesMap = {};
    for (const meta of output.accountPlan.metas) {
      if (meta.pubkey === undefined) continue;
      const d = await liveLoader(address(meta.pubkey));
      if (d) state[meta.pubkey] = d;
    }
    const cfg = await fetchMeteoraDlmmConfig(liveLoader, PAIR);
    const drift = solveReference(
      [{ quote: meteoraDlmmLadder.referenceQuote(cfg, state, output.slots[0].params, CLOCK), rungs: output.rungs[0] }],
      amountIn,
    );
    // The doctored active_id + volatility state MUST move the quote — else the
    // doctor wrote inert bytes and the "drift" would be vacuous (guards the
    // absolute-offset regression that shipped writes at abs 84/48).
    expect(drift.totalPredicted).not.toBe(408_662_622n);

    const outAta = freshOutAta(USDC_MINT);
    const result = await execEcoTrade(harness, staged, output, { [USER.outAta]: outAta, sv0: freshVault(USDC_MINT) }, output.encodeTrade(amountIn, drift.totalPredicted));
    if (!result.ok) throw new Error(`drift trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.realized).toBe(drift.totalPredicted);
    expect(words.predictedOuts).toEqual(drift.predictedOuts);
    harness.svm.setAccount({ ...acc, address: PAIR, data: original }); // restore
    console.log(`dlmm drift: realized ${words.realized} (was 408_662_622)`);
  });

  it('e. empty middle bin: drain bin -6261 between liquid -6260 and -6262 — the walk crosses the gap, exact', async () => {
    // The active bin (-6260) holds thin liquidity, -6261 holds the bulk; draining
    // -6261 forces the 5-SOL input to skip the emptied middle bin and re-anchor to
    // the next liquid bin -6262 (a worse price). Both the in-VM fragment (live
    // amount read == 0 -> bin skipped) and the mirror walk the SAME gap; the fee of
    // -6262 is bin-id-derived (path-independent), so the split must be wei-exact.
    const amountIn = 5_000_000_000n;
    const output = await ecoSwapSvm({
      amountIn, minOut: 1n,
      pools: [{ venue: 'meteora-dlmm', pool: PAIR, swapOverride: standIn(0) }],
      user: USER, load: liveLoader, now: CLOCK,
    });
    const staged = await stageEcoBlob(harness, bufferIndex++, output);

    // Drain the middle shipped bin's out-side reserve (amount_y) in its bin array.
    const cfg = await fetchMeteoraDlmmConfig(liveLoader, PAIR);
    const mid = cfg.windows.xToY.bins[1]; // -6261
    expect(mid.binId).toBe(-6261);
    const arr = address(cfg.windows.xToY.binArrays[mid.arrayIndex]);
    const acc = harness.svm.getAccount(arr);
    const original = new Uint8Array(acc.data);
    const drained = new Uint8Array(original);
    const cell = 56 + mid.offset * 144 + 8; // OFF_BA_BINS + offset*BIN_LEN + OFF_BIN_AMOUNT_Y
    for (let i = 0; i < 8; i++) drained[cell + i] = 0;
    harness.svm.setAccount({ ...acc, address: arr, data: drained });

    const state: AccountBytesMap = {};
    for (const meta of output.accountPlan.metas) {
      if (meta.pubkey === undefined) continue;
      const d = await liveLoader(address(meta.pubkey));
      if (d) state[meta.pubkey] = d;
    }
    const gap = solveReference(
      [{ quote: meteoraDlmmLadder.referenceQuote(cfg, state, output.slots[0].params, CLOCK), rungs: output.rungs[0] }],
      amountIn,
    );
    // Draining -6261 MUST change the quote (input redirected across the gap).
    expect(gap.totalPredicted).not.toBe(408_662_622n);
    expect(gap.totalPredicted).toBeGreaterThan(0n);

    const outAta = freshOutAta(USDC_MINT);
    const result = await execEcoTrade(harness, staged, output, { [USER.outAta]: outAta, sv0: freshVault(USDC_MINT) }, output.encodeTrade(amountIn, gap.totalPredicted));
    if (!result.ok) throw new Error(`empty-bin trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.realized).toBe(gap.totalPredicted);
    expect(words.predictedOuts).toEqual(gap.predictedOuts);
    harness.svm.setAccount({ ...acc, address: arr, data: original }); // restore
    console.log(`dlmm empty-mid-bin: realized ${words.realized} (was 408_662_622)`);
  });
});
