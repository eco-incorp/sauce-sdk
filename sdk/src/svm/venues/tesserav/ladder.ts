/**
 * TesseraV adapter v2 (SvmRoute ladder fragment) — see ./index.ts for the
 * account layout and the swap-CPI evidence. This file is the quote fragment
 * + its lamport-mirror + the swap-CPI builder.
 *
 * MODEL (deliberately the level-0-only MVP — see below for why, and for the
 * follow-up plan): the venue publishes, per direction, a 10-slot ladder of
 * NON-INCREASING (price, capacity) pairs; this fragment ships slot 0 (the
 * best price) only, LIVE-READ every trade, capacity-clamped to slot 0's own
 * published cap.
 *
 *   out(x) = floor( min(x, capIn) * price0 * mid_ratio )    [price0 in ppm of 1e6]
 *
 * where mid_ratio is the direction's raw exchange rate at ppm==1e6 (the
 * "perfect", zero-spread rate), derived from the pool's live `mid` field
 * (index.ts's OFF_MID, scaled 1e15, A-raw-per-B-raw):
 *   aToB (sell A, buy B): mid_ratio = MID_SCALE / mid   (B-raw per A-raw)
 *   bToA (sell B, buy A): mid_ratio = mid / MID_SCALE   (A-raw per B-raw)
 * `capIn` is derived from the SAME live read: the largest input whose
 * (uncapped) output would not exceed slot 0's published OUTPUT-side cap —
 * i.e. `capOut * MID_SCALE / (price0 * <the inverse of mid_ratio, direction-
 * matched>)`, computed so it can only UNDER-state the true cap (floor
 * throughout), never over-state it — a hard clamp never an over-quote.
 *
 * EXACTNESS CAVEAT (honest, per this doc's own exactness bar — see
 * docs/svm-venues.md's "Exactness criterion"): this is NOT a disassembly-
 * derived bit-exact formula the way quantum/obric-v2 are. It is an
 * EMPIRICALLY CALIBRATED model: real `sendTransaction` replays in LiteSVM
 * (cloned real mainnet pool/vault/mint state, real slot, the REAL deployed
 * TesseraV + Jupiter binaries) at seven input sizes spanning six orders of
 * magnitude (0.001 to 100 SOL notional) measured a raw out/in ratio flat to
 * 4 significant figures and consistent with `price0 * (1e15/mid)` to within
 * ~0.03-0.1% — a residual consistent with genuine price movement between
 * independently fetched live snapshots (the mid/price0 fields are rewritten
 * by the maker's bot on a near-continuous cadence — see index.ts), not a
 * derivation error, but NOT independently proven to be the bit-exact
 * on-chain formula either (no source, no IDL, and the intra-level rounding
 * rule was not isolated by disassembly in this pass). Two mitigations, both
 * load-bearing:
 *   1. A flat SAFETY_NUM/SAFETY_DEN haircut (currently 20 bps) is folded into
 *      price0 before the quote — the SAME haircut in the fragment and the TS
 *      mirror, so referenceQuote stays lamport-identical to the fragment
 *      (the exactness bar this SDK enforces), while the value BOTH compute
 *      is a deliberate underestimate of the real venue.
 *   2. The real on-chain swap (buildSwapV2) is NOT synthesized from this
 *      formula — it CPIs the verified real instruction (index.ts) with
 *      venue-level minOut=1, and the recipe's own post-swap outAta delta
 *      check is what the merge/minOut safety actually rests on (same
 *      contract as every other adapter here — "Venue-level min_out is always
 *      1" per types.ts's VenueSwap doc). A quote error here can only cost
 *      ELECTION quality (this slot gets over/under-allocated versus its
     *      true worth), never fund safety.
 *
 * WHY LEVEL-0-ONLY (not the full 10-slot walk): the measured capacity of
 * slot 0 alone (tens of thousands of USDC-equivalent on the one live pool
 * this pass verified) was never approached by any tested size — the curve
 * measured PERFECTLY FLAT (no visible degradation) from 0.001 SOL to 100 SOL.
 * A correct multi-slot walk needs the SAME bit-exactness care as quantum's
 * trapezoid (this pass did not isolate whether TesseraV ramps price WITHIN a
 * slot the way quantum does, or steps flat between slots) — shipping a
 * WRONG multi-slot walk risks a favourable-error election hazard (this
 * SDK's own stated worst outcome), whereas the level-0-only model is
 * trivially monotone, trivially capacity-safe, and empirically validated
 * over six orders of magnitude. Follow-up: isolate the intra-slot rule (more
 * LiteSVM replays at sizes approaching and past slot 0's cap) and extend to
 * the full walk the same way quantum's was built.
 *
 * SWAP CPI: verified real account order and instruction encoding — see
 * index.ts's header for the two independent replays (via a real Jupiter
 * `route` CPI, and via a from-scratch native passthrough program) that
 * pinned it down and settled the "is this a caller allowlist" question NO.
 *
 * bToA IS UNVERIFIED — DO NOT WIRE IT INTO DISCOVERY. Every real execution in
 * this pass sold mintA (wSOL) for mintB (USDC); the reverse direction's
 * account order (does the venue keep [mintA, mintB] fixed, or swap them? is
 * the direction byte really just 1-x?) was never independently confirmed —
 * the one attempt failed inside Jupiter's OWN validation before ever
 * reaching TesseraV, so it proves nothing about TesseraV's bToA shape either
 * way. This matters MORE here than on EVM: this SDK's own SVM parity notes
 * (recipes CLAUDE.md) record that "execution-time CPI catch/re-route is a
 * PLATFORM IMPOSSIBILITY on SVM — a launched CPI failure aborts the tx", so
 * a wrong bToA account order would not just self-drop this one slot, it
 * would abort the WHOLE cook, taking every other venue's fill down with it.
 * `bToA` stays in this file (the formula is genuinely symmetric and worth
 * keeping ready) but the recipe-side discovery wiring must request `aToB`
 * ONLY until a second live replay (the same LiteSVM + real-Jupiter-quote
 * technique used for aToB) confirms the reverse shape.
 */
import { address } from '@solana/kit';
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type {
  AccountBytesMap,
  LadderSwapTemplate,
  PoolConfig,
  SvmVenueLadder,
  SwapUser,
  VenueAccount,
} from '../types.js';
import { INSTRUCTIONS_SYSVAR } from '../../cpi-probe.js';
import {
  MID_SCALE,
  OFF_MID,
  PRICE_PPM_DEN,
  TESSERAV_PROGRAM_ID,
  TOKEN_PROGRAM,
  level0CumOffset,
  level0PriceOffset,
} from './index.js';
import type { TesseraVPoolConfig } from './index.js';

const SLUG = 'tesserav';
const ref = (slot: number, role: string): string => `s${slot}:${role}`;

/** Swap ix: tag(1B)=0x10 ++ direction(1B) ++ amountIn u64 LE (patched) ++ minOut u64 LE. */
const SWAP_TAG = 0x10;

/** Conservative haircut applied to price0 before quoting — see the file header. 20 bps. */
export const SAFETY_NUM = 998n;
export const SAFETY_DEN = 1000n;

function tvConfig(cfg: PoolConfig): TesseraVPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as TesseraVPoolConfig;
}

/** function qTvAB(x, price0, mid, capIn) — sell mintA for mintB (mid_ratio = MID_SCALE/mid). */
const HELPER_AB = {
  name: 'qTvAB',
  source: [
    'function qTvAB(x, price0, mid, capIn) {',
    '  if (x === 0 || mid === 0) { return 0 }',
    '  let cx = x;',
    '  if (cx > capIn) { cx = capIn }',
    `  const p = (price0 * ${SAFETY_NUM}) / ${SAFETY_DEN};`,
    `  return (cx * p * ${MID_SCALE}) / (${PRICE_PPM_DEN} * mid);`,
    '}',
  ].join('\n'),
};

/** function qTvBA(x, price0, mid, capIn) — sell mintB for mintA (mid_ratio = mid/MID_SCALE). */
const HELPER_BA = {
  name: 'qTvBA',
  source: [
    'function qTvBA(x, price0, mid, capIn) {',
    '  if (x === 0 || mid === 0) { return 0 }',
    '  let cx = x;',
    '  if (cx > capIn) { cx = capIn }',
    `  const p = (price0 * ${SAFETY_NUM}) / ${SAFETY_DEN};`,
    `  return (cx * p * mid) / (${PRICE_PPM_DEN} * ${MID_SCALE});`,
    '}',
  ].join('\n'),
};

/** TS mirror of qTvAB. */
export function tesseraVQuoteAB(x: bigint, price0: bigint, mid: bigint, capIn: bigint): bigint {
  if (x === 0n || mid === 0n) return 0n;
  const cx = x > capIn ? capIn : x;
  const p = (price0 * SAFETY_NUM) / SAFETY_DEN;
  return (cx * p * MID_SCALE) / (PRICE_PPM_DEN * mid);
}

/** TS mirror of qTvBA. */
export function tesseraVQuoteBA(x: bigint, price0: bigint, mid: bigint, capIn: bigint): bigint {
  if (x === 0n || mid === 0n) return 0n;
  const cx = x > capIn ? capIn : x;
  const p = (price0 * SAFETY_NUM) / SAFETY_DEN;
  return (cx * p * mid) / (PRICE_PPM_DEN * MID_SCALE);
}

/**
 * capIn: the largest input whose UNCAPPED quote would not exceed the slot's
 * published output-side cap, floor throughout (never over-states the true
 * cap). Both directions invert the same formula their quote uses.
 */
function capInFor(direction: 'aToB' | 'bToA', price0: bigint, mid: bigint, capOut: bigint): bigint {
  if (price0 === 0n) return 0n;
  const p = (price0 * SAFETY_NUM) / SAFETY_DEN;
  if (p === 0n) return 0n;
  if (direction === 'aToB') {
    // out = cx * p * MID_SCALE / (DEN * mid)  =>  cx = out * DEN * mid / (p * MID_SCALE)
    return (capOut * PRICE_PPM_DEN * mid) / (p * MID_SCALE);
  }
  // out = cx * p * mid / (DEN * MID_SCALE)  =>  cx = out * DEN * MID_SCALE / (p * mid)
  if (mid === 0n) return 0n;
  return (capOut * PRICE_PPM_DEN * MID_SCALE) / (p * mid);
}

export const tesseravLadder = {
  slug: SLUG,

  // No defaultRungs override: the flat-rate level-0 model is exact at any
  // rung count (every grid point below capacity samples the SAME linear
  // rate), so this rides the CP default (4, recipes/ecoswap/svm/budget.ts's
  // FamilyCuCoefficients doc) like the other simple CP families
  // (raydium-cp-swap, raydium-amm-v4, pumpswap, orca-legacy-token-swap,
  // meteora-damm-v2) rather than inventing a rung count below MIN_RUNGS=2
  // (recipes/ecoswap/svm/solver-reference.ts) that nothing else in the
  // ladder/budget pipeline expects.

  shapeKey(base: PoolConfig): string {
    return `${SLUG}:${tvConfig(base).direction}`;
  },

  helpers(base: PoolConfig): { name: string; source: string }[] {
    return [tvConfig(base).direction === 'aToB' ? HELPER_AB : HELPER_BA];
  },

  paramCount: 0,

  paramsFor(): bigint[] {
    return [];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const cfg = tvConfig(base);
    return [{ ref: ref(slot, 'pool'), address: cfg.pool }];
  },

  emitSetup(base: PoolConfig, slot: number): string {
    const cfg = tvConfig(base);
    const p = `s${slot}`;
    const pool = JSON.stringify(ref(slot, 'pool'));
    const priceOff = level0PriceOffset(cfg.direction);
    const cumOff = level0CumOffset(cfg.direction);
    return [
      `  const ${p}mid = accountUint(${pool}, ${OFF_MID}, 8);`,
      `  const ${p}p0 = accountUint(${pool}, ${priceOff}, 8);`,
      `  const ${p}cout = accountUint(${pool}, ${cumOff}, 8);`,
      // capIn: the largest input whose uncapped quote stays <= cout — a
      // one-shot inversion of the SAME formula the quote fragment uses,
      // floor throughout so it can only understate the true cap.
      `  let ${p}cin = 0;`,
      `  if (${p}p0 > 0 && ${p}mid > 0) {`,
      `    const ${p}pp = (${p}p0 * ${SAFETY_NUM}) / ${SAFETY_DEN};`,
      `    if (${p}pp > 0) {`,
      cfg.direction === 'aToB'
        ? `      ${p}cin = (${p}cout * ${PRICE_PPM_DEN} * ${p}mid) / (${p}pp * ${MID_SCALE});`
        : `      ${p}cin = (${p}cout * ${PRICE_PPM_DEN} * ${MID_SCALE}) / (${p}pp * ${p}mid);`,
      '    }',
      '  }',
      `  let ${p}cx = 0;`,
    ].join('\n');
  },

  emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string {
    const cfg = tvConfig(base);
    const p = `s${slot}`;
    const fn = cfg.direction === 'aToB' ? 'qTvAB' : 'qTvBA';
    return [
      `    ${p}cx = ${x};`,
      `    if (${p}cx > ${p}cin) { ${p}cx = ${p}cin }`,
      `    const ${outVar} = ${fn}(${x}, ${p}p0, ${p}mid, ${p}cin);`,
    ].join('\n');
  },

  emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string {
    const cfg = tvConfig(base);
    const p = `s${slot}`;
    const fn = cfg.direction === 'aToB' ? 'qTvAB' : 'qTvBA';
    return [
      `    ${p}cx = ${x};`,
      `    if (${p}cx > ${p}cin) { ${p}cx = ${p}cin }`,
      `    let ${outVar} = ${fn}(${x}, ${p}p0, ${p}mid, ${p}cin);`,
    ].join('\n');
  },

  capacityInputVar(slot: number): string {
    return `s${slot}cx`;
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const cfg = tvConfig(base);
    const directionByte = cfg.direction === 'aToB' ? 1 : 0;
    const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
    return {
      programId: TESSERAV_PROGRAM_ID,
      prefix: Uint8Array.from([SWAP_TAG, directionByte]),
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]), // minOut = 1; the recipe's delta check is the real floor.
      patch: 'in',
      accounts: [
        roled('auth', cfg.auth),
        roled('pool', cfg.pool, true),
        { ref: user.owner, signer: true },
        roled('vaultA', cfg.vaultA, true),
        roled('vaultB', cfg.vaultB, true),
        { ref: user.inAta, writable: true },
        { ref: user.outAta, writable: true },
        roled('mintA', cfg.mintA),
        roled('mintB', cfg.mintB),
        roled('tp1', TOKEN_PROGRAM),
        roled('tp2', TOKEN_PROGRAM),
        roled('ixSysvar', INSTRUCTIONS_SYSVAR),
      ],
    };
  },

  referenceQuote(base: PoolConfig, state: AccountBytesMap): (x: bigint) => bigint {
    const cfg = tvConfig(base);
    const pool = state[cfg.pool];
    if (pool === undefined) throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
    const mid = readUintLE(pool, OFF_MID, 8);
    const price0 = readUintLE(pool, level0PriceOffset(cfg.direction), 8);
    const capOut = readUintLE(pool, level0CumOffset(cfg.direction), 8);
    const capIn = capInFor(cfg.direction, price0, mid, capOut);
    const quote = cfg.direction === 'aToB' ? tesseraVQuoteAB : tesseraVQuoteBA;
    return (x: bigint): bigint => quote(x, price0, mid, capIn);
  },

  referenceCapacities(base: PoolConfig, state: AccountBytesMap): (grid: readonly bigint[]) => bigint[] {
    const cfg = tvConfig(base);
    const pool = state[cfg.pool];
    if (pool === undefined) throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
    const mid = readUintLE(pool, OFF_MID, 8);
    const price0 = readUintLE(pool, level0PriceOffset(cfg.direction), 8);
    const capOut = readUintLE(pool, level0CumOffset(cfg.direction), 8);
    const capIn = capInFor(cfg.direction, price0, mid, capOut);
    return (grid: readonly bigint[]): bigint[] => grid.map((g) => (g > capIn ? capIn : g));
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const cfg = tvConfig(base);
    const pool = state[cfg.pool];
    if (pool === undefined) throw new Error(`${SLUG} ladder depth is missing account ${cfg.pool}`);
    const mid = readUintLE(pool, OFF_MID, 8);
    const price0 = readUintLE(pool, level0PriceOffset(cfg.direction), 8);
    const capOut = readUintLE(pool, level0CumOffset(cfg.direction), 8);
    const capIn = capInFor(cfg.direction, price0, mid, capOut);
    return { reserveIn: capIn, reserveOut: capOut };
  },

  continuousFees(base: PoolConfig, state: AccountBytesMap): { gammaPpm: bigint; muPpm: bigint } {
    // Flat-rate venue up to its (small, level-0) capacity: no CP curvature
    // (gammaPpm=0 disables the continuous-oracle curve fit — measurement
    // only, never a gate, see types.ts's doc). muPpm is the LIVE level-0
    // spread (price0/1e6) folded with the same safety haircut the quote uses.
    const cfg = tvConfig(base);
    const pool = state[cfg.pool];
    if (pool === undefined) throw new Error(`${SLUG} ladder fees are missing account ${cfg.pool}`);
    const price0 = readUintLE(pool, level0PriceOffset(cfg.direction), 8);
    return { gammaPpm: 0n, muPpm: (price0 * SAFETY_NUM) / SAFETY_DEN };
  },
} satisfies SvmVenueLadder;
