/**
 * Byreal — a Raydium-CLMM program CLONE deployed under its own program id
 * (`REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2`), NOT the same deployment as
 * the already-wired `raydium-clmm` family (`CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`).
 *
 * PROVEN IDL-identical to raydium-clmm (verified against REAL mainnet state
 * 2026-07-31, slot ~436413616): `getProgramAccounts(REALQqN..., dataSize:
 * 1544)` returned 129 live pools, every one carrying discriminator
 * `f7ede3f5d7c3de46` — byte-identical to raydium-clmm's POOL_DISCRIMINATOR
 * (Anchor account/instruction discriminators are `sha256("account:"+name)`,
 * a function of the STRUCT NAME only, not the deploying program, so two
 * independent Anchor programs both naming their pool struct `PoolState`
 * necessarily share it). The field offsets below (token_mint_0@73,
 * token_mint_1@105, vault_0@137, vault_1@169, ...) are lifted verbatim from
 * raydium-clmm's decoder and confirmed against a real pool,
 * `23XoPQqGw9WMsLoqTu8HMzJLD6RnXsufbKyWPLJywsCT` (USDC/USDT, tickSpacing=1) —
 * see test/svm/fixtures/byreal/ and test/svm/venues/byreal.test.ts.
 *
 * WHY THIS MODULE FORKS THE FETCH BUT NOT THE LADDER MATH:
 *
 * Anchor PDAs are always seeded under the CALLING program's own id. Upstream
 * `fetchRaydiumClmmConfig` derives its tick-array / bitmap-extension PDAs
 * from a MODULE-SCOPED `RAYDIUM_CLMM_PROGRAM_ID` constant baked at import
 * time (not an injectable parameter), so calling it unmodified against a
 * Byreal pool would derive addresses in RAYDIUM's PDA space — accounts that
 * do not exist for a Byreal pool, so every tick array would read back null
 * and the pool would be unquotable (readable stays 0 in both directions).
 * Confirmed by deriving `['tick_array', pool, start_tick_be]` under
 * `BYREAL_PROGRAM_ID` for the pool above: the derived addresses
 * (`5ipEofiHQt2z9EXBZZMbMLcgeD6SFRFGKfQgfo65PKCc` et al.) are REAL, owned by
 * `REALQqN...`, decoding to the TickArrayState discriminator
 * `c09b55cd31f9812a` (again byte-identical to raydium-clmm's). So this file
 * is a deliberate, minimal fork of `fetchRaydiumClmmConfig` +
 * `resolveWindow`: identical offsets/gates/discriminators/tick-math,
 * differing ONLY in which program id seeds the PDA derivations.
 *
 * The quote/codegen MATH is *not* forked — it is IDL-identical, so every
 * ladder method below delegates straight to the verified upstream
 * `raydiumClmmLadder` (zero transcription risk for the tick-walk fixed-point
 * arithmetic) through a thin adapter-cfg shim (`asRay`) that exists ONLY to
 * satisfy the upstream ladder's internal `cfg.venue === 'raydium-clmm'`
 * identity assert (`rayConfig()` in the SDK's ladder.ts). Every EXTERNALLY
 * visible identity — this module's own `slug`, `shapeKey`, and
 * `buildSwapV2`'s returned `programId` — is honestly `'byreal'` /
 * `BYREAL_PROGRAM_ID`, so a Byreal pool and a real raydium-clmm pool can
 * never compile to an aliased shape or CPI into the wrong program.
 *
 * DYNAMIC-FEE POOLS (`swap_v3_dyn` / `set_swap_dynamic_fee_params` — a
 * nonzero `dynamic_fee_info` blob) ARE GATED (dropped), identical to
 * upstream raydium-clmm's own conservative behavior: the ladder does not
 * model the per-step volatility fee upstream applies on those pools, so
 * rather than guess at (and risk UNDERSTATING) that fee — which would make
 * our quote look more favorable than the venue can actually deliver, a
 * favorable-error liveness hazard per docs/svm-venues.md — the pool is
 * simply excluded. Classic (non-dynamic) pools read `trade_fee_rate` LIVE
 * from the AmmConfig account (never a hardcoded/assumed tier), both at
 * fetch time (an informational snapshot) and at cook time (the fragment
 * re-reads it, inherited unchanged from raydium-clmm's ladder). Measured
 * live 2026-07-31: 4 of the 129 pools carry a nonzero `dynamic_fee_info` and
 * are dropped by this gate; the rest are classic.
 */
import { address, getAddressCodec, getProgramDerivedAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { AMM_CONFIG_DISCRIMINATOR, RAYDIUM_CLMM_MAX_BOUNDARIES, POOL_DISCRIMINATOR, TICK_ARRAY_DISCRIMINATOR, windowStartTicks } from '../raydium-clmm/index.js';
import { MAX_TICK, MIN_TICK } from '../raydium-clmm/tick-math.js';
import { raydiumClmmLadder, raydiumSqrtPriceAtTick } from '../raydium-clmm/ladder.js';
import type { AccountLoader, PoolConfig, SvmVenueLadderV2 } from '../types.js';
import type { RaydiumClmmBoundary, RaydiumClmmPoolConfig, RaydiumClmmWindow } from '../raydium-clmm/index.js';

const SLUG = 'byreal' as const;

/** Byreal's deployed program — a different program id than raydium-clmm's CAMMC... deployment. */
export const BYREAL_PROGRAM_ID = address('REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// PoolState / AmmConfig / TickArrayState layout — byte-identical to
// raydium-clmm (see the header; confirmed against real Byreal mainnet state).
const POOL_ACCOUNT_SIZE = 1544;
const AMM_CONFIG_ACCOUNT_SIZE = 117;
const TICK_ARRAY_ACCOUNT_SIZE = 10240;
const TICK_ARRAY_SIZE = 60;
const OFF_AMM_CONFIG = 9;
const OFF_TOKEN_MINT_0 = 73;
const OFF_TOKEN_MINT_1 = 105;
const OFF_TOKEN_VAULT_0 = 137;
const OFF_TOKEN_VAULT_1 = 169;
const OFF_OBSERVATION_KEY = 201;
const OFF_TICK_SPACING = 235;
const OFF_LIQUIDITY = 237;
const OFF_SQRT_PRICE = 253;
const OFF_TICK_CURRENT = 269;
const OFF_STATUS = 389;
const OFF_FEE_ON = 390;
const OFF_DYNAMIC_FEE_INFO = 1096;
const DYNAMIC_FEE_INFO_LEN = 80;
const OFF_CFG_TRADE_FEE_RATE = 47;
const OFF_TA_START = 40;
const OFF_TA_TICKS = 44;
const TICK_LEN = 168;
const OFF_TICK_LIQ_GROSS = 20;
const OFF_TICK_ORDERS_AMOUNT = 124;
const OFF_TICK_PART_FILLED_ORDERS = 132;
/** Swap-disabled status bit (PoolStatusBitIndex::Swap = 4). */
const STATUS_SWAP_BIT = 4;

export interface ByrealPoolConfig extends Omit<RaydiumClmmPoolConfig, 'venue'> {
  venue: typeof SLUG;
}

function readUintLE(data: Uint8Array, offset: number, width: number): bigint {
  let v = 0n;
  for (let i = 0; i < width; i++) v |= BigInt(data[offset + i]!) << BigInt(8 * i);
  return v;
}
function readI32(data: Uint8Array, offset: number): number {
  const u = Number(readUintLE(data, offset, 4));
  return u >= 0x8000_0000 ? u - 0x1_0000_0000 : u;
}
function hasDiscriminator(data: Uint8Array, discriminator: readonly number[]): boolean {
  return discriminator.every((byte, i) => data[i] === byte);
}
function getAddressEncoded(value: Address): Uint8Array {
  return new Uint8Array(getAddressCodec().encode(value));
}

/** ['tick_array', pool, start_tick_index BE i32] under BYREAL_PROGRAM_ID (NOT raydium-clmm's). */
async function deriveTickArrayPda(pool: Address, startTick: number): Promise<Address> {
  const be = new Uint8Array(4);
  new DataView(be.buffer).setInt32(0, startTick, false);
  const [pda] = await getProgramDerivedAddress({
    programAddress: BYREAL_PROGRAM_ID,
    seeds: [new TextEncoder().encode('tick_array'), getAddressEncoded(pool), be],
  });
  return pda;
}

function tickInitialized(array: Uint8Array, offset: number): boolean {
  return readUintLE(array, OFF_TA_TICKS + offset * TICK_LEN + OFF_TICK_LIQ_GROSS, 16) !== 0n;
}
function tickHasLimitOrders(array: Uint8Array, offset: number): boolean {
  const base = OFF_TA_TICKS + offset * TICK_LEN;
  return (
    readUintLE(array, base + OFF_TICK_ORDERS_AMOUNT, 8) !== 0n ||
    readUintLE(array, base + OFF_TICK_PART_FILLED_ORDERS, 8) !== 0n
  );
}

async function resolveWindow(
  load: AccountLoader,
  pool: Address,
  tickCurrentIndex: number,
  tickSpacing: number,
  zeroForOne: boolean,
): Promise<RaydiumClmmWindow> {
  const startTicks = windowStartTicks(tickCurrentIndex, tickSpacing, zeroForOne);
  const tickArrays = (await Promise.all(startTicks.map((start) => deriveTickArrayPda(pool, start)))) as [
    Address,
    Address,
    Address,
  ];
  const arrays: Uint8Array[] = [];
  let readable = 0;
  for (let i = 0; i < 3; i++) {
    const data = await load(tickArrays[i]!);
    const valid =
      data !== null &&
      data.length >= TICK_ARRAY_ACCOUNT_SIZE &&
      hasDiscriminator(data, TICK_ARRAY_DISCRIMINATOR) &&
      readI32(data, OFF_TA_START) === startTicks[i];
    if (!valid) break;
    arrays.push(data);
    readable += 1;
  }

  const boundaries: RaydiumClmmBoundary[] = [];
  let maxStopped = false;
  for (let a = 0; a < readable && !maxStopped; a++) {
    const data = arrays[a]!;
    const start = startTicks[a]!;
    let offset: number;
    if (a === 0) {
      const raw = Math.floor((tickCurrentIndex - start) / tickSpacing);
      offset = zeroForOne ? raw : raw + 1;
    } else {
      offset = zeroForOne ? TICK_ARRAY_SIZE - 1 : 0;
    }
    if (!zeroForOne && offset < 0) offset = 0;
    while (offset >= 0 && offset < TICK_ARRAY_SIZE) {
      if (tickHasLimitOrders(data, offset)) {
        // Upstream matches this boundary tick's limit orders unconditionally; the
        // ladder does not model order matching (conservative drop — see raydium-clmm).
        throw new Error(
          `${SLUG}: pool ${pool} has active limit orders at tick ${start + offset * tickSpacing} ` +
            '— the ladder does not model limit-order matching',
        );
      }
      if (tickInitialized(data, offset)) {
        const tick = start + offset * tickSpacing;
        boundaries.push({ arrayIndex: a, offset, tick, sqrtPrice: raydiumSqrtPriceAtTick(tick) });
        if (boundaries.length === RAYDIUM_CLMM_MAX_BOUNDARIES) {
          maxStopped = true;
          break;
        }
      }
      offset += zeroForOne ? -1 : 1;
    }
  }

  let edge: RaydiumClmmWindow['edge'] = null;
  if (readable > 0 && !maxStopped) {
    const lastStart = startTicks[readable - 1]!;
    let tick: number;
    if (zeroForOne) {
      tick = Math.max(lastStart, MIN_TICK);
    } else {
      tick = lastStart + TICK_ARRAY_SIZE * tickSpacing - 1;
      if (lastStart + TICK_ARRAY_SIZE * tickSpacing > MAX_TICK) tick = MAX_TICK;
    }
    edge = { tick, sqrtPrice: raydiumSqrtPriceAtTick(tick) };
  }

  return { tickArrays, startTicks, boundaries, edge, readable };
}

/** The direction's window (mirrors raydium-clmm's own windowFor). */
export function byrealWindowFor(cfg: ByrealPoolConfig): RaydiumClmmWindow {
  return cfg.direction === '0to1' ? cfg.windows['0to1'] : cfg.windows['1to0'];
}

/**
 * Fetch + gate one Byreal pool and freeze both directions' boundary windows.
 * A deliberate, minimal fork of fetchRaydiumClmmConfig — see the header for
 * why (PDA derivation must use BYREAL_PROGRAM_ID, not raydium-clmm's).
 * Read-only against the loader.
 */
export async function fetchByrealPoolConfig(load: AccountLoader, pool: Address): Promise<ByrealPoolConfig> {
  const data = await load(pool);
  if (data === null) throw new Error(`${SLUG}: pool account ${pool} not found`);
  if (data.length !== POOL_ACCOUNT_SIZE) {
    throw new Error(`${SLUG}: pool ${pool} has ${data.length} bytes, expected ${POOL_ACCOUNT_SIZE}`);
  }
  if (!hasDiscriminator(data, POOL_DISCRIMINATOR)) {
    throw new Error(`${SLUG}: pool ${pool} has a foreign discriminator (not a PoolState account)`);
  }
  const status = data[OFF_STATUS]!;
  if ((status & (1 << STATUS_SWAP_BIT)) !== 0) {
    throw new Error(`${SLUG}: pool ${pool} has swaps disabled (status bit ${STATUS_SWAP_BIT})`);
  }
  const feeOn = data[OFF_FEE_ON]!;
  if (feeOn !== 0) {
    throw new Error(
      `${SLUG}: pool ${pool} uses fee_on ${feeOn} (Token0Only/Token1Only) — the ladder walks the fee-on-input path only`,
    );
  }
  for (let i = 0; i < DYNAMIC_FEE_INFO_LEN; i++) {
    if (data[OFF_DYNAMIC_FEE_INFO + i] !== 0) {
      throw new Error(
        `${SLUG}: pool ${pool} has a dynamic fee configured — its swap walks tick-spacing-bounded steps with a ` +
          'per-step volatility fee the in-VM quote does not model',
      );
    }
  }

  const codec = getAddressCodec();
  const ammConfig = codec.decode(data.subarray(OFF_AMM_CONFIG, OFF_AMM_CONFIG + 32)) as Address;
  const tokenMint0 = codec.decode(data.subarray(OFF_TOKEN_MINT_0, OFF_TOKEN_MINT_0 + 32)) as Address;
  const tokenMint1 = codec.decode(data.subarray(OFF_TOKEN_MINT_1, OFF_TOKEN_MINT_1 + 32)) as Address;
  for (const mint of [tokenMint0, tokenMint1]) {
    const mintData = await load(mint);
    if (mintData === null) throw new Error(`${SLUG}: mint ${mint} of pool ${pool} not found`);
    if (mintData.length !== 82) {
      throw new Error(`${SLUG}: pool ${pool} mint ${mint} is not a classic SPL mint (transfer-fee mints unsupported)`);
    }
  }

  const cfgData = await load(ammConfig);
  if (cfgData === null) throw new Error(`${SLUG}: AmmConfig ${ammConfig} of pool ${pool} not found`);
  if (cfgData.length !== AMM_CONFIG_ACCOUNT_SIZE || !hasDiscriminator(cfgData, AMM_CONFIG_DISCRIMINATOR)) {
    throw new Error(`${SLUG}: AmmConfig ${ammConfig} of pool ${pool} has an unexpected size/discriminator`);
  }

  const tickSpacing = Number(readUintLE(data, OFF_TICK_SPACING, 2));
  const tickCurrentIndex = readI32(data, OFF_TICK_CURRENT);

  const [zeroForOne, oneForZero, bitmapExtension] = await Promise.all([
    resolveWindow(load, pool, tickCurrentIndex, tickSpacing, true),
    resolveWindow(load, pool, tickCurrentIndex, tickSpacing, false),
    getProgramDerivedAddress({
      programAddress: BYREAL_PROGRAM_ID,
      seeds: [new TextEncoder().encode('pool_tick_array_bitmap_extension'), getAddressEncoded(pool)],
    }).then(([pda]) => pda),
  ]);

  return {
    venue: SLUG,
    pool,
    direction: '0to1',
    ammConfig,
    tokenMint0,
    tokenMint1,
    tokenVault0: codec.decode(data.subarray(OFF_TOKEN_VAULT_0, OFF_TOKEN_VAULT_0 + 32)) as Address,
    tokenVault1: codec.decode(data.subarray(OFF_TOKEN_VAULT_1, OFF_TOKEN_VAULT_1 + 32)) as Address,
    observation: codec.decode(data.subarray(OFF_OBSERVATION_KEY, OFF_OBSERVATION_KEY + 32)) as Address,
    bitmapExtension,
    tickSpacing,
    tradeFeeRate: Number(readUintLE(cfgData, OFF_CFG_TRADE_FEE_RATE, 4)),
    liquidity: readUintLE(data, OFF_LIQUIDITY, 16),
    sqrtPrice: readUintLE(data, OFF_SQRT_PRICE, 16),
    tickCurrentIndex,
    windows: { '0to1': zeroForOne, '1to0': oneForZero },
  };
}

/** Family facade for the recipe orchestrator (ladder-only, like raydium-clmm — no v1 adapter). */
export const byreal = {
  slug: SLUG,
  programId: BYREAL_PROGRAM_ID,
  tokenProgram: TOKEN_PROGRAM,
  token2022Program: TOKEN_2022_PROGRAM,
  memoProgram: MEMO_PROGRAM,
  fetchPoolConfig: fetchByrealPoolConfig,
};

/**
 * The adapter-cfg shim: relabels a ByrealPoolConfig as `venue: 'raydium-clmm'`
 * ONLY for the duration of a call into the upstream ladder, whose internal
 * `rayConfig()` assert requires that exact literal. This never escapes this
 * module — every method below still returns/exposes 'byreal' externally
 * (shapeKey, buildSwapV2's programId). See the header for the full rationale.
 */
function asRay(cfg: PoolConfig): PoolConfig {
  return { ...(cfg as ByrealPoolConfig), venue: 'raydium-clmm' };
}

/**
 * Byreal's ladder — IDL-identical math to raydium-clmm, delegated verbatim
 * (see the header). Only `shapeKey` (own family prefix, no collision with
 * real raydium-clmm shapes) and `buildSwapV2` (CPI target program) are
 * genuinely different from upstream.
 */
export const byrealLadder: SvmVenueLadderV2 = {
  slug: SLUG,
  defaultRungs: raydiumClmmLadder.defaultRungs,
  shapeKey: (base) => `${SLUG}:${(base as ByrealPoolConfig).direction}`,
  // raydiumClmmLadder's concrete methods below are cfg-argument-only where
  // shown (no `now` / no `params` on a few) — raydium-clmm carries no
  // time-dependent state, so those parameters are simply absent upstream;
  // matching their real arity here (rather than the SvmVenueLadderV2
  // interface's most-general optional signature) is what lets us delegate
  // instead of transcribe.
  helpers: () => raydiumClmmLadder.helpers(),
  paramCount: raydiumClmmLadder.paramCount,
  paramsFor: (base) => raydiumClmmLadder.paramsFor(asRay(base)),
  quoteRefs: (base, slot) => raydiumClmmLadder.quoteRefs(asRay(base), slot),
  emitSetup: (base, slot, params, enableVar) => raydiumClmmLadder.emitSetup(asRay(base), slot, params, enableVar),
  emitLadderQuote: (base, slot, rung, x, outVar) =>
    raydiumClmmLadder.emitLadderQuote(asRay(base), slot, rung, x, outVar),
  emitFinalQuote: (base, slot, x, outVar) => raydiumClmmLadder.emitFinalQuote(asRay(base), slot, x, outVar),
  capacityInputVar: (slot) => raydiumClmmLadder.capacityInputVar(slot),
  buildSwapV2: (base, slot, user) => ({
    ...raydiumClmmLadder.buildSwapV2(asRay(base), slot, user),
    programId: BYREAL_PROGRAM_ID,
  }),
  referenceQuote: (base, state, params) => raydiumClmmLadder.referenceQuote(asRay(base), state, params),
  referenceLadderQuotes: (base, state, params) => raydiumClmmLadder.referenceLadderQuotes(asRay(base), state, params),
  referenceCapacities: (base, state, params) => raydiumClmmLadder.referenceCapacities(asRay(base), state, params),
  depthReserves: (base, state) => raydiumClmmLadder.depthReserves(asRay(base), state),
  continuousFees: (base, state) => raydiumClmmLadder.continuousFees(asRay(base), state),
};
