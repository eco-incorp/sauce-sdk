/**
 * Obric V2 e2e (engine, SAUCE_ENGINE_SO) — the prop-AMM oracle-anchored (P-A)
 * family through the real Sauce engine, stand-in CPIs (the split, ladders and
 * merge run the PRODUCTION path against live account bytes; the venue binary is
 * exercised only by the env-gated real-CPI lane).
 *
 *  a. SOLO obric: the oracle-anchored quote runs in-VM, lamport-exact vs the
 *     off-chain mirror (quoteEcoSwapSvm);
 *  b. cp + obric SPLIT: both engaged, marginals equalize, lamport-exact;
 *  c. DOCTORED-ORACLE DRIFT: the SAME staged blob re-anchors to a new LIVE mid
 *     (doctor the feed price in-band) — lamport-exact vs the re-quote on the
 *     drifted bytes (the bake-shape/read-level thesis);
 *  d. OUT-OF-BAND self-deactivation: doctor the feed grossly off → the obric
 *     slot clamps to 0 and the merge redistributes the whole trade to the CP
 *     co-slot, in-instruction.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { address, lamports } from '@solana/kit';
import type { Address } from '@solana/kit';
import { obricV2, obricV2Ladder, raydiumCpSwap } from '../../src/svm/index.js';
import type { AccountLoader, LadderSwapTemplate } from '../../src/svm/index.js';
import { ecoSwapSvm, quoteEcoSwapSvm } from '../../src/recipes/ecoswap/svm/index.js';
import type { EcoSwapSvmOutput, EcoSwapSvmPoolSpec } from '../../src/recipes/ecoswap/svm/index.js';
import { describeSvm, randomAddress, setTokenAccount, startEngine, tokenAmount } from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';
import { loadFixtures } from './fixtures.js';
import {
  pythV2FeedBytes,
  synthesizeObricPool,
  synthesizeRaydiumCpPool,
  syntheticMintBytes,
  TOKENKEG,
  USDC_MINT,
} from './ecoswap-svm.fixtures.js';
import type { SynthesizedObricPool } from './ecoswap-svm.fixtures.js';
import { decodeEcoTrade, execEcoTrade, stageEcoBlob } from './ecoswap-svm.harness.js';

const CLOCK = 1_783_000_000n; // obric reads no clock; any instant works
const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };
/** A synthetic 6-decimal input token (equal decimals → oracle decimalMult 1). */
const AAA_MINT = address('AAA1111111111111111111111111111111111111111');

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

describeSvm('ecoswap-svm obric-v2 e2e: oracle-anchored split, drift re-anchor, band self-deactivation', () => {
  let harness: EngineHarness;
  let liveLoader: AccountLoader;
  let obric: SynthesizedObricPool;

  const setAccount = (a: Address, owner: Address, data: Uint8Array): void =>
    harness.svm.setAccount({
      address: a,
      data,
      executable: false,
      lamports: lamports(harness.svm.minimumBalanceForRentExemption(BigInt(data.length))),
      programAddress: owner,
      space: BigInt(data.length),
    });

  beforeAll(async () => {
    harness = await startEngine(CLOCK);
    // Mints (both 6-decimal → oracle decimalMult 1).
    setAccount(AAA_MINT, TOKENKEG, syntheticMintBytes(6));
    setAccount(USDC_MINT, TOKENKEG, syntheticMintBytes(6));
    liveLoader = async (addr) => {
      const account = harness.svm.getAccount(addr);
      return account.exists ? new Uint8Array(account.data) : null;
    };
  });

  /** Fresh out ATA + two funded stand-in source vaults, per test. */
  const freshCustody = (): { outAta: Address; sv0: Address; sv1: Address } => ({
    outAta: setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, 1_000_000n),
    sv0: setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, 10n ** 15n),
    sv1: setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, 10n ** 15n),
  });

  it('a. solo obric: the oracle-anchored quote runs in-VM, lamport-exact vs the mirror', async () => {
    obric = synthesizeObricPool({
      bigK: 10n ** 24n,
      reserveX: 5_000_000_000n,
      reserveY: 5_000_000_000n,
      priceX: 100_000_000n, // $1 @ expo −8
      priceY: 100_000_000n,
      mintX: AAA_MINT,
      mintY: USDC_MINT,
    });
    for (const a of obric.accounts) setAccount(a.address, a.owner, a.data);
    const { outAta, sv0 } = freshCustody();

    const pools: EcoSwapSvmPoolSpec[] = [{ venue: 'obric-v2', pool: obric.pool, swapOverride: standIn(0) }];
    const amountIn = 500_000_000n;
    const output = await ecoSwapSvm({ amountIn, minOut: 1n, pools, user: USER, load: liveLoader, now: CLOCK });
    expect(output.slots[0].venue).toBe('obric-v2');
    expect(output.shapeKey).toContain('obric-v2:xToY');

    const quote = await quoteEcoSwapSvm({ amountIn, pools, load: liveLoader, now: CLOCK });
    expect(quote.slices).toEqual([amountIn]);
    expect(quote.totalPredicted > 0n).toBe(true);

    const staged = await stageEcoBlob(harness, 0, output);
    const before = tokenAmount(harness, outAta);
    const result = await execEcoTrade(harness, staged, output, { [USER.outAta]: outAta, sv0 }, output.encodeTrade(amountIn, quote.totalPredicted));
    if (!result.ok) throw new Error(`solo obric failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.slices).toEqual(quote.slices);
    expect(words.predictedOuts).toEqual(quote.predictedOuts);
    expect(words.realized).toBe(quote.totalPredicted);
    expect(tokenAmount(harness, outAta)).toBe(before + words.realized);
    console.log(`solo obric: ${result.cu} CU, in ${amountIn} → out ${words.realized}`);
  });

  it('b. cp + obric split: both engaged, lamport-exact vs the mirror', async () => {
    // Obric: oracle-priced (1:1) at 1.5 bps but MODERATE depth (bigK) so its
    // marginal degrades; raydium-cp: deep but 0.25% fee. A large AAA→USDC trade
    // fills obric's cheap early rungs, then spills to the deep CP tail.
    obric = synthesizeObricPool({
      bigK: 4n * 10n ** 22n,
      reserveX: 2_000_000_000n,
      reserveY: 2_000_000_000n,
      priceX: 100_000_000n,
      priceY: 100_000_000n,
      mintX: AAA_MINT,
      mintY: USDC_MINT,
    });
    const cp = synthesizeRaydiumCpPool(50_000_000_000n, 50_000_000_000n, { mint0: AAA_MINT, mint1: USDC_MINT });
    for (const a of [...obric.accounts, ...cp.accounts]) setAccount(a.address, a.owner, a.data);
    const { outAta, sv0, sv1 } = freshCustody();

    const pools: EcoSwapSvmPoolSpec[] = [
      { venue: 'obric-v2', pool: obric.pool, swapOverride: standIn(0) },
      { venue: 'raydium-cp-swap', pool: cp.pool, direction: '0to1', swapOverride: standIn(1) },
    ];
    const amountIn = 4_000_000_000n;
    const output = await ecoSwapSvm({ amountIn, minOut: 1n, pools, user: USER, load: liveLoader, now: CLOCK });
    const quote = await quoteEcoSwapSvm({ amountIn, pools, load: liveLoader, now: CLOCK });
    expect(quote.slices[0] > 0n && quote.slices[1] > 0n).toBe(true); // BOTH engaged
    expect(quote.slices[0] + quote.slices[1]).toBe(amountIn);

    const staged = await stageEcoBlob(harness, 1, output);
    const before = tokenAmount(harness, outAta);
    const result = await execEcoTrade(
      harness,
      staged,
      output,
      { [USER.outAta]: outAta, sv0, sv1 },
      output.encodeTrade(amountIn, quote.totalPredicted),
    );
    if (!result.ok) throw new Error(`cp+obric split failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 2);
    expect(words.slices).toEqual(quote.slices);
    expect(words.predictedOuts).toEqual(quote.predictedOuts);
    expect(words.realized).toBe(quote.totalPredicted);
    expect(tokenAmount(harness, outAta)).toBe(before + words.realized);
    // Post-fee marginals equalize at the cut (obric's oracle price ≈ CP spot minus fee).
    console.log(`cp+obric split: ${result.cu} CU, slices ${words.slices.join('/')}, out ${words.realized}`);
  });

  it('c. doctored-oracle DRIFT: the same staged blob re-anchors to the new live mid, lamport-exact', async () => {
    obric = synthesizeObricPool({
      bigK: 10n ** 24n,
      reserveX: 5_000_000_000n,
      reserveY: 5_000_000_000n,
      priceX: 100_000_000n,
      priceY: 100_000_000n,
      mintX: AAA_MINT,
      mintY: USDC_MINT,
    });
    for (const a of obric.accounts) setAccount(a.address, a.owner, a.data);
    const { outAta, sv0 } = freshCustody();

    const pools: EcoSwapSvmPoolSpec[] = [{ venue: 'obric-v2', pool: obric.pool, swapOverride: standIn(0) }];
    const amountIn = 500_000_000n;
    const output = await ecoSwapSvm({ amountIn, minOut: 1n, pools, user: USER, load: liveLoader, now: CLOCK });
    const staged = await stageEcoBlob(harness, 2, output);

    // Baseline quote+trade at the seeded price.
    const q0 = await quoteEcoSwapSvm({ amountIn, pools, load: liveLoader, now: CLOCK });

    // DRIFT: raise the X (input token) oracle price ~8% — in the 25% band. A
    // higher X price re-anchors targetXK, changing the quote. The staged blob
    // is untouched; it reads the NEW feed bytes live at cook.
    setAccount(obric.feedX, obric.accounts.find((a) => a.address === obric.feedX)!.owner, pythV2FeedBytes(108_000_000n, -8));
    const qDrift = await quoteEcoSwapSvm({ amountIn, pools, load: liveLoader, now: CLOCK });
    expect(qDrift.totalPredicted).not.toBe(q0.totalPredicted); // the mid moved the quote

    const before = tokenAmount(harness, outAta);
    const result = await execEcoTrade(harness, staged, output, { [USER.outAta]: outAta, sv0 }, output.encodeTrade(amountIn, qDrift.totalPredicted));
    if (!result.ok) throw new Error(`drift re-anchor failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.predictedOuts).toEqual(qDrift.predictedOuts); // engine re-anchored to the SAME new mid
    expect(words.realized).toBe(qDrift.totalPredicted);
    expect(tokenAmount(harness, outAta)).toBe(before + words.realized);
    console.log(`drift re-anchor: base out ${q0.totalPredicted} → drifted out ${qDrift.totalPredicted}`);
  });

  it('d. out-of-band oracle: the obric slot self-deactivates and the merge routes the whole trade to CP', async () => {
    obric = synthesizeObricPool({
      bigK: 10n ** 24n,
      reserveX: 5_000_000_000n,
      reserveY: 5_000_000_000n,
      priceX: 100_000_000n,
      priceY: 100_000_000n,
      mintX: AAA_MINT,
      mintY: USDC_MINT,
    });
    const cp = synthesizeRaydiumCpPool(50_000_000_000n, 50_000_000_000n, { mint0: AAA_MINT, mint1: USDC_MINT });
    for (const a of [...obric.accounts, ...cp.accounts]) setAccount(a.address, a.owner, a.data);
    const { outAta, sv0, sv1 } = freshCustody();

    const pools: EcoSwapSvmPoolSpec[] = [
      { venue: 'obric-v2', pool: obric.pool, swapOverride: standIn(0) },
      { venue: 'raydium-cp-swap', pool: cp.pool, direction: '0to1', swapOverride: standIn(1) },
    ];
    const amountIn = 1_000_000_000n;
    const output = await ecoSwapSvm({ amountIn, minOut: 1n, pools, user: USER, load: liveLoader, now: CLOCK });
    const staged = await stageEcoBlob(harness, 3, output);

    // Push the X oracle price 10× — far outside the 25% band vs the stored mult.
    setAccount(obric.feedX, obric.accounts.find((a) => a.address === obric.feedX)!.owner, pythV2FeedBytes(1_000_000_000n, -8));
    const quote = await quoteEcoSwapSvm({ amountIn, pools, load: liveLoader, now: CLOCK });
    expect(quote.slices[0]).toBe(0n); // obric self-deactivated
    expect(quote.slices[1]).toBe(amountIn); // CP absorbs everything

    const before = tokenAmount(harness, outAta);
    const result = await execEcoTrade(harness, staged, output, { [USER.outAta]: outAta, sv0, sv1 }, output.encodeTrade(amountIn, quote.totalPredicted));
    if (!result.ok) throw new Error(`band self-deactivation failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 2);
    expect(words.slices).toEqual([0n, amountIn]);
    expect(words.predictedOuts[0]).toBe(0n);
    expect(words.realized).toBe(quote.totalPredicted);
    expect(tokenAmount(harness, outAta)).toBe(before + words.realized);
    console.log(`band self-deactivation: obric 0 / cp ${words.slices[1]}, out ${words.realized}`);
  });

  it('e. terminal realized-delta minOut backstop: an over-optimistic (doctored-high) oracle quote cannot land below minOut', async () => {
    // The prop-AMM trust boundary: the prediction is derived from a live oracle
    // we do NOT control, so it can be over-optimistic (a stale/manipulated
    // feed). The ground truth is the REALIZED outAta delta — not the
    // prediction. This cell inflates the oracle IN-BAND (so the prediction
    // rises and clears the pre-CPI gate) while an underpaying stand-in credits
    // the user's outAta with NOTHING (models the venue paying below the
    // over-optimistic quote). The terminal realized-delta check must revert
    // "out" and roll the whole transaction back — nothing lands under minOut.
    obric = synthesizeObricPool({
      bigK: 10n ** 24n,
      reserveX: 5_000_000_000n,
      reserveY: 5_000_000_000n,
      priceX: 100_000_000n,
      priceY: 100_000_000n,
      mintX: AAA_MINT,
      mintY: USDC_MINT,
    });
    for (const a of obric.accounts) setAccount(a.address, a.owner, a.data);
    const { outAta, sv0 } = freshCustody();
    // A scratch USDC ATA the stand-in credits INSTEAD of the user's outAta →
    // the outAta delta stays 0 while the CPI itself succeeds.
    const scratch = setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, 0n);
    const underpayStandIn: LadderSwapTemplate = {
      programId: TOKENKEG,
      prefix: Uint8Array.of(3),
      suffix: new Uint8Array(0),
      patch: 'out',
      accounts: [
        { ref: 'sv0', writable: true },
        { ref: 'scratch', writable: true }, // credit goes to scratch, NOT outAta
        { ref: USER.owner, signer: true },
      ],
    };
    const pools: EcoSwapSvmPoolSpec[] = [{ venue: 'obric-v2', pool: obric.pool, swapOverride: underpayStandIn }];
    const amountIn = 500_000_000n;
    const output = await ecoSwapSvm({ amountIn, minOut: 1n, pools, user: USER, load: liveLoader, now: CLOCK });
    const staged = await stageEcoBlob(harness, 4, output);

    // Doctor the X oracle UP ~8% (inside the 25% band) → the prediction inflates.
    setAccount(obric.feedX, obric.accounts.find((a) => a.address === obric.feedX)!.owner, pythV2FeedBytes(108_000_000n, -8));
    const q = await quoteEcoSwapSvm({ amountIn, pools, load: liveLoader, now: CLOCK });
    expect(q.totalPredicted > 0n).toBe(true); // an over-optimistic, positive prediction

    const before = tokenAmount(harness, outAta);
    // minOut == the inflated prediction: predicted >= minOut clears the pre-CPI
    // "minOut" gate, so control reaches the TERMINAL realized-delta check.
    const result = await execEcoTrade(
      harness,
      staged,
      output,
      { [USER.outAta]: outAta, sv0, scratch },
      output.encodeTrade(amountIn, q.totalPredicted),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable: the underpaying trade must revert');
    expect(Buffer.from(result.revertData).toString('utf8')).toBe('out'); // terminal realized-delta gate
    expect(tokenAmount(harness, outAta)).toBe(before); // atomic rollback — nothing landed below minOut
    console.log(`terminal minOut backstop: over-optimistic predicted ${q.totalPredicted}, realized 0 → revert "out"`);
  });
});
