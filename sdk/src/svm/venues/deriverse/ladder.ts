/**
 * Deriverse adapter v2 (EcoSwapSVM ladder fragment) — the embedded
 * constant-product leg of a hybrid CLOB+AMM instrument, everything read LIVE
 * from the ONE instrument account (no separate vault reads needed: reserves,
 * dec_factor and last_px all live in the same header). See index.ts's module
 * doc for the venue-level scope decision (AMM-only, book excluded) and the
 * fee model (feePpm is a baked cfg param, not a live read).
 *
 * QUOTE (transcribed + simplified from the real program's `amm.rs`, verified
 * to reduce to the plain constant-product form — see the derivation note
 * below):
 *   SELL (asset in, crncy out — cfg.side === 'sell'):
 *     newA = a + cx
 *     raw  = max(b - floor(k / newA) - 1, 0)     (the "-1" mirrors amm.rs's
 *                                                  own pool-favor rounding
 *                                                  guard against its f64
 *                                                  arithmetic; harmless and
 *                                                  exact here since we use
 *                                                  true integer division)
 *     out  = max(raw - ceil(raw * feePpm / 1e6), 0)
 *   BUY (crncy in, asset out — cfg.side === 'buy'):
 *     netIn = floor(cx * 1e6 / (1e6 + feePpm))
 *     newB  = b + netIn
 *     out   = max(a - floor(k / newB) - 1, 0)
 *
 * DERIVATION NOTE (why this is the real formula, not an approximation):
 * amm.rs's `get_amm_sum`/`get_reversed_amm_qty` (the forward exactIn paths
 * `lib.rs`'s `quote()` calls in the no-book-crossing case) compute exactly
 * `reserveOut - floor(k / (reserveIn + in))` with a "-1 if the f64 arithmetic
 * would violate the invariant" correction — algebraically identical to
 * `floor(reserveOut * in / (reserveIn + in))` (since `reserveOut - k/(rIn+in)
 * = reserveOut - reserveIn*reserveOut/(rIn+in) = reserveOut*in/(rIn+in)`).
 * The fee handling differs by direction in the real program: BUY charges
 * its fee on the CRNCY INPUT before it reaches the curve (`input_sum =
 * input_amount / (1+fee_rate+swap_fee_rate)`), SELL charges its fee on the
 * curve's raw CRNCY OUTPUT (`total_fees += traded_mints * fee_rate`) — both
 * preserved here.
 *
 * VALIDATION (2026-07-31, against the real deployed program via Jupiter's
 * public `dexes=Deriverse`-filtered quote — Deriverse is closed-source with
 * no local devnet mirror, so this is the strongest live cross-check
 * available without a funded mainnet wallet): on the live wSOL/USDC
 * instrument (8Wk2L1yDovBJifCN1o86X7g7pDcqLau39m6tEsJ9Sheh), fetching this
 * adapter's account state immediately before each Jupiter quote:
 *   sell 0.1 SOL:  ours 7,283,214 vs Jupiter 7,289,644 USDC-lamports (-8.8bps)
 *   sell 1   SOL:  ours 72,210,730 vs Jupiter 72,888,605           (-93.0bps)
 *   sell 5   SOL:  ours 347,862,391 vs Jupiter 364,294,839         (-451bps)
 *   buy  10 USDC:  ours 136,968,742 vs Jupiter 137,158,081 SOL-lamports (-13.8bps)
 *   buy  100 USDC: ours 1,353,530,944 vs Jupiter 1,371,427,100     (-130.5bps)
 *   buy  500 USDC: ours 6,434,211,181 vs Jupiter 6,848,477,633     (-604.9bps)
 * ALWAYS below Jupiter's real figure, by a margin that GROWS with size —
 * exactly the signature of the excluded resting-order book absorbing more
 * of a larger trade (see index.ts's module doc); never once above. The
 * USDT/USDC instrument (asset_tokens == crncy_tokens == 0, no embedded AMM
 * liquidity) still gets a real Jupiter fill (~0.9992 out-per-in) purely from
 * its book — this adapter correctly quotes 0 for it (self-drops), which is
 * the same safe under-quote, not a defect.
 *
 * CIRCUIT BREAKER (the venue's own, reproduced as a capacity clamp): the
 * real Swap/NewSpotOrder path stops filling once the AMM's marginal price
 * `k*df/(newA)^2` would move beyond `last_px +/- (last_px >> 3)` (or `>> 4`
 * for SimilarAssets pairs) — this fragment enforces the tighter `>> 4` bound
 * UNCONDITIONALLY (never the looser one, so it can only be MORE
 * conservative than the real breaker, never less) via a live isqrt-based
 * capacity clamp — `capacityInputVar`/`referenceCapacities`, the same
 * saturating-clamp shape obric-v2 uses for its own capacity cliff. Ceiling
 * rounding is used everywhere on the BUY side's cap derivation (a smaller
 * cap is always safe); floor rounding on the SELL side's (ditto).
 */
import type { Address } from '@solana/kit';
import { ceilDiv, readUintLE } from '../math.js';
import type {
  AccountBytesMap,
  LadderSwapTemplate,
  PoolConfig,
  SvmVenueLadderV2,
  SwapUser,
  VenueAccount,
} from '../types.js';
import { DERIVERSE_PROGRAM_ID, MASK_SUSPENDED, OFF_ASSET_TOKENS, OFF_CRNCY_TOKENS, OFF_DEC_FACTOR, OFF_LAST_PX, OFF_MASK, deriverseSwapAccounts } from './index.js';
import type { DeriversePoolConfig } from './index.js';

const SLUG = 'deriverse';
const FEE_DEN = 1_000_000n;

function deriverseConfig(base: PoolConfig): DeriversePoolConfig {
  if (base.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${base.venue}' pool config`);
  return base as DeriversePoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

/** Floor integer square root (mirrors the engine's Math.sqrt op / obric-v2's own isqrt). */
export function deriverseIsqrt(value: bigint): bigint {
  if (value < 0n) throw new Error(`deriverseIsqrt needs a non-negative value, got ${value}`);
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/** Ceiling integer square root: smallest r with r*r >= value. */
export function deriverseCeilIsqrt(value: bigint): bigint {
  const r = deriverseIsqrt(value);
  return r * r === value ? r : r + 1n;
}

interface LiveCurve {
  enabled: boolean;
  a: bigint;
  b: bigint;
  k: bigint;
  df: bigint;
  px: bigint;
  feePpm: bigint;
}

function liveCurve(cfg: DeriversePoolConfig, state: AccountBytesMap): LiveCurve {
  const pool = state[cfg.pool];
  if (pool === undefined) throw new Error(`${SLUG} reference is missing pool ${cfg.pool}`);
  const mask = readUintLE(pool, OFF_MASK, 4);
  const a = readUintLE(pool, OFF_ASSET_TOKENS, 8);
  const b = readUintLE(pool, OFF_CRNCY_TOKENS, 8);
  const df = readUintLE(pool, OFF_DEC_FACTOR, 8);
  const px = readUintLE(pool, OFF_LAST_PX, 8);
  const enabled = (mask & BigInt(MASK_SUSPENDED)) === 0n && a > 0n && b > 0n && df > 0n && px > 0n;
  return { enabled, a, b, k: enabled ? a * b : 0n, df, px, feePpm: cfg.feePpm };
}

/** The (icap, k) pair the SELL/BUY caps reduce to — see the file header derivation. */
function capacity(curve: LiveCurve, side: 'buy' | 'sell'): bigint {
  if (!curve.enabled) return 0n;
  const { a, b, k, df, feePpm } = curve;
  const maxDiff = curve.px >> 4n;
  const kdf = k * df;
  if (side === 'sell') {
    const floorPx = curve.px - maxDiff;
    const newAMax = deriverseIsqrt(kdf / floorPx);
    const cap = newAMax - a;
    return cap > 0n ? cap : 0n;
  }
  const ceilPx = curve.px + maxDiff;
  const newAMin = deriverseCeilIsqrt(ceilDiv(kdf, ceilPx));
  let netInCap = k / newAMin - b;
  if (netInCap < 0n) netInCap = 0n;
  return (netInCap * (FEE_DEN + feePpm)) / FEE_DEN;
}

/** The COLD (venue-exact) quote at gross input x, SATURATING at the capacity clamp — see the file header. */
export function deriverseRawQuote(x: bigint, curve: LiveCurve, side: 'buy' | 'sell', icap: bigint): bigint {
  if (!curve.enabled) return 0n;
  const cx = x > icap ? icap : x;
  if (cx <= 0n) return 0n;
  const { a, b, k, feePpm } = curve;
  if (side === 'sell') {
    const newA = a + cx;
    const raw0 = b - k / newA;
    const raw = raw0 > 0n ? raw0 - 1n : 0n;
    const fee = ceilDiv(raw * feePpm, FEE_DEN);
    return raw > fee ? raw - fee : 0n;
  }
  const netIn = (cx * FEE_DEN) / (FEE_DEN + feePpm);
  if (netIn <= 0n) return 0n;
  const newB = b + netIn;
  const raw0 = a - k / newB;
  return raw0 > 0n ? raw0 - 1n : 0n;
}

export const deriverseLadder = {
  slug: SLUG,

  /** CP-class: a closed-form quote (one deriverseIsqrt-derived cap + a division), 4 rungs. */
  defaultRungs: 4,

  shapeKey(base: PoolConfig): string {
    return `${SLUG}:${deriverseConfig(base).side}`;
  },

  helpers(): { name: string; source: string }[] {
    return [
      {
        name: 'drvCeilDiv',
        source: ['function drvCeilDiv(a, b) {', '  return (a + b - 1) / b;', '}'].join('\n'),
      },
      {
        name: 'drvCeilIsqrt',
        source: [
          'function drvCeilIsqrt(n) {',
          '  const r = Math.sqrt(n);',
          '  if (r * r === n) { return r }',
          '  return r + 1;',
          '}',
        ].join('\n'),
      },
    ];
  },

  paramCount: 1,

  paramsFor(base: PoolConfig): bigint[] {
    return [deriverseConfig(base).feePpm];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const c = deriverseConfig(base);
    return [{ ref: ref(slot, 'pool'), address: c.pool }];
  },

  emitSetup(base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string {
    const c = deriverseConfig(base);
    const p = `s${slot}`;
    const en = enableVar ?? `${p}en`;
    const pool = JSON.stringify(ref(slot, 'pool'));
    const [feePpm] = params;
    const capLines =
      c.side === 'sell'
        ? [
            `      const ${p}floorpx = ${p}px - ${p}maxdiff;`,
            `      const ${p}newamax = Math.sqrt(${p}kdf / ${p}floorpx);`,
            `      let ${p}cap = ${p}newamax - ${p}a;`,
            `      if (${p}cap < 0) { ${p}cap = 0 }`,
            `      ${p}icap = ${p}cap;`,
          ]
        : [
            `      const ${p}ceilpx = ${p}px + ${p}maxdiff;`,
            `      const ${p}newamin = drvCeilIsqrt(drvCeilDiv(${p}kdf, ${p}ceilpx));`,
            `      let ${p}netincap = ${p}k / ${p}newamin - ${p}b;`,
            `      if (${p}netincap < 0) { ${p}netincap = 0 }`,
            `      ${p}icap = ${p}netincap * (1000000 + ${feePpm}) / 1000000;`,
          ];
    // Rung-scratch locals emitLadderQuote ASSIGNS (never re-declares) on every
    // rung call — it runs once PER RUNG in the same function scope, so these
    // must be declared exactly once, here (the same shape obric-v2 uses for
    // its own s<slot>ni/no/gg rung scratch).
    const scratchDecl =
      c.side === 'sell'
        ? [`  let ${p}newa = 0;`, `  let ${p}raw0 = 0;`, `  let ${p}raw = 0;`, `  let ${p}rfee = 0;`]
        : [`  let ${p}netin = 0;`, `  let ${p}newb = 0;`, `  let ${p}raw0 = 0;`];
    return [
      // LIVE reads (unconditional — one account, the instrument itself).
      `  const ${p}mask = accountUint(${pool}, ${OFF_MASK}, 4);`,
      `  const ${p}a = accountUint(${pool}, ${OFF_ASSET_TOKENS}, 8);`,
      `  const ${p}b = accountUint(${pool}, ${OFF_CRNCY_TOKENS}, 8);`,
      `  const ${p}df = accountUint(${pool}, ${OFF_DEC_FACTOR}, 8);`,
      `  const ${p}px = accountUint(${pool}, ${OFF_LAST_PX}, 8);`,
      // feePpm is a baked param (see index.ts's conservativeFeePpm) — captured
      // in a slot local so emitLadderQuote/emitFinalQuote can reference it
      // without re-threading params (they receive no `params` argument).
      `  const ${p}fee = ${feePpm};`,
      `  let ${p}k = 0;`,
      `  let ${p}icap = 0;`,
      `  let ${p}cx = 0;`,
      ...scratchDecl,
      `  if (${en} !== 0) {`,
      `    let ${p}ok = 1;`,
      `    if ((${p}mask & ${MASK_SUSPENDED}) !== 0) { ${p}ok = 0 }`,
      `    if (${p}a <= 0) { ${p}ok = 0 }`,
      `    if (${p}b <= 0) { ${p}ok = 0 }`,
      `    if (${p}df <= 0) { ${p}ok = 0 }`,
      `    if (${p}px <= 0) { ${p}ok = 0 }`,
      `    if (${p}ok !== 0) {`,
      `      ${p}k = ${p}a * ${p}b;`,
      `      const ${p}maxdiff = ${p}px >> 4;`,
      `      const ${p}kdf = ${p}k * ${p}df;`,
      ...capLines,
      `    }`,
      `  }`,
    ].join('\n');
  },

  capacityInputVar(slot: number): string {
    return `s${slot}cx`;
  },

  /** Ladder rung at cumulative grid point `x`: qRaw(min(x, icap)) — stateless, mirrors deriverseRawQuote. */
  emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string {
    const c = deriverseConfig(base);
    const p = `s${slot}`;
    const feeExpr = `${p}fee`;
    // ASSIGN (never re-declare) the scratch locals emitSetup pre-declared —
    // this function runs once per rung in one shared scope.
    const quoteLines =
      c.side === 'sell'
        ? [
            `      ${p}newa = ${p}a + ${p}cx;`,
            `      ${p}raw0 = ${p}b - ${p}k / ${p}newa;`,
            `      ${p}raw = 0;`,
            `      if (${p}raw0 > 0) { ${p}raw = ${p}raw0 - 1 }`,
            `      ${p}rfee = drvCeilDiv(${p}raw * ${feeExpr}, 1000000);`,
            `      if (${p}raw > ${p}rfee) { ${outVar} = ${p}raw - ${p}rfee }`,
          ]
        : [
            `      ${p}netin = ${p}cx * 1000000 / (1000000 + ${feeExpr});`,
            `      if (${p}netin > 0) {`,
            `        ${p}newb = ${p}b + ${p}netin;`,
            `        ${p}raw0 = ${p}a - ${p}k / ${p}newb;`,
            `        if (${p}raw0 > 0) { ${outVar} = ${p}raw0 - 1 }`,
            `      }`,
          ];
    return [
      `    ${p}cx = ${x};`,
      `    if (${p}cx > ${p}icap) { ${p}cx = ${p}icap }`,
      `    let ${outVar} = 0;`,
      `    if (${p}cx > 0 && ${p}k !== 0) {`,
      ...quoteLines,
      `    }`,
    ].join('\n');
  },

  /** Cold final quote — same capacity clamp, fresh locals (no rung state to reuse). */
  emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string {
    const c = deriverseConfig(base);
    const p = `s${slot}`;
    const feeExpr = `${p}fee`;
    const quoteLines =
      c.side === 'sell'
        ? [
            `    const ${p}fnewa = ${p}fcx + ${p}a;`,
            `    const ${p}fraw0 = ${p}b - ${p}k / ${p}fnewa;`,
            `    let ${p}fraw = 0;`,
            `    if (${p}fraw0 > 0) { ${p}fraw = ${p}fraw0 - 1 }`,
            `    const ${p}ffee = drvCeilDiv(${p}fraw * ${feeExpr}, 1000000);`,
            `    if (${p}fraw > ${p}ffee) { ${outVar} = ${p}fraw - ${p}ffee }`,
          ]
        : [
            `    const ${p}fnetin = ${p}fcx * 1000000 / (1000000 + ${feeExpr});`,
            `    if (${p}fnetin > 0) {`,
            `      const ${p}fnewb = ${p}b + ${p}fnetin;`,
            `      const ${p}fraw0 = ${p}a - ${p}k / ${p}fnewb;`,
            `      if (${p}fraw0 > 0) { ${outVar} = ${p}fraw0 - 1 }`,
            `    }`,
          ];
    return [
      `  let ${p}fcx = ${x};`,
      `  if (${p}fcx > ${p}icap) { ${p}fcx = ${p}icap }`,
      `  let ${outVar} = 0;`,
      `  if (${p}fcx > 0 && ${p}k !== 0) {`,
      ...quoteLines,
      `  }`,
    ].join('\n');
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const c = deriverseConfig(base);
    // Swap (disc 26): tag(1) input_crncy(1) padding_u16(2) instr_id(4) price
    // i64(8)=0 ++ amount u64 LE (runtime-patched) ++ min_amount_out i64(8)=1.
    const prefix = new Uint8Array(16);
    const dv = new DataView(prefix.buffer);
    prefix[0] = 26;
    prefix[1] = c.side === 'buy' ? 1 : 0;
    dv.setUint32(4, c.instrId, true);
    dv.setBigInt64(8, 0n, true);
    const suffix = new Uint8Array(8);
    new DataView(suffix.buffer).setBigInt64(0, 1n, true);
    const make = (r: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
    return {
      programId: DERIVERSE_PROGRAM_ID,
      prefix,
      suffix,
      patch: 'in',
      accounts: deriverseSwapAccounts(c, user, make, (role) => ref(slot, role)),
    };
  },

  referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint {
    const c = deriverseConfig(base);
    const curve = liveCurveWithParams(c, state, params);
    const icap = capacity(curve, c.side);
    return (x: bigint): bigint => deriverseRawQuote(x, curve, c.side, icap);
  },

  /** Stateless (every grid point is its own closed-form evaluation) — mirrors emitLadderQuote's min(x, icap) clamp. */
  referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[] {
    const c = deriverseConfig(base);
    const curve = liveCurveWithParams(c, state, params);
    const icap = capacity(curve, c.side);
    return (grid: readonly bigint[]): bigint[] => grid.map((x) => deriverseRawQuote(x, curve, c.side, icap));
  },

  /** Cumulative productive input per ORDERED grid point — min(g, icap), mirroring capacityInputVar lamport-for-lamport. */
  referenceCapacities(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[] {
    const c = deriverseConfig(base);
    const curve = liveCurveWithParams(c, state, params);
    const icap = capacity(curve, c.side);
    return (grid: readonly bigint[]): bigint[] => grid.map((g) => (g > icap ? icap : g));
  },

  /** Depth = the embedded AMM's own reserves (0 for a book-only instrument — the honest, disclosed under-quote). */
  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const c = deriverseConfig(base);
    const curve = liveCurve(c, state);
    return c.side === 'sell' ? { reserveIn: curve.a, reserveOut: curve.b } : { reserveIn: curve.b, reserveOut: curve.a };
  },

  continuousFees(base: PoolConfig): { gammaPpm: bigint; muPpm: bigint } {
    const c = deriverseConfig(base);
    const feePpm = c.feePpm > FEE_DEN ? FEE_DEN : c.feePpm;
    return { gammaPpm: FEE_DEN, muPpm: FEE_DEN - feePpm };
  },
} satisfies SvmVenueLadderV2;

/** referenceQuote/referenceLadderQuotes/referenceCapacities all need the SAME live curve + baked feePpm. */
function liveCurveWithParams(cfg: DeriversePoolConfig, state: AccountBytesMap, params: readonly bigint[]): LiveCurve {
  const [feePpm] = params;
  const base = liveCurve(cfg, state);
  return { ...base, feePpm };
}

