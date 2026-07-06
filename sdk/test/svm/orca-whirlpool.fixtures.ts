/**
 * Synthetic Orca Whirlpool fixtures: a minimal pool + FIXED tick arrays laid
 * out byte-exact to the on-chain structs (653 / 9988 bytes, real
 * discriminators, i32/i128 LE two's-complement fields), with the tick arrays
 * placed at their REAL derived PDAs — fetchOrcaWhirlpoolConfig derives the
 * window from (pool, start, spacing), so synthetic arrays must live where
 * the derivation looks.
 *
 * Used by the oracle units (negative-net round-trips, window-edge clamps on
 * hand-built profiles) and the e2e window-exhaustion cell (a shallow
 * one-array pool whose capacity the merge must redistribute around).
 */
import { createHash } from 'node:crypto';
import { getAddressCodec, getAddressDecoder, getAddressEncoder, isOffCurveAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import {
  ORCA_WHIRLPOOL_PROGRAM_ID,
  TICK_ARRAY_ACCOUNT_SIZE,
  TICK_ARRAY_DISCRIMINATOR,
  WHIRLPOOL_ACCOUNT_SIZE,
  WHIRLPOOL_DISCRIMINATOR,
} from '../../src/svm/venues/orca-whirlpool/index.js';
import { whirlpoolSqrtPriceAtTick } from '../../src/svm/venues/orca-whirlpool/ladder.js';
import { randomAddr, splTokenAccountBytes, TOKENKEG } from './ecoswap-svm.fixtures.js';

export interface SyntheticWhirlpoolTick {
  tick: number;
  /** SIGNED liquidity_net (negative values exercise the i128 round-trip). */
  net: bigint;
}

export interface SynthesizedWhirlpool {
  pool: Address;
  vaultA: Address;
  vaultB: Address;
  /** Account images keyed by address — feed to a loader AND setAccount. */
  accounts: { address: Address; owner: Address; data: Uint8Array }[];
}

/** find_program_address (canonical bump) via the documented sha256 construction. */
export function findWhirlpoolPda(seeds: Uint8Array[]): Address {
  const decoder = getAddressDecoder();
  const programBytes = getAddressEncoder().encode(ORCA_WHIRLPOOL_PROGRAM_ID) as Uint8Array;
  for (let bump = 255; bump >= 0; bump--) {
    const hash = createHash('sha256');
    for (const seed of seeds) hash.update(seed);
    hash.update(Uint8Array.of(bump));
    hash.update(programBytes);
    hash.update('ProgramDerivedAddress');
    const candidate = decoder.decode(hash.digest());
    if (isOffCurveAddress(candidate)) return candidate;
  }
  throw new Error('no off-curve bump found');
}

export function tickArrayPda(pool: Address, startTick: number): Address {
  return findWhirlpoolPda([
    new TextEncoder().encode('tick_array'),
    getAddressEncoder().encode(pool) as Uint8Array,
    new TextEncoder().encode(String(startTick)),
  ]);
}

const writeLE = (data: Uint8Array, offset: number, width: number, value: bigint): void => {
  for (let i = 0; i < width; i++) data[offset + i] = Number((value >> BigInt(8 * i)) & 0xffn);
};
const writeI32 = (data: Uint8Array, offset: number, value: number): void => {
  writeLE(data, offset, 4, BigInt.asUintN(32, BigInt(value)));
};

export interface SynthesizeWhirlpoolOpts {
  mintA: Address;
  mintB: Address;
  tickSpacing: number;
  /** Live tick; sqrt_price defaults to the tick's exact boundary price. */
  tickCurrentIndex: number;
  sqrtPrice?: bigint;
  liquidity: bigint;
  /** Hundredths of a bp (1e-6), e.g. 3000 = 0.30%. */
  feeRate: number;
  /** Initialized ticks (any array; ticks outside `arrayStarts` spans are dropped). */
  ticks: SyntheticWhirlpoolTick[];
  /** start_tick_index of each FIXED tick array to create (its PDA is derived). */
  arrayStarts: number[];
  vaultAAmount?: bigint;
  vaultBAmount?: bigint;
}

/** Builds the pool + tick arrays + vault token accounts (owners as on-chain). */
export function synthesizeWhirlpool(opts: SynthesizeWhirlpoolOpts): SynthesizedWhirlpool {
  const codec = getAddressCodec();
  const pool = randomAddr();
  const vaultA = randomAddr();
  const vaultB = randomAddr();

  const data = new Uint8Array(WHIRLPOOL_ACCOUNT_SIZE);
  data.set(WHIRLPOOL_DISCRIMINATOR, 0);
  writeLE(data, 41, 2, BigInt(opts.tickSpacing));
  writeLE(data, 43, 2, BigInt(opts.tickSpacing)); // fee_tier_index_seed == tick_spacing (static tier)
  writeLE(data, 45, 2, BigInt(opts.feeRate));
  writeLE(data, 49, 16, opts.liquidity);
  writeLE(data, 65, 16, opts.sqrtPrice ?? whirlpoolSqrtPriceAtTick(opts.tickCurrentIndex));
  writeI32(data, 81, opts.tickCurrentIndex);
  data.set(new Uint8Array(codec.encode(opts.mintA)), 101);
  data.set(new Uint8Array(codec.encode(vaultA)), 133);
  data.set(new Uint8Array(codec.encode(opts.mintB)), 181);
  data.set(new Uint8Array(codec.encode(vaultB)), 213);

  const accounts: SynthesizedWhirlpool['accounts'] = [
    { address: pool, owner: ORCA_WHIRLPOOL_PROGRAM_ID, data },
    { address: vaultA, owner: TOKENKEG, data: splTokenAccountBytes(opts.mintA, pool, opts.vaultAAmount ?? 10n ** 15n) },
    { address: vaultB, owner: TOKENKEG, data: splTokenAccountBytes(opts.mintB, pool, opts.vaultBAmount ?? 10n ** 15n) },
  ];

  const span = 88 * opts.tickSpacing;
  for (const start of opts.arrayStarts) {
    const array = new Uint8Array(TICK_ARRAY_ACCOUNT_SIZE);
    array.set(TICK_ARRAY_DISCRIMINATOR, 0);
    writeI32(array, 8, start);
    array.set(new Uint8Array(codec.encode(pool)), 9956);
    for (const { tick, net } of opts.ticks) {
      if (tick < start || tick >= start + span || (tick - start) % opts.tickSpacing !== 0) continue;
      const offset = 12 + ((tick - start) / opts.tickSpacing) * 113;
      array[offset] = 1; // initialized
      writeLE(array, offset + 1, 16, BigInt.asUintN(128, net)); // liquidity_net i128 LE
      writeLE(array, offset + 17, 16, net < 0n ? -net : net); // liquidity_gross (plausible)
    }
    accounts.push({ address: tickArrayPda(pool, start), owner: ORCA_WHIRLPOOL_PROGRAM_ID, data: array });
  }

  return { pool, vaultA, vaultB, accounts };
}
