/**
 * Metric adapter — the amount-parametric quote-ladder fragment, sibling of ./index.ts's buildSwap.
 * See index.ts's module doc for the account/instruction layout and the off-chain price mechanism;
 * this file is the emitted-fragment side of the quote.
 *
 * BAKED PRICE, NO IN-VM ORACLE CPI. Metric's oracle exposes its price only through CALL return data
 * (its internal byte->price transform is closed and unrecovered — see index.ts's module doc), so
 * `fetchPoolConfig` reads it ONCE off-chain at quote time (via the caller-supplied `fetchOracleQuote`
 * callback) and BAKES the resulting scale into `params`. The emitted fragment then just multiplies
 * by that baked scale — exactly like every other read-off-chain-and-bake venue in this tree (zerofi,
 * WOOFi, BisonFi). It issues ZERO `contract.call`: it reads only the output vault's balance
 * (`accountUint`) to size a reserve-fraction cap.
 *
 * WHY NO CPI (this was the production blocker, now removed): an in-VM `contract.call` to the oracle
 * can REVERT — this oracle returns program error Custom:20 when its price account is stale (measured
 * live: some calls return a clean 32-byte quote, others revert once the price account's bytes move).
 * The engine's CATCH is PRE-FLIGHT-ONLY (`resolveRawCallCatch`: once `invoke()` launches, a failing
 * callee aborts the WHOLE transaction), so an in-quote oracle revert would abort the ENTIRE cook —
 * every co-merged venue's fill, not just Metric's own slot. A prior revision emitted such a CPI as a
 * freshness gate; it is deleted. Applying a baked scale can never revert, so Metric's quote fragment
 * can never take down a cook, and `minOut` remains the sole atomic backstop — the same posture as
 * every other read-off-chain venue here. The venue's OWN swap instruction still prices via the
 * oracle (its business, and only when Metric is actually elected), a normal per-slot swap failure,
 * not a quote-time whole-cook abort.
 *
 * CAPACITY: flat price, reserve-fraction capped (`liveReserveOut / CAP_DIVISOR`, see index.ts) —
 * stateless, closed-form; every rung (and the cold final quote) is an INDEPENDENT evaluation via
 * `emitQuoteCall`, mirroring zerofi's own "no warm-start chain needed" shape. The pool carries an
 * undecoded variable-length tail that may encode a real depth model, so the flat rung is held to the
 * conservative `CAP_DIVISOR` bound (output can never exceed reserveOut / CAP_DIVISOR) rather than
 * quoting an unmeasured curve — zerofi's own CAP_DIVISOR rationale, for the identical reason.
 *
 * `referenceQuote` is a pure, lamport-exact function of state + the baked `params` (state bytes
 * cannot reproduce the oracle's closed transform, so the price must ride in `params`).
 */
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
import { CAP_DIVISOR, METRIC_PROGRAM_ID, METRIC_SWAP_DISCRIMINATOR, metricSwapAccounts } from './index.js';
import type { MetricPoolConfig } from './index.js';

const SLUG = 'metric';
/** SPL token account `amount` byte offset. */
const AMOUNT_OFFSET = 64;

function metricConfig(cfg: PoolConfig): MetricPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as MetricPoolConfig;
}

const ref = (slot: number, role: string) => `s${slot}:${role}`;

export const metricLadder = {
  slug: SLUG,
  defaultRungs: 4,

  shapeKey(base: PoolConfig): string {
    const c = metricConfig(base);
    return `${SLUG}:${c.direction}`;
  },

  helpers() {
    return [
      {
        name: 'qMetric',
        source: ['function qMetric(x, sn, sd, cap) {', '  let g = (x * sn) / sd;', '  if (g > cap) { g = cap }', '  return g;', '}'].join(
          '\n',
        ),
      },
    ];
  },

  /** [scaleNum, scaleDen] — this direction's baked scale, read off-chain in fetchPoolConfig (index.ts). */
  paramCount: 2,

  paramsFor(base: PoolConfig): bigint[] {
    const c = metricConfig(base);
    return [c.scaleNum, c.scaleDen];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const c = metricConfig(base);
    const vaultOut = c.direction === 0 ? c.vaultB : c.vaultA;
    // Only the output vault is read (for the reserve-fraction cap). The price is baked off-chain in
    // fetchPoolConfig, so the emitted quote issues NO oracle CPI — see emitSetup.
    return [{ ref: ref(slot, 'vout'), address: vaultOut }];
  },

  emitSetup(_base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string {
    const p = `s${slot}`;
    const vout = JSON.stringify(ref(slot, 'vout'));
    const [scaleNum, scaleDen] = params;
    // NO oracle CPI. The price is read off-chain at fetch time and baked into the scale params
    // (see index.ts's module doc) — identical to how zerofi/BisonFi read-off-chain-and-bake. A
    // launched CPI can revert (this oracle reverts Custom:20 when stale), and the engine's CATCH is
    // pre-flight-only, so an in-quote CPI revert would abort the ENTIRE cook — every co-merged
    // venue's fill, not just Metric's. Applying a baked scale can never revert; minOut is the sole
    // atomic backstop, exactly as for every read-off-chain venue in this tree.
    const scaleBlock = [`    ${p}sn = ${scaleNum};`, `    ${p}sd = ${scaleDen};`].join('\n');
    const lines = [
      // The output vault read always happens (must be readable regardless of enable), sizing the cap.
      `  const ${p}rout = accountUint(${vout}, ${AMOUNT_OFFSET}, 8);`,
      `  const ${p}cap = ${p}rout / ${CAP_DIVISOR};`,
      // A disabled/dropped slot keeps the zero-output scale (0/1): qMetric(x, 0, 1, cap) === 0.
      `  let ${p}sn = 0;`,
      `  let ${p}sd = 1;`,
    ];
    if (enableVar !== undefined) {
      lines.push(`  if (${enableVar} !== 0) {`, scaleBlock, `  }`);
    } else {
      lines.push(scaleBlock);
    }
    return lines.join('\n');
  },

  emitQuoteCall(_base: PoolConfig, slot: number, x: string): string {
    const p = `s${slot}`;
    return `qMetric(${x}, ${p}sn, ${p}sd, ${p}cap)`;
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const c = metricConfig(base);
    const make = (r: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
    const accounts = metricSwapAccounts(c, user, make, (role) => ref(slot, role));
    return {
      programId: METRIC_PROGRAM_ID,
      // disc(1) ++ [runtime-patched amountIn u64 LE]
      prefix: Uint8Array.from([METRIC_SWAP_DISCRIMINATOR]),
      // [1] ++ direction ++ minOut u128 LE = 1
      suffix: Uint8Array.from([1, c.direction === 0 ? 1 : 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      patch: 'in',
      accounts,
    };
  },

  /**
   * TS mirror. Assumes the on-chain drift gate PASSES (baked-at-fetch == live-at-cook) — the
   * genuine oracle transform cannot be reproduced from `state` bytes at all (see index.ts's module
   * doc); this is a disclosed, narrow divergence from a true on-chain self-drop, never a fill-
   * quality gate (minOut remains the sole atomic backstop).
   */
  referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint {
    const c = metricConfig(base);
    const vaultOut = c.direction === 0 ? c.vaultB : c.vaultA;
    const voutData = state[vaultOut];
    if (voutData === undefined) throw new Error(`${SLUG} reference is missing vault ${vaultOut}`);
    const [scaleNum, scaleDen] = params;
    const rout = readUintLE(voutData, AMOUNT_OFFSET, 8);
    const cap = rout / CAP_DIVISOR;
    return (x: bigint) => {
      if (x === 0n) return 0n;
      const g = (x * scaleNum) / scaleDen;
      return g > cap ? cap : g;
    };
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const c = metricConfig(base);
    const vaultIn = c.direction === 0 ? c.vaultA : c.vaultB;
    const vaultOut = c.direction === 0 ? c.vaultB : c.vaultA;
    const vinData = state[vaultIn];
    const voutData = state[vaultOut];
    if (vinData === undefined || voutData === undefined) {
      throw new Error(`${SLUG} depth is missing a reserve vault`);
    }
    return {
      reserveIn: readUintLE(vinData, AMOUNT_OFFSET, 8),
      reserveOut: readUintLE(voutData, AMOUNT_OFFSET, 8),
    };
  },

  /**
   * Measurement only. The oracle spread (bid/ask, ~1bp measured — see index.ts's module doc) is
   * already folded into the baked scale, not a separate fee this ladder charges on top — so gamma
   * is the identity and mu is full retention, the same convention obric-v2/zerofi use when their
   * own venue fee is priced INTO the quote rather than deducted afterward.
   */
  continuousFees(): { gammaPpm: bigint; muPpm: bigint } {
    return { gammaPpm: 1_000_000n, muPpm: 1_000_000n };
  },
};
