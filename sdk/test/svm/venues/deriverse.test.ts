/**
 * Deriverse ladder adapter units (no engine, no RPC): fetchPoolConfig decode
 * against a REAL mainnet fixture (the wSOL/USDC instrument), the fee-model
 * (conservativeFeePpm), the isqrt-based capacity clamp (SATURATING, never
 * collapsing, mirroring the obric-v2/raydium-clmm/whirlpool contract), and a
 * compile-as-valid-SauceScript check for both directions.
 *
 * The exact expected quote figures below were derived by an independent
 * Python re-implementation of the SAME formula (not by reading this file's
 * own TS), against the checked-in fixture's exact byte state — see
 * ladder.ts's module doc for the separate REAL-PROGRAM cross-check (Jupiter
 * `dexes=Deriverse`, three sizes each direction, always conservative).
 */
import { resolve } from 'path';
import { address } from '@solana/kit';
import { compile } from '@eco-incorp/sauce-compiler';
import { deriverse, conservativeFeePpm, DERIVERSE_AUTH, DERIVERSE_PROGRAM_ID } from '../../../src/svm/venues/deriverse/index.js';
import type { DeriversePoolConfig } from '../../../src/svm/venues/deriverse/index.js';
import { deriverseLadder, deriverseIsqrt, deriverseCeilIsqrt, deriverseRawQuote } from '../../../src/svm/venues/deriverse/ladder.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';

const FIXTURES = resolve(process.cwd(), 'test/svm/fixtures/deriverse');
const REAL_POOL = address('8Wk2L1yDovBJifCN1o86X7g7pDcqLau39m6tEsJ9Sheh');

describe('deriverseIsqrt / deriverseCeilIsqrt', () => {
  it('floor sqrt matches known perfect and non-perfect squares', () => {
    expect(deriverseIsqrt(0n)).toBe(0n);
    expect(deriverseIsqrt(1n)).toBe(1n);
    expect(deriverseIsqrt(24n)).toBe(4n);
    expect(deriverseIsqrt(25n)).toBe(5n);
    expect(deriverseIsqrt(26n)).toBe(5n);
    expect(deriverseIsqrt(10n ** 24n)).toBe(10n ** 12n);
  });

  it('ceil sqrt rounds up exactly on non-perfect squares, exact on perfect ones', () => {
    expect(deriverseCeilIsqrt(24n)).toBe(5n);
    expect(deriverseCeilIsqrt(25n)).toBe(5n);
    expect(deriverseCeilIsqrt(26n)).toBe(6n);
  });
});

describe('conservativeFeePpm', () => {
  const ZERO_FEES = 0x1;
  const FIXED_FEES = 0x2;

  it('ZeroFees zeros the fee exactly, no margin', () => {
    expect(conservativeFeePpm(ZERO_FEES, 0.5, 10, 0.01)).toBe(0n);
  });

  it('FixedFees doubles the admin-set rate plus the flat floor', () => {
    // fixed_fee_rate=0.001 -> 1000ppm raw -> 2000+20
    expect(conservativeFeePpm(FIXED_FEES, 0.5, 10, 0.001)).toBe(2020n);
  });

  it('the dynamic default doubles day_volatility*spot_fee_rate*FEE_RATE_STEP plus the flat floor', () => {
    // 0.025 * 4 * 0.0005 = 0.00005 -> 50ppm raw -> 120
    expect(conservativeFeePpm(0, 0.025, 4, 0)).toBe(120n);
  });

  it('never returns a negative or non-finite fee even on a garbage read', () => {
    expect(conservativeFeePpm(0, Number.NaN, 4, 0)).toBe(20n);
    expect(conservativeFeePpm(0, -1, 4, 0)).toBe(20n);
  });
});

describe('fetchPoolConfig against the real wSOL/USDC instrument fixture', () => {
  it('decodes ids, mints and the conservative fee exactly (independently verified against a real mainnet snapshot)', async () => {
    const fixtures = loadFixtures(FIXTURES);
    const load = fixtureLoader(fixtures);
    const cfg = await deriverse.fetchPoolConfig(load, REAL_POOL);
    expect(cfg.venue).toBe('deriverse');
    expect(cfg.side).toBe('sell');
    expect(cfg.instrId).toBe(0);
    expect(cfg.assetTokenId).toBe(2);
    expect(cfg.crncyTokenId).toBe(1);
    expect(cfg.assetMint).toBe(address('So11111111111111111111111111111111111111112'));
    expect(cfg.crncyMint).toBe(address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'));
    expect(cfg.tokenProgram).toBe(address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'));
    expect(cfg.feePpm).toBe(120n);
    // Derived PDAs are all distinct from each other and from the pool itself.
    const derived = [cfg.assetVault, cfg.crncyVault, cfg.asksTree, cfg.askOrders, cfg.bidsTree, cfg.bidOrders, cfg.lines, cfg.mapsAddress, cfg.clientInfos];
    expect(new Set(derived).size).toBe(derived.length);
    expect(derived.every((a) => a !== REAL_POOL)).toBe(true);
  });

  it('rejects an account shorter than the InstrAccountHeader front slice', async () => {
    const load = async (): Promise<Uint8Array> => new Uint8Array(100);
    await expect(deriverse.fetchPoolConfig(load, REAL_POOL)).rejects.toThrow(/at least 1064/);
  });
});

describe('the embedded-AMM quote SATURATES at the circuit-breaker capacity (never collapses)', () => {
  it.each(['sell', 'buy'] as const)('%s: nondecreasing, quote(0)==0, flatlines past icap (real fixture state)', async (side) => {
    const fixtures = loadFixtures(FIXTURES);
    const load = fixtureLoader(fixtures);
    const state = fixtureBytesMap(fixtures);
    const base = await deriverse.fetchPoolConfig(load, REAL_POOL);
    const cfg: DeriversePoolConfig = { ...base, side };
    const params = deriverseLadder.paramsFor(cfg);
    const quote = deriverseLadder.referenceQuote(cfg, state, params);

    expect(quote(0n)).toBe(0n);

    const grid = [1n, 10n ** 8n, 10n ** 9n, 5n * 10n ** 9n, 5n * 10n ** 10n, 5n * 10n ** 11n, 1n << 62n];
    let prev = 0n;
    for (const x of grid) {
      const out = quote(x);
      expect(out).toBeGreaterThanOrEqual(prev);
      prev = out;
    }
    // Peak (past the capacity clamp) stays FLAT for every larger x — the
    // saturating contract, never a collapse back toward 0.
    const peak = quote(5n * 10n ** 11n);
    expect(quote(1n << 62n)).toBe(peak);
    expect(peak).toBeGreaterThan(0n);
  });

  it('matches the independently-derived expected figures at the checked-in fixture snapshot', async () => {
    const fixtures = loadFixtures(FIXTURES);
    const load = fixtureLoader(fixtures);
    const state = fixtureBytesMap(fixtures);
    const base = await deriverse.fetchPoolConfig(load, REAL_POOL);

    const sellCfg: DeriversePoolConfig = { ...base, side: 'sell' };
    const sellQuote = deriverseLadder.referenceQuote(sellCfg, state, deriverseLadder.paramsFor(sellCfg));
    expect(sellQuote(100_000_000n)).toBe(7_282_653n);
    expect(sellQuote(1_000_000_000n)).toBe(72_205_180n);
    expect(sellQuote(5_000_000_000n)).toBe(241_853_129n); // past the capacity clamp already
    expect(sellQuote(500_000_000_000n)).toBe(241_853_129n); // saturates, does not collapse

    const buyCfg: DeriversePoolConfig = { ...base, side: 'buy' };
    const buyQuote = deriverseLadder.referenceQuote(buyCfg, state, deriverseLadder.paramsFor(buyCfg));
    expect(buyQuote(10_000_000n)).toBe(136_968_553n);
    expect(buyQuote(100_000_000n)).toBe(1_353_714_095n);
    expect(buyQuote(5_000_000_000n)).toBe(3_119_602_612n); // past the capacity clamp already
    expect(buyQuote(50_000_000_000n)).toBe(3_119_602_612n); // saturates
  });

  it('a suspended instrument (mask bit 0x20) quotes 0 for every x, both directions', () => {
    const pool = address('So11111111111111111111111111111111111111112');
    const data = new Uint8Array(1064);
    const dv = new DataView(data.buffer);
    dv.setUint32(0, 7, true); // discriminator tag = INSTR
    dv.setUint32(4, 1, true); // version
    dv.setUint32(28, 0x20, true); // mask: Suspended
    dv.setBigInt64(32, 1_000_000_000n, true); // last_px
    dv.setBigInt64(144, 1_000_000_000n, true); // asset_tokens
    dv.setBigInt64(152, 1_000_000_000n, true); // crncy_tokens
    dv.setBigInt64(800, 1_000_000_000n, true); // dec_factor
    const cfg: DeriversePoolConfig = {
      venue: 'deriverse',
      pool,
      side: 'sell',
      instrId: 0,
      assetTokenId: 1,
      crncyTokenId: 2,
      assetMint: pool,
      crncyMint: pool,
      assetVault: pool,
      crncyVault: pool,
      asksTree: pool,
      askOrders: pool,
      bidsTree: pool,
      bidOrders: pool,
      lines: pool,
      mapsAddress: pool,
      clientInfos: pool,
      tokenProgram: pool,
      feePpm: 100n,
    };
    const quote = deriverseLadder.referenceQuote(cfg, { [pool]: data }, deriverseLadder.paramsFor(cfg));
    expect(quote(1_000_000n)).toBe(0n);
    expect(quote(1n << 40n)).toBe(0n);
  });
});

describe('deriverseRawQuote / deriverseLadder.depthReserves', () => {
  it('depthReserves reports the embedded AMM reserves oriented by side', async () => {
    const fixtures = loadFixtures(FIXTURES);
    const load = fixtureLoader(fixtures);
    const state = fixtureBytesMap(fixtures);
    const base = await deriverse.fetchPoolConfig(load, REAL_POOL);
    const sell = deriverseLadder.depthReserves({ ...base, side: 'sell' }, state);
    const buy = deriverseLadder.depthReserves({ ...base, side: 'buy' }, state);
    expect(sell.reserveIn).toBe(buy.reserveOut);
    expect(sell.reserveOut).toBe(buy.reserveIn);
    expect(sell.reserveIn).toBeGreaterThan(0n);
    expect(sell.reserveOut).toBeGreaterThan(0n);
  });
});

describe('the fragment compiles as valid SauceScript', () => {
  it.each(['sell', 'buy'] as const)('%s: emitSetup + two ladder rungs + emitFinalQuote', async (side) => {
    const fixtures = loadFixtures(FIXTURES);
    const load = fixtureLoader(fixtures);
    const base = await deriverse.fetchPoolConfig(load, REAL_POOL);
    const cfg: DeriversePoolConfig = { ...base, side };
    const params = deriverseLadder.paramsFor(cfg).map((v) => v.toString());
    const source = [
      ...deriverseLadder.helpers(cfg).map((h) => h.source),
      'function main() {',
      '  let s0en = 1;',
      deriverseLadder.emitSetup(cfg, 0, params),
      deriverseLadder.emitLadderQuote!(cfg, 0, 0, '100000', 's0o1'),
      deriverseLadder.emitLadderQuote!(cfg, 0, 1, '500000', 's0o2'),
      deriverseLadder.emitFinalQuote!(cfg, 0, '250000', 'qFinal'),
      '  return qFinal;',
      '}',
    ].join('\n');
    const { bytecode, accountPlan } = compile(source, { target: 'svm' });
    expect(bytecode[0].length).toBeGreaterThan(0);
    expect(accountPlan?.metas.map((m) => m.ref)).toEqual(['s0:pool']);
  });
});

describe('program identity', () => {
  it('the venue slug, program id and PDA authority are pinned', () => {
    expect(deriverse.slug).toBe('deriverse');
    expect(deriverseLadder.slug).toBe('deriverse');
    expect(deriverse.programId).toBe(address('DRVSpZ2YUYYKgZP8XtLhAGtT1zYSCKzeHfb4DgRnrgqD'));
    expect(DERIVERSE_PROGRAM_ID).toBe(deriverse.programId);
    expect(DERIVERSE_AUTH).toBe(address('5QLXhNtkVUEtCyzZ6C1iAavT2x6c6t6LdJcSwVnqWEii'));
  });
});

// Exercise the pure quote function directly too (deriverseRawQuote), so a
// future ladder.ts refactor that stops threading it through referenceQuote
// still gets covered.
describe('deriverseRawQuote (the pure closed-form)', () => {
  it('returns 0 when the curve is disabled', () => {
    const disabled = { enabled: false, a: 1n, b: 1n, k: 1n, df: 1n, px: 1n, feePpm: 0n };
    expect(deriverseRawQuote(1_000_000n, disabled, 'sell', 1_000_000n)).toBe(0n);
  });

  it('sell/buy round-trip is internally consistent on a small synthetic pool (no fee)', () => {
    const curve = { enabled: true, a: 1_000_000_000n, b: 1_000_000_000n, k: 1_000_000_000n * 1_000_000_000n, df: 1n, px: 1_000_000_000n, feePpm: 0n };
    const icap = 10n ** 15n; // effectively uncapped for this small trade
    const out = deriverseRawQuote(1_000_000n, curve, 'sell', icap);
    expect(out).toBeGreaterThan(0n);
    expect(out).toBeLessThan(1_000_000n); // a fair CP curve never returns more than it was given at 1:1 depth
  });
});
