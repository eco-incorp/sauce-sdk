import { readUintLE } from '../math.js';
import { CAP_DIVISOR, METRIC_PROGRAM_ID, METRIC_SWAP_DISCRIMINATOR, metricSwapAccounts } from './index.js';
const SLUG = 'metric';
/** SPL token account `amount` byte offset. */
const AMOUNT_OFFSET = 64;
function metricConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
const ref = (slot, role) => `s${slot}:${role}`;
export const metricLadder = {
    slug: SLUG,
    defaultRungs: 4,
    shapeKey(base) {
        const c = metricConfig(base);
        return `${SLUG}:${c.direction}`;
    },
    helpers() {
        return [
            {
                name: 'qMetric',
                source: ['function qMetric(x, sn, sd, cap) {', '  let g = (x * sn) / sd;', '  if (g > cap) { g = cap }', '  return g;', '}'].join('\n'),
            },
        ];
    },
    /** [scaleNum, scaleDen] — this direction's baked scale, read off-chain in fetchPoolConfig (index.ts). */
    paramCount: 2,
    paramsFor(base) {
        const c = metricConfig(base);
        return [c.scaleNum, c.scaleDen];
    },
    quoteRefs(base, slot) {
        const c = metricConfig(base);
        const vaultOut = c.direction === 0 ? c.vaultB : c.vaultA;
        // Only the output vault is read (for the reserve-fraction cap). The price is baked off-chain in
        // fetchPoolConfig, so the emitted quote issues NO oracle CPI — see emitSetup.
        return [{ ref: ref(slot, 'vout'), address: vaultOut }];
    },
    emitSetup(_base, slot, params, enableVar) {
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
        }
        else {
            lines.push(scaleBlock);
        }
        return lines.join('\n');
    },
    emitQuoteCall(_base, slot, x) {
        const p = `s${slot}`;
        return `qMetric(${x}, ${p}sn, ${p}sd, ${p}cap)`;
    },
    buildSwapV2(base, slot, user) {
        const c = metricConfig(base);
        const make = (r, addr, writable) => writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
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
    referenceQuote(base, state, params) {
        const c = metricConfig(base);
        const vaultOut = c.direction === 0 ? c.vaultB : c.vaultA;
        const voutData = state[vaultOut];
        if (voutData === undefined)
            throw new Error(`${SLUG} reference is missing vault ${vaultOut}`);
        const [scaleNum, scaleDen] = params;
        const rout = readUintLE(voutData, AMOUNT_OFFSET, 8);
        const cap = rout / CAP_DIVISOR;
        return (x) => {
            if (x === 0n)
                return 0n;
            const g = (x * scaleNum) / scaleDen;
            return g > cap ? cap : g;
        };
    },
    depthReserves(base, state) {
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
     * Measurement only. The oracle spread and the measured ~3-4 ppm over-quote correction
     * (`METRIC_QUOTE_HAIRCUT_PPM`, see index.ts) are already folded INTO the baked scale, not a
     * separate fee this ladder charges on top — so gamma is the identity and mu is full retention, the
     * same convention obric-v2/zerofi use when their own venue fee is priced into the quote rather than
     * deducted afterward.
     */
    continuousFees() {
        return { gammaPpm: 1000000n, muPpm: 1000000n };
    },
};
//# sourceMappingURL=ladder.js.map