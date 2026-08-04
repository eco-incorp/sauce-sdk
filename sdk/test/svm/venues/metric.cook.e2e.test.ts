/**
 * COOK PROOF for the Metric quote fragment: the emitted SauceScript is compiled to 'svm' bytecode
 * and executed through the REAL vendored SVM engine (LiteSVM, artifacts/svm/engine.so) against the
 * real mainnet fixture pool G5B2Ws2DKattHTm75AoANWCpbQ48R9n8ZJur42RLYRYF (USDC/USDT), with a stubbed
 * `fetchOracleQuote` returning the SAME real, live-captured oracle CPI bytes the unit test uses.
 *
 * The Metric quote is a read-only computation (a baked-scale multiply, reserve-fraction capped — it
 * issues NO oracle CPI, see ladder.ts), so the cook proof is exact-output identity: the value the
 * on-chain bytecode RETURNS must equal `referenceQuote(x)` lamport-exact, at every size — below the
 * cap (the flat baked-scale regime) and past it (the `reserveOut / CAP_DIVISOR` ceiling). This is the
 * on-engine analogue of a swap's `realized outAta delta == referenceQuote`: for a quote fragment the
 * returned amount IS the realized figure, with no token movement to diff.
 *
 * Skips cleanly when the engine binary is absent (describeSvm), same as every other e2e here.
 */
import { resolve } from 'path';
import { address } from '@solana/kit';
import { compile } from '@eco-incorp/sauce-compiler';
import {
  buildComputeBudgetPrepend,
  buildExecuteInstruction,
  buildHeapFramePrepend,
  resolveAccounts,
} from '../../../src/svm/index.js';
import type { AccountResolution } from '../../../src/svm/index.js';
import { metric } from '../../../src/svm/venues/metric/index.js';
import { metricLadder } from '../../../src/svm/venues/metric/ladder.js';
import type { MetricPoolConfig } from '../../../src/svm/venues/metric/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';
import {
  describeSvm,
  expectOk,
  loadFixtureAccounts,
  sendInstructions,
  startEngine,
  toBigInt,
} from '../engine-harness.js';
import type { EngineHarness } from '../engine-harness.js';

const FIXTURES = resolve(process.cwd(), 'test/svm/fixtures/metric');
const POOL = address('G5B2Ws2DKattHTm75AoANWCpbQ48R9n8ZJur42RLYRYF');
const NOW = 2_000_000_000n; // Metric's quote is time-independent; any value is fine.

// The SAME real 32-byte oracle CPI return data the unit test bakes (bid, then ask — u128 LE halves).
const REAL_BID = 18461132534087045066n;
const REAL_ASK = 18461317001527782162n;
function realOracleQuoteBytes(): Uint8Array {
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, REAL_BID & 0xffffffffffffffffn, true);
  view.setBigUint64(8, REAL_BID >> 64n, true);
  view.setBigUint64(16, REAL_ASK & 0xffffffffffffffffn, true);
  view.setBigUint64(24, REAL_ASK >> 64n, true);
  return out;
}

/** emitSetup + a single rung returning the quote for `x` — the exact fragment a cook would emit. */
function quoteSource(cfg: MetricPoolConfig, paramStrs: string[], x: bigint): string {
  const helpers = metricLadder.helpers().map((h) => h.source).join('\n');
  return [
    helpers,
    'function main() {',
    '  let s0en = 1;',
    metricLadder.emitSetup(cfg, 0, paramStrs, 's0en'),
    `  return ${metricLadder.emitQuoteCall(cfg, 0, x.toString())};`,
    '}',
  ].join('\n');
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

describeSvm('metric quote fragment — on-chain output matches referenceQuote (real engine)', () => {
  let harness: EngineHarness;

  beforeAll(async () => {
    harness = await startEngine(NOW);
    loadFixtureAccounts(harness, loadFixtures(FIXTURES));
  });

  for (const direction of [0, 1] as const) {
    describe(`direction ${direction} (${direction === 0 ? 'A->B' : 'B->A'})`, () => {
      let cfg: MetricPoolConfig;
      let resolution: AccountResolution;
      let paramStrs: string[];
      let reference: (x: bigint) => bigint;
      let cap: bigint;

      beforeAll(async () => {
        const fixtures = loadFixtures(FIXTURES);
        cfg = await metric.fetchPoolConfig(fixtureLoader(fixtures), POOL, direction, async () => realOracleQuoteBytes());
        resolution = Object.fromEntries(metricLadder.quoteRefs(cfg, 0).map((va) => [va.ref, va.address!]));
        paramStrs = metricLadder.paramsFor(cfg).map((v) => v.toString());
        reference = metricLadder.referenceQuote(cfg, fixtureBytesMap(fixtures), metricLadder.paramsFor(cfg));
        cap = metricLadder.depthReserves(cfg, fixtureBytesMap(fixtures)).reserveOut / 20n;
      });

      it('returns referenceQuote lamport-exact across the full size range, flat regime through the cap', async () => {
        // 1 atom → 1e9 tokens. THE cook proof: the on-chain bytecode and the TS referenceQuote agree
        // to the lamport at every size, whether in the flat baked-scale regime or clamped at the cap.
        for (const x of [1n, 1_000_000n, 10_000_000n, 2_000_000_000n, 10n ** 15n]) {
          const onChain = await runQuote(harness, resolution, quoteSource(cfg, paramStrs, x));
          expect(onChain).toBe(reference(x));
        }
      });

      it('exercises a real flat→cap transition (not a vacuous all-clamped or all-flat sweep)', async () => {
        // A small size stays in the flat baked-scale regime (strictly below the cap)...
        const flatX = 1_000_000n; // 1 token — well below reserveOut / CAP_DIVISOR for this pool
        const flat = await runQuote(harness, resolution, quoteSource(cfg, paramStrs, flatX));
        expect(flat).toBe(reference(flatX));
        expect(flat).toBeLessThan(cap);
        // ...while a huge size clamps at exactly reserveOut / CAP_DIVISOR, and one more atom of input
        // changes nothing (a genuine ceiling, both on-chain and in the reference).
        const huge = 10n ** 15n;
        const clamped = await runQuote(harness, resolution, quoteSource(cfg, paramStrs, huge));
        expect(clamped).toBe(cap);
        expect(clamped).toBe(reference(huge));
        expect(clamped).toBeGreaterThan(flat); // real growth into the ceiling, not coincidence
        expect(await runQuote(harness, resolution, quoteSource(cfg, paramStrs, huge + 1n))).toBe(cap);
      });

      it('a disabled slot returns zero on-chain, matching the zero-scale reference', async () => {
        const helpers = metricLadder.helpers().map((h) => h.source).join('\n');
        const source = [
          helpers,
          'function main() {',
          '  let s0en = 0;',
          metricLadder.emitSetup(cfg, 0, paramStrs, 's0en'),
          `  return ${metricLadder.emitQuoteCall(cfg, 0, '100000000')};`,
          '}',
        ].join('\n');
        expect(await runQuote(harness, resolution, source)).toBe(0n);
      });
    });
  }
});
