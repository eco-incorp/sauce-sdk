/**
 * stabble-weighted-swap ladder units (no engine, no RPC): the
 * referenceCapacities capacity-collapse fix.
 *
 * Real mainnet snapshot: pool JV4MkRFn58xpyrhF2oDxQYwnq5jFVzTQUKcUzce1FQA
 * (wSOL/... weighted pool), test/svm/fixtures/stabble-weighted-swap/*.json.
 *
 * emitLadderQuote/emitFinalQuote/referenceQuote all clamp the WRAPPED input
 * to `xcap` (30%-of-balance, the real on-chain MAX_IN_RATIO) BEFORE computing
 * the output, so they already saturate correctly and are not touched here —
 * referenceQuote's plateau is asserted below as the ground truth the fixed
 * referenceCapacities is checked against. referenceCapacities' OWN latch used
 * to freeze `lx` at whatever smaller grid point last succeeded the moment a
 * grid point's WRAPPED input first exceeded `xcap`, instead of bumping up to
 * xcap's unwrapped equivalent -- see ladder.ts's referenceCapacities doc.
 */
import { resolve } from 'path';
import { stabbleWeightedSwap } from '../../../src/svm/venues/stabble-weighted-swap/index.js';
import { stabbleWeightedSwapLadder } from '../../../src/svm/venues/stabble-weighted-swap/ladder.js';
import type { StabbleWeightedSwapPoolConfig } from '../../../src/svm/venues/stabble-weighted-swap/index.js';
import { readUintLE } from '../../../src/svm/venues/math.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';

// TOKENS_OFFSET(122) + 4 + index*TOKEN_SIZE(58) + BAL_SUB_OFFSET(42) -- ladder.ts's
// file-local balanceOffset(0), not exported, mirrored here read-only for the
// safety check below (no write path, just re-deriving what xcap really is).
const BALANCE0_OFFSET = 168;

const FIXTURES = loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/stabble-weighted-swap'));
const POOL_ADDRESS = FIXTURES.find((f) => f.owner === 'swapFpHZwjELNnjvThjajtiVmkz3yPQEHjLtka2fwHW')!.address;

async function cfgAndState(): Promise<{ cfg: StabbleWeightedSwapPoolConfig; state: ReturnType<typeof fixtureBytesMap> }> {
  const loader = fixtureLoader(FIXTURES);
  const state = fixtureBytesMap(FIXTURES);
  const cfg = (await stabbleWeightedSwap.fetchPoolConfig(loader, POOL_ADDRESS as never)) as StabbleWeightedSwapPoolConfig;
  return { cfg, state };
}

// Ground truth, from referenceQuote (untouched by this fix): output plateaus
// at 3,324,489,097 starting at x=59,386,075,950 -- the true continuous
// wrapped-input/xcap crossing (bit-exact against weightedCalcOutGivenIn).
const OUTPUT_PLATEAU = 3_324_489_097n;

describe('stabble-weighted-swap referenceCapacities — no longer freezes below the true 30%-of-balance cap', () => {
  it('REGRESSION: bumps to the unwrapped xcap equivalent once the grid crosses the MAX_IN_RATIO boundary, instead of freezing at a smaller grid point', async () => {
    const { cfg, state } = await cfgAndState();
    const q = stabbleWeightedSwapLadder.referenceQuote(cfg, state);
    // ground truth: referenceQuote already saturates correctly (unaffected by this fix).
    expect(q(59_386_075_950n)).toBe(OUTPUT_PLATEAU);
    expect(q(1n << 60n)).toBe(OUTPUT_PLATEAU);

    const grid = [1n << 20n, 1n << 28n, 1n << 30n, 1n << 32n, 1n << 40n, 1n << 60n];
    const caps = stabbleWeightedSwapLadder.referenceCapacities(cfg, state)(grid);
    for (let i = 1; i < caps.length; i++) {
      expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]);
    }
    // Pre-fix, caps[4]/caps[5] (grid points 2^40/2^60, both past xcap) would
    // freeze at caps[3] (2^32 = 4,294,967,296) -- the last grid point below
    // the boundary. Post-fix they bump to the unwrapped xcap equivalent.
    expect(caps[3]).toBe(4_294_967_296n); // 2^32 itself is still under xcap -- organic, unbumped
    expect(caps[4]).toBe(59_386_076_207n); // bumped -- NOT frozen at 4,294,967,296
    expect(caps[5]).toBe(caps[4]); // plateaued
    expect(caps[4]).toBeGreaterThan(0n);
    // The bumped capacity must never claim MORE wrapped input than xcap actually allows
    // (safety, not just monotonicity): re-wrapping it must not exceed the real cap.
    const tokenIn = cfg.tokens[0];
    const rewrapped = tokenIn.scalingUp ? caps[4]! * tokenIn.scalingFactor : caps[4]! / tokenIn.scalingFactor;
    const bal0 = readUintLE(state[cfg.pool]!, BALANCE0_OFFSET, 8);
    const xcap = (bal0 * 300_000_000n) / 1_000_000_000n;
    expect(rewrapped).toBeLessThanOrEqual(xcap);
  });
});
