/**
 * EcoSwapSVM oracle units (no engine, no RPC): the quantized solver mirror
 * (solver-reference.ts) — ladder construction, merge semantics, conservation,
 * tie preference; the ladder adapters' referenceQuote closures against the
 * docs/svm-venues.md pinned worked examples and the v1 adapters' independent
 * mirrors; the continuous water-fill oracle (optimal.ts); and the codegen
 * shape contract (compiles, packed-cfg layout, shape-stable bytecode across
 * pool sets).
 */
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { address } from '@solana/kit';
import {
  orcaLegacyTokenSwap,
  orcaLegacyTokenSwapLadder,
  pumpswapAdapter,
  pumpswapLadder,
  raydiumCpSwap,
  raydiumCpSwapLadder,
} from '../../src/svm/index.js';
import type { PumpswapPoolConfig } from '../../src/svm/index.js';
import {
  buildLadder,
  ecoSwapSvm,
  efficiencyLoss,
  encodeEcoSwapSvmTrade,
  generateEcoSwapSvm,
  QL_S,
  solveOptimal,
  solveReference,
} from '../../src/recipes/ecoswap/svm/index.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from './fixtures.js';
import {
  overlayBytesMap,
  overlayLoader,
  RAYDIUM_POOL,
  synthesizePumpswapPool,
} from './ecoswap-svm.fixtures.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const rayFixtures = loadFixtures(join(FIXTURES, 'raydium-cp-swap'));
const pumpFixtures = loadFixtures(join(FIXTURES, 'pumpswap'));
const orcaFixtures = loadFixtures(join(FIXTURES, 'orca-legacy-token-swap'));

const PUMP_POOL = address('2uF4Xh61rDwxnG9woyxsVQP7zuA6kLFpb3NvnRQeoiSd');
const ORCA_POOL = address('EGZ7tiLeH62TPV1gL8WwbXGzEPa9zmcpVnnkPKKnrE2U');

/** Pure CP quote with a multiplicative ppm fee — the merge-unit test venue. */
const cpQuote = (reserveIn: bigint, reserveOut: bigint, feePpm: bigint) => (x: bigint): bigint => {
  if (x === 0n) return 0n;
  const net = x - (x * feePpm + 999_999n) / 1_000_000n;
  return (net * reserveOut) / (reserveIn + net);
};

describe('solver-reference: ladder construction', () => {
  it('grid points are amountIn >> (QL_S − j); rung capacities sum to amountIn', () => {
    const amountIn = 400_000_000n;
    const rungs = buildLadder(cpQuote(10n ** 12n, 10n ** 12n, 2500n), amountIn);
    expect(rungs).toHaveLength(QL_S);
    expect(rungs.map((r) => r.dIn)).toEqual([50_000_000n, 50_000_000n, 100_000_000n, 200_000_000n]);
    expect(rungs.reduce((sum, r) => sum + r.dIn, 0n)).toBe(amountIn);
    // Marginal price falls with fill: rung average prices strictly decrease
    // on a deep CP curve (dOut/dIn compared cross-multiplied).
    for (let j = 1; j < QL_S; j++) {
      expect(rungs[j].dOut * rungs[j - 1].dIn <= rungs[j - 1].dOut * rungs[j].dIn).toBe(true);
    }
  });

  it('dust amounts produce zero-capacity leading rungs that the merge consumes as no-ops', () => {
    const rungs = buildLadder(cpQuote(10n ** 9n, 10n ** 9n, 0n), 4n);
    expect(rungs.map((r) => r.dIn)).toEqual([0n, 1n, 1n, 2n]);
    const { slices } = solveReference([{ quote: cpQuote(10n ** 9n, 10n ** 9n, 0n) }], 4n);
    expect(slices).toEqual([4n]);
  });
});

describe('solver-reference: merge semantics', () => {
  const DEEP = 10n ** 13n;

  it('a single slot absorbs the whole amount (G_QL_S == amountIn)', () => {
    const { slices, totalPredicted } = solveReference([{ quote: cpQuote(DEEP, DEEP, 2500n) }], 123_456_789n);
    expect(slices).toEqual([123_456_789n]);
    expect(totalPredicted).toBe(cpQuote(DEEP, DEEP, 2500n)(123_456_789n));
  });

  it('two identical venues split 50/50 exactly (geometric rungs interleave)', () => {
    const quote = cpQuote(DEEP, DEEP, 2500n);
    const { slices } = solveReference([{ quote }, { quote }], 400_000_000n);
    expect(slices).toEqual([200_000_000n, 200_000_000n]);
  });

  it('slices always conserve amountIn and skew toward the deeper venue', () => {
    const amountIn = 400_000_000n;
    const { slices } = solveReference(
      [{ quote: cpQuote(2n * DEEP, 2n * DEEP, 2500n) }, { quote: cpQuote(DEEP, DEEP, 2500n) }],
      amountIn,
    );
    expect(slices[0] + slices[1]).toBe(amountIn);
    expect(slices[0] > slices[1]).toBe(true);
  });

  it('the cheaper-fee venue wins the early rungs on equal reserves', () => {
    const { slices } = solveReference(
      [{ quote: cpQuote(DEEP, DEEP, 9000n) }, { quote: cpQuote(DEEP, DEEP, 500n) }],
      1_000_000n, // tiny vs reserves: marginals barely move, the fee gap dominates
    );
    expect(slices[1]).toBe(1_000_000n);
    expect(slices[0]).toBe(0n);
  });

  it('a disabled slot is born exhausted and quotes 0', () => {
    const quote = cpQuote(DEEP, DEEP, 2500n);
    const { slices, predictedOuts } = solveReference([{ quote, enabled: false }, { quote }], 10_000_000n);
    expect(slices).toEqual([0n, 10_000_000n]);
    expect(predictedOuts[0]).toBe(0n);
  });

  it('throws the "fill" mirror when no slot is enabled', () => {
    const quote = cpQuote(DEEP, DEEP, 2500n);
    expect(() => solveReference([{ quote, enabled: false }], 1_000_000n)).toThrow(/fill/);
  });
});

describe('ladder adapters: referenceQuote vs the svm-venues.md pins and the v1 mirrors', () => {
  it('raydium-cp-swap: fixture pool quotes the pinned 1e6 -> 81_443 and tracks the v1 mirror', async () => {
    const cfg = await raydiumCpSwap.fetchPoolConfig(fixtureLoader(rayFixtures), RAYDIUM_POOL);
    const state = fixtureBytesMap(rayFixtures);
    const params = raydiumCpSwapLadder.paramsFor(cfg);
    expect(params).toEqual([0n]); // fixture pool: creator fee disabled
    const quote = raydiumCpSwapLadder.referenceQuote(cfg, state, params);

    expect(quote(1_000_000n)).toBe(81_443n); // docs/svm-venues.md pin
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const x of [1_000_000n, 50_000_000n, 400_000_000n, 1_000_000_000n]) {
      expect(quote(x)).toBe(raydiumCpSwap.referenceQuote(cfg, state, x, now));
    }
    expect(quote(0n)).toBe(0n);
  });

  it('pumpswap: fixture pool quotes the pinned buy 1e9 -> 632_706_768_908 and sell 50e9 -> 78_539_874', async () => {
    const load = fixtureLoader(pumpFixtures);
    const state = fixtureBytesMap(pumpFixtures);
    const buyCfg = await pumpswapAdapter.fetchPoolConfig(load, PUMP_POOL);
    const params = pumpswapLadder.paramsFor(buyCfg);
    expect(params).toEqual([25n, 5n, 0n]); // non-canonical flat fees, creator zeroed

    expect(pumpswapLadder.referenceQuote(buyCfg, state, params)(1_000_000_000n)).toBe(632_706_768_908n);
    const sellCfg: PumpswapPoolConfig = { ...buyCfg, direction: 'baseToQuote' };
    expect(pumpswapLadder.referenceQuote(sellCfg, state, params)(50_000_000_000n)).toBe(78_539_874n);
    // parity with the independently-derived v1 mirror on both directions
    const now = 0n;
    for (const x of [1_000_000_000n, 5_000_000_000n]) {
      expect(pumpswapLadder.referenceQuote(buyCfg, state, params)(x)).toBe(
        pumpswapAdapter.referenceQuote(buyCfg, state, x, now),
      );
      expect(pumpswapLadder.referenceQuote(sellCfg, state, params)(x)).toBe(
        pumpswapAdapter.referenceQuote(sellCfg, state, x, now),
      );
    }
  });

  it('orca-legacy-token-swap: the pinned 1 SOL / 10 SOL / dust vectors, 0 where the venue throws', async () => {
    const cfg = await orcaLegacyTokenSwap.fetchPoolConfig(fixtureLoader(orcaFixtures), ORCA_POOL);
    const state = fixtureBytesMap(orcaFixtures);
    const params = orcaLegacyTokenSwapLadder.paramsFor(cfg);
    expect(params).toEqual([25n, 10_000n, 5n, 10_000n]);
    const quote = orcaLegacyTokenSwapLadder.referenceQuote(cfg, state, params);

    expect(quote(1_000_000_000n)).toBe(81_330_481n); // docs/svm-venues.md pins
    expect(quote(10_000_000_000n)).toBe(812_849_439n);
    expect(quote(1000n)).toBe(81n);
    expect(quote(0n)).toBe(0n);
    expect(quote(2n)).toBe(0n); // fees swallow the input where the venue would throw
  });
});

describe('optimal.ts: continuous water-fill oracle', () => {
  const DEEP = 10n ** 13n;

  it('two identical venues split within rounding of 50/50 and beat the single-venue quote', () => {
    const quote = cpQuote(DEEP, DEEP, 2500n);
    const venue = { reserveIn: DEEP, reserveOut: DEEP, gammaPpm: 997_500n, muPpm: 1_000_000n, quote };
    const amountIn = 400_000_000n;
    const { slices, totalOut } = solveOptimal([venue, { ...venue }], amountIn);
    expect(slices[0] + slices[1]).toBe(amountIn);
    expect(slices[0] - slices[1] < 4n && slices[1] - slices[0] < 4n).toBe(true);
    expect(totalOut > quote(amountIn)).toBe(true);
  });

  it('drops a venue whose spot marginal never reaches the water level', () => {
    // Venue 1 is 100x shallower AND 9x costlier: for a small trade the
    // optimum is a single-venue fill.
    const amountIn = 1_000_000n;
    const { slices } = solveOptimal(
      [
        { reserveIn: DEEP, reserveOut: DEEP, gammaPpm: 999_500n, muPpm: 1_000_000n, quote: cpQuote(DEEP, DEEP, 500n) },
        {
          reserveIn: DEEP / 100n,
          reserveOut: DEEP / 200n,
          gammaPpm: 991_000n,
          muPpm: 1_000_000n,
          quote: cpQuote(DEEP / 100n, DEEP / 200n, 9000n),
        },
      ],
      amountIn,
    );
    expect(slices).toEqual([amountIn, 0n]);
  });

  it('quantized ladder loses under 1% vs the continuous optimum on the fixture-scale pair', () => {
    // The 2-venue same-pair universe of the e2e suite: the raydium fixture
    // reserves vs the synthesized deeper pump pool.
    const venues = [
      {
        reserveIn: 1_771_691_202n,
        reserveOut: 144_736_343n,
        gammaPpm: 997_500n,
        muPpm: 1_000_000n,
        quote: cpQuote(1_771_691_202n, 144_736_343n, 2500n),
      },
      {
        reserveIn: 3_200_000_000n,
        reserveOut: 262_000_000n,
        gammaPpm: 997_000n,
        muPpm: 1_000_000n,
        quote: cpQuote(3_200_000_000n, 262_000_000n, 3000n),
      },
    ];
    const amountIn = 400_000_000n;
    const optimal = solveOptimal(venues, amountIn);
    const quantized = solveReference(venues.map((v) => ({ quote: v.quote })), amountIn);
    const loss = efficiencyLoss(optimal.totalOut, quantized.totalPredicted);
    // Measured ~1e-5 on this state; the bound is deliberately loose.
    expect(loss).toBeLessThan(0.01);
    expect(loss).toBeGreaterThan(-0.005);
  });
});

describe('codegen: shape contract', () => {
  const user = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };

  it('compiles the 2-slot raydium+pumpswap shape; packed cfg = 8 u64 words; plan carries the slot roles', async () => {
    const synth = synthesizePumpswapPool(3_200_000_000n, 262_000_000n);
    const load = overlayLoader([...rayFixtures, ...pumpFixtures], [synth]);
    const rayCfg = await raydiumCpSwap.fetchPoolConfig(load, RAYDIUM_POOL);
    const pumpCfg: PumpswapPoolConfig = {
      ...(await pumpswapAdapter.fetchPoolConfig(load, synth.pool)),
      direction: 'baseToQuote',
    };

    const generated = generateEcoSwapSvm({
      slots: [
        { adapter: raydiumCpSwapLadder, cfg: rayCfg },
        { adapter: pumpswapLadder, cfg: pumpCfg },
      ],
      user,
    });

    // [amountIn][minOut] + slot0 [enable][crMode] + slot1 [enable][lp][prot][cr]
    expect(generated.cfgByteLength).toBe(8 * 8);
    expect(generated.argsLayout.slots).toEqual([{ arg: 0, kind: 'bytes', offset: 0, length: 64 }]);
    expect(generated.shapeKey).toBe('raydium-cp-swap:0to1|pumpswap:baseToQuote');
    expect(generated.bytecode.length).toBeLessThan(65_535);

    const refs = generated.accountPlan.metas.map((m) => m.ref);
    for (const expected of ['s0:pool', 's0:cfg', 's0:vin', 's0:vout', 's0:prog', 's1:bvault', 's1:qvault', 's1:prog', 'user:out']) {
      expect(refs).toContain(expected);
    }
    // adapter-resolved refs are stamped; user refs stay open
    const byRef = new Map(generated.accountPlan.metas.map((m) => [m.ref, m]));
    expect(byRef.get('s0:pool')!.pubkey).toBe(RAYDIUM_POOL);
    expect(byRef.get('s1:bvault')!.pubkey).toBe(synth.baseVault);
    expect(byRef.get('user:out')!.pubkey).toBeUndefined();
  });

  it('the blob is shape-stable: a different pool set of the same shape compiles byte-identically', async () => {
    const build = async () => {
      const synth = synthesizePumpswapPool(5_000_000_000n, 410_000_000n);
      const load = overlayLoader([...rayFixtures, ...pumpFixtures], [synth]);
      const rayCfg = await raydiumCpSwap.fetchPoolConfig(load, RAYDIUM_POOL);
      const pumpCfg: PumpswapPoolConfig = {
        ...(await pumpswapAdapter.fetchPoolConfig(load, synth.pool)),
        direction: 'baseToQuote',
      };
      return generateEcoSwapSvm({
        slots: [
          { adapter: raydiumCpSwapLadder, cfg: rayCfg },
          { adapter: pumpswapLadder, cfg: pumpCfg },
        ],
        user,
      });
    };
    const a = await build();
    const b = await build(); // fresh random pool/vault addresses, same shape
    expect(Buffer.from(a.bytecode).toString('hex')).toBe(Buffer.from(b.bytecode).toString('hex'));
    expect(a.shapeKey).toBe(b.shapeKey);
  });

  it('encodeEcoSwapSvmTrade packs u64 LE words in slot order', () => {
    const hex = encodeEcoSwapSvmTrade(
      [{ params: [2n] }, { params: [25n, 5n, 0n], enabled: false }],
      0x0102030405n,
      1n,
    );
    const bytes = Buffer.from(hex.slice(2), 'hex');
    expect(bytes.length).toBe(8 * 8);
    expect(bytes.readBigUInt64LE(0)).toBe(0x0102030405n);
    expect(bytes.readBigUInt64LE(8)).toBe(1n);
    expect(bytes.readBigUInt64LE(16)).toBe(1n); // slot0 enabled (default)
    expect(bytes.readBigUInt64LE(24)).toBe(2n); // crMode
    expect(bytes.readBigUInt64LE(32)).toBe(0n); // slot1 disabled
    expect(bytes.readBigUInt64LE(40)).toBe(25n);
  });

  it('ecoSwapSvm end-to-end prepare: gates, depth filter, quote and trade encodings agree', async () => {
    const synth = synthesizePumpswapPool(3_200_000_000n, 262_000_000n);
    const dust = synthesizePumpswapPool(3_200_000n, 262_000n); // 1000x shallower: dropped at 1%
    const load = overlayLoader([...rayFixtures, ...pumpFixtures], [synth, dust]);
    const amountIn = 400_000_000n;

    const output = await ecoSwapSvm({
      amountIn,
      minOut: 1n,
      pools: [
        { venue: 'raydium-cp-swap', pool: RAYDIUM_POOL },
        { venue: 'pumpswap', pool: synth.pool, direction: 'baseToQuote' },
        { venue: 'pumpswap', pool: dust.pool, direction: 'baseToQuote' },
      ],
      user,
      load,
    });

    expect(output.slots.map((s) => s.pool)).toEqual([RAYDIUM_POOL, synth.pool]);
    expect(output.quote.dropped.map((d) => d.pool)).toEqual([dust.pool]);
    expect(output.quote.slices[0] + output.quote.slices[1]).toBe(amountIn);
    expect(output.quote.slices.every((slice) => slice > 0n)).toBe(true);
    expect(output.argValues).toEqual(output.encodeTrade(amountIn, 1n));

    // The quote mirrors the reference solve over the same fetch-time bytes.
    const state = overlayBytesMap([...rayFixtures, ...pumpFixtures], [synth]);
    const rayCfg = await raydiumCpSwap.fetchPoolConfig(load, RAYDIUM_POOL);
    const pumpCfg: PumpswapPoolConfig = {
      ...(await pumpswapAdapter.fetchPoolConfig(load, synth.pool)),
      direction: 'baseToQuote',
    };
    const expected = solveReference(
      [
        { quote: raydiumCpSwapLadder.referenceQuote(rayCfg, state, output.slots[0].params) },
        { quote: pumpswapLadder.referenceQuote(pumpCfg, state, output.slots[1].params) },
      ],
      amountIn,
    );
    expect(output.quote.slices).toEqual(expected.slices);
    expect(output.quote.totalPredicted).toBe(expected.totalPredicted);
  });
});
