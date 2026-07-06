/**
 * EcoSwapSVM Phase 1 oracle units (no engine, no RPC):
 * - the four new ladder families' referenceQuote closures against the
 *   docs/svm-venues.md pinned worked examples AND the v1 adapters'
 *   independently derived mirrors (raydium-amm-v4, meteora-damm-v2,
 *   saber-stableswap, meteora-damm-v1-stable);
 * - stable WARM-START ladder chains vs cold recompute — identical results
 *   on the fixture universe (the CU saving must be free);
 * - meteora-damm-v1 locked-profit decay window edges (t == last_report,
 *   ratio == 1e12 exactly, ratio past 1e12, clock behind last_report);
 * - the CU budgeter: model arithmetic, deterministic round-robin
 *   degradation, tail drops, the single-slot throw;
 * - solver-reference with per-slot rung counts and warm chains;
 * - the codegen shape contract for stable shapes (helper dedupe, rung
 *   suffixes, cfg words, GasLeft floor);
 * - the coalescing batched account loader (dedupe, chunking, owner checks).
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { address, getAddressCodec } from '@solana/kit';
import type { Address } from '@solana/kit';
import {
  meteoraDammV1Stable,
  meteoraDammV1StableLadder,
  meteoraDammV2,
  meteoraDammV2Ladder,
  raydiumAmmV4,
  raydiumAmmV4Ladder,
  saberStableswap,
  saberStableswapLadder,
  coalescingAccountLoader,
} from '../../src/svm/index.js';
import type { AccountBytesMap, LoadedAccount, MeteoraDammV2PoolConfig, RaydiumAmmV4PoolConfig } from '../../src/svm/index.js';
import {
  CU_ADMISSION_BUDGET,
  buildLadder,
  estimateShapeCu,
  generateEcoSwapSvm,
  ladderGrid,
  planLadders,
  quoteEcoSwapSvm,
  solveReference,
} from '../../src/recipes/ecoswap/svm/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from './fixtures.js';
import { synthesizeSaberPool, USDC_MINT, WSOL_MINT } from './ecoswap-svm.fixtures.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const v4Fixtures = loadFixtures(join(FIXTURES, 'raydium-amm-v4'));
const dv2Fixtures = loadFixtures(join(FIXTURES, 'meteora-damm-v2'));
const saberFixtures = loadFixtures(join(FIXTURES, 'saber-stableswap'));
const d1sFixtures = loadFixtures(join(FIXTURES, 'meteora-damm-v1-stable'));

const V4_POOL = address('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2');
const DV2_POOL = address('8Pm2kZpnxD3hoMmt4bjStX2Pw2Z9abpbHzZxMPqxPmie');
const SABER_POOL = address('YAkoNb6HKmSxQN9L8hiBE5tPJRsniSSMzND1boHmZxe');
const D1S_POOL = address('32D4zRxNc1EssbJieVHfPhZM3rH6CzfUPrWUuWxD9prG');

/** docs/svm-venues.md pin clocks. */
const CLOCK_SABER = 1_751_500_000n;
const CLOCK_SABER_MID_RAMP = 1_747_460_323n + 100_000n;
const CLOCK_DV2 = 1_780_000_000n;
const CLOCK_D1S = 1_783_175_236n;

describe('ladder adapters: the four Phase 1 families vs the svm-venues.md pins and the v1 mirrors', () => {
  it('raydium-amm-v4: pinned 1 SOL -> 81_386_311 and 1 USDC -> 12_225_534; parity with the v1 mirror', async () => {
    const cfg = await raydiumAmmV4.fetchPoolConfig(fixtureLoader(v4Fixtures), V4_POOL);
    const state = fixtureBytesMap(v4Fixtures);
    expect(raydiumAmmV4Ladder.paramsFor(cfg)).toEqual([]);

    const quote = raydiumAmmV4Ladder.referenceQuote(cfg, state, []);
    expect(quote(1_000_000_000n)).toBe(81_386_311n);
    expect(quote(0n)).toBe(0n);

    const reverse: RaydiumAmmV4PoolConfig = { ...(cfg as RaydiumAmmV4PoolConfig), inputIsCoin: false };
    expect(raydiumAmmV4Ladder.referenceQuote(reverse, state, [])(1_000_000n)).toBe(12_225_534n);

    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const x of [1_000_000n, 250_000_000n, 1_000_000_000n, 5_000_000_000n]) {
      expect(quote(x)).toBe(raydiumAmmV4.referenceQuote(cfg, state, x, now));
    }
  });

  it('meteora-damm-v2: pinned aToB 1 SOL -> 81_533_661 and bToA 100 USDC -> 1_225_394_003; parity with the v1 mirror', async () => {
    const cfg = await meteoraDammV2.fetchPoolConfig(fixtureLoader(dv2Fixtures), DV2_POOL);
    const state = fixtureBytesMap(dv2Fixtures);
    expect(meteoraDammV2Ladder.paramsFor(cfg)).toEqual([]);

    const aToB = meteoraDammV2Ladder.referenceQuote(cfg, state, []);
    expect(aToB(1_000_000_000n)).toBe(81_533_661n);
    expect(aToB(0n)).toBe(0n);

    const bToA: MeteoraDammV2PoolConfig = { ...(cfg as MeteoraDammV2PoolConfig), direction: 'bToA' };
    expect(meteoraDammV2Ladder.referenceQuote(bToA, state, [])(100_000_000n)).toBe(1_225_394_003n);

    for (const x of [1_000_000n, 100_000_000n, 1_000_000_000n, 20_000_000_000n]) {
      expect(aToB(x)).toBe(meteoraDammV2.referenceQuote(cfg, state, x, CLOCK_DV2));
      expect(meteoraDammV2Ladder.referenceQuote(bToA, state, [])(x)).toBe(
        meteoraDammV2.referenceQuote(bToA, state, x, CLOCK_DV2),
      );
    }
  });

  it('saber-stableswap: pinned post-ramp 1 USDC -> 1_000_603 and mid-ramp (amp 6843) -> 1_000_413; parity with the v1 mirror', async () => {
    const cfg = await saberStableswap.fetchPoolConfig(fixtureLoader(saberFixtures), SABER_POOL);
    const state = fixtureBytesMap(saberFixtures);
    expect(saberStableswapLadder.paramsFor(cfg)).toEqual([]);

    const quote = saberStableswapLadder.referenceQuote(cfg, state, [], CLOCK_SABER);
    expect(quote(1_000_000n)).toBe(1_000_603n);
    expect(quote(0n)).toBe(0n);
    expect(saberStableswapLadder.referenceQuote(cfg, state, [], CLOCK_SABER_MID_RAMP)(1_000_000n)).toBe(1_000_413n);

    for (const now of [CLOCK_SABER, CLOCK_SABER_MID_RAMP]) {
      const ladder = saberStableswapLadder.referenceQuote(cfg, state, [], now);
      for (const x of [1_000_000n, 500_000_000n, 10_000_000_000n]) {
        expect(ladder(x)).toBe(saberStableswap.referenceQuote(cfg, state, x, now));
      }
    }
  });

  it('meteora-damm-v1-stable: pinned 1e9 uUSDC -> 1_000_605_351 at the snapshot clock; parity with the v1 mirror', async () => {
    const cfg = await meteoraDammV1Stable.fetchPoolConfig(fixtureLoader(d1sFixtures), D1S_POOL);
    const state = fixtureBytesMap(d1sFixtures);
    expect(meteoraDammV1StableLadder.paramsFor(cfg)).toEqual([]);

    const quote = meteoraDammV1StableLadder.referenceQuote(cfg, state, [], CLOCK_D1S);
    expect(quote(1_000_000_000n)).toBe(1_000_605_351n);
    expect(quote(0n)).toBe(0n);

    for (const x of [1_000_000n, 1_000_000_000n, 25_000_000_000n]) {
      expect(quote(x)).toBe(meteoraDammV1Stable.referenceQuote(cfg, state, x, CLOCK_D1S));
    }
  });
});

describe('stable warm-start ladder chains: identical to cold recompute on the fixture universe', () => {
  const amounts = [3n, 1_000_000n, 137_654_321n, 1_000_000_000n, 25_000_000_000n];
  const rungCounts = [2, 3, 4];

  it('saber-stableswap: referenceLadderQuotes(grid) == grid.map(cold referenceQuote), every amount and rung count', async () => {
    const cfg = await saberStableswap.fetchPoolConfig(fixtureLoader(saberFixtures), SABER_POOL);
    const state = fixtureBytesMap(saberFixtures);
    const cold = saberStableswapLadder.referenceQuote(cfg, state, [], CLOCK_SABER);
    const chain = saberStableswapLadder.referenceLadderQuotes!(cfg, state, [], CLOCK_SABER);
    for (const amountIn of amounts) {
      for (const rungs of rungCounts) {
        const grid = ladderGrid(amountIn, rungs);
        expect(chain(grid)).toEqual(grid.map(cold));
      }
    }
  });

  it('meteora-damm-v1-stable: warm chain == cold recompute, every amount and rung count', async () => {
    const cfg = await meteoraDammV1Stable.fetchPoolConfig(fixtureLoader(d1sFixtures), D1S_POOL);
    const state = fixtureBytesMap(d1sFixtures);
    const cold = meteoraDammV1StableLadder.referenceQuote(cfg, state, [], CLOCK_D1S);
    const chain = meteoraDammV1StableLadder.referenceLadderQuotes!(cfg, state, [], CLOCK_D1S);
    for (const amountIn of amounts) {
      for (const rungs of rungCounts) {
        const grid = ladderGrid(amountIn, rungs);
        expect(chain(grid)).toEqual(grid.map(cold));
      }
    }
  });

  it('a synthesized saber pool (fresh bytes, flat amp) agrees warm == cold too', async () => {
    const synth = synthesizeSaberPool(WSOL_MINT, USDC_MINT, 200_000_000_000n, 900_000_000_000n, { amp: 5000n });
    const state: AccountBytesMap = {};
    for (const account of synth.accounts) state[account.address] = account.data;
    const load = async (addr: Address) => (state[addr] === undefined ? null : new Uint8Array(state[addr]));
    const cfg = await saberStableswap.fetchPoolConfig(load, synth.pool);
    const cold = saberStableswapLadder.referenceQuote(cfg, state, [], CLOCK_SABER);
    const chain = saberStableswapLadder.referenceLadderQuotes!(cfg, state, [], CLOCK_SABER);
    const grid = ladderGrid(40_000_000_000n, 4);
    expect(chain(grid)).toEqual(grid.map(cold));
    expect(cold(1_000_000n)).toBeGreaterThan(0n);
  });
});

describe('meteora-damm-v1-stable: locked-profit decay window edges', () => {
  const LAST_REPORT = 1_783_173_885n; // vault_a fixture value

  it('edges: t == last_report (full lock), ratio == 1e12 exactly and beyond (no lock), clock behind last_report', async () => {
    const cfg = await meteoraDammV1Stable.fetchPoolConfig(fixtureLoader(d1sFixtures), D1S_POOL);
    const base = fixtureBytesMap(d1sFixtures);
    const aVault = (cfg as import('../../src/svm/index.js').MeteoraDammV1StablePoolConfig).aVault;

    // Doctor vault_a: locked profit 1e9, degradation 1e6/s (full decay in 1e6 s).
    const LOCKED = 1_000_000_000n;
    const DEGRADATION = 1_000_000n;
    const doctored: AccountBytesMap = { ...base, [aVault]: new Uint8Array(base[aVault]) };
    const view = new DataView(doctored[aVault].buffer, doctored[aVault].byteOffset);
    view.setBigUint64(1203, LOCKED, true);
    view.setBigUint64(1211, LAST_REPORT, true);
    view.setBigUint64(1219, DEGRADATION, true);

    const reserveInAt = (now: bigint): bigint =>
      meteoraDammV1StableLadder.depthReserves(cfg, doctored, now).reserveIn;

    // Fully locked at t == last_report; linearly decaying; exactly zero lock
    // at ratio == 1e12 (Δt = 1e6 s); no lock past it; total on a wrapped clock.
    const fullLock = reserveInAt(LAST_REPORT);
    const halfLock = reserveInAt(LAST_REPORT + 500_000n);
    const zeroLockExact = reserveInAt(LAST_REPORT + 1_000_000n);
    const zeroLockPast = reserveInAt(LAST_REPORT + 1_000_001n);
    const wrapped = reserveInAt(LAST_REPORT - 1n);

    expect(fullLock).toBeLessThan(halfLock);
    expect(halfLock).toBeLessThan(zeroLockExact);
    expect(zeroLockExact).toBe(zeroLockPast); // the <= 1e12 branch meets the fallback exactly
    expect(wrapped).toBe(zeroLockPast); // t < last_report falls back to total_amount

    // And the quote at the edges stays a pure function of the same state.
    const qFull = meteoraDammV1StableLadder.referenceQuote(cfg, doctored, [], LAST_REPORT)(1_000_000_000n);
    const qNone = meteoraDammV1StableLadder.referenceQuote(cfg, doctored, [], LAST_REPORT + 1_000_000n)(1_000_000_000n);
    expect(qFull).toBeGreaterThan(0n);
    expect(qNone).toBeGreaterThan(0n);
    expect(qFull).not.toBe(qNone); // the decay window genuinely moves the quote
  });
});

describe('CU budgeter: model arithmetic and deterministic degradation', () => {
  it('estimateShapeCu is exact on the calibration identities', () => {
    // The fitted coefficients reproduce the single-slot measurements by construction.
    expect(estimateShapeCu([{ slug: 'raydium-cp-swap', rungs: 4 }])).toBe(400_206);
    expect(estimateShapeCu([{ slug: 'saber-stableswap', rungs: 2 }])).toBe(778_562);
    expect(estimateShapeCu([{ slug: 'meteora-damm-v1-stable', rungs: 2 }])).toBe(940_490);
  });

  it('defaults: CP slots plan 4 rungs, stable slots 2; small shapes pass untouched', () => {
    const plan = planLadders([{ slug: 'raydium-cp-swap' }, { slug: 'saber-stableswap' }], 2_000_000);
    expect(plan.rungs).toEqual([4, 2]);
    expect(plan.admitted).toBe(2);
    expect(plan.warnings).toEqual([]);
  });

  it('degrades round-robin (most rungs first, last index ties) — stable first, then CP', () => {
    // Three CP slots over budget: the LAST 4-rung slot degrades first, then
    // the next-to-last — never hammering one slot to MIN while peers sit at 4.
    const cp3 = planLadders(
      [{ slug: 'raydium-cp-swap' }, { slug: 'pumpswap' }, { slug: 'pumpswap' }],
      CU_ADMISSION_BUDGET,
    );
    expect(cp3.rungs).toEqual([4, 3, 3]);
    expect(cp3.admitted).toBe(3);
    expect(cp3.warnings).toHaveLength(2);
    expect(cp3.warnings[0]).toContain('degraded slot 2 (pumpswap) to 3 rungs');
    expect(cp3.warnings[1]).toContain('degraded slot 1 (pumpswap) to 3 rungs');

    // cp + saber: the stable slot is already at MIN (2), so the CP slot sheds.
    const cpStable = planLadders([{ slug: 'pumpswap' }, { slug: 'saber-stableswap' }], CU_ADMISSION_BUDGET);
    expect(cpStable.rungs).toEqual([3, 2]);
    expect(cpStable.warnings).toHaveLength(1);

    // A stable slot forced to 4 rungs degrades BEFORE any CP slot.
    const forced = planLadders(
      [{ slug: 'pumpswap' }, { slug: 'saber-stableswap', rungs: 4 }],
      CU_ADMISSION_BUDGET,
    );
    expect(forced.rungs[1]).toBeLessThan(4);
  });

  it('drops tail slots when degradation is not enough; a lone over-budget slot throws', () => {
    // saber + meteora-damm-v1-stable models past even the 1.4M cap — the
    // tail (heaviest) slot drops and saber survives alone.
    const plan = planLadders([{ slug: 'saber-stableswap' }, { slug: 'meteora-damm-v1-stable' }], CU_ADMISSION_BUDGET);
    expect(plan.admitted).toBe(1);
    expect(plan.rungs).toEqual([2]);
    expect(plan.warnings.some((w) => w.includes('dropped slot 1 (meteora-damm-v1-stable)'))).toBe(true);

    // meteora-damm-v1-stable alone IS admissible at the default budget…
    expect(planLadders([{ slug: 'meteora-damm-v1-stable' }], CU_ADMISSION_BUDGET).admitted).toBe(1);
    // …but a lone slot over a tightened budget throws with the estimate named.
    expect(() => planLadders([{ slug: 'meteora-damm-v1-stable' }], 900_000)).toThrow(/models 940490 CU, over the 900000/);
  });

  it('is a pure function of its inputs: identical inputs, identical plans', () => {
    const input = [{ slug: 'raydium-cp-swap' }, { slug: 'saber-stableswap' }, { slug: 'pumpswap' }];
    const a = planLadders(input, CU_ADMISSION_BUDGET);
    const b = planLadders(input, CU_ADMISSION_BUDGET);
    expect(a).toEqual(b);
  });
});

describe('solver-reference: per-slot rung counts and warm chains', () => {
  const cpQuote = (reserveIn: bigint, reserveOut: bigint) => (x: bigint): bigint =>
    x === 0n ? 0n : (x * reserveOut) / (reserveIn + x);

  it('mixed rung widths merge exactly and conserve amountIn', () => {
    const deep = cpQuote(10n ** 13n, 10n ** 13n);
    const { slices } = solveReference(
      [
        { quote: deep, rungs: 4 },
        { quote: deep, rungs: 2 },
      ],
      400_000_000n,
    );
    expect(slices[0] + slices[1]).toBe(400_000_000n);
    expect(slices[0] > 0n && slices[1] > 0n).toBe(true);
  });

  it('the ladder uses the CHAIN closure; predicted outputs use the COLD quote', () => {
    const gridsSeen: bigint[][] = [];
    const coldCalls: bigint[] = [];
    const quote = (x: bigint): bigint => {
      coldCalls.push(x);
      return x === 0n ? 0n : x / 2n;
    };
    const ladderQuotes = (grid: readonly bigint[]): bigint[] => {
      gridsSeen.push([...grid]);
      return grid.map((g) => (g === 0n ? 0n : g / 2n));
    };
    const result = solveReference([{ quote, ladderQuotes, rungs: 3 }], 800n);
    expect(gridsSeen).toEqual([[200n, 400n, 800n]]); // ONE chain call over the full grid
    expect(coldCalls).toEqual([800n]); // cold quote only for the predicted output
    expect(result.slices).toEqual([800n]);
    expect(result.totalPredicted).toBe(400n);
  });

  it('buildLadder rejects a chain returning the wrong width; rung bounds are enforced', () => {
    expect(() => buildLadder((x) => x, 100n, 4, () => [1n])).toThrow(/1 quotes for 4 grid points/);
    expect(() => solveReference([{ quote: (x) => x, rungs: 1 }], 100n)).toThrow(/rungs must be an integer in 2..4/);
    expect(() => solveReference([{ quote: (x) => x, rungs: 5 }], 100n)).toThrow(/rungs must be an integer in 2..4/);
  });
});

describe('codegen: stable shape contract', () => {
  const user = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };

  it('a saber+damm1s shape compiles once with the SHARED stable helpers deduped; rung suffixes in the shapeKey', async () => {
    const saberCfg = await saberStableswap.fetchPoolConfig(fixtureLoader(saberFixtures), SABER_POOL);
    const d1sCfg = await meteoraDammV1Stable.fetchPoolConfig(fixtureLoader(d1sFixtures), D1S_POOL);
    const generated = generateEcoSwapSvm({
      slots: [
        { adapter: saberStableswapLadder, cfg: saberCfg },
        { adapter: meteoraDammV1StableLadder, cfg: d1sCfg },
      ],
      user,
      cuFloor: 1_234_567,
    });
    expect(generated.shapeKey).toBe('saber-stableswap:AtoB~r2|meteora-damm-v1-stable:AtoB~r2');
    expect(generated.rungs).toEqual([2, 2]);
    // [amountIn][minOut] + 2 × [enable] (both families are param-free live readers)
    expect(generated.cfgByteLength).toBe(4 * 8);
    expect(generated.source.match(/function stableD\(/g)).toHaveLength(1); // deduped once
    expect(generated.source.match(/function stableYW\(/g)).toHaveLength(1);
    expect(generated.source).toContain('if (gasLeft() < 1234567) { throw "cu" }');
    expect(generated.bytecode.length).toBeLessThan(65_535);
  });

  it('the blob is shape-stable across pool sets: two synthesized saber pools compile byte-identically', async () => {
    const build = async () => {
      const synth = synthesizeSaberPool(WSOL_MINT, USDC_MINT, 150_000_000_000n, 700_000_000_000n, { amp: 5000n });
      const state: AccountBytesMap = {};
      for (const account of synth.accounts) state[account.address] = account.data;
      const load = async (addr: Address) => (state[addr] === undefined ? null : new Uint8Array(state[addr]));
      const cfg = await saberStableswap.fetchPoolConfig(load, synth.pool);
      return generateEcoSwapSvm({ slots: [{ adapter: saberStableswapLadder, cfg }], user, cuFloor: 777_777 });
    };
    const a = await build();
    const b = await build();
    expect(Buffer.from(a.bytecode).toString('hex')).toBe(Buffer.from(b.bytecode).toString('hex'));
    expect(a.shapeKey).toBe(b.shapeKey);
  });

  it('two adapters claiming one helper name with different sources are rejected', async () => {
    const saberCfg = await saberStableswap.fetchPoolConfig(fixtureLoader(saberFixtures), SABER_POOL);
    const clash = {
      ...saberStableswapLadder,
      helpers: () => [{ name: 'stableD', source: 'function stableD(a) { return a; }' }],
    };
    expect(() =>
      generateEcoSwapSvm({
        slots: [
          { adapter: saberStableswapLadder, cfg: saberCfg },
          { adapter: clash, cfg: saberCfg },
        ],
        user,
      }),
    ).toThrow(/helper 'stableD' is declared with two different sources/);
  });

  it('out-of-bounds rung requests are rejected at codegen', async () => {
    const saberCfg = await saberStableswap.fetchPoolConfig(fixtureLoader(saberFixtures), SABER_POOL);
    expect(() =>
      generateEcoSwapSvm({ slots: [{ adapter: saberStableswapLadder, cfg: saberCfg, rungs: 5 }], user }),
    ).toThrow(/rungs must be an integer in 2..4/);
  });
});

describe('coalescing batched account loader', () => {
  const addr = (byte: number): Address => getAddressCodec().decode(new Uint8Array(32).fill(byte));

  it('coalesces same-turn loads into one deduped batch and re-splits results', async () => {
    const batches: Address[][] = [];
    const load = coalescingAccountLoader(async (addresses) => {
      batches.push([...addresses]);
      return addresses.map((a) => ({ data: Uint8Array.of(1, 2, 3), owner: a }));
    });
    const [x, y, z] = await Promise.all([load(addr(1)), load(addr(2)), load(addr(1))]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2); // deduped
    expect([...x!]).toEqual([1, 2, 3]);
    expect([...y!]).toEqual([1, 2, 3]);
    expect([...z!]).toEqual([1, 2, 3]);
    expect(x).not.toBe(z); // fresh copies per waiter

    await load(addr(3));
    expect(batches).toHaveLength(2); // a later turn is a new sweep
  });

  it('chunks at the RPC cap and preserves order across chunks', async () => {
    const batches: number[] = [];
    const load = coalescingAccountLoader(
      async (addresses) => {
        batches.push(addresses.length);
        return addresses.map((_, i) => ({ data: Uint8Array.of(i), owner: addr(9) }));
      },
      { chunkSize: 3 },
    );
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => load(addr(i + 1))));
    expect(batches).toEqual([3, 3, 2]);
    expect(results.every((r) => r !== null)).toBe(true);
  });

  it('missing accounts resolve null; owner-check rejections fail ONLY that account', async () => {
    const owners: Record<string, Address> = { [addr(1) as string]: addr(7), [addr(2) as string]: addr(8) };
    const load = coalescingAccountLoader(
      async (addresses) =>
        addresses.map((a) => (a === (addr(3) as Address) ? null : { data: Uint8Array.of(9), owner: owners[a as string] })),
      {
        expectOwner: (address, owner) => {
          if (address === addr(2) && owner !== addr(7)) throw new Error(`bad owner for ${address}`);
        },
      },
    );
    const results = await Promise.allSettled([load(addr(1)), load(addr(2)), load(addr(3))]);
    expect(results[0].status).toBe('fulfilled');
    expect((results[0] as PromiseFulfilledResult<Uint8Array | null>).value).not.toBeNull();
    expect(results[1].status).toBe('rejected');
    expect(results[2].status).toBe('fulfilled');
    expect((results[2] as PromiseFulfilledResult<Uint8Array | null>).value).toBeNull();
  });

  it('a failing transport rejects every waiter of that chunk', async () => {
    const load = coalescingAccountLoader(async () => {
      throw new Error('rpc down');
    });
    const results = await Promise.allSettled([load(addr(1)), load(addr(2))]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });

  it('type-level: kitBatchAccountLoader shape matches LoadedAccount', () => {
    const sample: LoadedAccount = { data: Uint8Array.of(1), owner: addr(1) };
    expect(sample.data).toHaveLength(1);
  });

  it('quoteEcoSwapSvm over loadMany: the whole 2-pool prepare batches into DEPTH sweeps, not per-account trips', async () => {
    const fixtures = new Map<string, { data: Uint8Array; owner: Address }>();
    for (const fixture of [...saberFixtures, ...v4Fixtures]) {
      fixtures.set(fixture.address, {
        data: new Uint8Array(Buffer.from(fixture.base64Data, 'base64')),
        owner: address(fixture.owner),
      });
    }
    const sweeps: number[] = [];
    const loadMany = async (addresses: readonly Address[]) => {
      sweeps.push(addresses.length);
      return addresses.map((a) => fixtures.get(a) ?? null);
    };

    const quote = await quoteEcoSwapSvm({
      amountIn: 1_000_000n,
      pools: [
        { venue: 'saber-stableswap', pool: SABER_POOL },
        { venue: 'raydium-amm-v4', pool: V4_POOL },
      ],
      loadMany,
      now: CLOCK_SABER,
      minRelBps: 0,
    });
    expect(quote.slices).toHaveLength(2);
    expect(quote.slices[0] + quote.slices[1]).toBe(1_000_000n);
    // Sweep 1: both pool accounts together; the following sweeps carry the
    // families' satellite levels (v4's two vault fetches are sequential
    // inside its fetchPoolConfig, saber's state snapshot is one level) —
    // O(fixed dependency depth), NOT O(pool count): the sweep count is
    // bounded by the deepest family's chain, and every sweep batches that
    // level across ALL candidates.
    expect(sweeps.length).toBeLessThanOrEqual(5);
    expect(sweeps[0]).toBe(2);
    expect(sweeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(12);
  });

  it('quoteEcoSwapSvm over loadMany REJECTS a pool account owned by the wrong program', async () => {
    const saberPoolFixture = saberFixtures.find((f) => f.address === (SABER_POOL as string))!;
    const loadMany = async (addresses: readonly Address[]) =>
      addresses.map((a) =>
        a === SABER_POOL
          ? { data: new Uint8Array(Buffer.from(saberPoolFixture.base64Data, 'base64')), owner: addr(66) } // wrong owner
          : null,
      );
    await expect(
      quoteEcoSwapSvm({
        amountIn: 1_000_000n,
        pools: [{ venue: 'saber-stableswap', pool: SABER_POOL }],
        loadMany,
        now: CLOCK_SABER,
      }),
    ).rejects.toThrow(/owned by .* expected the saber-stableswap program/);
  });

  it('ecoSwapSvm demands exactly one account source', async () => {
    const pools: Parameters<typeof quoteEcoSwapSvm>[0]['pools'] = [{ venue: 'saber-stableswap', pool: SABER_POOL }];
    await expect(quoteEcoSwapSvm({ amountIn: 1n, pools })).rejects.toThrow(/pass load or loadMany/);
    await expect(
      quoteEcoSwapSvm({ amountIn: 1n, pools, load: fixtureLoader(saberFixtures), loadMany: async (a) => a.map(() => null) }),
    ).rejects.toThrow(/load OR loadMany, not both/);
  });
});
