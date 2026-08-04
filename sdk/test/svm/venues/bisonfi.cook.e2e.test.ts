/**
 * COOK PROOF for the BisonFi quote fragment: the emitted SauceScript is compiled to 'svm' bytecode
 * and executed through the REAL vendored SVM engine (LiteSVM, artifacts/svm/engine.so) against the
 * real mainnet fixture pool 8FnX3xo2yYw3EUE6w3nQA4GfXGS9wpK6oj3veJpbFzLo (wSOL/USDC, dumped fresh).
 *
 * BisonFi prices from a plaintext Q24.40 field inside the pool account (no oracle CPI) and gates
 * freshness with a pure in-VM `block.timestamp` comparison that self-drops to a zero quote when
 * stale — never a revert. So the cook proof has two halves, both exact-output identity against
 * referenceQuote (the read-only-quote analogue of a swap's `realized outAta delta == referenceQuote`):
 *   - FRESH (engine clock a few seconds past the keeper timestamp): the on-chain output equals the
 *     live-priced, fee-haircut, capped referenceQuote lamport-exact, across the whole size range.
 *   - STALE (engine clock well past STALE_SECONDS): the on-chain output is 0, proving the staleness
 *     gate self-drops IN-VM rather than reverting — the property that lets a stale BisonFi slot ride
 *     inside a co-merged cook without aborting every other venue's fill.
 *
 * The engine clock is pinned to the keeper timestamp baked into the fixture, and referenceQuote is
 * evaluated at the SAME `now`, so the block.timestamp gate is lamport-identical on both sides.
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
import { bisonfi, STALE_SECONDS, TS_OFFSET } from '../../../src/svm/venues/bisonfi/index.js';
import { bisonfiLadder } from '../../../src/svm/venues/bisonfi/ladder.js';
import type { BisonfiPoolConfig } from '../../../src/svm/venues/bisonfi/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';
import { readUintLE } from '../../../src/svm/venues/math.js';
import {
  describeSvm,
  expectOk,
  loadFixtureAccounts,
  sendInstructions,
  startEngine,
  toBigInt,
} from '../engine-harness.js';
import type { EngineHarness } from '../engine-harness.js';

const FIXTURES = resolve(process.cwd(), 'test/svm/fixtures/bisonfi');
const POOL = address('8FnX3xo2yYw3EUE6w3nQA4GfXGS9wpK6oj3veJpbFzLo');

function keeperTsSec(): bigint {
  return readUintLE(fixtureBytesMap(loadFixtures(FIXTURES))[POOL]!, TS_OFFSET, 8) / 1_000_000_000n;
}
const FRESH_NOW = keeperTsSec() + 5n;
const STALE_NOW = keeperTsSec() + STALE_SECONDS + 60n;

function quoteSource(cfg: BisonfiPoolConfig, paramStrs: string[], x: bigint): string {
  const helpers = bisonfiLadder.helpers(cfg).map((h) => h.source).join('\n');
  return [
    helpers,
    'function main() {',
    bisonfiLadder.emitSetup(cfg, 0, paramStrs),
    `  return ${bisonfiLadder.emitQuoteCall!(cfg, 0, x.toString())};`,
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

async function loadCfg(direction: 0 | 1): Promise<{ cfg: BisonfiPoolConfig; resolution: AccountResolution; paramStrs: string[] }> {
  const cfg = (await bisonfi.fetchPoolConfig(fixtureLoader(loadFixtures(FIXTURES)), POOL, direction)) as BisonfiPoolConfig;
  const resolution: AccountResolution = Object.fromEntries(bisonfiLadder.quoteRefs(cfg, 0).map((va) => [va.ref, va.address!]));
  const paramStrs = bisonfiLadder.paramsFor(cfg).map((v) => v.toString());
  return { cfg, resolution, paramStrs };
}

describeSvm('bisonfi quote fragment — on-chain output matches referenceQuote (real engine)', () => {
  for (const direction of [0, 1] as const) {
    describe(`direction ${direction} (${direction === 0 ? 'wSOL->USDC' : 'USDC->wSOL'})`, () => {
      const SIZES = direction === 0
        ? [1n, 1_000_000_000n, 10_000_000_000n] // 1 lamport, 1 wSOL, 10 wSOL
        : [1n, 1_000_000n, 100_000_000n]; // 1 unit, 1 USDC, 100 USDC

      it('FRESH: matches referenceQuote lamport-exact across the size range', async () => {
        const harness = await startEngine(FRESH_NOW);
        loadFixtureAccounts(harness, loadFixtures(FIXTURES));
        const { cfg, resolution, paramStrs } = await loadCfg(direction);
        const reference = bisonfiLadder.referenceQuote(cfg, fixtureBytesMap(loadFixtures(FIXTURES)), bisonfiLadder.paramsFor(cfg), FRESH_NOW);
        for (const x of SIZES) {
          const onChain = await runQuote(harness, resolution, quoteSource(cfg, paramStrs, x));
          expect(onChain).toBe(reference(x));
        }
        // Non-vacuity: at least one in-range size returns a real, positive quote.
        const positive = await runQuote(harness, resolution, quoteSource(cfg, paramStrs, SIZES[1]!));
        expect(positive).toBeGreaterThan(0n);
      });

      it('STALE: the staleness gate self-drops to 0 on-chain (no revert), matching the reference', async () => {
        const harness = await startEngine(STALE_NOW);
        loadFixtureAccounts(harness, loadFixtures(FIXTURES));
        const { cfg, resolution, paramStrs } = await loadCfg(direction);
        const reference = bisonfiLadder.referenceQuote(cfg, fixtureBytesMap(loadFixtures(FIXTURES)), bisonfiLadder.paramsFor(cfg), STALE_NOW);
        for (const x of SIZES) {
          const onChain = await runQuote(harness, resolution, quoteSource(cfg, paramStrs, x));
          expect(onChain).toBe(0n);
          expect(onChain).toBe(reference(x));
        }
      });

      it('FRESH: clamps at reserveOut / CAP_DIVISOR for an outsized input, matching the reference', async () => {
        const harness = await startEngine(FRESH_NOW);
        loadFixtureAccounts(harness, loadFixtures(FIXTURES));
        const { cfg, resolution, paramStrs } = await loadCfg(direction);
        const reference = bisonfiLadder.referenceQuote(cfg, fixtureBytesMap(loadFixtures(FIXTURES)), bisonfiLadder.paramsFor(cfg), FRESH_NOW);
        const huge = 10n ** 18n;
        const onChain = await runQuote(harness, resolution, quoteSource(cfg, paramStrs, huge));
        expect(onChain).toBe(reference(huge));
        expect(onChain).toBeGreaterThan(0n); // the cap itself is positive
      });
    });
  }
});
