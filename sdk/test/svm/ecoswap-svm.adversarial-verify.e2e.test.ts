/**
 * VERIFIER adversarial gate (independent Phase 2 verification, not part of the
 * stage deliverable): engine-executed lamport-exact cells that target the two
 * gate concerns the reviewer flagged —
 *   whirlpool: a NEGATIVE liquidity_net i128 crossing that leaves a NON-ZERO
 *     post-cross liquidity (so the two's-complement subtract must be exact or
 *     the continued walk diverges), plus a cut landing EXACTLY on the last
 *     shipped window boundary (window-edge off-by-one);
 *   manifest: a price-TIE across two levels (iteration order) with a
 *     fractional PARTIAL fill (full-order UP vs marginal DOWN rounding).
 * Each cell runs the production staged path on the real engine and asserts the
 * engine returndata == the solver-reference mirror bit-for-bit.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { address, lamports } from '@solana/kit';
import type { Address } from '@solana/kit';
import { fetchOrcaWhirlpoolConfig } from '../../src/svm/venues/orca-whirlpool/index.js';
import {
  orcaWhirlpoolLadder,
  whirlpoolDeltaA,
  whirlpoolDeltaB,
  whirlpoolSqrtPriceAtTick,
} from '../../src/svm/venues/orca-whirlpool/ladder.js';
import { fetchManifestConfig } from '../../src/svm/venues/manifest/index.js';
import { manifestLadder } from '../../src/svm/venues/manifest/ladder.js';
import type { AccountBytesMap, AccountLoader, LadderSwapTemplate } from '../../src/svm/index.js';
import { ecoSwapSvm, solveReference } from '../../src/recipes/ecoswap/svm/index.js';
import type { EcoSwapSvmOutput } from '../../src/recipes/ecoswap/svm/index.js';
import { describeSvm, loadFixtureAccounts, randomAddress, setTokenAccount, startEngine, tokenAmount } from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';
import { loadFixtures } from './fixtures.js';
import { synthesizePumpswapPool, TOKENKEG, USDC_MINT, WSOL_MINT } from './ecoswap-svm.fixtures.js';
import { synthesizeWhirlpool } from './orca-whirlpool.fixtures.js';
import { manifestPriceInner, synthesizeManifestMarket } from './manifest.fixtures.js';
import { decodeEcoTrade, execEcoTrade, stageEcoBlob } from './ecoswap-svm.harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CLOCK = 1_783_175_236n;
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

describeSvm('ecoswap-svm VERIFIER adversarial gate', () => {
  let harness: EngineHarness;
  let liveLoader: AccountLoader;
  let bufferIndex = 10;

  const freshOutAta = (mint: Address): Address =>
    setTokenAccount(harness, randomAddress(), mint, harness.payer.address, OUT_ATA_START);
  const freshVault = (mint: Address): Address =>
    setTokenAccount(harness, randomAddress(), mint, harness.payer.address, 10n ** 15n);
  const setSynth = (accounts: { address: Address; owner: Address; data: Uint8Array }[]): void => {
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
    liveLoader = async (addr) => {
      const account = harness.svm.getAccount(addr);
      return account.exists ? new Uint8Array(account.data) : null;
    };
  });

  // Two overlapping positions so a bToA up-cross of tick 256 (net -Lb, a
  // NEGATIVE i128 word) leaves L = La > 0 and the walk keeps producing output
  // on the reduced liquidity — a wrong two's-complement subtract diverges.
  const La = 3_000_000_000n;
  const Lb = 2_000_000_000n;
  const TS = 64;
  const buildTwoPosition = () =>
    synthesizeWhirlpool({
      mintA: WSOL_MINT,
      mintB: USDC_MINT,
      tickSpacing: TS,
      tickCurrentIndex: 0,
      liquidity: La + Lb, // active at spot
      feeRate: 3000,
      ticks: [
        { tick: -256, net: La + Lb }, // lower bound of both positions
        { tick: 256, net: -Lb }, // upper bound of position B — NEGATIVE net
        { tick: 512, net: -La }, // upper bound of position A — NEGATIVE net
      ],
      arrayStarts: [0, -5632],
    });

  it('whirlpool: NEGATIVE-net cross with non-zero post-L is lamport-exact on the engine (bToA)', async () => {
    const whirl = buildTwoPosition();
    setSynth(whirl.accounts);

    // Gross input to move price from tick 0 up to tick 256 (fee-grossed), then
    // some extra that walks into the [256, 512) segment at the reduced L=La.
    const sp0 = whirlpoolSqrtPriceAtTick(0);
    const sp256 = whirlpoolSqrtPriceAtTick(256);
    const inTo256 = whirlpoolDeltaB(La + Lb, sp0, sp256, true);
    const feeTo256 = (inTo256 * 3000n + 996_999n) / 997_000n;
    const amountIn = inTo256 + feeTo256 + 20_000_000n; // cross 256, continue on L=La

    const output = await ecoSwapSvm({
      amountIn,
      minOut: 1n,
      pools: [{ venue: 'orca-whirlpool', pool: whirl.pool, direction: 'bToA', swapOverride: standIn(0) }],
      user: USER,
      load: liveLoader,
      now: CLOCK,
      minRelBps: 0,
    });
    expect(output.slots[0].params[0]).toBe(2n); // two shipped boundaries (256, 512), both negative net

    // Mirror over the live bytes = the gate target.
    const cfg = { ...(await fetchOrcaWhirlpoolConfig(liveLoader, whirl.pool)), direction: 'bToA' as const };
    const state = await planState(output);
    const mirror = solveReference(
      [
        {
          quote: orcaWhirlpoolLadder.referenceQuote(cfg, state, output.slots[0].params),
          ladderQuotes: orcaWhirlpoolLadder.referenceLadderQuotes(cfg, state, output.slots[0].params),
          rungs: output.rungs[0],
        },
      ],
      amountIn,
    );
    // The cross MUST have happened with non-zero continuation: output strictly
    // exceeds the pure to-256 output (walk kept going on L=La past the boundary).
    const outTo256 = whirlpoolDeltaA(La + Lb, sp0, sp256, false);
    expect(mirror.predictedOuts[0]).toBeGreaterThan(outTo256);

    const outAta = freshOutAta(WSOL_MINT);
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(
      harness,
      staged,
      output,
      { [USER.outAta]: outAta, sv0: freshVault(WSOL_MINT) },
      output.encodeTrade(amountIn, mirror.totalPredicted),
    );
    if (!result.ok) throw new Error(`neg-net trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.slices).toEqual(mirror.slices);
    expect(words.predictedOuts).toEqual(mirror.predictedOuts); // engine == mirror, i128 subtract exact
    expect(words.realized).toBe(mirror.totalPredicted);
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + words.realized);
  });

  it('whirlpool: a cut EXACTLY on the last shipped boundary fills full; +1 self-deactivates (no off-by-one)', async () => {
    const whirl = buildTwoPosition();
    setSynth(whirl.accounts);
    const cfg = { ...(await fetchOrcaWhirlpoolConfig(liveLoader, whirl.pool)), direction: 'bToA' as const };
    const state: AccountBytesMap = {};
    for (const account of whirl.accounts) state[account.address] = new Uint8Array(account.data);
    const params = orcaWhirlpoolLadder.paramsFor(cfg);
    const quote = orcaWhirlpoolLadder.referenceQuote(cfg, state, params);

    // Exact gross to reach the LAST boundary (tick 512): sum the two segments'
    // fee-grossed fixed inputs (both computed on their own live L).
    const sp0 = whirlpoolSqrtPriceAtTick(0);
    const sp256 = whirlpoolSqrtPriceAtTick(256);
    const sp512 = whirlpoolSqrtPriceAtTick(512);
    const gross = (l: bigint, lo: bigint, hi: bigint): bigint => {
      const fixed = whirlpoolDeltaB(l, lo, hi, true);
      return fixed + (fixed * 3000n + 996_999n) / 997_000n;
    };
    const exact = gross(La + Lb, sp0, sp256) + gross(La, sp256, sp512);
    const outAtEdge = whirlpoolDeltaA(La + Lb, sp0, sp256, false) + whirlpoolDeltaA(La, sp256, sp512, false);

    expect(quote(exact)).toBe(outAtEdge); // exact cut on the last boundary — full output, not clamped
    expect(quote(exact + 1n)).toBe(0n); // one atom past capacity: self-deactivation (no fallback)
    expect(quote(exact - 1n)).toBeGreaterThan(0n);
    expect(quote(exact - 1n)).toBeLessThanOrEqual(outAtEdge);

    // And it lands on the engine: fill exactly to the edge, solo.
    const output = await ecoSwapSvm({
      amountIn: exact,
      minOut: 1n,
      pools: [{ venue: 'orca-whirlpool', pool: whirl.pool, direction: 'bToA', swapOverride: standIn(0) }],
      user: USER,
      load: liveLoader,
      now: CLOCK,
      minRelBps: 0,
    });
    expect(output.quote.totalPredicted).toBe(outAtEdge);
    const outAta = freshOutAta(WSOL_MINT);
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(
      harness,
      staged,
      output,
      { [USER.outAta]: outAta, sv0: freshVault(WSOL_MINT) },
      output.argValues,
    );
    if (!result.ok) throw new Error(`edge-cut trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.realized).toBe(outAtEdge);
  });

  it('manifest: price-TIE across two levels + fractional PARTIAL is lamport-exact on the engine (baseIn)', async () => {
    // Two bid levels at the SAME price 1.5 (tie -> iteration order), then a
    // worse level; a partial fill straddling a .5 quote atom (full UP, marginal DOWN).
    const book = synthesizeManifestMarket({
      side: 'bids',
      baseMint: WSOL_MINT,
      quoteMint: USDC_MINT,
      orders: [
        { priceInner: manifestPriceInner(1.5), size: 2_000_000n, seq: 900n },
        { priceInner: manifestPriceInner(1.5), size: 2_000_000n, seq: 901n }, // TIE with level 0
        { priceInner: manifestPriceInner(1.4), size: 2_000_000n, seq: 902n },
      ],
    });
    setSynth(book.accounts);

    // Sell 3_000_001 base:
    //   level0 full 2_000_000 -> UP ceil(1.5*2e6) = 3_000_000
    //   level1 partial 1_000_001 -> DOWN floor(1.5*1_000_001) = floor(1_500_001.5) = 1_500_001
    //   total 4_500_001 (fractional partial floors, tie order level0-before-level1)
    const amountIn = 3_000_001n;
    const output = await ecoSwapSvm({
      amountIn,
      minOut: 1n,
      pools: [{ venue: 'manifest', pool: book.market, swapOverride: standIn(0) }],
      user: USER,
      load: liveLoader,
      now: CLOCK,
      minRelBps: 0,
    });
    expect(output.slots[0].params[0]).toBe(3n);

    const cfg = await fetchManifestConfig(liveLoader, book.market);
    const state = await planState(output);
    const quote = manifestLadder.referenceQuote(cfg, state, output.slots[0].params);
    expect(quote(amountIn)).toBe(4_500_001n); // independently computed: 3_000_000 + 1_500_001
    const mirror = solveReference([{ quote, rungs: output.rungs[0] }], amountIn);

    const outAta = freshOutAta(USDC_MINT);
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(
      harness,
      staged,
      output,
      { [USER.outAta]: outAta, sv0: freshVault(USDC_MINT) },
      output.encodeTrade(amountIn, mirror.totalPredicted),
    );
    if (!result.ok) throw new Error(`tie/partial trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.slices).toEqual(mirror.slices);
    expect(words.predictedOuts).toEqual(mirror.predictedOuts); // engine == mirror, tie order + DOWN partial exact
    expect(words.realized).toBe(mirror.totalPredicted);
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + words.realized);
  });

  it('manifest: quoteIn fractional partial (base_limit floor) is lamport-exact on the engine', async () => {
    // asks at 1.5: buying with a quote amount that partially fills the top ask
    // -> base_limit = floor(1e18*quote/inner), marginal stop.
    const book = synthesizeManifestMarket({
      side: 'asks',
      baseMint: WSOL_MINT,
      quoteMint: USDC_MINT,
      orders: [
        { priceInner: manifestPriceInner(1.5), size: 1_000_000n, seq: 800n },
        { priceInner: manifestPriceInner(1.6), size: 1_000_000n, seq: 801n },
      ],
    });
    setSynth(book.accounts);

    // Buy with 2_100_001 quote:
    //   level0 full: base 1_000_000, quote cost floor(1.5*1e6)=1_500_000, remaining 600_001
    //   level1 partial: base_limit floor(1e18*600_001/1.6e18)=floor(375_000.625)=375_000
    //   total base 1_375_000
    const amountIn = 2_100_001n;
    const output = await ecoSwapSvm({
      amountIn,
      minOut: 1n,
      pools: [{ venue: 'manifest', pool: book.market, direction: 'quoteIn', swapOverride: standIn(0) }],
      user: USER,
      load: liveLoader,
      now: CLOCK,
      minRelBps: 0,
    });

    const cfg = { ...(await fetchManifestConfig(liveLoader, book.market)), direction: 'quoteIn' as const };
    const state = await planState(output);
    const quote = manifestLadder.referenceQuote(cfg, state, output.slots[0].params);
    expect(quote(amountIn)).toBe(1_375_000n); // independently computed
    const mirror = solveReference([{ quote, rungs: output.rungs[0] }], amountIn);

    const outAta = freshOutAta(WSOL_MINT);
    const staged = await stageEcoBlob(harness, bufferIndex++, output);
    const result = await execEcoTrade(
      harness,
      staged,
      output,
      { [USER.outAta]: outAta, sv0: freshVault(WSOL_MINT) },
      output.encodeTrade(amountIn, mirror.totalPredicted),
    );
    if (!result.ok) throw new Error(`quoteIn partial trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.predictedOuts).toEqual(mirror.predictedOuts);
    expect(words.realized).toBe(mirror.totalPredicted);
  });
});
