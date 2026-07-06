/**
 * EcoSwapSVM 2-hop route oracle units (no engine, no RPC): the composed
 * lamport-exact mirror (routeReference — leg-0 solve → intermediate → leg-1
 * solve), the leg-aware route budgeter (planRouteLadders — degradation, the
 * per-leg drop guard, infeasibility), and the route codegen shape contract
 * (compiles, packed-cfg layout, per-leg swap-user threading, shape-stable
 * bytecode across pool sets).
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { address } from '@solana/kit';
import { raydiumCpSwap, raydiumCpSwapLadder } from '../../src/svm/index.js';
import type { RaydiumCpSwapPoolConfig } from '../../src/svm/index.js';
import {
  DEFAULT_INTER_REF,
  ecoSwapSvmRouteShapeKey,
  encodeEcoSwapSvmTrade,
  estimateRouteCu,
  generateEcoSwapSvmRoute,
  planRouteLadders,
  routeReference,
  solveReference,
} from '../../src/recipes/ecoswap/svm/index.js';
import { loadFixtures } from './fixtures.js';
import { overlayLoader, RAYDIUM_CP_PROGRAM, synthesizeRaydiumCpPool } from './ecoswap-svm.fixtures.js';
import type { SynthesizedRaydiumCpPool } from './ecoswap-svm.fixtures.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const rayFixtures = loadFixtures(join(FIXTURES, 'raydium-cp-swap'));

/** Pure CP quote with a multiplicative ppm fee — the merge-unit test venue. */
const cpQuote = (reserveIn: bigint, reserveOut: bigint, feePpm: bigint) => (x: bigint): bigint => {
  if (x === 0n) return 0n;
  const net = x - (x * feePpm + 999_999n) / 1_000_000n;
  return (net * reserveOut) / (reserveIn + net);
};

const user = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };
const DEEP = 10n ** 13n;

/** Builds an EcoSwapSvmSlot from a synthesized raydium-cp pool (0to1, WSOL in). */
async function raySlot(pool: SynthesizedRaydiumCpPool, extra: SynthesizedRaydiumCpPool[] = []) {
  const load = overlayLoader(rayFixtures, [pool, ...extra]);
  const cfg = (await raydiumCpSwap.fetchPoolConfig(load, pool.pool)) as RaydiumCpSwapPoolConfig;
  return { adapter: raydiumCpSwapLadder, cfg };
}

describe('routeReference: composed lamport-exact mirror', () => {
  it('composes leg-0 → intermediate → leg-1: intermediate == Σ leg-0 predicted, totalOut == leg-1 solve on it', () => {
    const leg0 = [{ quote: cpQuote(DEEP, DEEP, 2500n) }, { quote: cpQuote(DEEP, DEEP, 3000n) }];
    const leg1 = [{ quote: cpQuote(2n * DEEP, DEEP, 2500n) }];
    const amountIn = 400_000_000n;

    const route = routeReference(leg0, leg1, amountIn);
    const r0 = solveReference(leg0, amountIn);
    expect(route.intermediate).toBe(r0.totalPredicted);
    expect(route.leg0.slices).toEqual(r0.slices);
    // leg-1 solves on the realized intermediate — the on-chain grid.
    const r1 = solveReference(leg1, route.intermediate);
    expect(route.leg1.slices).toEqual(r1.slices);
    expect(route.totalOut).toBe(r1.totalPredicted);
    // conservation: leg-0 slices sum to amountIn, leg-1 slices to the intermediate.
    expect(route.leg0.slices.reduce((s, x) => s + x, 0n)).toBe(amountIn);
    expect(route.leg1.slices.reduce((s, x) => s + x, 0n)).toBe(route.intermediate);
  });

  it('a multi-pool leg-0 splits and its predicted outs sum to the intermediate the leg-1 grid is built on', () => {
    const leg0 = [{ quote: cpQuote(DEEP, DEEP, 2500n) }, { quote: cpQuote(DEEP, DEEP, 2500n) }];
    const leg1 = [{ quote: cpQuote(DEEP, DEEP, 3000n) }];
    const amountIn = 1_000_000_000n;
    const route = routeReference(leg0, leg1, amountIn);
    expect(route.leg0.slices[0] + route.leg0.slices[1]).toBe(amountIn);
    expect(route.leg0.slices[0] > 0n && route.leg0.slices[1] > 0n).toBe(true);
    expect(route.leg0.predictedOuts.reduce((s, x) => s + x, 0n)).toBe(route.intermediate);
    expect(route.leg1.slices).toEqual([route.intermediate]); // single leg-1 pool absorbs it
  });

  it('throws the on-chain "x" mirror when leg-0 produces no intermediate', () => {
    const dead = { quote: (_x: bigint): bigint => 0n };
    expect(() => routeReference([dead], [{ quote: cpQuote(DEEP, DEEP, 2500n) }], 1_000_000n)).toThrow(/no intermediate/);
  });

  it('requires at least one slot per leg', () => {
    expect(() => routeReference([], [{ quote: cpQuote(DEEP, DEEP, 0n) }], 1n)).toThrow(/leg-0/);
    expect(() => routeReference([{ quote: cpQuote(DEEP, DEEP, 0n) }], [], 1n)).toThrow(/leg-1/);
  });
});

describe('planRouteLadders: leg-aware CU budgeter', () => {
  it('a 1-CP-per-leg route fits at full rungs (no degradation)', () => {
    const plan = planRouteLadders([{ slug: 'raydium-cp-swap' }], [{ slug: 'raydium-cp-swap' }]);
    expect(plan.leg0Rungs).toEqual([4]);
    expect(plan.leg1Rungs).toEqual([4]);
    expect(plan.rungs).toEqual([4, 4]);
    expect(plan.warnings).toEqual([]);
    expect(plan.estimatedCu).toBe(estimateRouteCu([{ slug: 'raydium-cp-swap', rungs: 4 }], [{ slug: 'raydium-cp-swap', rungs: 4 }]));
  });

  it('degrades rungs across both legs before dropping any slot', () => {
    const plan = planRouteLadders(
      [{ slug: 'raydium-cp-swap' }, { slug: 'raydium-cp-swap' }],
      [{ slug: 'raydium-cp-swap' }, { slug: 'raydium-cp-swap' }],
    );
    // 4 CP slots at 4 rungs models over budget → degrade toward MIN_RUNGS, then
    // (if still over) drop a tail slot — but never empty a leg.
    expect(plan.leg0Admitted).toBeGreaterThanOrEqual(1);
    expect(plan.leg1Admitted).toBeGreaterThanOrEqual(1);
    expect(plan.estimatedCu).toBeLessThanOrEqual(1_190_000);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it('never empties a leg: drops leg-1 tail first, keeps ≥1 slot per leg', () => {
    // Force heavy degradation by a tight budget; assert both legs keep a slot.
    const plan = planRouteLadders(
      [{ slug: 'raydium-cp-swap' }, { slug: 'raydium-cp-swap' }],
      [{ slug: 'raydium-cp-swap' }, { slug: 'raydium-cp-swap' }],
      900_000,
    );
    expect(plan.leg0Admitted).toBeGreaterThanOrEqual(1);
    expect(plan.leg1Admitted).toBeGreaterThanOrEqual(1);
    expect(plan.warnings.some((w) => w.includes('dropped'))).toBe(true);
  });

  it('throws infeasible when a 1-per-leg route at MIN_RUNGS still exceeds the budget', () => {
    expect(() => planRouteLadders([{ slug: 'orca-whirlpool' }], [{ slug: 'raydium-clmm' }], 500_000)).toThrow(/route CU budget/);
  });
});

describe('route codegen: shape contract', () => {
  it('compiles a 1+1 raydium-cp route; cfg = 6 u64 words; plan threads the intermediate ATA + per-leg users', async () => {
    const p0 = synthesizeRaydiumCpPool(3_200_000_000n, 262_000_000n);
    const p1 = synthesizeRaydiumCpPool(2_000_000_000n, 500_000_000n);
    const generated = generateEcoSwapSvmRoute({
      leg0: [await raySlot(p0, [p1])],
      leg1: [await raySlot(p1, [p0])],
      user,
    });

    // [amountIn][minOut] + slot0 [enable][crMode] + slot1 [enable][crMode]
    expect(generated.cfgByteLength).toBe(6 * 8);
    expect(generated.argsLayout.slots).toEqual([{ arg: 0, kind: 'bytes', offset: 0, length: 48 }]);
    expect(generated.leg0Count).toBe(1);
    expect(generated.leg1Count).toBe(1);
    expect(generated.rungs).toEqual([4, 4]);
    expect(generated.shapeKey).toBe('route:raydium-cp-swap:0to1>>raydium-cp-swap:0to1');
    expect(generated.bytecode.length).toBeGreaterThan(0);
    expect(generated.bytecode.length).toBeLessThan(65_535);

    const byRef = new Map(generated.accountPlan.metas.map((m) => [m.ref, m]));
    // leg-0 flat slot 0, leg-1 flat slot 1 — adapter-resolved refs stamped.
    expect(byRef.get('s0:pool')!.pubkey).toBe(p0.pool);
    expect(byRef.get('s1:pool')!.pubkey).toBe(p1.pool);
    // the intermediate ATA and the user token accounts stay open (caller-resolved).
    for (const ref of [DEFAULT_INTER_REF, 'user:out', 'user:in']) {
      expect(byRef.has(ref)).toBe(true);
      expect(byRef.get(ref)!.pubkey).toBeUndefined();
    }
    // the source computes realizedX (leg-0 delta on the intermediate) and realizedB.
    expect(generated.source).toContain('const realizedX = after0 - before0;');
    expect(generated.source).toContain('const realizedB = after1 - before1;');
    expect(generated.source).toContain('if (realizedX === 0) { throw "x" }');
    expect(generated.source).toContain('if (realizedB < minOut) { throw "out" }');
    // leg-1 ladder grids are built on the realized intermediate, not amountIn.
    expect(generated.source).toContain('realizedX >> ');
  });

  it('the route blob is shape-stable across pool sets (byte-identical)', async () => {
    const build = async () => {
      const p0 = synthesizeRaydiumCpPool(5_000_000_000n, 410_000_000n);
      const p1 = synthesizeRaydiumCpPool(1_000_000_000n, 900_000_000n);
      return generateEcoSwapSvmRoute({ leg0: [await raySlot(p0, [p1])], leg1: [await raySlot(p1, [p0])], user });
    };
    const a = await build();
    const b = await build(); // fresh random pool/vault addresses, same shape
    expect(Buffer.from(a.bytecode).toString('hex')).toBe(Buffer.from(b.bytecode).toString('hex'));
    expect(a.shapeKey).toBe(b.shapeKey);
  });

  it('compiles a 2+1 route; cfg = 8 words; flat trade encoding is leg-0 then leg-1', async () => {
    const p0a = synthesizeRaydiumCpPool(3_200_000_000n, 262_000_000n);
    const p0b = synthesizeRaydiumCpPool(3_000_000_000n, 250_000_000n);
    const p1 = synthesizeRaydiumCpPool(2_000_000_000n, 500_000_000n);
    const all = [p0a, p0b, p1];
    const generated = generateEcoSwapSvmRoute({
      leg0: [await raySlot(p0a, all), await raySlot(p0b, all)],
      leg1: [await raySlot(p1, all)],
      user,
    });
    expect(generated.leg0Count).toBe(2);
    expect(generated.leg1Count).toBe(1);
    expect(generated.cfgByteLength).toBe(8 * 8); // [amt][minOut] + 3 slots × [enable][crMode]
    expect(generated.shapeKey).toBe('route:raydium-cp-swap:0to1|raydium-cp-swap:0to1>>raydium-cp-swap:0to1');

    // encode packs the flat [leg-0…][leg-1…] slot order.
    const hex = encodeEcoSwapSvmTrade([{ params: [0n] }, { params: [0n] }, { params: [0n] }], 12345n, 1n);
    const bytes = Buffer.from(hex.slice(2), 'hex');
    expect(bytes.length).toBe(8 * 8);
    expect(bytes.readBigUInt64LE(0)).toBe(12345n);
  });

  it('rejects an empty leg and an interRef colliding with a user ATA', async () => {
    const p0 = synthesizeRaydiumCpPool(3_200_000_000n, 262_000_000n);
    const p1 = synthesizeRaydiumCpPool(2_000_000_000n, 500_000_000n);
    const leg0 = [await raySlot(p0, [p1])];
    const leg1 = [await raySlot(p1, [p0])];
    expect(() => generateEcoSwapSvmRoute({ leg0: [], leg1, user })).toThrow(/leg-0 expects/);
    expect(() => generateEcoSwapSvmRoute({ leg0, leg1: [], user })).toThrow(/leg-1 expects/);
    expect(() => generateEcoSwapSvmRoute({ leg0, leg1, user, interRef: 'user:out' })).toThrow(/must differ/);
  });
});

describe('route shape key', () => {
  it('marks the leg boundary with >> so k0 is recoverable', () => {
    const key = ecoSwapSvmRouteShapeKey(
      [{ adapter: raydiumCpSwapLadder, cfg: { venue: 'raydium-cp-swap', pool: address('11111111111111111111111111111111'), inputIsToken0: true } as unknown as RaydiumCpSwapPoolConfig }],
      [{ adapter: raydiumCpSwapLadder, cfg: { venue: 'raydium-cp-swap', pool: address('11111111111111111111111111111111'), inputIsToken0: true } as unknown as RaydiumCpSwapPoolConfig }],
    );
    expect(key.startsWith('route:')).toBe(true);
    expect(key.includes('>>')).toBe(true);
  });
});
