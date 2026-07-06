/**
 * Obric V2 adapter v2 (EcoSwapSVM ladder fragment) — the prop-AMM
 * oracle-anchored family. "Bake the shape, read the level": prepare ships the
 * drift-invariant curve SHAPE (bigK hi/lo, targetX, feeMillionth, the oracle
 * scaling) as cfg params; the fragment reads the fast-moving oracle MID LIVE
 * (a Pyth-v2-format relay account the swap already passes) and re-anchors the
 * virtual-reserve curve to it every execution — the SVM analog of the EVM
 * net-cache (cache the spread, read the mid live).
 *
 * Quote (shifted constant product on virtual reserves, re-centered on the
 * oracle, transcribed from the obric-solana SDK's V2Pool.quoteXToY):
 *   multX = floor(rawPriceX / divX) * mulX        (getPrice→expo −3 · decimalMult)
 *   multY = floor(rawPriceY / divY) * mulY
 *   targetXK = isqrt(bigK * multY / multX)         ← the LIVE re-anchor
 *   currentXK = targetXK − targetX + reserveX
 *   currentYK = bigK / currentXK
 *   xToY:  out = currentYK − bigK/(currentXK + x)  (Y from the curve)
 *   yToX:  out = currentXK − bigK/(currentYK + x)  (X from the curve)
 *   out −= floor(out * feeMillionth / 1e6)         (fee on OUTPUT; rebate omitted — see below)
 *   clamp to 0 if out > reserveOut                 (venue's "Insufficient active" → self-deactivate)
 *
 * Both directions collapse to ONE helper by mapping (cIn, cOut, reserveOut):
 * xToY = (currentXK, currentYK, reserveY); yToX = (currentYK, currentXK,
 * reserveX). Everything value-bearing is read LIVE (reserves from the vaults,
 * the mid from the oracle, the stored mult for the sanity band from the pool);
 * only the drift-invariant curve params + the oracle scaling ride cfg.
 *
 * SANITY BAND (self-deactivation): the live oracle-derived mult ratio is
 * compared against the pool's STORED multX/multY (the program's own last-swap
 * values); out of band by more than bandBps ⇒ the slot quotes 0 and the merge
 * redistributes in-instruction. A zero/halted price (mult 0) deactivates too.
 * bandBps is a wide gross-corruption guard for the documented P-A feed
 * (default 25%); a P-B proprietary feed would tighten it.
 *
 * CONSERVATIVE fee (documented, one-sided-safe): the venue grants a fee REBATE
 * on trades that rebalance reserves toward target; the fragment omits it
 * (charges the full feeMillionth), so predicted <= realized — the terminal
 * minOut can never trip on the rebate. rebatePercentage=0 pools (the fixtures)
 * are exact.
 *
 * The referenceQuote mirror transcribes this fragment bit-for-bit (the
 * lamport-exact gate). Venue-exactness (predicted == the real program's
 * realized output) additionally rests on the SDK==program oracle-derivation
 * assumption + minOut, per index.ts.
 */
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type {
  AccountBytesMap,
  LadderSwapTemplate,
  PoolConfig,
  SvmVenueLadderV2,
  SwapUser,
  VenueAccount,
} from '../types.js';
import {
  OBRIC_SWAP_DISCRIMINATOR,
  OBRIC_V2_PROGRAM_ID,
  OFF_MULT_X,
  OFF_MULT_Y,
  swapAccounts,
} from './index.js';
import type { ObricV2PoolConfig } from './index.js';

const SLUG = 'obric-v2';
/** SPL token account amount offset. */
const AMOUNT_OFF = 64;
const U64_MAX = (1n << 64n) - 1n;
const FEE_DEN = 1_000_000n;

/** cfg words per slot (paramsFor order). */
const PARAM_COUNT = 11;

function obricConfig(cfg: PoolConfig): ObricV2PoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as ObricV2PoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

/** Floor integer square root (mirrors the engine's SQRT op). */
export function isqrt(value: bigint): bigint {
  if (value < 0n) throw new Error(`isqrt needs a non-negative value, got ${value}`);
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/**
 * The COLD (final, venue-exact) oracle-anchored quote: the shifted-CP output
 * for gross input x, or 0 PAST CAPACITY (output would exceed reserveOut — the
 * venue's "Insufficient active" revert; a 0 final quote skips the CPI). This
 * is the predicted output the minOut check and the real swap see. `kq` is the
 * quote bigK (0 ⇒ deactivated: out-of-band oracle / underflow).
 */
export function obricColdQuote(x: bigint, cIn: bigint, cOut: bigint, kq: bigint, rOut: bigint, fee: bigint): bigint {
  if (x === 0n || kq === 0n) return 0n;
  const nOut = kq / (cIn + x);
  let g = 0n;
  if (nOut < cOut) g = cOut - nOut;
  if (g > rOut) return 0n; // past capacity — skip the CPI
  return g - (g * fee) / FEE_DEN;
}

interface LiveCurve {
  cIn: bigint;
  cOut: bigint;
  /** Quote bigK (0 ⇒ the slot is deactivated). */
  kq: bigint;
  rOut: bigint;
  fee: bigint;
}

/** The reference twin of emitSetup: derive the live curve anchor from account bytes + params. */
function liveCurve(cfg: ObricV2PoolConfig, state: AccountBytesMap, params: readonly bigint[]): LiveCurve {
  const pool = state[cfg.pool];
  const vx = state[cfg.reserveXVault];
  const vy = state[cfg.reserveYVault];
  const fx = state[cfg.feedX];
  const fy = state[cfg.feedY];
  if (pool === undefined) throw new Error(`${SLUG} reference is missing pool ${cfg.pool}`);
  if (vx === undefined || vy === undefined) throw new Error(`${SLUG} reference is missing a reserve vault`);
  if (fx === undefined || fy === undefined) throw new Error(`${SLUG} reference is missing a price feed`);
  const [bkHi, bkLo, targetX, fee, divX, mulX, divY, mulY, offX, offY, band] = params;

  const rx = readUintLE(vx, AMOUNT_OFF, 8);
  const ry = readUintLE(vy, AMOUNT_OFF, 8);
  const ax = readUintLE(fx, Number(offX), 8);
  const ay = readUintLE(fy, Number(offY), 8);
  const mx = (ax / divX) * mulX;
  const my = (ay / divY) * mulY;
  const k = (bkHi << 64n) | bkLo;

  const off: LiveCurve = { cIn: 0n, cOut: 0n, kq: 0n, rOut: 0n, fee };
  let ok = mx !== 0n && my !== 0n;
  if (band !== 0n && ok) {
    const zx = readUintLE(pool, OFF_MULT_X, 8);
    const zy = readUintLE(pool, OFF_MULT_Y, 8);
    const lhs = my * zx * 10_000n;
    if (lhs > (10_000n + band) * zy * mx) ok = false;
    if (lhs < (10_000n - band) * zy * mx) ok = false;
  }
  if (!ok) return off;

  const tk = isqrt((k * my) / mx);
  if (tk + rx <= targetX) return off; // currentXK would underflow — deactivate
  const cx = tk - targetX + rx;
  const cy = k / cx;
  return cfg.direction === 'xToY'
    ? { cIn: cx, cOut: cy, kq: k, rOut: ry, fee }
    : { cIn: cy, cOut: cx, kq: k, rOut: rx, fee };
}

export const obricV2Ladder = {
  slug: SLUG,

  /** CP-class: a closed-form quote (one isqrt + a division per rung), 4 rungs. */
  defaultRungs: 4,

  shapeKey(base: PoolConfig): string {
    return `${SLUG}:${obricConfig(base).direction}`;
  },

  /** The quote is inline statement-form (last-good ladder / cold final) — no shared helper. */
  helpers(): { name: string; source: string }[] {
    return [];
  },

  paramCount: PARAM_COUNT,

  paramsFor(base: PoolConfig): bigint[] {
    const c = obricConfig(base);
    return [
      c.bigK >> 64n,
      c.bigK & U64_MAX,
      c.targetX,
      c.feeMillionth,
      c.divX,
      c.mulX,
      c.divY,
      c.mulY,
      c.priceOffX,
      c.priceOffY,
      c.bandBps,
    ];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const c = obricConfig(base);
    return [
      { ref: ref(slot, 'pool'), address: c.pool },
      { ref: ref(slot, 'fx'), address: c.feedX },
      { ref: ref(slot, 'fy'), address: c.feedY },
      { ref: ref(slot, 'vx'), address: c.reserveXVault },
      { ref: ref(slot, 'vy'), address: c.reserveYVault },
    ];
  },

  emitSetup(base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string {
    const c = obricConfig(base);
    const xToY = c.direction === 'xToY';
    const p = `s${slot}`;
    const en = enableVar ?? `${p}en`;
    const pool = JSON.stringify(ref(slot, 'pool'));
    const fx = JSON.stringify(ref(slot, 'fx'));
    const fy = JSON.stringify(ref(slot, 'fy'));
    const vx = JSON.stringify(ref(slot, 'vx'));
    const vy = JSON.stringify(ref(slot, 'vy'));
    const [bkHi, bkLo, targetX, fee, divX, mulX, divY, mulY, offX, offY, band] = params;
    const assign = xToY
      ? `${p}ci = ${p}cx; ${p}co = ${p}cy; ${p}ro = ${p}ry; ${p}kq = ${p}bk;`
      : `${p}ci = ${p}cy; ${p}co = ${p}cx; ${p}ro = ${p}rx; ${p}kq = ${p}bk;`;
    return [
      // LIVE reads (unconditional — the accounts must be readable regardless of enable).
      `  const ${p}rx = accountUint(${vx}, ${AMOUNT_OFF}, 8);`,
      `  const ${p}ry = accountUint(${vy}, ${AMOUNT_OFF}, 8);`,
      `  const ${p}ax = accountUint(${fx}, ${offX}, 8);`,
      `  const ${p}ay = accountUint(${fy}, ${offY}, 8);`,
      `  const ${p}mx = (${p}ax / ${divX}) * ${mulX};`,
      `  const ${p}my = (${p}ay / ${divY}) * ${mulY};`,
      `  const ${p}bk = (${bkHi} << 64) | ${bkLo};`,
      `  const ${p}fe = ${fee};`,
      // Curve anchor + sanity band (EXPENSIVE — isqrt/products gated on enable).
      `  let ${p}ci = 0; let ${p}co = 0; let ${p}kq = 0; let ${p}ro = 0;`,
      // Ladder-chain state (last-good output + capped flag) and quote temps —
      // declared here, reassigned per rung (one enable-gated ladder block).
      `  let ${p}lo = 0; let ${p}cap = 0; let ${p}ni = 0; let ${p}no = 0; let ${p}gg = 0;`,
      `  if (${en} !== 0) {`,
      `    let ${p}ok = 1;`,
      `    if (${p}mx === 0) { ${p}ok = 0 }`,
      `    if (${p}my === 0) { ${p}ok = 0 }`,
      `    if (${band} !== 0 && ${p}ok !== 0) {`,
      `      const ${p}zx = accountUint(${pool}, ${OFF_MULT_X}, 8);`,
      `      const ${p}zy = accountUint(${pool}, ${OFF_MULT_Y}, 8);`,
      `      const ${p}lh = ${p}my * ${p}zx * 10000;`,
      `      if (${p}lh > (10000 + ${band}) * ${p}zy * ${p}mx) { ${p}ok = 0 }`,
      `      if (${p}lh < (10000 - ${band}) * ${p}zy * ${p}mx) { ${p}ok = 0 }`,
      `    }`,
      `    if (${p}ok !== 0) {`,
      `      const ${p}tk = Math.sqrt((${p}bk * ${p}my) / ${p}mx);`,
      `      if (${p}tk + ${p}rx > ${targetX}) {`,
      `        const ${p}cx = ${p}tk - ${targetX} + ${p}rx;`,
      `        const ${p}cy = ${p}bk / ${p}cx;`,
      `        ${assign}`,
      `      }`,
      `    }`,
      `  }`,
    ].join('\n');
  },

  /**
   * Ladder rung at cumulative grid point `x`: the shifted-CP output, reported
   * as the LAST-GOOD value once the walk passes capacity (g > reserveOut) — so
   * a capped rung's dOut is 0 and the merge never over-fills obric past what
   * the venue can pay. Monotone nondecreasing; quote(0)=0. Mirrored by
   * referenceLadderQuotes.
   */
  emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string {
    obricConfig(base);
    const p = `s${slot}`;
    return [
      `    if (${p}cap === 0 && ${x} > 0 && ${p}kq !== 0) {`,
      `      ${p}ni = ${p}ci + ${x};`,
      `      ${p}no = ${p}kq / ${p}ni;`,
      `      ${p}gg = 0;`,
      `      if (${p}no < ${p}co) { ${p}gg = ${p}co - ${p}no }`,
      `      if (${p}gg > ${p}ro) { ${p}cap = 1 }`,
      `      else { ${p}lo = ${p}gg - (${p}gg * ${p}fe) / ${FEE_DEN} }`,
      `    }`,
      `    const ${outVar} = ${p}lo;`,
    ].join('\n');
  },

  /** Cold final quote at the elected slice: g(fill)−fee, or 0 past capacity (skip the CPI). */
  emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string {
    obricConfig(base);
    const p = `s${slot}`;
    return [
      `  let ${outVar} = 0;`,
      `  if (${x} > 0 && ${p}kq !== 0) {`,
      `    ${p}ni = ${p}ci + ${x};`,
      `    ${p}no = ${p}kq / ${p}ni;`,
      `    ${p}gg = 0;`,
      `    if (${p}no < ${p}co) { ${p}gg = ${p}co - ${p}no }`,
      `    if (${p}gg <= ${p}ro) { ${outVar} = ${p}gg - (${p}gg * ${p}fe) / ${FEE_DEN} }`,
      `  }`,
    ].join('\n');
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const c = obricConfig(base);
    // swap: disc(8) ++ isXToY(bool) ++ input u64 LE (runtime-patched) ++ minOut u64 LE = 1.
    const xToY = c.direction === 'xToY';
    const make = (r: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
    return {
      programId: OBRIC_V2_PROGRAM_ID,
      prefix: Uint8Array.from([...OBRIC_SWAP_DISCRIMINATOR, xToY ? 1 : 0]),
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
      patch: 'in',
      accounts: swapAccounts(c, user, make, (role) => ref(slot, role)),
    };
  },

  /** The COLD final quote (0 past capacity) — the lamport-exact target for emitFinalQuote. */
  referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint {
    const cfg = obricConfig(base);
    const { cIn, cOut, kq, rOut, fee } = liveCurve(cfg, state, params);
    return (x: bigint): bigint => obricColdQuote(x, cIn, cOut, kq, rOut, fee);
  },

  /** The LAST-GOOD ladder chain — mirrors emitLadderQuote (monotone, flat past capacity). */
  referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[] {
    const cfg = obricConfig(base);
    const { cIn, cOut, kq, rOut, fee } = liveCurve(cfg, state, params);
    return (grid: readonly bigint[]): bigint[] => {
      let lo = 0n;
      let capped = false;
      return grid.map((x) => {
        if (!capped && x > 0n && kq !== 0n) {
          const nOut = kq / (cIn + x);
          let g = 0n;
          if (nOut < cOut) g = cOut - nOut;
          if (g > rOut) capped = true;
          else lo = g - (g * fee) / FEE_DEN;
        }
        return lo;
      });
    };
  },

  /**
   * Depth = the actual VAULT balances (isqrt(reserveIn·reserveOut)). A drained
   * Obric pool (thin inventory — the prop-AMM reality) reads 0 depth and drops
   * out of the relative-depth filter, exactly as the venue's own "Insufficient
   * active" guard would refuse the fill.
   */
  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const cfg = obricConfig(base);
    const vx = state[cfg.reserveXVault];
    const vy = state[cfg.reserveYVault];
    if (vx === undefined || vy === undefined) throw new Error(`${SLUG} depth is missing a reserve vault`);
    const rx = readUintLE(vx, AMOUNT_OFF, 8);
    const ry = readUintLE(vy, AMOUNT_OFF, 8);
    return cfg.direction === 'xToY' ? { reserveIn: rx, reserveOut: ry } : { reserveIn: ry, reserveOut: rx };
  },

  continuousFees(base: PoolConfig): { gammaPpm: bigint; muPpm: bigint } {
    // feeMillionth is already parts-per-1e6, charged on the OUTPUT.
    const c = obricConfig(base);
    const feePpm = c.feeMillionth > FEE_DEN ? FEE_DEN : c.feeMillionth;
    return { gammaPpm: FEE_DEN, muPpm: FEE_DEN - feePpm };
  },
} satisfies SvmVenueLadderV2;
