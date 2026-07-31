import { readUintLE } from '../math.js';
import { EXPIRY_SCALE, QUANTUM_KIND_TRAPEZOID, QUANTUM_MAX_LEVELS, QUANTUM_PROGRAM_ID, SIDE_EXPIRY, SIDE_KINDS, SIDE_LEVELS, SIDE_LEVEL_STRIDE, quantumInVault, quantumOutReserveOffset, quantumOutScale, quantumOutVault, quantumSideBase, quantumWindowFor, } from './index.js';
const SLUG = 'quantum';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** The program's single global config account (one for every pool). */
export const QUANTUM_GLOBAL = '3JumrbigQRj9TqEuy5fKGPHsQ6zCTwqqfVGhFhyoEMqH';
const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
const INSTRUCTIONS_SYSVAR = 'Sysvar1nstructions1111111111111111111111111';
/** Swap instruction tag (single leading byte), then amountIn u64, minOut u64, direction u8. */
const SWAP_INSTRUCTION = 7;
/** SPL token account `amount` u64 LE offset. */
const AMOUNT_OFF = 64;
/** Walk loop bound: every shipped level plus one partial step. */
const WALK_BOUND = QUANTUM_MAX_LEVELS + 1;
/** cfg words per slot: [shipped level count, 2 * 10^outDecimals]. */
const PARAM_COUNT = 2;
function quantumConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
const ref = (slot, role) => `s${slot}:${role}`;
// ---------------------------------------------------------------------------
// Helpers (fragment source and TS mirror are ONE algorithm — change together).
// ---------------------------------------------------------------------------
const HELPERS = [
    {
        // Input required to take `m` output from a level whose price ramps
        // linearly from pp (at m=0) to pc (at m=c). The INNER floor is the
        // venue's own (.text 0x2168) — not an approximation of a smooth integral.
        name: 'qtCost',
        source: [
            'function qtCost(m, pp, pc, c, s2) {',
            '  if (m === 0 || c === 0) { return 0 }',
            '  return (2 * pp + (pc - pp) * m / c) * m / s2;',
            '}',
        ].join('\n'),
    },
    {
        // max{ m in [0, c] : qtCost(m, ...) <= rem }, by binary-digit descent.
        // cost(m) <= rem  <=>  (2*pp + floor((pc-pp)*m/c)) * m <= s2*(rem+1) - 1.
        name: 'qtFill',
        source: [
            'function qtFill(rem, pp, pc, c, s2) {',
            '  if (c === 0 || pp === 0) { return 0 }',
            '  const k = s2 * (rem + 1) - 1;',
            '  let hi = k / (2 * pp);',
            '  if (hi > c) { hi = c }',
            '  let m = 0;',
            '  let pw = 9223372036854775808;',
            '  for (let i = 0; i < 64; i = i + 1) {',
            '    const t = m + pw;',
            '    if (t <= hi && (2 * pp + (pc - pp) * t / c) * t <= k) { m = t }',
            '    pw = pw / 2;',
            '  }',
            '  return m;',
            '}',
        ].join('\n'),
    },
];
/** TS mirror of qtCost. */
export function quantumCost(m, pp, pc, c, s2) {
    if (m === 0n || c === 0n)
        return 0n;
    return ((2n * pp + ((pc - pp) * m) / c) * m) / s2;
}
/** TS mirror of qtFill (the exact 64-step binary-digit descent). */
export function quantumFill(rem, pp, pc, c, s2) {
    if (c === 0n || pp === 0n)
        return 0n;
    const k = s2 * (rem + 1n) - 1n;
    let hi = k / (2n * pp);
    if (hi > c)
        hi = c;
    let m = 0n;
    let pw = 1n << 63n;
    for (let i = 0; i < 64; i++) {
        const t = m + pw;
        if (t <= hi && (2n * pp + ((pc - pp) * t) / c) * t <= k)
            m = t;
        pw >>= 1n;
    }
    return m;
}
/**
 * Live setup: re-derive the walkable prefix (price != 0, non-decreasing,
 * kind == 1) over the shipped level count, keep only the UNEXPIRED levels, and
 * precompute each one's full-level input `need`. `prev` is the price of the
 * ORIGINAL predecessor index (0xfd0) — expired-or-not, which is why the
 * prefix scan and the live filter are separate steps.
 */
function liveLevels(pool, side, shipped, s2, slot) {
    const out = [];
    let prevPrice = 0n;
    for (let i = 0; i < shipped && i < QUANTUM_MAX_LEVELS; i++) {
        const base = side + SIDE_LEVELS + i * SIDE_LEVEL_STRIDE;
        const price = readUintLE(pool, base, 8);
        const cum = readUintLE(pool, base + 8, 8);
        const expiry = readUintLE(pool, side + SIDE_EXPIRY + i * 8, 8);
        const kind = pool[side + SIDE_KINDS + i];
        if (price === 0n || kind !== QUANTUM_KIND_TRAPEZOID)
            break;
        if (i > 0 && price < prevPrice)
            break;
        const prev = i === 0 ? price : prevPrice;
        prevPrice = price;
        if (expiry / EXPIRY_SCALE < slot)
            continue; // expired level: skipped, not fatal
        out.push({ price, cum, prev, need: quantumCost(cum, prev, price, cum, s2) });
    }
    return out;
}
function outCapOf(cfg, state) {
    const pool = state[cfg.pool];
    if (pool === undefined)
        throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
    const cached = readUintLE(pool, quantumOutReserveOffset(cfg), 8);
    const vaultData = state[quantumOutVault(cfg)];
    if (vaultData === undefined)
        return cached;
    const vault = readUintLE(vaultData, AMOUNT_OFF, 8);
    return vault < cached ? vault : cached;
}
/**
 * The cold walk (fragment twin). Returns the saturating output and the
 * PRODUCTIVE gross input: `consumed === x` while the ladder and the output
 * vault absorb x, and `consumed < x` once either caps.
 */
function coldWalk(levels, capOut, s2, x) {
    if (x <= 0n || levels.length === 0)
        return { out: 0n, consumed: 0n };
    let rem = x;
    let out = 0n;
    for (let k = 0; k < levels.length && rem > 0n; k++) {
        const L = levels[k];
        const room = capOut > out ? capOut - out : 0n;
        if (room === 0n)
            break; // output vault drained — nothing more is landable
        if (room >= L.cum) {
            if (rem >= L.need) {
                out += L.cum;
                rem -= L.need;
                continue;
            }
            // input-limited partial: the venue consumes the whole remaining input
            // (it keeps whatever dust the fill did not pay for).
            out += quantumFill(rem, L.prev, L.price, L.cum, s2);
            return { out, consumed: x };
        }
        // RESERVE-LIMITED. The venue does NOT clamp its own fill — it computes the
        // full ladder output and reverts when it exceeds the vault. So the most
        // input this slot can take is the largest rem whose fill stays <= room:
        // cost(room + 1) - 1 (any m >= room+1 costs at least cost(room+1) > rem).
        // Booking cost(room) instead would be ONE WEI too much: that budget buys
        // room + delta and the venue aborts the whole cook.
        const bound = quantumCost(room + 1n, L.prev, L.price, L.cum, s2);
        if (bound === 0n)
            break; // degenerate: even zero input would overshoot
        const lim = bound - 1n;
        const budget = rem > lim ? lim : rem;
        out += quantumFill(budget, L.prev, L.price, L.cum, s2);
        return { out, consumed: x - (rem - budget) };
    }
    return { out, consumed: x - rem };
}
function effective(cfg, state, params, slot) {
    const pool = state[cfg.pool];
    if (pool === undefined)
        throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
    const shipped = Number(params[0] ?? 0n);
    const s2 = params[1] ?? 2n * quantumOutScale(cfg);
    return {
        levels: liveLevels(pool, quantumSideBase(cfg.direction), shipped, s2, slot),
        capOut: outCapOf(cfg, state),
        s2,
    };
}
// ---------------------------------------------------------------------------
// Fragment emission.
// ---------------------------------------------------------------------------
/** One emitted walk over grid point `xExpr` into the slot cursors. */
function emitWalk(p, xExpr, outVar, tag, indent, decl) {
    return [
        `${indent}${decl} ${outVar} = 0;`,
        `${indent}if (${p}n > 0 && ${xExpr} > 0) {`,
        `${indent}  ${p}rm = ${xExpr}; ${p}o = 0; ${p}k = 0; ${p}dn = 0;`,
        `${indent}  for (let ${p}w${tag} = 0; ${p}w${tag} < ${WALK_BOUND} && ${p}rm > 0 && ${p}k < ${p}n && ${p}dn === 0; ${p}w${tag} = ${p}w${tag} + 1) {`,
        `${indent}    ${p}rr = 0;`,
        `${indent}    if (${p}cap > ${p}o) { ${p}rr = ${p}cap - ${p}o }`,
        `${indent}    if (${p}rr === 0) { ${p}dn = 1 }`,
        `${indent}    else if (${p}rr >= ${p}cm[${p}k]) {`,
        `${indent}      if (${p}rm >= ${p}q[${p}k]) { ${p}o = ${p}o + ${p}cm[${p}k]; ${p}rm = ${p}rm - ${p}q[${p}k]; ${p}k = ${p}k + 1 }`,
        `${indent}      else {`,
        // input-limited: the venue consumes the whole remaining input.
        `${indent}        ${p}o = ${p}o + qtFill(${p}rm, ${p}pv[${p}k], ${p}pr[${p}k], ${p}cm[${p}k], ${p}s2);`,
        `${indent}        ${p}rm = 0; ${p}dn = 1;`,
        `${indent}      }`,
        `${indent}    } else {`,
        // RESERVE-LIMITED. The venue does not clamp its own fill; it reverts when
        // the ladder output exceeds the vault. The largest input whose fill stays
        // <= room is cost(room + 1) - 1. Booking cost(room) would be ONE WEI too
        // much and the venue would abort the whole cook.
        `${indent}      ${p}nd = qtCost(${p}rr + 1, ${p}pv[${p}k], ${p}pr[${p}k], ${p}cm[${p}k], ${p}s2);`,
        `${indent}      if (${p}nd === 0) { ${p}dn = 1 }`,
        `${indent}      else {`,
        `${indent}        ${p}ec = ${p}nd - 1;`,
        `${indent}        if (${p}ec > ${p}rm) { ${p}ec = ${p}rm }`,
        `${indent}        ${p}o = ${p}o + qtFill(${p}ec, ${p}pv[${p}k], ${p}pr[${p}k], ${p}cm[${p}k], ${p}s2);`,
        `${indent}        ${p}rm = ${p}rm - ${p}ec; ${p}dn = 1;`,
        `${indent}      }`,
        `${indent}    }`,
        `${indent}  }`,
        `${indent}  ${outVar} = ${p}o;`,
        `${indent}  ${p}lo = ${p}o; ${p}lx = ${xExpr} - ${p}rm;`,
        `${indent}}`,
    ];
}
export const quantumLadder = {
    slug: SLUG,
    /**
     * 2 rungs. The setup is a bounded 16-level live read and each rung's walk
     * carries one 64-step partial inversion, so a quantum slot is a
     * degrade-first family like manifest/whirlpool (see
     * recipes/ecoswap/svm/budget.ts). The walk is exact at every point, so a
     * coarser rung grid costs split quantization, never correctness.
     */
    defaultRungs: 2,
    shapeKey(base) {
        // Direction fixes the side-struct base, the out-reserve offset and the
        // swap account order; the level count and 10^outDec ride the params.
        return `${SLUG}:${quantumConfig(base).direction}`;
    },
    helpers() {
        return HELPERS;
    },
    paramCount: PARAM_COUNT,
    paramsFor(base) {
        const cfg = quantumConfig(base);
        return [BigInt(quantumWindowFor(cfg).levels.length), 2n * quantumOutScale(cfg)];
    },
    quoteRefs(base, slot) {
        const cfg = quantumConfig(base);
        return [
            { ref: ref(slot, 'pool'), address: cfg.pool },
            { ref: ref(slot, 'ovault'), address: quantumOutVault(cfg) },
            { ref: ref(slot, 'ivault'), address: quantumInVault(cfg) },
        ];
    },
    emitSetup(base, slot, params, enableVar) {
        const cfg = quantumConfig(base);
        const side = quantumSideBase(cfg.direction);
        const p = `s${slot}`;
        const enabled = enableVar ?? `${p}en`;
        const pool = JSON.stringify(ref(slot, 'pool'));
        const ovault = JSON.stringify(ref(slot, 'ovault'));
        const N = QUANTUM_MAX_LEVELS;
        return [
            `  const ${p}pr = new Array(${N});`,
            `  const ${p}cm = new Array(${N});`,
            `  const ${p}pv = new Array(${N});`,
            `  const ${p}q = new Array(${N});`,
            `  let ${p}n = 0;`,
            `  const ${p}s2 = ${params[1]};`,
            `  let ${p}cap = 0;`,
            // walk cursors (main scope — shared by every rung and the cold quote)
            `  let ${p}rm = 0; let ${p}o = 0; let ${p}k = 0; let ${p}dn = 0;`,
            `  let ${p}rr = 0; let ${p}ec = 0; let ${p}nd = 0; let ${p}m = 0;`,
            `  let ${p}lo = 0; let ${p}lx = 0;`,
            `  if (${enabled} !== 0) {`,
            `    let ${p}pl = 0; let ${p}st = 0;`,
            `    let ${p}lp = 0; let ${p}lc = 0; let ${p}lx2 = 0; let ${p}lk = 0; let ${p}pvv = 0;`,
            `    for (let ${p}i = 0; ${p}i < ${N} && ${p}i < ${params[0]} && ${p}st === 0; ${p}i = ${p}i + 1) {`,
            `      ${p}lp = accountUint(${pool}, ${side + SIDE_LEVELS} + ${p}i * ${SIDE_LEVEL_STRIDE}, 8);`,
            `      ${p}lc = accountUint(${pool}, ${side + SIDE_LEVELS + 8} + ${p}i * ${SIDE_LEVEL_STRIDE}, 8);`,
            `      ${p}lx2 = accountUint(${pool}, ${side + SIDE_EXPIRY} + ${p}i * 8, 8);`,
            `      ${p}lk = accountUint(${pool}, ${side + SIDE_KINDS} + ${p}i, 1);`,
            // the venue's own walkability gates, re-derived LIVE
            `      if (${p}lp === 0 || ${p}lk !== ${QUANTUM_KIND_TRAPEZOID}) { ${p}st = 1 }`,
            `      else if (${p}i > 0 && ${p}lp < ${p}pl) { ${p}st = 1 }`,
            `      else {`,
            `        ${p}pvv = ${p}pl;`,
            `        if (${p}i === 0) { ${p}pvv = ${p}lp }`,
            `        ${p}pl = ${p}lp;`,
            `        if (${p}lx2 / ${EXPIRY_SCALE} >= block.number) {`,
            `          ${p}pr[${p}n] = ${p}lp; ${p}cm[${p}n] = ${p}lc; ${p}pv[${p}n] = ${p}pvv;`,
            `          ${p}q[${p}n] = qtCost(${p}lc, ${p}pvv, ${p}lp, ${p}lc, ${p}s2);`,
            `          ${p}n = ${p}n + 1;`,
            `        }`,
            `      }`,
            `    }`,
            // out cap = min(cached reserve, live output-vault balance)
            `    ${p}cap = accountUint(${pool}, ${quantumOutReserveOffset(cfg)}, 8);`,
            `    ${p}ec = accountUint(${ovault}, ${AMOUNT_OFF}, 8);`,
            `    if (${p}ec < ${p}cap) { ${p}cap = ${p}ec }`,
            `    ${p}ec = 0;`,
            `  }`,
        ].join('\n');
    },
    emitLadderQuote(base, slot, rung, x, outVar) {
        quantumConfig(base);
        return emitWalk(`s${slot}`, x, outVar, `${rung}`, '    ', 'const').join('\n');
    },
    emitFinalQuote(base, slot, x, outVar) {
        quantumConfig(base);
        const p = `s${slot}`;
        // Reuse the last rung when it landed on exactly this x (the common case:
        // the merge's final slice equals a grid point it already walked).
        return [
            `    let ${outVar} = 0;`,
            `    if (${p}lx === ${x} && ${x} > 0) { ${outVar} = ${p}lo }`,
            `    else {`,
            ...emitWalk(p, x, `${p}cq`, 'f', '      ', 'let'),
            `      ${outVar} = ${p}cq;`,
            `    }`,
        ].join('\n');
    },
    capacityInputVar(slot) {
        return `s${slot}lx`;
    },
    buildSwapV2(base, slot, user) {
        const cfg = quantumConfig(base);
        const zeroIn = cfg.direction === 'zeroIn';
        const prefix = new Uint8Array([SWAP_INSTRUCTION]);
        // suffix: minOut u64 LE = 1 (the recipe's terminal outAta delta check is
        // the real bound) then the direction byte.
        const suffix = new Uint8Array(9);
        suffix[0] = 1;
        suffix[8] = zeroIn ? 0 : 1;
        // Account order is by TOKEN INDEX, not by in/out: [token0 ata, token1 ata].
        const token0Ata = zeroIn ? user.inAta : user.outAta;
        const token1Ata = zeroIn ? user.outAta : user.inAta;
        return {
            programId: QUANTUM_PROGRAM_ID,
            prefix,
            suffix,
            patch: 'in',
            accounts: [
                { ref: user.owner, signer: true },
                { ref: token0Ata, writable: true },
                { ref: token1Ata, writable: true },
                { ref: ref(slot, 'pool'), address: cfg.pool, writable: true },
                { ref: ref(slot, 'v0'), address: cfg.vault0, writable: true },
                { ref: ref(slot, 'v1'), address: cfg.vault1, writable: true },
                { ref: ref(slot, 'global'), address: QUANTUM_GLOBAL },
                { ref: ref(slot, 'tokprog'), address: TOKEN_PROGRAM },
                { ref: ref(slot, 'clock'), address: CLOCK_SYSVAR },
                { ref: ref(slot, 'ixsys'), address: INSTRUCTIONS_SYSVAR },
            ],
        };
    },
    referenceQuote(base, state, params, now) {
        const cfg = quantumConfig(base);
        const slot = now ?? 0n;
        const { levels, capOut, s2 } = effective(cfg, state, params, slot);
        return (x) => coldWalk(levels, capOut, s2, x).out;
    },
    referenceLadderQuotes(base, state, params, now) {
        const cfg = quantumConfig(base);
        const { levels, capOut, s2 } = effective(cfg, state, params, now ?? 0n);
        // Pointwise: the walk carries no state between rungs (every rung restarts
        // from the setup locals), exactly like the emitted fragment.
        return (grid) => grid.map((x) => coldWalk(levels, capOut, s2, x).out);
    },
    referenceCapacities(base, state, params, now) {
        const cfg = quantumConfig(base);
        const { levels, capOut, s2 } = effective(cfg, state, params, now ?? 0n);
        return (grid) => grid.map((x) => coldWalk(levels, capOut, s2, x).consumed);
    },
    depthReserves(base, state) {
        const cfg = quantumConfig(base);
        const inData = state[quantumInVault(cfg)];
        const reserveIn = inData === undefined ? 0n : readUintLE(inData, AMOUNT_OFF, 8);
        return { reserveIn, reserveOut: outCapOf(cfg, state) };
    },
    /**
     * A level ladder has no proportional fee: the maker's spread is priced INTO
     * each level's price, so the CP-form continuous oracle has no honest gamma
     * to report. Both are identity — measurement only, never a gate (types.ts).
     */
    continuousFees() {
        return { gammaPpm: 1000000n, muPpm: 1000000n };
    },
};
//# sourceMappingURL=ladder.js.map