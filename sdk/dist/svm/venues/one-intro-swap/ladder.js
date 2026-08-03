import { readUintLE } from '../math.js';
import { oneIntroSwapConfig, ONE_INTRO_SWAP_METADATA_STATE, ONE_INTRO_SWAP_PROGRAM_ID, OFF_VIRTUAL_RESERVE0, OFF_VIRTUAL_RESERVE1, TOKEN_ACCOUNT_AMOUNT_OFFSET } from './index.js';
const SLUG = 'one-intro-swap';
// sha256("global:swap_exact_amount_in")[0..8] — read directly off the Anchor
// debug log's "Instruction: SwapExactAmountIn" line paired with the observed
// mainnet instruction's own 8-byte data prefix (both real mainnet txs AND
// this adapter's own independently-built real-CPI calls hit this exact
// discriminator successfully).
const SWAP_EXACT_AMOUNT_IN_DISCRIMINATOR = [0x08, 0x97, 0xf5, 0x4c, 0xac, 0xcb, 0x90, 0x27];
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const FEE_UNIT_DENOM = 100000n;
const TOTAL_FEE_MULT = 10n; // 2 explicit (1x each) + 1 implicit (8x), all in units of feeUnit.
const ref = (slot, role) => `${SLUG}:s${slot}:${role}`;
function ceilDiv(a, b) {
    return (a + b - 1n) / b;
}
/** grossIn -> effIn — the SAME split on-chain and off-chain. */
function effectiveIn(grossIn) {
    const feeUnit = grossIn / FEE_UNIT_DENOM;
    return grossIn - TOTAL_FEE_MULT * feeUnit;
}
function quoteOut(biV, boV, grossIn, vaultOutBal) {
    if (grossIn === 0n || biV === 0n || boV === 0n)
        return 0n;
    const effIn = effectiveIn(grossIn);
    if (effIn <= 0n)
        return 0n;
    const denom = biV + effIn;
    const div = ceilDiv(biV * boV, denom);
    if (div >= boV)
        return 0n;
    const out = boV - div;
    return out < vaultOutBal ? out : vaultOutBal;
}
export const oneIntroSwapLadder = {
    slug: SLUG,
    shapeKey(base) {
        const cfg = oneIntroSwapConfig(base);
        return `${SLUG}:${cfg.direction}`;
    },
    helpers() {
        return [
            {
                name: 'qOneIntroSwap',
                source: [
                    'function qOneIntroSwap(x, biv, bov, vob) {',
                    '  if (x === 0) { return 0 }',
                    '  if (biv === 0 || bov === 0) { return 0 }',
                    '  const feeUnit = x / 100000;',
                    '  const effIn = x - feeUnit * 10;',
                    '  if (effIn <= 0) { return 0 }',
                    '  const denom = biv + effIn;',
                    '  const div = (biv * bov + denom - 1) / denom;',
                    '  if (div >= bov) { return 0 }',
                    '  const out = bov - div;',
                    '  const capped = out < vob ? out : vob;',
                    '  return capped;',
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
        const cfg = oneIntroSwapConfig(base);
        const vaultOut = cfg.direction === '1to0' ? cfg.vault0 : cfg.vault1;
        return [
            { ref: ref(slot, 'pool'), address: cfg.pool },
            { ref: ref(slot, 'vout'), address: vaultOut },
        ];
    },
    emitSetup(base, slot) {
        const cfg = oneIntroSwapConfig(base);
        const zeroToOne = cfg.direction === '0to1';
        const pool = JSON.stringify(ref(slot, 'pool'));
        const vout = JSON.stringify(ref(slot, 'vout'));
        const [inOff, outOff] = zeroToOne ? [OFF_VIRTUAL_RESERVE0, OFF_VIRTUAL_RESERVE1] : [OFF_VIRTUAL_RESERVE1, OFF_VIRTUAL_RESERVE0];
        return [
            `  const s${slot}biv = accountUint(${pool}, ${inOff}, 8);`,
            `  const s${slot}bov = accountUint(${pool}, ${outOff}, 8);`,
            `  const s${slot}vob = accountUint(${vout}, ${TOKEN_ACCOUNT_AMOUNT_OFFSET}, 8);`,
        ].join('\n');
    },
    emitQuoteCall(_base, slot, x) {
        return `qOneIntroSwap(${x}, s${slot}biv, s${slot}bov, s${slot}vob)`;
    },
    buildSwapV2(base, slot, user) {
        const cfg = oneIntroSwapConfig(base);
        const zeroToOne = cfg.direction === '0to1';
        const [vaultIn, vaultOut] = zeroToOne ? [cfg.vault0, cfg.vault1] : [cfg.vault1, cfg.vault0];
        const [feeA, feeB] = zeroToOne ? [cfg.feeA0, cfg.feeB0] : [cfg.feeA1, cfg.feeB1];
        const suffix = new Uint8Array(8);
        new DataView(suffix.buffer).setBigUint64(0, 1n, true); // minimum_amount_out = 1 (recipe's own outAta delta check is the real bound).
        const roled = (role, addr, writable) => writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
        return {
            programId: ONE_INTRO_SWAP_PROGRAM_ID,
            prefix: Uint8Array.from(SWAP_EXACT_AMOUNT_IN_DISCRIMINATOR),
            suffix,
            patch: 'in',
            accounts: [
                roled('metadata', ONE_INTRO_SWAP_METADATA_STATE),
                roled('pool', cfg.pool, true),
                roled('authority', cfg.authority),
                roled('vin', vaultIn, true),
                roled('vout', vaultOut, true),
                { ref: user.owner, signer: true, writable: true },
                { ref: user.inAta, writable: true },
                { ref: user.outAta, writable: true },
                roled('feeA', feeA, true),
                roled('feeB', feeB, true),
                roled('tp', TOKEN_PROGRAM),
            ],
        };
    },
    referenceQuote(base, state) {
        const cfg = oneIntroSwapConfig(base);
        const zeroToOne = cfg.direction === '0to1';
        const bytes = (addr) => {
            const data = state[addr];
            if (data === undefined)
                throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
            return data;
        };
        const pool = bytes(cfg.pool);
        const vaultOutAddr = zeroToOne ? cfg.vault1 : cfg.vault0;
        const [inOff, outOff] = zeroToOne ? [OFF_VIRTUAL_RESERVE0, OFF_VIRTUAL_RESERVE1] : [OFF_VIRTUAL_RESERVE1, OFF_VIRTUAL_RESERVE0];
        const biV = readUintLE(pool, inOff, 8);
        const boV = readUintLE(pool, outOff, 8);
        const vaultOutBal = readUintLE(bytes(vaultOutAddr), TOKEN_ACCOUNT_AMOUNT_OFFSET, 8);
        return (x) => quoteOut(biV, boV, x, vaultOutBal);
    },
    depthReserves(base, state) {
        const cfg = oneIntroSwapConfig(base);
        const zeroToOne = cfg.direction === '0to1';
        const bytes = (addr) => {
            const data = state[addr];
            if (data === undefined)
                throw new Error(`${SLUG} ladder depth is missing account ${addr}`);
            return data;
        };
        const pool = bytes(cfg.pool);
        const vaultOutAddr = zeroToOne ? cfg.vault1 : cfg.vault0;
        const [inOff, outOff] = zeroToOne ? [OFF_VIRTUAL_RESERVE0, OFF_VIRTUAL_RESERVE1] : [OFF_VIRTUAL_RESERVE1, OFF_VIRTUAL_RESERVE0];
        const reserveIn = readUintLE(pool, inOff, 8);
        const virtualOut = readUintLE(pool, outOff, 8);
        const vaultOutBal = readUintLE(bytes(vaultOutAddr), TOKEN_ACCOUNT_AMOUNT_OFFSET, 8);
        // Honest depth: the smaller of the pool's own belief and what the real vault can actually pay out.
        const reserveOut = virtualOut < vaultOutBal ? virtualOut : vaultOutBal;
        return { reserveIn, reserveOut };
    },
    continuousFees() {
        // Total fee is exactly 10 * feeUnit / grossIn ~= 100 ppm (1 bps) — see the
        // module header. muPpm stays 1e6 (no separate output-side skim).
        return { gammaPpm: 999900n, muPpm: 1000000n };
    },
};
//# sourceMappingURL=ladder.js.map