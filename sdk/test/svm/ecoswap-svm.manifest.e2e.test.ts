/**
 * EcoSwapSVM Manifest CLOB e2e on the REAL engine (LiteSVM): the second Phase 2
 * family and the first order-book venue — the in-VM taker walk against the
 * dumped mainnet SOL/USDC market (fixtures/manifest/, ENhU8LsaR7...) and
 * synthetic books, all through the production staged path (hash-pinned buffer,
 * packed cfg args, SPL-transfer stand-in CPIs paying the predicted output).
 *
 * Cells:
 *   a. solo baseIn (sell 5 SOL): the walk crosses real bid levels in-VM —
 *      LAMPORT-EXACT vs the solver mirror (slices, predicted, realized);
 *   b. solo quoteIn (buy with 1000 USDC): direction flip, exact;
 *   c. cp+manifest split: a shallow synthetic pumpswap pool priced above the
 *      book's best bid wins the fine early rungs, the deep book absorbs the
 *      tail — the cut lands mid-level, both slots engaged, exact; budgeter
 *      rungs match planLadders;
 *   d. re-execution determinism: same blob, same args, untouched state →
 *      byte-identical returndata;
 *   e. drift/re-anchor: doctor a shipped order's live size (a partial fill) and
 *      then its sequence_number (a fill/cancel + block reuse) — the SAME blob
 *      re-anchors on the live bytes / self-deactivates, exact both times;
 *   f. level exhaustion: a shallow synthetic book saturates at its top-of-book
 *      depth — the merge hands the tail to the CP slot, exact.
 *
 * Requires the engine .so; skips cleanly when absent.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { address, lamports } from '@solana/kit';
import type { Address } from '@solana/kit';
import { fetchManifestConfig } from '../../src/svm/venues/manifest/index.js';
import { manifestLadder } from '../../src/svm/venues/manifest/ladder.js';
import { pumpswapAdapter, pumpswapLadder } from '../../src/svm/index.js';
import type { AccountBytesMap, AccountLoader, LadderSwapTemplate, PumpswapPoolConfig } from '../../src/svm/index.js';
import { ecoSwapSvm, planLadders, quoteEcoSwapSvm, solveReference } from '../../src/recipes/ecoswap/svm/index.js';
import type { EcoSwapSvmOutput, EcoSwapSvmPoolSpec } from '../../src/recipes/ecoswap/svm/index.js';
import { describeSvm, loadFixtureAccounts, randomAddress, setTokenAccount, startEngine, tokenAmount } from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';
import { loadFixtures } from './fixtures.js';
import { synthesizePumpswapPool, TOKENKEG, USDC_MINT, WSOL_MINT } from './ecoswap-svm.fixtures.js';
import { manifestPriceInner, synthesizeManifestMarket } from './manifest.fixtures.js';
import { decodeEcoTrade, execEcoTrade, stageEcoBlob } from './ecoswap-svm.harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const MARKET = address('ENhU8LsaR7vDD2G1CsWcsuSGNrih9Cv5WZEk7q9kPapQ');
const CLOCK = 1_783_175_236n;
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

describeSvm('ecoswap-svm manifest e2e: CLOB taker walk, drift re-anchor, level exhaustion', () => {
  let harness: EngineHarness;
  let liveLoader: AccountLoader;
  let bufferIndex = 0;

  const freshOutAta = (mint: Address): Address =>
    setTokenAccount(harness, randomAddress(), mint, harness.payer.address, OUT_ATA_START);
  const freshVault = (mint: Address): Address =>
    setTokenAccount(harness, randomAddress(), mint, harness.payer.address, 10n ** 15n);
  const setSynthAccounts = (accounts: { address: Address; owner: Address; data: Uint8Array }[]): void => {
    for (const account of accounts) {
      harness.svm.setAccount({
        address: account.address,
        data: account.data,
        executable: false,
        lamports: lamports(harness.svm.minimumBalanceForRentExemption(BigInt(account.data.length))),
        programAddress: account.owner,
        space: BigInt(account.data.length),
      });
    }
  };

  beforeAll(async () => {
    harness = await startEngine(CLOCK);
    loadFixtureAccounts(harness, loadFixtures(join(FIXTURES, 'manifest')));
    loadFixtureAccounts(harness, loadFixtures(join(FIXTURES, 'pumpswap'))); // global/fee configs for synthetic pump pools
    liveLoader = async (addr) => {
      const account = harness.svm.getAccount(addr);
      return account.exists ? new Uint8Array(account.data) : null;
    };
  });

  it('a. solo baseIn: the in-VM walk over real bid levels is lamport-exact vs the mirror', async () => {
    const amountIn = 5_000_000_000n; // 5 SOL
    const output = await ecoSwapSvm({
      amountIn,
      minOut: 1n,
      pools: [{ venue: 'manifest', pool: MARKET, swapOverride: standIn(0) }],
      user: USER,
      load: liveLoader,
      now: CLOCK,
    });
    expect(output.slots.map((slot) => slot.venue)).toEqual(['manifest']);
    expect(output.rungs).toEqual([2]); // heavy setup -> 2-rung default (stable-class)
    expect(output.quote.slices).toEqual([amountIn]);
    expect(output.quote.totalPredicted).toBe(401_084_700n); // the independent-port pin

    const outAta = freshOutAta(USDC_MINT);
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(harness, staged, output, { [USER.outAta]: outAta, sv0: freshVault(USDC_MINT) }, output.argValues);
    if (!result.ok) throw new Error(`trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.slices).toEqual(output.quote.slices);
    expect(words.predictedOuts).toEqual(output.quote.predictedOuts);
    expect(words.realized).toBe(output.quote.totalPredicted);
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + words.realized);
    console.log(`manifest solo baseIn: ${result.cu} CU (floor ${output.quote.estimatedCu})`);
  });

  it('b. solo quoteIn: buy base, direction flip on the same market, exact', async () => {
    const amountIn = 1_000_000_000n; // 1000 USDC
    const output = await ecoSwapSvm({
      amountIn,
      minOut: 1n,
      pools: [{ venue: 'manifest', pool: MARKET, direction: 'quoteIn', swapOverride: standIn(0) }],
      user: USER,
      load: liveLoader,
      now: CLOCK,
    });
    expect(output.shapeKey).toContain('manifest:quoteIn');
    expect(output.quote.totalPredicted).toBe(12_381_694_976n); // the independent-port pin

    const outAta = freshOutAta(WSOL_MINT);
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(harness, staged, output, { [USER.outAta]: outAta, sv0: freshVault(WSOL_MINT) }, output.argValues);
    if (!result.ok) throw new Error(`quoteIn trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.realized).toBe(output.quote.totalPredicted);
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + words.realized);
    console.log(`manifest solo quoteIn: ${result.cu} CU`);
  });

  describe('c+d+e. cp+manifest split on one universe', () => {
    let output: EcoSwapSvmOutput;
    let staged: { buffer: Address };
    let outAta: Address;
    let vaults: Address[];
    let poolSpecs: EcoSwapSvmPoolSpec[];
    let pumpPool: Address;
    let baseline: { slices: bigint[]; predictedOuts: bigint[]; realized: bigint };
    let originalMarket: Uint8Array;
    const SPLIT_IN = 5_000_000_000n; // 5 SOL

    const resolution = (): Record<string, Address> => ({ [USER.outAta]: outAta, sv0: vaults[0], sv1: vaults[1] });

    beforeAll(async () => {
      // A shallow synthetic pumpswap pool priced ABOVE the book's best bid
      // (~86 vs ~80.2 USDC/SOL): its fine early rungs win, the deep book
      // absorbs the tail — a real cross-family split (both SELL: SOL in, USDC out).
      const pump = synthesizePumpswapPool(20_000_000_000n, 1_720_000_000n, { baseMint: WSOL_MINT, quoteMint: USDC_MINT });
      pumpPool = pump.pool;
      setSynthAccounts(pump.accounts);
      poolSpecs = [
        { venue: 'manifest', pool: MARKET, swapOverride: standIn(0) },
        { venue: 'pumpswap', pool: pump.pool, direction: 'baseToQuote', swapOverride: standIn(1) },
      ];
      output = await ecoSwapSvm({
        amountIn: SPLIT_IN,
        minOut: 1n,
        pools: poolSpecs,
        user: USER,
        load: liveLoader,
        now: CLOCK,
        minRelBps: 0, // the synthetic pump pool is deliberately below 1% relative depth
      });
      outAta = freshOutAta(USDC_MINT);
      vaults = [freshVault(USDC_MINT), freshVault(USDC_MINT)];
      staged = await stageEcoBlob(harness, bufferIndex++, output);
      const account = harness.svm.getAccount(MARKET);
      if (!account.exists) throw new Error('manifest fixture missing');
      originalMarket = new Uint8Array(account.data);
    });

    /** Mirror the prepared shape over the CURRENT bank bytes (drift cells). */
    const mirrorNow = async (): Promise<ReturnType<typeof solveReference>> => {
      const state: AccountBytesMap = {};
      for (const meta of output.accountPlan.metas) {
        if (meta.pubkey === undefined) continue;
        const data = await liveLoader(address(meta.pubkey));
        if (data !== null) state[meta.pubkey] = data;
      }
      const manifestCfg = await fetchManifestConfig(liveLoader, MARKET);
      const pumpCfg = {
        ...(await pumpswapAdapter.fetchPoolConfig(liveLoader, pumpPool)),
        direction: 'baseToQuote',
      } as PumpswapPoolConfig;
      return solveReference(
        [
          { quote: manifestLadder.referenceQuote(manifestCfg, state, output.slots[0].params), rungs: output.rungs[0] },
          { quote: pumpswapLadder.referenceQuote(pumpCfg, state, output.slots[1].params), rungs: output.rungs[1] },
        ],
        SPLIT_IN,
      );
    };

    const doctorMarket = (mutate: (data: Uint8Array) => void): void => {
      const account = harness.svm.getAccount(MARKET);
      if (!account.exists) throw new Error('manifest missing');
      const data = new Uint8Array(originalMarket);
      mutate(data);
      harness.svm.setAccount({ ...account, address: MARKET, data });
    };
    // Absolute market offsets for the shipped order at slot 0's window position p.
    const orderBase = (p: number): number => 256 + Number(output.slots[0].params[1 + 2 * p]);

    it('c. both slots engage, the cut lands mid-level, budgeter rungs are the planned ones', async () => {
      const plan = planLadders(poolSpecs.map((spec) => ({ slug: spec.venue })));
      expect(output.rungs).toEqual(plan.rungs);

      const quote = await quoteEcoSwapSvm({ amountIn: SPLIT_IN, pools: poolSpecs, load: liveLoader, now: CLOCK, minRelBps: 0 });
      expect(quote.slices).toEqual(output.quote.slices);

      const result = await execEcoTrade(harness, staged, output, resolution(), output.encodeTrade(SPLIT_IN, quote.totalPredicted));
      if (!result.ok) throw new Error(`split failed: ${result.err}\n${result.logs.join('\n')}`);
      baseline = decodeEcoTrade(result.returnData, 2);
      expect(baseline.slices).toEqual(quote.slices);
      expect(baseline.predictedOuts).toEqual(quote.predictedOuts);
      expect(baseline.realized).toBe(quote.totalPredicted);
      expect(baseline.slices[0] > 0n && baseline.slices[1] > 0n).toBe(true); // manifest AND pump engaged
      expect(baseline.slices[0] + baseline.slices[1]).toBe(SPLIT_IN);
      expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + baseline.realized);
      console.log(`cp+manifest split: ${result.cu} CU, slices ${baseline.slices.join('/')}`);
    });

    it('d. same blob, same args, untouched state: byte-identical outcome', async () => {
      const rerun = await execEcoTrade(harness, staged, output, resolution(), output.encodeTrade(SPLIT_IN, baseline.realized));
      if (!rerun.ok) throw new Error(`rerun failed: ${rerun.err}`);
      const words = decodeEcoTrade(rerun.returnData, 2);
      expect(words.slices).toEqual(baseline.slices);
      expect(words.predictedOuts).toEqual(baseline.predictedOuts);
      expect(words.realized).toBe(baseline.realized);
    });

    it('e1. drift: a shipped order partially fills — the SAME blob re-anchors on the live size', async () => {
      // Shrink the best bid's live size well below the baseline manifest slice
      // (a large partial fill since prepare) — the walk re-prices on the smaller
      // live level, spilling into worse levels and shifting more onto the CP slot.
      const base0 = orderBase(0);
      const shrunk = 500_000_000n; // 0.5 SOL — below the ~3.75 SOL baseline manifest fill
      doctorMarket((data) => {
        for (let i = 0; i < 8; i++) data[base0 + 16 + 16 + i] = Number((shrunk >> BigInt(8 * i)) & 0xffn);
      });
      const drift = await mirrorNow();
      // The shrunk best level re-prices the manifest side worse — adverse drift,
      // less output for the same trade (the split may quantize to the same rung).
      expect(drift.totalPredicted).toBeLessThan(baseline.realized);
      const result = await execEcoTrade(harness, staged, output, resolution(), output.encodeTrade(SPLIT_IN, drift.totalPredicted));
      if (!result.ok) throw new Error(`size-drift trade failed: ${result.err}\n${result.logs.join('\n')}`);
      const words = decodeEcoTrade(result.returnData, 2);
      expect(words.slices).toEqual(drift.slices);
      expect(words.predictedOuts).toEqual(drift.predictedOuts);
      expect(words.realized).toBe(drift.totalPredicted);
    });

    it('e2. drift: the best shipped order is filled/reused (seq mismatch) — manifest self-deactivates from that level', async () => {
      // Break the best bid's live sequence_number: the walk STOPS at level 0,
      // so the whole manifest side deactivates and the CP slot absorbs everything.
      const base0 = orderBase(0);
      doctorMarket((data) => {
        for (let i = 0; i < 8; i++) data[base0 + 16 + 24 + i] = 0;
        data[base0 + 16 + 24] = 0xfe; // seq now != shipped
      });
      const drift = await mirrorNow();
      expect(drift.slices).toEqual([0n, SPLIT_IN]); // deactivated; pump absorbs the whole trade
      expect(drift.predictedOuts[0]).toBe(0n);
      const result = await execEcoTrade(harness, staged, output, resolution(), output.encodeTrade(SPLIT_IN, drift.totalPredicted));
      if (!result.ok) throw new Error(`seq-drift trade failed: ${result.err}\n${result.logs.join('\n')}`);
      const words = decodeEcoTrade(result.returnData, 2);
      expect(words.slices).toEqual(drift.slices);
      expect(words.predictedOuts).toEqual(drift.predictedOuts);
      expect(words.realized).toBe(drift.totalPredicted);
      doctorMarket(() => {}); // restore
    });
  });

  it('f. level exhaustion: a shallow book saturates within a rung, the merge hands the tail to the CP slot', async () => {
    // Book depth 60M base-atoms across two clearly-cheap bid levels (priced far
    // above the pump). amountIn 100M: the geometric rungs up to amountIn>>1 =
    // 50M all sit INSIDE the 60M depth (real book prices, winning), while the
    // top rung (100M) reaches past the depth into diluted territory that the
    // pump beats — so the book takes exactly its viable rung prefix (50M) and
    // the deep CP slot absorbs the tail. Mirrors the whirlpool window-exhaustion
    // cell (one viable rung, the clamped upper rung loses every election).
    const book = synthesizeManifestMarket({
      side: 'bids',
      baseMint: WSOL_MINT,
      quoteMint: USDC_MINT,
      orders: [
        { priceInner: manifestPriceInner(0.2), size: 40_000_000n },
        { priceInner: manifestPriceInner(0.19), size: 20_000_000n },
      ],
    });
    // Deep pump at ~0.10 USDC/SOL — well below the book levels (loses the
    // in-depth rungs) but well above the diluted over-capacity top rung.
    const pump = synthesizePumpswapPool(1_000_000_000_000n, 100_000_000_000n, { baseMint: WSOL_MINT, quoteMint: USDC_MINT });
    setSynthAccounts([...book.accounts, ...pump.accounts]);

    const amountIn = 100_000_000n; // 0.1 SOL — the 60M book depth sits between amountIn>>1 and amountIn
    const output = await ecoSwapSvm({
      amountIn,
      minOut: 1n,
      pools: [
        { venue: 'manifest', pool: book.market, swapOverride: standIn(0) },
        { venue: 'pumpswap', pool: pump.pool, direction: 'baseToQuote', swapOverride: standIn(1) },
      ],
      user: USER,
      load: liveLoader,
      now: CLOCK,
      minRelBps: 0,
    });
    expect(output.slots[0].params[0]).toBe(2n); // two shipped bid levels

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
    expect(words.slices[0]).toBe(amountIn >> 1n); // exactly the viable rung prefix (inside the book depth)
    expect(words.slices[1]).toBe(amountIn - (amountIn >> 1n)); // the CP slot absorbs the tail
    expect(words.predictedOuts[0]).toBeGreaterThan(0n);
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + words.realized);
    console.log(`manifest exhaustion: book ${words.slices[0]} / pump ${words.slices[1]}`);
  });
});
