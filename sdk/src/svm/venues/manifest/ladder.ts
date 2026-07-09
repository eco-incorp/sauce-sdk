/**
 * Manifest CLOB adapter v2 (EcoSwapSVM ladder fragment) — the second Phase 2
 * family and the first order-book venue. The quote is the venue's own taker
 * match: a best-first walk over the resting orders shipped by prepare
 * (../manifest/index.ts). Prepare walks the market's red-black tree OFF-CHAIN
 * (the successor walk is unbounded and unaffordable in-VM, the same class as
 * whirlpool's rejected tick discovery) and ships up to MANIFEST_MAX_ORDERS
 * price levels as (DataIndex, sequence_number) cfg params; the fragment reads
 * each shipped order's price + num_base_atoms LIVE from the market account.
 *
 * The sequence_number is the drift-invariant identity anchor (a monotonic
 * per-order id, stable across partial fills, unique across the free-list reuse
 * a fill/cancel causes): the fragment validates it live per order and STOPS the
 * walk on the first mismatch — the CLOB analogue of whirlpool skipping a
 * removed tick, self-deactivating when the book has moved out from under the
 * shipped levels. See index.ts for the full drift semantics.
 *
 * PRICE LEVELS ARE THE LADDER: each shipped order is a discrete step — capacity
 * = its size (in the input token), marginal price = its listed price, ZERO fee
 * (Manifest charges no taker fee). The quote is exact at every point (a CLOB
 * output is piecewise-linear in the levels; the walk computes it lamport-exact,
 * no curve sampling), so the book contributes NO quantization loss; only the
 * shared geometric split-grid applies, and the binding rung partial-fills to
 * the atom.
 *
 * Venue-exactness sources (transcribed, not derived): github.com/CKS-Systems/
 * manifest programs/manifest/src/{state/market.rs impact_base_atoms +
 * place_order, quantities.rs checked_base_for_quote / checked_quote_for_base}.
 * Two directions, exactly the venue's two taker paths:
 * - baseIn (sell base, is_base_in=true, matches BIDS): full order rounds quote
 *   UP (taker favor), the marginal partial rounds DOWN (place_order:
 *   round_up = is_bid != did_fully_match = false != full);
 * - quoteIn (buy base, is_base_in=false, matches ASKS): impact_base_atoms —
 *   base_limit = floor(1e18 * quote / price), full when base_limit >= size,
 *   full-order quote consumed = floor(price * size / 1e18) (round DOWN), the
 *   marginal partial takes base_limit and stops.
 *
 * Conversions (quantities.rs), price stored as inner = price * 1e18 (u128):
 *   quote_for_base(base, up) = round(inner * base / 1e18)
 *   base_for_quote(quote, up) = round(1e18 * quote / inner)
 * A conversion the venue would reject (u128 product overflow / result > u64)
 * surfaces as the SENT sentinel (2^65) and the walk clamps — the merge patches
 * a smaller fill that never triggers the abort, so the CPI is safe.
 *
 * Overflow bounds (engine wraps at 2^256, the mirror is plain bigint — they
 * agree because nothing wraps): inner (u128) * base (u64) < 2^192; 1e18 * quote
 * (u64) < 2^128; both far below 2^256. The venue's own u128 guard is mirrored
 * by the SENT check.
 */
import { address } from '@solana/kit';
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
  MANIFEST_MAX_ORDERS,
  MANIFEST_PROGRAM_ID,
  MARKET_FIXED_SIZE,
  OFF_ORDER_PRICE,
  OFF_ORDER_SEQ,
  OFF_ORDER_SIZE,
  PRICE_D18,
  manifestWindowFor,
} from './index.js';
import type { ManifestPoolConfig } from './index.js';

export { MANIFEST_MAX_ORDERS };

const SLUG = 'manifest';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;

/** ManifestInstruction::Swap discriminant (a single leading byte). */
const SWAP_INSTRUCTION = 4;

/** Walk loop bound: MANIFEST_MAX_ORDERS full steps + one partial. */
const WALK_BOUND = MANIFEST_MAX_ORDERS + 1;
/** cfg words per slot: nb + (DataIndex, sequenceNumber) per shipped order. */
const PARAM_COUNT = 1 + 2 * MANIFEST_MAX_ORDERS;

// Shared numeric constants (fragment literals == mirror bigints).
const U64_MAX = (1n << 64n) - 1n;
const Q128 = 1n << 128n;
/** "Exceeds u64 / would overflow" sentinel: 2^65 — above any valid atom count. */
const SENT = 1n << 65n;

// Absolute market-account offsets for an order at runtime DataIndex `ix`:
// block base = MARKET_FIXED_SIZE + ix, payload field at base + OFF_ORDER_*.
const ABS_PRICE = MARKET_FIXED_SIZE + OFF_ORDER_PRICE; // ix + 272
const ABS_SIZE = MARKET_FIXED_SIZE + OFF_ORDER_SIZE; //  ix + 288
const ABS_SEQ = MARKET_FIXED_SIZE + OFF_ORDER_SEQ; //   ix + 296

// ---------------------------------------------------------------------------
// Conversion helpers (quantities.rs). SENT (2^65) means "the venue would
// reject this amount" (u128 product overflow or a u64-exceeding result).
// ---------------------------------------------------------------------------

const HELPERS: { name: string; source: string }[] = [
  {
    // checked_quote_for_base: round(inner * base / 1e18). inner*base >= 2^128 is
    // the venue's PriceConversionError(0x8); a result > u64::MAX is 0x9.
    name: 'mfQfb',
    source: [
      'function mfQfb(inner, base, up) {',
      '  if (base === 0) { return 0 }',
      '  const p = inner * base;',
      `  if (p >= ${Q128}) { return ${SENT} }`,
      `  let q = p / ${PRICE_D18};`,
      `  if (up !== 0 && q * ${PRICE_D18} < p) { q = q + 1 }`,
      `  if (q > ${U64_MAX}) { return ${SENT} }`,
      '  return q;',
      '}',
    ].join('\n'),
  },
  {
    // checked_base_for_quote: round(1e18 * quote / inner). 1e18*quote never
    // overflows u128 (u64::MAX * 1e18 < 2^128); a result > u64::MAX is 0x5.
    name: 'mfBfq',
    source: [
      'function mfBfq(inner, quote, up) {',
      '  if (inner === 0) { return 0 }',
      `  const d = ${PRICE_D18} * quote;`,
      '  let b = d / inner;',
      '  if (up !== 0 && b * inner < d) { b = b + 1 }',
      `  if (b > ${U64_MAX}) { return ${SENT} }`,
      '  return b;',
      '}',
    ].join('\n'),
  },
];

/** TS mirror of mfQfb (checked_quote_for_base). */
export function manifestQuoteForBase(inner: bigint, base: bigint, roundUp: boolean): bigint {
  if (base === 0n) return 0n;
  const p = inner * base;
  if (p >= Q128) return SENT;
  let q = p / PRICE_D18;
  if (roundUp && q * PRICE_D18 < p) q += 1n;
  return q > U64_MAX ? SENT : q;
}

/** TS mirror of mfBfq (checked_base_for_quote). */
export function manifestBaseForQuote(inner: bigint, quote: bigint, roundUp: boolean): bigint {
  if (inner === 0n) return 0n;
  const d = PRICE_D18 * quote;
  let b = d / inner;
  if (roundUp && b * inner < d) b += 1n;
  return b > U64_MAX ? SENT : b;
}

// ---------------------------------------------------------------------------
// The TS mirror of the setup + walk. The fragment emission below and these
// functions transcribe ONE algorithm — change them together or the
// lamport-exact gate breaks.
// ---------------------------------------------------------------------------

interface ManifestLevel {
  price: bigint; // inner (price * 1e18)
  size: bigint; // num_base_atoms
  aux: bigint; // baseIn: full-order quote out (UP); quoteIn: full-order quote in (DOWN)
}

function manifestConfig(cfg: PoolConfig): ManifestPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as ManifestPoolConfig;
}

/**
 * Live verification over a shipped-order list: for each (DataIndex, seq), read
 * the live sequence_number and STOP on the first mismatch (the block was reused
 * / freed — drift); otherwise read the live price + size and precompute the
 * direction's full-order aux. Transcribed by emitSetup.
 */
function readLevels(
  market: Uint8Array,
  orders: readonly { dataIndex: number; sequenceNumber: bigint }[],
  baseIn: boolean,
): ManifestLevel[] {
  const levels: ManifestLevel[] = [];
  for (const order of orders) {
    const base = MARKET_FIXED_SIZE + order.dataIndex;
    const seqLive = readUintLE(market, base + OFF_ORDER_SEQ, 8);
    if (seqLive !== order.sequenceNumber) break; // identity mismatch — stop the walk
    const price = readUintLE(market, base + OFF_ORDER_PRICE, 16);
    const size = readUintLE(market, base + OFF_ORDER_SIZE, 8);
    const aux = manifestQuoteForBase(price, size, baseIn); // UP for baseIn, DOWN for quoteIn
    levels.push({ price, size, aux });
  }
  return levels;
}

/** The reference levels, keyed off the SHIPPED PARAMS (drift-correct, exactly like the fragment). */
function effectiveLevels(cfg: ManifestPoolConfig, state: AccountBytesMap, params: readonly bigint[]): ManifestLevel[] {
  const market = state[cfg.pool];
  if (market === undefined) throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
  const nb = Number(params[0] ?? 0n);
  const orders: { dataIndex: number; sequenceNumber: bigint }[] = [];
  for (let k = 0; k < nb && k < MANIFEST_MAX_ORDERS; k++) {
    orders.push({ dataIndex: Number(params[1 + 2 * k]), sequenceNumber: params[2 + 2 * k] });
  }
  return readLevels(market, orders, cfg.direction === 'baseIn');
}

/** Cold taker walk over the shipped levels — exact reproduction of the venue's two match paths. */
function coldWalk(levels: readonly ManifestLevel[], baseIn: boolean, x: bigint): bigint {
  if (x <= 0n) return 0n;
  let remaining = x;
  let out = 0n;
  for (let k = 0; k < levels.length && remaining > 0n; k++) {
    const level = levels[k];
    if (baseIn) {
      // sell base: match bids. Full order -> quote UP (precomputed aux); marginal partial -> DOWN.
      if (remaining >= level.size) {
        if (level.aux >= SENT) break;
        out += level.aux;
        remaining -= level.size;
      } else {
        const pv = manifestQuoteForBase(level.price, remaining, false);
        if (pv >= SENT) break;
        out += pv;
        remaining = 0n;
      }
    } else {
      // buy base: impact_base_atoms over asks. base_limit floor; full when >= size.
      const bl = manifestBaseForQuote(level.price, remaining, false);
      if (bl >= SENT) break;
      if (bl >= level.size) {
        out += level.size;
        remaining -= level.aux; // aux = qfb(size, DOWN) = matched_quote for a full fill
      } else {
        out += bl;
        remaining = 0n;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fragment emission. Slot-local names are s<i>-prefixed short codes; the
// reserved codegen surface (s<i>en, s<i>p<k>, s<i>g<j>, s<i>o<j>, amountIn,
// minOut) is untouched.
// ---------------------------------------------------------------------------

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

/** One emitted walk (the fragment twin of coldWalk) into the slot's cursor vars, over grid point `xExpr`. */
function emitWalk(p: string, baseIn: boolean, xExpr: string, outVar: string, tag: string, indent: string, decl: 'const' | 'let'): string[] {
  const step = baseIn
    ? [
        `${indent}    if (${p}rm >= ${p}sz[${p}k]) {`,
        `${indent}      if (${p}au[${p}k] >= ${SENT}) { ${p}dn = 1 }`,
        `${indent}      else { ${p}out = ${p}out + ${p}au[${p}k]; ${p}rm = ${p}rm - ${p}sz[${p}k]; ${p}k = ${p}k + 1; }`,
        `${indent}    } else {`,
        `${indent}      ${p}pv = mfQfb(${p}pr[${p}k], ${p}rm, 0);`,
        `${indent}      if (${p}pv >= ${SENT}) { ${p}dn = 1 } else { ${p}out = ${p}out + ${p}pv; ${p}rm = 0; }`,
        `${indent}    }`,
      ]
    : [
        `${indent}    ${p}bl = mfBfq(${p}pr[${p}k], ${p}rm, 0);`,
        `${indent}    if (${p}bl >= ${SENT}) { ${p}dn = 1 }`,
        `${indent}    else {`,
        `${indent}      if (${p}bl >= ${p}sz[${p}k]) { ${p}out = ${p}out + ${p}sz[${p}k]; ${p}rm = ${p}rm - ${p}au[${p}k]; ${p}k = ${p}k + 1; }`,
        `${indent}      else { ${p}out = ${p}out + ${p}bl; ${p}rm = 0; }`,
        `${indent}    }`,
      ];
  return [
    `${indent}${decl} ${outVar} = 0;`,
    `${indent}if (${p}vld !== 0 && ${xExpr} > 0) {`,
    `${indent}  ${p}rm = ${xExpr}; ${p}out = 0; ${p}k = 0; ${p}dn = 0;`,
    `${indent}  for (let ${p}w${tag} = 0; ${p}w${tag} < ${WALK_BOUND} && ${p}rm > 0 && ${p}k < ${p}nb && ${p}dn === 0; ${p}w${tag}++) {`,
    ...step,
    `${indent}  }`,
    `${indent}  ${outVar} = ${p}out;`,
    // Remember the last computed grid point so the cold final quote can reuse it.
    `${indent}  ${p}lo = ${p}out; ${p}lx = ${xExpr};`,
    `${indent}}`,
  ];
}

/** Per-shipped-order live verification (unrolled; the order count nb is a param). */
function emitOrderRead(p: string, slot: number, k: number, baseIn: boolean, params: readonly string[]): string[] {
  const mkt = JSON.stringify(ref(slot, 'mkt'));
  const idxParam = params[1 + 2 * k];
  const seqParam = params[2 + 2 * k];
  const auxRound = baseIn ? 1 : 0; // baseIn: full-order quote out UP; quoteIn: full-order quote in DOWN
  return [
    `    if (${p}st === 0 && ${params[0]} > ${k}) {`,
    `      ${p}ix = ${idxParam};`,
    `      if (accountUint(${mkt}, ${p}ix + ${ABS_SEQ}, 8) === ${seqParam}) {`,
    `        ${p}pr[${p}nb] = accountUint(${mkt}, ${p}ix + ${ABS_PRICE}, 16);`,
    `        ${p}sz[${p}nb] = accountUint(${mkt}, ${p}ix + ${ABS_SIZE}, 8);`,
    `        ${p}au[${p}nb] = mfQfb(${p}pr[${p}nb], ${p}sz[${p}nb], ${auxRound});`,
    `        ${p}nb = ${p}nb + 1;`,
    `      } else { ${p}st = 1; }`,
    `    }`,
  ];
}

export const manifestLadder = {
  slug: SLUG,

  /**
   * 2 rungs by default: the setup (MANIFEST_MAX_ORDERS unrolled live reads over
   * the whole book account) is a heavy fixed cost, so a manifest slot is a
   * degrade-first 'stable'-class family like whirlpool (see
   * recipes/ecoswap/svm/budget.ts). The cold walk is exact at any point, so a
   * coarser rung grid only affects the split quantization, not correctness.
   */
  defaultRungs: 2,

  shapeKey(base: PoolConfig): string {
    return `${SLUG}:${manifestConfig(base).direction}`;
  },

  helpers(): { name: string; source: string }[] {
    return HELPERS;
  },

  /** [nb, (DataIndex, sequenceNumber) x MANIFEST_MAX_ORDERS]. */
  paramCount: PARAM_COUNT,

  paramsFor(base: PoolConfig): bigint[] {
    const window = manifestWindowFor(manifestConfig(base));
    const words: bigint[] = [BigInt(window.orders.length)];
    for (let k = 0; k < MANIFEST_MAX_ORDERS; k++) {
      const order = window.orders[k];
      if (order === undefined) {
        words.push(0n, 0n);
        continue;
      }
      words.push(BigInt(order.dataIndex), order.sequenceNumber);
    }
    return words;
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    // The whole book lives in ONE account — a quote reads only the market.
    return [{ ref: ref(slot, 'mkt'), address: manifestConfig(base).pool }];
  },

  emitSetup(base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string {
    const cfg = manifestConfig(base);
    const baseIn = cfg.direction === 'baseIn';
    const p = `s${slot}`;
    const enabled = enableVar ?? `${p}en`;
    const lines = [
      `  const ${p}pr = new Array(${MANIFEST_MAX_ORDERS});`,
      `  const ${p}sz = new Array(${MANIFEST_MAX_ORDERS});`,
      `  const ${p}au = new Array(${MANIFEST_MAX_ORDERS});`,
      `  let ${p}nb = 0;`,
      `  let ${p}st = 0;`,
      `  let ${p}ix = 0;`,
      // Walk cursor (shared by the rungs and the cold final quote — main scope).
      `  let ${p}rm = 0; let ${p}out = 0; let ${p}k = 0; let ${p}dn = 0; let ${p}bl = 0; let ${p}pv = 0;`,
      `  let ${p}lo = 0; let ${p}lx = 0;`,
      `  if (${enabled} !== 0) {`,
      ...Array.from({ length: MANIFEST_MAX_ORDERS }, (_, k) => emitOrderRead(p, slot, k, baseIn, params)).flat(),
      `  }`,
      `  let ${p}vld = 0;`,
      `  if (${p}nb > 0) { ${p}vld = 1 }`,
    ];
    return lines.join('\n');
  },

  emitLadderQuote(base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string {
    const baseIn = manifestConfig(base).direction === 'baseIn';
    return emitWalk(`s${slot}`, baseIn, x, outVar, `${rung}`, '    ', 'const').join('\n');
  },

  emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string {
    const p = `s${slot}`;
    const baseIn = manifestConfig(base).direction === 'baseIn';
    // Reuse the last computed ladder grid point when the elected fill lands on
    // it (the whole-trade case / a fully consumed slot) — value-identical to a
    // fresh walk, so the mirror stays plain (pointwise quote).
    return [
      `  let ${outVar} = 0;`,
      `  if (${p}vld !== 0 && ${x} > 0) {`,
      `    if (${p}lx === ${x}) { ${outVar} = ${p}lo }`,
      `    else {`,
      ...emitWalk(p, baseIn, x, `${p}fq`, 'f', '      ', 'let').map((line) => '  ' + line),
      `      ${outVar} = ${p}fq;`,
      `    }`,
      `  }`,
    ].join('\n');
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const cfg = manifestConfig(base);
    const baseIn = cfg.direction === 'baseIn';
    // Swap ix data: [disc=4][in_atoms u64 LE (runtime-patched)][out_atoms u64
    // LE = 1][is_base_in u8][is_exact_in u8 = 1] (Borsh SwapParams). Venue
    // out_atoms (min out) = 1 — the terminal outAta delta enforces the real
    // bound. is_exact_in: the patched in_atoms is the exact input slice.
    const suffix = new Uint8Array(8 + 1 + 1);
    suffix[0] = 1; // out_atoms = 1
    suffix[8] = baseIn ? 1 : 0; // is_base_in
    suffix[9] = 1; // is_exact_in = true
    const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
    return {
      programId: MANIFEST_PROGRAM_ID,
      prefix: Uint8Array.from([SWAP_INSTRUCTION]),
      suffix,
      patch: 'in',
      // Swap (disc 4), classic-SPL, no global: the minimal 8-account form.
      // account[0] payer == owner (single-account case, market is manifest-owned).
      accounts: [
        { ref: user.owner, signer: true, writable: true },
        roled('mkt', cfg.pool, true),
        roled('sys', address('11111111111111111111111111111111')),
        // trader_base / trader_quote: base-in spends base (inAta) for quote (outAta); quote-in the reverse.
        { ref: baseIn ? user.inAta : user.outAta, writable: true },
        { ref: baseIn ? user.outAta : user.inAta, writable: true },
        roled('bv', cfg.baseVault, true),
        roled('qv', cfg.quoteVault, true),
        roled('tp', TOKEN_PROGRAM),
      ],
    };
  },

  /**
   * Exact mirror of the emitted fragment given the SAME cfg + params the blob
   * was prepared with, over live account bytes — the shipped order set rides
   * the params (DataIndex + seq), so callers mirroring a drifted execution must
   * pass the prepare-time cfg/params (as the orchestrator and e2e suites do).
   */
  referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint {
    const cfg = manifestConfig(base);
    const baseIn = cfg.direction === 'baseIn';
    const levels = effectiveLevels(cfg, state, params);
    return (x: bigint): bigint => coldWalk(levels, baseIn, x);
  },

  // No referenceLadderQuotes: the ladder is pointwise (each rung is an
  // independent cold walk, no warm-start), so buildLadder's default
  // grid.map(quote) mirrors the fragment exactly.

  /**
   * Depth for the relative filter: the shipped top-of-book aggregate. reserveIn
   * = total input capacity across the shipped levels, reserveOut = total output
   * — isqrt(in*out) gives a book-depth metric comparable to a pool's reserves.
   */
  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const cfg = manifestConfig(base);
    const baseIn = cfg.direction === 'baseIn';
    // Prepare-time metric (no drift) — the shipped window's aggregate depth.
    const market = state[cfg.pool];
    if (market === undefined) throw new Error(`${SLUG} ladder depth is missing account ${cfg.pool}`);
    const levels = readLevels(market, manifestWindowFor(cfg).orders, baseIn);
    let reserveIn = 0n;
    let reserveOut = 0n;
    for (const level of levels) {
      if (level.aux >= SENT) continue;
      if (baseIn) {
        // input = base (size), output = quote (full-order aux).
        reserveIn += level.size;
        reserveOut += level.aux;
      } else {
        // input = quote (full-order aux), output = base (size).
        reserveIn += level.aux;
        reserveOut += level.size;
      }
    }
    return { reserveIn, reserveOut };
  },

  /**
   * Manifest is ZERO-fee and not a constant-product curve — the continuous CP
   * oracle is meaningless here (it is measurement-only and CP-class-only). No
   * fee, unit multiplier.
   */
  continuousFees(): { gammaPpm: bigint; muPpm: bigint } {
    return { gammaPpm: 1_000_000n, muPpm: 1_000_000n };
  },
} satisfies SvmVenueLadderV2;
