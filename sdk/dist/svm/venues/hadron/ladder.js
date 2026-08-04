import { readUintLE } from '../math.js';
import { HADRON_AMOUNT_OFF, HADRON_CLOCK_SYSVAR, HADRON_FEE_PPM, HADRON_HAIRCUT_PPM, HADRON_PPM_DENOM, HADRON_PRICE_OFFSET, HADRON_PRICE_SCALE, HADRON_PROGRAM_ID, HADRON_TOKEN_PROGRAM, hadronConfig, } from './index.js';
const SLUG = 'hadron';
const ref = (slot, role) => `s${slot}:${role}`;
export function hadronQuoteRefs(base, slot) {
    const cfg = hadronConfig(base);
    const vout = cfg.direction === 'BtoA' ? cfg.vaultA : cfg.vaultB;
    return [
        { ref: ref(slot, 'price'), address: cfg.assetCfgA },
        { ref: ref(slot, 'vout'), address: vout },
    ];
}
export const hadronLadder = {
    slug: SLUG,
    /** Near-flat oracle-anchored rate, clamped by a hard capacity ceiling — 4 rungs. */
    defaultRungs: 4,
    shapeKey(base) {
        return `${SLUG}:${hadronConfig(base).direction}`;
    },
    helpers() {
        return [
            {
                name: 'qHadron',
                source: [
                    'function qHadron(x, icap, en, ed) {',
                    '  if (x === 0) { return 0 }',
                    '  let cx = x;',
                    '  if (cx > icap) { cx = icap }',
                    '  if (cx === 0) { return 0 }',
                    `  const fee = Math.mulDiv(cx, ${HADRON_FEE_PPM}, ${HADRON_PPM_DENOM});`,
                    '  const net = cx - fee;',
                    '  return Math.mulDiv(net, en, ed);',
                    '}',
                ].join('\n'),
            },
        ];
    },
    paramCount: 0,
    paramsFor(_base) {
        return [];
    },
    quoteRefs: hadronQuoteRefs,
    emitSetup(base, slot) {
        const cfg = hadronConfig(base);
        const priceRef = JSON.stringify(ref(slot, 'price'));
        const voutRef = JSON.stringify(ref(slot, 'vout'));
        const twoPow32TimesHaircut = (HADRON_PRICE_SCALE * HADRON_HAIRCUT_PPM).toString();
        const twoPow32TimesPpmDenom = (HADRON_PRICE_SCALE * HADRON_PPM_DENOM).toString();
        const lines = [
            `  const s${slot}price = accountUint(${priceRef}, ${HADRON_PRICE_OFFSET}, 8);`,
            `  const s${slot}rout = accountUint(${voutRef}, ${HADRON_AMOUNT_OFF}, 8);`,
            `  let s${slot}pnum = 0; let s${slot}pden = 1; let s${slot}icap = 0;`,
            `  if (s${slot}price !== 0) {`,
        ];
        if (cfg.direction === 'BtoA') {
            lines.push(`    s${slot}pnum = ${twoPow32TimesHaircut};`);
            lines.push(`    s${slot}pden = s${slot}price * ${HADRON_PPM_DENOM};`);
        }
        else {
            lines.push(`    s${slot}pnum = s${slot}price * ${HADRON_HAIRCUT_PPM};`);
            lines.push(`    s${slot}pden = ${twoPow32TimesPpmDenom};`);
        }
        lines.push(`    s${slot}icap = Math.mulDiv(s${slot}rout, s${slot}pden, s${slot}pnum);`);
        lines.push('  }');
        return lines.join('\n');
    },
    emitQuoteCall(_base, slot, x) {
        return `qHadron(${x}, s${slot}icap, s${slot}pnum, s${slot}pden)`;
    },
    /**
     * 26-byte swap ix: disc(1)=0x03 ++ direction(1) ++ amountIn(8, patched) ++
     * minOut(8)=0 ++ i64::MAX sentinel(8) — see file header for the real/
     * simulated evidence.
     */
    buildSwapV2(base, slot, user) {
        const cfg = hadronConfig(base);
        const isBtoA = cfg.direction === 'BtoA';
        const [vaultIn, vaultOut, feeDest] = isBtoA
            ? [cfg.vaultB, cfg.vaultA, cfg.feeVaultB]
            : [cfg.vaultA, cfg.vaultB, cfg.feeVaultA];
        const roled = (role, addr) => ({ ref: ref(slot, role), address: addr, writable: true });
        return {
            programId: HADRON_PROGRAM_ID,
            prefix: Uint8Array.from([3, isBtoA ? 0 : 1]),
            suffix: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]),
            patch: 'in',
            accounts: [
                { ref: ref(slot, 'tp1'), address: HADRON_TOKEN_PROGRAM },
                { ref: ref(slot, 'tp2'), address: HADRON_TOKEN_PROGRAM },
                roled('pool', cfg.pool),
                roled('assetCfgA', cfg.assetCfgA),
                roled('assetCfgB', cfg.assetCfgB),
                roled('growingA', cfg.growingA),
                roled('poolAuth', cfg.pool),
                { ref: user.owner, signer: true },
                { ref: user.inAta, writable: true },
                roled('vaultIn', vaultIn),
                roled('vaultOut', vaultOut),
                { ref: user.outAta, writable: true },
                roled('global', cfg.global),
                roled('feeDest', feeDest),
                { ref: ref(slot, 'clock'), address: HADRON_CLOCK_SYSVAR },
                roled('metaA', cfg.metaA),
            ],
        };
    },
    referenceQuote(base, state) {
        const cfg = hadronConfig(base);
        const priceData = state[cfg.assetCfgA];
        if (priceData === undefined)
            throw new Error(`${SLUG} reference is missing price account ${cfg.assetCfgA}`);
        const voutAddr = cfg.direction === 'BtoA' ? cfg.vaultA : cfg.vaultB;
        const voutData = state[voutAddr];
        if (voutData === undefined)
            throw new Error(`${SLUG} reference is missing vault ${voutAddr}`);
        const price = readUintLE(priceData, HADRON_PRICE_OFFSET, 8);
        if (price === 0n)
            return () => 0n;
        const rout = readUintLE(voutData, HADRON_AMOUNT_OFF, 8);
        const [en, ed] = cfg.direction === 'BtoA'
            ? [HADRON_PRICE_SCALE * HADRON_HAIRCUT_PPM, price * HADRON_PPM_DENOM]
            : [price * HADRON_HAIRCUT_PPM, HADRON_PRICE_SCALE * HADRON_PPM_DENOM];
        const icap = (rout * ed) / en;
        return (x) => {
            if (x === 0n)
                return 0n;
            const cx = x > icap ? icap : x;
            if (cx === 0n)
                return 0n;
            const fee = (cx * HADRON_FEE_PPM) / HADRON_PPM_DENOM;
            const net = cx - fee;
            return (net * en) / ed;
        };
    },
    /** Real, un-haircut live vault balances — the true liquidity depth for the relative-depth filter. */
    depthReserves(base, state) {
        const cfg = hadronConfig(base);
        const [vinAddr, voutAddr] = cfg.direction === 'BtoA' ? [cfg.vaultB, cfg.vaultA] : [cfg.vaultA, cfg.vaultB];
        const vin = state[vinAddr];
        const vout = state[voutAddr];
        if (vin === undefined || vout === undefined)
            throw new Error(`${SLUG} depth is missing a vault`);
        return { reserveIn: readUintLE(vin, HADRON_AMOUNT_OFF, 8), reserveOut: readUintLE(vout, HADRON_AMOUNT_OFF, 8) };
    },
    continuousFees() {
        // Flat oracle-anchored rate (no additional per-rung decay term — gammaPpm
        // at par); muPpm folds BOTH the measured protocol fee and the
        // conservative safety haircut, so the efficiency oracle reads the same
        // conservative curve the ladder actually quotes.
        const kept = (HADRON_HAIRCUT_PPM * (HADRON_PPM_DENOM - HADRON_FEE_PPM)) / HADRON_PPM_DENOM;
        return { gammaPpm: HADRON_PPM_DENOM, muPpm: kept };
    },
};
//# sourceMappingURL=ladder.js.map