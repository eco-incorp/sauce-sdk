/**
 * EcoSwapSVM Phase 1 e2e on the REAL engine (LiteSVM): the cp+stable split.
 *
 * Universe (one USDC → USDT pair): the mainnet saber-stableswap fixture
 * (deep, near-1:1 stable pricing) + a synthesized pumpswap pool (shallow but
 * better-priced at spot: base = USDC, quote = a synthetic USDT, sell
 * direction), sized so pumpswap wins the early rungs and saber absorbs the
 * rest — a real cross-CLASS split (CP curve beside Newton stableswap in ONE
 * atomic instruction).
 *
 * Cells:
 *   a. the CU budgeter in anger: pump+saber models over the default
 *      admission budget → the pump slot degrades 4 → 3 rungs
 *      (deterministically, with a warning), the stable slot stays at its
 *      2-rung default — asserted on the PRODUCTION ecoSwapSvm output;
 *   b. the split lands: both slots engaged, LAMPORT-EXACT against the
 *      solver mirror (slices, predicted outs, realized total), custody on
 *      the outAta delta;
 *   c. adaptive-degradation determinism: preparing twice yields identical
 *      blobs/rungs/warnings, and executing the same args twice yields
 *      identical returndata (rung counts are a pure function of
 *      (shape, budget) — never of runtime CU);
 *   d. budgeter rejection: saber + meteora-damm-v1-stable models past the
 *      budget → the tail stable slot is DROPPED (reason 'budget', warned);
 *      a raised cuBudget re-admits it (quote-only);
 *   e. the GasLeft floor: executing under the shape's modeled CU throws the
 *      typed "cu" revert BEFORE any work — nothing lands;
 *   f. stable drift/re-anchor: doctor the saber out-vault between prepare
 *      and execute — the SAME blob + args re-anchor the split on the live
 *      bytes, still exact vs the mirror.
 *
 * Requires the engine .so; skips cleanly when absent.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { address, lamports } from '@solana/kit';
import type { Address } from '@solana/kit';
import { pumpswapAdapter, pumpswapLadder, saberStableswap, saberStableswapLadder } from '../../src/svm/index.js';
import type { AccountLoader, LadderSwapTemplate } from '../../src/svm/index.js';
import { ecoSwapSvm, quoteEcoSwapSvm, solveReference } from '../../src/recipes/ecoswap/svm/index.js';
import type { EcoSwapSvmOutput, EcoSwapSvmPoolSpec } from '../../src/recipes/ecoswap/svm/index.js';
import { describeSvm, loadFixtureAccounts, randomAddress, setTokenAccount, startEngine, tokenAmount } from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';
import { loadFixtures } from './fixtures.js';
import {
  randomAddr,
  synthesizePumpswapPool,
  synthesizeSaberPool,
  syntheticMintBytes,
  TOKENKEG,
  USDC_MINT,
} from './ecoswap-svm.fixtures.js';
import type { SynthesizedPumpswapPool } from './ecoswap-svm.fixtures.js';
import { decodeEcoTrade, execEcoTrade, stageEcoBlob } from './ecoswap-svm.harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SABER_POOL = address('YAkoNb6HKmSxQN9L8hiBE5tPJRsniSSMzND1boHmZxe');
const D1S_POOL = address('32D4zRxNc1EssbJieVHfPhZM3rH6CzfUPrWUuWxD9prG');
/** The damm-v1-stable snapshot clock — saber's amp ramp is long finished by it. */
const CLOCK = 1_783_175_236n;
const AMOUNT_IN = 2_000_000_000n; // 2000 USDC against a 20k-USDC pump pool + the deep saber fixture
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

describeSvm('ecoswap-svm phase 1 e2e: cp+stable split, budgeter, GasLeft floor', () => {
  let harness: EngineHarness;
  let liveLoader: AccountLoader;
  let pump: SynthesizedPumpswapPool;
  let usdtMint: Address;
  let poolSpecs: EcoSwapSvmPoolSpec[];
  let output: EcoSwapSvmOutput;
  let staged: { buffer: Address };
  let outAta: Address;
  let vaults: Address[];
  let baseline: { slices: bigint[]; predictedOuts: bigint[]; realized: bigint };

  const resolution = (): Record<string, Address> => ({
    [USER.outAta]: outAta,
    sv0: vaults[0],
    sv1: vaults[1],
  });

  beforeAll(async () => {
    harness = await startEngine(CLOCK);
    loadFixtureAccounts(harness, loadFixtures(join(FIXTURES, 'saber-stableswap')));
    loadFixtureAccounts(harness, loadFixtures(join(FIXTURES, 'meteora-damm-v1-stable')));

    // The synthetic USDT mint + the pump pool: base = USDC in, quote = USDT
    // out (sell), spot ≈ 1.03 − 30 bps — beats saber's ≈ 1.0006 until the
    // shallow curve dives.
    usdtMint = randomAddr();
    harness.svm.setAccount({
      address: usdtMint,
      data: syntheticMintBytes(6),
      executable: false,
      lamports: lamports(harness.svm.minimumBalanceForRentExemption(82n)),
      programAddress: TOKENKEG,
      space: 82n,
    });
    // The pump fixture set carries the real USDC mint + global/fee configs.
    loadFixtureAccounts(harness, loadFixtures(join(FIXTURES, 'pumpswap')));
    pump = synthesizePumpswapPool(20_000_000_000n, 20_600_000_000n, { baseMint: USDC_MINT, quoteMint: usdtMint });
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

    liveLoader = async (addr) => {
      const account = harness.svm.getAccount(addr);
      return account.exists ? new Uint8Array(account.data) : null;
    };

    poolSpecs = [
      { venue: 'pumpswap', pool: pump.pool, direction: 'baseToQuote', swapOverride: standIn(0) },
      { venue: 'saber-stableswap', pool: SABER_POOL, swapOverride: standIn(1) },
    ];

    output = await ecoSwapSvm({
      amountIn: AMOUNT_IN,
      minOut: 1n,
      pools: poolSpecs,
      user: USER,
      load: liveLoader,
      now: CLOCK,
    });

    outAta = setTokenAccount(harness, randomAddress(), usdtMint, harness.payer.address, OUT_ATA_START);
    vaults = [
      setTokenAccount(harness, randomAddress(), usdtMint, harness.payer.address, 10n ** 15n),
      setTokenAccount(harness, randomAddress(), usdtMint, harness.payer.address, 10n ** 15n),
    ];

    staged = await stageEcoBlob(harness, 0, output);
  });

  it('a. the budgeter degrades the CP slot to 3 rungs and keeps the stable slot at 2 — deterministically, with a warning', () => {
    expect(output.rungs).toEqual([3, 2]);
    expect(output.slots.map((s) => s.rungs)).toEqual([3, 2]);
    expect(output.shapeKey).toBe(
      `pumpswap:baseToQuote~r3#ov:out:${TOKENKEG}:3|saber-stableswap:AtoB~r2#ov:out:${TOKENKEG}:3`,
    );
    expect(output.quote.warnings).toHaveLength(1);
    expect(output.quote.warnings[0]).toContain('degraded slot 0 (pumpswap) to 3 rungs');
    expect(output.quote.estimatedCu).toBeGreaterThan(1_000_000);
    expect(output.quote.estimatedCu).toBeLessThanOrEqual(1_190_000);
    // The GasLeft floor is the modeled estimate, baked into the source.
    expect(output.source).toContain(`if (gasLeft() < ${output.quote.estimatedCu}) { throw "cu" }`);
  });

  it('b. the cp+stable split lands: both slots engaged, lamport-exact vs the mirror, custody on the outAta delta', async () => {
    const quote = await quoteEcoSwapSvm({ amountIn: AMOUNT_IN, pools: poolSpecs, load: liveLoader, now: CLOCK });
    expect(quote.slices).toEqual(output.quote.slices);

    const result = await execEcoTrade(harness, staged, output, resolution(), output.encodeTrade(AMOUNT_IN, quote.totalPredicted));
    if (!result.ok) throw new Error(`trade failed: ${result.err}\n${result.logs.join('\n')}`);
    baseline = decodeEcoTrade(result.returnData, 2);

    expect(baseline.slices).toEqual(quote.slices);
    expect(baseline.predictedOuts).toEqual(quote.predictedOuts);
    expect(baseline.realized).toBe(quote.totalPredicted);
    expect(baseline.slices[0] > 0n && baseline.slices[1] > 0n).toBe(true); // CP AND stable engaged
    expect(baseline.slices[0] + baseline.slices[1]).toBe(AMOUNT_IN);
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + baseline.realized);
    console.log(`cp+stable split: ${result.cu} CU (floor ${output.quote.estimatedCu}), slices ${baseline.slices.join('/')}`);
  });

  it('c. degradation is deterministic: same inputs → same blob; same args → same returndata', async () => {
    const again = await ecoSwapSvm({
      amountIn: AMOUNT_IN,
      minOut: 1n,
      pools: poolSpecs,
      user: USER,
      load: liveLoader,
      now: CLOCK,
    });
    expect(Buffer.from(again.bytecode).toString('hex')).toBe(Buffer.from(output.bytecode).toString('hex'));
    expect(again.rungs).toEqual(output.rungs);
    expect(again.quote.warnings).toEqual(output.quote.warnings);
    expect(again.quote.slices).toEqual(output.quote.slices);

    // Same staged blob, same args, pool state untouched (stand-ins spend
    // harness vaults) — byte-identical solver outcome.
    const rerun = await execEcoTrade(harness, staged, output, resolution(), output.encodeTrade(AMOUNT_IN, baseline.realized));
    if (!rerun.ok) throw new Error(`rerun failed: ${rerun.err}`);
    const words = decodeEcoTrade(rerun.returnData, 2);
    expect(words.slices).toEqual(baseline.slices);
    expect(words.predictedOuts).toEqual(baseline.predictedOuts);
    expect(words.realized).toBe(baseline.realized);
  });

  it('d. budgeter rejection: saber + meteora-damm-v1-stable drops the tail stable slot; a raised cuBudget re-admits it', async () => {
    const pools: EcoSwapSvmPoolSpec[] = [
      { venue: 'saber-stableswap', pool: SABER_POOL },
      { venue: 'meteora-damm-v1-stable', pool: D1S_POOL },
    ];
    const rejected = await quoteEcoSwapSvm({ amountIn: 1_000_000_000n, pools, load: liveLoader, now: CLOCK, minRelBps: 0 });
    expect(rejected.slots.map((s) => s.venue)).toEqual(['saber-stableswap']);
    expect(rejected.dropped).toEqual([
      expect.objectContaining({ pool: D1S_POOL, venue: 'meteora-damm-v1-stable', reason: 'budget' }),
    ]);
    expect(rejected.warnings.some((w) => w.includes('dropped slot 1 (meteora-damm-v1-stable)'))).toBe(true);
    expect(rejected.slices).toEqual([1_000_000_000n]); // saber absorbs the whole trade

    // Forcing a higher budget re-admits the heavy slot (quote-only — the
    // modeled shape exceeds the real 1.4M transaction cap).
    const forced = await quoteEcoSwapSvm({
      amountIn: 1_000_000_000n,
      pools,
      load: liveLoader,
      now: CLOCK,
      minRelBps: 0,
      cuBudget: 2_000_000,
    });
    expect(forced.slots.map((s) => s.venue)).toEqual(['saber-stableswap', 'meteora-damm-v1-stable']);
    expect(forced.dropped).toEqual([]);
    expect(forced.slices[0] + forced.slices[1]).toBe(1_000_000_000n);
  });

  it('e. the GasLeft floor: a compute budget under the modeled cost reverts "cu" before any work', async () => {
    const before = tokenAmount(harness, outAta);
    const starved = await execEcoTrade(
      harness,
      staged,
      output,
      resolution(),
      output.encodeTrade(AMOUNT_IN, 1n),
      Math.max(200_000, output.quote.estimatedCu - 400_000),
    );
    expect(starved.ok).toBe(false);
    if (starved.ok) throw new Error('unreachable');
    expect(Buffer.from(starved.revertData).toString('utf8')).toBe('cu');
    expect(tokenAmount(harness, outAta)).toBe(before); // nothing landed
  });

  it('f. stable drift/re-anchor: PAUSING saber between prepare and execute reroutes the SAME blob live, still exact', async () => {
    // The most drastic stable drift there is: flip the live is_paused byte.
    // The fragment reads it at execute time — the stable slot quotes 0, its
    // CPI is skipped, and the CP slot absorbs the whole trade.
    const saberPool = output.accountPlan.metas.find((m) => m.ref === 's1:pool')?.pubkey;
    expect(saberPool).toBeDefined();
    const account = harness.svm.getAccount(address(saberPool!));
    if (!account.exists) throw new Error('saber pool missing');
    const original = new Uint8Array(account.data);
    const doctored = new Uint8Array(original);
    doctored[1] = 1; // is_paused
    harness.svm.setAccount({ ...account, address: address(saberPool!), data: doctored });

    // The full prepare GATES a paused pool (fetchPoolConfig throws), which is
    // the right call for a fresh trade — the drift scenario is prepare
    // BEFORE the pause, so the mirror here is the raw solver reference over
    // the doctored bytes with the ALREADY-COMPILED shape's rungs.
    const state: Record<string, Uint8Array> = {};
    for (const meta of output.accountPlan.metas) {
      if (meta.pubkey === undefined) continue;
      const data = await liveLoader(address(meta.pubkey));
      if (data !== null) state[meta.pubkey] = data;
    }
    const pumpCfg = { ...(await pumpswapAdapter.fetchPoolConfig(liveLoader, pump.pool)), direction: 'baseToQuote' as const };
    const saberCfg = await saberStableswap.fetchPoolConfig(
      async (addr) => (addr === SABER_POOL ? new Uint8Array(original) : liveLoader(addr)), // fetch gates on the PRE-pause bytes
      SABER_POOL,
    );
    const driftQuote = solveReference(
      [
        { quote: pumpswapLadder.referenceQuote(pumpCfg, state, output.slots[0].params), rungs: output.rungs[0] },
        {
          quote: saberStableswapLadder.referenceQuote(saberCfg, state, [], CLOCK),
          ladderQuotes: saberStableswapLadder.referenceLadderQuotes!(saberCfg, state, [], CLOCK),
          rungs: output.rungs[1],
        },
      ],
      AMOUNT_IN,
    );
    expect(driftQuote.slices).toEqual([AMOUNT_IN, 0n]); // the mirror already reroutes
    expect(driftQuote.predictedOuts[1]).toBe(0n);

    const result = await execEcoTrade(harness, staged, output, resolution(), output.encodeTrade(AMOUNT_IN, driftQuote.totalPredicted));
    if (!result.ok) throw new Error(`drift trade failed: ${result.err}\n${result.logs.join('\n')}`);
    const drift = decodeEcoTrade(result.returnData, 2);

    expect(drift.slices).toEqual(driftQuote.slices);
    expect(drift.predictedOuts).toEqual(driftQuote.predictedOuts);
    expect(drift.realized).toBe(driftQuote.totalPredicted);
    expect(drift.realized).toBeLessThan(baseline.realized); // the lone CP curve prices the trade worse

    harness.svm.setAccount({ ...account, address: address(saberPool!), data: original }); // restore
  });
});
