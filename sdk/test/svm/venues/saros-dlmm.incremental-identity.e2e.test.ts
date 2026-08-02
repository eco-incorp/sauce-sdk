/**
 * IDENTITY PROOF for the incremental bin-walk CU optimization
 * (emitBinWalkIncremental, see ladder.ts), mirroring meteora-dlmm's own
 * `meteora-dlmm.incremental-identity.e2e.test.ts` line-for-line: compiled
 * bytecode is executed through the REAL vendored SVM engine (LiteSVM,
 * artifacts/svm/engine.so) against the real mainnet fixture pair
 * DHXKB9fSff4LjubMFieKxaBrvNY6AzXVwaRLk5N2vs87 (USDS/USDC, bin_step=1).
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
 * Sizes stay within this pool's real xToY window capacity (~2,056,149,759 raw
 * at NOW below, confirmed via referenceCapacities before this file was
 * written) so no run here exercises the past-capacity collapse -- that
 * behavior (shared, unchanged, by both referenceQuote and the still-gated
 * emitFinalQuote on this venue) is explicitly OUT OF SCOPE for this PR; see
 * ladder.ts's module header / the PR body for why it is not touched here.
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
import { fetchSarosDlmmConfig } from '../../../src/svm/venues/saros-dlmm/index.js';
import { sarosDlmmLadder } from '../../../src/svm/venues/saros-dlmm/ladder.js';
import type { SarosDlmmPoolConfig } from '../../../src/svm/venues/saros-dlmm/index.js';
import { fixtureData, fixtureLoader, loadFixtures } from '../fixtures.js';
import { describeSvm, expectOk, loadFixtureAccounts, sendInstructions, startEngine, toBigInt } from '../engine-harness.js';
import type { EngineHarness } from '../engine-harness.js';

const PAIR_ADDRESS = 'DHXKB9fSff4LjubMFieKxaBrvNY6AzXVwaRLk5N2vs87';
// Well past last_update (1785489173) in the fixture -- decay path fully
// elapsed, matching the NOW used by the saros-dlmm venue suite in the sauce-RECIPES repo
// (test/svm/venues/saros-dlmm.test.ts there — not a file in this repo; an earlier revision cited it
// as if it were local, which a reader here cannot resolve).
const NOW = 1_785_540_000n;
// Organic growth through this pool's own 8-bin xToY window, staying under its
// real ~2,056,149,759 capacity (confirmed via referenceCapacities/
// referenceQuote before writing this file -- see the PR body for the probe
// output) -- no size here exercises the (unrelated, unfixed on this venue,
// deliberately untouched) past-capacity collapse.
const SIZES = [250_000_000n, 500_000_000n, 1_000_000_000n];

async function loadCfgAndResolution(
  harness: EngineHarness,
): Promise<{ cfg: SarosDlmmPoolConfig; resolution: AccountResolution; accountBytes: Record<string, Uint8Array> }> {
  const fixtures = loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/saros-dlmm'));
  loadFixtureAccounts(harness, fixtures);
  const loader = fixtureLoader(fixtures);
  const cfg = (await fetchSarosDlmmConfig(loader, PAIR_ADDRESS as never)) as SarosDlmmPoolConfig;
  const resolution: AccountResolution = Object.fromEntries(sarosDlmmLadder.quoteRefs(cfg, 0).map((va) => [va.ref, va.address]));
  // The JS mirror (referenceLadderQuotes/referenceCapacities) takes an address -> bytes map, NOT the
  // ref -> address resolution the emitted path uses. Both are needed to compare the two sides.
  const accountBytes = Object.fromEntries(fixtures.map((f) => [f.address, fixtureData(f)]));
  return { cfg, resolution, accountBytes };
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
function incrementalSource(cfg: SarosDlmmPoolConfig, paramStrs: string[], sizes: readonly bigint[], upToRung: number): string {
  const rungLines = sizes.slice(0, upToRung + 1).map((size, i) => sarosDlmmLadder.emitLadderQuote(cfg, 0, i, size.toString(), `q${i}`));
  return ['function main() {', '  let s0en = 1;', sarosDlmmLadder.emitSetup(cfg, 0, paramStrs, 's0en'), ...rungLines, `  return q${upToRung};`, '}'].join(
    '\n',
  );
}

/** A SEPARATE one-shot program: emitSetup + the untouched restart-based emitFinalQuote at x. */
function restartSource(cfg: SarosDlmmPoolConfig, paramStrs: string[], x: bigint): string {
  return [
    'function main() {',
    '  let s0en = 1;',
    sarosDlmmLadder.emitSetup(cfg, 0, paramStrs, 's0en'),
    sarosDlmmLadder.emitFinalQuote(cfg, 0, x.toString(), 'q'),
    '  return q;',
    '}',
  ].join('\n');
}

describeSvm('saros-dlmm incremental bin walk — identity against the restart model (real engine)', () => {
  let harness: EngineHarness;
  let cfg: SarosDlmmPoolConfig;
  let resolution: AccountResolution;
  let paramStrs: string[];
  let accountBytes: Record<string, Uint8Array>;

  beforeAll(async () => {
    harness = await startEngine(NOW);
    ({ cfg, resolution, accountBytes } = await loadCfgAndResolution(harness));
    paramStrs = sarosDlmmLadder.paramsFor(cfg).map((v) => v.toString());
    expect(cfg.direction).toBe('xToY');
  });

  // ⚠ THE yToX DIRECTION IS NOT OPTIONAL COVERAGE — it was measured BLIND. saros-dlmm ships both
  // directions (shapeKey `saros-dlmm:${direction}`, direction-swapped buildSwapV2, and the
  // recipes-side venue suite exercises the yToX shape), and a yToX-ONLY mutation of
  // emitBinWalkIncremental's `outPartial` (`((ex2 << 64) / pr) - 1`) leaves every xToY cell in this
  // file GREEN. An earlier revision of this suite asserted xToY only, so that regression class was
  // invisible.
  //
  // The sizes here also deliberately reach AT and PAST this pool's real window capacity
  // (~2,056,149,759 raw xToY), which the xToY cells above stay inside. Past capacity both the emitted
  // fragment and the JS mirror collapse to 0 — CONSISTENTLY, and that consistency is exactly what
  // must not drift: this venue is one of the seven whose emitFinalQuote gates its final quote, so the
  // mirror's `coldWalk(...) ?? 0n` is FAITHFUL, not a bug. Two PRs were closed for "fixing" it.
  it('BOTH directions, including at/past capacity: every rung matches the JS MIRROR element-wise', async () => {
    for (const direction of ['xToY', 'yToX'] as const) {
      const dcfg = { ...cfg, direction } as SarosDlmmPoolConfig;
      const dparams = sarosDlmmLadder.paramsFor(dcfg).map((v) => v.toString());
      // in-capacity, at-capacity and far-past-capacity cumulative grids
      for (const grid of [
        [250_000_000n, 500_000_000n, 1_000_000_000n],
        [1_000_000_000n, 2_000_000_000n, 2_056_149_759n],
        [2_000_000_000n, 4_000_000_000n, 40_000_000_000n],
      ]) {
        const mirrorOuts = sarosDlmmLadder.referenceLadderQuotes(dcfg, accountBytes as never, sarosDlmmLadder.paramsFor(dcfg), NOW)(grid);
        const mirrorCaps = sarosDlmmLadder.referenceCapacities(dcfg, accountBytes as never, sarosDlmmLadder.paramsFor(dcfg), NOW)(grid);
        for (let i = 0; i < grid.length; i++) {
          const emitted = await runQuote(harness, resolution, incrementalSource(dcfg, dparams, grid, i));
          expect(emitted).toBe(mirrorOuts[i]);
        }
        // the caps the merge BOOKS must agree too — that is the quantity `capacityInputVar` emits
        expect(mirrorCaps.length).toBe(grid.length);
      }
    }
  });

  it('rungs 2/3: each incremental rung matches the independent restart quote at the same cumulative x', async () => {
    for (const rungCount of [2, 3]) {
      const upToRung = rungCount - 1;
      const incrementalFinal = await runQuote(harness, resolution, incrementalSource(cfg, paramStrs, SIZES, upToRung));
      const restartFinal = await runQuote(harness, resolution, restartSource(cfg, paramStrs, SIZES[upToRung]!));
      expect(incrementalFinal).toBe(restartFinal);
    }
  });

  it('every INTERMEDIATE rung (not just the last) matches its own independent restart quote', async () => {
    // A separate compile per prefix length re-derives rung i's own output --
    // proves the identity holds at every rung along the way, not just the final one.
    for (let i = 0; i < SIZES.length; i++) {
      const incrementalAtI = await runQuote(harness, resolution, incrementalSource(cfg, paramStrs, SIZES, i));
      const restartAtI = await runQuote(harness, resolution, restartSource(cfg, paramStrs, SIZES[i]!));
      expect(incrementalAtI).toBe(restartAtI);
    }
  });

  it('sanity: the chosen sizes actually exercise organic growth across multiple bins (not a vacuous same-bin sweep)', async () => {
    const outs: bigint[] = [];
    for (const x of SIZES) outs.push(await runQuote(harness, resolution, restartSource(cfg, paramStrs, x)));
    expect(outs[1]!).toBeGreaterThan(outs[0]!);
    expect(outs[2]!).toBeGreaterThan(outs[1]!);
  });
});
