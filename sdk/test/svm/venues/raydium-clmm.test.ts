/**
 * raydium-clmm ladder units (no engine, no RPC): the cold-quote-collapse
 * fix, same mechanism as orca-whirlpool (see its test file's header).
 *
 * Real mainnet snapshot: pool 3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv,
 * test/svm/fixtures/raydium-clmm/*.json. Both directions probed: the pool's
 * OWN fetched config defaults to '0to1'; '1to0' is the same fetched config
 * with `direction` overridden (fetchPoolConfig's `windows` carries both
 * directions' tick-array windows already, so no extra fixture is needed).
 */
import { resolve } from 'path';
import { raydiumClmm } from '../../../src/svm/venues/raydium-clmm/index.js';
import { raydiumClmmLadder } from '../../../src/svm/venues/raydium-clmm/ladder.js';
import type { RaydiumClmmPoolConfig } from '../../../src/svm/venues/raydium-clmm/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';

const POOL_ADDRESS = '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv';
const FIXTURES = loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/raydium-clmm'));

async function cfgAndState() {
  const loader = fixtureLoader(FIXTURES);
  const state = fixtureBytesMap(FIXTURES);
  const cfg0to1 = (await raydiumClmm.fetchPoolConfig(loader, POOL_ADDRESS as never)) as RaydiumClmmPoolConfig;
  return { cfg0to1, state };
}

describe('raydium-clmm referenceQuote — no longer collapses to 0 past the window capacity', () => {
  it('REGRESSION (0to1): plateaus at the window\'s true saturated output instead of collapsing to 0', async () => {
    const { cfg0to1, state } = await cfgAndState();
    expect(cfg0to1.direction).toBe('0to1');
    const params = raydiumClmmLadder.paramsFor!(cfg0to1);
    const q = raydiumClmmLadder.referenceQuote(cfg0to1, state, params);
    const caps = raydiumClmmLadder.referenceCapacities!(cfg0to1, state, params)([1n << 36n, 1n << 37n, 1n << 60n]);

    expect(q(1n << 36n)).toBe(5_617_442_468n); // organically below the cliff -- unaffected by this fix
    expect(q(1n << 37n)).toBe(7_780_360_867n); // was 0n pre-fix
    expect(q(1n << 60n)).toBe(7_780_360_867n); // plateaued
    expect(q(0n)).toBe(0n);
    // 2^36 itself is still below the window's true capacity -- fully
    // absorbed (cap = x), unaffected by this fix; 2^37/2^60 are past it and
    // correctly saturate (referenceCapacities was already correct pre-fix).
    expect(caps).toEqual([68_719_476_736n, 95_185_556_484n, 95_185_556_484n]);
  });

  it('REGRESSION (1to0): the SAME pool\'s other direction plateaus instead of collapsing to 0', async () => {
    const { cfg0to1, state } = await cfgAndState();
    const cfg1to0: RaydiumClmmPoolConfig = { ...cfg0to1, direction: '1to0' };
    const params = raydiumClmmLadder.paramsFor!(cfg1to0);
    const q = raydiumClmmLadder.referenceQuote(cfg1to0, state, params);
    const caps = raydiumClmmLadder.referenceCapacities!(cfg1to0, state, params)([1n << 33n, 1n << 34n, 1n << 60n]);

    expect(q(1n << 33n)).toBe(104_951_027_622n); // organically below the cliff
    expect(q(1n << 34n)).toBe(134_527_424_614n); // was 0n pre-fix
    expect(q(1n << 60n)).toBe(134_527_424_614n); // plateaued
    expect(caps).toEqual([8_589_934_592n, 11_011_525_605n, 11_011_525_605n]);
  });
});
