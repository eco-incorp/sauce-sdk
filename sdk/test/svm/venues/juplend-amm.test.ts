/**
 * juplend-amm venue adapter units (no engine, no RPC): fetchPoolConfig
 * against a REAL mainnet dump (dex_id 1, USDC/USDT, pool
 * FfEJYz4hLLFe4KyNyKYCjvfhMfbtpLH3CXpcPe8nhmfy — checked in under
 * sdk/test/svm/fixtures/juplend-amm/, captured 2026-07-31; a smart_debt,
 * non-shifting-peg pool — see index.ts's module doc for why an ACTIVE
 * center-price-shift pool like the SOL/JitoSOL one is rejected outright and
 * so cannot be the fetchPoolConfig fixture here), plus the capacity-clamp /
 * rate-model unit coverage.
 *
 * VALIDATION METHOD AND ITS LIMITS (see index.ts's module doc for the full
 * account-list write-up): every byte offset and every PDA this test
 * exercises was independently reproduced against LIVE mainnet-beta state —
 * this fixture's `tokenReserve0`/`tokenReserve1`/`position0`/`position1`
 * derivations below are asserted against the REAL addresses the RPC
 * returned for this exact Dex, not merely "does it not throw". What this
 * suite does NOT do (and could not, without the closed-source Rust): assert
 * `referenceQuote` reproduces the real program's own exact output. The
 * account-list correctness (all 24 `swap_in` accounts, both position kinds)
 * was instead proven by round-tripping the real instruction through
 * `simulateTransaction` for THIS pool and for a smart-collateral pool
 * (SOL/JitoSOL), each running deep into the program's own business logic
 * (11–50k CU) past every Anchor account/owner/discriminator check — see
 * index.ts's module doc for the full account-list validation writeup.
 */
import { resolve } from 'path';
import { address, getProgramDerivedAddress } from '@solana/kit';
import { juplendAmm, JUPLEND_LIQUIDITY_PROGRAM_ID } from '../../../src/svm/venues/juplend-amm/index.js';
import type { JuplendAmmPoolConfig } from '../../../src/svm/venues/juplend-amm/index.js';
import { juplendAmmLadder } from '../../../src/svm/venues/juplend-amm/ladder.js';
import { fixtureLoader, fixtureBytesMap, loadFixtures } from '../fixtures.js';

const FIXTURES = resolve(process.cwd(), 'test/svm/fixtures/juplend-amm');
const POOL = address('FfEJYz4hLLFe4KyNyKYCjvfhMfbtpLH3CXpcPe8nhmfy');
const MINT_USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const MINT_USDT = address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');

describe('juplend-amm.fetchPoolConfig (real mainnet dump)', () => {
  it('decodes the USDC/USDT Dex and derives every PDA to the REAL on-chain address', async () => {
    const fixtures = loadFixtures(FIXTURES);
    const load = fixtureLoader(fixtures);
    const cfg = await juplendAmm.fetchPoolConfig(load, POOL, true);

    expect(cfg.token0).toBe(MINT_USDC);
    expect(cfg.token1).toBe(MINT_USDT);
    // fee = 500 (0.05%, 1e6-scale ppm — verified live against 8 real Dex pools).
    expect(cfg.feePpm).toBe(500n);
    // smart_debt enabled, smart_collateral disabled on this pool (real state).
    expect(cfg.positionKind).toBe('borrow');
    expect(cfg.tokenProgram0).toBe(address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'));
    expect(cfg.tokenProgram1).toBe(address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'));

    // Every derived PDA below was independently verified live: these are
    // the REAL addresses returned by getProgramAccounts / getMultipleAccounts
    // for this exact Dex (see index.ts's module doc).
    expect(cfg.tokenReserve0).toBe(address('94vK29npVbyRHXH63rRcTiSr26SFhrQTzbpNJuhQEDu'));
    expect(cfg.tokenReserve1).toBe(address('Enao27EWUV2fv3rUqwknJ1eRaM5aAeN5ijeCrM9tayRX'));
    expect(cfg.position0).toBe(address('4NB8MfVbDzZEEKAda5kxChxPSqJJ2vjTb7hRFZyJ5EWr'));
    expect(cfg.position1).toBe(address('37PKKRw8Jv6sXUWi16hjj4TsCmXGugZejsRpWmGzf2PZ'));
    expect(cfg.vault0).toBe(address('BmkUoKMFYBxNSzWXyUjyMJjMAaVz4d8ZnxwwmhDCUXFB'));
    expect(cfg.vault1).toBe(address('4HTRHjdgy4VSVRcsumuzVFCgWywNhjGsD5oG3kqAt5vo'));

    const [expectedLiquidity] = await getProgramDerivedAddress({
      programAddress: JUPLEND_LIQUIDITY_PROGRAM_ID,
      seeds: ['liquidity'],
    });
    expect(cfg.liquidity).toBe(expectedLiquidity);
  });

  it('quotes the real fixture at exactly 1:1 (center_price 1e15, a hard USDC/USDT peg) minus the real 5bp fee', async () => {
    const fixtures = loadFixtures(FIXTURES);
    const load = fixtureLoader(fixtures);
    const cfg = await juplendAmm.fetchPoolConfig(load, POOL, true);
    const state = fixtureBytesMap(fixtures);
    const params = juplendAmmLadder.paramsFor(cfg);
    // Reading the raw center_price via the SAME accountUint-mirroring path
    // referenceQuote uses (no separate decode path to drift from).
    const quote = juplendAmmLadder.referenceQuote(cfg, state, params);
    // 1 USDC (1e6 raw, dec 6) in, swap0to1 (USDC -> USDT): effIn =
    // 1,000,000 - floor(1,000,000*500/1e6) = 999,500; at centerPrice == 1e15
    // exactly (numer == denom) the rate leg is a no-op, so out == effIn.
    expect(quote(1_000_000n)).toBe(999_500n);
  });
});

describe('juplend-amm ladder — capacity clamp + rate model (synthetic, exact arithmetic)', () => {
  const DEX = address('So11111111111111111111111111111111111111112');
  const POS0 = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const POS1 = address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
  const DUMMY = address('75HgnSvXbWKZBpZHveX68ZzAhDqMzNDS29X6BGLtxMo1');

  function dexBytes(centerPrice: bigint): Uint8Array {
    const data = new Uint8Array(329);
    const view = new DataView(data.buffer);
    view.setBigUint64(109, centerPrice & ((1n << 64n) - 1n), true);
    view.setBigUint64(117, centerPrice >> 64n, true);
    return data;
  }
  function positionBytes(amount: bigint, ceiling: bigint): Uint8Array {
    const data = new Uint8Array(120);
    const view = new DataView(data.buffer);
    view.setBigUint64(73, amount, true);
    view.setBigUint64(81, ceiling, true);
    return data;
  }

  function cfgFor(swap0to1: boolean, feePpm: bigint): JuplendAmmPoolConfig {
    return {
      venue: 'juplend-amm',
      pool: DEX,
      swap0to1,
      token0: DUMMY,
      token1: DUMMY,
      tokenProgram0: DUMMY,
      tokenProgram1: DUMMY,
      tokenReserve0: DUMMY,
      tokenReserve1: DUMMY,
      vault0: DUMMY,
      vault1: DUMMY,
      rateModel0: DUMMY,
      rateModel1: DUMMY,
      liquidity: DUMMY,
      positionKind: 'supply',
      position0: POS0,
      position1: POS1,
      feePpm,
    };
  }

  it('quote(0) === 0 and the quote is nondecreasing up to the capacity ceiling, then FLAT (saturating, never collapsing)', () => {
    const cfg = cfgFor(true, 1_000n); // 0.1% fee
    const state = {
      [DEX]: dexBytes(1_000_000_000_000_000n), // 1.0
      [POS1]: positionBytes(0n, 1_000_000_000n), // cap = 1e9
    };
    const params = juplendAmmLadder.paramsFor(cfg);
    const quote = juplendAmmLadder.referenceQuote(cfg, state, params);
    expect(quote(0n)).toBe(0n);
    const samples = [1n, 1_000n, 100_000_000n, 1_000_000_000n, 2_000_000_000n, 10_000_000_000n];
    let prev = 0n;
    for (const x of samples) {
      const out = quote(x);
      expect(out).toBeGreaterThanOrEqual(prev);
      prev = out;
    }
    // Past the ceiling, the quote is flat at whatever the clamp landed on
    // (never negative, never re-collapsing to 0 — see the file header).
    expect(quote(10_000_000_000n)).toBe(quote(50_000_000_000n));
  });

  it('a fully-utilized position (amount >= ceiling) self-drops the whole slot (cap == 0, quote(x) == 0 for every x)', () => {
    const cfg = cfgFor(true, 100n);
    const state = {
      [DEX]: dexBytes(1_000_000_000_000_000n),
      [POS1]: positionBytes(2_000_000_000n, 1_000_000_000n), // amount > ceiling
    };
    const params = juplendAmmLadder.paramsFor(cfg);
    const quote = juplendAmmLadder.referenceQuote(cfg, state, params);
    expect(quote(1_000_000_000n)).toBe(0n);
    expect(quote(10n ** 12n)).toBe(0n);
  });

  it('a zero center_price self-drops (defensive: a peg that reads as unset is treated as inert, never divides by zero)', () => {
    const cfg = cfgFor(true, 100n);
    const state = {
      [DEX]: dexBytes(0n),
      [POS1]: positionBytes(0n, 1_000_000_000n),
    };
    const params = juplendAmmLadder.paramsFor(cfg);
    const quote = juplendAmmLadder.referenceQuote(cfg, state, params);
    expect(quote(1_000_000_000n)).toBe(0n);
  });

  it('direction flip: swap1to0 uses position0 and the inverse rate', () => {
    const centerPrice = 2_000_000_000_000_000n; // 2.0
    const state = {
      [DEX]: dexBytes(centerPrice),
      [POS0]: positionBytes(0n, 10_000_000_000n),
      [POS1]: positionBytes(0n, 10_000_000_000n),
    };
    const cfg0to1 = cfgFor(true, 0n); // no fee, for exact arithmetic
    const cfg1to0 = cfgFor(false, 0n);
    const params0 = juplendAmmLadder.paramsFor(cfg0to1);
    const params1 = juplendAmmLadder.paramsFor(cfg1to0);
    const q0to1 = juplendAmmLadder.referenceQuote(cfg0to1, state, params0);
    const q1to0 = juplendAmmLadder.referenceQuote(cfg1to0, state, params1);
    // swap0to1: out = in * 1e15 / centerPrice = in / 2.
    expect(q0to1(1_000_000_000n)).toBe(500_000_000n);
    // swap1to0: out = in * centerPrice / 1e15 = in * 2.
    expect(q1to0(1_000_000_000n)).toBe(2_000_000_000n);
  });

  it('capacityInputVar / referenceCapacities agree with referenceQuote at the clamp boundary', () => {
    const cfg = cfgFor(true, 500n);
    const state = {
      [DEX]: dexBytes(1_000_000_000_000_000n),
      [POS1]: positionBytes(0n, 1_000_000_000n),
    };
    const params = juplendAmmLadder.paramsFor(cfg);
    const quote = juplendAmmLadder.referenceQuote(cfg, state, params);
    const capacities = juplendAmmLadder.referenceCapacities!(cfg, state, params);
    const grid = [10_000_000_000n, 20_000_000_000n];
    const [c0, c1] = capacities(grid);
    // Both grid points are past the cliff — capacity must saturate (equal),
    // never keep growing with the raw grid span.
    expect(c1).toBe(c0);
    // And the productive cap must reproduce the SAME final quote.
    expect(quote(c0)).toBe(quote(grid[0]!));
  });
});
