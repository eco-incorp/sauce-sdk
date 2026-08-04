/**
 * Metric venue adapter units (no engine, no RPC-at-test-time): fetchPoolConfig against a REAL
 * mainnet fixture (pool G5B2Ws2DKattHTm75AoANWCpbQ48R9n8ZJur42RLYRYF, USDC/USDT) with a stubbed
 * `fetchOracleQuote` returning REAL, live-measured oracle CPI return data (captured
 * 2026-08-03 via a standalone `simulateTransaction` against the deployed oracle program — see
 * index.ts's module doc), the refuse-don't-guess gate when it is omitted, the scale/cap math in
 * `referenceQuote`, and that the emitted fragment actually compiles as valid SauceScript on the
 * 'svm' target (the CPI-in-emitSetup shape is novel in this tree — see ladder.ts's module doc).
 */
import { resolve } from 'path';
import { compile } from '@eco-incorp/sauce-compiler';
import { metric } from '../../../src/svm/venues/metric/index.js';
import type { MetricPoolConfig } from '../../../src/svm/venues/metric/index.js';
import { metricLadder } from '../../../src/svm/venues/metric/ladder.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';
import { address } from '@solana/kit';

const FIXTURES = resolve(process.cwd(), 'test/svm/fixtures/metric');
const POOL = address('G5B2Ws2DKattHTm75AoANWCpbQ48R9n8ZJur42RLYRYF');

// Real 32-byte oracle CPI return data captured live (bid, then ask — u128 LE halves), against the
// SAME ground-truth (oracleConfig, priceAccount) pair the fixture's pool resolves to.
const REAL_BID = 18461132534087045066n; // /2^64 ~= 1.00078
const REAL_ASK = 18461317001527782162n; // /2^64 ~= 1.00079
function realOracleQuoteBytes(): Uint8Array {
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, REAL_BID & 0xffffffffffffffffn, true);
  view.setBigUint64(8, REAL_BID >> 64n, true);
  view.setBigUint64(16, REAL_ASK & 0xffffffffffffffffn, true);
  view.setBigUint64(24, REAL_ASK >> 64n, true);
  return out;
}

describe('metric.fetchPoolConfig', () => {
  it('decodes the real pool topology and bakes the supplied oracle quote', async () => {
    const fixtures = loadFixtures(FIXTURES);
    const load = fixtureLoader(fixtures);
    const cfg = await metric.fetchPoolConfig(load, POOL, 0, async () => realOracleQuoteBytes());

    expect(cfg.mintA).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC
    expect(cfg.mintB).toBe('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'); // USDT
    expect(cfg.decimalsA).toBe(6);
    expect(cfg.decimalsB).toBe(6);
    expect(cfg.oracleConfig).toBe('BHqHqvdiW9WQPgYkkxcpHicM5zS8czHn7tLdHs23tGxb');
    expect(cfg.priceAccount).toBe('BubYekVVTtbTuVsAtptiAZV4rpPQNFyBs3THPSGJgk6a');
    expect(cfg.bidQ64).toBe(REAL_BID);
    expect(cfg.askQ64).toBe(REAL_ASK);
    expect(cfg.bakedPrice).toBe(REAL_BID); // direction 0 bakes bid

    // Independently derived (not via metricScaleParams): equal decimals -> scale == bid/2^64, gcd-reduced.
    const g = gcd(REAL_BID, 1n << 64n);
    expect(cfg.scaleNum).toBe(REAL_BID / g);
    expect(cfg.scaleDen).toBe((1n << 64n) / g);
  });

  it('direction 1 bakes the ask and the exact reciprocal scale', async () => {
    const fixtures = loadFixtures(FIXTURES);
    const load = fixtureLoader(fixtures);
    const cfg = await metric.fetchPoolConfig(load, POOL, 1, async () => realOracleQuoteBytes());
    expect(cfg.bakedPrice).toBe(REAL_ASK);
    const g = gcd(1n << 64n, REAL_ASK);
    expect(cfg.scaleNum).toBe((1n << 64n) / g);
    expect(cfg.scaleDen).toBe(REAL_ASK / g);
  });

  it('throws (refuse, do not guess) when fetchOracleQuote is not supplied', async () => {
    const fixtures = loadFixtures(FIXTURES);
    const load = fixtureLoader(fixtures);
    await expect(metric.fetchPoolConfig(load, POOL)).rejects.toThrow(
      /has no fetchOracleQuote supplied/,
    );
  });

  it('throws when the oracle quote callback returns the wrong length', async () => {
    const fixtures = loadFixtures(FIXTURES);
    const load = fixtureLoader(fixtures);
    await expect(
      metric.fetchPoolConfig(load, POOL, 0, async () => new Uint8Array(16)),
    ).rejects.toThrow(/expected 32/);
  });
});

describe('metricLadder.referenceQuote', () => {
  it('quotes proportional to the baked scale, capped at reserveOut / CAP_DIVISOR', async () => {
    const fixtures = loadFixtures(FIXTURES);
    const load = fixtureLoader(fixtures);
    const state = fixtureBytesMap(fixtures);
    const cfg: MetricPoolConfig = await metric.fetchPoolConfig(load, POOL, 0, async () => realOracleQuoteBytes());
    const params = metricLadder.paramsFor(cfg);
    const quote = metricLadder.referenceQuote(cfg, state, params);

    expect(quote(0n)).toBe(0n);
    const small = 1_000_000n; // 1 USDC (6dp)
    expect(quote(small)).toBe((small * cfg.scaleNum) / cfg.scaleDen);

    // Cap: reserveOut (vaultB) from the real fixture / CAP_DIVISOR.
    const vaultB = fixtureBytesMap(fixtures)[cfg.vaultB];
    const reserveOut = readU64LE(vaultB, 64);
    const cap = reserveOut / 20n;
    const huge = 10n ** 15n;
    expect(quote(huge)).toBe(cap);
  });
});

describe('the emitted fragment compiles as valid SauceScript (svm target)', () => {
  it('emitSetup + one rung + a second (disabled) slot compiles, with the expected account plan', async () => {
    const fixtures = loadFixtures(FIXTURES);
    const load = fixtureLoader(fixtures);
    const cfg: MetricPoolConfig = await metric.fetchPoolConfig(load, POOL, 0, async () => realOracleQuoteBytes());
    const params = metricLadder.paramsFor(cfg).map((v) => v.toString());
    const helpers = metricLadder.helpers().map((h) => h.source).join('\n');
    const source = [
      helpers,
      'function main() {',
      '  let s0en = 1;',
      metricLadder.emitSetup(cfg, 0, params, 's0en'),
      `  const q1 = ${metricLadder.emitQuoteCall(cfg, 0, '100000')};`,
      `  const q2 = ${metricLadder.emitQuoteCall(cfg, 0, '5000000')};`,
      '  return q1 + q2;',
      '}',
    ].join('\n');
    const { bytecode, accountPlan } = compile(source, { target: 'svm' });
    expect(bytecode[0].length).toBeGreaterThan(0);
    const refs = accountPlan?.metas.map((m) => m.ref).sort() ?? [];
    expect(refs).toEqual(['s0:oracleConfig', 's0:oracleProg', 's0:price', 's0:vout'].sort());
  });

  it('a disabled slot (enable=0) skips the CPI account plan entries at runtime but still compiles', async () => {
    const fixtures = loadFixtures(FIXTURES);
    const load = fixtureLoader(fixtures);
    const cfg: MetricPoolConfig = await metric.fetchPoolConfig(load, POOL, 0, async () => realOracleQuoteBytes());
    const params = metricLadder.paramsFor(cfg).map((v) => v.toString());
    const helpers = metricLadder.helpers().map((h) => h.source).join('\n');
    const source = [
      helpers,
      'function main() {',
      '  let s0en = 0;',
      metricLadder.emitSetup(cfg, 0, params, 's0en'),
      `  return ${metricLadder.emitQuoteCall(cfg, 0, '100000')};`,
      '}',
    ].join('\n');
    const { bytecode } = compile(source, { target: 'svm' });
    expect(bytecode[0].length).toBeGreaterThan(0);
  });
});

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i]);
  return v;
}
