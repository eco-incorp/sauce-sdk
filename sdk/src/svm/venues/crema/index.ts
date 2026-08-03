/**
 * Crema Finance (`crema.finance`) — a Solana CLMM whose account layout, tick
 * math and swap-step fee model are a BYTE-IDENTICAL clone of Orca Whirlpool's
 * (program `CLMM9tUoggJu2wagPkkqs9eFG4BWhVBZWkP1qv3Sp7tR`; TypeScript SDK
 * `@cremafinance/crema-sdk-v2`, mirrored verbatim in the community fork
 * `github.com/jup-ag/crema-clmm-sdk-v2` this module's layout/math was
 * cross-verified against). 27 pools live on mainnet at integration time
 * (`getProgramAccounts` filtered on `dataSize:748`) — thin, per the venue
 * brief; shipped anyway, survivorship (the relative-depth filter) decides.
 *
 * LAYOUT — Clmmpool account (748 bytes total incl. 8-byte Anchor
 * discriminator; VALIDATED against a real mainnet dump, pool
 * `DV569UDdnjkYWJDnpJfJZE4HyzYKYyRGowtdPQrFUZpm`, SOL/USDC ts=50):
 * discriminator sha256('account:Clmmpool')[0..8] = aa a0 21 7a 95 d9 b7 f4 @0,
 * clmm_config pubkey@8, token_a (MINT) pubkey@40, token_b (MINT) pubkey@72,
 * token_a_vault pubkey@104, token_b_vault pubkey@136, tick_spacing u16@168,
 * tick_spacing_seed [u8;2]@170, fee_rate u16@172, liquidity u128@174,
 * current_sqrt_price u128@190, current_tick_index i32@206,
 * fee_growth_global_{a,b} u128@210/226, fee_protocol_token_{a,b} u64@242/250,
 * bump [u8;1]@258, rewarder_infos [Rewarder;3]@259 (160 bytes each = 480),
 * rewarder_last_updated_time u64@739, is_pause bool@747. Every offset here was
 * confirmed field-for-field against the live account (clmm_config/token_a/
 * token_b/vaults decode to real, sensible pubkeys; tick_spacing_seed ==
 * tick_spacing's own LE bytes).
 *
 * TickArray account (8556 bytes, FIXED length — unlike DefiTuna's
 * Whirlpool-lineage variable-length encoding, Crema keeps Whirlpool's own
 * fixed-stride design): discriminator sha256('account:TickArray')[0..8] =
 * 45 61 bd be 6e 07 42 bb (IDENTICAL bytes to Whirlpool's own TickArray
 * discriminator — Anchor's discriminator is a pure function of the account
 * TYPE NAME, and Crema's IDL names it `TickArray` too), array_index u16@8,
 * tick_spacing u16@10, clmmpool pubkey@12, ticks[64]@44 (133 bytes/tick:
 * is_initialized bool + index i32 + sqrt_price u128 + liquidity_net i128 +
 * liquidity_gross u128 + fee_growth_outside_{a,b} u128 + reward_growth_outside
 * [u128;3] = 1+4+16+16+16+16+16+48). Confirmed against 5 live tick arrays: the
 * `array_index`/`tick_spacing`/`clmmpool` header fields decode exactly as
 * expected, and every initialized tick's on-chain `sqrt_price` matches
 * `whirlpoolSqrtPriceAtTick(index)` (the SAME Q64.64 bit-table math this
 * module reuses from orca-whirlpool) bit-for-bit.
 *
 * TickArrayMap account (876 bytes: 8-byte disc + an 868-byte BITMAP, one bit
 * per possible array index, up to 6944 slots) — THE KEY STRUCTURAL DIVERGENCE
 * FROM WHIRLPOOL/DEFITUNA: Crema's own swap-account-selection helper
 * (`math/clmm.ts`'s `getSwapTickArrays`, the code path the real client SDK
 * uses to build a live transaction) does NOT walk consecutive array indices —
 * it SCANS THE BITMAP for the nearest ALLOCATED array in the walk direction,
 * SKIPPING any unallocated index in between, collecting up to 3. This module
 * replicates that scan exactly (`resolveWindow` below) rather than
 * Whirlpool/DefiTuna's plain ±1/±2-consecutive convention — using the
 * consecutive convention here would ship the WRONG tick array PDAs whenever a
 * gap exists between allocated arrays (confirmed live: the validation pool's
 * bitmap has only 16 of 6944 possible bits set, e.g. arrays 128-135 then a
 * gap to 138, then 153, then 277 — dense assumption would miss real
 * liquidity). `TickUtil.getArrayIndex`/`getStartTickIndex` (array index <->
 * tick-range mapping) anchor array 0 at `MIN_TICK_INDEX + (443636 %
 * tickSpacing)` — NOT at tick 0 the way Whirlpool's own convention does —
 * confirmed by deriving the PDA for the computed index and finding the real
 * account there with a matching `array_index` field.
 *
 * PDA seeds (`utils/pda.ts`): tick_array_map = ['tick_array_map', pool];
 * tick_array = ['tick_array', pool, arrayIndex as 2-byte LE] — ARRAY INDEX,
 * not Whirlpool's start-tick-as-ASCII-STRING scheme. clmm_config is not a
 * PDA at all here — it's a plain pubkey FIELD on the pool account (read
 * directly, no derivation).
 *
 * Swap instruction (`swap`, Anchor discriminator sha256('global:swap')[0..8]
 * = f8 c6 9e 91 e1 75 87 c8 — IDENTICAL bytes to Whirlpool's own `swap` disc,
 * again because Anchor's discriminator depends only on the snake_case
 * instruction NAME): args are `a_to_b: bool, by_amount_in: bool, amount: u64,
 * amount_limit: u64, sqrt_price_limit: u128` — NOTE THE ARG ORDER: the two
 * bools sit BEFORE `amount`, unlike Whirlpool's `amount` first. Accounts:
 * clmm_config(r), clmmpool(w), token_a(r, MINT), token_b(r, MINT),
 * account_a(w, user ATA), account_b(w, user ATA), token_a_vault(w),
 * token_b_vault(w), tick_array_map(w), owner(signer), token_program(r), then
 * up to 3 tick arrays as remaining accounts (w) in walk order. `account_a`/
 * `account_b` are ALWAYS the user's token-A/token-B accounts respectively
 * (fixed by MINT, not by input/output side) — `a_to_b` alone selects debit
 * vs credit internally.
 *
 * VALIDATED bit-exact against the REAL crema.so binary (dumped from
 * mainnet-beta) executing on this module's own mainnet snapshot
 * (test/svm/fixtures/crema/) via LiteSVM — NOT a disclosed-residual case
 * like DefiTuna's: every size below matched the real program to the last
 * digit once the harness compared against a FRESH copy of the pool state per
 * size (an earlier pass of this validation reused one mutated LiteSVM
 * instance across sizes and manufactured a spurious ~2% "residual" purely
 * from comparing against stale, already-swapped state — a test-methodology
 * bug, not a venue quirk; corrected before these numbers were pinned). A
 * second real bug this validation caught (fixed, not disclosed-residual):
 * `liquidity_net`'s tick-relative byte offset is 21 here (index + sqrt_price
 * precede it — see the Tick field list above), NOT 1 the way orca-whirlpool's
 * own Tick struct packs it; reusing whirlpool's offset verbatim silently read
 * sqrt_price bytes as liquidity_net and manufactured a spurious "exhausted"
 * abort on the FIRST tick crossing, at any size that crossed one.
 *   aToB (SOL -> USDC): 0.05 SOL -> 3_664_448; 0.2 SOL -> 14_638_354 (crosses
 *     tick -26150); 1 SOL -> 72_681_306 (crosses -26150); 5 SOL -> 351_168_050
 *     (crosses -26150, -26650) — all bit-exact.
 *   bToA (USDC -> SOL): 50/200 USDC -> 675_134_472 / 2_653_858_762 lamports
 *     SOL, bit-exact. At 1000 USDC the real program continues realizing
 *     12_246_501_046 (crossing -25850/-25800/-25350/-24650 then on into the
 *     NEXT shipped tick array) while this ladder's off-chain model returns 0
 *     (self-deactivates): CREMA_MAX_BOUNDARIES(4) is entirely consumed by
 *     array0's own four upward ticks before the scan ever reaches array1's
 *     content, even though array1's account already rides the transaction —
 *     the SAME shared-budget-across-arrays limitation orca-whirlpool's own
 *     header documents (a fixed boundary count, not per-array), not a defect
 *     introduced here. Backstopped by minOut like every other venue's
 *     quote-vs-window-capacity edge in this repo.
 * A genuinely venue-specific-FEELING but actually general mechanism worth
 * recording for whoever next builds a synthetic-state CLMM harness (found
 * while validating bToA above, off the committed test path — this repo's
 * shipped real-CPI lane, the consuming app realcpi e2e test, only exercises this
 * venue's aToB direction, matching every sibling venue cell there): crediting
 * a native-mint (wSOL) OUTPUT account during a real swap CPI moves REAL
 * LAMPORTS out of the vault (not just the SPL "amount" data field the way a
 * plain non-native transfer does) — a LiteSVM fixture whose wSOL vault is
 * given only the generic rent-exempt-minimum lamports (what
 * `fixtureAccounts()` assigns by default, ignoring each account's true
 * captured balance) throws `UnbalancedInstruction` the moment a bToA swap
 * tries to pay it out. The fix is giving the vault its REAL lamports
 * (rent-exempt reserve + its own stated wSOL `amount` field) before a bToA
 * real-CPI run. This is not Crema-specific (it is how wrapped SOL generally
 * works), but every existing venue's real-CPI cell in this repo happens to
 * sell SOL rather than buy it, so this had not been hit before.
 *
 * Gates (named errors, everything else is a live read):
 * - account size / discriminator (pool, tick array, tick array map);
 * - non-Tokenkeg mints (the swap ix's `token_program` account is a single
 *   fixed program — Tokenkeg only, no Token-2022 variant in this IDL);
 * - `is_pause` set on the pool (an administrative halt — not a drift
 *   condition, a real venue-level shutdown; loud, not a self-drop class);
 * - a direction with NO shipped boundaries and no edge (readable === 0) —
 *   wired via SvmWindowDriftError like orca-whirlpool/meteora-dlmm.
 */
import { address, getAddressCodec, getProgramDerivedAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { MAX_TICK_INDEX, MIN_TICK_INDEX, whirlpoolSqrtPriceAtTick } from '../orca-whirlpool/tick-math.js';
import { orcaWhirlpoolLadder, whirlpoolDeltaA, whirlpoolDeltaB, whirlpoolNextSqrtA } from '../orca-whirlpool/ladder.js';
import { readUintLE } from '../math.js';
import type { AccountBytesMap, AccountLoader, LadderSwapTemplate, PoolConfig, SvmVenueLadder, SwapUser, VenueAccount } from '../types.js';

const SLUG = 'crema';
export const CREMA_PROGRAM_ID = address('CLMM9tUoggJu2wagPkkqs9eFG4BWhVBZWkP1qv3Sp7tR');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

export const CLMMPOOL_ACCOUNT_SIZE = 748;
/** sha256('account:Clmmpool')[0..8]. */
export const CLMMPOOL_DISCRIMINATOR = [0xaa, 0xa0, 0x21, 0x7a, 0x95, 0xd9, 0xb7, 0xf4];
export const TICK_ARRAY_ACCOUNT_SIZE = 8556;
/** sha256('account:TickArray')[0..8] — byte-identical to orca-whirlpool's own (name-derived, not program-derived). */
export const TICK_ARRAY_DISCRIMINATOR = [0x45, 0x61, 0xbd, 0xbe, 0x6e, 0x07, 0x42, 0xbb];
export const TICK_ARRAY_MAP_ACCOUNT_SIZE = 876;
/** sha256('account:TickArrayMap')[0..8]. */
export const TICK_ARRAY_MAP_DISCRIMINATOR = [0x6c, 0xcb, 0x30, 0xa5, 0x74, 0xd5, 0x60, 0xdd];
export const TICK_ARRAY_SIZE = 64;
export { MAX_TICK_INDEX, MIN_TICK_INDEX };

// Clmmpool offsets (declared-field order, Borsh-packed, no padding).
const OFF_CLMM_CONFIG = 8;
const OFF_MINT_A = 40;
const OFF_MINT_B = 72;
const OFF_VAULT_A = 104;
const OFF_VAULT_B = 136;
export const OFF_TICK_SPACING = 168;
export const OFF_FEE_RATE = 172;
export const OFF_LIQUIDITY = 174;
export const OFF_SQRT_PRICE = 190;
export const OFF_TICK_CURRENT = 206;
const OFF_IS_PAUSE = 747;

// TickArray offsets.
export const OFF_TA_ARRAY_INDEX = 8;
const OFF_TA_TICK_SPACING = 10;
const OFF_TA_CLMMPOOL = 12;
export const OFF_TA_TICKS = 44;
export const TICK_LEN = 133;
/**
 * Tick-relative byte offset of `liquidity_net` (i128): is_initialized(1) +
 * index(4) + sqrt_price(16) = 21. UNLIKE orca-whirlpool/defituna, where
 * liquidity_net sits immediately after the init flag (tick-relative offset
 * 1) — Crema's own Tick struct declares index/sqrt_price BEFORE
 * liquidity_net (see the module header's field list), so this offset is
 * NOT reusable from the whirlpool convention this file otherwise mirrors.
 */
const TICK_LIQUIDITY_NET_OFFSET = 21;

// TickArrayMap: 8-byte disc + 868-byte bitmap, one bit per possible array index.
const TICK_ARRAY_MAP_BITMAP_OFFSET = 8;
const TICK_ARRAY_MAP_MIN_BIT_INDEX = 0;
const TICK_ARRAY_MAP_MAX_BIT_INDEX = 868 * 8 - 1; // 6943

/** Shipped initialized-tick boundaries per direction — same budget class as orca-whirlpool/raydium-clmm. */
export const CREMA_MAX_BOUNDARIES = 4;
/** Up to 3 tick-array PDAs ride a window, same as orca-whirlpool/raydium-clmm/defituna. */
const CREMA_MAX_ARRAYS = 3;

const BIAS = 2147483648n; // 2^31 tick bias
const M32 = 4294967295n;

export interface CremaBoundary {
  /** Index (0..2) into this window's `tickArrays`/`startTicks` — NOT the real Crema array index. */
  arrayIndex: number;
  /** Slot offset (0..63) within that tick array. */
  offset: number;
  tick: number;
  sqrtPrice: bigint;
}

export interface CremaWindow {
  tickArrays: [Address, Address, Address];
  /** Real Crema array indices the 3 slots above resolve to (bitmap-scan order, may be non-consecutive). */
  arrayIndices: [number, number, number];
  startTicks: [number, number, number];
  boundaries: CremaBoundary[];
  edge: { tick: number; sqrtPrice: bigint } | null;
  /** Contiguous PREFIX of tickArrays that existed as real, valid TickArray accounts at prepare. */
  readable: number;
}

export interface CremaPoolConfig extends PoolConfig {
  venue: typeof SLUG;
  direction: 'aToB' | 'bToA';
  tokenMintA: Address;
  tokenMintB: Address;
  tokenVaultA: Address;
  tokenVaultB: Address;
  clmmConfig: Address;
  tickArrayMap: Address;
  tickSpacing: number;
  feeRate: number;
  liquidity: bigint;
  sqrtPrice: bigint;
  tickCurrentIndex: number;
  windows: { aToB: CremaWindow; bToA: CremaWindow };
}

/** The direction's window (the ladder adapter and the orchestrator gate read through this). */
export function cremaWindowFor(cfg: CremaPoolConfig): CremaWindow {
  return cfg.direction === 'aToB' ? cfg.windows.aToB : cfg.windows.bToA;
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
async function deriveTickArrayMapPda(pool: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: CREMA_PROGRAM_ID,
    seeds: [new TextEncoder().encode('tick_array_map'), getAddressEncoded(pool)],
  });
  return pda;
}
async function deriveTickArrayPda(pool: Address, arrayIndex: number): Promise<Address> {
  const idxBytes = new Uint8Array(2);
  idxBytes[0] = arrayIndex & 0xff;
  idxBytes[1] = (arrayIndex >> 8) & 0xff;
  const [pda] = await getProgramDerivedAddress({
    programAddress: CREMA_PROGRAM_ID,
    seeds: [new TextEncoder().encode('tick_array'), getAddressEncoded(pool), idxBytes],
  });
  return pda;
}

/** floor division toward negative infinity (Crema's own TickUtil.getMinIndex/getArrayIndex). */
const floorDiv = (a: number, b: number): number => Math.floor(a / b);
/** TickUtil.getMinIndex: array 0 is anchored here, NOT at tick 0 (Whirlpool's convention). */
function minIndexFor(tickSpacing: number): number {
  return MIN_TICK_INDEX + (Math.abs(MIN_TICK_INDEX) % tickSpacing);
}
function arrayIndexOf(tick: number, tickSpacing: number): number {
  return floorDiv(tick - minIndexFor(tickSpacing), TICK_ARRAY_SIZE * tickSpacing);
}
function startTickOf(arrayIndex: number, tickSpacing: number): number {
  return minIndexFor(tickSpacing) + TICK_ARRAY_SIZE * tickSpacing * arrayIndex;
}

function bitmapBitSet(mapData: Uint8Array, index: number): boolean {
  const byteIdx = TICK_ARRAY_MAP_BITMAP_OFFSET + Math.floor(index / 8);
  const bit = index % 8;
  return ((mapData[byteIdx] ?? 0) >> bit) % 2 === 1;
}

/**
 * Scan the TickArrayMap bitmap for up to CREMA_MAX_ARRAYS allocated array
 * indices in the walk direction, SKIPPING unallocated ones (see header — this
 * is Crema's own `getSwapTickArrays` behavior, not Whirlpool's plain
 * consecutive-index convention). Then, for each selected array, scan its 64
 * ticks for initialized-tick boundaries in walk order: the array containing
 * the reference tick (aToB: tickCurrentIndex; bToA: tickCurrentIndex + 1 —
 * Crema's own `computeSwap`'s `firstTickIndex`) gets the partial from-here
 * scan; any OTHER selected array (reached by skipping a gap, or a later one)
 * gets its FULL span, since it lies entirely ahead of the live tick either
 * way.
 */
async function resolveWindow(
  load: AccountLoader,
  pool: Address,
  tickArrayMapData: Uint8Array,
  tickCurrentIndex: number,
  tickSpacing: number,
  aToB: boolean,
): Promise<CremaWindow> {
  const firstTickIndex = aToB ? tickCurrentIndex : tickCurrentIndex + 1;
  const startArrayIndex = arrayIndexOf(firstTickIndex, tickSpacing);

  // Bitmap-driven scan first (skips unallocated indices — see header), then,
  // if the valid range is exhausted before finding CREMA_MAX_ARRAYS, pad by
  // CONTINUING the same monotonic scan ignoring the bitmap. Both phases visit
  // each index at most once, so `arrayIndices` is always distinct — padding
  // with a REPEATED index would derive the SAME PDA twice, double-counting
  // that array's boundaries in the walk and passing a duplicate writable
  // account into the swap ix.
  const arrayIndices: number[] = [];
  let cursor = startArrayIndex;
  const inRange = (i: number) => (aToB ? i >= TICK_ARRAY_MAP_MIN_BIT_INDEX : i <= TICK_ARRAY_MAP_MAX_BIT_INDEX);
  const step = aToB ? -1 : 1;
  while (inRange(cursor) && arrayIndices.length < CREMA_MAX_ARRAYS) {
    if (bitmapBitSet(tickArrayMapData, cursor)) arrayIndices.push(cursor);
    cursor += step;
  }
  cursor = arrayIndices.length > 0 ? arrayIndices[arrayIndices.length - 1]! + step : startArrayIndex + step;
  while (arrayIndices.length < CREMA_MAX_ARRAYS && inRange(cursor)) {
    arrayIndices.push(cursor);
    cursor += step;
  }
  // Only possible when the tick range itself is smaller than CREMA_MAX_ARRAYS
  // arrays (an extreme tickSpacing) — pad with the last valid boundary index
  // (duplicate PDAs here fail the fetch-validity check identically on both
  // slots, so `readable` still stops correctly; there is nothing further to
  // read either way).
  while (arrayIndices.length < CREMA_MAX_ARRAYS) arrayIndices.push(arrayIndices[arrayIndices.length - 1] ?? startArrayIndex);

  const tickArrays = (await Promise.all(arrayIndices.map((idx) => deriveTickArrayPda(pool, idx)))) as [Address, Address, Address];
  const startTicks = arrayIndices.map((idx) => startTickOf(idx, tickSpacing)) as [number, number, number];

  const arrays: Uint8Array[] = [];
  let readable = 0;
  for (let i = 0; i < CREMA_MAX_ARRAYS; i++) {
    const data = await load(tickArrays[i]!);
    const valid =
      data !== null &&
      data.length === TICK_ARRAY_ACCOUNT_SIZE &&
      hasDiscriminator(data, TICK_ARRAY_DISCRIMINATOR) &&
      Number(readUintLE(data, OFF_TA_ARRAY_INDEX, 2)) === arrayIndices[i] &&
      Number(readUintLE(data, OFF_TA_TICK_SPACING, 2)) === tickSpacing;
    if (!valid) break;
    arrays.push(data as Uint8Array);
    readable += 1;
  }

  const boundaries: CremaBoundary[] = [];
  let maxStopped = false;
  for (let a = 0; a < readable && !maxStopped; a++) {
    const data = arrays[a]!;
    const start = startTicks[a]!;
    const isReferenceArray = arrayIndices[a] === startArrayIndex;
    let offset: number;
    if (isReferenceArray) {
      const raw = floorDiv(tickCurrentIndex - start, tickSpacing);
      offset = aToB ? raw : raw + 1;
    } else {
      offset = aToB ? TICK_ARRAY_SIZE - 1 : 0;
    }
    while (offset >= 0 && offset < TICK_ARRAY_SIZE) {
      const cell = OFF_TA_TICKS + offset * TICK_LEN;
      if (data[cell] === 1) {
        const tick = start + offset * tickSpacing;
        boundaries.push({ arrayIndex: a, offset, tick, sqrtPrice: whirlpoolSqrtPriceAtTick(tick) });
        if (boundaries.length === CREMA_MAX_BOUNDARIES) {
          maxStopped = true;
          break;
        }
      }
      offset += aToB ? -1 : 1;
    }
  }

  let edge: { tick: number; sqrtPrice: bigint } | null = null;
  if (readable > 0 && !maxStopped) {
    const lastStart = startTicks[readable - 1]!;
    let tick: number;
    if (aToB) {
      tick = Math.max(lastStart, MIN_TICK_INDEX);
    } else {
      tick = lastStart + TICK_ARRAY_SIZE * tickSpacing - 1;
      if (lastStart + TICK_ARRAY_SIZE * tickSpacing > MAX_TICK_INDEX) tick = MAX_TICK_INDEX;
    }
    edge = { tick, sqrtPrice: whirlpoolSqrtPriceAtTick(tick) };
  }

  return { tickArrays, arrayIndices: arrayIndices as [number, number, number], startTicks, boundaries, edge, readable };
}

/** Fetch + decode one Clmmpool and freeze both directions' boundary windows. Read-only against the loader. */
export async function fetchCremaPoolConfig(load: AccountLoader, pool: Address): Promise<CremaPoolConfig> {
  const data = await load(pool);
  if (data === null) throw new Error(`${SLUG}: pool account ${pool} not found`);
  if (data.length !== CLMMPOOL_ACCOUNT_SIZE) {
    throw new Error(`${SLUG}: pool ${pool} has ${data.length} bytes, expected ${CLMMPOOL_ACCOUNT_SIZE}`);
  }
  if (!hasDiscriminator(data, CLMMPOOL_DISCRIMINATOR)) {
    throw new Error(`${SLUG}: pool ${pool} has a foreign discriminator (not a Clmmpool account)`);
  }
  if (data[OFF_IS_PAUSE] === 1) {
    throw new Error(`${SLUG}: pool ${pool} is administratively paused (is_pause = true)`);
  }

  const codec = getAddressCodec();
  const clmmConfig = codec.decode(data.subarray(OFF_CLMM_CONFIG, OFF_CLMM_CONFIG + 32)) as Address;
  const tokenMintA = codec.decode(data.subarray(OFF_MINT_A, OFF_MINT_A + 32)) as Address;
  const tokenMintB = codec.decode(data.subarray(OFF_MINT_B, OFF_MINT_B + 32)) as Address;
  for (const mint of [tokenMintA, tokenMintB]) {
    const mintData = await load(mint);
    if (mintData === null) throw new Error(`${SLUG}: mint ${mint} of pool ${pool} not found`);
    // The swap ix's token_program account is a single fixed program (Tokenkeg) — classic SPL only.
    if (mintData.length !== 82) {
      throw new Error(`${SLUG}: pool ${pool} mint ${mint} is not a classic SPL mint (swap is Tokenkeg-only)`);
    }
  }

  const tickSpacing = Number(readUintLE(data, OFF_TICK_SPACING, 2));
  const tickCurrentIndex = readI32(data, OFF_TICK_CURRENT);
  const tickArrayMap = await deriveTickArrayMapPda(pool);
  const mapData = await load(tickArrayMap);
  if (mapData === null) throw new Error(`${SLUG}: tick array map ${tickArrayMap} of pool ${pool} not found`);
  if (mapData.length !== TICK_ARRAY_MAP_ACCOUNT_SIZE) {
    throw new Error(`${SLUG}: tick array map ${tickArrayMap} has ${mapData.length} bytes, expected ${TICK_ARRAY_MAP_ACCOUNT_SIZE}`);
  }
  if (!hasDiscriminator(mapData, TICK_ARRAY_MAP_DISCRIMINATOR)) {
    throw new Error(`${SLUG}: tick array map ${tickArrayMap} has a foreign discriminator (not a TickArrayMap account)`);
  }

  const [aToB, bToA] = await Promise.all([
    resolveWindow(load, pool, mapData as Uint8Array, tickCurrentIndex, tickSpacing, true),
    resolveWindow(load, pool, mapData as Uint8Array, tickCurrentIndex, tickSpacing, false),
  ]);

  return {
    venue: SLUG,
    pool,
    direction: 'aToB',
    tokenMintA,
    tokenMintB,
    tokenVaultA: codec.decode(data.subarray(OFF_VAULT_A, OFF_VAULT_A + 32)) as Address,
    tokenVaultB: codec.decode(data.subarray(OFF_VAULT_B, OFF_VAULT_B + 32)) as Address,
    clmmConfig,
    tickArrayMap,
    tickSpacing,
    feeRate: Number(readUintLE(data, OFF_FEE_RATE, 2)),
    liquidity: readUintLE(data, OFF_LIQUIDITY, 16),
    sqrtPrice: readUintLE(data, OFF_SQRT_PRICE, 16),
    tickCurrentIndex,
    windows: { aToB, bToA },
  };
}

/** Family facade for the recipe orchestrator (ladder-only, like orca-whirlpool/raydium-clmm). */
export const crema = {
  slug: SLUG,
  programId: CREMA_PROGRAM_ID,
  tokenProgram: TOKEN_PROGRAM,
  fetchPoolConfig: fetchCremaPoolConfig,
};

// ---------------------------------------------------------------------------
// Ladder (fragment emission + reference mirror). The Q64.64 delta/next-sqrt
// math and the fee model are reused VERBATIM from orca-whirlpool (both the
// on-chain helper SOURCE via orcaWhirlpoolLadder.helpers() — dedupe-safe by
// {name, source}, so a cook mixing an orca-whirlpool slot and a crema slot
// shares ONE copy of wpDA/wpDB/wpNxA — and the TS mirror below) since Crema's
// own computeSwapStep is a line-for-line match (VALIDATED bit-exact against
// the real binary at 4 sizes each direction, see the module header). Only the
// account offsets, the PDA seeds, and the bitmap-scan window resolution
// (resolveWindow above) are new.
// ---------------------------------------------------------------------------
const SWAP_DISCRIMINATOR = [248, 198, 158, 145, 225, 117, 135, 200]; // sha256('global:swap')[0..8] — same ix name as Whirlpool's swap
const WALK_BOUND = CREMA_MAX_BOUNDARIES + 2;
const PARAM_COUNT = 1 + 3 * CREMA_MAX_BOUNDARIES + 3;
const S127 = 1n << 127n;
const Q128 = 1n << 128n;
const FEE_MUL = 1000000n;
const U64_MAX = (1n << 64n) - 1n;
const SENT = 1n << 65n;

function cremaConfig(cfg: PoolConfig): CremaPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as CremaPoolConfig;
}

function liveFromState(cfg: CremaPoolConfig, state: AccountBytesMap) {
  const pool = state[cfg.pool];
  if (pool === undefined) throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
  const fr = readUintLE(pool, OFF_FEE_RATE, 2);
  return {
    l: readUintLE(pool, OFF_LIQUIDITY, 16),
    sp: readUintLE(pool, OFF_SQRT_PRICE, 16),
    bt: (readUintLE(pool, OFF_TICK_CURRENT, 4) + BIAS) & M32,
    fr,
    fn: FEE_MUL - fr,
  };
}

interface LiveState {
  l: bigint;
  sp: bigint;
  bt: bigint;
  fr: bigint;
  fn: bigint;
}
interface EffectiveWindow {
  valid: boolean;
  bsp: bigint[];
  bnt: bigint[];
}

/** Live-verified boundary set from the shipped params — mirrors emitSetup/emitBoundary exactly. */
function effectiveWindow(cfg: CremaPoolConfig, state: AccountBytesMap, live: LiveState, params: readonly bigint[]): EffectiveWindow {
  const aToB = cfg.direction === 'aToB';
  const window = cremaWindowFor(cfg);
  const result: EffectiveWindow = { valid: false, bsp: [], bnt: [] };
  const nb = Number(params[0] ?? 0n);
  for (let k = 0; k < CREMA_MAX_BOUNDARIES && k < nb; k++) {
    const meta = params[1 + 3 * k]!;
    const btick = meta & M32;
    if (aToB ? btick > live.bt : btick <= live.bt) continue; // behind the live tick
    const offset = Number((meta >> 32n) & 127n);
    const arrayIndex = Number(meta >> 39n);
    const data = state[window.tickArrays[arrayIndex]!];
    if (data === undefined) throw new Error(`${SLUG} ladder reference is missing account ${window.tickArrays[arrayIndex]}`);
    const cell = OFF_TA_TICKS + offset * TICK_LEN;
    if (data[cell] !== 1) continue; // removed since prepare — the venue skips it too
    result.bsp.push((params[2 + 3 * k]! << 64n) | params[3 + 3 * k]!);
    result.bnt.push(readUintLE(data, cell + TICK_LIQUIDITY_NET_OFFSET, 16));
  }
  const edgeTick = params[1 + 3 * CREMA_MAX_BOUNDARIES] ?? 0n;
  if (edgeTick !== 0n && (aToB ? edgeTick <= live.bt : edgeTick > live.bt)) {
    result.bsp.push((params[2 + 3 * CREMA_MAX_BOUNDARIES]! << 64n) | params[3 + 3 * CREMA_MAX_BOUNDARIES]!);
    result.bnt.push(0n); // no-op cross
  }
  result.valid = result.bsp.length > 0;
  return result;
}

interface Cursor {
  sp: bigint;
  l: bigint;
  k: number;
  exhausted: boolean;
  out: bigint;
}

function walkStep(cursor: Cursor, win: EffectiveWindow, live: LiveState, aToB: boolean, rm: bigint): bigint {
  const nb = win.bsp.length;
  if (cursor.k >= nb) {
    cursor.exhausted = true;
    return rm;
  }
  const tg = win.bsp[cursor.k]!;
  const ca = (rm * live.fn) / FEE_MUL;
  const fx = aToB ? whirlpoolDeltaA(cursor.l, tg, cursor.sp, true) : whirlpoolDeltaB(cursor.l, cursor.sp, tg, true);
  let nx = tg;
  if (fx > ca) nx = aToB ? whirlpoolNextSqrtA(cursor.sp, cursor.l, ca) : cursor.sp + (ca << 64n) / cursor.l;
  if (nx === 0n) {
    cursor.exhausted = true;
    return rm;
  }
  const ou = aToB ? whirlpoolDeltaB(cursor.l, nx, cursor.sp, false) : whirlpoolDeltaA(cursor.l, cursor.sp, nx, false);
  let i2 = fx;
  if (nx !== tg || fx >= SENT) {
    i2 = aToB ? whirlpoolDeltaA(cursor.l, nx, cursor.sp, true) : whirlpoolDeltaB(cursor.l, cursor.sp, nx, true);
  }
  if (ou >= SENT || i2 >= SENT) {
    cursor.exhausted = true;
    return rm;
  }
  let fe: bigint;
  if (nx === tg) {
    fe = (i2 * live.fr + live.fn - 1n) / live.fn;
    if (i2 + fe > rm) {
      cursor.exhausted = true;
      return rm;
    }
  } else {
    if (i2 > rm) {
      cursor.exhausted = true;
      return rm;
    }
    fe = rm - i2;
  }
  rm -= i2 + fe;
  cursor.out += ou;
  cursor.sp = nx;
  if (nx === tg) {
    if (cursor.k < nb) {
      const raw = win.bnt[cursor.k]!;
      const positive = raw < S127;
      if (positive === aToB) {
        const sub = positive ? raw : Q128 - raw;
        if (cursor.l < sub) {
          cursor.exhausted = true;
          return rm;
        }
        cursor.l -= sub;
      } else {
        const add = positive ? raw : Q128 - raw;
        cursor.l += add;
        if (cursor.l >= Q128) {
          cursor.exhausted = true;
          return rm;
        }
      }
    }
    cursor.k += 1;
  }
  return rm;
}

function coldWalk(win: EffectiveWindow, live: LiveState, aToB: boolean, x: bigint): bigint | null {
  if (!win.valid || x === 0n) return x === 0n ? 0n : null;
  const cursor: Cursor = { sp: live.sp, l: live.l, k: 0, exhausted: false, out: 0n };
  let rm = x;
  for (let it = 0; it < WALK_BOUND && rm > 0n && !cursor.exhausted; it++) rm = walkStep(cursor, win, live, aToB, rm);
  return cursor.exhausted || rm > 0n ? null : cursor.out;
}

function coldWalkClamped(win: EffectiveWindow, live: LiveState, aToB: boolean, x: bigint): { out: bigint; cap: bigint } {
  if (!win.valid || x <= 0n) return { out: 0n, cap: 0n };
  const cursor: Cursor = { sp: live.sp, l: live.l, k: 0, exhausted: false, out: 0n };
  let rm = x;
  for (let it = 0; it < WALK_BOUND && rm > 0n && !cursor.exhausted; it++) rm = walkStep(cursor, win, live, aToB, rm);
  return { out: cursor.out, cap: x - rm };
}

// ---------------------------------------------------------------------------
// Fragment emission. Slot-local names are s<i>-prefixed short codes, mirroring
// orca-whirlpool's emitWalkStep/emitBoundary line for line (identical walk
// math and boundary-meta packing: meta = (tick+BIAS) | (offset<<32) |
// (arrayIndex<<39), decoded on-chain with the same shift/mask pair — only the
// TICK_LEN/OFF_TA_TICKS constants baked into the emitted source differ).
// ---------------------------------------------------------------------------
const ref = (slot: number, role: string): string => `s${slot}:${role}`;

function emitWalkStep(
  p: string,
  aToB: boolean,
  v: { sp: string; l: string; k: string; ex: string; out: string; rm: string },
  indent: string,
): string[] {
  const dIn = (lo: string, hi: string) => `wpDA(${v.l}, ${lo}, ${hi}, 1)`;
  const dInB = (lo: string, hi: string) => `wpDB(${v.l}, ${lo}, ${hi}, 1)`;
  const full = aToB ? dIn(`${p}tg`, v.sp) : dInB(v.sp, `${p}tg`);
  const out = aToB ? `wpDB(${v.l}, ${p}nx, ${v.sp}, 0)` : `wpDA(${v.l}, ${v.sp}, ${p}nx, 0)`;
  const outFull = aToB ? `wpDB(${v.l}, ${p}tg, ${v.sp}, 0)` : `wpDA(${v.l}, ${v.sp}, ${p}tg, 0)`;
  const inRe = aToB ? dIn(`${p}nx`, v.sp) : dInB(v.sp, `${p}nx`);
  const next = aToB ? `wpNxA(${v.sp}, ${v.l}, ${p}ca)` : `${v.sp} + ((${p}ca << 64) / ${v.l})`;
  const cross = (indent2: string) =>
    aToB
      ? [
          `${indent2}${p}nw = ${p}bnt[${v.k}];`,
          `${indent2}if (${p}nw < ${S127}) { if (${v.l} < ${p}nw) { ${v.ex} = 1 } else { ${v.l} = ${v.l} - ${p}nw } }`,
          `${indent2}else { ${v.l} = ${v.l} + ${Q128} - ${p}nw; if (${v.l} >= ${Q128}) { ${v.ex} = 1 } }`,
        ]
      : [
          `${indent2}${p}nw = ${p}bnt[${v.k}];`,
          `${indent2}if (${p}nw < ${S127}) { ${v.l} = ${v.l} + ${p}nw; if (${v.l} >= ${Q128}) { ${v.ex} = 1 } }`,
          `${indent2}else { if (${v.l} < ${Q128} - ${p}nw) { ${v.ex} = 1 } else { ${v.l} = ${v.l} - (${Q128} - ${p}nw) } }`,
        ];
  return [
    `${indent}if (${v.k} >= ${p}nbv) { ${v.ex} = 1 }`,
    `${indent}else {`,
    `${indent}  ${p}tg = ${p}bsp[${v.k}];`,
    `${indent}  ${p}ca = (${v.rm} * ${p}fn) / ${FEE_MUL};`,
    `${indent}  if (${v.k} < ${p}kmx) { ${p}fx = ${p}fxa[${v.k}] }`,
    `${indent}  else { ${p}fx = ${full} }`,
    `${indent}  if (${p}fx <= ${p}ca) {`,
    `${indent}    if (${v.k} < ${p}kmx) {`,
    `${indent}      ${p}fe = ${p}csn[${v.k}];`,
    `${indent}      if (${p}fe > ${v.rm}) { ${v.ex} = 1 }`,
    `${indent}      else {`,
    `${indent}        ${v.rm} = ${v.rm} - ${p}fe;`,
    `${indent}        ${v.out} = ${v.out} + ${p}cot[${v.k}];`,
    `${indent}        ${v.l} = ${p}lps[${v.k}];`,
    `${indent}        ${v.sp} = ${p}tg;`,
    `${indent}        ${v.k} = ${v.k} + 1;`,
    `${indent}      }`,
    `${indent}    } else {`,
    `${indent}      ${p}ou = ${outFull};`,
    `${indent}      ${p}fe = (${p}fx * ${p}fr + ${p}fn - 1) / ${p}fn;`,
    `${indent}      if (${p}ou >= ${SENT} || ${p}fx + ${p}fe > ${v.rm}) { ${v.ex} = 1 }`,
    `${indent}      else {`,
    `${indent}        ${v.rm} = ${v.rm} - ${p}fx - ${p}fe;`,
    `${indent}        ${v.out} = ${v.out} + ${p}ou;`,
    `${indent}        ${v.sp} = ${p}tg;`,
    ...cross(`${indent}        `),
    `${indent}        if (${v.ex} === 0) {`,
    `${indent}          ${p}fxa[${v.k}] = ${p}fx; ${p}csn[${v.k}] = ${p}fx + ${p}fe; ${p}cot[${v.k}] = ${p}ou; ${p}lps[${v.k}] = ${v.l};`,
    `${indent}          ${p}kmx = ${v.k} + 1;`,
    `${indent}          ${v.k} = ${v.k} + 1;`,
    `${indent}        }`,
    `${indent}      }`,
    `${indent}    }`,
    `${indent}  } else {`,
    `${indent}    ${p}nx = ${next};`,
    `${indent}    if (${p}nx === 0) { ${v.ex} = 1 }`,
    `${indent}    else {`,
    `${indent}      ${p}i2 = ${inRe};`,
    `${indent}      ${p}ou = ${out};`,
    `${indent}      if (${p}ou + ${p}i2 >= ${SENT}) { ${v.ex} = 1 }`,
    `${indent}      else {`,
    `${indent}        if (${p}nx === ${p}tg) {`,
    `${indent}          ${p}fe = (${p}i2 * ${p}fr + ${p}fn - 1) / ${p}fn;`,
    `${indent}          if (${p}i2 + ${p}fe > ${v.rm}) { ${v.ex} = 1 }`,
    `${indent}          else {`,
    `${indent}            ${v.rm} = ${v.rm} - ${p}i2 - ${p}fe;`,
    `${indent}            ${v.out} = ${v.out} + ${p}ou;`,
    `${indent}            ${v.sp} = ${p}tg;`,
    ...cross(`${indent}            `),
    `${indent}            if (${v.ex} === 0) { ${v.k} = ${v.k} + 1 }`,
    `${indent}          }`,
    `${indent}        } else {`,
    `${indent}          if (${p}i2 > ${v.rm}) { ${v.ex} = 1 }`,
    `${indent}          else {`,
    `${indent}            ${v.rm} = 0;`,
    `${indent}            ${v.out} = ${v.out} + ${p}ou;`,
    `${indent}            ${v.sp} = ${p}nx;`,
    `${indent}          }`,
    `${indent}        }`,
    `${indent}      }`,
    `${indent}    }`,
    `${indent}  }`,
    `${indent}}`,
  ];
}

/** The per-boundary live verification (unrolled; account refs are compile-time). */
function emitBoundary(p: string, slot: number, k: number, aToB: boolean, params: readonly string[]): string[] {
  const keep = aToB ? `${p}t2 <= ${p}bt` : `${p}t2 > ${p}bt`;
  const readArm = (a: number) => [
    `        ${p}t5 = accountUint(${JSON.stringify(ref(slot, `ta${a}`))}, ${OFF_TA_TICKS} + ${p}t3 * ${TICK_LEN}, 1);`,
    `        if (${p}t5 === 1) { ${p}t6 = accountUint(${JSON.stringify(ref(slot, `ta${a}`))}, ${OFF_TA_TICKS} + ${p}t3 * ${TICK_LEN} + ${TICK_LIQUIDITY_NET_OFFSET}, 16) }`,
  ];
  return [
    `    if (${params[0]} > ${k}) {`,
    `      ${p}t1 = ${params[1 + 3 * k]};`,
    `      ${p}t2 = ${p}t1 & ${M32};`,
    `      if (${keep}) {`,
    `        ${p}t3 = (${p}t1 >> 32) & 127;`,
    `        ${p}t4 = ${p}t1 >> 39;`,
    `        ${p}t5 = 0;`,
    `        ${p}t6 = 0;`,
    `        if (${p}t4 === 0) {`,
    ...readArm(0).map((line) => '  ' + line),
    `        } else { if (${p}t4 === 1) {`,
    ...readArm(1).map((line) => '  ' + line),
    `        } else {`,
    ...readArm(2).map((line) => '  ' + line),
    `        } }`,
    `        if (${p}t5 === 1) {`,
    `          ${p}bsp[${p}nbv] = (${params[2 + 3 * k]} << 64) | ${params[3 + 3 * k]};`,
    `          ${p}bnt[${p}nbv] = ${p}t6;`,
    `          ${p}nbv = ${p}nbv + 1;`,
    `        }`,
    `      }`,
    `    }`,
  ];
}

export const cremaLadder: SvmVenueLadder = {
  slug: SLUG,
  /** 2 rungs by default: same walk/CU economics as orca-whirlpool/raydium-clmm. */
  defaultRungs: 2,
  shapeKey(base) {
    return `${SLUG}:${cremaConfig(base).direction}`;
  },
  helpers() {
    // Byte-identical wpDA/wpDB/wpNxA source to orca-whirlpool's (VALIDATED
    // bit-exact against the real crema.so binary — see module header) — the
    // codegen dedupes helpers by {name, source}, so this is a genuine
    // zero-cost share when a cook mixes both families, not a copy.
    return (orcaWhirlpoolLadder.helpers as unknown as () => { name: string; source: string }[])();
  },
  /** [nb, (meta,sqrtHi,sqrtLo) x CREMA_MAX_BOUNDARIES, edgeTick, edgeHi, edgeLo]. */
  paramCount: PARAM_COUNT,
  paramsFor(base) {
    const window = cremaWindowFor(cremaConfig(base));
    const words = [BigInt(window.boundaries.length)];
    for (let k = 0; k < CREMA_MAX_BOUNDARIES; k++) {
      const boundary = window.boundaries[k];
      if (boundary === undefined) {
        words.push(0n, 0n, 0n);
        continue;
      }
      words.push(
        (BigInt(boundary.tick) + BIAS) | (BigInt(boundary.offset) << 32n) | (BigInt(boundary.arrayIndex) << 39n),
        boundary.sqrtPrice >> 64n,
        boundary.sqrtPrice & U64_MAX,
      );
    }
    if (window.edge === null) words.push(0n, 0n, 0n);
    else words.push(BigInt(window.edge.tick) + BIAS, window.edge.sqrtPrice >> 64n, window.edge.sqrtPrice & U64_MAX);
    return words;
  },
  quoteRefs(base, slot) {
    const cfg = cremaConfig(base);
    const window = cremaWindowFor(cfg);
    const referenced = new Set(window.boundaries.map((boundary) => boundary.arrayIndex));
    return [
      { ref: ref(slot, 'pool'), address: cfg.pool },
      // All three window PDAs ride the plan (the swap ix needs them and the
      // blob is shape-generic); the ones hosting no shipped boundary may not
      // even exist on-chain — the fragment never reads them and the
      // orchestrator's state fetch skips them (optional).
      ...window.tickArrays.map((addr, i) => ({
        ref: ref(slot, `ta${i}`),
        address: addr,
        ...(referenced.has(i) ? {} : { optional: true }),
      })),
    ] as VenueAccount[];
  },
  emitSetup(base, slot, params, enableVar) {
    const cfg = cremaConfig(base);
    const aToB = cfg.direction === 'aToB';
    const p = `s${slot}`;
    const pool = JSON.stringify(ref(slot, 'pool'));
    const enabled = enableVar ?? `${p}en`;
    const edgeKeep = aToB ? `${p}t1 <= ${p}bt` : `${p}t1 > ${p}bt`;
    const lines = [
      `  const ${p}l0 = accountUint(${pool}, ${OFF_LIQUIDITY}, 16);`,
      `  const ${p}sp0 = accountUint(${pool}, ${OFF_SQRT_PRICE}, 16);`,
      `  const ${p}bt = (accountUint(${pool}, ${OFF_TICK_CURRENT}, 4) + ${BIAS}) & ${M32};`,
      `  const ${p}fr = accountUint(${pool}, ${OFF_FEE_RATE}, 2);`,
      `  const ${p}fn = ${FEE_MUL} - ${p}fr;`,
      `  let ${p}nbv = 0;`,
      `  let ${p}kmx = 0;`,
      `  const ${p}bsp = new Array(${CREMA_MAX_BOUNDARIES + 1});`,
      `  const ${p}bnt = new Array(${CREMA_MAX_BOUNDARIES + 1});`,
      `  const ${p}fxa = new Array(${CREMA_MAX_BOUNDARIES + 1});`,
      `  const ${p}csn = new Array(${CREMA_MAX_BOUNDARIES + 1});`,
      `  const ${p}cot = new Array(${CREMA_MAX_BOUNDARIES + 1});`,
      `  const ${p}lps = new Array(${CREMA_MAX_BOUNDARIES + 1});`,
      `  let ${p}t1 = 0; let ${p}t2 = 0; let ${p}t3 = 0; let ${p}t4 = 0; let ${p}t5 = 0; let ${p}t6 = 0;`,
      `  let ${p}tg = 0; let ${p}ca = 0; let ${p}fx = 0; let ${p}nx = 0; let ${p}ou = 0; let ${p}i2 = 0; let ${p}fe = 0; let ${p}nw = 0;`,
      `  let ${p}wsp = 0; let ${p}wl = 0; let ${p}wk = 0; let ${p}wex = 0; let ${p}wout = 0; let ${p}rm = 0;`,
      `  let ${p}lo = 0; let ${p}lx = 0; let ${p}wcx = 0;`,
      `  if (${enabled} !== 0) {`,
      ...Array.from({ length: CREMA_MAX_BOUNDARIES }, (_, k) => emitBoundary(p, slot, k, aToB, params)).flat(),
      `    ${p}t1 = ${params[1 + 3 * CREMA_MAX_BOUNDARIES]};`,
      `    if (${p}t1 !== 0 && (${edgeKeep})) {`,
      `      ${p}bsp[${p}nbv] = (${params[2 + 3 * CREMA_MAX_BOUNDARIES]} << 64) | ${params[3 + 3 * CREMA_MAX_BOUNDARIES]};`,
      `      ${p}bnt[${p}nbv] = 0;`,
      `      ${p}nbv = ${p}nbv + 1;`,
      `    }`,
      `  }`,
      `  let ${p}vld = 0;`,
      `  if (${p}nbv > 0) { ${p}vld = 1 }`,
    ];
    return lines.join('\n');
  },
  emitLadderQuote(base, slot, rung, x, outVar) {
    const cfg = cremaConfig(base);
    const aToB = cfg.direction === 'aToB';
    const p = `s${slot}`;
    const v = { sp: `${p}wsp`, l: `${p}wl`, k: `${p}wk`, ex: `${p}wex`, out: `${p}wout`, rm: `${p}rm` };
    const lines = [
      `    if (${p}vld !== 0 && ${p}wcx === 0 && ${x} > 0) {`,
      `      ${p}wsp = ${p}sp0; ${p}wl = ${p}l0; ${p}wk = 0; ${p}wex = 0; ${p}wout = 0;`,
      `      ${p}rm = ${x};`,
      `      for (let ${p}w${rung} = 0; ${p}w${rung} < ${WALK_BOUND} && ${p}rm > 0 && ${p}wex === 0; ${p}w${rung}++) {`,
      ...emitWalkStep(p, aToB, v, '        '),
      `      }`,
      `      if (${p}wex === 0 && ${p}rm === 0) { ${p}lo = ${p}wout; ${p}lx = ${x} }`,
      `      else { ${p}lo = ${p}wout; ${p}lx = ${x} - ${p}rm; ${p}wcx = 1 }`,
      `    }`,
      `    const ${outVar} = ${p}lo;`,
    ];
    return lines.join('\n');
  },
  capacityInputVar(slot) {
    return `s${slot}lx`;
  },
  emitFinalQuote(base, slot, x, outVar) {
    const cfg = cremaConfig(base);
    const aToB = cfg.direction === 'aToB';
    const p = `s${slot}`;
    const v = { sp: `${p}fsp`, l: `${p}fl`, k: `${p}fk`, ex: `${p}fex`, out: `${p}fo`, rm: `${p}frm` };
    return [
      `  let ${outVar} = 0;`,
      `  if (${p}vld !== 0 && ${x} > 0) {`,
      `    if (${p}lx === ${x}) { ${outVar} = ${p}lo }`,
      `    else {`,
      `      let ${p}fsp = ${p}sp0; let ${p}fl = ${p}l0; let ${p}fk = 0; let ${p}fex = 0; let ${p}fo = 0;`,
      `      let ${p}frm = ${x};`,
      `      for (let ${p}wf = 0; ${p}wf < ${WALK_BOUND} && ${p}frm > 0 && ${p}fex === 0; ${p}wf++) {`,
      ...emitWalkStep(p, aToB, v, '        '),
      `      }`,
      `      if (${p}fex === 0 && ${p}frm === 0) { ${outVar} = ${p}fo }`,
      `    }`,
      `  }`,
    ].join('\n');
  },
  buildSwapV2(base, slot, user: SwapUser): LadderSwapTemplate {
    const cfg = cremaConfig(base);
    const aToB = cfg.direction === 'aToB';
    const window = cremaWindowFor(cfg);
    // swap: disc(8) ++ a_to_b(1) ++ by_amount_in(1) ++ amount u64 LE
    // (runtime-patched) ++ amount_limit u64 LE = 1 ++ sqrt_price_limit u128 LE
    // = the venue's own MIN/MAX global bound (Crema's `swap` takes an EXPLICIT
    // sqrt_price_limit with no zero-means-default special-casing observed in
    // testing — the exact MIN/MAX values are what this repo's real-CPI
    // validation used, see module header). NOTE THE ARG ORDER: a_to_b and
    // by_amount_in sit BEFORE amount, unlike orca-whirlpool's own layout.
    const MIN_SQRT_PRICE = 4295048016n;
    const MAX_SQRT_PRICE = 79226673515401279992447579055n;
    const prefix = new Uint8Array(8 + 1 + 1);
    prefix.set(SWAP_DISCRIMINATOR, 0);
    prefix[8] = aToB ? 1 : 0;
    prefix[9] = 1; // by_amount_in = true
    const suffix = new Uint8Array(8 + 16);
    suffix[0] = 1; // amount_limit = 1 (terminal outAta delta enforces the real bound)
    let limit = aToB ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
    for (let i = 0; i < 16; i++) {
      suffix[8 + i] = Number(limit & 0xffn);
      limit >>= 8n;
    }
    const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
    return {
      programId: CREMA_PROGRAM_ID,
      prefix,
      suffix,
      patch: 'in',
      accounts: [
        roled('cfg', cfg.clmmConfig),
        roled('pool', cfg.pool, true),
        roled('ma', cfg.tokenMintA),
        roled('mb', cfg.tokenMintB),
        // account_a/account_b are ALWAYS the user's token-A/token-B accounts
        // respectively (fixed by MINT, never by input/output side) — a_to_b
        // alone selects debit vs credit internally (see module header).
        { ref: aToB ? user.inAta : user.outAta, writable: true }, // account_a
        { ref: aToB ? user.outAta : user.inAta, writable: true }, // account_b
        roled('va', cfg.tokenVaultA, true),
        roled('vb', cfg.tokenVaultB, true),
        roled('tam', cfg.tickArrayMap, true),
        { ref: user.owner, signer: true },
        roled('tp', TOKEN_PROGRAM),
        roled('ta0', window.tickArrays[0], true),
        roled('ta1', window.tickArrays[1], true),
        roled('ta2', window.tickArrays[2], true),
      ],
    };
  },
  /**
   * Exact mirror of the emitted fragment given the SAME cfg + params the
   * blob was prepared with, over live account bytes — VALIDATED bit-exact
   * against the real crema.so binary at 4 sizes each direction (module
   * header).
   */
  referenceQuote(base, state, params) {
    const cfg = cremaConfig(base);
    const aToB = cfg.direction === 'aToB';
    const live = liveFromState(cfg, state);
    const win = effectiveWindow(cfg, state, live, params);
    return (x) => coldWalk(win, live, aToB, x) ?? 0n;
  },
  referenceLadderQuotes(base, state, params) {
    const cfg = cremaConfig(base);
    const aToB = cfg.direction === 'aToB';
    const live = liveFromState(cfg, state);
    const win = effectiveWindow(cfg, state, live, params);
    return (grid) => {
      let lo = 0n;
      let capped = false;
      return grid.map((g) => {
        if (win.valid && !capped && g > 0n) {
          const { out, cap } = coldWalkClamped(win, live, aToB, g);
          lo = out;
          if (cap < g) capped = true;
        }
        return lo;
      });
    };
  },
  referenceCapacities(base, state, params) {
    const cfg = cremaConfig(base);
    const aToB = cfg.direction === 'aToB';
    const live = liveFromState(cfg, state);
    const win = effectiveWindow(cfg, state, live, params);
    return (grid) => {
      let cap = 0n;
      let capped = false;
      return grid.map((g) => {
        if (win.valid && !capped && g > 0n) {
          const clamped = coldWalkClamped(win, live, aToB, g);
          cap = clamped.cap;
          if (clamped.cap < g) capped = true;
        }
        return cap;
      });
    };
  },
  /**
   * Full-range CP-equivalent VIRTUAL reserves at the live spot (Q64.64):
   * a = L<<64/sp, b = L*sp>>64 — isqrt(a*b) == L, the canonical CLMM depth.
   * Same convention as orca-whirlpool/meteora-damm-v2.
   */
  depthReserves(base, state) {
    const cfg = cremaConfig(base);
    const live = liveFromState(cfg, state);
    if (live.sp === 0n) return { reserveIn: 0n, reserveOut: 0n };
    const a = (live.l << 64n) / live.sp;
    const b = (live.l * live.sp) >> 64n;
    return cfg.direction === 'aToB' ? { reserveIn: a, reserveOut: b } : { reserveIn: b, reserveOut: a };
  },
  continuousFees(base, state) {
    const cfg = cremaConfig(base);
    const live = liveFromState(cfg, state);
    // fee_rate is ppm-scaled (FEE_RATE_DENOMINATOR = 1e6), charged on the input.
    return { gammaPpm: FEE_MUL - live.fr, muPpm: FEE_MUL };
  },
};
