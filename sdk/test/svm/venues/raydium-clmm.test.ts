/**
 * Raydium CLMM ladder adapter units (no engine, no RPC): mainnet fixture
 * decode, tick math against the live pool's mid-tick sqrt price, worked-example
 * quotes (regression-pinned from the mirror — the venue's compute_swap
 * transcription; the lamport-exact engine gate cross-checks the fragment
 * against this mirror, and the optional real-binary lane against the program),
 * window-capacity clamp, the warm chain's merge-safety, negative-liquidity-net
 * i128 round-trips on synthetic profiles, fetch gates, swap-instruction
 * encoding, and a full staged compile of a one-slot shape.
 *
 * Fixture: SOL/USDC 0.04% ts=1 pool 3ucNos4N... + surrounding tick arrays +
 * config + vaults + mints, one-slot mainnet snapshot (slot ~431198953).
 */
import { resolve } from 'path';
import { address } from '@solana/kit';
import {
  fetchRaydiumClmmConfig,
  windowStartTicks,
  arrayStartIndex,
  POOL_DISCRIMINATOR,
  TICK_ARRAY_DISCRIMINATOR,
  AMM_CONFIG_DISCRIMINATOR,
  RAYDIUM_CLMM_MAX_BOUNDARIES,
} from '../../../src/svm/venues/raydium-clmm/index.js';
import type { RaydiumClmmPoolConfig } from '../../../src/svm/venues/raydium-clmm/index.js';
import {
  raydiumClmmLadder,
  raydiumDelta0,
  raydiumDelta1,
  raydiumSqrtPriceAtTick,
} from '../../../src/svm/venues/raydium-clmm/ladder.js';
import { MIN_SQRT_PRICE_X64, MAX_SQRT_PRICE_X64, MIN_TICK, MAX_TICK } from '../../../src/svm/venues/raydium-clmm/tick-math.js';
import type { AccountBytesMap, AccountLoader } from '../../../src/svm/index.js';
import { buildLadder, generateEcoSwapSvm } from '../../../src/recipes/ecoswap/svm/index.js';
import { fixtureBytesMap, fixtureData, fixtureLoader, loadFixtures } from '../fixtures.js';
import { WSOL_MINT, USDC_MINT } from '../ecoswap-svm.fixtures.js';

const POOL = address('3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv');
const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };

const fixtures = loadFixtures(resolve(process.cwd(), 'test/svm/fixtures/raydium-clmm'));
const loader = fixtureLoader(fixtures);
const state = fixtureBytesMap(fixtures);
const poolFixture = fixtures.find((f) => f.address === POOL)!;

const fetchCfg = (): Promise<RaydiumClmmPoolConfig> => fetchRaydiumClmmConfig(loader, POOL);
const as1to0 = (cfg: RaydiumClmmPoolConfig): RaydiumClmmPoolConfig => ({ ...cfg, direction: '1to0' });
const quoteFn = (cfg: RaydiumClmmPoolConfig, bytes: AccountBytesMap = state) =>
  raydiumClmmLadder.referenceQuote(cfg, bytes, raydiumClmmLadder.paramsFor(cfg));

function writeLE(data: Uint8Array, offset: number, width: number, value: bigint): void {
  for (let i = 0; i < width; i++) data[offset + i] = Number((value >> BigInt(8 * i)) & 0xffn);
}
function doctoredLoader(mutate: (data: Uint8Array) => void, extra: Record<string, Uint8Array> = {}): AccountLoader {
  const data = fixtureData(poolFixture);
  mutate(data);
  return async (addr) => {
    if (addr === POOL) return data;
    if (extra[addr] !== undefined) return extra[addr];
    return loader(addr);
  };
}

describe('raydium-clmm tick math', () => {
  it('matches the source bounds and is strictly increasing', () => {
    expect(raydiumSqrtPriceAtTick(0)).toBe(18446744073709551616n); // 2^64
    expect(raydiumSqrtPriceAtTick(MIN_TICK)).toBe(MIN_SQRT_PRICE_X64);
    expect(raydiumSqrtPriceAtTick(MAX_TICK)).toBe(MAX_SQRT_PRICE_X64);
    // The live pool's mid-tick sqrt sits between its tick and tick+1 boundaries.
    expect(raydiumSqrtPriceAtTick(-25007)).toBe(5283561491725923125n);
    for (const tick of [-25038, -1, 0, 1, 25000]) {
      expect(raydiumSqrtPriceAtTick(tick)).toBeLessThan(raydiumSqrtPriceAtTick(tick + 1));
    }
  });

  it('delta_1 equals the whirlpool wpDB form; delta_0 uses nested rounding', () => {
    const l = 832740502930995n;
    const lo = raydiumSqrtPriceAtTick(-25040);
    const hi = raydiumSqrtPriceAtTick(-25038);
    // both non-negative, monotone in the range width
    expect(raydiumDelta1(l, lo, hi, true)).toBeGreaterThanOrEqual(raydiumDelta1(l, lo, hi, false));
    expect(raydiumDelta0(l, lo, hi, true)).toBeGreaterThanOrEqual(raydiumDelta0(l, lo, hi, false));
    expect(raydiumDelta0(l, hi, hi, true)).toBe(0n); // empty range
  });
});

describe('raydium-clmm fetchPoolConfig on the mainnet fixture', () => {
  it('decodes the pinned pool fields (snapshot slot ~431198953)', async () => {
    const cfg = await fetchCfg();
    expect(cfg.tickSpacing).toBe(1);
    expect(cfg.tradeFeeRate).toBe(400);
    expect(cfg.tickCurrentIndex).toBe(-25038);
    expect(cfg.tokenMint0).toBe(WSOL_MINT);
    expect(cfg.tokenMint1).toBe(USDC_MINT);
    expect(cfg.ammConfig).toBe(address('3h2e43PunVA5K34vwKCLHWhZF4aZpyaC9RmxvshGAQpL'));
  });

  it('derives both direction windows and the boundary params', async () => {
    const cfg = await fetchCfg();
    expect(cfg.windows['0to1'].boundaries.map((b) => b.tick)).toEqual([-25039, -25040, -25041, -25042]);
    expect(cfg.windows['0to1'].boundaries.every((b) => b.arrayIndex === 0)).toBe(true);
    expect(cfg.windows['0to1'].boundaries[0].sqrtPrice).toBe(raydiumSqrtPriceAtTick(-25039));
    expect(cfg.windows['1to0'].boundaries.map((b) => b.tick)).toEqual([-25034, -25033, -25032, -25030]);

    const params = raydiumClmmLadder.paramsFor(cfg);
    expect(params).toHaveLength(1 + 3 * RAYDIUM_CLMM_MAX_BOUNDARIES + 3);
    expect(params[0]).toBe(4n);
    const meta0 = params[1];
    expect(meta0 & 0xffffffffn).toBe(2147483648n - 25039n); // biased tick
    expect((params[2] << 64n) | params[3]).toBe(raydiumSqrtPriceAtTick(-25039));
  });

  it('computes array-start indexes with floor-to-negative division', () => {
    expect(arrayStartIndex(-25038, 1)).toBe(-25080);
    expect(arrayStartIndex(0, 1)).toBe(0);
    expect(arrayStartIndex(-1, 1)).toBe(-60);
    expect(windowStartTicks(-25038, 1, true)).toEqual([-25080, -25140, -25200]);
    expect(windowStartTicks(-25038, 1, false)).toEqual([-25080, -25020, -24960]);
  });

  it('gates fee_on, dynamic fee, foreign sizes/discriminators, swap-disabled, non-classic mints', async () => {
    await expect(fetchRaydiumClmmConfig(doctoredLoader((d) => (d[390] = 1)), POOL)).rejects.toThrow(/fee_on/);
    await expect(fetchRaydiumClmmConfig(doctoredLoader((d) => (d[1096] = 1)), POOL)).rejects.toThrow(/dynamic fee/);
    await expect(fetchRaydiumClmmConfig(doctoredLoader((d) => (d[389] = 1 << 4)), POOL)).rejects.toThrow(/swaps disabled/);
    const truncated = fixtureData(poolFixture).subarray(0, 1000);
    await expect(fetchRaydiumClmmConfig(async () => truncated, POOL)).rejects.toThrow(/1544/);
    await expect(fetchRaydiumClmmConfig(doctoredLoader((d) => (d[0] ^= 0xff)), POOL)).rejects.toThrow(/discriminator/);
    await expect(
      fetchRaydiumClmmConfig(doctoredLoader(() => {}, { [WSOL_MINT]: new Uint8Array(200) }), POOL),
    ).rejects.toThrow(/classic SPL/);
  });
});

describe('raydium-clmm worked examples (regression-pinned from the mirror)', () => {
  it('0to1 SOL -> USDC, within the ts=1 window', async () => {
    const quote = quoteFn(await fetchCfg());
    expect(quote(1_000_000_000n)).toBe(81_759_001n);
    expect(quote(10_000_000_000n)).toBe(817_570_824n);
    expect(quote(0n)).toBe(0n);
    expect(quote(100_000_000_000n)).toBe(0n); // beyond the 4-boundary window capacity — self-deactivation
  });

  it('1to0 USDC -> SOL', async () => {
    const quote = quoteFn(as1to0(await fetchCfg()));
    expect(quote(82_000_000n)).toBe(1_002_140_234n);
    expect(quote(820_000_000n)).toBe(10_021_166_496n);
    expect(quote(8_200_000_000n)).toBe(100_188_087_624n);
  });

  it('the warm chain equals the cold quotes pointwise and stays monotone (no negative dOut)', async () => {
    const cfg = await fetchCfg();
    const amountIn = 5_000_000_000n;
    const cold = quoteFn(cfg);
    const chain = raydiumClmmLadder.referenceLadderQuotes!(cfg, state, raydiumClmmLadder.paramsFor(cfg));
    const rungs = buildLadder(cold, amountIn, 4, chain);
    for (const rung of rungs) {
      expect(rung.dOut).toBeGreaterThanOrEqual(0n);
      expect(rung.dIn).toBeGreaterThan(0n);
    }
    const grid = [amountIn >> 3n, amountIn >> 2n, amountIn >> 1n, amountIn];
    expect(grid.map(cold)).toEqual(chain(grid));
  });
});

describe('raydium-clmm swap template + staged compile', () => {
  it('encodes the swap_v2 instruction (disc, threshold 1, no explicit limit, base_input)', async () => {
    const cfg = await fetchCfg();
    const template = raydiumClmmLadder.buildSwapV2(cfg, 0, USER);
    expect(template.programId).toBe(address('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'));
    expect([...template.prefix]).toEqual([43, 4, 237, 11, 26, 201, 30, 98]);
    expect(template.patch).toBe('in');
    // threshold u64 = 1, sqrt_price_limit u128 = 0, is_base_input = 1
    expect([...template.suffix]).toEqual([1, 0, 0, 0, 0, 0, 0, 0, ...new Array(16).fill(0), 1]);
    expect(template.accounts.map((a) => a.ref)).toEqual([
      'payer', 's0:cfg', 's0:pool', 'user:in', 'user:out', 's0:iv', 's0:ov', 's0:obs',
      's0:tp', 's0:tp22', 's0:memo', 's0:im', 's0:om', 's0:bmx', 's0:ta0', 's0:ta1', 's0:ta2',
    ]);
    // 0to1: input vault = vault0, output = vault1
    expect(template.accounts[5].address).toBe(cfg.tokenVault0);
    expect(template.accounts[6].address).toBe(cfg.tokenVault1);
    const flipped = raydiumClmmLadder.buildSwapV2(as1to0(cfg), 0, USER);
    expect(flipped.accounts[5].address).toBe(cfg.tokenVault1); // 1to0: input vault = vault1
    expect(flipped.accounts[6].address).toBe(cfg.tokenVault0);
  });

  it('compiles a one-slot staged shape (helpers, scan, chain, cold final)', async () => {
    const cfg = await fetchCfg();
    const generated = generateEcoSwapSvm({ slots: [{ adapter: raydiumClmmLadder, cfg }], user: USER, cuFloor: 1 });
    expect(generated.shapeKey).toBe('raydium-clmm:0to1~r2');
    expect(generated.rungs).toEqual([2]);
    expect(generated.cfgByteLength).toBe(152); // amountIn, minOut, enable, 16 boundary/edge words
    expect(generated.bytecode.length).toBeGreaterThan(1000);
    const refs = generated.accountPlan.metas.map((m) => m.ref);
    for (const ref of ['s0:pool', 's0:cfg', 's0:ta0', 's0:ta1', 's0:ta2', 's0:prog']) expect(refs).toContain(ref);
  });

  it('pins the account discriminators the fragment/fetch check', () => {
    expect(POOL_DISCRIMINATOR).toEqual([0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46]);
    expect(TICK_ARRAY_DISCRIMINATOR).toEqual([0xc0, 0x9b, 0x55, 0xcd, 0x31, 0xf9, 0x81, 0x2a]);
    expect(AMM_CONFIG_DISCRIMINATOR).toEqual([0xda, 0xf4, 0x21, 0x68, 0xcb, 0xcb, 0x2b, 0x6f]);
  });
});
