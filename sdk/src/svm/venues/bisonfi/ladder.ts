/**
 * BisonFi adapter v2 (SvmVenueLadder fragment) — see ./index.ts's module doc
 * for the full account/instruction/price-field recovery. Unlike a typical
 * closed-source oracle-priced PMM, BisonFi's price does NOT live in a
 * separate oracle account: it is a plain Q24.40 fixed-point u64 inside the
 * SAME pool account the swap CPI already touches, so this ladder reads it
 * (and its keeper timestamp, and its per-direction fee byte) live on-chain
 * with ZERO extra account locks beyond `pool` and the output vault.
 *
 * SCALE: `PRICE_SCALE = 2^40`. The live price word is HUMAN units
 * (quote-per-whole-base), so converting to raw token units needs the
 * mintA/mintB decimals delta folded in — baked once at fetch time
 * (`scaleNum`/`scaleDen`, decimals-only, direction-neutral) and combined
 * with the LIVE price at emitSetup time:
 *
 *   direction 0 (mintA -> mintB): sn = livePrice * scaleNum, sd = PRICE_SCALE * scaleDen
 *   direction 1 (mintB -> mintA): sn = PRICE_SCALE * scaleDen, sd = livePrice * scaleNum  (exact reciprocal)
 *
 * one canonical (scaleNum, scaleDen) pair serves both directions, mirroring
 * the zerofi oracle ladder's own reciprocal trick.
 *
 * FRESHNESS: `block.timestamp` (the real Clock sysvar, seconds) minus the
 * live keeper timestamp (`accountUint` at TS_OFFSET, nanoseconds, floored to
 * seconds) gated against STALE_SECONDS — see index.ts's module doc for the
 * live 18-pool population split this bound was measured against. A stale
 * slot quotes 0 (self-drops) rather than serving a visibly-wrong stored
 * price.
 *
 * FEE: the per-direction basis-point byte is ALSO read live (same account),
 * applied as a ppm haircut on the modeled output — see index.ts's module doc
 * for the single-real-trade cross-check that grounds this as conservative
 * (predicted <= realized).
 *
 * CAPACITY: `cap = liveVaultOutBalance / CAP_DIVISOR` — a flat saturating
 * ceiling (never 0 above it, never above it), the same convention zerofi and
 * denali use in this tree; there is no measured true venue-depth model for
 * this closed-source program.
 */
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type { AccountBytesMap, PoolConfig, SvmVenueLadder, SwapUser, VenueAccount } from '../types.js';
import {
  AMOUNT_OFF,
  BISONFI_PROGRAM_ID,
  CAP_DIVISOR,
  FEE_BPS_OFF_A,
  FEE_BPS_OFF_B,
  PRICE_OFFSET,
  PRICE_SCALE,
  STALE_SECONDS,
  SWAP_DISCRIMINATOR,
  TAIL_FLAG,
  TOKEN_PROGRAM,
  TS_OFFSET,
  bisonfiConfig,
} from './index.js';
import type { BisonfiPoolConfig } from './index.js';

const SLUG = 'bisonfi';
const FEE_DEN = 1_000_000n;
const BPS_TO_PPM = 100n;

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

export const bisonfiLadder: SvmVenueLadder = {
  slug: SLUG,
  /** Simple closed-form curve (no window walk / Newton iteration), 4 rungs. */
  defaultRungs: 4,
  shapeKey(base) {
    return `${SLUG}:${bisonfiConfig(base).direction}`;
  },
  helpers() {
    return [
      {
        name: 'qBisonFi',
        source: [
          'function qBisonFi(x, sn, sd, feePpm, ok, cap) {',
          '  if (x === 0 || ok === 0) { return 0 }',
          '  let g = Math.mulDiv(x, sn, sd);',
          `  g = g - Math.mulDiv(g, feePpm, ${FEE_DEN});`,
          '  if (g > cap) { g = cap }',
          '  return g;',
          '}',
        ].join('\n'),
      },
    ];
  },
  /** [scaleNum, scaleDen] — decimals-only, baked in fetchPoolConfig (index.ts). */
  paramCount: 2,
  paramsFor(base) {
    const c = bisonfiConfig(base);
    return [c.scaleNum, c.scaleDen];
  },
  quoteRefs(base, slot) {
    const c = bisonfiConfig(base);
    const vaultOut = c.direction === 0 ? c.vaultB : c.vaultA;
    return [
      { ref: ref(slot, 'pool'), address: c.pool },
      { ref: ref(slot, 'vout'), address: vaultOut },
    ];
  },
  emitSetup(base, slot, params) {
    const c = bisonfiConfig(base);
    const p = `s${slot}`;
    const pool = JSON.stringify(ref(slot, 'pool'));
    const vout = JSON.stringify(ref(slot, 'vout'));
    const [scaleNum, scaleDen] = params;
    const feeOff = c.direction === 0 ? FEE_BPS_OFF_A : FEE_BPS_OFF_B;
    const scaleLines =
      c.direction === 0
        ? [`  const ${p}sn = ${p}price * ${scaleNum};`, `  const ${p}sd = ${PRICE_SCALE} * ${scaleDen};`]
        : [`  const ${p}sn = ${PRICE_SCALE} * ${scaleDen};`, `  const ${p}sd = ${p}price * ${scaleNum};`];
    return [
      `  const ${p}price = accountUint(${pool}, ${PRICE_OFFSET}, 8);`,
      `  const ${p}tsSec = accountUint(${pool}, ${TS_OFFSET}, 8) / 1000000000;`,
      `  let ${p}ok = 1;`,
      `  if (block.timestamp - ${p}tsSec > ${STALE_SECONDS}) { ${p}ok = 0 }`,
      ...scaleLines,
      `  const ${p}feeBps = accountUint(${pool}, ${feeOff}, 2);`,
      `  const ${p}fee = ${p}feeBps * ${BPS_TO_PPM};`,
      `  const ${p}rout = accountUint(${vout}, ${AMOUNT_OFF}, 8);`,
      `  const ${p}cap = ${p}rout / ${CAP_DIVISOR};`,
    ].join('\n');
  },
  emitQuoteCall(_base, slot, x) {
    const p = `s${slot}`;
    return `qBisonFi(${x}, ${p}sn, ${p}sd, ${p}fee, ${p}ok, ${p}cap)`;
  },
  buildSwapV2(base, slot, user: SwapUser) {
    const c = bisonfiConfig(base);
    const [userAtaA, userAtaB] = c.direction === 0 ? [user.inAta, user.outAta] : [user.outAta, user.inAta];
    const roled = (roleRef: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, roleRef), address: addr, writable: true } : { ref: ref(slot, roleRef), address: addr };
    return {
      programId: BISONFI_PROGRAM_ID,
      prefix: Uint8Array.from([SWAP_DISCRIMINATOR]),
      // minOut u64 LE = 1 ++ direction ++ TAIL_FLAG — see index.ts's module doc.
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, c.direction, TAIL_FLAG]),
      patch: 'in',
      accounts: [
        { ref: user.owner, signer: true },
        roled('pool', c.pool, true),
        roled('vaultA', c.vaultA, true),
        roled('vaultB', c.vaultB, true),
        { ref: userAtaA, writable: true },
        { ref: userAtaB, writable: true },
        roled('tp1', TOKEN_PROGRAM),
        roled('tp2', TOKEN_PROGRAM),
        // The caller's OWN owner ref, read-only, NOT a signer — see index.ts's
        // module doc "Account 8" for why this is safe (a bare, zero-byte,
        // System-owned account in every real landed swap, not a required
        // co-signer).
        { ref: user.owner },
      ],
    };
  },
  referenceQuote(base, state: AccountBytesMap, params: readonly bigint[], now?: bigint) {
    const c = bisonfiConfig(base) as BisonfiPoolConfig;
    const vaultOut = c.direction === 0 ? c.vaultB : c.vaultA;
    const poolData = state[c.pool];
    const voutData = state[vaultOut];
    if (poolData === undefined) throw new Error(`${SLUG} reference is missing pool ${c.pool}`);
    if (voutData === undefined) throw new Error(`${SLUG} reference is missing vault ${vaultOut}`);
    const [scaleNum, scaleDen] = params;
    const livePrice = readUintLE(poolData, PRICE_OFFSET, 8);
    const tsSec = readUintLE(poolData, TS_OFFSET, 8) / 1_000_000_000n;
    const nowSec = now ?? BigInt(Math.floor(Date.now() / 1000));
    const ok = nowSec - tsSec <= STALE_SECONDS;
    const [sn, sd] = c.direction === 0 ? [livePrice * scaleNum, PRICE_SCALE * scaleDen] : [PRICE_SCALE * scaleDen, livePrice * scaleNum];
    const feeOff = c.direction === 0 ? FEE_BPS_OFF_A : FEE_BPS_OFF_B;
    const feeBps = readUintLE(poolData, feeOff, 2);
    const feePpm = feeBps * BPS_TO_PPM;
    const rout = readUintLE(voutData, AMOUNT_OFF, 8);
    const cap = rout / CAP_DIVISOR;
    return (x: bigint) => {
      if (x === 0n || !ok) return 0n;
      let g = (x * sn) / sd;
      g = g - (g * feePpm) / FEE_DEN;
      return g > cap ? cap : g;
    };
  },
  depthReserves(base, state: AccountBytesMap) {
    const c = bisonfiConfig(base) as BisonfiPoolConfig;
    const vaData = state[c.vaultA];
    const vbData = state[c.vaultB];
    if (vaData === undefined || vbData === undefined) throw new Error(`${SLUG} depth is missing a vault`);
    const ra = readUintLE(vaData, AMOUNT_OFF, 8);
    const rb = readUintLE(vbData, AMOUNT_OFF, 8);
    return c.direction === 0 ? { reserveIn: ra, reserveOut: rb } : { reserveIn: rb, reserveOut: ra };
  },
  continuousFees(base: PoolConfig, state: AccountBytesMap) {
    // Measurement-only oracle (see the SvmVenueLadder doc) — the realized
    // curve is flat (a plaintext live rate, not a reserve-ratio curve), so
    // gamma is at par; muPpm folds the real live per-direction fee byte.
    const c = bisonfiConfig(base) as BisonfiPoolConfig;
    const poolData = state[c.pool];
    if (poolData === undefined) throw new Error(`${SLUG} continuousFees is missing pool ${c.pool}`);
    const feeOff = c.direction === 0 ? FEE_BPS_OFF_A : FEE_BPS_OFF_B;
    const feeBps = readUintLE(poolData, feeOff, 2);
    const feePpm = feeBps * BPS_TO_PPM;
    const muPpm = feePpm >= FEE_DEN ? 0n : FEE_DEN - feePpm;
    return { gammaPpm: FEE_DEN, muPpm };
  },
};
