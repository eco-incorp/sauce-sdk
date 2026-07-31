import { readUintLE } from '../math.js';
import { INSTRUCTIONS_SYSVAR } from '../../cpi-probe.js';
import { MID_SCALE, OFF_MID, PRICE_PPM_DEN, TESSERAV_PROGRAM_ID, TOKEN_PROGRAM, level0CumOffset, level0PriceOffset, } from './index.js';
const SLUG = 'tesserav';
const ref = (slot, role) => `s${slot}:${role}`;
/** Swap ix: tag(1B)=0x10 ++ direction(1B) ++ amountIn u64 LE (patched) ++ minOut u64 LE. */
const SWAP_TAG = 0x10;
/** Conservative haircut applied to price0 before quoting — see the file header. 20 bps. */
export const SAFETY_NUM = 998n;
export const SAFETY_DEN = 1000n;
function tvConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
/** function qTvAB(x, price0, mid, capIn) — sell mintA for mintB (mid_ratio = MID_SCALE/mid). */
const HELPER_AB = {
    name: 'qTvAB',
    source: [
        'function qTvAB(x, price0, mid, capIn) {',
        '  if (x === 0 || mid === 0) { return 0 }',
        '  let cx = x;',
        '  if (cx > capIn) { cx = capIn }',
        `  const p = (price0 * ${SAFETY_NUM}) / ${SAFETY_DEN};`,
        `  return (cx * p * ${MID_SCALE}) / (${PRICE_PPM_DEN} * mid);`,
        '}',
    ].join('\n'),
};
/** function qTvBA(x, price0, mid, capIn) — sell mintB for mintA (mid_ratio = mid/MID_SCALE). */
const HELPER_BA = {
    name: 'qTvBA',
    source: [
        'function qTvBA(x, price0, mid, capIn) {',
        '  if (x === 0 || mid === 0) { return 0 }',
        '  let cx = x;',
        '  if (cx > capIn) { cx = capIn }',
        `  const p = (price0 * ${SAFETY_NUM}) / ${SAFETY_DEN};`,
        `  return (cx * p * mid) / (${PRICE_PPM_DEN} * ${MID_SCALE});`,
        '}',
    ].join('\n'),
};
/** TS mirror of qTvAB. */
export function tesseraVQuoteAB(x, price0, mid, capIn) {
    if (x === 0n || mid === 0n)
        return 0n;
    const cx = x > capIn ? capIn : x;
    const p = (price0 * SAFETY_NUM) / SAFETY_DEN;
    return (cx * p * MID_SCALE) / (PRICE_PPM_DEN * mid);
}
/** TS mirror of qTvBA. */
export function tesseraVQuoteBA(x, price0, mid, capIn) {
    if (x === 0n || mid === 0n)
        return 0n;
    const cx = x > capIn ? capIn : x;
    const p = (price0 * SAFETY_NUM) / SAFETY_DEN;
    return (cx * p * mid) / (PRICE_PPM_DEN * MID_SCALE);
}
/**
 * capIn: the largest input whose UNCAPPED quote would not exceed the slot's
 * published output-side cap, floor throughout (never over-states the true
 * cap). Both directions invert the same formula their quote uses.
 */
function capInFor(direction, price0, mid, capOut) {
    if (price0 === 0n)
        return 0n;
    const p = (price0 * SAFETY_NUM) / SAFETY_DEN;
    if (p === 0n)
        return 0n;
    if (direction === 'aToB') {
        // out = cx * p * MID_SCALE / (DEN * mid)  =>  cx = out * DEN * mid / (p * MID_SCALE)
        return (capOut * PRICE_PPM_DEN * mid) / (p * MID_SCALE);
    }
    // out = cx * p * mid / (DEN * MID_SCALE)  =>  cx = out * DEN * MID_SCALE / (p * mid)
    if (mid === 0n)
        return 0n;
    return (capOut * PRICE_PPM_DEN * MID_SCALE) / (p * mid);
}
export const tesseravLadder = {
    slug: SLUG,
    // No defaultRungs override: the flat-rate level-0 model is exact at any
    // rung count (every grid point below capacity samples the SAME linear
    // rate), so this rides the CP default (4, recipes/ecoswap/svm/budget.ts's
    // FamilyCuCoefficients doc) like the other simple CP families
    // (raydium-cp-swap, raydium-amm-v4, pumpswap, orca-legacy-token-swap,
    // meteora-damm-v2) rather than inventing a rung count below MIN_RUNGS=2
    // (recipes/ecoswap/svm/solver-reference.ts) that nothing else in the
    // ladder/budget pipeline expects.
    shapeKey(base) {
        return `${SLUG}:${tvConfig(base).direction}`;
    },
    helpers(base) {
        return [tvConfig(base).direction === 'aToB' ? HELPER_AB : HELPER_BA];
    },
    paramCount: 0,
    paramsFor() {
        return [];
    },
    quoteRefs(base, slot) {
        const cfg = tvConfig(base);
        return [{ ref: ref(slot, 'pool'), address: cfg.pool }];
    },
    emitSetup(base, slot) {
        const cfg = tvConfig(base);
        const p = `s${slot}`;
        const pool = JSON.stringify(ref(slot, 'pool'));
        const priceOff = level0PriceOffset(cfg.direction);
        const cumOff = level0CumOffset(cfg.direction);
        return [
            `  const ${p}mid = accountUint(${pool}, ${OFF_MID}, 8);`,
            `  const ${p}p0 = accountUint(${pool}, ${priceOff}, 8);`,
            `  const ${p}cout = accountUint(${pool}, ${cumOff}, 8);`,
            // capIn: the largest input whose uncapped quote stays <= cout — a
            // one-shot inversion of the SAME formula the quote fragment uses,
            // floor throughout so it can only understate the true cap.
            `  let ${p}cin = 0;`,
            `  if (${p}p0 > 0 && ${p}mid > 0) {`,
            `    const ${p}pp = (${p}p0 * ${SAFETY_NUM}) / ${SAFETY_DEN};`,
            `    if (${p}pp > 0) {`,
            cfg.direction === 'aToB'
                ? `      ${p}cin = (${p}cout * ${PRICE_PPM_DEN} * ${p}mid) / (${p}pp * ${MID_SCALE});`
                : `      ${p}cin = (${p}cout * ${PRICE_PPM_DEN} * ${MID_SCALE}) / (${p}pp * ${p}mid);`,
            '    }',
            '  }',
            `  let ${p}cx = 0;`,
        ].join('\n');
    },
    emitLadderQuote(base, slot, _rung, x, outVar) {
        const cfg = tvConfig(base);
        const p = `s${slot}`;
        const fn = cfg.direction === 'aToB' ? 'qTvAB' : 'qTvBA';
        return [
            `    ${p}cx = ${x};`,
            `    if (${p}cx > ${p}cin) { ${p}cx = ${p}cin }`,
            `    const ${outVar} = ${fn}(${x}, ${p}p0, ${p}mid, ${p}cin);`,
        ].join('\n');
    },
    emitFinalQuote(base, slot, x, outVar) {
        const cfg = tvConfig(base);
        const p = `s${slot}`;
        const fn = cfg.direction === 'aToB' ? 'qTvAB' : 'qTvBA';
        return [
            `    ${p}cx = ${x};`,
            `    if (${p}cx > ${p}cin) { ${p}cx = ${p}cin }`,
            `    let ${outVar} = ${fn}(${x}, ${p}p0, ${p}mid, ${p}cin);`,
        ].join('\n');
    },
    capacityInputVar(slot) {
        return `s${slot}cx`;
    },
    buildSwapV2(base, slot, user) {
        const cfg = tvConfig(base);
        const directionByte = cfg.direction === 'aToB' ? 1 : 0;
        const roled = (role, addr, writable) => writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
        return {
            programId: TESSERAV_PROGRAM_ID,
            prefix: Uint8Array.from([SWAP_TAG, directionByte]),
            suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]), // minOut = 1; the recipe's delta check is the real floor.
            patch: 'in',
            accounts: [
                roled('auth', cfg.auth),
                roled('pool', cfg.pool, true),
                { ref: user.owner, signer: true },
                roled('vaultA', cfg.vaultA, true),
                roled('vaultB', cfg.vaultB, true),
                { ref: user.inAta, writable: true },
                { ref: user.outAta, writable: true },
                roled('mintA', cfg.mintA),
                roled('mintB', cfg.mintB),
                roled('tp1', TOKEN_PROGRAM),
                roled('tp2', TOKEN_PROGRAM),
                roled('ixSysvar', INSTRUCTIONS_SYSVAR),
            ],
        };
    },
    referenceQuote(base, state) {
        const cfg = tvConfig(base);
        const pool = state[cfg.pool];
        if (pool === undefined)
            throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
        const mid = readUintLE(pool, OFF_MID, 8);
        const price0 = readUintLE(pool, level0PriceOffset(cfg.direction), 8);
        const capOut = readUintLE(pool, level0CumOffset(cfg.direction), 8);
        const capIn = capInFor(cfg.direction, price0, mid, capOut);
        const quote = cfg.direction === 'aToB' ? tesseraVQuoteAB : tesseraVQuoteBA;
        return (x) => quote(x, price0, mid, capIn);
    },
    referenceCapacities(base, state) {
        const cfg = tvConfig(base);
        const pool = state[cfg.pool];
        if (pool === undefined)
            throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
        const mid = readUintLE(pool, OFF_MID, 8);
        const price0 = readUintLE(pool, level0PriceOffset(cfg.direction), 8);
        const capOut = readUintLE(pool, level0CumOffset(cfg.direction), 8);
        const capIn = capInFor(cfg.direction, price0, mid, capOut);
        return (grid) => grid.map((g) => (g > capIn ? capIn : g));
    },
    depthReserves(base, state) {
        const cfg = tvConfig(base);
        const pool = state[cfg.pool];
        if (pool === undefined)
            throw new Error(`${SLUG} ladder depth is missing account ${cfg.pool}`);
        const mid = readUintLE(pool, OFF_MID, 8);
        const price0 = readUintLE(pool, level0PriceOffset(cfg.direction), 8);
        const capOut = readUintLE(pool, level0CumOffset(cfg.direction), 8);
        const capIn = capInFor(cfg.direction, price0, mid, capOut);
        return { reserveIn: capIn, reserveOut: capOut };
    },
    continuousFees() {
        // Flat-rate venue up to its (small, level-0) capacity: no CP curvature.
        // gammaPpm=0 disables the continuous-oracle curve fit (measurement-only,
        // never a gate — see types.ts's doc); muPpm carries the venue's own spread.
        return { gammaPpm: 0n, muPpm: PRICE_PPM_DEN - (PRICE_PPM_DEN - (PRICE_PPM_DEN * SAFETY_NUM) / SAFETY_DEN) };
    },
};
//# sourceMappingURL=ladder.js.map