import { readUintLE } from '../math.js';
import { raydiumAmmV4 } from './index.js';
const SLUG = 'raydium-amm-v4';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** create_program_address([b"amm authority", [nonce]], programId) — one PDA for the whole program. */
const AMM_AUTHORITY = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
// AmmInfo offsets (state.rs; docs/svm-venues.md layout table).
const OFF_SWAP_FEE_NUMERATOR = 176;
const OFF_SWAP_FEE_DENOMINATOR = 184;
const OFF_NEED_TAKE_PNL_COIN = 192;
const OFF_NEED_TAKE_PNL_PC = 200;
const OFF_SPL_AMOUNT = 64;
function v4Config(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
const ref = (slot, role) => `s${slot}:${role}`;
export const raydiumAmmV4Ladder = {
    slug: SLUG,
    shapeKey(base) {
        const cfg = v4Config(base);
        return `${SLUG}:${cfg.inputIsCoin ? 'coinToPc' : 'pcToCoin'}`;
    },
    // Fee is ceil-charged on the input (checked_ceil_div, processor.rs:2396),
    // curve floors (math.rs:373). A fee that swallows the input returns 0
    // where the venue would revert.
    helpers() {
        return [
            {
                name: 'qRayV4',
                source: [
                    'function qRayV4(x, rin, rout, fn, fd) {',
                    '  if (x === 0) { return 0 }',
                    '  const fee = (x * fn + fd - 1) / fd;',
                    '  if (fee >= x) { return 0 }',
                    '  const net = x - fee;',
                    '  return Math.mulDiv(net, rout, rin + net);',
                    '}',
                ].join('\n'),
            },
        ];
    },
    /** Everything is a live read — no per-trade params. */
    paramCount: 0,
    paramsFor(_base) {
        return [];
    },
    quoteRefs(base, slot) {
        const cfg = v4Config(base);
        const [vin, vout] = cfg.inputIsCoin ? [cfg.coinVault, cfg.pcVault] : [cfg.pcVault, cfg.coinVault];
        return [
            { ref: ref(slot, 'pool'), address: cfg.pool },
            { ref: ref(slot, 'vin'), address: vin },
            { ref: ref(slot, 'vout'), address: vout },
        ];
    },
    emitSetup(base, slot) {
        const cfg = v4Config(base);
        const pool = JSON.stringify(ref(slot, 'pool'));
        const [pnlIn, pnlOut] = cfg.inputIsCoin
            ? [OFF_NEED_TAKE_PNL_COIN, OFF_NEED_TAKE_PNL_PC]
            : [OFF_NEED_TAKE_PNL_PC, OFF_NEED_TAKE_PNL_COIN];
        return [
            `  const s${slot}rin = accountUint(${JSON.stringify(ref(slot, 'vin'))}, ${OFF_SPL_AMOUNT}, 8) - accountUint(${pool}, ${pnlIn}, 8);`,
            `  const s${slot}rout = accountUint(${JSON.stringify(ref(slot, 'vout'))}, ${OFF_SPL_AMOUNT}, 8) - accountUint(${pool}, ${pnlOut}, 8);`,
            `  const s${slot}fn = accountUint(${pool}, ${OFF_SWAP_FEE_NUMERATOR}, 8);`,
            `  const s${slot}fd = accountUint(${pool}, ${OFF_SWAP_FEE_DENOMINATOR}, 8);`,
        ].join('\n');
    },
    emitQuoteCall(_base, slot, x) {
        return `qRayV4(${x}, s${slot}rin, s${slot}rout, s${slot}fn, s${slot}fd)`;
    },
    buildSwapV2(base, slot, user) {
        const cfg = v4Config(base);
        // swap_base_in_v2: tag 0x10 ++ amount_in u64 LE (runtime-patched) ++
        // minimum_amount_out u64 LE = 1. The program infers direction from the
        // user token account mints, so the account list is direction-independent
        // (coin vault always precedes pc vault).
        const roled = (role, addr, writable) => writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
        return {
            programId: raydiumAmmV4.programId,
            prefix: Uint8Array.from([0x10]),
            suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
            patch: 'in',
            accounts: [
                roled('tp', TOKEN_PROGRAM),
                roled('pool', cfg.pool, true),
                roled('auth', AMM_AUTHORITY),
                roled(cfg.inputIsCoin ? 'vin' : 'vout', cfg.coinVault, true),
                roled(cfg.inputIsCoin ? 'vout' : 'vin', cfg.pcVault, true),
                { ref: user.inAta, writable: true },
                { ref: user.outAta, writable: true },
                { ref: user.owner, signer: true },
            ],
        };
    },
    referenceQuote(base, state, _params) {
        const cfg = v4Config(base);
        const bytes = (addr) => {
            const data = state[addr];
            if (data === undefined)
                throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
            return data;
        };
        const pool = bytes(cfg.pool);
        const [pnlIn, pnlOut] = cfg.inputIsCoin
            ? [OFF_NEED_TAKE_PNL_COIN, OFF_NEED_TAKE_PNL_PC]
            : [OFF_NEED_TAKE_PNL_PC, OFF_NEED_TAKE_PNL_COIN];
        const rin = readUintLE(bytes(cfg.inputIsCoin ? cfg.coinVault : cfg.pcVault), OFF_SPL_AMOUNT, 8) - readUintLE(pool, pnlIn, 8);
        const rout = readUintLE(bytes(cfg.inputIsCoin ? cfg.pcVault : cfg.coinVault), OFF_SPL_AMOUNT, 8) - readUintLE(pool, pnlOut, 8);
        const fn = readUintLE(pool, OFF_SWAP_FEE_NUMERATOR, 8);
        const fd = readUintLE(pool, OFF_SWAP_FEE_DENOMINATOR, 8);
        return (x) => {
            if (x === 0n)
                return 0n;
            const fee = (x * fn + fd - 1n) / fd;
            if (fee >= x)
                return 0n;
            const net = x - fee;
            return (net * rout) / (rin + net);
        };
    },
    depthReserves(base, state) {
        const cfg = v4Config(base);
        const bytes = (addr) => {
            const data = state[addr];
            if (data === undefined)
                throw new Error(`${SLUG} ladder depth is missing account ${addr}`);
            return data;
        };
        const pool = bytes(cfg.pool);
        const coin = readUintLE(bytes(cfg.coinVault), OFF_SPL_AMOUNT, 8) - readUintLE(pool, OFF_NEED_TAKE_PNL_COIN, 8);
        const pc = readUintLE(bytes(cfg.pcVault), OFF_SPL_AMOUNT, 8) - readUintLE(pool, OFF_NEED_TAKE_PNL_PC, 8);
        return cfg.inputIsCoin ? { reserveIn: coin, reserveOut: pc } : { reserveIn: pc, reserveOut: coin };
    },
    continuousFees(base, state) {
        const cfg = v4Config(base);
        const pool = state[cfg.pool];
        if (pool === undefined)
            throw new Error(`${SLUG} ladder fees are missing account ${cfg.pool}`);
        const fn = readUintLE(pool, OFF_SWAP_FEE_NUMERATOR, 8);
        const fd = readUintLE(pool, OFF_SWAP_FEE_DENOMINATOR, 8);
        return { gammaPpm: 1000000n - (fn * 1000000n) / fd, muPpm: 1000000n };
    },
};
//# sourceMappingURL=ladder.js.map