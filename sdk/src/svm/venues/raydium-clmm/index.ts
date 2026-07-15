/**
 * Raydium CLMM (concentrated liquidity) venue — pool decoding, scope gates and
 * the prepare-declared tick-boundary WINDOW for the EcoSwapSVM ladder fragment
 * (./ladder.ts). LADDER-ONLY (adapter contract v2): a CLMM quote is a tick walk
 * over a data-dependent account set, so there is no v1 SvmVenueAdapter and the
 * venue is not in the v1 registry. The design is the Orca-Whirlpools WINDOW
 * pattern retargeted to Raydium's layout + math (see ./ladder.ts and
 * docs/svm-venues.md).
 *
 * Layout source-verified against github.com/raydium-io/raydium-clmm
 * (programs/amm/src/states/{pool,tick_array,config,pool_fee}.rs,
 * libraries/{tick_math,sqrt_price_math,liquidity_math,swap_math}.rs) AND a
 * mainnet dump of the SOL/USDC 0.04% pool 3ucNos4N... (snapshot slot
 * ~431198953, sdk/test/svm/fixtures/raydium-clmm/): PoolState = 1544 bytes
 * (8 disc + 1536 struct), discriminator sha256('account:PoolState')[0..8] =
 * f7 ed e3 f5 d7 c3 de 46 (SHARED with raydium-cp-swap — size 1544 and the
 * CAMM program owner discriminate); AmmConfig = 117 bytes, discriminator
 * da f4 21 68 cb cb 2b 6f; TickArrayState = 10240 bytes, discriminator
 * c0 9b 55 cd 31 f9 81 2a. All integers little-endian; liquidity_net is i128
 * LE two's-complement and tick indices are i32 LE (read unsigned + biased by
 * 2^31 in-VM). A tick is INITIALIZED iff its liquidity_gross (u128) is nonzero
 * — Raydium has no per-tick `initialized` byte (unlike whirlpool).
 *
 * THE WINDOW (identical thesis to whirlpool): prepare walks the tick arrays
 * OFF-CHAIN and ships up to RAYDIUM_CLMM_MAX_BOUNDARIES initialized-tick
 * boundaries per direction — each (arrayIndex, offset, biased tick, sqrt
 * price) — plus the swap-sequence EDGE. Everything value-bearing stays live:
 * the fragment re-reads sqrt_price_x64 / tick_current / liquidity from the
 * pool, trade_fee_rate from the AmmConfig, and each shipped boundary's
 * liquidity_gross (initialized check) + liquidity_net i128 from its tick array
 * at cook time. Shipped parts are drift-invariant by construction (a
 * TickArrayState PDA encodes (pool, start_tick_index), so a shipped offset's
 * tick can never change, and sqrt_price_from_tick is a pure function of the
 * tick). Drift semantics match whirlpool (see ./ladder.ts).
 *
 * Gates (named errors, everything else is a live read):
 * - account size / discriminator;
 * - `fee_on != 0` (Token0Only/Token1Only fee routing) — the ladder walks the
 *   classic fee-on-input path only;
 * - a nonzero `dynamic_fee_info` — a dynamic-fee pool walks tick-spacing-
 *   bounded steps with a per-step volatility fee the fragment does not model
 *   (the SwapState path where `get_dynamic_fee_info()` is Some); classic pools
 *   (all-zero dynamic_fee_info) jump straight to the next initialized tick;
 * - the swap-disabled status bit;
 * - non-classic-SPL mints (the quote reads vault-independent tick liquidity,
 *   but a transfer-fee mint would break the realized-delta bound);
 * - a direction with NO shipped boundaries and no edge (gated by the recipe
 *   orchestrator via windowFor).
 */
import { address, getAddressCodec, getProgramDerivedAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type { AccountLoader, PoolConfig } from '../types.js';
import { MAX_TICK, MIN_TICK, raydiumSqrtPriceAtTick } from './tick-math.js';

const SLUG = 'raydium-clmm';

export const RAYDIUM_CLMM_PROGRAM_ID = address('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export const POOL_ACCOUNT_SIZE = 1544;
export const AMM_CONFIG_ACCOUNT_SIZE = 117;
export const TICK_ARRAY_ACCOUNT_SIZE = 10240;
/** sha256('account:PoolState')[0..8] (shared with raydium-cp — size+owner discriminate). */
export const POOL_DISCRIMINATOR = [0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46];
/** sha256('account:AmmConfig')[0..8]. */
export const AMM_CONFIG_DISCRIMINATOR = [0xda, 0xf4, 0x21, 0x68, 0xcb, 0xcb, 0x2b, 0x6f];
/** sha256('account:TickArrayState')[0..8]. */
export const TICK_ARRAY_DISCRIMINATOR = [0xc0, 0x9b, 0x55, 0xcd, 0x31, 0xf9, 0x81, 0x2a];

export const TICK_ARRAY_SIZE = 60;
export { MAX_TICK, MIN_TICK };

/**
 * Shipped initialized-tick boundaries per direction (matches whirlpool: each
 * crossed boundary is a walk step ~tens of k CU on the interpreter). Moves in
 * lockstep with the fragment's unrolled setup (ladder.ts) and the mirror.
 */
export const RAYDIUM_CLMM_MAX_BOUNDARIES = 4;

// PoolState offsets (ABSOLUTE = struct offset + 8 anchor disc; repr(C, packed)).
export const OFF_AMM_CONFIG = 9;
export const OFF_TOKEN_MINT_0 = 73;
export const OFF_TOKEN_MINT_1 = 105;
export const OFF_TOKEN_VAULT_0 = 137;
export const OFF_TOKEN_VAULT_1 = 169;
export const OFF_OBSERVATION_KEY = 201;
export const OFF_TICK_SPACING = 235;
export const OFF_LIQUIDITY = 237;
export const OFF_SQRT_PRICE = 253;
export const OFF_TICK_CURRENT = 269;
export const OFF_STATUS = 389;
export const OFF_FEE_ON = 390;
export const OFF_OPEN_TIME = 1080;
export const OFF_DYNAMIC_FEE_INFO = 1096;
export const DYNAMIC_FEE_INFO_LEN = 80;
/** AmmConfig: trade_fee_rate u32 @47 (hundredths of a bip, denominator 1e6). */
export const OFF_CFG_TRADE_FEE_RATE = 47;

// TickArrayState offsets: pool_id @8, start_tick_index i32 @40, ticks[60] @44
// (168 bytes each: tick i32 @+0, liquidity_net i128 @+4, liquidity_gross u128 @+20).
export const OFF_TA_POOL = 8;
export const OFF_TA_START = 40;
export const OFF_TA_TICKS = 44;
export const TICK_LEN = 168;
export const OFF_TICK_LIQ_NET = 4;
export const OFF_TICK_LIQ_GROSS = 20;

/** Swap-disabled status bit (PoolStatusBitIndex::Swap = 4). */
const STATUS_SWAP_BIT = 4;

export interface RaydiumClmmBoundary {
  /** Index into the window's tickArrays (0..2). */
  arrayIndex: number;
  /** Tick offset within that array (0..59) — the live liquidity_gross/net cell. */
  offset: number;
  /** UNBIASED tick index (= start + offset * spacing, PDA-pinned). */
  tick: number;
  /** raydiumSqrtPriceAtTick(tick) — pure function of the tick. */
  sqrtPrice: bigint;
}

export interface RaydiumClmmWindow {
  /** The three swap-sequence tick array PDAs, nearest first (walk order). */
  tickArrays: [Address, Address, Address];
  /** start_tick_index encoded in each PDA (walk order). */
  startTicks: [number, number, number];
  /** Initialized-tick boundaries in walk order (<= RAYDIUM_CLMM_MAX_BOUNDARIES). */
  boundaries: RaydiumClmmBoundary[];
  /**
   * The swap-sequence bound of the readable window — null when the boundary
   * scan stopped at RAYDIUM_CLMM_MAX_BOUNDARIES (deeper ticks the model does
   * not carry, so the walk must not step past the last shipped boundary).
   */
  edge: { tick: number; sqrtPrice: bigint } | null;
  /** Contiguous prefix of tickArrays that existed as TickArrayState at prepare. */
  readable: number;
}

export interface RaydiumClmmPoolConfig extends PoolConfig {
  venue: typeof SLUG;
  /** Trade direction: '0to1' (default) sells token_0 for token_1 (zero_for_one, price down). */
  direction: '0to1' | '1to0';
  ammConfig: Address;
  tokenMint0: Address;
  tokenMint1: Address;
  tokenVault0: Address;
  tokenVault1: Address;
  observation: Address;
  /** ['pool_tick_array_bitmap_extension', pool] — required by the swap when the walk leaves the default bitmap. */
  bitmapExtension: Address;
  tickSpacing: number;
  /** Snapshot at fetch time (the fragment re-reads it live from the AmmConfig). */
  tradeFeeRate: number;
  /** Snapshots at fetch time (the fragment re-reads them live from the pool). */
  liquidity: bigint;
  sqrtPrice: bigint;
  tickCurrentIndex: number;
  /** Direction-keyed prepare-declared windows (see the header). */
  windows: { '0to1': RaydiumClmmWindow; '1to0': RaydiumClmmWindow };
}

/** The direction's window (the ladder adapter and the orchestrator gate read through this). */
export function windowFor(cfg: RaydiumClmmPoolConfig): RaydiumClmmWindow {
  return cfg.direction === '0to1' ? cfg.windows['0to1'] : cfg.windows['1to0'];
}

const readI32 = (data: Uint8Array, offset: number): number => {
  const u = Number(readUintLE(data, offset, 4));
  return u >= 0x8000_0000 ? u - 0x1_0000_0000 : u;
};

function hasDiscriminator(data: Uint8Array, discriminator: readonly number[]): boolean {
  return discriminator.every((byte, i) => data[i] === byte);
}

function getAddressEncoded(value: Address): Uint8Array {
  return new Uint8Array(getAddressCodec().encode(value));
}

async function deriveTickArrayPda(pool: Address, startTick: number): Promise<Address> {
  const be = new Uint8Array(4);
  new DataView(be.buffer).setInt32(0, startTick, false); // start_tick_index.to_be_bytes()
  const [pda] = await getProgramDerivedAddress({
    programAddress: RAYDIUM_CLMM_PROGRAM_ID,
    seeds: [new TextEncoder().encode('tick_array'), getAddressEncoded(pool), be],
  });
  return pda;
}

/** floor division toward negative infinity (TickArrayState::get_array_start_index). */
export function arrayStartIndex(tickIndex: number, tickSpacing: number): number {
  const n = TICK_ARRAY_SIZE * tickSpacing;
  let start = Math.trunc(tickIndex / n);
  if (tickIndex < 0 && tickIndex % n !== 0) start -= 1;
  return start * n;
}

/**
 * The three swap-sequence array starts for a direction: the array containing
 * the live tick, then two more in the walk direction (down for zero_for_one).
 * Raydium's first swap array is always the live-tick array (no whirlpool-style
 * shifted-window rule — next_initialized_tick searches within it first).
 */
export function windowStartTicks(tickCurrentIndex: number, tickSpacing: number, zeroForOne: boolean): [number, number, number] {
  const span = TICK_ARRAY_SIZE * tickSpacing;
  const base = arrayStartIndex(tickCurrentIndex, tickSpacing);
  return zeroForOne ? [base, base - span, base - 2 * span] : [base, base + span, base + 2 * span];
}

/** Whether a tick cell (at OFF_TA_TICKS + offset*TICK_LEN) is initialized (liquidity_gross != 0). */
function tickInitialized(array: Uint8Array, offset: number): boolean {
  return readUintLE(array, OFF_TA_TICKS + offset * TICK_LEN + OFF_TICK_LIQ_GROSS, 16) !== 0n;
}

/**
 * Scan the readable window for initialized-tick boundaries in walk order —
 * next_initialized_tick semantics: zero_for_one searches DOWN from the live
 * tick's offset INCLUSIVE, one_for_zero searches UP exclusive; later arrays
 * search their full span. The edge is shipped only when the scan exhausted the
 * readable window (see RaydiumClmmWindow.edge).
 */
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

  const arrays: (Uint8Array | null)[] = [];
  let readable = 0;
  for (let i = 0; i < 3; i++) {
    const data = await load(tickArrays[i]);
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
    const start = startTicks[a];
    let offset: number;
    if (a === 0) {
      const raw = Math.floor((tickCurrentIndex - start) / tickSpacing);
      offset = zeroForOne ? raw : raw + 1;
    } else {
      offset = zeroForOne ? TICK_ARRAY_SIZE - 1 : 0;
    }
    if (!zeroForOne && offset < 0) offset = 0;
    while (offset >= 0 && offset < TICK_ARRAY_SIZE) {
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
    const lastStart = startTicks[readable - 1];
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

/**
 * Fetch + gate one Raydium CLMM pool (see the header for the gate list) and
 * freeze both directions' boundary windows. Read-only against the loader.
 */
export async function fetchRaydiumClmmConfig(load: AccountLoader, pool: Address): Promise<RaydiumClmmPoolConfig> {
  const data = await load(pool);
  if (data === null) throw new Error(`${SLUG}: pool account ${pool} not found`);
  if (data.length !== POOL_ACCOUNT_SIZE) {
    throw new Error(`${SLUG}: pool ${pool} has ${data.length} bytes, expected ${POOL_ACCOUNT_SIZE}`);
  }
  if (!hasDiscriminator(data, POOL_DISCRIMINATOR)) {
    throw new Error(`${SLUG}: pool ${pool} has a foreign discriminator (not a PoolState account)`);
  }

  const status = data[OFF_STATUS];
  if ((status & (1 << STATUS_SWAP_BIT)) !== 0) {
    throw new Error(`${SLUG}: pool ${pool} has swaps disabled (status bit ${STATUS_SWAP_BIT})`);
  }
  const feeOn = data[OFF_FEE_ON];
  if (feeOn !== 0) {
    throw new Error(
      `${SLUG}: pool ${pool} uses fee_on ${feeOn} (Token0Only/Token1Only) — the ladder walks the fee-on-input path only`,
    );
  }
  for (let i = 0; i < DYNAMIC_FEE_INFO_LEN; i++) {
    if (data[OFF_DYNAMIC_FEE_INFO + i] !== 0) {
      throw new Error(
        `${SLUG}: pool ${pool} has a dynamic fee configured — its swap walks tick-spacing-bounded steps with a per-step ` +
          'volatility fee the in-VM quote does not model',
      );
    }
  }

  const codec = getAddressCodec();
  const ammConfig = codec.decode(data.subarray(OFF_AMM_CONFIG, OFF_AMM_CONFIG + 32));
  const tokenMint0 = codec.decode(data.subarray(OFF_TOKEN_MINT_0, OFF_TOKEN_MINT_0 + 32));
  const tokenMint1 = codec.decode(data.subarray(OFF_TOKEN_MINT_1, OFF_TOKEN_MINT_1 + 32));
  for (const mint of [tokenMint0, tokenMint1]) {
    const mintData = await load(mint);
    if (mintData === null) throw new Error(`${SLUG}: mint ${mint} of pool ${pool} not found`);
    // The quote reads tick liquidity (vault-independent), but a transfer-fee
    // (Token-2022 TLV) mint would break the realized-delta bound; classic SPL
    // mints are exactly 82 bytes.
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
      programAddress: RAYDIUM_CLMM_PROGRAM_ID,
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
    tokenVault0: codec.decode(data.subarray(OFF_TOKEN_VAULT_0, OFF_TOKEN_VAULT_0 + 32)),
    tokenVault1: codec.decode(data.subarray(OFF_TOKEN_VAULT_1, OFF_TOKEN_VAULT_1 + 32)),
    observation: codec.decode(data.subarray(OFF_OBSERVATION_KEY, OFF_OBSERVATION_KEY + 32)),
    bitmapExtension,
    tickSpacing,
    tradeFeeRate: Number(readUintLE(cfgData, OFF_CFG_TRADE_FEE_RATE, 4)),
    liquidity: readUintLE(data, OFF_LIQUIDITY, 16),
    sqrtPrice: readUintLE(data, OFF_SQRT_PRICE, 16),
    tickCurrentIndex,
    windows: { '0to1': zeroForOne, '1to0': oneForZero },
  };
}

/** Family facade for the recipe orchestrator (ladder-only — no v1 adapter). */
export const raydiumClmm = {
  slug: SLUG,
  programId: RAYDIUM_CLMM_PROGRAM_ID,
  tokenProgram: TOKEN_PROGRAM,
  token2022Program: TOKEN_2022_PROGRAM,
  memoProgram: MEMO_PROGRAM,
  fetchPoolConfig: fetchRaydiumClmmConfig,
};
