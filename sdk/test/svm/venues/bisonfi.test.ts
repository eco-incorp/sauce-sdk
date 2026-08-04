/**
 * BisonFi venue adapter units (no engine, no RPC-at-test-time): fetchPoolConfig against a REAL
 * mainnet fixture (pool 8FnX3xo2yYw3EUE6w3nQA4GfXGS9wpK6oj3veJpbFzLo, wSOL/USDC, dumped fresh
 * 2026-08-03), the freshness self-drop, the per-direction live fee haircut, the reserve-fraction cap,
 * and that the emitted fragment compiles as valid 'svm' SauceScript AND — the key safety property —
 * issues NO contract.call: its staleness gate is a pure in-VM computation that self-drops to a zero
 * quote, never an on-chain revert that could abort a co-merged cook.
 *
 * The pool's fee is read LIVE per direction (feeA=26 bps A-in, feeB=51 bps B-in in this fixture — a
 * genuinely per-direction value, and one an 18-pool sweep showed varies pool-to-pool and even
 * second-to-second as the keeper updates it, so a baked constant would be wrong). referenceQuote is a
 * pure function of state + params + an explicit `now`.
 */
import { resolve } from 'path';
import { compile } from '@eco-incorp/sauce-compiler';
import { address } from '@solana/kit';
import {
  bisonfi,
  AMOUNT_OFF,
  FEE_BPS_OFF_A,
  FEE_BPS_OFF_B,
  PRICE_OFFSET,
  PRICE_SCALE,
  STALE_SECONDS,
  TS_OFFSET,
} from '../../../src/svm/venues/bisonfi/index.js';
import type { BisonfiPoolConfig } from '../../../src/svm/venues/bisonfi/index.js';
import { bisonfiLadder } from '../../../src/svm/venues/bisonfi/ladder.js';
import { fixtureBytesMap, fixtureLoader, loadFixtures } from '../fixtures.js';
import { readUintLE } from '../../../src/svm/venues/math.js';

const FIXTURES = resolve(process.cwd(), 'test/svm/fixtures/bisonfi');
const POOL = address('8FnX3xo2yYw3EUE6w3nQA4GfXGS9wpK6oj3veJpbFzLo');
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FEE_DEN = 1_000_000n;
const BPS_TO_PPM = 100n;

/** The keeper timestamp baked into the fixture pool — freshness is asserted relative to it. */
function keeperTsSec(): bigint {
  const pool = fixtureBytesMap(loadFixtures(FIXTURES))[POOL]!;
  return readUintLE(pool, TS_OFFSET, 8) / 1_000_000_000n;
}
const FRESH_NOW = keeperTsSec() + 5n; // within STALE_SECONDS
const STALE_NOW = keeperTsSec() + STALE_SECONDS + 60n; // well past it

describe('bisonfi.fetchPoolConfig', () => {
  it('decodes the real pool topology and the decimals-only scale', async () => {
    const cfg = await bisonfi.fetchPoolConfig(fixtureLoader(loadFixtures(FIXTURES)), POOL, 0);
    expect(cfg.mintA).toBe(WSOL);
    expect(cfg.mintB).toBe(USDC);
    expect(cfg.direction).toBe(0);
    // decA=9 (wSOL), decB=6 (USDC) -> d=-3 -> scale = 1 / 1000.
    expect(cfg.scaleNum).toBe(1n);
    expect(cfg.scaleDen).toBe(1000n);
    // vaults are the real SPL token accounts (each owned by the token program).
    const bytes = fixtureBytesMap(loadFixtures(FIXTURES));
    expect(bytes[cfg.vaultA]).toBeDefined();
    expect(bytes[cfg.vaultB]).toBeDefined();
  });

  it('rejects an account whose size is not the fixed 2048-byte pool layout', async () => {
    const loader = async (a: typeof POOL) => (a === POOL ? new Uint8Array(2047) : null);
    await expect(bisonfi.fetchPoolConfig(loader as never, POOL, 0)).rejects.toThrow(/2047 bytes, expected 2048/);
  });
});

describe('bisonfiLadder.referenceQuote', () => {
  function refFor(direction: 0 | 1, now: bigint) {
    const fixtures = loadFixtures(FIXTURES);
    return (async () => {
      const cfg = (await bisonfi.fetchPoolConfig(fixtureLoader(fixtures), POOL, direction)) as BisonfiPoolConfig;
      const params = bisonfiLadder.paramsFor(cfg);
      return {
        cfg,
        quote: bisonfiLadder.referenceQuote(cfg, fixtureBytesMap(fixtures), params, now),
        bytes: fixtureBytesMap(fixtures),
      };
    })();
  }

  it('direction 0 (wSOL->USDC): quotes live price * amount, minus the live feeA haircut, when fresh', async () => {
    const { cfg, quote, bytes } = await refFor(0, FRESH_NOW);
    const price = readUintLE(bytes[cfg.pool]!, PRICE_OFFSET, 8);
    const feeBps = readUintLE(bytes[cfg.pool]!, FEE_BPS_OFF_A, 2);
    const x = 1_000_000_000n; // 1 wSOL (9dp)
    const gross = (x * (price * cfg.scaleNum)) / (PRICE_SCALE * cfg.scaleDen);
    const expected = gross - (gross * (feeBps * BPS_TO_PPM)) / FEE_DEN;
    expect(quote(x)).toBe(expected);
    expect(quote(x)).toBeGreaterThan(0n);
  });

  it('direction 1 (USDC->wSOL): quotes the exact reciprocal scale, minus the live feeB haircut', async () => {
    const { cfg, quote, bytes } = await refFor(1, FRESH_NOW);
    const price = readUintLE(bytes[cfg.pool]!, PRICE_OFFSET, 8);
    const feeBps = readUintLE(bytes[cfg.pool]!, FEE_BPS_OFF_B, 2);
    const x = 100_000_000n; // 100 USDC (6dp)
    const gross = (x * (PRICE_SCALE * cfg.scaleDen)) / (price * cfg.scaleNum);
    const expected = gross - (gross * (feeBps * BPS_TO_PPM)) / FEE_DEN;
    expect(quote(x)).toBe(expected);
  });

  it('applies a genuinely per-direction fee (feeA != feeB on this fixture), not one baked constant', async () => {
    const bytes = fixtureBytesMap(loadFixtures(FIXTURES));
    const pool = bytes[POOL]!;
    const feeA = readUintLE(pool, FEE_BPS_OFF_A, 2);
    const feeB = readUintLE(pool, FEE_BPS_OFF_B, 2);
    expect(feeA).not.toBe(feeB); // 26 vs 51 — a single "51" would over-quote direction 0
  });

  it('SELF-DROPS to 0 when the keeper timestamp is stale (never a revert-shaped failure)', async () => {
    const { quote } = await refFor(0, STALE_NOW);
    expect(quote(1_000_000_000n)).toBe(0n);
    expect(quote(1n)).toBe(0n);
  });

  it('quotes 0 for a 0 input regardless of freshness', async () => {
    const { quote } = await refFor(0, FRESH_NOW);
    expect(quote(0n)).toBe(0n);
  });

  it('clamps at reserveOut / CAP_DIVISOR for an outsized input', async () => {
    const { cfg, quote, bytes } = await refFor(0, FRESH_NOW);
    const vaultOut = cfg.direction === 0 ? cfg.vaultB : cfg.vaultA;
    const cap = readUintLE(bytes[vaultOut]!, AMOUNT_OFF, 8) / 20n;
    expect(quote(10n ** 18n)).toBe(cap);
  });
});

describe('the emitted BisonFi fragment compiles (svm) and issues NO contract.call', () => {
  // The staleness gate is a pure in-VM computation (block.timestamp - keeperTs > STALE_SECONDS ->
  // quote 0), NOT an on-chain call that could revert and abort a co-merged cook. Prove the emitted
  // program contains zero contract.call and attaches only the pool + output vault it reads.
  for (const direction of [0, 1] as const) {
    it(`direction ${direction}: no contract.call, account plan is [pool, vout], and it compiles`, async () => {
      const cfg = (await bisonfi.fetchPoolConfig(fixtureLoader(loadFixtures(FIXTURES)), POOL, direction)) as BisonfiPoolConfig;
      const params = bisonfiLadder.paramsFor(cfg).map((v) => v.toString());
      const setup = bisonfiLadder.emitSetup(cfg, 0, params);
      const quoteCall = bisonfiLadder.emitQuoteCall!(cfg, 0, '100000');
      expect(setup).not.toMatch(/contract\.call/);
      expect(quoteCall).not.toMatch(/contract\.call/);
      const helpers = bisonfiLadder.helpers(cfg).map((h) => h.source).join('\n');
      const source = [helpers, 'function main() {', setup, `  return ${quoteCall};`, '}'].join('\n');
      const { bytecode, accountPlan } = compile(source, { target: 'svm' });
      expect(bytecode[0].length).toBeGreaterThan(0);
      const refs = accountPlan?.metas.map((m) => m.ref).sort() ?? [];
      expect(refs).toEqual(['s0:pool', 's0:vout']);
    });
  }
});
