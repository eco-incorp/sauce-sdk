/**
 * Invariant Protocol — a Uniswap-V3-lineage CLMM on Solana (Anchor program,
 * fully OPEN SOURCE: github.com/invariant-labs/protocol, `programs/invariant`),
 * program id HyaB3W9q6XdA5xwpU4XnSZV94htfmbmqJXZcEbRaJutt. NOT an on-chain IDL
 * job and NOT reverse-engineering — the layout source is the published Rust
 * crate (`invariant-types`/`programs/invariant/src/{structs,math,util}.rs`).
 *
 * GROUND-TRUTHED LIVE against real mainnet state at integration time (2026-07-31):
 * - `Pool` zero-copy account: 400 bytes (8-byte Anchor discriminator
 *   sha256('account:Pool')[0..8] + 392 bytes, `#[repr(packed)]`, NO padding).
 *   604 live pool accounts confirmed at exactly this dataSize+discriminator via
 *   getProgramAccounts. Field offsets (after the 8-byte discriminator):
 *   token_x@8, token_y@40, token_x_reserve@72, token_y_reserve@104,
 *   position_iterator(u128)@136, tick_spacing(u16)@152, fee(u128,1e12-scaled
 *   FixedPoint)@154, protocol_fee(u128)@170, liquidity(u128,1e6-scaled)@186,
 *   sqrt_price(u128,1e24-scaled)@202, current_tick_index(i32)@218,
 *   tickmap(pubkey)@222. 16 real on-chain FeeTier accounts confirm the fee
 *   scale (values from 0.00001 to 0.5, i.e. up to 50% on exotic tiers — an
 *   unusually wide range, but real and chain-configured, not a decode bug).
 * - `Tick` zero-copy account: 150 bytes (8 + pool(32) + index(i32)@40 +
 *   sign(bool)@44 + liquidity_change(u128,1e6-scaled)@45 + liquidity_gross(u128)
 *   + sqrt_price(u128) + ...). PDA seeds `["tickv1", pool, index_i32_le]` —
 *   verified: 8 PDAs derived off-chain for a real pool's tickmap-reported
 *   initialized indices all matched real on-chain accounts with the EXACT
 *   expected `index` field decoded back out.
 * - `Tickmap` zero-copy account: a single ~11KB fixed bitmap per pool
 *   (`bitmap: [u8; 11091]`), NOT an array-of-ticks (unlike Whirlpool/Raydium
 *   CLMM) — ticks are individually PDA'd, so "one boundary" here means "one
 *   more account", not "one more index into a shared array". `next_initialized`
 *   /`prev_initialized`/`get_search_limit`/`tick_to_position` are ported
 *   verbatim (bigint) from `structs/tickmap.rs` and validated against a real
 *   pool's real bitmap (found initialized ticks [5,2,1,0,-1,-2] walking down
 *   from a live tick of 8, confirmed by fetching all 8 real Tick PDAs).
 * - `calculate_price_sqrt` (the bit-ladder of custom FixedPoint(1e12)
 *   constants, NOT `1.0001^tick` — Invariant's own reduced-precision
 *   approximation) is ported verbatim and passes every vector in
 *   `math.rs`'s `test_calculate_price_sqrt`.
 * - `compute_swap_step`/`get_delta_x`/`get_delta_y`/`get_next_sqrt_price_x_up`/
 *   `get_next_sqrt_price_y_down` (the exact ceil/floor rounding conventions,
 *   including the "double ceil/floor" TokenAmount-conversion pattern
 *   `big_div_values_to_token{,_up}`) are ported verbatim and pass every
 *   vector in `math.rs`'s `test_swap_step`/`test_get_delta_x`/
 *   `test_get_delta_y`/`test_get_next_sqrt_price_{x_up,y_down}` (32/32).
 * - `cross_tick`'s liquidity update (`structs/util.rs`) reduces, for a
 *   DIRECTED single-pass walk (this ladder never re-visits an earlier tick),
 *   to a per-direction-invariant rule: `pool.current_tick_index >= tick.index`
 *   is ALWAYS true while walking DOWN (xToY) and ALWAYS false while walking UP
 *   (yToX) — proved by induction over the walk (each step's post-cross
 *   current_tick lands AT OR BELOW/ABOVE the crossed tick, and the next
 *   boundary is strictly further in the same direction). So: xToY crossing a
 *   tick with `sign=true` SUBTRACTS `liquidity_change`, `sign=false` ADDS;
 *   yToX is the mirror (`sign=true` ADDS, `sign=false` SUBTRACTS).
 * - The `swap` instruction (Anchor global disc sha256('global:swap')[0..8] =
 *   [248,198,158,145,225,117,135,200] — the SAME 8 bytes as
 *   Whirlpool's/DefiTuna's `swap`, since Anchor discriminators depend only on
 *   the instruction NAME) takes `(x_to_y: bool, amount: u64, by_amount_in:
 *   bool, sqrt_price_limit: u128)` and a FIXED 10-account list — state(ro),
 *   pool(mut), tickmap(mut), account_x(mut), account_y(mut), reserve_x(mut),
 *   reserve_y(mut), owner(signer), program_authority(ro), token_program(ro) —
 *   PLUS the crossed-tick PDAs as `remaining_accounts` (order-independent: the
 *   program `.find()`s each by pubkey). Classic `token::transfer` (not
 *   `transfer_checked`) — no mint accounts needed. `state` (seeds
 *   `["statev1"]`) and `program_authority` (seeds `["Invariant"]`) are
 *   GLOBAL, pool-independent PDAs — hardcoded below and verified against real
 *   mainnet accounts (the `State` account's own `authority` field byte-decodes
 *   to exactly the hardcoded `program_authority` address).
 *
 * VALIDATED against the REAL deployed program (dumped from mainnet-beta) via
 * LiteSVM real-CPI on real mainnet pool/tickmap/tick state (pool
 * 5dX3tkVDmbHBWMCQMerAHTmd9wsRvmtKLoQt6qv9fHy7, USDC/USDT, tick_spacing=1,
 * fee=1bp) at THREE sizes, all BIT-EXACT to this module's off-chain math:
 *   100_000 USDC-raw    -> 100_075 USDT-raw   (single segment, no crossing)
 *   1_000_000 USDC-raw  -> 1_000_755 USDT-raw (single segment, no crossing)
 *   700_000_000 USDC-raw -> 700_381_707 USDT-raw (crosses tick 5, real
 *     on-chain `cross_tick` executes and the post-cross liquidity this
 *     module predicts off-chain matches the real program's realized output
 *     exactly — proves the cross-tick sign rule above, not just the
 *     no-crossing math).
 * See test/svm/venues/invariant.test.ts for the fixture-driven regression of
 * this exact quadrilateral (offline) and the SAUCE_VENUE_PROGRAMS-gated
 * real-CPI cell in ecoswap-svm.realcpi.e2e.test.ts.
 *
 * Volume is thin (~$0.04M/7d per the integration brief) — this ladder is
 * wired unconditionally; the existing relative-depth survivorship filter
 * drops it from an election whenever it is too shallow to matter, exactly
 * like every other thin venue in this recipe. A pool/direction with no
 * initialized tick within the tickmap's chained search range (no boundary to
 * bound the walk) self-drops via `SvmWindowDriftError`, matching
 * orca-whirlpool/raydium-clmm/meteora-dlmm's own "nothing to walk" gate.
 */
import { address, getAddressCodec, getProgramDerivedAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type { AccountBytesMap, AccountLoader, LadderSwapTemplate, PoolConfig, SvmVenueLadderV2, SwapUser, VenueAccount } from '../types.js';

const SLUG = 'invariant';
export const INVARIANT_PROGRAM_ID = address('HyaB3W9q6XdA5xwpU4XnSZV94htfmbmqJXZcEbRaJutt');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/** Global PDA, seeds ["statev1"] — verified against the real on-chain State account (bump 255). */
const STATE_PDA = address('8NsPwRFYqob3FzYvHYTjFK6WVFJADFN8Hn7yNQKcVNW1');
/** Global PDA, seeds ["Invariant"] — verified: equals the real State account's own `authority` field. */
const PROGRAM_AUTHORITY = address('J4uBbeoWpZE8fH58PM1Fp9n9K6f1aThyeVCyRdJbaXqt');

export const POOL_ACCOUNT_SIZE = 400;
/** sha256('account:Pool')[0..8]. */
export const POOL_DISCRIMINATOR = [0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc];
/** sha256('account:Tick')[0..8]. */
export const TICK_DISCRIMINATOR = [0xb0, 0x5e, 0x43, 0xf7, 0x85, 0xad, 0x07, 0x73];
export const TICK_ACCOUNT_SIZE = 150;
export const TICKMAP_ACCOUNT_SIZE = 8 + 11091;

// Pool field offsets (after the 8-byte discriminator; see header for the full field list).
const OFF_TOKEN_X = 8;
const OFF_TOKEN_Y = 40;
const OFF_TOKEN_X_RESERVE = 72;
const OFF_TOKEN_Y_RESERVE = 104;
const OFF_TICK_SPACING = 152;
const OFF_FEE = 154;
const OFF_LIQUIDITY = 186;
const OFF_SQRT_PRICE = 202;
const OFF_CURRENT_TICK = 218;
const OFF_TICKMAP = 222;

// Tick field offsets.
const OFF_TICK_INDEX = 40;
const OFF_TICK_SIGN = 44;
const OFF_TICK_LIQUIDITY_CHANGE = 45;

// Decimal scales.
const PRICE_ONE = 10n ** 24n;
const LIQ_ONE = 10n ** 6n;
const FEE_ONE = 10n ** 12n;
const PRICE_LIQUIDITY_DENOMINATOR = 10n ** 18n;

// Tickmap constants (structs/tickmap.rs).
const TICK_LIMIT = 44_364;
const TICK_SEARCH_RANGE = 256;
const MAX_TICK = 221_818;

/** Shipped boundaries per direction — one ACCOUNT per boundary (no shared tick-array amortization). */
export const INVARIANT_MAX_BOUNDARIES = 3;

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** calculate_price_sqrt (math.rs) — the custom bit-ladder, NOT 1.0001^tick. Verified vs 7 Rust vectors. */
const TICK_BITS: readonly [number, bigint][] = [
  [0x1, 1000049998750n],
  [0x2, 1000100000000n],
  [0x4, 1000200010000n],
  [0x8, 1000400060004n],
  [0x10, 1000800280056n],
  [0x20, 1001601200560n],
  [0x40, 1003204964963n],
  [0x80, 1006420201726n],
  [0x100, 1012881622442n],
  [0x200, 1025929181080n],
  [0x400, 1052530684591n],
  [0x800, 1107820842005n],
  [0x1000, 1227267017980n],
  [0x2000, 1506184333421n],
  [0x4000, 2268591246242n],
  [0x8000, 5146506242525n],
  [0x10000, 26486526504348n],
  [0x20000, 701536086265529n],
];

export function invariantSqrtPriceAtTick(tickIndex: number): bigint {
  const tick = Math.abs(tickIndex);
  if (tick > MAX_TICK) throw new Error(`invariant: tick ${tickIndex} out of bounds`);
  let price = FEE_ONE;
  for (const [mask, c] of TICK_BITS) {
    if (tick & mask) price = (price * c) / FEE_ONE;
  }
  if (tickIndex >= 0) return price * (PRICE_ONE / FEE_ONE);
  const inv = (FEE_ONE * FEE_ONE) / price;
  return inv * (PRICE_ONE / FEE_ONE);
}

// ── get_delta_x / get_delta_y / get_next_sqrt_price_{x_up,y_down} (math.rs) ──
// Verified bit-exact against 32 Rust unit-test vectors AND a real-CPI quadrilateral (see header).

export function invariantDeltaX(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, up: boolean): bigint {
  const deltaPrice = sqrtA > sqrtB ? sqrtA - sqrtB : sqrtB - sqrtA;
  const nominator = (deltaPrice * liquidity) / LIQ_ONE; // big_mul_to_value (floor), always non-up
  if (up) {
    const denom = (sqrtA * sqrtB) / PRICE_ONE; // big_mul_to_value (floor)
    return ceilDiv(ceilDiv(nominator * PRICE_ONE, denom), PRICE_ONE);
  }
  const denom = ceilDiv(sqrtA * sqrtB, PRICE_ONE); // big_mul_to_value_up (ceil)
  return (nominator * PRICE_ONE) / denom / PRICE_ONE;
}

export function invariantDeltaY(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, up: boolean): bigint {
  const deltaPrice = sqrtA > sqrtB ? sqrtA - sqrtB : sqrtB - sqrtA;
  if (up) return ceilDiv(ceilDiv(deltaPrice * liquidity, LIQ_ONE), PRICE_ONE);
  return (deltaPrice * liquidity) / LIQ_ONE / PRICE_ONE;
}

/** get_next_sqrt_price_x_up(price, liquidity, amount, add=true) — the ONLY branch a by-amount-in ladder ever needs. */
export function invariantNextSqrtXUp(price: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return price;
  const bigLiquidity = liquidity * PRICE_LIQUIDITY_DENOMINATOR;
  const denominator = bigLiquidity + price * amount;
  const nom = ceilDiv(price * liquidity, LIQ_ONE);
  return ceilDiv(nom * PRICE_ONE, denominator);
}

/** get_next_sqrt_price_y_down(price, liquidity, amount, add=true). */
export function invariantNextSqrtYDown(price: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return price;
  const num = amount * PRICE_ONE * PRICE_ONE;
  const den = liquidity * PRICE_LIQUIDITY_DENOMINATOR;
  return price + num / den;
}

export interface InvariantSwapStep {
  nextSqrt: bigint;
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
}

/**
 * compute_swap_step (math.rs), BY-AMOUNT-IN ONLY (the merge ladder never
 * quotes by-amount-out). `xToY` is derived exactly like the Rust source
 * (`current_price_sqrt >= target_price_sqrt`).
 */
export function invariantComputeSwapStepIn(currentSqrt: bigint, targetSqrt: bigint, liquidity: bigint, amount: bigint, fee: bigint): InvariantSwapStep {
  if (liquidity === 0n) return { nextSqrt: targetSqrt, amountIn: 0n, amountOut: 0n, feeAmount: 0n };
  const xToY = currentSqrt >= targetSqrt;
  const amountAfterFee = (amount * (FEE_ONE - fee)) / FEE_ONE;
  const fx = xToY ? invariantDeltaX(targetSqrt, currentSqrt, liquidity, true) : invariantDeltaY(currentSqrt, targetSqrt, liquidity, true);
  const nextSqrt = amountAfterFee >= fx ? targetSqrt : xToY ? invariantNextSqrtXUp(currentSqrt, liquidity, amountAfterFee) : invariantNextSqrtYDown(currentSqrt, liquidity, amountAfterFee);
  const notMax = targetSqrt !== nextSqrt;
  let amountIn: bigint;
  let amountOut: bigint;
  if (xToY) {
    amountIn = notMax ? invariantDeltaX(nextSqrt, currentSqrt, liquidity, true) : fx;
    amountOut = invariantDeltaY(nextSqrt, currentSqrt, liquidity, false);
  } else {
    amountIn = notMax ? invariantDeltaY(currentSqrt, nextSqrt, liquidity, true) : fx;
    amountOut = invariantDeltaX(currentSqrt, nextSqrt, liquidity, false);
  }
  const feeAmount = notMax ? amount - amountIn : ceilDiv(amountIn * fee, FEE_ONE);
  return { nextSqrt, amountIn, amountOut, feeAmount };
}

// ── Tickmap bit-scan (structs/tickmap.rs), ported verbatim. Off-chain only — the on-chain quote
// never re-scans the tickmap; boundary prices/refs are baked at prepare time. ──

function tickToPosition(tick: number, tickSpacing: number): [number, number] {
  if (tick % tickSpacing !== 0) throw new Error(`invariant: tick ${tick} not divisible by spacing ${tickSpacing}`);
  const bitmapIndex = Math.trunc(tick / tickSpacing) + TICK_LIMIT;
  const byte = Math.trunc(bitmapIndex / 8);
  const bit = ((bitmapIndex % 8) + 8) % 8;
  return [byte, bit];
}

function getBit(bitmap: Uint8Array, tick: number, tickSpacing: number): boolean {
  const [byte, bit] = tickToPosition(tick, tickSpacing);
  return ((bitmap[byte]! >> bit) & 1) === 1;
}

function getSearchLimit(tick: number, tickSpacing: number, up: boolean): number {
  const index = Math.trunc(tick / tickSpacing);
  let limit: number;
  if (up) {
    limit = Math.min(TICK_LIMIT - 1, index + TICK_SEARCH_RANGE, Math.trunc(MAX_TICK / tickSpacing));
  } else {
    limit = Math.max(-TICK_LIMIT + 1, index - TICK_SEARCH_RANGE, -Math.trunc(MAX_TICK / tickSpacing));
  }
  return limit * tickSpacing;
}

function nextInitialized(bitmap: Uint8Array, tick: number, tickSpacing: number): number | null {
  const limit = getSearchLimit(tick, tickSpacing, true);
  let [byte, bit] = tickToPosition(tick + tickSpacing, tickSpacing);
  const [limitingByte, limitingBit] = tickToPosition(limit, tickSpacing);
  while (byte < limitingByte || (byte === limitingByte && bit <= limitingBit)) {
    let shifted = bitmap[byte]! >> bit;
    if (shifted !== 0) {
      while ((shifted & 1) === 0) {
        shifted >>= 1;
        bit += 1;
      }
      if (byte < limitingByte || (byte === limitingByte && bit <= limitingBit)) {
        return (byte * 8 + bit - TICK_LIMIT) * tickSpacing;
      }
      return null;
    }
    byte += 1;
    bit = 0;
  }
  return null;
}

function prevInitialized(bitmap: Uint8Array, tick: number, tickSpacing: number): number | null {
  const limit = getSearchLimit(tick, tickSpacing, false);
  let [byte, bit] = tickToPosition(tick, tickSpacing);
  const [limitingByte, limitingBit] = tickToPosition(limit, tickSpacing);
  while (byte > limitingByte || (byte === limitingByte && bit >= limitingBit)) {
    let mask = 1 << bit;
    const value = bitmap[byte]!;
    if (value % (mask << 1) > 0) {
      while ((value & mask) === 0) {
        mask >>= 1;
        bit -= 1;
      }
      if (byte > limitingByte || (byte === limitingByte && bit >= limitingBit)) {
        return (byte * 8 + bit - TICK_LIMIT) * tickSpacing;
      }
      return null;
    }
    byte -= 1;
    bit = 7;
  }
  return null;
}

async function deriveTickPda(pool: Address, tickIndex: number): Promise<Address> {
  const poolBytes = new Uint8Array(getAddressCodec().encode(pool));
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setInt32(0, tickIndex, true);
  const [pda] = await getProgramDerivedAddress({
    programAddress: INVARIANT_PROGRAM_ID,
    seeds: [new TextEncoder().encode('tickv1'), poolBytes, indexBytes],
  });
  return pda;
}

function hasDiscriminator(data: Uint8Array, discriminator: readonly number[]): boolean {
  return discriminator.every((byte, i) => data[i] === byte);
}

export interface InvariantBoundary {
  tick: number;
  sqrtPrice: bigint;
  address: Address;
}

export interface InvariantWindow {
  boundaries: InvariantBoundary[];
}

export interface InvariantPoolConfig extends PoolConfig {
  venue: typeof SLUG;
  direction: 'xToY' | 'yToX';
  tokenXMint: Address;
  tokenYMint: Address;
  tokenXReserve: Address;
  tokenYReserve: Address;
  tickmap: Address;
  windows: { xToY: InvariantWindow; yToX: InvariantWindow };
}

export function invariantWindowFor(cfg: InvariantPoolConfig): InvariantWindow {
  return cfg.direction === 'xToY' ? cfg.windows.xToY : cfg.windows.yToX;
}

/**
 * Chains next_initialized/prev_initialized calls (each internally bounded to
 * a +/-256 index search range, matching the on-chain single-call bound) to
 * find up to INVARIANT_MAX_BOUNDARIES initialized tick indices walking away
 * from `currentTick`, then derives + confirms each real Tick PDA. Takes the
 * ALREADY-FETCHED tickmap bitmap bytes (shared across both directions).
 */
async function resolveWindowFromBitmap(
  load: AccountLoader,
  pool: Address,
  bitmap: Uint8Array,
  currentTick: number,
  tickSpacing: number,
  xToY: boolean,
): Promise<InvariantWindow> {
  const boundaries: InvariantBoundary[] = [];
  let cursor = currentTick;
  for (let i = 0; i < INVARIANT_MAX_BOUNDARIES; i++) {
    const found = xToY ? prevInitialized(bitmap, cursor, tickSpacing) : nextInitialized(bitmap, cursor, tickSpacing);
    if (found === null) break;
    const tickAddress = await deriveTickPda(pool, found);
    const data = await load(tickAddress);
    if (data === null || data.length !== TICK_ACCOUNT_SIZE || !hasDiscriminator(data, TICK_DISCRIMINATOR)) break;
    boundaries.push({ tick: found, sqrtPrice: invariantSqrtPriceAtTick(found), address: tickAddress });
    cursor = xToY ? found - tickSpacing : found + tickSpacing; // don't check the current tick again
  }
  return { boundaries };
}

/** Fetch + decode one Invariant Pool and freeze both directions' boundary windows. Read-only against the loader. */
export async function fetchInvariantPoolConfig(load: AccountLoader, pool: Address): Promise<InvariantPoolConfig> {
  const data = await load(pool);
  if (data === null) throw new Error(`${SLUG}: pool account ${pool} not found`);
  if (data.length !== POOL_ACCOUNT_SIZE) throw new Error(`${SLUG}: pool ${pool} has ${data.length} bytes, expected ${POOL_ACCOUNT_SIZE}`);
  if (!hasDiscriminator(data, POOL_DISCRIMINATOR)) throw new Error(`${SLUG}: pool ${pool} has a foreign discriminator (not a Pool account)`);

  const codec = getAddressCodec();
  const tokenXMint = codec.decode(data.subarray(OFF_TOKEN_X, OFF_TOKEN_X + 32)) as Address;
  const tokenYMint = codec.decode(data.subarray(OFF_TOKEN_Y, OFF_TOKEN_Y + 32)) as Address;
  const tokenXReserve = codec.decode(data.subarray(OFF_TOKEN_X_RESERVE, OFF_TOKEN_X_RESERVE + 32)) as Address;
  const tokenYReserve = codec.decode(data.subarray(OFF_TOKEN_Y_RESERVE, OFF_TOKEN_Y_RESERVE + 32)) as Address;
  const tickmap = codec.decode(data.subarray(OFF_TICKMAP, OFF_TICKMAP + 32)) as Address;
  const tickSpacing = Number(readUintLE(data, OFF_TICK_SPACING, 2));
  const currentTick = ((): number => {
    const u = Number(readUintLE(data, OFF_CURRENT_TICK, 4));
    return u >= 0x8000_0000 ? u - 0x1_0000_0000 : u;
  })();

  const tickmapData = await load(tickmap);
  if (tickmapData === null) throw new Error(`${SLUG}: tickmap ${tickmap} of pool ${pool} not found`);
  const bitmap = tickmapData.subarray(8);

  const [xToY, yToX] = await Promise.all([
    resolveWindowFromBitmap(load, pool, bitmap, currentTick, tickSpacing, true),
    resolveWindowFromBitmap(load, pool, bitmap, currentTick, tickSpacing, false),
  ]);

  return {
    venue: SLUG,
    pool,
    direction: 'xToY',
    tokenXMint,
    tokenYMint,
    tokenXReserve,
    tokenYReserve,
    tickmap,
    windows: { xToY, yToX },
  };
}

/** Family facade for the recipe orchestrator (ladder-only, like orca-whirlpool/raydium-clmm). */
export const invariant = {
  slug: SLUG,
  programId: INVARIANT_PROGRAM_ID,
  tokenProgram: TOKEN_PROGRAM,
  fetchPoolConfig: fetchInvariantPoolConfig,
};

// ---------------------------------------------------------------------------
// Ladder (fragment emission + reference mirror).
// ---------------------------------------------------------------------------
const SWAP_DISCRIMINATOR = [248, 198, 158, 145, 225, 117, 135, 200]; // sha256('global:swap')[0..8]
const WALK_BOUND = INVARIANT_MAX_BOUNDARIES + 1;
// discriminator bytes LE-decoded to the same unsigned integer accountUint(ref, 0, 8) would read.
const TICK_DISC_U64 = TICK_DISCRIMINATOR.reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);

function invariantConfig(cfg: PoolConfig): InvariantPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as InvariantPoolConfig;
}

interface LiveState {
  l: bigint;
  sp: bigint;
  fee: bigint;
}
function liveFromState(cfg: InvariantPoolConfig, state: AccountBytesMap): LiveState {
  const pool = state[cfg.pool];
  if (pool === undefined) throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
  return {
    l: readUintLE(pool, OFF_LIQUIDITY, 16),
    sp: readUintLE(pool, OFF_SQRT_PRICE, 16),
    fee: readUintLE(pool, OFF_FEE, 16),
  };
}

interface EffectiveWindow {
  valid: boolean;
  targets: bigint[];
  signs: boolean[];
  liquidityChanges: bigint[];
}

/** Live-verified boundary set: drops any shipped boundary the live price has already passed, or whose account went stale. */
function effectiveWindow(cfg: InvariantPoolConfig, state: AccountBytesMap, live: LiveState): EffectiveWindow {
  const xToY = cfg.direction === 'xToY';
  const window = invariantWindowFor(cfg);
  const result: EffectiveWindow = { valid: false, targets: [], signs: [], liquidityChanges: [] };
  for (const boundary of window.boundaries) {
    const keep = xToY ? boundary.sqrtPrice < live.sp : boundary.sqrtPrice > live.sp;
    if (!keep) continue;
    const data = state[boundary.address];
    if (data === undefined) throw new Error(`${SLUG} ladder reference is missing account ${boundary.address}`);
    if (readUintLE(data, 0, 8) !== TICK_DISC_U64) continue; // stale/foreign account since prepare — skip it
    result.targets.push(boundary.sqrtPrice);
    result.signs.push(readUintLE(data, OFF_TICK_SIGN, 1) === 1n);
    result.liquidityChanges.push(readUintLE(data, OFF_TICK_LIQUIDITY_CHANGE, 16));
  }
  result.valid = live.l > 0n; // even zero shipped boundaries can still quote a single unbounded-by-tick segment
  return result;
}

interface Cursor {
  sp: bigint;
  l: bigint;
  k: number;
  exhausted: boolean;
  out: bigint;
}

/** One compute_swap_step segment against boundary k (or, past the shipped set, treated as exhausted — never an unbounded synthetic edge). */
function walkStep(cursor: Cursor, win: EffectiveWindow, fee: bigint, xToY: boolean, rm: bigint): bigint {
  if (cursor.k >= win.targets.length) {
    cursor.exhausted = true;
    return rm;
  }
  const step = invariantComputeSwapStepIn(cursor.sp, win.targets[cursor.k]!, cursor.l, rm, fee);
  const spent = step.amountIn + step.feeAmount;
  if (spent > rm) {
    cursor.exhausted = true;
    return rm;
  }
  rm -= spent;
  cursor.out += step.amountOut;
  cursor.sp = step.nextSqrt;
  if (cursor.sp !== win.targets[cursor.k]) {
    // Partial fill inside this segment (rm is already 0 by construction — see
    // invariantComputeSwapStepIn's notMax branch, feeAmount = amount - amountIn
    // makes spent === rm exactly). NOT a failure: the outer loop's `rm > 0n`
    // condition stops naturally here without crossing this tick.
    return rm;
  }
  const positive = win.signs[cursor.k]!;
  const change = win.liquidityChanges[cursor.k]!;
  const add = xToY ? !positive : positive;
  if (add) {
    cursor.l += change;
  } else {
    if (cursor.l < change) {
      cursor.exhausted = true;
      return rm;
    }
    cursor.l -= change;
  }
  cursor.k += 1;
  return rm;
}

function coldWalk(win: EffectiveWindow, live: LiveState, xToY: boolean, x: bigint): bigint | null {
  if (!win.valid || x === 0n) return x === 0n ? 0n : null;
  const cursor: Cursor = { sp: live.sp, l: live.l, k: 0, exhausted: false, out: 0n };
  let rm = x;
  for (let it = 0; it < WALK_BOUND && rm > 0n && !cursor.exhausted; it++) rm = walkStep(cursor, win, live.fee, xToY, rm);
  return cursor.exhausted || rm > 0n ? null : cursor.out;
}

function coldWalkClamped(win: EffectiveWindow, live: LiveState, xToY: boolean, x: bigint): { out: bigint; cap: bigint } {
  if (!win.valid || x <= 0n) return { out: 0n, cap: 0n };
  const cursor: Cursor = { sp: live.sp, l: live.l, k: 0, exhausted: false, out: 0n };
  let rm = x;
  for (let it = 0; it < WALK_BOUND && rm > 0n && !cursor.exhausted; it++) rm = walkStep(cursor, win, live.fee, xToY, rm);
  return { out: cursor.out, cap: x - rm };
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

/** Emits one compute_swap_step segment against boundary k's locals (target/sign/liquidityChange already bound). */
function emitWalkStep(p: string, xToY: boolean, k: number, v: { sp: string; l: string; ex: string; out: string; rm: string }, indent: string): string[] {
  const dxUp = (lo: string, hi: string) => `ivDeltaX(${lo}, ${hi}, ${v.l}, 1)`;
  const dyUp = (lo: string, hi: string) => `ivDeltaY(${lo}, ${hi}, ${v.l}, 1)`;
  const tg = `${p}tg${k}`;
  return [
    `${indent}${p}ca = (${v.rm} * (${p}fn)) / 1000000000000;`,
    `${indent}${p}fx = ${xToY ? dxUp(tg, v.sp) : dyUp(v.sp, tg)};`,
    `${indent}if (${p}fx <= ${p}ca) {`,
    `${indent}  ${p}nx = ${tg};`,
    `${indent}  ${p}i2 = ${p}fx;`,
    `${indent}} else {`,
    `${indent}  ${p}nx = ${xToY ? `ivNextXUp(${v.sp}, ${v.l}, ${p}ca)` : `ivNextYDown(${v.sp}, ${v.l}, ${p}ca)`};`,
    `${indent}  ${p}i2 = ${xToY ? dxUp(`${p}nx`, v.sp) : dyUp(v.sp, `${p}nx`)};`,
    `${indent}}`,
    `${indent}${p}ou = ${xToY ? `ivDeltaY(${p}nx, ${v.sp}, ${v.l}, 0)` : `ivDeltaX(${v.sp}, ${p}nx, ${v.l}, 0)`};`,
    `${indent}if (${p}nx === ${tg}) { ${p}fe = (${p}i2 * ${p}fee + 999999999999) / 1000000000000; }`,
    `${indent}else { ${p}fe = ${v.rm} - ${p}i2; }`,
    `${indent}if (${p}i2 + ${p}fe > ${v.rm}) { ${v.ex} = 1; }`,
    `${indent}else {`,
    `${indent}  ${v.rm} = ${v.rm} - ${p}i2 - ${p}fe;`,
    `${indent}  ${v.out} = ${v.out} + ${p}ou;`,
    `${indent}  ${v.sp} = ${p}nx;`,
    // Partial fill (nx !== target): rm is already 0 by construction (fe = rm -
    // i2 above), so the NEXT boundary's block simply skips on its own `rm > 0`
    // guard — no exhausted flag needed, this is a normal successful terminal.
    `${indent}  if (${p}nx === ${tg}) {`,
    // Cross-tick liquidity update (structs/util.rs's cross_tick, reduced for a
    // directed single-pass walk — see header): xToY subtracts on sign=1/adds on
    // sign=0; yToX is the mirror.
    ...(xToY
      ? [
          `${indent}    if (${p}sg${k} === 1) { if (${v.l} < ${p}ln${k}) { ${v.ex} = 1; } else { ${v.l} = ${v.l} - ${p}ln${k}; } }`,
          `${indent}    else { ${v.l} = ${v.l} + ${p}ln${k}; }`,
        ]
      : [
          `${indent}    if (${p}sg${k} === 1) { ${v.l} = ${v.l} + ${p}ln${k}; }`,
          `${indent}    else { if (${v.l} < ${p}ln${k}) { ${v.ex} = 1; } else { ${v.l} = ${v.l} - ${p}ln${k}; } }`,
        ]),
    `${indent}  }`,
    `${indent}}`,
  ];
}

export const invariantLadder: SvmVenueLadderV2 = {
  slug: SLUG,
  defaultRungs: 2,
  shapeKey(base) {
    const cfg = invariantConfig(base);
    return `${SLUG}:${cfg.direction}:${invariantWindowFor(cfg).boundaries.length}`;
  },
  helpers() {
    return [
      {
        name: 'ivDeltaX',
        source: [
          'function ivDeltaX(a, b, l, up) {',
          '  const dp = a > b ? a - b : b - a;',
          '  const nom = (dp * l) / 1000000;',
          '  if (up !== 0) {',
          '    const den = (a * b) / 1000000000000000000000000;',
          '    const s1 = (nom * 1000000000000000000000000 + den - 1) / den;',
          '    return (s1 + 999999999999999999999999) / 1000000000000000000000000;',
          '  }',
          '  const den = (a * b + 999999999999999999999999) / 1000000000000000000000000;',
          '  return (nom * 1000000000000000000000000) / den / 1000000000000000000000000;',
          '}',
        ].join('\n'),
      },
      {
        name: 'ivDeltaY',
        source: [
          'function ivDeltaY(a, b, l, up) {',
          '  const dp = a > b ? a - b : b - a;',
          '  if (up !== 0) {',
          '    const s1 = (dp * l + 999999) / 1000000;',
          '    return (s1 + 999999999999999999999999) / 1000000000000000000000000;',
          '  }',
          '  return (dp * l) / 1000000 / 1000000000000000000000000;',
          '}',
        ].join('\n'),
      },
      {
        name: 'ivNextXUp',
        source: [
          'function ivNextXUp(price, l, amount) {',
          '  if (amount === 0) { return price; }',
          '  const bigL = l * 1000000000000000000;',
          '  const den = bigL + price * amount;',
          '  const nom = (price * l + 999999) / 1000000;',
          '  return (nom * 1000000000000000000000000 + den - 1) / den;',
          '}',
        ].join('\n'),
      },
      {
        name: 'ivNextYDown',
        source: [
          'function ivNextYDown(price, l, amount) {',
          '  if (amount === 0) { return price; }',
          '  const num = amount * 1000000000000000000000000 * 1000000000000000000000000;',
          '  const den = l * 1000000000000000000;',
          '  return price + num / den;',
          '}',
        ].join('\n'),
      },
    ];
  },
  // Per boundary: sqrtPrice hi (u64) + sqrtPrice lo (u64). No index/liquidity params — those are read
  // LIVE from each boundary's own dedicated account ref (a per-boundary literal ref, not a shared
  // array requiring a byte-offset/index param the way defituna/raydium-clmm need).
  paramCount: INVARIANT_MAX_BOUNDARIES * 2,
  paramsFor(base) {
    const window = invariantWindowFor(invariantConfig(base));
    const words: bigint[] = [];
    for (let k = 0; k < INVARIANT_MAX_BOUNDARIES; k++) {
      const boundary = window.boundaries[k];
      if (boundary === undefined) {
        words.push(0n, 0n);
        continue;
      }
      words.push(boundary.sqrtPrice >> 64n, boundary.sqrtPrice & ((1n << 64n) - 1n));
    }
    return words;
  },
  quoteRefs(base, slot) {
    const cfg = invariantConfig(base);
    const window = invariantWindowFor(cfg);
    return [
      { ref: ref(slot, 'pool'), address: cfg.pool },
      ...window.boundaries.map((boundary, i) => ({ ref: ref(slot, `t${i}`), address: boundary.address }) as VenueAccount),
    ];
  },
  emitSetup(base, slot, params, enableVar) {
    const cfg = invariantConfig(base);
    const window = invariantWindowFor(cfg);
    const xToY = cfg.direction === 'xToY';
    const p = `s${slot}`;
    const pool = JSON.stringify(ref(slot, 'pool'));
    const enabled = enableVar ?? `${p}en`;
    const lines: string[] = [
      `  const ${p}l0 = accountUint(${pool}, ${OFF_LIQUIDITY}, 16);`,
      `  const ${p}sp0 = accountUint(${pool}, ${OFF_SQRT_PRICE}, 16);`,
      `  const ${p}fee = accountUint(${pool}, ${OFF_FEE}, 16);`,
      `  const ${p}fn = 1000000000000 - ${p}fee;`,
      `  let ${p}nb = 0;`,
    ];
    for (let k = 0; k < window.boundaries.length; k++) {
      const tickRef = JSON.stringify(ref(slot, `t${k}`));
      const targetHi = params[2 * k]!;
      const targetLo = params[2 * k + 1]!;
      const target = `((${targetHi}) << 64) | (${targetLo})`;
      const keep = xToY ? `${p}tg${k} < ${p}sp0` : `${p}tg${k} > ${p}sp0`;
      lines.push(
        `  const ${p}tg${k} = ${target};`,
        `  let ${p}sg${k} = 0; let ${p}ln${k} = 0; let ${p}ok${k} = 0;`,
        `  if (${enabled} !== 0 && (${keep})) {`,
        `    if (accountUint(${tickRef}, 0, 8) === ${TICK_DISC_U64}) {`,
        `      ${p}sg${k} = accountUint(${tickRef}, ${OFF_TICK_SIGN}, 1);`,
        `      ${p}ln${k} = accountUint(${tickRef}, ${OFF_TICK_LIQUIDITY_CHANGE}, 16);`,
        `      ${p}ok${k} = 1;`,
        `      ${p}nb = ${p}nb + 1;`,
        `    }`,
        `  }`,
      );
    }
    lines.push(`  let ${p}vld = 0;`, `  if (${p}l0 > 0) { ${p}vld = 1; }`);
    lines.push(
      `  let ${p}t1 = 0; let ${p}ca = 0; let ${p}fx = 0; let ${p}nx = 0; let ${p}i2 = 0; let ${p}ou = 0; let ${p}fe = 0;`,
      `  let ${p}wsp = 0; let ${p}wl = 0; let ${p}wex = 0; let ${p}wout = 0; let ${p}rm = 0;`,
      `  let ${p}lo = 0; let ${p}lx = 0; let ${p}wcx = 0;`,
    );
    return lines.join('\n');
  },
  emitLadderQuote(base, slot, rung, x, outVar) {
    const cfg = invariantConfig(base);
    const window = invariantWindowFor(cfg);
    const xToY = cfg.direction === 'xToY';
    const p = `s${slot}`;
    const v = { sp: `${p}wsp`, l: `${p}wl`, ex: `${p}wex`, out: `${p}wout`, rm: `${p}rm` };
    const lines: string[] = [
      `    if (${p}vld !== 0 && ${p}wcx === 0 && ${x} > 0) {`,
      `      ${v.sp} = ${p}sp0; ${v.l} = ${p}l0; ${v.ex} = 0; ${v.out} = 0;`,
      `      ${v.rm} = ${x};`,
    ];
    for (let k = 0; k < window.boundaries.length; k++) {
      lines.push(`      if (${v.ex} === 0 && ${v.rm} > 0 && ${p}ok${k} !== 0) {`, ...emitWalkStep(p, xToY, k, v, '        '), `      }`);
    }
    lines.push(
      `      if (${v.ex} === 0 && ${v.rm} === 0) { ${p}lo = ${v.out}; ${p}lx = ${x}; }`,
      `      else { ${p}lo = ${v.out}; ${p}lx = ${x} - ${v.rm}; ${p}wcx = 1; }`,
      `    }`,
      `    const ${outVar} = ${p}lo;`,
    );
    return lines.join('\n');
  },
  capacityInputVar(slot) {
    return `s${slot}lx`;
  },
  emitFinalQuote(base, slot, x, outVar) {
    const cfg = invariantConfig(base);
    const window = invariantWindowFor(cfg);
    const xToY = cfg.direction === 'xToY';
    const p = `s${slot}`;
    const v = { sp: `${p}fsp`, l: `${p}fl`, ex: `${p}fex`, out: `${p}fo`, rm: `${p}frm` };
    const lines: string[] = [
      `  let ${outVar} = 0;`,
      `  if (${p}vld !== 0 && ${x} > 0) {`,
      `    if (${p}lx === ${x}) { ${outVar} = ${p}lo; }`,
      `    else {`,
      `      let ${v.sp} = ${p}sp0; let ${v.l} = ${p}l0; let ${v.ex} = 0; let ${v.out} = 0;`,
      `      let ${v.rm} = ${x};`,
    ];
    for (let k = 0; k < window.boundaries.length; k++) {
      lines.push(`      if (${v.ex} === 0 && ${v.rm} > 0 && ${p}ok${k} !== 0) {`, ...emitWalkStep(p, xToY, k, v, '        '), `      }`);
    }
    lines.push(`      if (${v.ex} === 0 && ${v.rm} === 0) { ${outVar} = ${v.out}; }`, `    }`, `  }`);
    return lines.join('\n');
  },
  buildSwapV2(base, slot, user: SwapUser): LadderSwapTemplate {
    const cfg = invariantConfig(base);
    const window = invariantWindowFor(cfg);
    const xToY = cfg.direction === 'xToY';
    // swap: disc(8) ++ x_to_y bool(1, static) ++ amount u64 LE (runtime-patched) ++
    // by_amount_in bool(1) = 1 ++ sqrt_price_limit u128 LE = 0 (the shipped-window
    // capacity clamp keeps the walk inside crossable ticks; a real revert past that
    // is caught the same way every other ladder's quote-vs-execution drift is —
    // minOut is the terminal floor).
    const prefix = new Uint8Array(8 + 1);
    prefix.set(SWAP_DISCRIMINATOR, 0);
    prefix[8] = xToY ? 1 : 0;
    const suffix = new Uint8Array(1 + 16);
    suffix[0] = 1; // by_amount_in = true
    const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
    return {
      programId: INVARIANT_PROGRAM_ID,
      prefix,
      suffix,
      patch: 'in',
      accounts: [
        roled('state', STATE_PDA),
        roled('pool', cfg.pool, true),
        roled('tickmap', cfg.tickmap, true),
        { ref: xToY ? user.inAta : user.outAta, writable: true }, // account_x
        { ref: xToY ? user.outAta : user.inAta, writable: true }, // account_y
        roled('rx', cfg.tokenXReserve, true),
        roled('ry', cfg.tokenYReserve, true),
        { ref: user.owner, signer: true }, // owner
        roled('auth', PROGRAM_AUTHORITY),
        roled('tp', TOKEN_PROGRAM),
        ...window.boundaries.map((boundary, i) => roled(`t${i}`, boundary.address, true)),
      ],
    };
  },
  /**
   * THE COLD-QUOTE COLLAPSE — FIXED. Used to be `coldWalk(...) ?? 0n`:
   * coldWalk requires x to be FULLY absorbed by the shipped boundary window
   * to return non-null, so any x exceeding the window's capacity collapsed
   * straight to 0 instead of the window's own true saturated output —
   * violating "nondecreasing in x, quote(0)=0" (see
   * test/svm/venues/invariant.test.ts for the real-fixture measurement).
   * coldWalkClamped runs the identical walk but never returns null — for any
   * x already within capacity it returns the exact same `.out` coldWalk
   * would have, and for x beyond capacity it returns the window's true
   * saturated output instead of nothing. referenceLadderQuotes/
   * referenceCapacities below already use it.
   */
  referenceQuote(base, state, params) {
    const cfg = invariantConfig(base);
    const xToY = cfg.direction === 'xToY';
    const live = liveFromState(cfg, state);
    const win = effectiveWindow(cfg, state, live);
    return (x: bigint) => coldWalkClamped(win, live, xToY, x).out;
  },
  referenceLadderQuotes(base, state, params) {
    const cfg = invariantConfig(base);
    const xToY = cfg.direction === 'xToY';
    const live = liveFromState(cfg, state);
    const win = effectiveWindow(cfg, state, live);
    return (grid: readonly bigint[]) => {
      let lo = 0n;
      let capped = false;
      return grid.map((g) => {
        if (win.valid && !capped && g > 0n) {
          const { out, cap } = coldWalkClamped(win, live, xToY, g);
          lo = out;
          if (cap < g) capped = true;
        }
        return lo;
      });
    };
  },
  referenceCapacities(base, state, params) {
    const cfg = invariantConfig(base);
    const xToY = cfg.direction === 'xToY';
    const live = liveFromState(cfg, state);
    const win = effectiveWindow(cfg, state, live);
    return (grid: readonly bigint[]) => {
      let cap = 0n;
      let capped = false;
      return grid.map((g) => {
        if (win.valid && !capped && g > 0n) {
          const clamped = coldWalkClamped(win, live, xToY, g);
          cap = clamped.cap;
          if (clamped.cap < g) capped = true;
        }
        return cap;
      });
    };
  },
  depthReserves(base, state) {
    const cfg = invariantConfig(base);
    const live = liveFromState(cfg, state);
    if (live.sp === 0n) return { reserveIn: 0n, reserveOut: 0n };
    // x_real = L*1e18/sqrtP ; y_real = L*sqrtP/1e30 (raw TokenAmount units — see header derivation).
    const x = (live.l * PRICE_LIQUIDITY_DENOMINATOR) / live.sp;
    const y = (live.l * live.sp) / (PRICE_ONE * LIQ_ONE);
    return cfg.direction === 'xToY' ? { reserveIn: x, reserveOut: y } : { reserveIn: y, reserveOut: x };
  },
  continuousFees(base, state) {
    const cfg = invariantConfig(base);
    const live = liveFromState(cfg, state);
    const feePpm = live.fee / 1_000_000n; // fee is 1e12-scaled; ppm is 1e6-scaled
    return { gammaPpm: 1_000_000n - feePpm, muPpm: 1_000_000n };
  },
};
