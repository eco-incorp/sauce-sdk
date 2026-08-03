/**
 * ZeroFi adapter v2 (SvmRoute ladder fragment) — the amount-parametric
 * sibling of ./index.ts's buildSwap: the oracle price is read LIVE in-VM
 * (pure integer ops — no float unit assumed in the target VM), the gross
 * input arrives at runtime, and the pool's live output-vault balance sizes
 * a conservative saturating cap (see index.ts's CAP_DIVISOR doc). The only
 * per-pool compile-time residue is the swap DIRECTION (which side of the
 * (companion, vault) pair is "in") plus 5 small verified numeric constants
 * (see paramsFor) — part of the shape key alongside direction.
 *
 * ORACLE DECODE (the actual novel piece here — see index.ts's module doc
 * for how the account/instruction layout was recovered): the Wildcard
 * oracle stores price as a plain IEEE-754 binary64 at PRICE_OFFSET. This
 * repo's SVM target has no float unit (every other ladder in this tree is
 * pure-integer fixed-point), so the fragment decodes the RAW BITS with
 * shift + mask, exactly mirroring what a software float-to-fixed routine
 * does (see ./ieee754.ts for the exact derivation):
 *
 *   top   = bits >> 52                      // sign(1) + biased exponent(11)
 *   mant  = (bits & (2^52-1)) | 2^52         // 53-bit true mantissa (implicit leading 1)
 *   value = mant * 2^(top - 1075)            // top's sign bit is 0 for any real price
 *
 * `top` is READ LIVE but only ever COMPARED against a value baked at
 * PREPARE TIME (`ZeroFiPoolConfig.scaleBakedTop`, from fetchPoolConfig) — a
 * live mismatch (price moved across a power-of-2 boundary since the pool
 * was fetched, a corrupted word, a negative/NaN/inf bit pattern)
 * DEACTIVATES the slot (quote 0) rather than misquoting it, the same
 * posture obric-v2's oracle sanity band takes. Given `top` is pinned,
 * `2^(top-1075)` is a build-time-known rational; ieee754.ts reduces it
 * (together with the mintA/mintB decimals adjustment) to a SINGLE (num,
 * den) pair via gcd, and additionally right-shifts the mantissa by a baked
 * `shiftPre` so the ON-CHAIN product `reduced * num` (or `num` alone — see
 * below) never has to carry more than the ~53 mantissa bits through a live
 * multiply, matching every other ladder's plain-`*`/`/` comfort zone
 * (obric-v2's 128-bit `bigK * my` plain-multiply is the precedent this
 * leans on — no `Math.mulDiv` needed). `shiftPre` shaves LOW mantissa bits
 * (a FLOOR, i.e. it can only make the decoded price a hair smaller, never
 * larger) — one more one-sided-safe rounding choice stacked on top of the
 * feePpm margin.
 *
 * Direction reduces to which (num, den) side is live-scaled: mintA->mintB
 * multiplies by price (`sn = reduced*num`, `sd = den`); mintB->mintA
 * divides by it, the EXACT reciprocal (`sn = den`, `sd = reduced*num` —
 * num and den swap sides too, not just which one gets `reduced*` — one
 * canonical (num, den) pair serves both directions.
 *
 * CAPACITY: `cap = liveReserveOut / CAP_DIVISOR` (index.ts) — a flat
 * ceiling, not a curve; past it the quote SATURATES (constant, like a
 * capacity-exhausted window-walk), never collapses to 0 for x above it and
 * never exceeds it. There is no capacityInputVar/warm-start chain — every
 * rung (and the cold final quote) is an INDEPENDENT closed-form evaluation
 * (`emitQuoteCall` covers both), exactly like obric-v2's own "stateless,
 * rung is unused" ladder, except ours needs no separate ladder/final split
 * at all since there is no capacity clamp on the INPUT side to reuse.
 *
 * ACCOUNT-8 CAVEAT: buildSwapV2's accounts (via zerofiSwapAccounts) settle
 * through `cfg.authority`/`authorityAtaA`/`authorityAtaB` — see index.ts's
 * module doc for the measured proof and the pending-registration gap this
 * implies for a real (non-simulated) cook.
 */
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
import { IMPLICIT_BIT, MANTISSA_MASK } from './ieee754.js';
import {
  CAP_DIVISOR,
  PRICE_OFFSET,
  ZEROFI_PROGRAM_ID,
  ZEROFI_SWAP_DISCRIMINATOR,
  zerofiSwapAccounts,
} from './index.js';
import type { ZeroFiPoolConfig } from './index.js';

const SLUG = 'zerofi';
/** SPL token account `amount` byte offset. */
const AMOUNT_OFFSET = 64;
const FEE_DEN = 1_000_000n;

function zerofiConfig(cfg: PoolConfig): ZeroFiPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as ZeroFiPoolConfig;
}

const ref = (slot: number, role: string) => `s${slot}:${role}`;

export const zerofiLadder = {
  slug: SLUG,
  defaultRungs: 4,

  shapeKey(base: PoolConfig): string {
    const c = zerofiConfig(base);
    return `${SLUG}:${c.direction}`;
  },

  helpers() {
    return [
      {
        name: 'qZeroFi',
        source: [
          'function qZeroFi(x, sn, sd, feePpm, ok, cap) {',
          '  if (x === 0 || ok === 0) { return 0 }',
          '  let g = (x * sn) / sd;',
          `  g = g - (g * feePpm) / ${FEE_DEN};`,
          '  if (g > cap) { g = cap }',
          '  return g;',
          '}',
        ].join('\n'),
      },
    ];
  },

  /** [bakedTop, shiftPre, num, den, feePpm] — baked in fetchPoolConfig (index.ts), see ./ieee754.ts. */
  paramCount: 5,

  paramsFor(base: PoolConfig): bigint[] {
    const c = zerofiConfig(base);
    return [c.scaleBakedTop, c.scaleShiftPre, c.scaleNum, c.scaleDen, c.feePpm];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const c = zerofiConfig(base);
    const vaultOut = c.direction === 0 ? c.vaultB : c.vaultA;
    return [
      { ref: ref(slot, 'oracle'), address: c.oracle },
      { ref: ref(slot, 'vout'), address: vaultOut },
    ];
  },

  emitSetup(base: PoolConfig, slot: number, params: readonly string[]): string {
    const c = zerofiConfig(base);
    const p = `s${slot}`;
    const oracle = JSON.stringify(ref(slot, 'oracle'));
    const vout = JSON.stringify(ref(slot, 'vout'));
    const [bakedTop, shiftPre, num, den, feePpm] = params;
    // direction 0 (mintA -> mintB) multiplies by price: sn = reduced*num, sd = den.
    // direction 1 (mintB -> mintA) divides by price — the EXACT reciprocal of
    // the same (num, den): sn = den, sd = reduced*num. (Swapping num<->den
    // AND which side gets `reduced*` — not just flipping which side gets
    // `reduced*` alone, which was a bug caught by ieee754.test.ts's
    // divide-direction fixture assertion.)
    const scaleLines =
      c.direction === 0
        ? [`  const ${p}sn = ${p}red * ${num};`, `  const ${p}sd = ${den};`]
        : [`  const ${p}sn = ${den};`, `  const ${p}sd = ${p}red * ${num};`];
    return [
      `  const ${p}raw = accountUint(${oracle}, ${PRICE_OFFSET}, 8);`,
      `  const ${p}top = ${p}raw >> 52;`,
      `  let ${p}ok = 1;`,
      `  if (${p}top !== ${bakedTop}) { ${p}ok = 0 }`,
      `  const ${p}mant = (${p}raw & ${MANTISSA_MASK}) | ${IMPLICIT_BIT};`,
      `  const ${p}red = ${p}mant >> ${shiftPre};`,
      ...scaleLines,
      `  const ${p}rout = accountUint(${vout}, ${AMOUNT_OFFSET}, 8);`,
      `  const ${p}cap = ${p}rout / ${CAP_DIVISOR};`,
      `  const ${p}fee = ${feePpm};`,
    ].join('\n');
  },

  /** Stateless closed-form — every rung (and the cold final quote) is independently evaluated. */
  emitQuoteCall(_base: PoolConfig, slot: number, x: string): string {
    const p = `s${slot}`;
    return `qZeroFi(${x}, ${p}sn, ${p}sd, ${p}fee, ${p}ok, ${p}cap)`;
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const c = zerofiConfig(base);
    void user; // see index.ts's zerofi.buildSwap doc — this venue has no caller-owned-ATA slot.
    const make = (r: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
    const accounts = zerofiSwapAccounts(c, make, (role) => ref(slot, role));
    return {
      programId: ZEROFI_PROGRAM_ID,
      // disc(1) ++ [runtime-patched amountIn u64 LE]
      prefix: Uint8Array.from([ZEROFI_SWAP_DISCRIMINATOR]),
      // minOut u64 LE = 1 (the recipe's terminal delta owns the real bound).
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
      patch: 'in',
      accounts,
    };
  },

  referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint {
    const c = zerofiConfig(base);
    const vaultOut = c.direction === 0 ? c.vaultB : c.vaultA;
    const oracleData = state[c.oracle];
    const voutData = state[vaultOut];
    if (oracleData === undefined) throw new Error(`${SLUG} reference is missing oracle ${c.oracle}`);
    if (voutData === undefined) throw new Error(`${SLUG} reference is missing vault ${vaultOut}`);
    const [bakedTop, shiftPre, num, den, feePpm] = params;
    const raw = readUintLE(oracleData, PRICE_OFFSET, 8);
    const top = raw >> 52n;
    const ok = top === bakedTop;
    const mant = (raw & MANTISSA_MASK) | IMPLICIT_BIT;
    const reduced = mant >> shiftPre;
    const [sn, sd] = c.direction === 0 ? [reduced * num, den] : [den, reduced * num];
    const rout = readUintLE(voutData, AMOUNT_OFFSET, 8);
    const cap = rout / CAP_DIVISOR;
    return (x: bigint) => {
      if (x === 0n || !ok) return 0n;
      let g = (x * sn) / sd;
      g = g - (g * feePpm) / FEE_DEN;
      return g > cap ? cap : g;
    };
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const c = zerofiConfig(base);
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
   * Measurement only (see the SvmVenueLadder doc) — this venue's realized
   * curve is FLAT (no measured curvature across a ~1000x range, see
   * index.ts's module doc), so gamma is the identity and mu is the
   * measured fee retention, mirroring obric-v2's own P-A convention.
   */
  continuousFees(base: PoolConfig): { gammaPpm: bigint; muPpm: bigint } {
    const c = zerofiConfig(base);
    const feePpm = c.feePpm > FEE_DEN ? FEE_DEN : c.feePpm;
    return { gammaPpm: FEE_DEN, muPpm: FEE_DEN - feePpm };
  },
};
