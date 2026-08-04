import { readUintLE } from '../math.js';
import { IMPLICIT_BIT, MANTISSA_MASK } from './ieee754.js';
import { CAP_DIVISOR, PRICE_OFFSET, ZEROFI_PROGRAM_ID, ZEROFI_SWAP_DISCRIMINATOR, zerofiSwapAccounts, } from './index.js';
const SLUG = 'zerofi';
/** SPL token account `amount` byte offset. */
const AMOUNT_OFFSET = 64;
const FEE_DEN = 1000000n;
function zerofiConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
const ref = (slot, role) => `s${slot}:${role}`;
export const zerofiLadder = {
    slug: SLUG,
    defaultRungs: 4,
    shapeKey(base) {
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
    paramsFor(base) {
        const c = zerofiConfig(base);
        return [c.scaleBakedTop, c.scaleShiftPre, c.scaleNum, c.scaleDen, c.feePpm];
    },
    quoteRefs(base, slot) {
        const c = zerofiConfig(base);
        const vaultOut = c.direction === 0 ? c.vaultB : c.vaultA;
        return [
            { ref: ref(slot, 'oracle'), address: c.oracle },
            { ref: ref(slot, 'vout'), address: vaultOut },
        ];
    },
    emitSetup(base, slot, params) {
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
        const scaleLines = c.direction === 0
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
    emitQuoteCall(_base, slot, x) {
        const p = `s${slot}`;
        return `qZeroFi(${x}, ${p}sn, ${p}sd, ${p}fee, ${p}ok, ${p}cap)`;
    },
    buildSwapV2(base, slot, user) {
        const c = zerofiConfig(base);
        void user; // see index.ts's zerofi.buildSwap doc — this venue has no caller-owned-ATA slot.
        const make = (r, addr, writable) => writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
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
    referenceQuote(base, state, params) {
        const c = zerofiConfig(base);
        const vaultOut = c.direction === 0 ? c.vaultB : c.vaultA;
        const oracleData = state[c.oracle];
        const voutData = state[vaultOut];
        if (oracleData === undefined)
            throw new Error(`${SLUG} reference is missing oracle ${c.oracle}`);
        if (voutData === undefined)
            throw new Error(`${SLUG} reference is missing vault ${vaultOut}`);
        const [bakedTop, shiftPre, num, den, feePpm] = params;
        const raw = readUintLE(oracleData, PRICE_OFFSET, 8);
        const top = raw >> 52n;
        const ok = top === bakedTop;
        const mant = (raw & MANTISSA_MASK) | IMPLICIT_BIT;
        const reduced = mant >> shiftPre;
        const [sn, sd] = c.direction === 0 ? [reduced * num, den] : [den, reduced * num];
        const rout = readUintLE(voutData, AMOUNT_OFFSET, 8);
        const cap = rout / CAP_DIVISOR;
        return (x) => {
            if (x === 0n || !ok)
                return 0n;
            let g = (x * sn) / sd;
            g = g - (g * feePpm) / FEE_DEN;
            return g > cap ? cap : g;
        };
    },
    depthReserves(base, state) {
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
    continuousFees(base) {
        const c = zerofiConfig(base);
        const feePpm = c.feePpm > FEE_DEN ? FEE_DEN : c.feePpm;
        return { gammaPpm: FEE_DEN, muPpm: FEE_DEN - feePpm };
    },
};
//# sourceMappingURL=ladder.js.map