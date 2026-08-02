/**
 * IDENTITY PROOF for the incremental bin-walk CU optimization
 * (emitBinWalkIncremental, see ladder.ts): compiled bytecode is executed
 * through the REAL vendored SVM engine (LiteSVM, artifacts/svm/engine.so)
 * against the real mainnet fixture pool 5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6.
 *
 * Two independently-compiled program shapes are compared at every rung:
 *  - INCREMENTAL: ONE program emitting emitSetup + emitLadderQuote for rungs
 *    0..N in sequence (the persisted wk/wcb/wob cursor carries across rungs
 *    WITHIN this one execution, exactly as a real multi-rung cook does),
 *    returning each rung's own output variable.
 *  - RESTART: for the SAME cumulative x, a SEPARATE one-shot program using
 *    the untouched emitFinalQuote (a full restart-from-bin-0 walk, exactly
 *    the pre-optimization behavior) -- the independent ground truth.
 *
 * Sizes cross a REAL bin/saturation boundary (not just organic growth): the
 * ratio out/in is essentially flat through 2.2e12, then genuinely drops at
 * 3.298e12 (a real bin transition), then plateaus (saturated) at 4.4e12 --
 * confirmed separately against referenceQuote before this file was written.
 *
 * Per the design brief: if identity breaks anywhere here, the incremental
 * optimization must be dropped from the PR, not tuned until this passes.
 */
import { resolve } from 'path';
import { compile } from '@eco-incorp/sauce-compiler';
import {
  buildComputeBudgetPrepend,
  buildExecuteInstruction,
  buildHeapFramePrepend,
  resolveAccounts,
} from '../../../src/svm/index.js';
import type { AccountResolution } from '../../../src/svm/index.js';
import { meteoraDlmm } from '../../../src/svm/venues/meteora-dlmm/index.js';
import { meteoraDlmmLadder } from '../../../src/svm/venues/meteora-dlmm/ladder.js';
import type { MeteoraDlmmPoolConfig } from '../../../src/svm/venues/meteora-dlmm/index.js';
import { fixtureLoader, loadFixtures } from '../fixtures.js';
import {
  describeSvm,
  expectOk,
  loadFixtureAccounts,
  sendInstructions,
  startEngine,
  toBigInt,
} from '../engine-harness.js';
import type { EngineHarness } from '../engine-harness.js';

const POOL_ADDRESS = '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6';
// Matches the `now` used to characterize this pool's organic-growth/cliff
// shape via referenceQuote before this file was written -- the volatility
// decay model is `now`-sensitive, so the chosen SIZES below are only valid
// for this exact value.
const NOW = 2_000_000_000n;
// Spans organic growth (1e12), the drift zone (2.5e12), the real bin/saturation
// transition (3,298,534,883,328 -- ratio genuinely drops here), and full
// saturation (4,398,046,511,104 -- plateaued, confirmed via referenceQuote).
const SIZES = [1_000_000_000_000n, 2_500_000_000_000n, 3_298_534_883_328n, 4_398_046_511_104n];

async function loadCfgAndResolution(harness: EngineHarness): Promise<{ cfg: MeteoraDlmmPoolConfig; resolution: AccountResolution }> {
  const fixtures = loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/meteora-dlmm'));
  loadFixtureAccounts(harness, fixtures);
  const loader = fixtureLoader(fixtures);
  const cfg = (await meteoraDlmm.fetchPoolConfig(loader, POOL_ADDRESS as never)) as MeteoraDlmmPoolConfig;
  const resolution: AccountResolution = Object.fromEntries(
    meteoraDlmmLadder.quoteRefs(cfg, 0).map((va) => [va.ref, va.address]),
  );
  return { cfg, resolution };
}

async function runQuote(harness: EngineHarness, resolution: AccountResolution, source: string): Promise<bigint> {
  const { bytecode, accountPlan } = compile(source, { target: 'svm' });
  const accounts = resolveAccounts(accountPlan!, resolution, harness.payer.address);
  const execute = buildExecuteInstruction({ programId: harness.programId, bytecode: bytecode[0]!, accounts });
  const result = expectOk(
    await sendInstructions(harness, [...buildComputeBudgetPrepend({ unitLimit: 1_400_000 }), buildHeapFramePrepend(), execute]),
  );
  return toBigInt(result.returnData);
}

/** ONE program: emitSetup + incremental emitLadderQuote for rungs 0..upToRung, returns the LAST rung's output. */
function incrementalSource(cfg: MeteoraDlmmPoolConfig, paramStrs: string[], sizes: readonly bigint[], upToRung: number): string {
  const rungLines = sizes
    .slice(0, upToRung + 1)
    .map((size, i) => meteoraDlmmLadder.emitLadderQuote(cfg, 0, i, size.toString(), `q${i}`));
  return [
    'function main() {',
    '  let s0en = 1;',
    meteoraDlmmLadder.emitSetup(cfg, 0, paramStrs, 's0en'),
    ...rungLines,
    `  return q${upToRung};`,
    '}',
  ].join('\n');
}

/** A SEPARATE one-shot program: emitSetup + the untouched restart-based emitFinalQuote at x. */
function restartSource(cfg: MeteoraDlmmPoolConfig, paramStrs: string[], x: bigint): string {
  return [
    'function main() {',
    '  let s0en = 1;',
    meteoraDlmmLadder.emitSetup(cfg, 0, paramStrs, 's0en'),
    meteoraDlmmLadder.emitFinalQuote(cfg, 0, x.toString(), 'q'),
    '  return q;',
    '}',
  ].join('\n');
}

describeSvm('meteora-dlmm incremental bin walk — identity against the restart model (real engine)', () => {
  let harness: EngineHarness;
  let cfg: MeteoraDlmmPoolConfig;
  let resolution: AccountResolution;
  let paramStrs: string[];

  beforeAll(async () => {
    harness = await startEngine(NOW);
    ({ cfg, resolution } = await loadCfgAndResolution(harness));
    paramStrs = meteoraDlmmLadder.paramsFor(cfg).map((v) => v.toString());
    expect(cfg.direction).toBe('xToY');
  });

  it('rungs 2/3/4: each incremental rung matches the independent restart quote at the same cumulative x, including across the real bin/saturation boundary', async () => {
    for (const rungCount of [2, 3, 4]) {
      const upToRung = rungCount - 1;
      const incrementalFinal = await runQuote(harness, resolution, incrementalSource(cfg, paramStrs, SIZES, upToRung));
      const restartFinal = await runQuote(harness, resolution, restartSource(cfg, paramStrs, SIZES[upToRung]!));
      expect(incrementalFinal).toBe(restartFinal);
    }
  });

  it('every INTERMEDIATE rung (not just the last) matches its own independent restart quote', async () => {
    // A separate compile per prefix length re-derives rung i's own output by
    // asking for a program that stops AT rung i -- proves the identity holds
    // at every rung along the way, not just the final one.
    for (let i = 0; i < SIZES.length; i++) {
      const incrementalAtI = await runQuote(harness, resolution, incrementalSource(cfg, paramStrs, SIZES, i));
      const restartAtI = await runQuote(harness, resolution, restartSource(cfg, paramStrs, SIZES[i]!));
      expect(incrementalAtI).toBe(restartAtI);
    }
  });

  it('sanity: the chosen sizes actually exercise organic growth AND a real bin/saturation transition (not a vacuous same-bin sweep)', async () => {
    const outs: bigint[] = [];
    for (const x of SIZES) outs.push(await runQuote(harness, resolution, restartSource(cfg, paramStrs, x)));
    // Organic growth from SIZES[0] into SIZES[2] (the real bin/saturation
    // transition); SIZES[2] and SIZES[3] are BOTH already at the saturated
    // plateau (confirmed equal below), so only the first two steps are
    // strictly increasing.
    expect(outs[1]!).toBeGreaterThan(outs[0]!);
    expect(outs[2]!).toBeGreaterThan(outs[1]!);
    expect(outs[3]!).toBe(outs[2]!); // plateaued -- both past the ceiling
    // Confirms SIZES[3] genuinely reached the ladder's ceiling (one more unit
    // of input changes nothing), not an arbitrary point that merely happens
    // to match by coincidence.
    const capAtLast = SIZES[SIZES.length - 1]!;
    const oneMore = await runQuote(harness, resolution, restartSource(cfg, paramStrs, capAtLast + 1_000_000_000n));
    expect(oneMore).toBe(outs[outs.length - 1]);
  });
});
