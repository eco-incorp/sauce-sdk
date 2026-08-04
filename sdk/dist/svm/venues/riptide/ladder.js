import { readUintLE } from '../math.js';
import { AMOUNT_OFF, JITODONTFRONT, MEMO_PROGRAM, RIPTIDE_PROGRAM_ID, SYSVAR_INSTRUCTIONS, TOKEN_PROGRAM, riptideConfig } from './index.js';
const SLUG = 'riptide';
/** disc(1) ++ amountIn u64 LE (patched) ++ direction(1) ++ reserved(1)=0 ++ flag(1) = 12 bytes. */
const SWAP_DISCRIMINATOR = 0x02;
/** Byte 11: observed as 0 or 1 across real swaps, uncorrelated with direction; fixed at the majority value. */
const TAIL_FLAG = 1;
/** Conservative haircut on the modeled output side — see the module doc "Quote curve" note. */
const OUT_DISCOUNT_NUM = 1n;
const OUT_DISCOUNT_DEN = 2n;
const ref = (slot, role) => `s${slot}:${role}`;
export const riptideLadder = {
    slug: SLUG,
    /** Simple CP-style curve (no window walk / Newton iteration), 4 rungs. */
    defaultRungs: 4,
    shapeKey(base) {
        return `${SLUG}:${riptideConfig(base).direction}`;
    },
    helpers() {
        return [
            {
                name: 'qRiptide',
                source: [
                    'function qRiptide(x, rin, rout) {',
                    '  if (x === 0) { return 0 }',
                    '  return Math.mulDiv(x, rout, rin + x);',
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
        const cfg = riptideConfig(base);
        const [vin, vout] = cfg.direction === 0 ? [cfg.vaultA, cfg.vaultB] : [cfg.vaultB, cfg.vaultA];
        return [
            { ref: ref(slot, 'vin'), address: vin },
            { ref: ref(slot, 'vout'), address: vout },
        ];
    },
    emitSetup(base, slot) {
        riptideConfig(base);
        const vin = JSON.stringify(ref(slot, 'vin'));
        const vout = JSON.stringify(ref(slot, 'vout'));
        return [
            `  const s${slot}rin = accountUint(${vin}, ${AMOUNT_OFF}, 8);`,
            `  const s${slot}rout = (accountUint(${vout}, ${AMOUNT_OFF}, 8) * ${OUT_DISCOUNT_NUM}) / ${OUT_DISCOUNT_DEN};`,
        ].join('\n');
    },
    emitQuoteCall(_base, slot, x) {
        return `qRiptide(${x}, s${slot}rin, s${slot}rout)`;
    },
    buildSwapV2(base, slot, user) {
        const cfg = riptideConfig(base);
        const [userAtaA, userAtaB] = cfg.direction === 0 ? [user.inAta, user.outAta] : [user.outAta, user.inAta];
        const roled = (roleRef, addr, writable) => writable ? { ref: ref(slot, roleRef), address: addr, writable: true } : { ref: ref(slot, roleRef), address: addr };
        // byte9 direction bit: 1 = mintA in, 0 = mintB in — the inverse of our own
        // cfg.direction numbering (0 = mintA in) — see index.ts's header.
        const directionBit = cfg.direction === 0 ? 1 : 0;
        return {
            programId: RIPTIDE_PROGRAM_ID,
            prefix: Uint8Array.from([SWAP_DISCRIMINATOR]),
            // direction ++ reserved(0) ++ TAIL_FLAG.
            suffix: Uint8Array.from([directionBit, 0, TAIL_FLAG]),
            patch: 'in',
            accounts: [
                { ref: user.owner, signer: true },
                roled('pool', cfg.pool, true),
                roled('mintA', cfg.mintA),
                roled('mintB', cfg.mintB),
                { ref: userAtaA, writable: true },
                { ref: userAtaB, writable: true },
                roled('vaultA', cfg.vaultA, true),
                roled('vaultB', cfg.vaultB, true),
                roled('tp1', TOKEN_PROGRAM),
                roled('tp2', TOKEN_PROGRAM),
                roled('memo', MEMO_PROGRAM),
                roled('sysvarInstructions', SYSVAR_INSTRUCTIONS),
                { ref: 'jitodontfront', address: JITODONTFRONT },
            ],
        };
    },
    referenceQuote(base, state) {
        const cfg = riptideConfig(base);
        const [vin, vout] = cfg.direction === 0 ? [cfg.vaultA, cfg.vaultB] : [cfg.vaultB, cfg.vaultA];
        const vinData = state[vin];
        const voutData = state[vout];
        if (vinData === undefined)
            throw new Error(`${SLUG} reference is missing vault ${vin}`);
        if (voutData === undefined)
            throw new Error(`${SLUG} reference is missing vault ${vout}`);
        const rin = readUintLE(vinData, AMOUNT_OFF, 8);
        const rout = (readUintLE(voutData, AMOUNT_OFF, 8) * OUT_DISCOUNT_NUM) / OUT_DISCOUNT_DEN;
        return (x) => {
            if (x === 0n)
                return 0n;
            return (x * rout) / (rin + x);
        };
    },
    depthReserves(base, state) {
        const cfg = riptideConfig(base);
        const vaData = state[cfg.vaultA];
        const vbData = state[cfg.vaultB];
        if (vaData === undefined || vbData === undefined)
            throw new Error(`${SLUG} depth is missing a vault`);
        // Real (undiscounted) vault balances — the true liquidity depth for the
        // relative-depth filter; the conservative haircut above is a QUOTE-only
        // safety margin, not a claim about real depth.
        const ra = readUintLE(vaData, AMOUNT_OFF, 8);
        const rb = readUintLE(vbData, AMOUNT_OFF, 8);
        return cfg.direction === 0 ? { reserveIn: ra, reserveOut: rb } : { reserveIn: rb, reserveOut: ra };
    },
    continuousFees() {
        // Measurement-only oracle (see the SvmVenueLadder doc comment) — no
        // additional denominator decay (gammaPpm at par), muPpm folds the
        // OUT_DISCOUNT_NUM/DEN conservative haircut so the efficiency oracle
        // reads the same conservative curve the ladder actually quotes.
        return { gammaPpm: 1000000n, muPpm: (1000000n * OUT_DISCOUNT_NUM) / OUT_DISCOUNT_DEN };
    },
};
//# sourceMappingURL=ladder.js.map