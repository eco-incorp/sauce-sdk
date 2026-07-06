/**
 * EcoSwapSVM Whirlpools e2e on the REAL engine (LiteSVM): the first CLMM
 * family — the in-VM tick walk against the dumped mainnet SOL/USDC 0.04%
 * pool (fixtures/orca-whirlpool/, snapshot slot 431094837) and synthetic
 * shallow profiles, all through the production staged path (hash-pinned
 * buffer, packed cfg args, SPL-transfer stand-in CPIs paying the predicted
 * output).
 *
 * Cells:
 *   a. solo aToB, 1000 SOL: the walk crosses real initialized ticks in-VM —
 *      LAMPORT-EXACT vs the solver mirror (slices, predicted, realized);
 *   b. cp+whirlpool split: a shallow synthetic pumpswap pool prices better
 *      at spot, the whirlpool absorbs the tail — the cut lands INSIDE the
 *      tick window, both slots engaged, exact; budgeter-planned rungs match
 *      planLadders (deterministic degradation under the CLMM coefficients);
 *   c. re-execution determinism: same blob, same args, untouched state →
 *      byte-identical returndata;
 *   d. drift/re-anchor: doctor sqrt_price/tick/liquidity across one crossed
 *      boundary (a real swap's post-state), then across an ARRAY boundary —
 *      the SAME blob re-anchors on the live bytes, exact both times;
 *   e. window exhaustion: a shallow synthetic whirlpool clamps at its
 *      one-position capacity — the merge hands the tail to the CP slot,
 *      the whirlpool slice stays a rung inside its window, exact;
 *   f. solo bToA (direction flip on the same pool), exact.
 *
 * Requires the engine .so; skips cleanly when absent.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { address, lamports } from '@solana/kit';
import type { Address } from '@solana/kit';
import { readUintLE } from '../../src/svm/venues/math.js';
import { fetchOrcaWhirlpoolConfig } from '../../src/svm/venues/orca-whirlpool/index.js';
import { orcaWhirlpoolLadder, whirlpoolSqrtPriceAtTick } from '../../src/svm/venues/orca-whirlpool/ladder.js';
import { pumpswapAdapter, pumpswapLadder } from '../../src/svm/index.js';
import type { AccountBytesMap, AccountLoader, LadderSwapTemplate, PumpswapPoolConfig } from '../../src/svm/index.js';
import { ecoSwapSvm, planLadders, quoteEcoSwapSvm, solveReference } from '../../src/recipes/ecoswap/svm/index.js';
import type { EcoSwapSvmOutput, EcoSwapSvmPoolSpec } from '../../src/recipes/ecoswap/svm/index.js';
import { describeSvm, loadFixtureAccounts, randomAddress, setTokenAccount, startEngine, tokenAmount } from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';
import { loadFixtures } from './fixtures.js';
import { randomAddr, synthesizePumpswapPool, TOKENKEG, USDC_MINT, WSOL_MINT } from './ecoswap-svm.fixtures.js';
import { synthesizeWhirlpool } from './orca-whirlpool.fixtures.js';
import { decodeEcoTrade, execEcoTrade, stageEcoBlob } from './ecoswap-svm.harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const POOL = address('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE');
const CLOCK = 1_783_175_236n;
const AMOUNT_IN = 1_000_000_000_000n; // 1000 SOL — the walk crosses several real ticks
const OUT_ATA_START = 5_000_000n;
const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };

/** SPL-token transfer stand-in paying the slot's PREDICTED OUTPUT (patch: 'out'). */
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

describeSvm('ecoswap-svm whirlpool e2e: live tick walk, drift re-anchor, window exhaustion', () => {
  let harness: EngineHarness;
  let liveLoader: AccountLoader;
  let bufferIndex = 0;

  const freshOutAta = (mint: Address): Address => setTokenAccount(harness, randomAddress(), mint, harness.payer.address, OUT_ATA_START);
  const freshVault = (mint: Address): Address => setTokenAccount(harness, randomAddress(), mint, harness.payer.address, 10n ** 15n);

  /** Snapshot of every adapter-resolved plan account's LIVE bank bytes (for manual mirrors). */
  const planState = async (output: EcoSwapSvmOutput): Promise<AccountBytesMap> => {
    const state: AccountBytesMap = {};
    for (const meta of output.accountPlan.metas) {
      if (meta.pubkey === undefined) continue;
      const data = await liveLoader(address(meta.pubkey));
      if (data !== null) state[meta.pubkey] = data;
    }
    return state;
  };

  beforeAll(async () => {
    harness = await startEngine(CLOCK);
    loadFixtureAccounts(harness, loadFixtures(join(FIXTURES, 'orca-whirlpool')));
    loadFixtureAccounts(harness, loadFixtures(join(FIXTURES, 'pumpswap'))); // global/fee configs for synthetic pump pools
    liveLoader = async (addr) => {
      const account = harness.svm.getAccount(addr);
      return account.exists ? new Uint8Array(account.data) : null;
    };
  });

  it('a. solo aToB: the in-VM walk over real mainnet ticks is lamport-exact vs the mirror', async () => {
    const output = await ecoSwapSvm({
      amountIn: AMOUNT_IN,
      minOut: 1n,
      pools: [{ venue: 'orca-whirlpool', pool: POOL, swapOverride: standIn(0) }],
      user: USER,
      load: liveLoader,
      now: CLOCK,
    });
    expect(output.slots.map((slot) => slot.venue)).toEqual(['orca-whirlpool']);
    expect(output.slots[0].params).toHaveLength(16); // nb + 4x(meta,hi,lo) + edge triple
    expect(output.slots[0].params[0]).toBe(4n); // four shipped boundaries
    expect(output.rungs).toEqual([2]);
    expect(output.quote.slices).toEqual([AMOUNT_IN]);
    expect(output.quote.totalPredicted).toBe(80_768_189_284n); // the independent-port pin

    const outAta = freshOutAta(USDC_MINT);
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(harness, staged, output, { [USER.outAta]: outAta, sv0: freshVault(USDC_MINT) }, output.argValues);
    if (!result.ok) throw new Error(`trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);

    expect(words.slices).toEqual(output.quote.slices);
    expect(words.predictedOuts).toEqual(output.quote.predictedOuts);
    expect(words.realized).toBe(output.quote.totalPredicted);
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + words.realized);
    console.log(`whirlpool solo aToB: ${result.cu} CU (floor ${output.quote.estimatedCu})`);
  });

  it('f. solo bToA: direction flip on the same pool, exact', async () => {
    const amountIn = 81_000_000_000n; // 81k USDC
    const output = await ecoSwapSvm({
      amountIn,
      minOut: 1n,
      pools: [{ venue: 'orca-whirlpool', pool: POOL, direction: 'bToA', swapOverride: standIn(0) }],
      user: USER,
      load: liveLoader,
      now: CLOCK,
    });
    expect(output.shapeKey).toContain('orca-whirlpool:bToA');
    expect(output.quote.totalPredicted).toBe(1_001_383_338_471n); // the independent-port pin

    const outAta = freshOutAta(WSOL_MINT);
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(harness, staged, output, { [USER.outAta]: outAta, sv0: freshVault(WSOL_MINT) }, output.argValues);
    if (!result.ok) throw new Error(`bToA trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.realized).toBe(output.quote.totalPredicted);
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + words.realized);
    console.log(`whirlpool solo bToA: ${result.cu} CU`);
  });

  describe('b+c+d. cp+whirlpool split on one universe', () => {
    let output: EcoSwapSvmOutput;
    let staged: { buffer: Address };
    let outAta: Address;
    let vaults: Address[];
    let poolSpecs: EcoSwapSvmPoolSpec[];
    let baseline: { slices: bigint[]; predictedOuts: bigint[]; realized: bigint };
    let originalPool: Uint8Array;
    const SPLIT_IN = 50_000_000_000n; // 50 SOL

    const resolution = (): Record<string, Address> => ({ [USER.outAta]: outAta, sv0: vaults[0], sv1: vaults[1] });

    beforeAll(async () => {
      // A shallow synthetic pumpswap pool priced ABOVE the whirlpool spot
      // (84 vs ~80.8 USDC/SOL): its first 12.5-SOL rung still averages ~81,
      // so it wins the fine early rungs and the deep whirlpool absorbs the
      // tail — a real cross-family split.
      const pump = synthesizePumpswapPool(400_000_000_000n, 33_600_000_000n, { baseMint: WSOL_MINT, quoteMint: USDC_MINT });
      for (const account of pump.accounts) {
        harness.svm.setAccount({
          address: account.address,
          data: account.data,
          executable: false,
          lamports: lamports(harness.svm.minimumBalanceForRentExemption(BigInt(account.data.length))),
          programAddress: account.owner,
          space: BigInt(account.data.length),
        });
      }
      poolSpecs = [
        { venue: 'orca-whirlpool', pool: POOL, swapOverride: standIn(0) },
        { venue: 'pumpswap', pool: pump.pool, direction: 'baseToQuote', swapOverride: standIn(1) },
      ];
      output = await ecoSwapSvm({
        amountIn: SPLIT_IN,
        minOut: 1n,
        pools: poolSpecs,
        user: USER,
        load: liveLoader,
        now: CLOCK,
        minRelBps: 0, // the synthetic pump pool is deliberately far below 1% relative depth
      });
      outAta = freshOutAta(USDC_MINT);
      vaults = [freshVault(USDC_MINT), freshVault(USDC_MINT)];
      staged = await stageEcoBlob(harness, bufferIndex++, output);
      const account = harness.svm.getAccount(POOL);
      if (!account.exists) throw new Error('whirlpool fixture missing');
      originalPool = new Uint8Array(account.data);
    });

    it('b. both slots engage, the cut lands inside the tick window, budgeter rungs are the planned ones', async () => {
      const plan = planLadders(poolSpecs.map((spec) => ({ slug: spec.venue })));
      expect(output.rungs).toEqual(plan.rungs);
      expect(output.quote.estimatedCu).toBe(plan.estimatedCu);

      const quote = await quoteEcoSwapSvm({ amountIn: SPLIT_IN, pools: poolSpecs, load: liveLoader, now: CLOCK, minRelBps: 0 });
      expect(quote.slices).toEqual(output.quote.slices);

      const result = await execEcoTrade(harness, staged, output, resolution(), output.encodeTrade(SPLIT_IN, quote.totalPredicted));
      if (!result.ok) throw new Error(`split failed: ${result.err}\n${result.logs.join('\n')}`);
      baseline = decodeEcoTrade(result.returnData, 2);

      expect(baseline.slices).toEqual(quote.slices);
      expect(baseline.predictedOuts).toEqual(quote.predictedOuts);
      expect(baseline.realized).toBe(quote.totalPredicted);
      expect(baseline.slices[0] > 0n && baseline.slices[1] > 0n).toBe(true); // whirlpool AND pump engaged
      expect(baseline.slices[0] + baseline.slices[1]).toBe(SPLIT_IN);
      expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + baseline.realized);
      console.log(`cp+whirlpool split: ${result.cu} CU, slices ${baseline.slices.join('/')}, rungs ${output.rungs.join('/')}`);
    });

    it('c. same blob, same args, untouched state: byte-identical outcome', async () => {
      const rerun = await execEcoTrade(harness, staged, output, resolution(), output.encodeTrade(SPLIT_IN, baseline.realized));
      if (!rerun.ok) throw new Error(`rerun failed: ${rerun.err}`);
      const words = decodeEcoTrade(rerun.returnData, 2);
      expect(words.slices).toEqual(baseline.slices);
      expect(words.predictedOuts).toEqual(baseline.predictedOuts);
      expect(words.realized).toBe(baseline.realized);
    });

    /** Mirror the prepared shape over the CURRENT bank bytes (drift cells). */
    const mirrorNow = async (): Promise<ReturnType<typeof solveReference>> => {
      const state = await planState(output);
      const whirlCfg = await fetchOrcaWhirlpoolConfig(liveLoader, POOL);
      const pumpCfg = {
        ...(await pumpswapAdapter.fetchPoolConfig(liveLoader, poolSpecs[1].pool)),
        direction: 'baseToQuote',
      } as PumpswapPoolConfig;
      return solveReference(
        [
          {
            quote: orcaWhirlpoolLadder.referenceQuote(whirlCfg, state, output.slots[0].params),
            ladderQuotes: orcaWhirlpoolLadder.referenceLadderQuotes(whirlCfg, state, output.slots[0].params),
            rungs: output.rungs[0],
          },
          { quote: pumpswapLadder.referenceQuote(pumpCfg, state, output.slots[1].params), rungs: output.rungs[1] },
        ],
        SPLIT_IN,
      );
    };

    const doctorPool = (mutate: (data: Uint8Array) => void): void => {
      const account = harness.svm.getAccount(POOL);
      if (!account.exists) throw new Error('whirlpool missing');
      const data = new Uint8Array(originalPool);
      mutate(data);
      harness.svm.setAccount({ ...account, address: POOL, data });
    };
    const writeLE = (data: Uint8Array, offset: number, width: number, value: bigint): void => {
      for (let i = 0; i < width; i++) data[offset + i] = Number((value >> BigInt(8 * i)) & 0xffn);
    };

    it('d1. drift across one crossed boundary: the SAME blob re-anchors on the live bytes, exact', async () => {
      // A real swap's post-state one boundary down: tick -25158 (mid-slot),
      // liquidity adjusted by the crossed tick's net (read from the array).
      const ta0 = harness.svm.getAccount(address('DXi5Z4FeJKHm4kcZPdmfoWSkJG7sj5s3wrvnpxy3DAny'));
      if (!ta0.exists) throw new Error('ta0 missing');
      const offset = 12 + ((-25156 - -25344) / 4) * 113;
      const rawNet = readUintLE(new Uint8Array(ta0.data), offset + 1, 16);
      const net = rawNet >= 1n << 127n ? rawNet - (1n << 128n) : rawNet;
      const liquidity = readUintLE(originalPool, 49, 16) - net; // aToB cross: L - net
      doctorPool((data) => {
        writeLE(data, 65, 16, whirlpoolSqrtPriceAtTick(-25158));
        writeLE(data, 81, 4, BigInt.asUintN(32, -25158n));
        writeLE(data, 49, 16, BigInt.asUintN(128, liquidity));
      });

      const drift = await mirrorNow();
      expect(drift.totalPredicted).toBeLessThan(baseline.realized); // adverse drift prices worse
      const result = await execEcoTrade(harness, staged, output, resolution(), output.encodeTrade(SPLIT_IN, drift.totalPredicted));
      if (!result.ok) throw new Error(`drift trade failed: ${result.err}\n${result.logs.join('\n')}`);
      const words = decodeEcoTrade(result.returnData, 2);
      expect(words.slices).toEqual(drift.slices);
      expect(words.predictedOuts).toEqual(drift.predictedOuts);
      expect(words.realized).toBe(drift.totalPredicted);
    });

    it('d2. drift past the whole shipped window: the venue SELF-DEACTIVATES, the CP slot absorbs everything', async () => {
      // The live tick drops below every shipped boundary (into ta1's span):
      // there is no out-of-window fallback — the slot quotes 0 live and its
      // CPI is skipped, exactly like the paused-saber reroute.
      doctorPool((data) => {
        writeLE(data, 65, 16, whirlpoolSqrtPriceAtTick(-25400)); // inside ta1's span [-25696, -25344)
        writeLE(data, 81, 4, BigInt.asUintN(32, -25400n));
      });
      const drift = await mirrorNow();
      expect(drift.slices).toEqual([0n, SPLIT_IN]); // deactivated; pump absorbs the whole trade
      expect(drift.predictedOuts[0]).toBe(0n);
      const result = await execEcoTrade(harness, staged, output, resolution(), output.encodeTrade(SPLIT_IN, drift.totalPredicted));
      if (!result.ok) throw new Error(`array-drift trade failed: ${result.err}\n${result.logs.join('\n')}`);
      const words = decodeEcoTrade(result.returnData, 2);
      expect(words.slices).toEqual(drift.slices);
      expect(words.predictedOuts).toEqual(drift.predictedOuts);
      expect(words.realized).toBe(drift.totalPredicted);

      doctorPool(() => {}); // restore the original bytes
    });
  });

  it('e. window exhaustion: the shallow whirlpool clamps at capacity, the merge hands the tail to the CP slot', async () => {
    // Synthetic pair at ~1:1 — the whirlpool prices better at spot but its
    // single position [-128, 0] holds only ~0.032 units of input capacity.
    const whirl = synthesizeWhirlpool({
      mintA: WSOL_MINT,
      mintB: USDC_MINT,
      tickSpacing: 64,
      tickCurrentIndex: 0,
      liquidity: 5_000_000_000n,
      feeRate: 3000,
      ticks: [{ tick: -128, net: 5_000_000_000n }],
      arrayStarts: [0, -5632],
    });
    const pump = synthesizePumpswapPool(1_000_000_000_000n, 970_000_000_000n, { baseMint: WSOL_MINT, quoteMint: USDC_MINT });
    for (const account of [...whirl.accounts, ...pump.accounts]) {
      harness.svm.setAccount({
        address: account.address,
        data: account.data,
        executable: false,
        lamports: lamports(harness.svm.minimumBalanceForRentExemption(BigInt(account.data.length))),
        programAddress: account.owner,
        space: BigInt(account.data.length),
      });
    }

    // Window capacity (one position to tick -128 at L=5e9) is ~32.1e6 gross
    // input: the 2-rung grid over 60e6 puts rung 1 (30e6) inside capacity and
    // rung 2 (60e6) past it — the exhausted rung reports dOut 0 and loses
    // every election.
    const amountIn = 60_000_000n;
    const output = await ecoSwapSvm({
      amountIn,
      minOut: 1n,
      pools: [
        { venue: 'orca-whirlpool', pool: whirl.pool, swapOverride: standIn(0) },
        { venue: 'pumpswap', pool: pump.pool, direction: 'baseToQuote', swapOverride: standIn(1) },
      ],
      user: USER,
      load: liveLoader,
      now: CLOCK,
      minRelBps: 0,
    });
    expect(output.slots[0].params[0]).toBe(1n); // one shipped boundary (tick -128) + the edge

    // The whirlpool takes exactly its viable rung prefix; the clamped upper
    // rungs (dOut 0) never win — the CP slot absorbs the tail.
    const outAta = freshOutAta(USDC_MINT);
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(
      harness,
      staged,
      output,
      { [USER.outAta]: outAta, sv0: freshVault(USDC_MINT), sv1: freshVault(USDC_MINT) },
      output.argValues,
    );
    if (!result.ok) throw new Error(`exhaustion trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 2);

    expect(words.slices).toEqual(output.quote.slices);
    expect(words.predictedOuts).toEqual(output.quote.predictedOuts);
    expect(words.realized).toBe(output.quote.totalPredicted);
    expect(words.slices[0]).toBe(amountIn >> 1n); // exactly the one viable rung
    expect(words.slices[1]).toBe(amountIn - words.slices[0]); // the CP slot absorbs the tail
    expect(words.predictedOuts[0]).toBeGreaterThan(0n);
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + words.realized);
    console.log(`window exhaustion: whirl ${words.slices[0]} / pump ${words.slices[1]}`);
  });
});
