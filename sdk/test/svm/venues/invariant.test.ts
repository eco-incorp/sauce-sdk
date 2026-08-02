/**
 * invariant ladder units (no engine, no RPC): the cold-quote-collapse fix.
 *
 * Real mainnet snapshot: pool 5dX3tkVDmbHBWMCQMerAHTmd9wsRvmtKLoQt6qv9fHy7
 * (xToY direction, a 3-tick-boundary window), test/svm/fixtures/invariant/*.json.
 *
 * referenceQuote used to be `coldWalk(...) ?? 0n`: coldWalk requires x to be
 * FULLY absorbed by the shipped tick-boundary window to return non-null, so
 * any x past the window's capacity collapsed to 0 forever instead of the
 * window's own true saturated output -- violating "nondecreasing in x,
 * quote(0)=0" (measured: q(1,225,852,593)=1,226,292,773 (still fully
 * absorbed, one wei under the window's capacity ceiling), q(1,225,852,594)=0
 * pre-fix -- one wei OVER capacity collapsed the whole quote to 0 -- while
 * referenceCapacities correctly saturates at 1,225,852,592/1,225,852,593 the
 * whole time; only the cold quote was wrong). Fixed by switching to
 * coldWalkClamped, which runs the identical walk but never returns null.
 */
import { resolve } from 'path';
import { invariant, invariantLadder } from '../../../src/svm/venues/invariant/index.js';
import type { InvariantPoolConfig } from '../../../src/svm/venues/invariant/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';

const POOL_ADDRESS = '5dX3tkVDmbHBWMCQMerAHTmd9wsRvmtKLoQt6qv9fHy7';
const FIXTURES = loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/invariant'));

// The exact x at which the shipped window is fully (but only just) absorbed
// -- referenceCapacities' reported cap === x at this point and one wei less,
// and stops tracking x 1:1 from CAPACITY_CEILING + 1 onward.
const CAPACITY_CEILING = 1_225_852_593n;

async function cfgAndState() {
  const loader = fixtureLoader(FIXTURES);
  const state = fixtureBytesMap(FIXTURES);
  const cfg = (await invariant.fetchPoolConfig(loader, POOL_ADDRESS as never)) as InvariantPoolConfig;
  return { cfg, state };
}

describe('invariant referenceQuote — no longer collapses to 0 past the window capacity', () => {
  it("REGRESSION: plateaus at the window's true saturated output instead of collapsing to 0", async () => {
    const { cfg, state } = await cfgAndState();
    expect(cfg.direction).toBe('xToY');
    expect(cfg.windows.xToY.boundaries.length).toBe(3);

    const params = invariantLadder.paramsFor!(cfg);
    const q = invariantLadder.referenceQuote(cfg, state, params);
    const caps = invariantLadder.referenceCapacities!(cfg, state, params)([
      CAPACITY_CEILING - 1n,
      CAPACITY_CEILING,
      CAPACITY_CEILING + 1n,
      10n ** 20n,
    ]);

    expect(q(0n)).toBe(0n);
    // Still organically within the window's capacity (fully absorbed) --
    // unaffected by this fix either side of it.
    expect(q(CAPACITY_CEILING - 1n)).toBe(1_226_292_772n);
    expect(q(CAPACITY_CEILING)).toBe(1_226_292_773n);
    // One wei past the window's true capacity -- this is exactly where the
    // pre-fix quote collapsed to 0n. Post-fix it plateaus at the same
    // saturated output the fully-absorbed case already reached.
    expect(q(CAPACITY_CEILING + 1n)).toBe(1_226_292_773n); // was 0n pre-fix
    expect(q(10n ** 20n)).toBe(1_226_292_773n); // plateaued, arbitrarily far past the cliff

    // referenceCapacities was already correct (untouched by this fix) -- the
    // capacity ceiling it reports must be consistent with where the fixed
    // cold quote plateaus (the window is exhausted at the same point either
    // way; capacity and output saturate together).
    expect(caps).toEqual([CAPACITY_CEILING - 1n, CAPACITY_CEILING, 1_225_852_592n, 1_225_852_592n]);

    // Monotonicity across the boundary: quote must never decrease in x,
    // including at and around the exact point that used to collapse.
    const probe = [0n, 1n, CAPACITY_CEILING - 1n, CAPACITY_CEILING, CAPACITY_CEILING + 1n, CAPACITY_CEILING * 2n, 10n ** 20n];
    for (let i = 1; i < probe.length; i++) {
      expect(q(probe[i])).toBeGreaterThanOrEqual(q(probe[i - 1]));
    }
  });
});
