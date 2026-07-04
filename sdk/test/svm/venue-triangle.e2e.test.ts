/**
 * Per-adapter one-pool quote triangle on the REAL SVM engine (LiteSVM): for
 * every registered venue, compile the adapter's emitQuote fragment as a
 * one-pool quote program (`return q0`), load the venue's mainnet fixture
 * dumps into the bank, pin the cluster clock, execute — and assert
 *
 *     in-VM quote == adapter.referenceQuote == docs/svm-venues.md pinned constant
 *
 * closing the emitQuote ↔ referenceQuote ↔ docs triangle. The pinned
 * constants are copied from each venue's worked example in docs/svm-venues.md
 * over the untouched fixture snapshot (the same pins the per-venue unit suites use) —
 * NEVER derived from the adapter's own output, so a shared formula bug cannot
 * self-verify. Requires the engine .so (SAUCE_ENGINE_SO); skips cleanly
 * without it.
 */
import { resolve } from 'path';
import { address } from '@solana/kit';
import type { Address } from '@solana/kit';
import { compile } from '@eco-incorp/sauce-compiler';
import { venueAdapter } from '../../src/svm/venues/registry.js';
import type { PoolConfig } from '../../src/svm/venues/types.js';
import { SOLSWAP_STABLE_HELPERS } from '../../src/recipes/solswap/index.js';
import type { AccountResolution } from '../../src/svm/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from './fixtures.js';
import {
  describeSvm,
  execute,
  expectOk,
  loadFixtureAccounts,
  startEngine,
  toBigInt,
} from './engine-harness.js';

interface TriangleCase {
  slug: string;
  pool: Address;
  amountIn: bigint;
  /**
   * The docs/svm-venues.md pinned worked example over the untouched fixture snapshot
   * (independently recomputed constants, same pins as the venue unit suites).
   */
  pinned: bigint;
  /**
   * Clock the quote is evaluated at, in-VM (LiteSVM Clock sysvar) and
   * off-chain (referenceQuote `now`) alike. Time-dependent venues use their
   * worked example's exact timestamp; the rest use any post-gate instant.
   */
  clock: bigint;
}

const CASES: TriangleCase[] = [
  // 1_000_000 WSOL lamports -> 81443 USDC (fee ceil 2500, floor quote).
  { slug: 'raydium-cp-swap', pool: address('7JuwJuNU88gurFnyWeiyGKbFmExMWcmRZntn9imEzdny'), amountIn: 1_000_000n, pinned: 81_443n, clock: 1_783_123_200n },
  // 1 SOL -> 81.386311 USDC (fee 2_500_000 ceil-charged on input).
  { slug: 'raydium-amm-v4', pool: address('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'), amountIn: 1_000_000_000n, pinned: 81_386_311n, clock: 1_783_123_200n },
  // buy_exact_quote_in over the untouched snapshot: 1000 USDC -> 632706768908 PUMP raw.
  { slug: 'pumpswap', pool: address('2uF4Xh61rDwxnG9woyxsVQP7zuA6kLFpb3NvnRQeoiSd'), amountIn: 1_000_000_000n, pinned: 632_706_768_908n, clock: 1_783_123_200n },
  // 1 SOL -> 81330481 USDC raw (trade fee 25/10000 + owner fee 5/10000, floor-min-1).
  { slug: 'orca-legacy-token-swap', pool: address('EGZ7tiLeH62TPV1gL8WwbXGzEPa9zmcpVnnkPKKnrE2U'), amountIn: 1_000_000_000n, pinned: 81_330_481n, clock: 1_783_123_200n },
  // 1 SOL -> 81.533661 USDC (sqrt-price step, 0.04% fee on output).
  { slug: 'meteora-damm-v2', pool: address('8Pm2kZpnxD3hoMmt4bjStX2Pw2Z9abpbHzZxMPqxPmie'), amountIn: 1_000_000_000n, pinned: 81_533_661n, clock: 1_780_000_000n },
  // 1.0 USDC -> 1.000603 USDT (post-ramp amp, output-side fee, -1 buffer).
  { slug: 'saber-stableswap', pool: address('YAkoNb6HKmSxQN9L8hiBE5tPJRsniSSMzND1boHmZxe'), amountIn: 1_000_000n, pinned: 1_000_603n, clock: 1_751_500_000n },
  // 1e9 uUSDC -> 1000605351 uUSDT at the exact snapshot clock (locked-profit decay).
  { slug: 'meteora-damm-v1-stable', pool: address('32D4zRxNc1EssbJieVHfPhZM3rH6CzfUPrWUuWxD9prG'), amountIn: 1_000_000_000n, pinned: 1_000_605_351n, clock: 1_783_175_236n },
];

const fixturesDir = (slug: string) => resolve(process.cwd(), 'test', 'svm', 'fixtures', slug);

describeSvm('venue quote triangle: emitQuote (real engine) == referenceQuote == svm-venues.md pin', () => {
  for (const { slug, pool, amountIn, pinned, clock } of CASES) {
    it(`${slug}: one-pool quote program returns the pinned quote`, async () => {
      const adapter = venueAdapter(slug);
      const fixtures = loadFixtures(fixturesDir(slug));
      const cfg = await adapter.fetchPoolConfig(fixtureLoader(fixtures), pool);

      // Leg 1: the TS mirror over the same snapshot reproduces the documented pin.
      const reference = adapter.referenceQuote(cfg, fixtureBytesMap(fixtures), amountIn, clock);
      expect(reference).toBe(pinned);

      // Leg 2: the emitQuote fragment, compiled as a one-pool quote program
      // (with the generator's shared Newton helpers for stable venues), runs
      // on the real engine against the same fixture accounts and clock.
      const helpers = adapter.kind === 'stable' ? `${SOLSWAP_STABLE_HELPERS}\n` : '';
      const source = `${helpers}function main() {\n${adapter.emitQuote(cfg, 0, amountIn)}\n  return q0;\n}`;
      const { bytecode, accountPlan } = compile(source, { target: 'svm' });
      if (!accountPlan) throw new Error('svm compile produced no account plan');

      const resolution: AccountResolution = {};
      for (const account of adapter.quoteAccounts(cfg)) {
        if (account.address === undefined) throw new Error(`quote account ref '${account.ref}' has no address`);
        resolution[account.ref] = account.address;
      }

      const harness = await startEngine(clock);
      loadFixtureAccounts(harness, fixtures);

      const result = expectOk(await execute(harness, { bytecode: bytecode[0], accountPlan }, resolution));
      expect(toBigInt(result.returnData)).toBe(pinned);
    });
  }
});

/**
 * meteora-damm-v2 clamp semantics on the real engine: a quote that crosses the
 * pool's sqrt-price band, or evaluates before a timestamp activation point,
 * returns 0 instead of aborting — the rest of a multi-venue solswapBest
 * program stays quotable. referenceQuote mirrors the band clamp (0n).
 */
describeSvm('meteora-damm-v2 clamps quote 0 in-VM instead of throwing', () => {
  const slug = 'meteora-damm-v2';
  const pool = address('8Pm2kZpnxD3hoMmt4bjStX2Pw2Z9abpbHzZxMPqxPmie');
  const adapter = venueAdapter(slug);
  const fixtures = loadFixtures(fixturesDir(slug));
  // Fixture pins (same as the triangle case): activation_point 1_754_985_927
  // (unix), post-activation clock 1_780_000_000.
  const ACTIVATION = 1_754_985_927n;
  const CLOCK = 1_780_000_000n;
  const ONE_SOL = 1_000_000_000n;

  const runInVm = async (cfg: PoolConfig, amountIn: bigint, clock: bigint): Promise<bigint> => {
    const source = `function main() {\n${adapter.emitQuote(cfg, 0, amountIn)}\n  return q0;\n}`;
    const { bytecode, accountPlan } = compile(source, { target: 'svm' });
    if (!accountPlan) throw new Error('svm compile produced no account plan');
    const resolution: AccountResolution = {};
    for (const account of adapter.quoteAccounts(cfg)) {
      if (account.address === undefined) throw new Error(`quote account ref '${account.ref}' has no address`);
      resolution[account.ref] = account.address;
    }
    const harness = await startEngine(clock);
    loadFixtureAccounts(harness, fixtures);
    const result = expectOk(await execute(harness, { bytecode: bytecode[0], accountPlan }, resolution));
    return toBigInt(result.returnData);
  };

  it('aToB amountIn crossing sqrt_min_price: 0 in-VM and from referenceQuote', async () => {
    const cfg = await adapter.fetchPoolConfig(fixtureLoader(fixtures), pool);
    const amountIn = 10_000n * ONE_SOL; // pushes next_sqrt_price below sqrt_min_price
    expect(adapter.referenceQuote(cfg, fixtureBytesMap(fixtures), amountIn, CLOCK)).toBe(0n);
    expect(await runInVm(cfg, amountIn, CLOCK)).toBe(0n);
  });

  it('bToA amountIn crossing sqrt_max_price: 0 in-VM and from referenceQuote', async () => {
    const cfg = { ...(await adapter.fetchPoolConfig(fixtureLoader(fixtures), pool)), direction: 'bToA' };
    const amountIn = (1n << 64n) - 1n; // pushes next_sqrt_price above sqrt_max_price
    expect(adapter.referenceQuote(cfg, fixtureBytesMap(fixtures), amountIn, CLOCK)).toBe(0n);
    expect(await runInVm(cfg, amountIn, CLOCK)).toBe(0n);
  });

  it('clock before the timestamp activation point: 0 in-VM (referenceQuote throws)', async () => {
    const cfg = await adapter.fetchPoolConfig(fixtureLoader(fixtures), pool);
    expect(() => adapter.referenceQuote(cfg, fixtureBytesMap(fixtures), ONE_SOL, ACTIVATION - 1n)).toThrow(
      'not activated',
    );
    expect(await runInVm(cfg, ONE_SOL, ACTIVATION - 1n)).toBe(0n);
  });
});
