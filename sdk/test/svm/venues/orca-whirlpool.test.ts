/**
 * orca-whirlpool ladder units (no engine, no RPC): the cold-quote-collapse
 * fix.
 *
 * Real mainnet snapshot: pool Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE
 * (aToB direction), test/svm/fixtures/orca-whirlpool/*.json.
 *
 * referenceQuote used to be `coldWalk(...) ?? 0n`: coldWalk requires x to be
 * FULLY absorbed by the shipped tick-array window to return non-null, so
 * any x past the window's capacity collapsed to 0 forever instead of the
 * window's own true saturated output -- violating "nondecreasing in x,
 * quote(0)=0" (measured: q(2^40)=88,802,545,193, q(2^41)=0 pre-fix, while
 * referenceCapacities correctly saturates at 1,818,415,775,132 the whole
 * time -- only the cold quote was wrong). Fixed by switching to
 * coldWalkClamped, which runs the identical walk but never returns null.
 */
import { resolve } from 'path';
import { orcaWhirlpool } from '../../../src/svm/venues/orca-whirlpool/index.js';
import { orcaWhirlpoolLadder } from '../../../src/svm/venues/orca-whirlpool/ladder.js';
import type { OrcaWhirlpoolPoolConfig } from '../../../src/svm/venues/orca-whirlpool/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';

const POOL_ADDRESS = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
const FIXTURES = loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/orca-whirlpool'));

async function cfgAndState() {
  const loader = fixtureLoader(FIXTURES);
  const state = fixtureBytesMap(FIXTURES);
  const cfg = (await orcaWhirlpool.fetchPoolConfig(loader, POOL_ADDRESS as never)) as OrcaWhirlpoolPoolConfig;
  return { cfg, state };
}

describe('orca-whirlpool referenceQuote — no longer collapses to 0 past the window capacity', () => {
  it('REGRESSION: plateaus at the window\'s true saturated output instead of collapsing to 0', async () => {
    const { cfg, state } = await cfgAndState();
    expect(cfg.direction).toBe('aToB');
    const params = orcaWhirlpoolLadder.paramsFor!(cfg);
    const q = orcaWhirlpoolLadder.referenceQuote(cfg, state, params);
    const caps = orcaWhirlpoolLadder.referenceCapacities!(cfg, state, params)([1n << 40n, 1n << 41n, 1n << 60n]);

    // Ground truth from the audit: 2^40 is still organically below the
    // window's capacity (last-nonzero point pre-fix too -- unaffected by
    // this fix); 2^41 is where it used to collapse.
    expect(q(1n << 40n)).toBe(88_802_545_193n);
    expect(q(1n << 41n)).toBe(146_829_069_683n); // was 0n pre-fix
    expect(q(1n << 60n)).toBe(146_829_069_683n); // plateaued, arbitrarily far past the cliff
    expect(q(0n)).toBe(0n);

    // referenceCapacities was already correct (untouched by this fix) -- the
    // capacity ceiling it reports must be consistent with where the fixed
    // cold quote plateaus (the window is exhausted at the same point either
    // way; capacity and output saturate together).
    expect(caps).toEqual([1_099_511_627_776n, 1_818_415_775_132n, 1_818_415_775_132n]);
  });
});
