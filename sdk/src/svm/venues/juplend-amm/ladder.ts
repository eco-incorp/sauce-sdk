/**
 * JupLend AMM adapter v2 (EcoSwapSVM ladder fragment).
 *
 * QUOTE MODEL (see index.ts's module doc for the full derivation + the
 * scope note on what is and isn't reproduced): a FLAT rate at the Dex's own
 * live `center_price` (u128, 1e15-scaled, read live — this adapter does not
 * bake it, since a peg CAN move even without an active oracle-driven
 * shift), fee taken on the input (matches the Solidity-derived
 * `_swapIn`'s `temp2_ = amountIn*fee/1e6` haircut BEFORE the curve, not
 * after), SATURATING at a real, byte-verified capacity ceiling instead of
 * collapsing past it (the SAME capacity-clamp contract every other
 * capacity-aware family in this SDK implements — obric-v2/meteora-damm-v2/
 * orca-legacy-token-swap/orca-whirlpool/raydium-clmm/meteora-dlmm/manifest):
 *
 *   cap        = max(0, position.ceiling − position.amount)   (position is
 *                whichever of UserSupplyPosition/UserBorrowPosition this Dex
 *                uses for the OUTPUT token — see index.ts's positionKind)
 *   effIn(x)   = x − floor(x·fee / 1e6)
 *   qRaw(x)    = floor(effIn(x) · numer / denom)     numer/denom = (1e15,
 *                centerPrice) for swap0to1, (centerPrice, 1e15) for swap1to0
 *   C          = floor(cap · 1e6 · denom / ((1e6−fee) · numer))   — the
 *                input at which qRaw(C) == cap (continuous inverse; the
 *                real discrete qRaw(C) lands at-or-under cap, never over —
 *                one-sided safe, same rounding discipline as every other
 *                family here)
 *   quote(x)   = qRaw(min(x, C))
 *
 * This is a FLAT (zero-curvature) rate rather than a real curve, which is a
 * documented, deliberate simplification (index.ts's scope note) — but the
 * SATURATING clamp still makes the overall (x, quote(x)) function concave
 * (linear ramp then flat), so it satisfies the same monotone/concave
 * contract every other family's ladder does, and it can never quote past
 * the real, on-chain-enforced ceiling (`DexDebtLimitReached` /
 * `DexWithdrawalLimitReached`).
 *
 * Because the curve has no real curvature, 2 rungs (the two ends of the
 * line — a straight segment needs no interior sample points) capture 100%
 * of the model's information; more rungs would cost CU for zero gain.
 */
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
import {
  CENTER_PRICE_SCALE,
  FEE_SCALE,
  JUPLEND_AMM_PROGRAM_ID,
  JUPLEND_SWAP_IN_DISCRIMINATOR,
  OFF_CENTER_PRICE,
  OFF_POSITION_AMOUNT,
  OFF_POSITION_CEILING,
  juplendAmmSwapAccounts,
} from './index.js';
import type { JuplendAmmPoolConfig } from './index.js';

const SLUG = 'juplend-amm';

function juplendAmmConfig(cfg: PoolConfig): JuplendAmmPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as JuplendAmmPoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

interface LiveState {
  centerPrice: bigint;
  cap: bigint;
  fee: bigint;
}

function liveState(cfg: JuplendAmmPoolConfig, state: AccountBytesMap, params: readonly bigint[]): LiveState {
  const dex = state[cfg.pool];
  const positionAddr = cfg.swap0to1 ? cfg.position1 : cfg.position0;
  const position = state[positionAddr];
  if (dex === undefined) throw new Error(`${SLUG} reference is missing pool ${cfg.pool}`);
  if (position === undefined) throw new Error(`${SLUG} reference is missing position ${positionAddr}`);
  const [fee] = params;
  const centerPrice = readUintLE(dex, OFF_CENTER_PRICE, 16);
  const amount = readUintLE(position, OFF_POSITION_AMOUNT, 8);
  const ceiling = readUintLE(position, OFF_POSITION_CEILING, 8);
  let cap = ceiling > amount ? ceiling - amount : 0n;
  if (centerPrice === 0n || fee >= FEE_SCALE) cap = 0n;
  return { centerPrice, cap, fee };
}

function numerDenom(cfg: JuplendAmmPoolConfig, centerPrice: bigint): { numer: bigint; denom: bigint } {
  return cfg.swap0to1 ? { numer: CENTER_PRICE_SCALE, denom: centerPrice } : { numer: centerPrice, denom: CENTER_PRICE_SCALE };
}

/** The input at which qRaw(C) == cap (continuous inverse) — see file header. */
function capacityInput(cap: bigint, fee: bigint, numer: bigint, denom: bigint): bigint {
  if (cap === 0n || numer === 0n || denom === 0n) return 0n;
  return (cap * FEE_SCALE * denom) / ((FEE_SCALE - fee) * numer);
}

/** qRaw(x) — see file header; 0 at x == 0. */
function rawQuote(x: bigint, fee: bigint, numer: bigint, denom: bigint): bigint {
  if (x === 0n || numer === 0n || denom === 0n) return 0n;
  const effIn = x - (x * fee) / FEE_SCALE;
  return (effIn * numer) / denom;
}

export const juplendAmmLadder = {
  slug: SLUG,

  /** A flat rate needs only its two endpoints — see file header. */
  defaultRungs: 2,

  shapeKey(base: PoolConfig): string {
    const c = juplendAmmConfig(base);
    return `${SLUG}:${c.swap0to1}:${c.positionKind}`;
  },

  helpers(): { name: string; source: string }[] {
    return [];
  },

  paramCount: 1,

  paramsFor(base: PoolConfig): bigint[] {
    return [juplendAmmConfig(base).feePpm];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const c = juplendAmmConfig(base);
    const positionAddr = c.swap0to1 ? c.position1 : c.position0;
    return [
      { ref: ref(slot, 'dex'), address: c.pool },
      { ref: ref(slot, 'pos'), address: positionAddr },
    ];
  },

  emitSetup(base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string {
    const c = juplendAmmConfig(base);
    const p = `s${slot}`;
    const en = enableVar ?? `${p}en`;
    const dexRef = JSON.stringify(ref(slot, 'dex'));
    const posRef = JSON.stringify(ref(slot, 'pos'));
    const [fee] = params;
    const numerExpr = c.swap0to1 ? `${CENTER_PRICE_SCALE}` : `${p}cp`;
    const denomExpr = c.swap0to1 ? `${p}cp` : `${CENTER_PRICE_SCALE}`;
    return [
      // LIVE reads (unconditional — cheap; matches the other families' style).
      `  const ${p}cp = accountUint(${dexRef}, ${OFF_CENTER_PRICE}, 16);`,
      `  const ${p}pamt = accountUint(${posRef}, ${OFF_POSITION_AMOUNT}, 8);`,
      `  const ${p}pceil = accountUint(${posRef}, ${OFF_POSITION_CEILING}, 8);`,
      `  const ${p}fee = ${fee};`,
      `  let ${p}cap = ${p}pceil - ${p}pamt;`,
      `  if (${p}cap < 0) { ${p}cap = 0 }`,
      `  if (${p}cp === 0) { ${p}cap = 0 }`,
      `  if (${p}fee >= ${FEE_SCALE}) { ${p}cap = 0 }`,
      // Capacity clamp (closed form, see file header) + ladder-quote temps —
      // declared here, reassigned per rung (one enable-gated block).
      `  let ${p}icap = 0;`,
      `  let ${p}cx = 0; let ${p}ei = 0;`,
      `  if (${en} !== 0 && ${p}cap > 0) {`,
      `    ${p}icap = (${p}cap * ${FEE_SCALE} * ${denomExpr}) / ((${FEE_SCALE} - ${p}fee) * ${numerExpr});`,
      `  }`,
    ].join('\n');
  },

  /**
   * Ladder rung / final quote at cumulative grid point `x`: `qRaw(min(x,
   * C))` — SATURATING (never collapsing past the real position ceiling).
   * Stateless (no warm-start; every point is its own closed-form
   * evaluation, byte-identical to the cold quote) — `rung` is unused.
   */
  emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string {
    const c = juplendAmmConfig(base);
    const p = `s${slot}`;
    const numerExpr = c.swap0to1 ? `${CENTER_PRICE_SCALE}` : `${p}cp`;
    const denomExpr = c.swap0to1 ? `${p}cp` : `${CENTER_PRICE_SCALE}`;
    return [
      `    ${p}cx = ${x};`,
      `    if (${p}cx > ${p}icap) { ${p}cx = ${p}icap }`,
      `    let ${outVar} = 0;`,
      `    if (${p}cx > 0) {`,
      `      ${p}ei = ${p}cx - (${p}cx * ${p}fee) / ${FEE_SCALE};`,
      `      ${outVar} = (${p}ei * ${numerExpr}) / ${denomExpr};`,
      `    }`,
    ].join('\n');
  },

  /** Cold final quote — same capacity clamp, fresh locals (no rung state to reuse). */
  emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string {
    const c = juplendAmmConfig(base);
    const p = `s${slot}`;
    const numerExpr = c.swap0to1 ? `${CENTER_PRICE_SCALE}` : `${p}cp`;
    const denomExpr = c.swap0to1 ? `${p}cp` : `${CENTER_PRICE_SCALE}`;
    return [
      `  let ${p}fcx = ${x};`,
      `  if (${p}fcx > ${p}icap) { ${p}fcx = ${p}icap }`,
      `  let ${outVar} = 0;`,
      `  if (${p}fcx > 0) {`,
      `    const ${p}fei = ${p}fcx - (${p}fcx * ${p}fee) / ${FEE_SCALE};`,
      `    ${outVar} = (${p}fei * ${numerExpr}) / ${denomExpr};`,
      `  }`,
    ].join('\n');
  },

  /**
   * swap_in CPI (amount runtime-patched): disc(8) ++ swap0to1(bool) ++
   * input u64 LE (patched) ++ amount_out_min u64 LE = 1.
   */
  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const c = juplendAmmConfig(base);
    const make = (r: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
    return {
      programId: JUPLEND_AMM_PROGRAM_ID,
      prefix: Uint8Array.from([...JUPLEND_SWAP_IN_DISCRIMINATOR, c.swap0to1 ? 1 : 0]),
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
      patch: 'in',
      accounts: juplendAmmSwapAccounts(c, user, make, (role) => ref(slot, role)),
    };
  },

  /** The slot-local emitLadderQuote reassigns per rung to the clamped `min(x, C)` input. */
  capacityInputVar(slot: number): string {
    return `s${slot}cx`;
  },

  referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint {
    const c = juplendAmmConfig(base);
    const { centerPrice, cap, fee } = liveState(c, state, params);
    const { numer, denom } = numerDenom(c, centerPrice);
    const cx = capacityInput(cap, fee, numer, denom);
    return (x: bigint): bigint => rawQuote(x > cx ? cx : x, fee, numer, denom);
  },

  referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[] {
    const c = juplendAmmConfig(base);
    const { centerPrice, cap, fee } = liveState(c, state, params);
    const { numer, denom } = numerDenom(c, centerPrice);
    const cx = capacityInput(cap, fee, numer, denom);
    return (grid: readonly bigint[]): bigint[] => grid.map((x) => rawQuote(x > cx ? cx : x, fee, numer, denom));
  },

  referenceCapacities(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[] {
    const c = juplendAmmConfig(base);
    const { centerPrice, cap, fee } = liveState(c, state, params);
    const { numer, denom } = numerDenom(c, centerPrice);
    const cx = capacityInput(cap, fee, numer, denom);
    return (grid: readonly bigint[]): bigint[] => grid.map((g) => (g > cx ? cx : g));
  },

  /**
   * Depth proxy: (reserveIn, reserveOut) = (the capacity-clamp input bound,
   * the real byte-verified output cap) — the closest coherent analogue this
   * flat-rate model has to a CP curve's vault balances (see file header: the
   * model has no separate notion of "input reserve", only a derived
   * capacity). A drained/fully-utilized position (cap == 0) reads 0 depth
   * and drops out of the relative-depth filter, exactly as the venue's own
   * ceiling would refuse the fill.
   */
  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const c = juplendAmmConfig(base);
    const { centerPrice, cap, fee } = liveState(c, state, [c.feePpm]);
    const { numer, denom } = numerDenom(c, centerPrice);
    const cx = capacityInput(cap, fee, numer, denom);
    return { reserveIn: cx, reserveOut: cap };
  },

  continuousFees(base: PoolConfig): { gammaPpm: bigint; muPpm: bigint } {
    const c = juplendAmmConfig(base);
    const feePpm = c.feePpm > FEE_SCALE ? FEE_SCALE : c.feePpm;
    return { gammaPpm: FEE_SCALE, muPpm: FEE_SCALE - feePpm };
  },
};
