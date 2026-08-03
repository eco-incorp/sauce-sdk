/**
 * Meteora Dynamic Bonding Curve (DBC) adapter v2 (SvmRoute ladder fragment)
 * — single-active-segment sqrt-price quoting with EVERYTHING read LIVE from
 * the pool's two accounts (VirtualPool + PoolConfig): the live sqrt_price and
 * volatility accumulator (pool), and the ACTIVE curve segment's bounds +
 * liquidity, the base-fee scheduler state, the dynamic-fee params, the
 * collect-fee mode and the migration sqrt-price cap (config). Zero per-trade
 * params — the only compile-time residue is DIRECTION and SEGIDX (the active
 * curve-segment index, picked at fetch time — part of the shape key, since it
 * changes which fixed byte offset the fragment reads the segment bounds
 * from).
 *
 * Math verified against the program source (github.com/MeteoraAg/
 * dynamic-bonding-curve) and cross-checked lamport-for-lamport against the
 * official `@meteora-ag/dynamic-bonding-curve-sdk`'s `swapQuoteExactIn` on
 * REAL mainnet pool state at multiple sizes, including the live linear
 * fee-scheduler decay and the volatility-based dynamic fee combined (see
 * test/svm/venues/meteora-dbc.test.ts for the worked examples and byte
 * fixtures).
 *
 * CAPACITY (statement-mode ladder, saturating — the SAME contract every
 * other windowed SVM family in this repo ships: orca-whirlpool /
 * raydium-clmm / meteora-dlmm / manifest / meteora-damm-v2): each curve
 * point is a Uniswap-v3-style CP band in Q64.64 sqrt-price space, and this
 * adapter quotes ONLY the segment containing the pool's LIVE sqrt_price at
 * fetch time (see index.ts's file header for why — the curve's OTHER
 * segments are config data already sitting in the SAME account, so a future
 * pass could widen the window to walk them; this pass scopes to one band,
 * exactly like meteora-damm-v2's single band). The closed-form capacity `C`
 * is the largest gross input the segment can absorb before its price would
 * cross the segment boundary (or, for quoteToBase, the migration_sqrt_price
 * cap, whichever binds first); `qRaw(min(x, C))` SATURATES instead of
 * collapsing to 0 past `C` — the exact defect class meteora-damm-v2's own
 * capacity clamp fixed (see its ladder.ts header), avoided here from the
 * start.
 *
 * FEE-SCHEDULER ACTIVATION GATE: when the base-fee scheduler is armed
 * (period_frequency != 0) and the live clock has not yet reached
 * activation_point, the REAL program's fee computation underflow-reverts
 * (`current_point.safe_sub(activation_point)` in Rust) — the whole swap
 * fails, not just a worse fee. `capacity` is forced to 0 in that case so the
 * merge simply elects nothing from this slot rather than promising an
 * output the real transaction cannot deliver.
 */
import type { Address } from '@solana/kit';
import { ceilDiv, readUintLE } from '../math.js';
import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SvmVenueLadder, SwapUser, VenueAccount } from '../types.js';
import {
  dbcCapacity,
  dbcFeeNumerator,
  meteoraDbc,
  METEORA_DBC_EVENT_AUTHORITY,
  METEORA_DBC_FEE_DENOMINATOR,
  METEORA_DBC_MAX_FEE_NUMERATOR,
  METEORA_DBC_OFF_ACTIVATION_POINT,
  METEORA_DBC_OFF_CLIFF_FEE_NUMERATOR,
  METEORA_DBC_OFF_COLLECT_FEE_MODE,
  METEORA_DBC_OFF_CURVE,
  METEORA_DBC_CURVE_POINT_SIZE,
  METEORA_DBC_OFF_DYN_BIN_STEP,
  METEORA_DBC_OFF_DYN_INITIALIZED,
  METEORA_DBC_OFF_DYN_VARIABLE_FEE_CONTROL,
  METEORA_DBC_OFF_MIGRATION_SQRT_PRICE,
  METEORA_DBC_OFF_NUMBER_OF_PERIOD,
  METEORA_DBC_OFF_PERIOD_FREQUENCY,
  METEORA_DBC_OFF_REDUCTION_FACTOR,
  METEORA_DBC_OFF_SQRT_START_PRICE,
  METEORA_DBC_OFF_SQRT_PRICE,
  METEORA_DBC_OFF_VOL_ACCUMULATOR,
  METEORA_DBC_POOL_AUTHORITY,
  METEORA_DBC_SWAP_DISCRIMINATOR,
  quoteSingleSegment,
  __decodeMeteoraDbcConfig,
  __decodeMeteoraDbcPool,
} from './index.js';
import type { MeteoraDbcPoolConfig } from './index.js';

const SLUG = 'meteora-dbc';
const Q128 = 1n << 128n;

function v2Config(base: PoolConfig): MeteoraDbcPoolConfig {
  if (base.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${base.venue}' pool config`);
  return base as MeteoraDbcPoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

export const meteoraDbcLadder = {
  slug: SLUG,

  shapeKey(base: PoolConfig): string {
    const c = v2Config(base);
    return `${SLUG}:${c.direction}:${c.segIdx}`;
  },

  helpers(_base: PoolConfig): { name: string; source: string }[] {
    return [
      {
        // Pure fee arithmetic (no account/global reads): period-decayed base
        // fee (Linear scheduler; a static fee when periodFrequency == 0) plus
        // the volatility-based dynamic fee, capped at MAX_FEE_NUMERATOR.
        // Mirrors dbcFeeNumerator (index.ts) — change them together.
        name: 'dbcFee',
        source: [
          'function dbcFee(cliff, freq, act, np, red, dyn, bs, vfc, va, now) {',
          '  let f = cliff;',
          '  if (freq !== 0) {',
          '    let per = 0;',
          '    if (now >= act) { per = (now - act) / freq }',
          '    if (per > np) { per = np }',
          '    f = cliff - red * per;',
          '  }',
          '  if (dyn === 1) {',
          '    const vv = va * bs;',
          `    f = f + (vv * vv * vfc + 99999999999) / 100000000000;`,
          '  }',
          `  if (f > ${METEORA_DBC_MAX_FEE_NUMERATOR}) { f = ${METEORA_DBC_MAX_FEE_NUMERATOR} }`,
          '  return f;',
          '}',
        ].join('\n'),
      },
      {
        // quoteToBase (buying): x is already capacity-clamped. cfm == 0
        // (QuoteToken) charges the fee on input; cfm != 0 (OutputToken) on
        // output. next = sp + floor(din << 128 / L); delta_b floors.
        name: 'dbcQuoteBuy',
        source: [
          'function dbcQuoteBuy(x, sp, liq, f, cfm) {',
          '  if (x === 0) { return 0 }',
          '  if (liq === 0) { return 0 }',
          '  let din = x;',
          '  if (cfm === 0) { din = x - (x * f + 999999999) / 1000000000 }',
          '  if (din === 0) { return 0 }',
          `  const nx = sp + (din * ${Q128}) / liq;`,
          '  const g = (liq * (nx - sp)) / (sp * nx);',
          '  let out = g;',
          '  if (cfm !== 0) { out = g - (g * f + 999999999) / 1000000000 }',
          '  return out;',
          '}',
        ].join('\n'),
      },
      {
        // baseToQuote (selling): x is already capacity-clamped; fees are
        // ALWAYS on output for this direction. next = ceil(L*sp/(L+x*sp));
        // delta_a floors; fee ceils on output.
        name: 'dbcQuoteSell',
        source: [
          'function dbcQuoteSell(x, sp, liq, f) {',
          '  if (x === 0) { return 0 }',
          '  if (liq === 0) { return 0 }',
          '  const den = liq + x * sp;',
          '  const nx = (liq * sp + den - 1) / den;',
          `  const g = (liq * (sp - nx)) / ${Q128};`,
          '  return g - (g * f + 999999999) / 1000000000;',
          '}',
        ].join('\n'),
      },
    ];
  },

  paramCount: 0,

  paramsFor(_base: PoolConfig): bigint[] {
    return [];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const c = v2Config(base);
    return [
      { ref: ref(slot, 'pool'), address: c.pool },
      { ref: ref(slot, 'config'), address: c.config },
    ];
  },

  emitSetup(base: PoolConfig, slot: number): string {
    const c = v2Config(base);
    const pool = JSON.stringify(ref(slot, 'pool'));
    const cfgRef = JSON.stringify(ref(slot, 'config'));
    const upperOff = METEORA_DBC_OFF_CURVE + METEORA_DBC_CURVE_POINT_SIZE * c.segIdx;
    const lowerOff = c.segIdx === 0 ? METEORA_DBC_OFF_SQRT_START_PRICE : METEORA_DBC_OFF_CURVE + METEORA_DBC_CURVE_POINT_SIZE * (c.segIdx - 1);
    const p = `s${slot}`;
    const lines = [
      `  const ${p}sp = accountUint(${pool}, ${METEORA_DBC_OFF_SQRT_PRICE}, 16);`,
      `  const ${p}cliff = accountUint(${cfgRef}, ${METEORA_DBC_OFF_CLIFF_FEE_NUMERATOR}, 8);`,
      `  const ${p}freq = accountUint(${cfgRef}, ${METEORA_DBC_OFF_PERIOD_FREQUENCY}, 8);`,
      `  const ${p}act = accountUint(${pool}, ${METEORA_DBC_OFF_ACTIVATION_POINT}, 8);`,
      `  const ${p}np = accountUint(${cfgRef}, ${METEORA_DBC_OFF_NUMBER_OF_PERIOD}, 2);`,
      `  const ${p}red = accountUint(${cfgRef}, ${METEORA_DBC_OFF_REDUCTION_FACTOR}, 8);`,
      `  const ${p}dyn = accountUint(${cfgRef}, ${METEORA_DBC_OFF_DYN_INITIALIZED}, 1);`,
      `  const ${p}bs = accountUint(${cfgRef}, ${METEORA_DBC_OFF_DYN_BIN_STEP}, 2);`,
      `  const ${p}vfc = accountUint(${cfgRef}, ${METEORA_DBC_OFF_DYN_VARIABLE_FEE_CONTROL}, 4);`,
      `  const ${p}va = accountUint(${pool}, ${METEORA_DBC_OFF_VOL_ACCUMULATOR}, 16);`,
      `  const ${p}f = dbcFee(${p}cliff, ${p}freq, ${p}act, ${p}np, ${p}red, ${p}dyn, ${p}bs, ${p}vfc, ${p}va, block.timestamp);`,
      `  const ${p}liq = accountUint(${cfgRef}, ${upperOff + 16}, 16);`,
    ];
    if (c.direction === 'quoteToBase') {
      lines.push(
        `  const ${p}up0 = accountUint(${cfgRef}, ${upperOff}, 16);`,
        `  const ${p}mig = accountUint(${cfgRef}, ${METEORA_DBC_OFF_MIGRATION_SQRT_PRICE}, 16);`,
        `  let ${p}up = ${p}up0;`,
        `  if (${p}mig < ${p}up) { ${p}up = ${p}mig }`,
        `  let ${p}cap = 0;`,
        `  if (${p}up > ${p}sp) { ${p}cap = (${p}liq * (${p}up - ${p}sp) + ${Q128 - 1n}) / ${Q128} }`,
        `  const ${p}cfm = accountUint(${cfgRef}, ${METEORA_DBC_OFF_COLLECT_FEE_MODE}, 1);`,
      );
    } else {
      lines.push(
        `  const ${p}lo = accountUint(${cfgRef}, ${lowerOff}, 16);`,
        `  let ${p}cap = 0;`,
        `  if (${p}sp > ${p}lo) { ${p}cap = (${p}liq * (${p}sp - ${p}lo) + ${p}lo * ${p}sp - 1) / (${p}lo * ${p}sp) }`,
      );
    }
    lines.push(
      `  if (${p}freq !== 0) { if (block.timestamp < ${p}act) { ${p}cap = 0 } }`,
      `  let ${p}cx = 0;`,
    );
    return lines.join('\n');
  },

  capacityInputVar(slot: number): string {
    return `s${slot}cx`;
  },

  /** Statement-mode rung: clamp x to the closed-form capacity, then quote. `rung` is unused — every rung is an independent closed-form evaluation. */
  emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string {
    const c = v2Config(base);
    const p = `s${slot}`;
    if (c.direction === 'quoteToBase') {
      return [
        `    ${p}cx = ${x};`,
        `    if (${p}cx > ${p}cap) { ${p}cx = ${p}cap }`,
        `    const ${outVar} = dbcQuoteBuy(${p}cx, ${p}sp, ${p}liq, ${p}f, ${p}cfm);`,
      ].join('\n');
    }
    return [
      `    ${p}cx = ${x};`,
      `    if (${p}cx > ${p}cap) { ${p}cx = ${p}cap }`,
      `    const ${outVar} = dbcQuoteSell(${p}cx, ${p}sp, ${p}liq, ${p}f);`,
    ].join('\n');
  },

  /** Cold final quote — same capacity clamp, fresh locals (no rung state to reuse). */
  emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string {
    const c = v2Config(base);
    const p = `s${slot}`;
    if (c.direction === 'quoteToBase') {
      return [
        `  let ${p}fcx = ${x};`,
        `  if (${p}fcx > ${p}cap) { ${p}fcx = ${p}cap }`,
        `  const ${outVar} = dbcQuoteBuy(${p}fcx, ${p}sp, ${p}liq, ${p}f, ${p}cfm);`,
      ].join('\n');
    }
    return [
      `  let ${p}fcx = ${x};`,
      `  if (${p}fcx > ${p}cap) { ${p}fcx = ${p}cap }`,
      `  const ${outVar} = dbcQuoteSell(${p}fcx, ${p}sp, ${p}liq, ${p}f);`,
    ].join('\n');
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const c = v2Config(base);
    const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
    return {
      programId: meteoraDbc.programId,
      prefix: Uint8Array.from(METEORA_DBC_SWAP_DISCRIMINATOR),
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
      patch: 'in',
      accounts: [
        roled('auth', METEORA_DBC_POOL_AUTHORITY),
        roled('cfg', c.config),
        roled('pool', c.pool, true),
        { ref: user.inAta, writable: true },
        { ref: user.outAta, writable: true },
        roled('bv', c.baseVault, true),
        roled('qv', c.quoteVault, true),
        roled('bm', c.baseMint),
        roled('qm', c.quoteMint),
        { ref: user.owner, signer: true },
        roled('tbp', c.tokenBaseProgram),
        roled('tqp', c.tokenQuoteProgram),
        // Anchor-optional referral_token_account: the program id readonly is
        // the none-placeholder.
        roled('prog', meteoraDbc.programId),
        roled('evt', METEORA_DBC_EVENT_AUTHORITY),
        roled('prog', meteoraDbc.programId),
      ],
    };
  },

  referenceQuote(base: PoolConfig, state: AccountBytesMap, _params?: readonly bigint[], now?: bigint): (x: bigint) => bigint {
    const c = v2Config(base);
    const poolData = state[c.pool];
    const configData = state[c.config];
    if (poolData === undefined) throw new Error(`${SLUG} ladder reference is missing account ${c.pool}`);
    if (configData === undefined) throw new Error(`${SLUG} ladder reference is missing account ${c.config}`);
    const p = __decodeMeteoraDbcPool(c.pool, poolData);
    const cfgD = __decodeMeteoraDbcConfig(c.config, configData);
    const nowResolved = now ?? liveNow();
    return (x: bigint): bigint => quoteSingleSegment(c, p, cfgD, x, nowResolved).output;
  },

  referenceCapacities(
    base: PoolConfig,
    state: AccountBytesMap,
    _params?: readonly bigint[],
    now?: bigint,
  ): (grid: readonly bigint[]) => bigint[] {
    const c = v2Config(base);
    const poolData = state[c.pool];
    const configData = state[c.config];
    if (poolData === undefined) throw new Error(`${SLUG} ladder capacities missing account ${c.pool}`);
    if (configData === undefined) throw new Error(`${SLUG} ladder capacities missing account ${c.config}`);
    const p = __decodeMeteoraDbcPool(c.pool, poolData);
    const cfgD = __decodeMeteoraDbcConfig(c.config, configData);
    const cap = dbcCapacity(c, p, cfgD, now ?? liveNow());
    return (grid: readonly bigint[]): bigint[] => grid.map((g) => (g > cap ? cap : g));
  },

  /**
   * Full-range CP-equivalent VIRTUAL reserves of the ACTIVE segment at the
   * live spot (Q64.64 sqrt_price): a = L*2^64/sp, b = L*sp/2^64, so
   * isqrt(a*b) == L, the canonical CLMM depth (same shim meteora-damm-v2
   * uses). Locally exact for the single-segment in-band quote.
   */
  depthReserves(base: PoolConfig, state: AccountBytesMap, _now?: bigint): { reserveIn: bigint; reserveOut: bigint } {
    const c = v2Config(base);
    const poolData = state[c.pool];
    const configData = state[c.config];
    if (poolData === undefined) throw new Error(`${SLUG} ladder depth missing account ${c.pool}`);
    if (configData === undefined) throw new Error(`${SLUG} ladder depth missing account ${c.config}`);
    const p = __decodeMeteoraDbcPool(c.pool, poolData);
    const cfgD = __decodeMeteoraDbcConfig(c.config, configData);
    const seg = cfgD.curve[c.segIdx];
    if (seg === undefined || p.sqrtPrice === 0n) return { reserveIn: 0n, reserveOut: 0n };
    const l = seg.liquidity;
    const sp = p.sqrtPrice;
    const a = (l << 64n) / sp; // base-equivalent virtual reserve
    const b = (l * sp) >> 64n; // quote-equivalent virtual reserve
    return c.direction === 'quoteToBase' ? { reserveIn: b, reserveOut: a } : { reserveIn: a, reserveOut: b };
  },

  continuousFees(base: PoolConfig, state: AccountBytesMap, _params?: readonly bigint[]): { gammaPpm: bigint; muPpm: bigint } {
    const c = v2Config(base);
    const poolData = state[c.pool];
    const configData = state[c.config];
    if (poolData === undefined) throw new Error(`${SLUG} ladder fees missing account ${c.pool}`);
    if (configData === undefined) throw new Error(`${SLUG} ladder fees missing account ${c.config}`);
    const p = __decodeMeteoraDbcPool(c.pool, poolData);
    const cfgD = __decodeMeteoraDbcConfig(c.config, configData);
    const feePpm =
      dbcFeeNumerator(
        cfgD.cliffFeeNumerator,
        cfgD.periodFrequency,
        p.activationPoint,
        cfgD.numberOfPeriod,
        cfgD.reductionFactor,
        cfgD.dynInitialized,
        cfgD.binStep,
        cfgD.variableFeeControl,
        p.volatilityAccumulator,
        liveNow(),
      ) / 1000n; // 1e9-denominated -> ppm
    const feesOnInput = c.direction === 'quoteToBase' && cfgD.collectFeeMode === 0;
    return feesOnInput
      ? { gammaPpm: 1_000_000n - feePpm, muPpm: 1_000_000n }
      : { gammaPpm: 1_000_000n, muPpm: 1_000_000n - feePpm };
  },
} satisfies SvmVenueLadder;

/** Wall-clock unix seconds — the fragment's `block.timestamp` reads the REAL Clock sysvar; a stale `now` here only staleness-shifts the off-chain quote (covered by minOut like any other drift), matching every other time-dependent family's referenceQuote/referenceCapacities default. */
function liveNow(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}
