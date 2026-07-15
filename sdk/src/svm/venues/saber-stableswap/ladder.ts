/**
 * Saber StableSwap adapter v2 (EcoSwapSVM ladder fragment) — the stable
 * family archetype. Everything is a LIVE read (pause byte, both vault
 * balances, the four amp-ramp fields, the trade fee fraction); zero
 * per-trade params; the quote direction (A → B, like ./index.ts) is the
 * whole shape.
 *
 * Newton economics (why this family is statement-form):
 * - the invariant D depends only on the reserves, so it is computed ONCE per
 *   trade in emitSetup — gated on the slot's enable flag and reserve/pause
 *   validity so a disabled slot pays nothing;
 * - each ladder rung's compute_y WARM-STARTS from the previous rung's y
 *   (stableYW; rung 0 starts from D — exactly the venue's cold start). A
 *   larger cumulative input means a smaller y, so the previous rung's y
 *   still approaches the fixed point from above and converges in ~1-2
 *   iterations instead of the cold ~15+ — the difference between a stable
 *   slot fitting the CU budget or not (see recipes/ecoswap/svm/budget.ts);
 * - the FINAL predicted output is always COLD (y0 = D), byte-identical to
 *   the venue program's swap_to — what the real-binary quadrilateral pins.
 *
 * Amp ramp: interpolated live from the four SwapInfo fields with the venue's
 * floor division, both ramp directions branched at runtime. One documented
 * divergence: a ramp scheduled to START in the future (now < start_ramp_ts,
 * never observed on-chain — admins ramp from `now`) quotes at the TARGET amp
 * here, where the venue would extrapolate a negative delta; the mirror
 * transcribes THIS adapter, so the lamport-exact gate is unaffected.
 *
 * Where the v1 adapter's referenceQuote THROWS (paused, empty reserve), the
 * ladder quotes 0 — a dead slot never wins a rung and a 0-predicted slot
 * skips its CPI.
 */
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import { STABLE_D_HELPER, STABLE_YW_HELPER, stableComputeD, stableComputeYWarm } from '../stable-helpers.js';
import type {
  AccountBytesMap,
  LadderSwapTemplate,
  PoolConfig,
  SvmVenueLadderV2,
  SwapUser,
  VenueAccount,
} from '../types.js';
import { SABER_STABLESWAP_PROGRAM_ID } from './index.js';
import type { SaberPoolConfig } from './index.js';

const SLUG = 'saber-stableswap';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;

// SwapInfo offsets (docs/svm-venues.md layout table).
const OFF_IS_PAUSED = 1;
const OFF_INITIAL_AMP = 3;
const OFF_TARGET_AMP = 11;
const OFF_START_RAMP_TS = 19;
const OFF_STOP_RAMP_TS = 27;
const OFF_TRADE_FEE_NUM = 363;
const OFF_TRADE_FEE_DEN = 371;
const OFF_SPL_AMOUNT = 64;

function saberConfig(cfg: PoolConfig): SaberPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as SaberPoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

interface SaberLive {
  paused: boolean;
  src: bigint;
  dst: bigint;
  amp: bigint;
  fn: bigint;
  fd: bigint;
  /** 0 when the slot is unquotable (paused / empty reserve) — the master validity flag. */
  d: bigint;
}

/** Live state exactly as the fragment computes it (amp ramp branches included). */
function liveState(cfg: SaberPoolConfig, state: AccountBytesMap, now: bigint): SaberLive {
  const bytes = (addr: Address): Uint8Array => {
    const data = state[addr];
    if (data === undefined) throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
    return data;
  };
  const pool = bytes(cfg.pool);
  const paused = pool[OFF_IS_PAUSED] !== 0;
  const src = readUintLE(bytes(cfg.vaultA), OFF_SPL_AMOUNT, 8);
  const dst = readUintLE(bytes(cfg.vaultB), OFF_SPL_AMOUNT, 8);
  const ini = readUintLE(pool, OFF_INITIAL_AMP, 8);
  const tgt = readUintLE(pool, OFF_TARGET_AMP, 8);
  const start = readUintLE(pool, OFF_START_RAMP_TS, 8);
  const stop = readUintLE(pool, OFF_STOP_RAMP_TS, 8);
  let amp = tgt;
  if (now < stop && stop > start && now >= start) {
    amp = tgt >= ini
      ? ini + ((tgt - ini) * (now - start)) / (stop - start)
      : ini - ((ini - tgt) * (now - start)) / (stop - start);
  }
  const fn = readUintLE(pool, OFF_TRADE_FEE_NUM, 8);
  const fd = readUintLE(pool, OFF_TRADE_FEE_DEN, 8);
  const d = !paused && src > 0n && dst > 0n ? stableComputeD(amp, src, dst) : 0n;
  return { paused, src, dst, amp, fn, fd, d };
}

/**
 * out from a converged y: dy = dst − y − 1, fee floors off the OUTPUT.
 * A zero fee denominator mirrors the engine's Math.mulDiv rule (small
 * product, d == 0 → 0); the fetch gate rejects such pools anyway.
 */
function outFromY(live: SaberLive, y: bigint): bigint {
  if (live.dst <= y) return 0n;
  const dy = live.dst - y - 1n;
  return dy - (live.fd === 0n ? 0n : (dy * live.fn) / live.fd);
}

export const saberStableswapLadder = {
  slug: SLUG,

  /** Stable slots default to 2 rungs (cap 4) — a Newton quote is ~2 orders costlier than a CP one. */
  defaultRungs: 2,

  shapeKey(): string {
    return `${SLUG}:AtoB`;
  },

  helpers(): { name: string; source: string }[] {
    return [STABLE_D_HELPER, STABLE_YW_HELPER];
  },

  /** Everything is a live read — no per-trade params. */
  paramCount: 0,

  paramsFor(_base: PoolConfig): bigint[] {
    return [];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const cfg = saberConfig(base);
    return [
      { ref: ref(slot, 'pool'), address: cfg.pool },
      { ref: ref(slot, 'va'), address: cfg.vaultA },
      { ref: ref(slot, 'vb'), address: cfg.vaultB },
    ];
  },

  emitSetup(base: PoolConfig, slot: number, _params: readonly string[], enableVar?: string): string {
    void base;
    const pool = JSON.stringify(ref(slot, 'pool'));
    const enabled = enableVar ?? `s${slot}en`;
    return [
      `  const s${slot}ps = accountUint(${pool}, ${OFF_IS_PAUSED}, 1);`,
      `  const s${slot}src = accountUint(${JSON.stringify(ref(slot, 'va'))}, ${OFF_SPL_AMOUNT}, 8);`,
      `  const s${slot}dst = accountUint(${JSON.stringify(ref(slot, 'vb'))}, ${OFF_SPL_AMOUNT}, 8);`,
      `  const s${slot}ini = accountUint(${pool}, ${OFF_INITIAL_AMP}, 8);`,
      `  const s${slot}tgt = accountUint(${pool}, ${OFF_TARGET_AMP}, 8);`,
      `  const s${slot}srt = accountUint(${pool}, ${OFF_START_RAMP_TS}, 8);`,
      `  const s${slot}stp = accountUint(${pool}, ${OFF_STOP_RAMP_TS}, 8);`,
      `  let s${slot}amp = s${slot}tgt;`,
      `  if (block.timestamp < s${slot}stp && s${slot}stp > s${slot}srt && block.timestamp >= s${slot}srt) {`,
      `    if (s${slot}tgt >= s${slot}ini) { s${slot}amp = s${slot}ini + Math.mulDiv(s${slot}tgt - s${slot}ini, block.timestamp - s${slot}srt, s${slot}stp - s${slot}srt) }`,
      `    else { s${slot}amp = s${slot}ini - Math.mulDiv(s${slot}ini - s${slot}tgt, block.timestamp - s${slot}srt, s${slot}stp - s${slot}srt) }`,
      '  }',
      `  const s${slot}fn = accountUint(${pool}, ${OFF_TRADE_FEE_NUM}, 8);`,
      `  const s${slot}fd = accountUint(${pool}, ${OFF_TRADE_FEE_DEN}, 8);`,
      // Newton D — ONCE per trade, only for an enabled, unpaused, funded slot.
      // d == 0 is the master validity flag every quote checks.
      `  let s${slot}d = 0;`,
      `  if (${enabled} !== 0 && s${slot}ps === 0 && s${slot}src > 0 && s${slot}dst > 0) { s${slot}d = stableD(s${slot}amp, s${slot}src, s${slot}dst) }`,
    ].join('\n');
  },

  emitLadderQuote(_base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string {
    const lines: string[] = [];
    // The warm cursor: rung 0 seeds from D (the venue's own cold start).
    if (rung === 0) lines.push(`    let s${slot}wy = s${slot}d;`);
    lines.push(
      `    let ${outVar} = 0;`,
      `    if (s${slot}d > 0 && ${x} > 0) {`,
      `      s${slot}wy = stableYW(s${slot}amp, s${slot}src + ${x}, s${slot}d, s${slot}wy);`,
      `      if (s${slot}dst > s${slot}wy) {`,
      `        const s${slot}dy${rung} = s${slot}dst - s${slot}wy - 1;`,
      `        ${outVar} = s${slot}dy${rung} - Math.mulDiv(s${slot}dy${rung}, s${slot}fn, s${slot}fd);`,
      '      }',
      '    }',
    );
    return lines.join('\n');
  },

  emitFinalQuote(_base: PoolConfig, slot: number, x: string, outVar: string): string {
    // COLD: y0 = D — byte-identical to the venue's swap_to compute_y.
    return [
      `  let ${outVar} = 0;`,
      `  if (s${slot}d > 0 && ${x} > 0) {`,
      `    const s${slot}fy = stableYW(s${slot}amp, s${slot}src + ${x}, s${slot}d, s${slot}d);`,
      `    if (s${slot}dst > s${slot}fy) {`,
      `      const s${slot}fdy = s${slot}dst - s${slot}fy - 1;`,
      `      ${outVar} = s${slot}fdy - Math.mulDiv(s${slot}fdy, s${slot}fn, s${slot}fd);`,
      '    }',
      '  }',
    ].join('\n');
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const cfg = saberConfig(base);
    // tag 0x01 ++ amount_in u64 LE (runtime-patched) ++ minimum_amount_out
    // u64 LE = 1 (the recipe's terminal delta check enforces the real bound).
    const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
    return {
      programId: SABER_STABLESWAP_PROGRAM_ID,
      prefix: Uint8Array.from([0x01]),
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
      patch: 'in',
      accounts: [
        roled('pool', cfg.pool),
        roled('auth', cfg.swapAuthority),
        { ref: user.owner, signer: true },
        { ref: user.inAta, writable: true },
        roled('va', cfg.vaultA, true),
        roled('vb', cfg.vaultB, true),
        { ref: user.outAta, writable: true },
        roled('afb', cfg.adminFeeB, true),
        roled('tp', TOKEN_PROGRAM),
      ],
    };
  },

  referenceQuote(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], now?: bigint): (x: bigint) => bigint {
    const live = liveState(saberConfig(base), state, now ?? BigInt(Math.floor(Date.now() / 1000)));
    return (x: bigint): bigint => {
      if (live.d === 0n || x === 0n) return 0n;
      const y = stableComputeYWarm(live.amp, live.src + x, live.d, live.d); // COLD
      return outFromY(live, y);
    };
  },

  referenceLadderQuotes(
    base: PoolConfig,
    state: AccountBytesMap,
    _params: readonly bigint[],
    now?: bigint,
  ): (grid: readonly bigint[]) => bigint[] {
    const live = liveState(saberConfig(base), state, now ?? BigInt(Math.floor(Date.now() / 1000)));
    return (grid: readonly bigint[]): bigint[] => {
      let wy = live.d;
      return grid.map((g) => {
        if (live.d === 0n || g === 0n) return 0n; // wy unchanged, exactly like the fragment
        wy = stableComputeYWarm(live.amp, live.src + g, live.d, wy);
        return outFromY(live, wy);
      });
    };
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const cfg = saberConfig(base);
    const bytes = (addr: Address): Uint8Array => {
      const data = state[addr];
      if (data === undefined) throw new Error(`${SLUG} ladder depth is missing account ${addr}`);
      return data;
    };
    return {
      reserveIn: readUintLE(bytes(cfg.vaultA), OFF_SPL_AMOUNT, 8),
      reserveOut: readUintLE(bytes(cfg.vaultB), OFF_SPL_AMOUNT, 8),
    };
  },

  continuousFees(base: PoolConfig, state: AccountBytesMap): { gammaPpm: bigint; muPpm: bigint } {
    const cfg = saberConfig(base);
    const pool = state[cfg.pool];
    if (pool === undefined) throw new Error(`${SLUG} ladder fees are missing account ${cfg.pool}`);
    const fn = readUintLE(pool, OFF_TRADE_FEE_NUM, 8);
    const fd = readUintLE(pool, OFF_TRADE_FEE_DEN, 8);
    // Output-side fee retention; the CP form badly understates a stable
    // curve's depth — measurement oracle only, never a gate.
    return { gammaPpm: 1_000_000n, muPpm: 1_000_000n - (fn * 1_000_000n) / fd };
  },
} satisfies SvmVenueLadderV2;
