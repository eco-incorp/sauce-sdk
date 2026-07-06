/**
 * EcoSwapSVM full-universe INTEGRATION SMOKE (engine, SAUCE_ENGINE_SO) — the
 * "does the whole recipe wire together from the public API" gate, the SVM
 * analog of the EVM recipe's chains-fork lane. Where the per-family e2e suites
 * each exercise ONE model in depth, this one drives the PRODUCTION
 * `ecoSwapSvm` orchestrator end-to-end over a MULTI-FAMILY universe — prepare
 * (per-family fetchPoolConfig gates → relative-depth filter → CU budgeter →
 * shape selection) → codegen + staged compile → stage once → execute — and
 * asserts the landed trade is lamport-exact against the user-facing
 * `quoteEcoSwapSvm` and splits across THREE families in one instruction.
 *
 * The universe is synthetic-but-real-layout (the byte-exact venue account
 * images the per-family suites use), spanning three liquidity models:
 *   - obric-v2               PROP  (oracle-anchored, tier P-A)
 *   - raydium-cp-swap        CP    (constant product)
 *   - pumpswap               CP    (constant product, mainnet fee fixtures)
 * sized so obric's cheap early rungs, the raydium mid band and the deep
 * pumpswap tail each bind — all three engaged on a [3,3,2]-rung shape.
 *
 * Venue binaries are NOT deployed (repo stand-in convention): each slot's swap
 * CPI is an SPL-token-transfer stand-in paying the slot's predicted output
 * ({ patch: 'out' }), through the same runtime calldata-patch path the real
 * venue templates use. Quotes, ladders, the merge and the split are the
 * production path against live account bytes.
 *
 * Cells:
 *   a. FULL UNIVERSE: prepare → stage → executeStaged, the split lands across
 *      all three families, lamport-exact vs quoteEcoSwapSvm;
 *   b. STAGE ONCE, TRADE MANY: two more trades of different size on the SAME
 *      staged blob — different splits, each lamport-exact (the amortization
 *      claim: one stage, many executes);
 *   c. MULTI-MODEL UNIVERSE + CU shedding: add a saber-stableswap (STABLE)
 *      candidate — the orchestrator discovers and depth-keeps it, then the CU
 *      budgeter DROPS it (a stable slot pairs past the 1.4M cap with anything;
 *      see the recipe README "Honest limits") while the CP-class trio still
 *      lands lamport-exact.
 *
 * WHY LiteSVM and not a real cluster: no Sauce engine program is deployed on
 * any cluster yet (engine sauce#202 unmerged), so `stageEcoSwapSvm` /
 * `executeEcoSwapSvm` against a live RPC have nothing to target. The staged
 * buffer + execute_from_account instruction path this suite drives (via the
 * shared harness helpers) is byte-identical to what those production wrappers
 * emit through the RPC client — this is the same gate, on the same engine.so,
 * without a deployed cluster.
 *
 * Requires the engine .so (SAUCE_ENGINE_SO or the sibling sauce checkout);
 * skips cleanly when absent.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { address, lamports } from '@solana/kit';
import type { Address } from '@solana/kit';
import type { AccountLoader, LadderSwapTemplate } from '../../src/svm/index.js';
import { ecoSwapSvm, quoteEcoSwapSvm } from '../../src/recipes/ecoswap/svm/index.js';
import type { EcoSwapSvmOutput, EcoSwapSvmPoolSpec } from '../../src/recipes/ecoswap/svm/index.js';
import { describeSvm, randomAddress, setTokenAccount, startEngine, tokenAmount } from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';
import { loadFixtures } from './fixtures.js';
import {
  synthesizeObricPool,
  synthesizePumpswapPool,
  synthesizeRaydiumCpPool,
  synthesizeSaberPool,
  syntheticMintBytes,
  TOKENKEG,
  USDC_MINT,
} from './ecoswap-svm.fixtures.js';
import { decodeEcoTrade, execEcoTrade, stageEcoBlob } from './ecoswap-svm.harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CLOCK = 1_783_000_000n; // obric/CP read no clock; saber's amp is flat here
const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };
/** A synthetic 6-decimal input token (equal decimals with USDC → oracle decimalMult 1). */
const AAA_MINT = address('AAA1111111111111111111111111111111111111111');

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

describeSvm('ecoswap-svm SMOKE: full-universe multi-family split through the public orchestrator', () => {
  let harness: EngineHarness;
  let liveLoader: AccountLoader;
  const pumpFixtures = loadFixtures(join(FIXTURES, 'pumpswap'));

  const setAccount = (a: Address, owner: Address, data: Uint8Array): void =>
    harness.svm.setAccount({
      address: a,
      data,
      executable: false,
      lamports: lamports(harness.svm.minimumBalanceForRentExemption(BigInt(data.length))),
      programAddress: owner,
      space: BigInt(data.length),
    });

  // The tuned universe: obric shallow + cheapest fee (wins the small early
  // rungs), raydium mid, pumpswap deepest (catches the A/2 tail) — all three
  // bind on the [3,3,2] shape at AMOUNT_IN.
  let obric: ReturnType<typeof synthesizeObricPool>;
  let ray: ReturnType<typeof synthesizeRaydiumCpPool>;
  let pump: ReturnType<typeof synthesizePumpswapPool>;
  let poolSpecs: EcoSwapSvmPoolSpec[];
  const AMOUNT_IN = 16_000_000_000n;

  const buildUniverse = (): void => {
    obric = synthesizeObricPool({
      bigK: 10n ** 22n,
      reserveX: 5_000_000_000n,
      reserveY: 5_000_000_000n,
      priceX: 100_000_000n, // 1:1 @ expo −8
      priceY: 100_000_000n,
      mintX: AAA_MINT,
      mintY: USDC_MINT,
    });
    ray = synthesizeRaydiumCpPool(15_000_000_000n, 15_000_000_000n, { mint0: AAA_MINT, mint1: USDC_MINT });
    pump = synthesizePumpswapPool(50_000_000_000n, 50_000_000_000n, { baseMint: AAA_MINT, quoteMint: USDC_MINT });
    for (const a of [...obric.accounts, ...ray.accounts, ...pump.accounts]) setAccount(a.address, a.owner, a.data);
    poolSpecs = [
      { venue: 'obric-v2', pool: obric.pool, swapOverride: standIn(0) },
      { venue: 'raydium-cp-swap', pool: ray.pool, direction: '0to1', swapOverride: standIn(1) },
      { venue: 'pumpswap', pool: pump.pool, direction: 'baseToQuote', swapOverride: standIn(2) },
    ];
  };

  /** Fresh out ATA + three funded stand-in source vaults (USDC), per trade set. */
  const freshCustody = (): { outAta: Address; sv0: Address; sv1: Address; sv2: Address } => ({
    outAta: setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, 5_000_000n),
    sv0: setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, 10n ** 15n),
    sv1: setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, 10n ** 15n),
    sv2: setTokenAccount(harness, randomAddress(), USDC_MINT, harness.payer.address, 10n ** 15n),
  });

  let output: EcoSwapSvmOutput;
  let buffer: { buffer: Address };
  let custody: { outAta: Address; sv0: Address; sv1: Address; sv2: Address };

  beforeAll(async () => {
    harness = await startEngine(CLOCK);
    // The mainnet pumpswap GlobalConfig/FeeConfig fixtures (flat 25/5 bps for
    // the default-creator pool), plus both 6-decimal mints.
    for (const account of pumpFixtures) {
      setAccount(address(account.address), address(account.owner), Buffer.from(account.base64Data, 'base64'));
    }
    setAccount(AAA_MINT, TOKENKEG, syntheticMintBytes(6));
    setAccount(USDC_MINT, TOKENKEG, syntheticMintBytes(6));
    liveLoader = async (addr) => {
      const account = harness.svm.getAccount(addr);
      return account.exists ? new Uint8Array(account.data) : null;
    };

    buildUniverse();
    custody = freshCustody();

    // PRODUCTION orchestrator: fetch gates → relative-depth filter → CU budgeter
    // → shape codegen → staged compile. No slot count/rungs passed — the
    // budgeter fixes them from the universe.
    output = await ecoSwapSvm({ amountIn: AMOUNT_IN, minOut: 1n, pools: poolSpecs, user: USER, load: liveLoader, now: CLOCK });
    buffer = await stageEcoBlob(harness, 0, output);
  });

  const resolutionFor = (c: typeof custody): Record<string, Address> => ({
    [USER.outAta]: c.outAta,
    sv0: c.sv0,
    sv1: c.sv1,
    sv2: c.sv2,
  });

  it('a. full universe: prepare → stage → execute, the split lands across all THREE families lamport-exact', async () => {
    // The budgeter admitted all three CP-class families (obric is CP-class) at
    // the [3,3,2] shape — three families, no drops.
    expect(output.slots.map((s) => s.venue)).toEqual(['obric-v2', 'raydium-cp-swap', 'pumpswap']);
    expect(output.slots.map((s) => s.rungs)).toEqual([3, 3, 2]);
    expect(output.quote.dropped).toEqual([]);
    expect(output.shapeKey).toContain('obric-v2:xToY');
    expect(output.shapeKey).toContain('raydium-cp');
    expect(output.shapeKey).toContain('pumpswap');
    expect(output.quote.estimatedCu).toBeLessThan(1_400_000);

    // The user-facing quote equals the prepared shape's quote (one solver, no
    // simulation) — and matches the staged output's baked quote.
    const quote = await quoteEcoSwapSvm({ amountIn: AMOUNT_IN, pools: poolSpecs, load: liveLoader, now: CLOCK });
    expect(quote.slices).toEqual(output.quote.slices);
    expect(quote.totalPredicted).toBe(output.quote.totalPredicted);
    expect(quote.slices.filter((s) => s > 0n)).toHaveLength(3); // all three engaged
    expect(quote.slices.reduce((sum, s) => sum + s, 0n)).toBe(AMOUNT_IN); // conservation

    const before = tokenAmount(harness, custody.outAta);
    const result = await execEcoTrade(harness, buffer, output, resolutionFor(custody), output.encodeTrade(AMOUNT_IN, quote.totalPredicted));
    if (!result.ok) throw new Error(`full-universe trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 3);

    // LAMPORT-EXACT gate: the in-VM split == the off-chain mirror on the same bytes.
    expect(words.slices).toEqual(quote.slices);
    expect(words.predictedOuts).toEqual(quote.predictedOuts);
    expect(words.realized).toBe(quote.totalPredicted);
    // The split landed across three families in ONE instruction.
    expect(words.slices.filter((s) => s > 0n)).toHaveLength(3);
    expect(words.slices.reduce((sum, s) => sum + s, 0n)).toBe(AMOUNT_IN);
    expect(words.realized).toBe(words.predictedOuts.reduce((sum, p) => sum + p, 0n));
    expect(tokenAmount(harness, custody.outAta)).toBe(before + words.realized);
    expect(result.cu).toBeLessThan(1_400_000n); // under the transaction cap
    expect(output.bytecode.length).toBeLessThan(65_535); // under the staged buffer cap
    console.log(
      `full universe: ${result.cu} CU (cap 1,400,000), blob ${output.bytecode.length} B, ` +
        `slices ${words.slices.join('/')}, out ${words.realized}`,
    );
  });

  it('b. stage once, trade many: two more sizes on the SAME staged blob, each split exact', async () => {
    // The amortization claim: the blob staged in `beforeAll` serves any trade
    // amount — re-encode the cfg args, execute, no re-stage. Different amounts
    // give different splits, each lamport-exact against the mirror.
    for (const amountIn of [8_000_000_000n, 24_000_000_000n]) {
      const c = freshCustody();
      const quote = await quoteEcoSwapSvm({ amountIn, pools: poolSpecs, load: liveLoader, now: CLOCK });
      const before = tokenAmount(harness, c.outAta);
      const result = await execEcoTrade(harness, buffer, output, resolutionFor(c), output.encodeTrade(amountIn, quote.totalPredicted));
      if (!result.ok) throw new Error(`trade(${amountIn}) failed: ${result.err}\n${result.logs.join('\n')}`);
      const words = decodeEcoTrade(result.returnData, 3);
      expect(words.slices).toEqual(quote.slices);
      expect(words.predictedOuts).toEqual(quote.predictedOuts);
      expect(words.realized).toBe(quote.totalPredicted);
      expect(words.slices.reduce((sum, s) => sum + s, 0n)).toBe(amountIn);
      expect(words.slices).not.toEqual(output.quote.slices); // a different amount IS a different split
      expect(tokenAmount(harness, c.outAta)).toBe(before + words.realized);
      console.log(`stage-once/trade-many: amountIn ${amountIn} → slices ${words.slices.join('/')}, out ${words.realized}`);
    }
  });

  it('c. multi-model universe: the CU budgeter sheds the STABLE slot, the CP-class trio still lands exact', async () => {
    // Add a saber-stableswap (STABLE model) to the CP-class universe. The
    // orchestrator discovers it and it survives the relative-depth filter — but
    // a stable slot models past the 1.4M cap paired with anything (README
    // "Honest limits"), so the CU budgeter DROPS it (reason 'budget'), landing
    // the three CP-class families. This proves the public path handles a
    // genuinely multi-model candidate set and sheds the CU-heavy family.
    const saber = synthesizeSaberPool(AAA_MINT, USDC_MINT, 12_000_000_000n, 12_000_000_000n);
    for (const a of saber.accounts) setAccount(a.address, a.owner, a.data);

    const universe: EcoSwapSvmPoolSpec[] = [
      ...poolSpecs,
      { venue: 'saber-stableswap', pool: saber.pool, swapOverride: standIn(3) },
    ];
    const amountIn = 16_000_000_000n;
    const outputC = await ecoSwapSvm({ amountIn, minOut: 1n, pools: universe, user: USER, load: liveLoader, now: CLOCK });

    // The stable slot was discovered + depth-kept, then CU-dropped; the three
    // CP-class families are the landed shape.
    expect(outputC.slots.map((s) => s.venue)).toEqual(['obric-v2', 'raydium-cp-swap', 'pumpswap']);
    expect(outputC.quote.dropped.map((d) => `${d.venue}:${d.reason}`)).toEqual(['saber-stableswap:budget']);
    expect(outputC.warnings.some((w) => w.includes('saber-stableswap') && w.includes('CU budget'))).toBe(true);

    const quote = await quoteEcoSwapSvm({ amountIn, pools: universe, load: liveLoader, now: CLOCK });
    expect(quote.slices).toEqual(outputC.quote.slices);
    expect(quote.dropped.map((d) => d.venue)).toEqual(['saber-stableswap']);
    expect(outputC.slots.map((s) => s.rungs)).toEqual([2, 2, 2]); // shedding the stable forced the trio to MIN_RUNGS
    // At the coarser [2,2,2] shape the geometric grid is [A/2, A], so the trade
    // resolves into two A/2 chunks and the deepest pool absorbs them (only
    // [3,3,2]+ shapes chop finely enough for all three to bind — cell a). The
    // landed trade must still be lamport-exact and fully assigned.
    expect(quote.slices.filter((s) => s > 0n).length).toBeGreaterThanOrEqual(1);
    expect(quote.slices.reduce((sum, s) => sum + s, 0n)).toBe(amountIn);

    const c = freshCustody();
    const stagedC = await stageEcoBlob(harness, 1, outputC);
    const before = tokenAmount(harness, c.outAta);
    const result = await execEcoTrade(harness, stagedC, outputC, resolutionFor(c), outputC.encodeTrade(amountIn, quote.totalPredicted));
    if (!result.ok) throw new Error(`multi-model trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const words = decodeEcoTrade(result.returnData, 3);
    expect(words.slices).toEqual(quote.slices);
    expect(words.predictedOuts).toEqual(quote.predictedOuts);
    expect(words.realized).toBe(quote.totalPredicted);
    expect(words.slices.reduce((sum, s) => sum + s, 0n)).toBe(amountIn);
    expect(tokenAmount(harness, c.outAta)).toBe(before + words.realized);
    console.log(
      `multi-model shed: dropped ${outputC.quote.dropped.map((d) => d.venue).join(',')} (budget), ` +
        `landed slices ${words.slices.join('/')}, ${result.cu} CU`,
    );
  });
});
