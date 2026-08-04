/**
 * Obsidian adapter v2 (SvmRoute ladder fragment) — see index.ts's module
 * doc for the account layout / method / live-state honesty notes. This file
 * is the on-chain quote fragment (SvmVenueLadder) + the swap CPI builder.
 *
 * ── Quote model — fit against the 18 real fills ──
 * The RAW vault-balance ratio is NOT the price (it swings from ~1:1 to
 * ~99:1 across the 18 fills while the REAL execution price stays within
 * 0.02% of ~84.39 USDC/SOL the entire time) — this is an ORACLE/PMM venue,
 * not a constant-product pool; modeling it as one would be the exact
 * favourable-error hazard this integration must avoid. Instead the mid price
 * lives directly in the pool account (OFF_PRICE, see index.ts) and this
 * ladder reads it LIVE, on-chain, in the SAME instruction that executes the
 * swap — so there is no off-chain/on-chain staleness gap for the price
 * itself. Fitting `amountOut = amountIn * price / 1e(6+decimalsA-decimalsB)`
 * (A->B) against the 18 real fills gives real/model in [0.999869, 0.999961]
 * — i.e. the model, UNDISCOUNTED, already over-predicts real output by up to
 * ~13.1 bps (real is worse for the taker than the raw price implies — a
 * genuine spread/fee this integration cannot fully decompose from 18 samples
 * alone). `OUT_DISCOUNT_BPS` below (30 bps) clears that worst gap with ~2.3x
 * margin while staying far more competitive than a curve-shaped venue's
 * typical haircut (see bisonfi's 25% for comparison) — safe for election (a
 * worse model never wins a share it doesn't deserve), and the flat (zero
 * curvature) shape is trivially monotone/weakly-concave over the rung grid.
 * An explicit vault-balance cap (see emitSetup) additionally bounds the
 * quote so a flat, uncapped line never promises more than the pool can
 * actually deliver — unlike a CP curve, a straight line has no natural
 * asymptote.
 *
 * ── CU (2026-07-31) ──
 * No successful mainnet `simulateTransaction` was obtainable in this session
 * (every known pool is stale — see index.ts), so this is NOT a measured
 * successful-swap CU figure the way bisonfi's is. Recipe-side `CU_FAMILIES`
 * is sized generously above comparable simple single-CPI ladders (bisonfi,
 * raydium-cp-swap) BECAUSE it has strictly less to compute (one price read,
 * no curve iteration) than any of them — see that file for the exact pin and
 * the re-measure instruction once a fresh pool (or a local engine.so) is
 * available.
 */
import { address } from '@solana/kit';
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SvmVenueLadder, SwapUser, VenueAccount } from '../types.js';
import { OBSIDIAN_PROGRAM_ID, OFF_PRICE } from './index.js';
import type { ObsidianPoolConfig } from './index.js';

const SLUG = 'obsidian';
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSVAR_INSTRUCTIONS = address('Sysvar1nstructions1111111111111111111111111');

/** SPL token account amount field offset (standard layout). */
const AMOUNT_OFF = 64;

/** disc(1) ++ amountIn u64 LE (patched) = 9 bytes. No min_out, no direction byte. */
const SWAP_DISCRIMINATOR = 1;

/** price_raw scale: OFF_PRICE is quoteB-per-baseA * 1e6. */
const PRICE_SCALE = 1_000_000n;

/**
 * Conservative haircut on the modeled output — see the module doc "Quote
 * model" note. Clears the worst measured real/model gap (~13.1 bps) with
 * ~2.3x margin.
 */
const OUT_DISCOUNT_BPS = 30n;
const BPS_DEN = 10_000n;

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

function obsidianConfig(base: PoolConfig): ObsidianPoolConfig {
  if (base.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${base.venue}' pool config`);
  return base as ObsidianPoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

/** (numerator, denominator) reduced fraction for `amountOut_raw(A->B) = amountIn_raw * price_raw * num / den`. */
function priceScaleFraction(decimalsA: number, decimalsB: number): { num: bigint; den: bigint } {
  const upScale = 10n ** BigInt(decimalsB);
  const downScale = PRICE_SCALE * 10n ** BigInt(decimalsA);
  const g = gcd(upScale, downScale);
  return { num: upScale / g, den: downScale / g };
}

export const obsidianLadder: SvmVenueLadder = {
  slug: SLUG,
  /** Flat price (no curvature) — 4 rungs matches the family CP default; every rung shares one marginal rate. */
  defaultRungs: 4,
  shapeKey(base) {
    const cfg = obsidianConfig(base);
    return `${SLUG}:${cfg.direction}:${cfg.decimalsA}:${cfg.decimalsB}`;
  },
  helpers() {
    return [
      {
        name: 'qObsidian',
        source: [
          'function qObsidian(x, mulNum, mulDen, capOut) {',
          '  if (x === 0) { return 0 }',
          '  let out = Math.mulDiv(x, mulNum, mulDen);',
          `  out = (out * (${BPS_DEN} - ${OUT_DISCOUNT_BPS})) / ${BPS_DEN};`,
          '  if (out > capOut) { out = capOut }',
          '  return out;',
          '}',
        ].join('\n'),
      },
    ];
  },
  paramCount: 0,
  paramsFor() {
    return [];
  },
  quoteRefs(base, slot) {
    const cfg = obsidianConfig(base);
    return [
      { ref: ref(slot, 'pool'), address: cfg.pool },
      { ref: ref(slot, 'vaultA'), address: cfg.vaultA },
      { ref: ref(slot, 'vaultB'), address: cfg.vaultB },
    ];
  },
  emitSetup(base, slot) {
    const cfg = obsidianConfig(base);
    const pool = JSON.stringify(ref(slot, 'pool'));
    const vaultOutRef = JSON.stringify(ref(slot, cfg.direction === 0 ? 'vaultB' : 'vaultA'));
    const { num } = priceScaleFraction(cfg.decimalsA, cfg.decimalsB);
    return [
      `  const s${slot}price = accountUint(${pool}, ${OFF_PRICE}, 8);`,
      // price * num: the runtime side of whichever (mulNum, mulDen) slot the trade direction needs
      // (see emitQuoteCall) — computed once here so the call site stays a plain local reference.
      `  const s${slot}pn = s${slot}price * ${num};`,
      `  const s${slot}capout = accountUint(${vaultOutRef}, ${AMOUNT_OFF}, 8);`,
    ].join('\n');
  },
  /**
   * A->B (direction 0): amountOut = discount(mulDiv(x, price*num, den)) — `qObsidian(x, s{slot}pn, den, capOut)`.
   * B->A (direction 1): the reciprocal — amountOut = discount(mulDiv(x, den, price*num)) —
   * `qObsidian(x, den, s{slot}pn, capOut)`. Same helper (mulNum, mulDen just swap slots), no
   * direction branch lives inside qObsidian itself.
   */
  emitQuoteCall(base, slot, x) {
    const cfg = obsidianConfig(base);
    const { den } = priceScaleFraction(cfg.decimalsA, cfg.decimalsB);
    if (cfg.direction === 0) {
      return `qObsidian(${x}, s${slot}pn, ${den}, s${slot}capout)`;
    }
    return `qObsidian(${x}, ${den}, s${slot}pn, s${slot}capout)`;
  },
  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const cfg = obsidianConfig(base);
    const [userSrc, userDst] = cfg.direction === 0 ? [user.inAta, user.outAta] : [user.outAta, user.inAta];
    const roled = (roleRef: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, roleRef), address: addr, writable: true } : { ref: ref(slot, roleRef), address: addr };
    return {
      programId: OBSIDIAN_PROGRAM_ID,
      prefix: Uint8Array.from([SWAP_DISCRIMINATOR]),
      suffix: Uint8Array.from([]),
      patch: 'in',
      accounts: [
        { ref: user.owner, signer: true },
        roled('pool', cfg.pool, true),
        roled('vaultA', cfg.vaultA, true),
        roled('vaultB', cfg.vaultB, true),
        { ref: userSrc, writable: true },
        { ref: userDst, writable: true },
        roled('tp', TOKEN_PROGRAM),
        { ref: 'obsidianSysvarInstructions', address: SYSVAR_INSTRUCTIONS },
      ],
    };
  },
  referenceQuote(base: PoolConfig, state: AccountBytesMap) {
    const cfg = obsidianConfig(base);
    const poolData = state[cfg.pool];
    const vaultOutData = state[cfg.direction === 0 ? cfg.vaultB : cfg.vaultA];
    if (poolData === undefined) throw new Error(`${SLUG} reference is missing pool ${cfg.pool}`);
    if (vaultOutData === undefined) throw new Error(`${SLUG} reference is missing the output vault`);
    const priceRaw = readUintLE(poolData, OFF_PRICE, 8);
    const capOut = readUintLE(vaultOutData, AMOUNT_OFF, 8);
    const { num, den } = priceScaleFraction(cfg.decimalsA, cfg.decimalsB);
    return (x: bigint) => {
      if (x === 0n) return 0n;
      let out: bigint;
      if (cfg.direction === 0) {
        out = (x * priceRaw * num) / den;
      } else {
        out = (x * den) / (priceRaw * num);
      }
      out = (out * (BPS_DEN - OUT_DISCOUNT_BPS)) / BPS_DEN;
      return out > capOut ? capOut : out;
    };
  },
  depthReserves(base: PoolConfig, state: AccountBytesMap) {
    const cfg = obsidianConfig(base);
    const vaData = state[cfg.vaultA];
    const vbData = state[cfg.vaultB];
    if (vaData === undefined || vbData === undefined) throw new Error(`${SLUG} depth is missing a vault`);
    // Real vault balances — the true liquidity depth for the relative-depth filter (the
    // conservative price haircut above is a QUOTE-only safety margin, not a depth claim).
    const ra = readUintLE(vaData, AMOUNT_OFF, 8);
    const rb = readUintLE(vbData, AMOUNT_OFF, 8);
    return cfg.direction === 0 ? { reserveIn: ra, reserveOut: rb } : { reserveIn: rb, reserveOut: ra };
  },
  continuousFees() {
    // Measurement-only oracle (see the SvmVenueLadder doc comment). No curvature (gammaPpm at
    // par); muPpm folds the OUT_DISCOUNT_BPS conservative haircut so the efficiency oracle reads
    // the same conservative rate the ladder actually quotes.
    return { gammaPpm: 1_000_000n, muPpm: (BPS_DEN - OUT_DISCOUNT_BPS) * 100n };
  },
} satisfies SvmVenueLadder;
