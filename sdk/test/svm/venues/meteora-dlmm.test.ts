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
import { fixtureLoader, loadFixtures } from '../fixtures.js';

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
