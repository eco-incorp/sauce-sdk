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
import { createHash } from 'node:crypto';
import { address, getAddressCodec, getAddressDecoder, getAddressEncoder, isOffCurveAddress } from '@solana/kit';
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
 * A 243-byte pump-amm Pool account for base = WSOL, quote = USDC (override
 * the mint pair through opts) with the given vault balances, plus its two
 * vault token accounts. coin_creator is Pubkey::default (zeros) — creator
 * fee 0, no pool-v2 remaining account — and the creator is random, so the
 * pool is non-canonical (flat fees). Non-fixture mints need their own
 * account image on the loader — see syntheticMintBytes.
 */
export function synthesizePumpswapPool(
  baseAmount: bigint,
  quoteAmount: bigint,
  opts: { baseMint?: Address; quoteMint?: Address } = {},
): SynthesizedPumpswapPool {
  const codec = getAddressCodec();
  const pool = randomAddr();
  const baseVault = randomAddr();
  const quoteVault = randomAddr();
  const baseMint = opts.baseMint ?? WSOL_MINT;
  const quoteMint = opts.quoteMint ?? USDC_MINT;

  const data = new Uint8Array(243);
  data.set(POOL_DISCRIMINATOR, 0);
  data.set(randomBytes32(), 11); // creator: random => non-canonical
  data.set(new Uint8Array(codec.encode(baseMint)), 43);
  data.set(new Uint8Array(codec.encode(quoteMint)), 75);
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
      { address: baseVault, owner: TOKENKEG, data: splTokenAccountBytes(baseMint, pool, baseAmount) },
      { address: quoteVault, owner: TOKENKEG, data: splTokenAccountBytes(quoteMint, pool, quoteAmount) },
    ],
  };
}

/** 82-byte classic SPL mint image: supply u64 LE @36, decimals @44, initialized @45. */
export function syntheticMintBytes(decimals: number, supply = 10n ** 15n): Uint8Array {
  const data = new Uint8Array(82);
  new DataView(data.buffer).setBigUint64(36, supply, true);
  data[44] = decimals;
  data[45] = 1;
  return data;
}

export const SABER_PROGRAM = address('SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ');

export interface SynthesizedSaberPool {
  pool: Address;
  vaultA: Address;
  vaultB: Address;
  /** Account images keyed by address — feed to a loader AND setAccount. */
  accounts: { address: Address; owner: Address; data: Uint8Array }[];
}

/**
 * A 395-byte saber SwapInfo on the given mint pair with the given vault
 * balances: initialized, unpaused, flat amp (initial == target == amp, no
 * ramp window), trade fee feeNum/feeDen, zero admin fees. The stored nonce
 * walks down from 255 to the first OFF-curve swap authority — the same
 * search initialize performs, so fetchPoolConfig's create_program_address
 * derivation succeeds. Admin fee accounts are random (only the real-binary
 * CPI lane ever touches them, and it fabricates token accounts there).
 */
export function synthesizeSaberPool(
  mintA: Address,
  mintB: Address,
  reserveA: bigint,
  reserveB: bigint,
  opts: { amp?: bigint; feeNum?: bigint; feeDen?: bigint } = {},
): SynthesizedSaberPool {
  const codec = getAddressCodec();
  const pool = randomAddr();
  const vaultA = randomAddr();
  const vaultB = randomAddr();
  const amp = opts.amp ?? 100n;
  const feeNum = opts.feeNum ?? 1n;
  const feeDen = opts.feeDen ?? 10_000n;

  // The stored bump: first nonce (255 downward) deriving off-curve.
  const encoder = getAddressEncoder();
  const decoder = getAddressDecoder();
  let nonce = 255;
  for (; nonce >= 0; nonce--) {
    const digest = createHash('sha256')
      .update(encoder.encode(pool) as Uint8Array)
      .update(Uint8Array.of(nonce))
      .update(encoder.encode(SABER_PROGRAM) as Uint8Array)
      .update('ProgramDerivedAddress')
      .digest();
    if (isOffCurveAddress(decoder.decode(digest))) break;
  }

  const data = new Uint8Array(395);
  const view = new DataView(data.buffer);
  data[0] = 1; // is_initialized
  data[1] = 0; // is_paused
  data[2] = nonce;
  view.setBigUint64(3, amp, true); // initial_amp_factor
  view.setBigUint64(11, amp, true); // target_amp_factor
  // start/stop ramp ts stay 0 — amp is flat
  data.set(new Uint8Array(codec.encode(vaultA)), 107);
  data.set(new Uint8Array(codec.encode(vaultB)), 139);
  data.set(new Uint8Array(codec.encode(mintA)), 203);
  data.set(new Uint8Array(codec.encode(mintB)), 235);
  data.set(randomBytes32(), 267); // admin_fees_a
  data.set(randomBytes32(), 299); // admin_fees_b
  view.setBigUint64(363, feeNum, true);
  view.setBigUint64(371, feeDen, true);

  return {
    pool,
    vaultA,
    vaultB,
    accounts: [
      { address: pool, owner: SABER_PROGRAM, data },
      { address: vaultA, owner: TOKENKEG, data: splTokenAccountBytes(mintA, pool, reserveA) },
      { address: vaultB, owner: TOKENKEG, data: splTokenAccountBytes(mintB, pool, reserveB) },
    ],
  };
}

/** Loader over mainnet fixtures overlaid with synthesized accounts (fresh copies per read). */
export function overlayLoader(
  fixtures: AccountFixture[],
  synthesized: { accounts: { address: Address; owner: Address; data: Uint8Array }[] }[],
): AccountLoader {
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
export function overlayBytesMap(
  fixtures: AccountFixture[],
  synthesized: { accounts: { address: Address; owner: Address; data: Uint8Array }[] }[],
): AccountBytesMap {
  const map: AccountBytesMap = {};
  for (const fixture of fixtures) map[fixture.address] = fixtureData(fixture);
  for (const synth of synthesized) {
    for (const account of synth.accounts) map[account.address] = new Uint8Array(account.data);
  }
  return map;
}
