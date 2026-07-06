/**
 * EcoSwapSVM real-binary CPI lane (env-gated: SAUCE_VENUE_PROGRAMS): the
 * FULL quadrilateral for raydium-cp-swap, pumpswap and saber-stableswap —
 *
 *   docs/svm-venues.md pin == ladder referenceQuote (the user-facing quote)
 *     == in-VM predicted output == REALIZED output of the real venue binary
 *
 * — through the PRODUCTION path end to end: ecoSwapSvm prepare (gates,
 * depth filter, CU budgeter, GasLeft floor), the staged blob, and the
 * runtime-patched `patch: 'in'` venue swap template (the exact bytes the
 * adapters pin in the unit suites), CPI'd into the venue program dumped
 * from mainnet. Venue-side min_out is 1; the terminal outAta delta check
 * enforces the real bound — the solswap discipline.
 *
 * Point SAUCE_VENUE_PROGRAMS at a directory of `solana program dump`ed
 * binaries named `<venue slug>.so` (pumpswap also wants `pump-fee.so`, its
 * fee program — attached in the swap's account list):
 *
 *   solana program dump CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C raydium-cp-swap.so --url mainnet-beta
 *   solana program dump pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA pumpswap.so --url mainnet-beta
 *   solana program dump pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ pump-fee.so --url mainnet-beta
 *   solana program dump SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ saber-stableswap.so --url mainnet-beta
 *   solana program dump whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc orca-whirlpool.so --url mainnet-beta
 *   solana program dump MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms manifest.so --url mainnet-beta
 *
 * Each cell skips cleanly when its binaries (or the engine) are absent.
 * Accounts the swap touches beyond the quote fixtures (saber's admin-fee
 * destination, pumpswap's fee-recipient ATAs) are fabricated as empty token
 * accounts at the adapter-derived addresses.
 */
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { address } from '@solana/kit';
import type { Address } from '@solana/kit';
import { manifest, orcaWhirlpool, pumpswapAdapter, raydiumCpSwap, saberStableswap } from '../../src/svm/index.js';
import type { AccountLoader, PumpswapPoolConfig, SaberPoolConfig } from '../../src/svm/index.js';
import { ecoSwapSvm } from '../../src/recipes/ecoswap/svm/index.js';
import type { EcoSwapSvmPoolSpec } from '../../src/recipes/ecoswap/svm/index.js';
import { ENGINE_SO, loadFixtureAccounts, randomAddress, setTokenAccount, startEngine, tokenAmount } from './engine-harness.js';
import type { EngineHarness } from './engine-harness.js';
import { loadFixtures } from './fixtures.js';
import { decodeEcoTrade, execEcoTrade, stageEcoBlob } from './ecoswap-svm.harness.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const VENUE_PROGRAMS = process.env.SAUCE_VENUE_PROGRAMS;
const soPath = (name: string): string | undefined => (VENUE_PROGRAMS ? join(VENUE_PROGRAMS, `${name}.so`) : undefined);
const haveAll = (...names: string[]): boolean =>
  existsSync(ENGINE_SO) && names.every((name) => soPath(name) !== undefined && existsSync(soPath(name)!));
const describeWith = (...names: string[]): jest.Describe => (haveAll(...names) ? describe : describe.skip);

const USER = { outAta: 'user:out', inAta: 'user:in', owner: 'payer' };
const OUT_ATA_START = 5_000_000n;

interface QuadCell {
  harness: EngineHarness;
  liveLoader: AccountLoader;
}

const boot = async (clock: bigint, fixtureDirs: string[], programs: [Address, string][]): Promise<QuadCell> => {
  const harness = await startEngine(clock);
  for (const dir of fixtureDirs) loadFixtureAccounts(harness, loadFixtures(join(FIXTURES, dir)));
  for (const [programId, name] of programs) harness.svm.addProgramFromFile(programId, soPath(name)!);
  const liveLoader: AccountLoader = async (addr) => {
    const account = harness.svm.getAccount(addr);
    return account.exists ? new Uint8Array(account.data) : null;
  };
  return { harness, liveLoader };
};

/** The whole quadrilateral: prepare → stage → real-CPI execute → pins. */
const runQuad = async (
  cell: QuadCell,
  spec: EcoSwapSvmPoolSpec,
  amountIn: bigint,
  pin: bigint,
  atas: { inAta: Address; outAta: Address },
  now: bigint,
): Promise<void> => {
  const output = await ecoSwapSvm({
    amountIn,
    minOut: pin, // the pin IS the bound — anything less is a failure
    pools: [spec],
    user: USER,
    load: cell.liveLoader,
    now,
  });

  // Legs 1+2: the docs pin == the ladder referenceQuote == the prepare quote.
  expect(output.quote.totalPredicted).toBe(pin);
  expect(output.quote.slices).toEqual([amountIn]);

  const staged = await stageEcoBlob(cell.harness, 0, output);
  const inBefore = tokenAmount(cell.harness, atas.inAta);
  const result = await execEcoTrade(cell.harness, staged, output, { [USER.outAta]: atas.outAta, [USER.inAta]: atas.inAta }, output.argValues);
  if (!result.ok) throw new Error(`real-CPI trade failed: ${result.err}\n${result.logs.join('\n')}`);

  // Legs 3+4: in-VM predicted == realized output of the REAL program.
  const words = decodeEcoTrade(result.returnData, 1);
  expect(words.slices).toEqual([amountIn]);
  expect(words.predictedOuts).toEqual([pin]);
  expect(words.realized).toBe(pin);
  expect(tokenAmount(cell.harness, atas.outAta)).toBe(OUT_ATA_START + pin);
  expect(tokenAmount(cell.harness, atas.inAta)).toBe(inBefore - amountIn);
  console.log(`${spec.venue} quadrilateral: ${amountIn} -> ${pin} realized by the real binary (${result.cu} CU)`);
};

describeWith('raydium-cp-swap')('ecoswap-svm real-binary CPI: raydium-cp-swap quadrilateral', () => {
  it('1_000_000 WSOL lamports -> the pinned 81_443 USDC raw, realized on-chain', async () => {
    const RAYDIUM_POOL = address('7JuwJuNU88gurFnyWeiyGKbFmExMWcmRZntn9imEzdny');
    // The pumpswap fixture dir carries the untouched WSOL/USDC mainnet mints
    // (transfer_checked reads them); the observation account is part of the
    // raydium-cp fixture set.
    const cell = await boot(1_783_123_200n, ['raydium-cp-swap', 'pumpswap'], [
      [raydiumCpSwap.programId, 'raydium-cp-swap'],
    ]);
    const cfg = await raydiumCpSwap.fetchPoolConfig(cell.liveLoader, RAYDIUM_POOL);
    const inAta = setTokenAccount(cell.harness, randomAddress(), cfg.token0Mint, cell.harness.payer.address, 10_000_000n);
    const outAta = setTokenAccount(cell.harness, randomAddress(), cfg.token1Mint, cell.harness.payer.address, OUT_ATA_START);
    await runQuad(cell, { venue: 'raydium-cp-swap', pool: RAYDIUM_POOL }, 1_000_000n, 81_443n, { inAta, outAta }, 1_783_123_200n);
  });
});

describeWith('pumpswap', 'pump-fee')('ecoswap-svm real-binary CPI: pumpswap sell quadrilateral', () => {
  it('50e9 PUMP -> the pinned 78_539_874 USDC raw, realized on-chain (fee ATAs fabricated)', async () => {
    const PUMP_POOL = address('2uF4Xh61rDwxnG9woyxsVQP7zuA6kLFpb3NvnRQeoiSd');
    const PUMP_FEE_PROGRAM = address('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
    const cell = await boot(1_783_123_200n, ['pumpswap'], [
      [pumpswapAdapter.programId, 'pumpswap'],
      [PUMP_FEE_PROGRAM, 'pump-fee'],
    ]);
    const cfg = (await pumpswapAdapter.fetchPoolConfig(cell.liveLoader, PUMP_POOL)) as PumpswapPoolConfig;

    // Fee destinations the SELL transfers into: fabricate quote-mint token
    // accounts at the adapter-derived addresses.
    setTokenAccount(cell.harness, cfg.protocolFeeRecipientTokenAccount, cfg.quoteMint, cfg.protocolFeeRecipient, 0n);
    setTokenAccount(cell.harness, cfg.coinCreatorVaultAta, cfg.quoteMint, cfg.coinCreatorVaultAuthority, 0n);
    setTokenAccount(cell.harness, cfg.buybackFeeRecipientTokenAccount, cfg.quoteMint, cfg.buybackFeeRecipient, 0n);

    // The PUMP mint is Token-2022 — the user's base account must live under
    // the same token program the swap's transfer_checked runs through.
    const inAta = setTokenAccount(
      cell.harness,
      randomAddress(),
      cfg.baseMint,
      cell.harness.payer.address,
      100_000_000_000n,
      cfg.baseTokenProgram,
    );
    const outAta = setTokenAccount(cell.harness, randomAddress(), cfg.quoteMint, cell.harness.payer.address, OUT_ATA_START, cfg.quoteTokenProgram);
    await runQuad(
      cell,
      { venue: 'pumpswap', pool: PUMP_POOL, direction: 'baseToQuote' },
      50_000_000_000n,
      78_539_874n,
      { inAta, outAta },
      1_783_123_200n,
    );
  });
});

describeWith('saber-stableswap')('ecoswap-svm real-binary CPI: saber-stableswap quadrilateral', () => {
  it('1.0 USDC -> the pinned 1_000_603 USDT raw at the post-ramp clock, realized on-chain', async () => {
    const SABER_POOL = address('YAkoNb6HKmSxQN9L8hiBE5tPJRsniSSMzND1boHmZxe');
    const CLOCK = 1_751_500_000n; // the docs pin clock (amp ramp finished)
    const cell = await boot(CLOCK, ['saber-stableswap'], [[saberStableswap.programId, 'saber-stableswap']]);
    const cfg = (await saberStableswap.fetchPoolConfig(cell.liveLoader, SABER_POOL)) as SaberPoolConfig;

    // The admin-fee destination is CPI'd (third inner transfer) but never
    // quoted — fabricate it empty at the stored address.
    setTokenAccount(cell.harness, cfg.adminFeeB, cfg.mintB, randomAddress(), 0n);

    const inAta = setTokenAccount(cell.harness, randomAddress(), cfg.mintA, cell.harness.payer.address, 10_000_000n);
    const outAta = setTokenAccount(cell.harness, randomAddress(), cfg.mintB, cell.harness.payer.address, OUT_ATA_START);
    await runQuad(cell, { venue: 'saber-stableswap', pool: SABER_POOL }, 1_000_000n, 1_000_603n, { inAta, outAta }, CLOCK);
  });
});

describeWith('orca-whirlpool')('ecoswap-svm real-binary CPI: orca-whirlpool quadrilateral', () => {
  it('100 SOL -> the pinned 8_079_301_632 USDC raw, realized by the real CLMM walk (tick crossed)', async () => {
    const WHIRLPOOL = address('Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE');
    // Any post-snapshot clock works (the quote reads no clock; the program
    // only advances reward growth) — but it must clear the pool's
    // reward_last_updated_timestamp (1_783_313_301 at the snapshot slot) or
    // the program rejects with InvalidTimestamp.
    const CLOCK = 1_783_400_000n;
    const cell = await boot(CLOCK, ['orca-whirlpool'], [[orcaWhirlpool.programId, 'orca-whirlpool']]);
    const cfg = await orcaWhirlpool.fetchPoolConfig(cell.liveLoader, WHIRLPOOL);

    // The oracle PDA is uninitialized for static-fee pools — the swap ix
    // takes it as a seeds-checked UncheckedAccount, so nothing to fabricate.
    // 100 SOL crosses the live tick's boundary (-25156) and lands in the
    // next spacing (-25157): the real program walks the same shipped window
    // the fragment priced.
    const inAta = setTokenAccount(cell.harness, randomAddress(), cfg.tokenMintA, cell.harness.payer.address, 200_000_000_000n);
    const outAta = setTokenAccount(cell.harness, randomAddress(), cfg.tokenMintB, cell.harness.payer.address, OUT_ATA_START);
    await runQuad(cell, { venue: 'orca-whirlpool', pool: WHIRLPOOL }, 100_000_000_000n, 8_079_301_632n, { inAta, outAta }, CLOCK);
  });
});

describeWith('manifest')('ecoswap-svm real-binary CPI: manifest CLOB quadrilateral', () => {
  it('1 SOL sell -> the pinned 80_216_939 USDC raw, realized by the real CLOB taker match', async () => {
    const MARKET = address('ENhU8LsaR7vDD2G1CsWcsuSGNrih9Cv5WZEk7q9kPapQ');
    // The book's shipped orders carry no expiration (last_valid_slot 0), so the
    // quote reads no clock; the swap's temp-seat claim + the best bid's reverse
    // re-post draw from the market's live free blocks (free_list_head is set).
    const CLOCK = 1_783_400_000n;
    const cell = await boot(CLOCK, ['manifest'], [[manifest.programId, 'manifest']]);
    const cfg = await manifest.fetchPoolConfig(cell.liveLoader, MARKET);
    // baseIn (sell): base account is spent (inAta), quote account receives (outAta).
    const inAta = setTokenAccount(cell.harness, randomAddress(), cfg.baseMint, cell.harness.payer.address, 10_000_000_000n);
    const outAta = setTokenAccount(cell.harness, randomAddress(), cfg.quoteMint, cell.harness.payer.address, OUT_ATA_START);
    await runQuad(cell, { venue: 'manifest', pool: MARKET }, 1_000_000_000n, 80_216_939n, { inAta, outAta }, CLOCK);
  });
});
