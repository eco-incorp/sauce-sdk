/**
 * DefiTuna Fusion Pools (FusionAMM) — a Whirlpool-LINEAGE CLMM on Solana.
 * DefiTuna's own docs describe FusionAMM as "a hybrid (CLMM + OrderBook) AMM
 * contract... Modification based on Orca Whirlpools" (source headers in
 * github.com/DefiTuna/fusionamm-sdk, FusionAMM SDK Source-Available License;
 * the on-chain program itself is closed-source — only the client SDK + IDL
 * are public). Program id fUSioN9YKKSa3CUC2YUc4tPkHJ5Y6XW1yz8y6F7qWz9,
 * 906 live pools measured (dataSize 423) at integration time.
 *
 * Layout source: target/idl/fusionamm.json (FusionPool/TickArray account
 * types) in the SDK repo above, CROSS-VERIFIED against a real mainnet dump
 * (pool 7VuKeevbvbQQcxz6N4SNLmuq6PYy4AcGQRDssoqo4t65, SOL/USDC ts=4):
 * FusionPool = 423 bytes, discriminator sha256('account:FusionPool')[0..8] =
 * fe cc cf 62 19 b5 1d 43, token_mint_a@11, token_mint_b@43, token_vault_a@75,
 * token_vault_b@107 (all pubkeys) — this matches the trimmed Whirlpool header
 * (Whirlpool itself is 653 bytes; FusionPool drops the config/reward-related
 * fields Whirlpool carries, keeping tick_spacing/fee_rate/liquidity/sqrt_price/
 * tick_current_index in the same relative shape).
 *
 * THE KEY STRUCTURAL DIVERGENCE FROM ORCA WHIRLPOOL: FusionPool's TickArray
 * account is VARIABLE-LENGTH, not the fixed 9988-byte layout Whirlpool uses.
 * The IDL's `MaybeTick` is a Rust enum (Uninitialized | Initialized(TickData))
 * Borsh-serialized as ONE tag byte (0 or 1) PLUS 112 bytes of TickData only
 * when initialized — so an all-empty tick array is 132 bytes
 * (8 + 4 + 32 + 88) and a fully-initialized one is 9988 bytes
 * (8 + 4 + 32 + 88*113), confirmed empirically: 5 real tick arrays sampled at
 * integration time measured 244/356/356/692/804 bytes, each solving
 * `88 + 112*k` exactly for k = 1/2/2/5/6 initialized ticks. This means a
 * tick's byte position within the account is NOT `offset * TICK_LEN` (the
 * Whirlpool/raydium-clmm assumption) — it depends on how many EARLIER ticks
 * in the array are initialized. Prepare-time resolution here does a
 * SEQUENTIAL scan of the fetched bytes and bakes each shipped boundary's
 * ABSOLUTE byte offset (not an index) as a compile-time constant — cheaper
 * on-chain than Whirlpool's own `OFF_TA_TICKS + offset*TICK_LEN` (no
 * multiply needed at all), but with a residual drift risk Whirlpool's fixed
 * stride does not have: if some EARLIER tick in the same array flips
 * initialized-state between prepare and execution, every LATER tick's true
 * byte offset shifts. The tag-byte check every boundary read already does
 * (`if (tag !== 1) skip` — identical to Whirlpool's own "removed since
 * prepare" check) catches the common case (a shift landing on a 0 tag), and
 * a residual false-tag-positive is bounded in the same way EVERY venue's
 * quote-vs-execution drift already is in this codebase: `minOut` is the sole
 * atomic revert/floor authority, never a per-venue model guarantee.
 *
 * Tick array PDA seeds are IDENTICAL to Whirlpool's own scheme
 * (['tick_array', pool, start_tick_index.toString()] — confirmed from the
 * SDK's rust-sdk/client/src/pda/tick_array.rs), so `windowStartTicks` is
 * reused verbatim from the orca-whirlpool module (pure function of
 * tick/spacing/direction, venue-agnostic). TICK_ARRAY_SIZE (88 slots/array)
 * and the swap-sequence window-walk semantics (aToB searches DOWN from the
 * live tick inclusive, bToA searches UP exclusive) are also unchanged from
 * Whirlpool, and the Q64.64 sqrt-price / delta-A / delta-B / next-sqrt-price
 * math is reused VERBATIM (whirlpoolSqrtPriceAtTick / whirlpoolDeltaA /
 * whirlpoolDeltaB / whirlpoolNextSqrtA, and the identical on-chain helper
 * SOURCE via orcaWhirlpoolLadder.helpers() — the codegen dedupes helpers by
 * {name, source}, so a cook mixing an orca-whirlpool slot and a defituna slot
 * shares ONE copy of wpDA/wpDB/wpNxA at zero extra cost).
 *
 * VALIDATED against the REAL fusionamm.so binary (dumped from mainnet-beta)
 * executing on REAL mainnet pool + tick-array state via LiteSVM
 * (test/svm/venues/defituna.test.ts's real-CPI cell / the realcpi e2e lane):
 * at 0.05 SOL (single segment, no boundary crossed) our off-chain math is
 * BIT-EXACT to the real program's realized output. At larger single-segment
 * sizes (0.2 SOL, 1 SOL, same pool/state) we measured the real program
 * delivering marginally LESS output than our pure-CLMM model predicts (up to
 * ~0.01% at 1 SOL on the tested pool, growing with size) — most likely an
 * undocumented protocol-level adjustment in the closed-source swap
 * instruction (DefiTuna markets FusionAMM as more than plain-Whirlpool CLMM
 * math; the FusionPool account also carries an `ma_sqrt_price` field with no
 * public SDK documentation of how it feeds execution). This is a DISCLOSED,
 * MEASURED, one-sided residual (never in the favourable direction beyond the
 * exact match at small size) backstopped by `minOut` like every other venue's
 * quote-vs-execution drift in this repo — not a fund-safety gap. Re-measure
 * (ECO_SVM_CU_PRINT-style re-pin discipline) if this grows materially.
 *
 * Gates (named errors caught by the orchestrator's TOCTOU self-drop):
 * - account size / discriminator / owner (fetch-time);
 * - non-Tokenkeg mints (the swap accounts below are classic-SPL only);
 * - a direction with NO shipped boundaries and no edge (readable === 0),
 *   wired the same way as orca-whirlpool/raydium-clmm/byreal via the
 *   recipe's SvmWindowDriftError in ecoswap/svm/index.ts's FAMILIES entry;
 * - a shipped boundary carrying an ACTIVE resting limit order
 *   (open_orders_input > 0 or part_filled_orders_remaining_input > 0) —
 *   FusionAMM's hybrid CLMM+orderbook model may fill resting orders at a
 *   crossed tick beyond plain liquidity_net math, which this pure-CLMM
 *   ladder does not model; every REAL tick sampled at integration time
 *   carried all-zero order fields (this is the common case), but a pool
 *   that DOES have one is self-dropped rather than risk a silently wrong
 *   quote — recoverable (an order fills/cancels), so it is the SAME
 *   SvmWindowDriftError self-drop class, wired via `window.hasActiveOrder`.
 */
import { address, getAddressCodec, getProgramDerivedAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { MAX_TICK_INDEX, MIN_TICK_INDEX, whirlpoolSqrtPriceAtTick } from '../orca-whirlpool/tick-math.js';
import { orcaWhirlpoolLadder, whirlpoolDeltaA, whirlpoolDeltaB, whirlpoolNextSqrtA } from '../orca-whirlpool/ladder.js';
import { readUintLE } from '../math.js';
import { windowStartTicks } from '../orca-whirlpool/index.js';
import type { AccountBytesMap, AccountLoader, LadderSwapTemplate, PoolConfig, SvmVenueLadderV2, SwapUser, VenueAccount } from '../types.js';

const SLUG = 'defituna';
export const DEFITUNA_PROGRAM_ID = address('fUSioN9YKKSa3CUC2YUc4tPkHJ5Y6XW1yz8y6F7qWz9');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export const FUSION_POOL_ACCOUNT_SIZE = 423;
/** sha256('account:FusionPool')[0..8] (IDL-given: [254,204,207,98,25,181,29,67]). */
export const FUSION_POOL_DISCRIMINATOR = [0xfe, 0xcc, 0xcf, 0x62, 0x19, 0xb5, 0x1d, 0x43];
/** sha256('account:TickArray')[0..8] (IDL-given: [85,1,199,2,188,97,101,139]). */
export const TICK_ARRAY_DISCRIMINATOR = [85, 1, 199, 2, 188, 97, 101, 139];
export const TICK_ARRAY_SIZE = 88;
/** Borsh-tagged-enum per-tick size when Initialized (1-byte tag + 112-byte TickData); 1 byte when Uninitialized. */
export const TICK_LEN_INITIALIZED = 113;
/** Minimum possible TickArray account length (all 88 ticks uninitialized): 8 + 4 + 32 + 88. */
export const TICK_ARRAY_MIN_LEN = 132;

// FusionPool offsets (fusionamm.json's FusionPool type, declared-field order, Borsh-packed).
const OFF_MINT_A = 11;
const OFF_MINT_B = 43;
const OFF_VAULT_A = 75;
const OFF_VAULT_B = 107;
const OFF_TICK_SPACING = 139;
const OFF_FEE_RATE = 143;
const OFF_LIQUIDITY = 151;
const OFF_SQRT_PRICE = 167;
const OFF_TICK_CURRENT = 183;

// TickArray offsets.
const OFF_TA_START = 8;
const OFF_TA_FUSION_POOL = 12;
const OFF_TA_TICKS = 44;

/**
 * Shipped initialized-tick boundaries per direction — same budget class as
 * orca-whirlpool/raydium-clmm (2 rungs default, degrade-first CU kind).
 */
export const DEFITUNA_MAX_BOUNDARIES = 4;

const BIAS = 2147483648n; // 2^31 tick bias
const M32 = 4294967295n;
const BYTE_OFFSET_MASK = 0xffffn; // 16 bits — real TickArray max length 9988 fits comfortably
const ARRAY_INDEX_SHIFT = 48n;

export interface DefiTunaBoundary {
  arrayIndex: number;
  /** ABSOLUTE byte offset of the tick's tag byte within its TickArray account (see header — NOT offset*stride). */
  byteOffset: number;
  tick: number;
  sqrtPrice: bigint;
}

export interface DefiTunaWindow {
  tickArrays: [Address, Address, Address];
  startTicks: [number, number, number];
  boundaries: DefiTunaBoundary[];
  edge: { tick: number; sqrtPrice: bigint } | null;
  /** Contiguous prefix of tickArrays that existed as real TickArray accounts at prepare. */
  readable: number;
  /** True when a SHIPPED boundary carries a live resting limit order (see header gate). */
  hasActiveOrder: boolean;
}

export interface DefiTunaPoolConfig extends PoolConfig {
  venue: typeof SLUG;
  direction: 'aToB' | 'bToA';
  tokenMintA: Address;
  tokenMintB: Address;
  tokenVaultA: Address;
  tokenVaultB: Address;
  tickSpacing: number;
  feeRate: number;
  liquidity: bigint;
  sqrtPrice: bigint;
  tickCurrentIndex: number;
  windows: { aToB: DefiTunaWindow; bToA: DefiTunaWindow };
}

/** The direction's window (the ladder adapter and the orchestrator gate read through this). */
export function defitunaWindowFor(cfg: DefiTunaPoolConfig): DefiTunaWindow {
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
async function deriveTickArrayPda(pool: Address, startTick: number): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: DEFITUNA_PROGRAM_ID,
    seeds: [new TextEncoder().encode('tick_array'), getAddressEncoded(pool), new TextEncoder().encode(String(startTick))],
  });
  return pda;
}

interface DecodedTick {
  tick: number;
  byteOffset: number;
  liquidityNetRaw: bigint;
  hasOrder: boolean;
}

/**
 * Sequential Borsh-tagged-enum scan of one TickArray's raw bytes (see header
 * — NOT a fixed stride). Stops defensively on an unrecognized tag byte
 * (foreign/corrupt data) rather than misreading the rest of the account.
 */
function scanTickArray(data: Uint8Array, startTick: number, tickSpacing: number): DecodedTick[] {
  const out: DecodedTick[] = [];
  let pos = OFF_TA_TICKS;
  for (let slot = 0; slot < TICK_ARRAY_SIZE && pos < data.length; slot++) {
    const tag = data[pos];
    if (tag === 0) {
      pos += 1;
      continue;
    }
    if (tag !== 1) break; // defensive: unrecognized encoding, stop rather than misread
    if (pos + TICK_LEN_INITIALIZED > data.length) break; // truncated tail, stop rather than misread
    const liquidityNetRaw = readUintLE(data, pos + 1, 16);
    const openOrdersInput = readUintLE(data, pos + 73, 8);
    const partFilledRemaining = readUintLE(data, pos + 89, 8);
    out.push({
      tick: startTick + slot * tickSpacing,
      byteOffset: pos,
      liquidityNetRaw,
      hasOrder: openOrdersInput > 0n || partFilledRemaining > 0n,
    });
    pos += TICK_LEN_INITIALIZED;
  }
  return out;
}

/**
 * Scan the readable window for initialized-tick boundaries in walk order —
 * identical direction semantics to orca-whirlpool's resolveWindow (aToB
 * searches DOWN from the live tick inclusive, bToA searches UP exclusive;
 * later arrays search their full span), adapted for the variable-length
 * per-array scan above instead of a fixed-offset walk.
 */
async function resolveWindow(
  load: AccountLoader,
  pool: Address,
  tickCurrentIndex: number,
  tickSpacing: number,
  aToB: boolean,
): Promise<DefiTunaWindow> {
  const startTicks = windowStartTicks(tickCurrentIndex, tickSpacing, aToB) as [number, number, number];
  const tickArrays = (await Promise.all(startTicks.map((start) => deriveTickArrayPda(pool, start)))) as [Address, Address, Address];
  const arrays: Uint8Array[] = [];
  let readable = 0;
  for (let i = 0; i < 3; i++) {
    const data = await load(tickArrays[i]!);
    const valid =
      data !== null &&
      data.length >= TICK_ARRAY_MIN_LEN &&
      hasDiscriminator(data, TICK_ARRAY_DISCRIMINATOR) &&
      readI32(data, OFF_TA_START) === startTicks[i];
    if (!valid) break;
    arrays.push(data as Uint8Array);
    readable += 1;
  }

  const boundaries: DefiTunaBoundary[] = [];
  let hasActiveOrder = false;
  let maxStopped = false;
  for (let a = 0; a < readable && !maxStopped; a++) {
    const decoded = scanTickArray(arrays[a]!, startTicks[a]!, tickSpacing);
    const candidates =
      a === 0
        ? aToB
          ? decoded.filter((t) => t.tick <= tickCurrentIndex).sort((x, y) => y.tick - x.tick)
          : decoded.filter((t) => t.tick > tickCurrentIndex).sort((x, y) => x.tick - y.tick)
        : aToB
          ? [...decoded].sort((x, y) => y.tick - x.tick)
          : [...decoded].sort((x, y) => x.tick - y.tick);
    for (const c of candidates) {
      boundaries.push({ arrayIndex: a, byteOffset: c.byteOffset, tick: c.tick, sqrtPrice: whirlpoolSqrtPriceAtTick(c.tick) });
      if (c.hasOrder) hasActiveOrder = true;
      if (boundaries.length === DEFITUNA_MAX_BOUNDARIES) {
        maxStopped = true;
        break;
      }
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

  return { tickArrays, startTicks, boundaries, edge, readable, hasActiveOrder };
}

/** Fetch + decode one FusionPool and freeze both directions' boundary windows. Read-only against the loader. */
export async function fetchDefiTunaPoolConfig(load: AccountLoader, pool: Address): Promise<DefiTunaPoolConfig> {
  const data = await load(pool);
  if (data === null) throw new Error(`${SLUG}: pool account ${pool} not found`);
  if (data.length !== FUSION_POOL_ACCOUNT_SIZE) {
    throw new Error(`${SLUG}: pool ${pool} has ${data.length} bytes, expected ${FUSION_POOL_ACCOUNT_SIZE}`);
  }
  if (!hasDiscriminator(data, FUSION_POOL_DISCRIMINATOR)) {
    throw new Error(`${SLUG}: pool ${pool} has a foreign discriminator (not a FusionPool account)`);
  }

  const codec = getAddressCodec();
  const tokenMintA = codec.decode(data.subarray(OFF_MINT_A, OFF_MINT_A + 32)) as Address;
  const tokenMintB = codec.decode(data.subarray(OFF_MINT_B, OFF_MINT_B + 32)) as Address;
  for (const mint of [tokenMintA, tokenMintB]) {
    const mintData = await load(mint);
    if (mintData === null) throw new Error(`${SLUG}: mint ${mint} of pool ${pool} not found`);
    if (mintData.length !== 82) {
      throw new Error(`${SLUG}: pool ${pool} mint ${mint} is not a classic SPL mint (swap is Tokenkeg-only)`);
    }
  }

  const tickSpacing = Number(readUintLE(data, OFF_TICK_SPACING, 2));
  const tickCurrentIndex = readI32(data, OFF_TICK_CURRENT);
  const [aToB, bToA] = await Promise.all([
    resolveWindow(load, pool, tickCurrentIndex, tickSpacing, true),
    resolveWindow(load, pool, tickCurrentIndex, tickSpacing, false),
  ]);

  return {
    venue: SLUG,
    pool,
    direction: 'aToB',
    tokenMintA,
    tokenMintB,
    tokenVaultA: codec.decode(data.subarray(OFF_VAULT_A, OFF_VAULT_A + 32)) as Address,
    tokenVaultB: codec.decode(data.subarray(OFF_VAULT_B, OFF_VAULT_B + 32)) as Address,
    tickSpacing,
    feeRate: Number(readUintLE(data, OFF_FEE_RATE, 2)),
    liquidity: readUintLE(data, OFF_LIQUIDITY, 16),
    sqrtPrice: readUintLE(data, OFF_SQRT_PRICE, 16),
    tickCurrentIndex,
    windows: { aToB, bToA },
  };
}

/** Family facade for the recipe orchestrator (ladder-only, like orca-whirlpool/raydium-clmm/byreal). */
export const defituna = {
  slug: SLUG,
  programId: DEFITUNA_PROGRAM_ID,
  tokenProgram: TOKEN_PROGRAM,
  fetchPoolConfig: fetchDefiTunaPoolConfig,
};

// ---------------------------------------------------------------------------
// Ladder (fragment emission + reference mirror). Math verbatim from
// orca-whirlpool's tick-math/delta helpers (Q64.64 CLMM, venue-agnostic);
// only the account offsets, the boundary meta packing (absolute byte offset
// instead of index*stride — see header), and the swap CPI shape are new.
// ---------------------------------------------------------------------------
const SWAP_DISCRIMINATOR = [248, 198, 158, 145, 225, 117, 135, 200]; // sha256('global:swap')[0..8] — same ix name as Whirlpool's v1 swap
const WALK_BOUND = DEFITUNA_MAX_BOUNDARIES + 2;
const PARAM_COUNT = 1 + 3 * DEFITUNA_MAX_BOUNDARIES + 3;
const S127 = 1n << 127n;
const Q128 = 1n << 128n;
const FEE_MUL = 1000000n;

function defitunaConfig(cfg: PoolConfig): DefiTunaPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as DefiTunaPoolConfig;
}

function liveFromState(cfg: DefiTunaPoolConfig, state: AccountBytesMap) {
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
function effectiveWindow(cfg: DefiTunaPoolConfig, state: AccountBytesMap, live: LiveState, params: readonly bigint[]): EffectiveWindow {
  const aToB = cfg.direction === 'aToB';
  const window = defitunaWindowFor(cfg);
  const result: EffectiveWindow = { valid: false, bsp: [], bnt: [] };
  const nb = Number(params[0] ?? 0n);
  for (let k = 0; k < DEFITUNA_MAX_BOUNDARIES && k < nb; k++) {
    const meta = params[1 + 3 * k]!;
    const btick = meta & M32;
    if (aToB ? btick > live.bt : btick <= live.bt) continue; // behind the live tick
    const byteOffset = Number((meta >> 32n) & BYTE_OFFSET_MASK);
    const arrayIndex = Number(meta >> ARRAY_INDEX_SHIFT);
    const data = state[window.tickArrays[arrayIndex]!];
    if (data === undefined) throw new Error(`${SLUG} ladder reference is missing account ${window.tickArrays[arrayIndex]}`);
    if (data[byteOffset] !== 1) continue; // removed since prepare — the venue skips it too
    result.bsp.push((params[2 + 3 * k]! << 64n) | params[3 + 3 * k]!);
    result.bnt.push(readUintLE(data, byteOffset + 1, 16));
  }
  const edgeTick = params[1 + 3 * DEFITUNA_MAX_BOUNDARIES] ?? 0n;
  if (edgeTick !== 0n && (aToB ? edgeTick <= live.bt : edgeTick > live.bt)) {
    result.bsp.push((params[2 + 3 * DEFITUNA_MAX_BOUNDARIES]! << 64n) | params[3 + 3 * DEFITUNA_MAX_BOUNDARIES]!);
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
  if (nx !== tg || fx >= 1n << 65n) {
    i2 = aToB ? whirlpoolDeltaA(cursor.l, nx, cursor.sp, true) : whirlpoolDeltaB(cursor.l, cursor.sp, nx, true);
  }
  const SENT = 1n << 65n;
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

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

function emitWalkStep(p: string, aToB: boolean, v: { sp: string; l: string; k: string; ex: string; out: string; rm: string }, indent: string): string[] {
  const dIn = (lo: string, hi: string) => `wpDA(${v.l}, ${lo}, ${hi}, 1)`;
  const dInB = (lo: string, hi: string) => `wpDB(${v.l}, ${lo}, ${hi}, 1)`;
  const full = aToB ? dIn(`${p}tg`, v.sp) : dInB(v.sp, `${p}tg`);
  const out = aToB ? `wpDB(${v.l}, ${p}nx, ${v.sp}, 0)` : `wpDA(${v.l}, ${v.sp}, ${p}nx, 0)`;
  const outFull = aToB ? `wpDB(${v.l}, ${p}tg, ${v.sp}, 0)` : `wpDA(${v.l}, ${v.sp}, ${p}tg, 0)`;
  const inRe = aToB ? dIn(`${p}nx`, v.sp) : dInB(v.sp, `${p}nx`);
  const next = aToB ? `wpNxA(${v.sp}, ${v.l}, ${p}ca)` : `${v.sp} + ((${p}ca << 64) / ${v.l})`;
  const SENT = 1n << 65n;
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

/** The per-boundary live verification (unrolled; account refs are compile-time). No stride math needed — t3 IS the absolute byte offset. */
function emitBoundary(p: string, slot: number, k: number, aToB: boolean, params: readonly string[]): string[] {
  const keep = aToB ? `${p}t2 <= ${p}bt` : `${p}t2 > ${p}bt`;
  const readArm = (a: number) => [
    `        ${p}t5 = accountUint(${JSON.stringify(ref(slot, `ta${a}`))}, ${p}t3, 1);`,
    `        if (${p}t5 === 1) { ${p}t6 = accountUint(${JSON.stringify(ref(slot, `ta${a}`))}, ${p}t3 + 1, 16) }`,
  ];
  return [
    `    if (${params[0]} > ${k}) {`,
    `      ${p}t1 = ${params[1 + 3 * k]};`,
    `      ${p}t2 = ${p}t1 & ${M32};`,
    `      if (${keep}) {`,
    `        ${p}t3 = (${p}t1 >> 32) & ${BYTE_OFFSET_MASK};`,
    `        ${p}t4 = ${p}t1 >> ${ARRAY_INDEX_SHIFT};`,
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

export const defitunaLadder: SvmVenueLadderV2 = {
  slug: SLUG,
  defaultRungs: 2,
  shapeKey(base) {
    return `${SLUG}:${defitunaConfig(base).direction}`;
  },
  helpers() {
    // Byte-identical wpDA/wpDB/wpNxA source to orca-whirlpool's — the codegen
    // dedupes helpers by {name, source}, so this is a genuine zero-cost share
    // when a cook mixes both families, not a copy.
    return (orcaWhirlpoolLadder.helpers as () => { name: string; source: string }[])();
  },
  paramCount: PARAM_COUNT,
  paramsFor(base) {
    const window = defitunaWindowFor(defitunaConfig(base));
    const words = [BigInt(window.boundaries.length)];
    for (let k = 0; k < DEFITUNA_MAX_BOUNDARIES; k++) {
      const boundary = window.boundaries[k];
      if (boundary === undefined) {
        words.push(0n, 0n, 0n);
        continue;
      }
      words.push(
        (BigInt(boundary.tick) + BIAS) | (BigInt(boundary.byteOffset) << 32n) | (BigInt(boundary.arrayIndex) << ARRAY_INDEX_SHIFT),
        boundary.sqrtPrice >> 64n,
        boundary.sqrtPrice & ((1n << 64n) - 1n),
      );
    }
    if (window.edge === null) words.push(0n, 0n, 0n);
    else words.push(BigInt(window.edge.tick) + BIAS, window.edge.sqrtPrice >> 64n, window.edge.sqrtPrice & ((1n << 64n) - 1n));
    return words;
  },
  quoteRefs(base, slot) {
    const cfg = defitunaConfig(base);
    const window = defitunaWindowFor(cfg);
    const referenced = new Set(window.boundaries.map((boundary) => boundary.arrayIndex));
    return [
      { ref: ref(slot, 'pool'), address: cfg.pool },
      ...window.tickArrays.map((addr, i) => ({
        ref: ref(slot, `ta${i}`),
        address: addr,
        ...(referenced.has(i) ? {} : { optional: true }),
      })),
    ] as VenueAccount[];
  },
  emitSetup(base, slot, params, enableVar) {
    const cfg = defitunaConfig(base);
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
      `  const ${p}bsp = new Array(${DEFITUNA_MAX_BOUNDARIES + 1});`,
      `  const ${p}bnt = new Array(${DEFITUNA_MAX_BOUNDARIES + 1});`,
      `  const ${p}fxa = new Array(${DEFITUNA_MAX_BOUNDARIES + 1});`,
      `  const ${p}csn = new Array(${DEFITUNA_MAX_BOUNDARIES + 1});`,
      `  const ${p}cot = new Array(${DEFITUNA_MAX_BOUNDARIES + 1});`,
      `  const ${p}lps = new Array(${DEFITUNA_MAX_BOUNDARIES + 1});`,
      `  let ${p}t1 = 0; let ${p}t2 = 0; let ${p}t3 = 0; let ${p}t4 = 0; let ${p}t5 = 0; let ${p}t6 = 0;`,
      `  let ${p}tg = 0; let ${p}ca = 0; let ${p}fx = 0; let ${p}nx = 0; let ${p}ou = 0; let ${p}i2 = 0; let ${p}fe = 0; let ${p}nw = 0;`,
      `  let ${p}wsp = 0; let ${p}wl = 0; let ${p}wk = 0; let ${p}wex = 0; let ${p}wout = 0; let ${p}rm = 0;`,
      `  let ${p}lo = 0; let ${p}lx = 0; let ${p}wcx = 0;`,
      `  if (${enabled} !== 0) {`,
      ...Array.from({ length: DEFITUNA_MAX_BOUNDARIES }, (_, k) => emitBoundary(p, slot, k, aToB, params)).flat(),
      `    ${p}t1 = ${params[1 + 3 * DEFITUNA_MAX_BOUNDARIES]};`,
      `    if (${p}t1 !== 0 && (${edgeKeep})) {`,
      `      ${p}bsp[${p}nbv] = (${params[2 + 3 * DEFITUNA_MAX_BOUNDARIES]} << 64) | ${params[3 + 3 * DEFITUNA_MAX_BOUNDARIES]};`,
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
    const cfg = defitunaConfig(base);
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
    const cfg = defitunaConfig(base);
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
    const cfg = defitunaConfig(base);
    const aToB = cfg.direction === 'aToB';
    const window = defitunaWindowFor(cfg);
    // swap: disc(8) ++ amount u64 LE (runtime-patched) ++
    // other_amount_threshold u64 LE = 1 ++ sqrt_price_limit u128 LE = 0
    // (the program substitutes its own MIN/MAX bound — the capacity clamp
    // keeps the walk inside the shipped window, matching orca-whirlpool's
    // own convention) ++ amount_specified_is_input = 1 ++ a_to_b ++
    // remaining_accounts_info: Option::None (1 byte, 0).
    const suffix = new Uint8Array(8 + 16 + 1 + 1 + 1);
    suffix[0] = 1; // other_amount_threshold = 1 (terminal outAta delta enforces the real bound)
    suffix[24] = 1; // amount_specified_is_input = true
    suffix[25] = aToB ? 1 : 0;
    suffix[26] = 0; // remaining_accounts_info = None
    const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
    return {
      programId: DEFITUNA_PROGRAM_ID,
      prefix: Uint8Array.from(SWAP_DISCRIMINATOR),
      suffix,
      patch: 'in',
      accounts: [
        roled('tpa', TOKEN_PROGRAM),
        roled('tpb', TOKEN_PROGRAM),
        roled('memo', MEMO_PROGRAM),
        { ref: user.owner, signer: true }, // token_authority
        roled('pool', cfg.pool, true),
        roled('ma', cfg.tokenMintA),
        roled('mb', cfg.tokenMintB),
        { ref: aToB ? user.inAta : user.outAta, writable: true }, // token_owner_account_a
        { ref: aToB ? user.outAta : user.inAta, writable: true }, // token_owner_account_b
        roled('va', cfg.tokenVaultA, true),
        roled('vb', cfg.tokenVaultB, true),
        roled('ta0', window.tickArrays[0], true),
        roled('ta1', window.tickArrays[1], true),
        roled('ta2', window.tickArrays[2], true),
      ],
    };
  },
  referenceQuote(base, state, params) {
    const cfg = defitunaConfig(base);
    const aToB = cfg.direction === 'aToB';
    const live = liveFromState(cfg, state);
    const win = effectiveWindow(cfg, state, live, params);
    return (x: bigint) => coldWalk(win, live, aToB, x) ?? 0n;
  },
  referenceLadderQuotes(base, state, params) {
    const cfg = defitunaConfig(base);
    const aToB = cfg.direction === 'aToB';
    const live = liveFromState(cfg, state);
    const win = effectiveWindow(cfg, state, live, params);
    return (grid: readonly bigint[]) => {
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
    const cfg = defitunaConfig(base);
    const aToB = cfg.direction === 'aToB';
    const live = liveFromState(cfg, state);
    const win = effectiveWindow(cfg, state, live, params);
    return (grid: readonly bigint[]) => {
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
  depthReserves(base, state) {
    const cfg = defitunaConfig(base);
    const live = liveFromState(cfg, state);
    if (live.sp === 0n) return { reserveIn: 0n, reserveOut: 0n };
    const a = (live.l << 64n) / live.sp;
    const b = (live.l * live.sp) >> 64n;
    return cfg.direction === 'aToB' ? { reserveIn: a, reserveOut: b } : { reserveIn: b, reserveOut: a };
  },
  continuousFees(base, state) {
    const cfg = defitunaConfig(base);
    const live = liveFromState(cfg, state);
    return { gammaPpm: FEE_MUL - live.fr, muPpm: FEE_MUL };
  },
};
