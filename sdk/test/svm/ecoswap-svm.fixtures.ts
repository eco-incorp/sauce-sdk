/**
 * EcoSwapSVM test fixtures: a synthesized PumpSwap pool on the SAME mint
 * pair as the raydium-cp-swap mainnet fixture (WSOL/USDC).
 *
 * The two checked-in mainnet snapshots trade DIFFERENT pairs (raydium-cp:
 * WSOL/USDC; pumpswap: PUMP/USDC and a canonical WSOL-quoted pool), so the
 * 2-venue same-pair split cell clones the pumpswap POOL LAYOUT with fresh
 * addresses: base = WSOL, quote = USDC, direction baseToQuote (sell — WSOL
 * in, USDC out, matching the raydium fixture's 0to1 direction), reserves
 * chosen near the raydium fixture's ~81.7 USDC/SOL price so both venues earn
 * slices. The synthesized pool is 243 bytes with coin_creator =
 * Pubkey::default (creator fee zeroed, no pool-v2 remaining account) and a
 * random (non-canonical) creator, so fetchPoolConfig selects the REAL
 * flat fees from the checked-in FeeConfig fixture (25/5/0 bps). The
 * GlobalConfig/FeeConfig/mint accounts are the untouched mainnet dumps.
 */
import { address, getAddressCodec } from '@solana/kit';
import type { Address } from '@solana/kit';
import type { AccountBytesMap, AccountLoader } from '../../src/svm/index.js';
import type { AccountFixture } from './fixtures.js';
import { fixtureBytesMap, fixtureData } from './fixtures.js';

export const WSOL_MINT = address('So11111111111111111111111111111111111111112');
export const USDC_MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const TOKENKEG = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const PUMPSWAP_PROGRAM = address('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

/** The raydium-cp-swap mainnet fixture pool (WSOL/USDC, 0to1 = WSOL in). */
export const RAYDIUM_POOL = address('7JuwJuNU88gurFnyWeiyGKbFmExMWcmRZntn9imEzdny');

const POOL_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188];

const randomBytes32 = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

export const randomAddr = (): Address => getAddressCodec().decode(randomBytes32());

/** 165-byte SPL token account image: mint@0, owner@32, amount u64 LE@64, state Initialized. */
export function splTokenAccountBytes(mint: Address, owner: Address, amount: bigint): Uint8Array {
  const codec = getAddressCodec();
  const data = new Uint8Array(165);
  data.set(new Uint8Array(codec.encode(mint)), 0);
  data.set(new Uint8Array(codec.encode(owner)), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1; // AccountState::Initialized
  return data;
}

export interface SynthesizedPumpswapPool {
  pool: Address;
  baseVault: Address;
  quoteVault: Address;
  /** Account images keyed by address — feed to a loader AND setAccount. */
  accounts: { address: Address; owner: Address; data: Uint8Array }[];
}

/**
 * A 243-byte pump-amm Pool account for base = WSOL, quote = USDC with the
 * given vault balances, plus its two vault token accounts. coin_creator is
 * Pubkey::default (zeros) — creator fee 0, no pool-v2 remaining account —
 * and the creator is random, so the pool is non-canonical (flat fees).
 */
export function synthesizePumpswapPool(baseAmount: bigint, quoteAmount: bigint): SynthesizedPumpswapPool {
  const codec = getAddressCodec();
  const pool = randomAddr();
  const baseVault = randomAddr();
  const quoteVault = randomAddr();

  const data = new Uint8Array(243);
  data.set(POOL_DISCRIMINATOR, 0);
  data.set(randomBytes32(), 11); // creator: random => non-canonical
  data.set(new Uint8Array(codec.encode(WSOL_MINT)), 43);
  data.set(new Uint8Array(codec.encode(USDC_MINT)), 75);
  data.set(new Uint8Array(codec.encode(baseVault)), 139);
  data.set(new Uint8Array(codec.encode(quoteVault)), 171);
  new DataView(data.buffer).setBigUint64(203, 1_000_000_000n, true); // lp_supply (unread)
  // bytes 211..243 stay zero: coin_creator = Pubkey::default

  return {
    pool,
    baseVault,
    quoteVault,
    accounts: [
      { address: pool, owner: PUMPSWAP_PROGRAM, data },
      { address: baseVault, owner: TOKENKEG, data: splTokenAccountBytes(WSOL_MINT, pool, baseAmount) },
      { address: quoteVault, owner: TOKENKEG, data: splTokenAccountBytes(USDC_MINT, pool, quoteAmount) },
    ],
  };
}

/** Loader over mainnet fixtures overlaid with synthesized accounts (fresh copies per read). */
export function overlayLoader(fixtures: AccountFixture[], synthesized: SynthesizedPumpswapPool[]): AccountLoader {
  const map: AccountBytesMap = fixtureBytesMap(fixtures);
  for (const synth of synthesized) {
    for (const account of synth.accounts) map[account.address] = account.data;
  }
  return async (addr) => {
    const data = map[addr];
    return data === undefined ? null : new Uint8Array(data);
  };
}

/** AccountBytesMap over the same overlay (for the reference oracles). */
export function overlayBytesMap(fixtures: AccountFixture[], synthesized: SynthesizedPumpswapPool[]): AccountBytesMap {
  const map: AccountBytesMap = {};
  for (const fixture of fixtures) map[fixture.address] = fixtureData(fixture);
  for (const synth of synthesized) {
    for (const account of synth.accounts) map[account.address] = new Uint8Array(account.data);
  }
  return map;
}
