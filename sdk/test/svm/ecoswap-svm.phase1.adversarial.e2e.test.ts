/**
 * EcoSwapSVM Phase 1 ADVERSARIAL e2e (independent verification cells): the
 * stable warm-start chain and the saber amp-ramp interpolation exercised
 * ON THE ENGINE in configurations the main suites never land.
 *
 * Cells:
 *   a. MID-RAMP (amp ramping UP) saber beside a thin pumpswap CP pool, sized
 *      so the merge cut lands strictly INSIDE saber's warm rung 2 — the
 *      warm-start dout of the LAST stable rung is election-load-bearing and
 *      the final cold quote evaluates at a non-grid fill. The fragment's
 *      in-VM amp interpolation branch (tgt >= ini at a live mid-window
 *      clock) has never run on-engine before this cell — the checked-in
 *      saber fixture is long past its ramp at every suite clock. Landed
 *      through the PRODUCTION ecoSwapSvm path (budgeter degrades the CP slot
 *      4 -> 3), asserted lamport-exact against the solver mirror.
 *   b. MID-RAMP DOWN (tgt < ini — the fragment's OTHER interpolation branch)
 *      on an off-peg saber pool, single slot, landed and lamport-exact; the
 *      mirror proves the branch has teeth (mid-ramp quote != post-ramp
 *      quote, so a fragment taking the wrong branch would shift predicted
 *      by ~4e6 lamports and fail the gate).
 *   c. (mirror-only) the budgeter's rung degradation CHANGES the elected
 *      split on a crafted curve pair — 4-rung vs 3-rung ladders on the same
 *      quotes disagree — pinning that rung counts are functionally
 *      load-bearing, which is exactly why they must stay a pure function of
 *      (shape, budget), never of runtime CU.
 *   d. the damm-v1 locked-profit WRAPPED-CLOCK × ZERO-DEGRADATION corner ON
 *      THE ENGINE: with the cluster clock behind the vault's last_report the
 *      fragment's decay ratio wraps huge — but a zero degradation rate
 *      multiplies the wrap back to ratio 0, so the fragment takes the
 *      FULL-LOCK branch (total − locked), not the total_amount fallback.
 *      The mirror originally early-returned total for ANY rewound clock —
 *      this cell pins the corrected transcription lamport-exactly (a
 *      doctored A-vault with locked profit large enough to move the quote).
 *
 * Requires the engine .so; skips cleanly when absent.
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { address, lamports } from '@solana/kit';
import type { Address } from '@solana/kit';
import { meteoraDammV1Stable, meteoraDammV1StableLadder, saberStableswap, saberStableswapLadder } from '../../src/svm/index.js';
import type { AccountBytesMap, AccountLoader, LadderSwapTemplate, MeteoraDammV1StablePoolConfig } from '../../src/svm/index.js';
import {
  ecoSwapSvm,
  encodeEcoSwapSvmTrade,
  generateEcoSwapSvm,
  ladderGrid,
  solveReference,
} from '../../src/recipes/ecoswap/svm/index.js';
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
import { decodeEcoTrade, execEcoTrade, stageEcoBlob } from './ecoswap-svm.harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CLOCK = 1_783_175_236n;
const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };
const OUT_ATA_START = 5_000_000n;

/**
 * Mid-window amp ramps at CLOCK (deliberately non-round interpolants):
 * UP:   ini 20,  tgt 200, window [CLOCK-777, CLOCK+1223]  -> amp = 20 + floor(180*777/2000)  = 89
 * DOWN: ini 800, tgt 80,  window [CLOCK-1391, CLOCK+609]  -> amp = 800 - floor(720*1391/2000) = 300
 */
const RAMP_UP = { ini: 20n, tgt: 200n, start: CLOCK - 777n, stop: CLOCK + 1223n };
const RAMP_DOWN = { ini: 800n, tgt: 80n, start: CLOCK - 1391n, stop: CLOCK + 609n };

/** Overwrites a synthesized SwapInfo's flat amp with a live ramp window. */
function doctorRamp(data: Uint8Array, r: { ini: bigint; tgt: bigint; start: bigint; stop: bigint }): void {
  const view = new DataView(data.buffer, data.byteOffset);
  view.setBigUint64(3, r.ini, true); // initial_amp_factor
  view.setBigUint64(11, r.tgt, true); // target_amp_factor
  view.setBigUint64(19, r.start, true); // start_ramp_ts
  view.setBigUint64(27, r.stop, true); // stop_ramp_ts
}

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

describeSvm('ecoswap-svm phase 1 adversarial: mid-ramp stable warm chains on the engine', () => {
  let harness: EngineHarness;
  let liveLoader: AccountLoader;
  let usdtMint: Address;

  const placeSynthesized = (accounts: { address: Address; owner: Address; data: Uint8Array }[]): void => {
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
    loadFixtureAccounts(harness, loadFixtures(join(FIXTURES, 'pumpswap'))); // GlobalConfig/FeeConfig/USDC mint
    usdtMint = randomAddr();
    harness.svm.setAccount({
      address: usdtMint,
      data: syntheticMintBytes(6),
      executable: false,
      lamports: lamports(harness.svm.minimumBalanceForRentExemption(82n)),
      programAddress: TOKENKEG,
      space: 82n,
    });
    liveLoader = async (addr) => {
      const account = harness.svm.getAccount(addr);
      return account.exists ? new Uint8Array(account.data) : null;
    };
  });

  it('a. the cut lands INSIDE the mid-ramp saber warm rung 2 — production path, lamport-exact', async () => {
    // Saber: mildly off-peg, amp ramping UP and LIVE at CLOCK (interpolated
    // amp 89 — neither ini nor tgt). Pump: thin CP, spot ~1.07 pre-fee, so
    // it wins the early rungs and the stable absorbs the tail.
    const saber = synthesizeSaberPool(USDC_MINT, usdtMint, 30_000_000_000n, 31_500_000_000n, { feeNum: 25n, feeDen: 10_000n });
    doctorRamp(saber.accounts[0].data, RAMP_UP);
    const pump = synthesizePumpswapPool(20_000_000_000n, 21_400_000_000n, { baseMint: USDC_MINT, quoteMint: usdtMint });
    placeSynthesized([...saber.accounts, ...pump.accounts]);

    const AMOUNT_IN = 2_000_000_000n;
    const output = await ecoSwapSvm({
      amountIn: AMOUNT_IN,
      minOut: 1n,
      pools: [
        { venue: 'pumpswap', pool: pump.pool, direction: 'baseToQuote', swapOverride: standIn(0) },
        { venue: 'saber-stableswap', pool: saber.pool, swapOverride: standIn(1) },
      ],
      user: USER,
      load: liveLoader,
      now: CLOCK,
    });

    // The budgeter degrades the CP slot (4 -> 3) and keeps the stable at 2.
    expect(output.rungs).toEqual([3, 2]);

    // The ramp interpolation has teeth: the same bytes quoted past the ramp
    // window (amp = tgt 200) price differently than mid-window (amp 89).
    const state: Record<string, Uint8Array> = {};
    for (const account of [...saber.accounts, ...pump.accounts]) state[account.address] = account.data;
    const saberCfg = await saberStableswap.fetchPoolConfig(liveLoader, saber.pool);
    const midRamp = saberStableswapLadder.referenceQuote(saberCfg, state, [], CLOCK);
    const pastRamp = saberStableswapLadder.referenceQuote(saberCfg, state, [], RAMP_UP.stop + 1n);
    expect(midRamp(1_000_000_000n)).not.toBe(pastRamp(1_000_000_000n));

    // The cut is strictly INTERIOR to saber's warm rung 2: its elected fill
    // sits between the two grid points, so the warm-start dout decided the
    // election and the final cold quote runs at a non-grid x.
    const grid = ladderGrid(AMOUNT_IN, 2);
    expect(output.quote.slices[1]).toBeGreaterThan(grid[0]);
    expect(output.quote.slices[1]).toBeLessThan(grid[1]);
    expect(output.quote.slices[0]).toBeGreaterThan(0n);

    const outAta = setTokenAccount(harness, randomAddress(), usdtMint, harness.payer.address, OUT_ATA_START);
    const resolution: Record<string, Address> = {
      [USER.outAta]: outAta,
      sv0: setTokenAccount(harness, randomAddress(), usdtMint, harness.payer.address, 10n ** 15n),
      sv1: setTokenAccount(harness, randomAddress(), usdtMint, harness.payer.address, 10n ** 15n),
    };
    const staged = await stageEcoBlob(harness, 10, output);
    const result = await execEcoTrade(harness, staged, output, resolution, output.argValues);
    if (!result.ok) throw new Error(`mid-ramp split failed: ${result.err}\n${result.logs.join('\n')}`);

    const words = decodeEcoTrade(result.returnData, 2);
    expect(words.slices).toEqual(output.quote.slices); // lamport-exact election
    expect(words.predictedOuts).toEqual(output.quote.predictedOuts); // cold finals at the interior fill
    expect(words.realized).toBe(output.quote.totalPredicted);
    expect(words.slices[0] + words.slices[1]).toBe(AMOUNT_IN);
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + words.realized);
  });

  it('b. the DOWNWARD ramp branch (tgt < ini) on an off-peg pool lands lamport-exact', async () => {
    const saber = synthesizeSaberPool(USDC_MINT, usdtMint, 5_000_000_000n, 9_000_000_000n, { feeNum: 4n, feeDen: 10_000n });
    doctorRamp(saber.accounts[0].data, RAMP_DOWN);
    placeSynthesized(saber.accounts);

    const AMOUNT_IN = 1_000_000_000n;
    const output = await ecoSwapSvm({
      amountIn: AMOUNT_IN,
      minOut: 1n,
      pools: [{ venue: 'saber-stableswap', pool: saber.pool, swapOverride: standIn(0) }],
      user: USER,
      load: liveLoader,
      now: CLOCK,
    });
    expect(output.rungs).toEqual([2]);

    // Teeth: off-peg + a 300 -> 80 amp gap moves the quote by ~4e6 lamports,
    // so a fragment resolving the wrong ramp direction cannot pass the gate.
    const state: Record<string, Uint8Array> = {};
    for (const account of saber.accounts) state[account.address] = account.data;
    const saberCfg = await saberStableswap.fetchPoolConfig(liveLoader, saber.pool);
    const midRamp = saberStableswapLadder.referenceQuote(saberCfg, state, [], CLOCK);
    const pastRamp = saberStableswapLadder.referenceQuote(saberCfg, state, [], RAMP_DOWN.stop + 1n);
    expect(midRamp(AMOUNT_IN)).not.toBe(pastRamp(AMOUNT_IN));
    expect(output.quote.predictedOuts[0]).toBe(midRamp(AMOUNT_IN));

    const outAta = setTokenAccount(harness, randomAddress(), usdtMint, harness.payer.address, OUT_ATA_START);
    const resolution: Record<string, Address> = {
      [USER.outAta]: outAta,
      sv0: setTokenAccount(harness, randomAddress(), usdtMint, harness.payer.address, 10n ** 15n),
    };
    const staged = await stageEcoBlob(harness, 11, output);
    const result = await execEcoTrade(harness, staged, output, resolution, output.argValues);
    if (!result.ok) throw new Error(`down-ramp trade failed: ${result.err}\n${result.logs.join('\n')}`);

    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.slices).toEqual([AMOUNT_IN]);
    expect(words.predictedOuts).toEqual([midRamp(AMOUNT_IN)]);
    expect(words.realized).toBe(midRamp(AMOUNT_IN));
    expect(tokenAmount(harness, outAta)).toBe(OUT_ATA_START + words.realized);
  });

  it('c. (mirror) rung degradation CHANGES the split on a crafted curve pair — rung counts are load-bearing', () => {
    // Piecewise-linear concave slot A: rich first 1000, then flattening.
    // Its 4-rung ladder exposes a 2.6-priced first rung; collapsed to 3
    // rungs the same span averages 1.85. Slot B is flat at 1.2, BETWEEN
    // A's 4-rung second rung (1.1) and A's 3-rung first rung (1.85) — so
    // the election order (and the landed split) flips with the rung count.
    const points: [bigint, bigint][] = [
      [0n, 0n],
      [1_000n, 2_600n],
      [2_000n, 3_700n],
      [4_000n, 4_400n],
      [8_000n, 4_900n],
    ];
    const qa = (x: bigint): bigint => {
      for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1];
        const [x1, y1] = points[i];
        if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
      return points[points.length - 1][1];
    };
    const qb = (x: bigint): bigint => (6n * x) / 5n;

    const at4 = solveReference([{ quote: qa, rungs: 4 }, { quote: qb, rungs: 2 }], 8_000n);
    const at3 = solveReference([{ quote: qa, rungs: 3 }, { quote: qb, rungs: 2 }], 8_000n);
    expect(at4.slices).toEqual([1_000n, 7_000n]);
    expect(at3.slices).toEqual([2_000n, 6_000n]);
    expect(at4.slices[0] + at4.slices[1]).toBe(8_000n);
    expect(at3.slices[0] + at3.slices[1]).toBe(8_000n);
    // Same curves, different quantization, different landed split — which is
    // why the rung plan must be decided off-chain (budget.ts) and mirrored,
    // never adapted from runtime CU.
    expect(at4.slices).not.toEqual(at3.slices);
  });

  it('d. damm-v1 wrapped-clock x zero-degradation corner: the fragment takes the FULL-LOCK branch, engine-verified', async () => {
    // A fresh engine whose cluster clock sits BEHIND vault_a's last_report.
    const D1S_POOL = address('32D4zRxNc1EssbJieVHfPhZM3rH6CzfUPrWUuWxD9prG');
    const LAST_REPORT = 1_783_173_885n; // vault_a fixture value
    const REWOUND = LAST_REPORT - 500n;
    const corner = await startEngine(REWOUND);
    loadFixtureAccounts(corner, loadFixtures(join(FIXTURES, 'meteora-damm-v1-stable')));
    const cornerLoader: AccountLoader = async (addr) => {
      const account = corner.svm.getAccount(addr);
      return account.exists ? new Uint8Array(account.data) : null;
    };
    const cfg = (await meteoraDammV1Stable.fetchPoolConfig(cornerLoader, D1S_POOL)) as MeteoraDammV1StablePoolConfig;

    // Doctor vault_a: a big locked profit that NEVER decays (degradation 0).
    // In-VM: ratio = (rewound_clock - last_report) wraps huge, x 0 -> 0, so
    // the <= 1e12 branch RUNS and the full lock comes off the reserve.
    const vaultAccount = corner.svm.getAccount(cfg.aVault);
    if (!vaultAccount.exists) throw new Error('vault a missing');
    const doctored = new Uint8Array(vaultAccount.data);
    const view = new DataView(doctored.buffer, doctored.byteOffset);
    const total = view.getBigUint64(11, true);
    const LOCKED = total / 2n;
    view.setBigUint64(1203, LOCKED, true); // last_updated_locked_profit
    view.setBigUint64(1219, 0n, true); // locked_profit_degradation = 0
    corner.svm.setAccount({ ...vaultAccount, address: cfg.aVault, data: doctored });

    const state: AccountBytesMap = {};
    for (const account of meteoraDammV1StableLadder.quoteRefs(cfg, 0)) {
      if (account.address === undefined) continue;
      const data = await cornerLoader(account.address);
      if (data === null) throw new Error(`missing quote account ${account.address}`);
      state[account.address] = data;
    }

    const AMOUNT_IN = 1_000_000_000n;
    const fullLock = meteoraDammV1StableLadder.referenceQuote(cfg, state, [], REWOUND); // fixed mirror
    // The OLD mirror semantics (total_amount fallback) == the same bytes with
    // no locked profit at all; the two candidate readings must disagree here,
    // so the engine gate below genuinely arbitrates the corner.
    const undoctoredState: AccountBytesMap = { ...state, [cfg.aVault]: new Uint8Array(doctored) };
    new DataView(undoctoredState[cfg.aVault].buffer).setBigUint64(1203, 0n, true);
    const fallback = meteoraDammV1StableLadder.referenceQuote(cfg, undoctoredState, [], REWOUND);
    expect(fullLock(AMOUNT_IN)).not.toBe(fallback(AMOUNT_IN));

    const expected = solveReference([{ quote: fullLock, rungs: 2 }], AMOUNT_IN);
    const generated = generateEcoSwapSvm({
      slots: [{ adapter: meteoraDammV1StableLadder, cfg, rungs: 2, swapOverride: standIn(0) }],
      user: USER,
      cuFloor: 1,
    });

    const mint = randomAddr();
    corner.svm.setAccount({
      address: mint,
      data: syntheticMintBytes(6),
      executable: false,
      lamports: lamports(corner.svm.minimumBalanceForRentExemption(82n)),
      programAddress: TOKENKEG,
      space: 82n,
    });
    const outAta = setTokenAccount(corner, randomAddress(), mint, corner.payer.address, OUT_ATA_START);
    const resolution: Record<string, Address> = {
      [USER.outAta]: outAta,
      sv0: setTokenAccount(corner, randomAddress(), mint, corner.payer.address, 10n ** 15n),
    };
    const staged = await stageEcoBlob(corner, 12, generated);
    const result = await execEcoTrade(corner, staged, generated, resolution, [
      encodeEcoSwapSvmTrade([{ params: [] }], AMOUNT_IN, expected.totalPredicted),
    ]);
    if (!result.ok) throw new Error(`corner trade failed: ${result.err}\n${result.logs.join('\n')}`);

    const words = decodeEcoTrade(result.returnData, 1);
    expect(words.slices).toEqual(expected.slices);
    expect(words.predictedOuts).toEqual(expected.predictedOuts); // the FULL-LOCK reading, not the fallback
    expect(words.realized).toBe(expected.totalPredicted);
    expect(words.predictedOuts[0]).not.toBe(fallback(AMOUNT_IN));
    expect(tokenAmount(corner, outAta)).toBe(OUT_ATA_START + words.realized);
  });
});
