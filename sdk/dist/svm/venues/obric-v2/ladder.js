import { readUintLE } from '../math.js';
import { OBRIC_SWAP_DISCRIMINATOR, OBRIC_V2_PROGRAM_ID, OFF_MULT_X, OFF_MULT_Y, swapAccounts, } from './index.js';
const SLUG = 'obric-v2';
/** SPL token account amount offset. */
const AMOUNT_OFF = 64;
const U64_MAX = (1n << 64n) - 1n;
const FEE_DEN = 1000000n;
/** Pyth-v2 relay: agg.status (u32 LE, 1 == Trading) sits 16 bytes past agg.price. */
const FEED_STATUS_GAP = 16;
const FEED_STATUS_TRADING = 1n;
/** cfg words per slot (paramsFor order). */
const PARAM_COUNT = 11;
function obricConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
const ref = (slot, role) => `s${slot}:${role}`;
/** Floor integer square root (mirrors the engine's SQRT op). */
export function isqrt(value) {
    if (value < 0n)
        throw new Error(`isqrt needs a non-negative value, got ${value}`);
    if (value < 2n)
        return value;
    let x = value;
    let y = (x + 1n) / 2n;
    while (y < x) {
        x = y;
        y = (x + value / x) / 2n;
    }
    return x;
}
/**
 * The COLD (final, venue-exact) oracle-anchored quote: the shifted-CP output
 * for gross input x, or 0 PAST CAPACITY (output would exceed reserveOut — the
 * venue's "Insufficient active" revert; a 0 final quote skips the CPI). This
 * is the predicted output the minOut check and the real swap see. `kq` is the
 * quote bigK (0 ⇒ deactivated: out-of-band oracle / underflow).
 */
export function obricColdQuote(x, cIn, cOut, kq, rOut, fee) {
    if (x === 0n || kq === 0n)
        return 0n;
    const nOut = kq / (cIn + x);
    let g = 0n;
    if (nOut < cOut)
        g = cOut - nOut;
    if (g > rOut)
        return 0n; // past capacity — skip the CPI
    return g - (g * fee) / FEE_DEN;
}
/** The reference twin of emitSetup: derive the live curve anchor from account bytes + params. */
function liveCurve(cfg, state, params) {
    const pool = state[cfg.pool];
    const vx = state[cfg.reserveXVault];
    const vy = state[cfg.reserveYVault];
    const fx = state[cfg.feedX];
    const fy = state[cfg.feedY];
    if (pool === undefined)
        throw new Error(`${SLUG} reference is missing pool ${cfg.pool}`);
    if (vx === undefined || vy === undefined)
        throw new Error(`${SLUG} reference is missing a reserve vault`);
    if (fx === undefined || fy === undefined)
        throw new Error(`${SLUG} reference is missing a price feed`);
    const [bkHi, bkLo, targetX, fee, divX, mulX, divY, mulY, offX, offY, band] = params;
    const rx = readUintLE(vx, AMOUNT_OFF, 8);
    const ry = readUintLE(vy, AMOUNT_OFF, 8);
    const ax = readUintLE(fx, Number(offX), 8);
    const ay = readUintLE(fy, Number(offY), 8);
    const mx = (ax / divX) * mulX;
    const my = (ay / divY) * mulY;
    const k = (bkHi << 64n) | bkLo;
    const off = { cIn: 0n, cOut: 0n, kq: 0n, rOut: 0n, fee };
    // Both admitted feeds are the Pyth-v2 relay (non-relay layouts are rejected P-B
    // at fetch), so agg.status sits 16 bytes past the price word; a feed that is not
    // Trading (1) deactivates the slot rather than quoting a halted mid.
    const sx = readUintLE(fx, Number(offX) + FEED_STATUS_GAP, 4);
    const sy = readUintLE(fy, Number(offY) + FEED_STATUS_GAP, 4);
    let ok = mx !== 0n && my !== 0n && sx === FEED_STATUS_TRADING && sy === FEED_STATUS_TRADING;
    if (band !== 0n && ok) {
        const zx = readUintLE(pool, OFF_MULT_X, 8);
        const zy = readUintLE(pool, OFF_MULT_Y, 8);
        const lhs = my * zx * 10000n;
        if (lhs > (10000n + band) * zy * mx)
            ok = false;
        if (lhs < (10000n - band) * zy * mx)
            ok = false;
    }
    if (!ok)
        return off;
    const tk = isqrt((k * my) / mx);
    if (tk + rx <= targetX)
        return off; // currentXK would underflow — deactivate
    const cx = tk - targetX + rx;
    const cy = k / cx;
    return cfg.direction === 'xToY'
        ? { cIn: cx, cOut: cy, kq: k, rOut: ry, fee }
        : { cIn: cy, cOut: cx, kq: k, rOut: rx, fee };
}
export const obricV2Ladder = {
    slug: SLUG,
    /** CP-class: a closed-form quote (one isqrt + a division per rung), 4 rungs. */
    defaultRungs: 4,
    shapeKey(base) {
        return `${SLUG}:${obricConfig(base).direction}`;
    },
    /** The quote is inline statement-form (last-good ladder / cold final) — no shared helper. */
    helpers() {
        return [];
    },
    paramCount: PARAM_COUNT,
    paramsFor(base) {
        const c = obricConfig(base);
        return [
            c.bigK >> 64n,
            c.bigK & U64_MAX,
            c.targetX,
            c.feeMillionth,
            c.divX,
            c.mulX,
            c.divY,
            c.mulY,
            c.priceOffX,
            c.priceOffY,
            c.bandBps,
        ];
    },
    quoteRefs(base, slot) {
        const c = obricConfig(base);
        return [
            { ref: ref(slot, 'pool'), address: c.pool },
            { ref: ref(slot, 'fx'), address: c.feedX },
            { ref: ref(slot, 'fy'), address: c.feedY },
            { ref: ref(slot, 'vx'), address: c.reserveXVault },
            { ref: ref(slot, 'vy'), address: c.reserveYVault },
        ];
    },
    emitSetup(base, slot, params, enableVar) {
        const c = obricConfig(base);
        const xToY = c.direction === 'xToY';
        const p = `s${slot}`;
        const en = enableVar ?? `${p}en`;
        const pool = JSON.stringify(ref(slot, 'pool'));
        const fx = JSON.stringify(ref(slot, 'fx'));
        const fy = JSON.stringify(ref(slot, 'fy'));
        const vx = JSON.stringify(ref(slot, 'vx'));
        const vy = JSON.stringify(ref(slot, 'vy'));
        const [bkHi, bkLo, targetX, fee, divX, mulX, divY, mulY, offX, offY, band] = params;
        const assign = xToY
            ? `${p}ci = ${p}cx; ${p}co = ${p}cy; ${p}ro = ${p}ry; ${p}kq = ${p}bk;`
            : `${p}ci = ${p}cy; ${p}co = ${p}cx; ${p}ro = ${p}rx; ${p}kq = ${p}bk;`;
        return [
            // LIVE reads (unconditional — the accounts must be readable regardless of enable).
            `  const ${p}rx = accountUint(${vx}, ${AMOUNT_OFF}, 8);`,
            `  const ${p}ry = accountUint(${vy}, ${AMOUNT_OFF}, 8);`,
            `  const ${p}ax = accountUint(${fx}, ${offX}, 8);`,
            `  const ${p}ay = accountUint(${fy}, ${offY}, 8);`,
            `  const ${p}mx = (${p}ax / ${divX}) * ${mulX};`,
            `  const ${p}my = (${p}ay / ${divY}) * ${mulY};`,
            // agg.status (Pyth-v2 relay: 16 bytes past the price word) — a non-Trading
            // feed deactivates the slot rather than quoting a halted mid.
            `  const ${p}sx = accountUint(${fx}, ${Number(c.priceOffX) + FEED_STATUS_GAP}, 4);`,
            `  const ${p}sy = accountUint(${fy}, ${Number(c.priceOffY) + FEED_STATUS_GAP}, 4);`,
            `  const ${p}bk = (${bkHi} << 64) | ${bkLo};`,
            `  const ${p}fe = ${fee};`,
            // Curve anchor + sanity band (EXPENSIVE — isqrt/products gated on enable).
            `  let ${p}ci = 0; let ${p}co = 0; let ${p}kq = 0; let ${p}ro = 0;`,
            // Ladder-chain state (last-good output + capped flag) and quote temps —
            // declared here, reassigned per rung (one enable-gated ladder block).
            `  let ${p}lo = 0; let ${p}cap = 0; let ${p}ni = 0; let ${p}no = 0; let ${p}gg = 0;`,
            `  if (${en} !== 0) {`,
            `    let ${p}ok = 1;`,
            `    if (${p}mx === 0) { ${p}ok = 0 }`,
            `    if (${p}my === 0) { ${p}ok = 0 }`,
            `    if (${p}sx !== ${FEED_STATUS_TRADING}) { ${p}ok = 0 }`,
            `    if (${p}sy !== ${FEED_STATUS_TRADING}) { ${p}ok = 0 }`,
            `    if (${band} !== 0 && ${p}ok !== 0) {`,
            `      const ${p}zx = accountUint(${pool}, ${OFF_MULT_X}, 8);`,
            `      const ${p}zy = accountUint(${pool}, ${OFF_MULT_Y}, 8);`,
            `      const ${p}lh = ${p}my * ${p}zx * 10000;`,
            `      if (${p}lh > (10000 + ${band}) * ${p}zy * ${p}mx) { ${p}ok = 0 }`,
            `      if (${p}lh < (10000 - ${band}) * ${p}zy * ${p}mx) { ${p}ok = 0 }`,
            `    }`,
            `    if (${p}ok !== 0) {`,
            `      const ${p}tk = Math.sqrt((${p}bk * ${p}my) / ${p}mx);`,
            `      if (${p}tk + ${p}rx > ${targetX}) {`,
            `        const ${p}cx = ${p}tk - ${targetX} + ${p}rx;`,
            `        const ${p}cy = ${p}bk / ${p}cx;`,
            `        ${assign}`,
            `      }`,
            `    }`,
            `  }`,
        ].join('\n');
    },
    /**
     * Ladder rung at cumulative grid point `x`: the shifted-CP output, reported
     * as the LAST-GOOD value once the walk passes capacity (g > reserveOut) — so
     * a capped rung's dOut is 0 and the merge never over-fills obric past what
     * the venue can pay. Monotone nondecreasing; quote(0)=0. Mirrored by
     * referenceLadderQuotes.
     */
    emitLadderQuote(base, slot, _rung, x, outVar) {
        obricConfig(base);
        const p = `s${slot}`;
        return [
            `    if (${p}cap === 0 && ${x} > 0 && ${p}kq !== 0) {`,
            `      ${p}ni = ${p}ci + ${x};`,
            `      ${p}no = ${p}kq / ${p}ni;`,
            `      ${p}gg = 0;`,
            `      if (${p}no < ${p}co) { ${p}gg = ${p}co - ${p}no }`,
            `      if (${p}gg > ${p}ro) { ${p}cap = 1 }`,
            `      else { ${p}lo = ${p}gg - (${p}gg * ${p}fe) / ${FEE_DEN} }`,
            `    }`,
            `    const ${outVar} = ${p}lo;`,
        ].join('\n');
    },
    /** Cold final quote at the elected slice: g(fill)−fee, or 0 past capacity (skip the CPI). */
    emitFinalQuote(base, slot, x, outVar) {
        obricConfig(base);
        const p = `s${slot}`;
        return [
            `  let ${outVar} = 0;`,
            `  if (${x} > 0 && ${p}kq !== 0) {`,
            `    ${p}ni = ${p}ci + ${x};`,
            `    ${p}no = ${p}kq / ${p}ni;`,
            `    ${p}gg = 0;`,
            `    if (${p}no < ${p}co) { ${p}gg = ${p}co - ${p}no }`,
            `    if (${p}gg <= ${p}ro) { ${outVar} = ${p}gg - (${p}gg * ${p}fe) / ${FEE_DEN} }`,
            `  }`,
        ].join('\n');
    },
    buildSwapV2(base, slot, user) {
        const c = obricConfig(base);
        // swap: disc(8) ++ isXToY(bool) ++ input u64 LE (runtime-patched) ++ minOut u64 LE = 1.
        const xToY = c.direction === 'xToY';
        const make = (r, addr, writable) => writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
        return {
            programId: OBRIC_V2_PROGRAM_ID,
            prefix: Uint8Array.from([...OBRIC_SWAP_DISCRIMINATOR, xToY ? 1 : 0]),
            suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
            patch: 'in',
            accounts: swapAccounts(c, user, make, (role) => ref(slot, role)),
        };
    },
    /** The COLD final quote (0 past capacity) — the lamport-exact target for emitFinalQuote. */
    referenceQuote(base, state, params) {
        const cfg = obricConfig(base);
        const { cIn, cOut, kq, rOut, fee } = liveCurve(cfg, state, params);
        return (x) => obricColdQuote(x, cIn, cOut, kq, rOut, fee);
    },
    /** The LAST-GOOD ladder chain — mirrors emitLadderQuote (monotone, flat past capacity). */
    referenceLadderQuotes(base, state, params) {
        const cfg = obricConfig(base);
        const { cIn, cOut, kq, rOut, fee } = liveCurve(cfg, state, params);
        return (grid) => {
            let lo = 0n;
            let capped = false;
            return grid.map((x) => {
                if (!capped && x > 0n && kq !== 0n) {
                    const nOut = kq / (cIn + x);
                    let g = 0n;
                    if (nOut < cOut)
                        g = cOut - nOut;
                    if (g > rOut)
                        capped = true;
                    else
                        lo = g - (g * fee) / FEE_DEN;
                }
                return lo;
            });
        };
    },
    /**
     * Depth = the actual VAULT balances (isqrt(reserveIn·reserveOut)). A drained
     * Obric pool (thin inventory — the prop-AMM reality) reads 0 depth and drops
     * out of the relative-depth filter, exactly as the venue's own "Insufficient
     * active" guard would refuse the fill.
     */
    depthReserves(base, state) {
        const cfg = obricConfig(base);
        const vx = state[cfg.reserveXVault];
        const vy = state[cfg.reserveYVault];
        if (vx === undefined || vy === undefined)
            throw new Error(`${SLUG} depth is missing a reserve vault`);
        const rx = readUintLE(vx, AMOUNT_OFF, 8);
        const ry = readUintLE(vy, AMOUNT_OFF, 8);
        return cfg.direction === 'xToY' ? { reserveIn: rx, reserveOut: ry } : { reserveIn: ry, reserveOut: rx };
    },
    continuousFees(base) {
        // feeMillionth is already parts-per-1e6, charged on the OUTPUT.
        const c = obricConfig(base);
        const feePpm = c.feeMillionth > FEE_DEN ? FEE_DEN : c.feeMillionth;
        return { gammaPpm: FEE_DEN, muPpm: FEE_DEN - feePpm };
    },
};
//# sourceMappingURL=ladder.js.map