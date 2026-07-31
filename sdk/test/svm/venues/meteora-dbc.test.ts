/**
 * meteora-dbc venue adapter + ladder units, validated against REAL mainnet
 * pool state at three or more sizes per direction, cross-checked
 * lamport-for-lamport against the OFFICIAL `@meteora-ag/
 * dynamic-bonding-curve-sdk`'s `swapQuoteExactIn` (an independent,
 * Meteora-authored implementation) run on the SAME decoded bytes — not a
 * self-consistency check against our own math.
 *
 * Fixtures (test/svm/fixtures/meteora-dbc/, real mainnet dumps):
 *  - 5HXw3UDdd9n6aNsiPCNkB23JJBAZv3qSMf11oiJxL5z8 / config D5JsQBRqbTprBZCPGERxVjFeg1jn6ZECGhgShX36r3E6
 *    — static fee (cliff_fee_numerator = 20_000_000 = 2%, period_frequency
 *    = 0, dynamic fee disabled), single active segment (segIdx 0), live
 *    sqrt_price sits inside [sqrt_start_price, curve[0].sqrt_price].
 *  - 2kYZa4r6LD7qoBhbKQxFb3XmGkezD1AxSUccWFt7zcib / config AH3FPZicRqHcBCyUDsBD8oD8PiCAcpEWgtjfN1aqUAHu
 *    — an ARMED linear fee scheduler (period_frequency = 30, number_of_period
 *    = 10, reduction_factor = 4_000_000, cliff = 50_000_000) fully decayed
 *    to its floor (10_000_000 = 1%) at any `now` far past
 *    activation_point + 300s (pinned NOW below), PLUS a live dynamic
 *    (volatility) fee contributing +395_062 on top — both combined and
 *    exercised at once.
 *
 * The expected numbers below were computed by feeding the SAME decoded
 * account bytes into the official SDK's `swapQuoteExactIn` (see the PR
 * description / commit message for the exact script) — this is NOT a
 * regression pin invented from our own implementation.
 */
import { resolve } from 'path';
import { address } from '@solana/kit';
import { compile } from '@eco-incorp/sauce-compiler';
import { meteoraDbc } from '../../../src/svm/venues/meteora-dbc/index.js';
import type { MeteoraDbcPoolConfig } from '../../../src/svm/venues/meteora-dbc/index.js';
import { meteoraDbcLadder } from '../../../src/svm/venues/meteora-dbc/ladder.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';

const FIXTURES = resolve(process.cwd(), 'test/svm/fixtures/meteora-dbc');
const STATIC_POOL = address('5HXw3UDdd9n6aNsiPCNkB23JJBAZv3qSMf11oiJxL5z8');
const SCHEDULED_POOL = address('2kYZa4r6LD7qoBhbKQxFb3XmGkezD1AxSUccWFt7zcib');
/** Safely far past both fixtures' activation_point + max schedule duration — deterministic forever. */
const NOW = 2_000_000_000n;

const fixtures = loadFixtures(FIXTURES);
const load = fixtureLoader(fixtures);
const state = fixtureBytesMap(fixtures);

const bi = (x: bigint): string => x.toString();

async function fetch(pool: ReturnType<typeof address>): Promise<MeteoraDbcPoolConfig> {
  return meteoraDbc.fetchPoolConfig(load, pool) as Promise<MeteoraDbcPoolConfig>;
}

describe('meteora-dbc: fetchPoolConfig decode', () => {
  it('static-fee pool: segIdx 0, single active segment, direction defaults quoteToBase', async () => {
    const cfg = await fetch(STATIC_POOL);
    expect(cfg.segIdx).toBe(0);
    expect(cfg.curveLength).toBe(2);
    expect(cfg.direction).toBe('quoteToBase');
    expect(cfg.quoteMint).toBe(address('So11111111111111111111111111111111111111112'));
  });

  it('scheduled+dynamic-fee pool: also segIdx 0', async () => {
    const cfg = await fetch(SCHEDULED_POOL);
    expect(cfg.segIdx).toBe(0);
  });
});

describe('meteora-dbc: v1 adapter referenceQuote matches the official SDK on real mainnet state', () => {
  it('quoteToBase (buying): 1 / 5 / 20 SOL, static 2% fee', async () => {
    const cfg = await fetch(STATIC_POOL);
    const expected: [bigint, bigint][] = [
      [1_000_000_000n, 18_643_953_491_788_332n],
      [5_000_000_000n, 86_357_294_065_213_210n],
      [20_000_000_000n, 270_699_732_078_262_432n],
    ];
    for (const [amountIn, out] of expected) {
      expect(bi(meteoraDbc.referenceQuote(cfg, state, amountIn, NOW))).toBe(bi(out));
    }
  });

  it('baseToQuote (selling): three sizes, static 2% fee', async () => {
    const cfg = await fetch(STATIC_POOL);
    const sellCfg: MeteoraDbcPoolConfig = { ...cfg, direction: 'baseToQuote' };
    const expected: [bigint, bigint][] = [
      [100_000_000_000_000n, 5_048_391n],
      [500_000_000_000_000n, 25_231_207n],
      [2_000_000_000_000_000n, 100_763_860n],
      [5_000_000_000_000_000n, 251_108_635n],
    ];
    for (const [amountIn, out] of expected) {
      expect(bi(meteoraDbc.referenceQuote(sellCfg, state, amountIn, NOW))).toBe(bi(out));
    }
  });

  it('quoteToBase with a LIVE decayed linear scheduler + a live dynamic (volatility) fee combined', async () => {
    const cfg = await fetch(SCHEDULED_POOL);
    const expected: [bigint, bigint][] = [
      [1_000_000_000n, 30_939_797_922_437n],
      [5_000_000_000n, 142_126_901_729_869n],
      [20_000_000_000n, 435_719_730_624_801n],
    ];
    for (const [amountIn, out] of expected) {
      expect(bi(meteoraDbc.referenceQuote(cfg, state, amountIn, NOW))).toBe(bi(out));
    }
  });
});

describe('meteora-dbc ladder: matches the v1 adapter exactly (same math, live-read parametric form)', () => {
  it('quoteToBase, static-fee pool', async () => {
    const cfg = await fetch(STATIC_POOL);
    const ladderQuote = meteoraDbcLadder.referenceQuote(cfg, state, [], NOW);
    for (const amountIn of [1_000_000_000n, 5_000_000_000n, 20_000_000_000n]) {
      expect(bi(ladderQuote(amountIn))).toBe(bi(meteoraDbc.referenceQuote(cfg, state, amountIn, NOW)));
    }
  });

  it('baseToQuote, static-fee pool', async () => {
    const cfg = await fetch(STATIC_POOL);
    const sellCfg: MeteoraDbcPoolConfig = { ...cfg, direction: 'baseToQuote' };
    const ladderQuote = meteoraDbcLadder.referenceQuote(sellCfg, state, [], NOW);
    for (const amountIn of [100_000_000_000_000n, 500_000_000_000_000n, 2_000_000_000_000_000n]) {
      expect(bi(ladderQuote(amountIn))).toBe(bi(meteoraDbc.referenceQuote(sellCfg, state, amountIn, NOW)));
    }
  });

  it('scheduled+dynamic-fee pool', async () => {
    const cfg = await fetch(SCHEDULED_POOL);
    const ladderQuote = meteoraDbcLadder.referenceQuote(cfg, state, [], NOW);
    for (const amountIn of [1_000_000_000n, 5_000_000_000n, 20_000_000_000n]) {
      expect(bi(ladderQuote(amountIn))).toBe(bi(meteoraDbc.referenceQuote(cfg, state, amountIn, NOW)));
    }
  });
});

describe('meteora-dbc: capacity clamp SATURATES at the segment/migration boundary, never collapses to 0', () => {
  it('quoteToBase: quote(0) == 0, nondecreasing, and saturates past the segment capacity instead of collapsing', async () => {
    const cfg = await fetch(STATIC_POOL);
    const quote = meteoraDbcLadder.referenceQuote(cfg, state, [], NOW);
    const capacities = meteoraDbcLadder.referenceCapacities!(cfg, state, [], NOW);
    // Two wildly different oversized grid points both clamp to the SAME true
    // capacity — referenceCapacities is a pure min(g, C), not a running max.
    const capBig = capacities([1_000_000_000_000n])[0]!;
    expect(bi(capacities([1n << 62n])[0]!)).toBe(bi(capBig));
    expect(bi(quote(0n))).toBe(bi(0n));

    let prev = -1n;
    const grid = [0n, 1n, 1_000n, 1_000_000_000n, 5_000_000_000n, 20_000_000_000n, capBig, capBig + 1n, 2n * capBig, 1_000_000_000_000n];
    for (const x of grid) {
      const q = quote(x);
      expect(q).toBeGreaterThanOrEqual(prev);
      prev = q;
    }
    // Never collapses to 0 for a huge x once the pool has ANY capacity.
    expect(quote(1_000_000_000_000n)).toBeGreaterThan(0n);
    expect(quote(1_000_000_000_000n)).toBe(quote(capBig));
  });

  it('baseToQuote: same saturating shape', async () => {
    const cfg = await fetch(STATIC_POOL);
    const sellCfg: MeteoraDbcPoolConfig = { ...cfg, direction: 'baseToQuote' };
    const quote = meteoraDbcLadder.referenceQuote(sellCfg, state, [], NOW);
    let prev = -1n;
    const grid = [0n, 1n, 1_000_000n, 100_000_000_000_000n, 2_000_000_000_000_000n, 50_000_000_000_000_000n, 500_000_000_000_000_000n];
    for (const x of grid) {
      const q = quote(x);
      expect(q).toBeGreaterThanOrEqual(prev);
      prev = q;
    }
    expect(quote(500_000_000_000_000_000n)).toBeGreaterThan(0n);
  });
});

describe('meteora-dbc: not-yet-activated fee scheduler zeroes the quote instead of promising a fill the real program would revert on', () => {
  it('a synthetic pool whose activation_point is in the future quotes 0 at every size', async () => {
    const cfg = await fetch(SCHEDULED_POOL);
    // Force `now` BEFORE activation_point (real activation_point = 1_770_914_811).
    const beforeActivation = 1n;
    const quote = meteoraDbcLadder.referenceQuote(cfg, state, [], beforeActivation);
    expect(bi(quote(1_000_000_000n))).toBe(bi(0n));
    expect(bi(quote(1_000_000_000_000n))).toBe(bi(0n));
  });
});

describe('meteora-dbc: the ladder fragment compiles as valid SauceScript', () => {
  it.each(['quoteToBase', 'baseToQuote'] as const)('%s: helpers + emitSetup + two ladder rungs + emitFinalQuote', async (direction) => {
    const base = await fetch(STATIC_POOL);
    const cfg: MeteoraDbcPoolConfig = { ...base, direction };
    const source = [
      ...meteoraDbcLadder.helpers(cfg).map((h) => h.source),
      'function main() {',
      meteoraDbcLadder.emitSetup(cfg, 0),
      meteoraDbcLadder.emitLadderQuote!(cfg, 0, 0, '1000000000', 's0o1'),
      meteoraDbcLadder.emitLadderQuote!(cfg, 0, 1, '5000000000', 's0o2'),
      meteoraDbcLadder.emitFinalQuote!(cfg, 0, '2000000000', 'qFinal'),
      '  return qFinal;',
      '}',
    ].join('\n');
    const { bytecode, accountPlan } = compile(source, { target: 'svm' });
    expect(bytecode[0]!.length).toBeGreaterThan(0);
    expect(accountPlan?.metas.map((m) => m.ref).sort()).toEqual(['s0:pool', 's0:config'].sort());
  });
});

describe('meteora-dbc: buildSwapV2 account order + discriminator', () => {
  it('emits the swap discriminator, patches "in", and attaches 15 accounts in the documented order', async () => {
    const cfg = await fetch(STATIC_POOL);
    const user = { inAta: 'user:in', outAta: 'user:out', owner: 'payer' };
    const tpl = meteoraDbcLadder.buildSwapV2(cfg, 0, user);
    expect(tpl.patch).toBe('in');
    expect([...tpl.prefix]).toEqual([248, 198, 158, 145, 225, 117, 135, 200]);
    expect([...tpl.suffix]).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(tpl.accounts).toHaveLength(15);
    expect(tpl.accounts.map((a) => a.ref)).toEqual([
      's0:auth',
      's0:cfg',
      's0:pool',
      'user:in',
      'user:out',
      's0:bv',
      's0:qv',
      's0:bm',
      's0:qm',
      'payer',
      's0:tbp',
      's0:tqp',
      's0:prog',
      's0:evt',
      's0:prog',
    ]);
    expect(tpl.accounts[2]!.writable).toBe(true); // pool
    expect(tpl.accounts[9]!.signer).toBe(true); // owner
  });
});
