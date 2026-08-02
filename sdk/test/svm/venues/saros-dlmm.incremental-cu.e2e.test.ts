/**
 * CU REGRESSION for the saros-dlmm incremental bin walk (emitBinWalkIncremental
 * in ladder.ts): proves, against the REAL vendored SVM engine (LiteSVM,
 * artifacts/svm/engine.so, the SAME instrument meteora-dlmm's own identity
 * test uses -- meteora-dlmm.incremental-identity.e2e.test.ts reports no CU
 * number anywhere in the repo, grepped; this file is what supplies the number
 * for saros, both before and after this PR), that the incremental walk is
 * genuinely cheaper at a realistic 2-rung schedule -- not just correct.
 *
 * FAILING-FIRST: this file's baseline ("RESTART") is built from
 * `emitFinalQuote` (untouched, always a full restart-from-bin-0 walk) called
 * ONCE PER RUNG in the SAME program -- a definition that is completely
 * independent of whatever `emitLadderQuote` does, so it stays a valid ground
 * truth whether or not the incremental optimization exists. The candidate
 * ("INCREMENTAL") is built from the SHIPPED `emitLadderQuote`. At the parent
 * commit (before this PR's ladder.ts change), `emitLadderQuote` was ALSO a
 * plain restart (calling the old `emitBinWalk` fresh every rung) -- so the
 * marginal-cost comparison below would measure ~0% improvement and the
 * `toBeLessThan` assertions would FAIL AS ASSERTIONS (both functions load and
 * run fine pre-port; the numbers just don't diverge yet), not as a
 * missing-export/compile error. Post-port they diverge for real.
 *
 * REPRESENTATIVE SIZES: rung0 = amountIn >> 1, rung1 = amountIn (the default
 * geometric schedule's own second-largest-grid-point rule, `defaultRungs: 2`
 * for this venue) at three amountIn values, all within this pool's real
 * xToY window capacity (~2,056,149,759 raw at NOW below) so no run here
 * exercises the past-capacity collapse -- deliberately unrelated to, and
 * untouched by, this PR (see saros-dlmm.incremental-identity.e2e.test.ts's
 * header).
 *
 * MEASURED on this fixture (probe SHA cited in the PR body): marginal
 * (rung1-only) CU drops 28.68% / 46.51% / 46.59% across the three amountIns
 * below; whole-2-rung-program CU drops 9.18% / 21.09% / 21.12%. Materially
 * smaller than meteora-dlmm's own -34.35% at the smallest (unrepresentative,
 * rung0 far below amountIn>>1) split, comparable-to-larger at the
 * amountIn>>1-realistic splits -- see the PR body for the full step-1
 * measurement record, including the non-representative split that
 * understated this.
 */
import { resolve } from 'path';
import { compile } from '@eco-incorp/sauce-compiler';
import { FailedTransactionMetadata } from 'litesvm';
import {
  buildComputeBudgetPrepend,
  buildExecuteInstruction,
  buildExecuteTransaction,
  buildHeapFramePrepend,
  resolveAccounts,
} from '../../../src/svm/index.js';
import type { AccountResolution } from '../../../src/svm/index.js';
import { fetchSarosDlmmConfig } from '../../../src/svm/venues/saros-dlmm/index.js';
import { sarosDlmmLadder } from '../../../src/svm/venues/saros-dlmm/ladder.js';
import type { SarosDlmmPoolConfig } from '../../../src/svm/venues/saros-dlmm/index.js';
import { fixtureLoader, loadFixtures } from '../fixtures.js';
import { describeSvm, loadFixtureAccounts, startEngine } from '../engine-harness.js';
import type { EngineHarness } from '../engine-harness.js';

const PAIR_ADDRESS = 'DHXKB9fSff4LjubMFieKxaBrvNY6AzXVwaRLk5N2vs87';
const NOW = 1_785_540_000n;

// rung0 = amountIn >> 1, rung1 = amountIn -- the real production 2-rung
// schedule (`defaultRungs: 2`) for this venue, at three amountIns, all within
// the pool's real xToY window capacity.
const AMOUNT_INS = [500_000_000n, 2_000_000_000n, 1_800_000_000n] as const;

async function loadCfgAndResolution(harness: EngineHarness): Promise<{ cfg: SarosDlmmPoolConfig; resolution: AccountResolution }> {
  const fixtures = loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/saros-dlmm'));
  loadFixtureAccounts(harness, fixtures);
  const loader = fixtureLoader(fixtures);
  const cfg = (await fetchSarosDlmmConfig(loader, PAIR_ADDRESS as never)) as SarosDlmmPoolConfig;
  const resolution: AccountResolution = Object.fromEntries(sarosDlmmLadder.quoteRefs(cfg, 0).map((va) => [va.ref, va.address]));
  return { cfg, resolution };
}

/** ONE program: emitSetup + emitFinalQuote called ONCE PER SIZE, in sequence -- an always-restart 2-rung ground truth, independent of emitLadderQuote. */
function restartTwoRungSource(cfg: SarosDlmmPoolConfig, paramStrs: string[], sizes: readonly bigint[], upToRung: number): string {
  const rungLines = sizes.slice(0, upToRung + 1).map((size, i) => sarosDlmmLadder.emitFinalQuote(cfg, 0, size.toString(), `q${i}`));
  return ['function main() {', '  let s0en = 1;', sarosDlmmLadder.emitSetup(cfg, 0, paramStrs, 's0en'), ...rungLines, `  return q${upToRung};`, '}'].join(
    '\n',
  );
}

/** ONE program: emitSetup + the SHIPPED emitLadderQuote for rungs 0..upToRung, returns the LAST rung's output. */
function incrementalTwoRungSource(cfg: SarosDlmmPoolConfig, paramStrs: string[], sizes: readonly bigint[], upToRung: number): string {
  const rungLines = sizes.slice(0, upToRung + 1).map((size, i) => sarosDlmmLadder.emitLadderQuote(cfg, 0, i, size.toString(), `q${i}`));
  return ['function main() {', '  let s0en = 1;', sarosDlmmLadder.emitSetup(cfg, 0, paramStrs, 's0en'), ...rungLines, `  return q${upToRung};`, '}'].join(
    '\n',
  );
}

/** Compiles+sends `source`; returns the real CU spend (litesvm TransactionMetadata.computeUnitsConsumed()) and the return value. */
async function runQuoteWithCu(harness: EngineHarness, resolution: AccountResolution, source: string): Promise<{ cu: bigint; value: bigint }> {
  const { bytecode, accountPlan } = compile(source, { target: 'svm' });
  const accounts = resolveAccounts(accountPlan!, resolution, harness.payer.address);
  const execute = buildExecuteInstruction({ programId: harness.programId, bytecode: bytecode[0]!, accounts });
  harness.svm.expireBlockhash();
  const tx = await buildExecuteTransaction({
    payer: harness.payer,
    instructions: [...buildComputeBudgetPrepend({ unitLimit: 1_400_000 }), buildHeapFramePrepend(), execute],
    latestBlockhash: { blockhash: harness.svm.latestBlockhash(), lastValidBlockHeight: 1_000_000n },
  });
  const result = harness.svm.sendTransaction(tx);
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(`saros-dlmm CU probe: transaction failed: ${String(result.err())}\n${result.meta().logs().join('\n')}`);
  }
  const cu = result.computeUnitsConsumed();
  const returnBytes = result.returnData().data();
  const value = returnBytes.length === 0 ? 0n : BigInt('0x' + Buffer.from(returnBytes).toString('hex'));
  return { cu, value };
}

describeSvm('saros-dlmm incremental bin walk — CU regression against the always-restart baseline (real engine)', () => {
  let harness: EngineHarness;
  let cfg: SarosDlmmPoolConfig;
  let resolution: AccountResolution;
  let paramStrs: string[];

  beforeAll(async () => {
    harness = await startEngine(NOW);
    ({ cfg, resolution } = await loadCfgAndResolution(harness));
    paramStrs = sarosDlmmLadder.paramsFor(cfg).map((v) => v.toString());
    expect(cfg.direction).toBe('xToY');
  });

  it.each(AMOUNT_INS)('amountIn=%s: incremental rung1 output matches the always-restart ground truth', async (amountIn) => {
    const sizes = [amountIn >> 1n, amountIn] as const;
    const incremental = await runQuoteWithCu(harness, resolution, incrementalTwoRungSource(cfg, paramStrs, sizes, 1));
    const restart = await runQuoteWithCu(harness, resolution, restartTwoRungSource(cfg, paramStrs, sizes, 1));
    expect(incremental.value).toBe(restart.value);
  });

  it.each(AMOUNT_INS)(
    'amountIn=%s: marginal (rung1) and whole-program CU both drop materially vs the always-restart baseline',
    async (amountIn) => {
      const sizes = [amountIn >> 1n, amountIn] as const;

      const restartRung0 = await runQuoteWithCu(harness, resolution, restartTwoRungSource(cfg, paramStrs, sizes, 0));
      const restartRung1 = await runQuoteWithCu(harness, resolution, restartTwoRungSource(cfg, paramStrs, sizes, 1));
      const incrementalRung0 = await runQuoteWithCu(harness, resolution, incrementalTwoRungSource(cfg, paramStrs, sizes, 0));
      const incrementalRung1 = await runQuoteWithCu(harness, resolution, incrementalTwoRungSource(cfg, paramStrs, sizes, 1));

      const marginalRestart = restartRung1.cu - restartRung0.cu;
      const marginalIncremental = incrementalRung1.cu - incrementalRung0.cu;
      const pctDeltaMarginal = (Number(marginalIncremental - marginalRestart) / Number(marginalRestart)) * 100;
      const pctDeltaWholeProgram = (Number(incrementalRung1.cu - restartRung1.cu) / Number(restartRung1.cu)) * 100;

      // Printed, not just asserted -- the exact numbers cited in ladder.ts's
      // emitLadderQuote doc and the PR body come from this log line.
      // eslint-disable-next-line no-console
      console.log(
        `[saros-dlmm CU] amountIn=${amountIn} sizes=${sizes.join(',')} ` +
          `restart(rung0-only=${restartRung0.cu}, rung0+1=${restartRung1.cu}, marginal-rung1=${marginalRestart}) ` +
          `incremental(rung0-only=${incrementalRung0.cu}, rung0+1=${incrementalRung1.cu}, marginal-rung1=${marginalIncremental}) ` +
          `marginalDelta=${pctDeltaMarginal.toFixed(2)}% wholeProgramDelta=${pctDeltaWholeProgram.toFixed(2)}%`,
      );

      // Conservative thresholds well under the measured -28%..-47% marginal /
      // -9%..-21% whole-program range across all three amountIns -- these FAIL
      // at the parent commit (pre-port emitLadderQuote was itself a restart,
      // so marginalDelta/wholeProgramDelta measure ~0% there), and pass now.
      expect(pctDeltaMarginal).toBeLessThan(-10);
      expect(pctDeltaWholeProgram).toBeLessThan(-5);
    },
  );
});
