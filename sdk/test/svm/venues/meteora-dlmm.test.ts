/**
 * meteora-dlmm buildSwapV2 account-meta regression: bin_array_bitmap_extension
 * is an Option<AccountLoader> on the deployed program (LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo)
 * whose Anchor #[account(mut)] constraint requires the real account WRITABLE
 * when it is Some, and requires the None sentinel (the program id) READONLY
 * (a writable program-id account is rejected before the program even runs —
 * "Program addresses may not be writable"). Proven against the deployed
 * binary in LiteSVM (direct top-level invoke): Some+readonly reverts with
 * AnchorError ConstraintMut (0x7d0) on account bin_array_bitmap_extension;
 * Some+writable lands; None+readonly lands; None+writable is rejected by the
 * runtime itself. This repo's only fixture pool (5rCf1DM8...) HAS the
 * extension, so the None branch is reachable only here, not in any e2e fixture.
 */
import { resolve } from 'path';
import { address } from '@solana/kit';
import {
  fetchMeteoraDlmmConfig,
  meteoraDlmmLadder,
  METEORA_DLMM_PROGRAM_ID,
} from '../../../src/svm/index.js';
import type { MeteoraDlmmPoolConfig, SwapUser } from '../../../src/svm/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';

const PAIR = address('5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6');
const BITMAP_EXTENSION = address('DArpuuqJxNLRGQ8xq5ebZbobyjxSWWsPq8MqSZ2fUZLE');

const user: SwapUser = { inAta: 'user-in', outAta: 'user-out', owner: 'user-owner' };

async function fetchCfg(): Promise<MeteoraDlmmPoolConfig> {
  const fixtures = loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/meteora-dlmm'));
  return fetchMeteoraDlmmConfig(fixtureLoader(fixtures), PAIR);
}

describe('meteora-dlmm buildSwapV2 bin_array_bitmap_extension meta', () => {
  it('marks the REAL extension account WRITABLE when it exists (Some branch)', async () => {
    const cfg = await fetchCfg();
    expect(cfg.bitmapExtensionExists).toBe(true); // the fixture pair carries a real extension
    const swap = meteoraDlmmLadder.buildSwapV2(cfg, 0, user);
    const bmx = swap.accounts[1];
    expect(bmx.address).toBe(BITMAP_EXTENSION);
    expect(bmx.writable).toBe(true);
  });

  it('marks the None sentinel (program id) READONLY when the extension is absent', async () => {
    const cfg: MeteoraDlmmPoolConfig = { ...(await fetchCfg()), bitmapExtensionExists: false };
    const swap = meteoraDlmmLadder.buildSwapV2(cfg, 0, user);
    const bmx = swap.accounts[1];
    expect(bmx.address).toBe(METEORA_DLMM_PROGRAM_ID);
    expect(bmx.writable).toBeUndefined();
  });
});

/**
 * THE COLD-QUOTE COLLAPSE — FIXED. Same defect and same fix as
 * orca-whirlpool/raydium-clmm's referenceQuote (see orca-whirlpool.test.ts's
 * header for the full mechanism): `coldWalk(...) ?? 0n` required full
 * absorption of x by the shipped bin window to return non-null, so any x
 * past the window's capacity collapsed to 0 forever instead of the window's
 * own true saturated output. Fixed by switching to coldWalkClamped (which
 * runs the identical bin walk but never returns null), same as the other
 * two window-walking families. `now` is pinned (2,000,000,000) since the
 * fee model's age/volatility decay is time-dependent -- all numbers below
 * are specific to that `now`.
 */
const NOW = 2_000_000_000n;

describe('meteora-dlmm referenceQuote — no longer collapses to 0 past the bin window capacity', () => {
  it("REGRESSION (xToY): plateaus at the window's true saturated output instead of collapsing to 0", async () => {
    const cfg = await fetchCfg();
    expect(cfg.direction).toBe('xToY');
    const state = fixtureBytesMap(loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/meteora-dlmm')));
    const params = meteoraDlmmLadder.paramsFor!(cfg);
    const q = meteoraDlmmLadder.referenceQuote(cfg, state, params, NOW);
    const caps = meteoraDlmmLadder.referenceCapacities!(cfg, state, params, NOW)([1n << 41n, 1n << 42n, 1n << 60n]);

    expect(q(1n << 41n)).toBe(179_540_472_977n); // organically below the cliff
    expect(q(1n << 42n)).toBe(205_617_877_803n); // was 0n pre-fix
    expect(q(1n << 60n)).toBe(205_617_877_803n); // plateaued
    expect(q(0n)).toBe(0n);
    expect(caps).toEqual([2_199_023_255_552n, 2_518_876_474_451n, 2_518_876_474_451n]);
  });

  it("REGRESSION (yToX): the SAME pair's other direction plateaus instead of collapsing to 0", async () => {
    const base = await fetchCfg();
    const cfg: MeteoraDlmmPoolConfig = { ...base, direction: 'yToX' };
    const state = fixtureBytesMap(loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/meteora-dlmm')));
    const params = meteoraDlmmLadder.paramsFor!(cfg);
    const q = meteoraDlmmLadder.referenceQuote(cfg, state, params, NOW);
    const caps = meteoraDlmmLadder.referenceCapacities!(cfg, state, params, NOW)([1n << 37n, 1n << 38n, 1n << 60n]);

    expect(q(1n << 37n)).toBe(1_678_155_051_104n); // organically below the cliff
    expect(q(1n << 38n)).toBe(2_569_384_657_300n); // was 0n pre-fix
    expect(q(1n << 60n)).toBe(2_569_384_657_300n); // plateaued
    expect(caps).toEqual([137_438_953_472n, 210_550_761_878n, 210_550_761_878n]);
  });
});
