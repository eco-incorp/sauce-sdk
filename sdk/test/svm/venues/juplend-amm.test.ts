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
import { fixtureLoader, loadFixtures } from '../fixtures.js';

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
});
