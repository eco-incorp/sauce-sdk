/**
 * Stabble CLMM ladder fragment (adapter contract v2) — the in-VM tick walk +
 * swap CPI template. Byte-for-byte the SAME walk math as
 * `@eco-incorp/sauce-sdk/svm`'s raydium-clmm ladder (see ./index.ts's header
 * for the ground-truthed layout/instruction proof); the ONLY venue-bound
 * difference is the CPI `programId` in buildSwapV2 (and, upstream in
 * ./index.ts, the tick-array/bitmap-extension PDA derivations).
 *
 * The three quote helpers (`rcD0`/`rcD1`/`rcNx0`) are emitted under the SAME
 * names and BYTE-IDENTICAL source as raydium-clmm's — the codegen dedupes
 * helper functions by (name, source) across every family in a shape, so a
 * cook mixing this venue with raydium-clmm shares one copy of each instead
 * of paying for two (SvmVenueLadderV2.helpers' contract: same name requires
 * byte-identical source, enforced by the codegen).
 */
import { address } from '@solana/kit';
import { readUintLE } from '../math.js';
import { MAX_SQRT_PRICE_X64, MIN_SQRT_PRICE_X64 } from '../raydium-clmm/tick-math.js';
import { raydiumDelta0, raydiumDelta1, raydiumNextSqrt0, raydiumSqrtPriceAtTick } from '../raydium-clmm/ladder.js';
import { OFF_CFG_TRADE_FEE_RATE, OFF_LIQUIDITY, OFF_SQRT_PRICE, OFF_TA_TICKS, OFF_TICK_CURRENT, OFF_TICK_LIQ_GROSS, OFF_TICK_LIQ_NET, STABBLE_CLMM_MAX_BOUNDARIES, STABBLE_CLMM_PROGRAM_ID, TICK_LEN, windowFor, } from './index.js';
export { raydiumSqrtPriceAtTick, STABBLE_CLMM_MAX_BOUNDARIES };
const SLUG = 'stabble-clmm';
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** sha256('global:swap_v2')[0..8] — verified live against a real Stabble CLMM swap_v2 CPI (see ./index.ts). */
const SWAP_V2_DISCRIMINATOR = [43, 4, 237, 11, 26, 201, 30, 98];
/** Walk loop bound: MAX_BOUNDARIES full steps + the edge step + one partial. */
const WALK_BOUND = STABBLE_CLMM_MAX_BOUNDARIES + 2;
/** cfg words per slot: nb + (meta,hi,lo) per boundary + (tick,hi,lo) edge. */
const PARAM_COUNT = 1 + 3 * STABBLE_CLMM_MAX_BOUNDARIES + 3;
const BIAS = 2147483648n; // 2^31 tick bias
const M32 = 4294967295n;
const S127 = 1n << 127n; // i128 sign bit
const Q128 = 1n << 128n;
const G192 = 1n << 192n;
const U64_MAX = (1n << 64n) - 1n;
const SENT = 1n << 65n;
const FEE_MUL = 1000000n; // FEE_RATE_DENOMINATOR_VALUE
// ---------------------------------------------------------------------------
// Fragment quote helpers — BYTE-IDENTICAL name+source to raydium-clmm's (see
// this file's header): dedup-eligible across families in one shape.
// ---------------------------------------------------------------------------
const HELPERS = [
    {
        name: 'rcD0',
        source: [
            'function rcD0(l, lo, hi, up) {',
            '  if (hi <= lo || l === 0) { return 0 }',
            '  const num = (l << 64) * (hi - lo);',
            '  let inner = num / hi;',
            '  if (up !== 0 && inner * hi < num) { inner = inner + 1 }',
            '  let q = inner / lo;',
            '  if (up !== 0 && q * lo < inner) { q = q + 1 }',
            `  if (q > ${U64_MAX}) { return ${SENT} }`,
            '  return q;',
            '}',
        ].join('\n'),
    },
    {
        name: 'rcD1',
        source: [
            'function rcD1(l, lo, hi, up) {',
            '  if (hi <= lo || l === 0) { return 0 }',
            '  const p = l * (hi - lo);',
            '  let q = p >> 64;',
            `  if (up !== 0 && (p & ${U64_MAX}) !== 0) { q = q + 1 }`,
            `  if (q > ${U64_MAX}) { return ${SENT} }`,
            '  return q;',
            '}',
        ].join('\n'),
    },
    {
        name: 'rcNx0',
        source: [
            'function rcNx0(sp, l, amt) {',
            '  if (amt === 0) { return sp }',
            '  if (l === 0) { return 0 }',
            '  const t = l * sp;',
            `  if (t >= ${G192}) { return 0 }`,
            '  const num = t << 64;',
            '  const den = (l << 64) + amt * sp;',
            '  let q = num / den;',
            '  if (q * den < num) { q = q + 1 }',
            `  if (q < ${MIN_SQRT_PRICE_X64}) { return 0 }`,
            `  if (q > ${MAX_SQRT_PRICE_X64}) { return 0 }`,
            '  return q;',
            '}',
        ].join('\n'),
    },
];
function sbConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
function liveFromState(cfg, state) {
    const pool = state[cfg.pool];
    if (pool === undefined)
        throw new Error(`${SLUG} ladder reference is missing pool ${cfg.pool}`);
    const config = state[cfg.ammConfig];
    if (config === undefined)
        throw new Error(`${SLUG} ladder reference is missing AmmConfig ${cfg.ammConfig}`);
    const fr = readUintLE(config, OFF_CFG_TRADE_FEE_RATE, 4);
    return {
        l: readUintLE(pool, OFF_LIQUIDITY, 16),
        sp: readUintLE(pool, OFF_SQRT_PRICE, 16),
        bt: (readUintLE(pool, OFF_TICK_CURRENT, 4) + BIAS) & M32,
        fr,
        fn: FEE_MUL - fr,
    };
}
function effectiveWindow(cfg, state, live, params) {
    const zeroForOne = cfg.direction === '0to1';
    const window = windowFor(cfg);
    const result = { valid: false, bsp: [], bnt: [] };
    const nb = Number(params[0] ?? 0n);
    for (let k = 0; k < STABBLE_CLMM_MAX_BOUNDARIES && k < nb; k++) {
        const meta = params[1 + 3 * k];
        const btick = meta & M32;
        if (zeroForOne ? btick > live.bt : btick <= live.bt)
            continue;
        const offset = Number((meta >> 32n) & 127n);
        const arrayIndex = Number(meta >> 39n);
        const data = state[window.tickArrays[arrayIndex]];
        if (data === undefined) {
            throw new Error(`${SLUG} ladder reference is missing account ${window.tickArrays[arrayIndex]}`);
        }
        const cell = OFF_TA_TICKS + offset * TICK_LEN;
        if (readUintLE(data, cell + OFF_TICK_LIQ_GROSS, 16) === 0n)
            continue; // removed since prepare
        result.bsp.push((params[2 + 3 * k] << 64n) | params[3 + 3 * k]);
        result.bnt.push(readUintLE(data, cell + OFF_TICK_LIQ_NET, 16));
    }
    const edgeTick = params[1 + 3 * STABBLE_CLMM_MAX_BOUNDARIES] ?? 0n;
    if (edgeTick !== 0n && (zeroForOne ? edgeTick <= live.bt : edgeTick > live.bt)) {
        result.bsp.push((params[2 + 3 * STABBLE_CLMM_MAX_BOUNDARIES] << 64n) | params[3 + 3 * STABBLE_CLMM_MAX_BOUNDARIES]);
        result.bnt.push(0n);
    }
    result.valid = result.bsp.length > 0;
    return result;
}
function walkStep(cursor, win, live, zeroForOne, rm) {
    const nb = win.bsp.length;
    if (cursor.k >= nb) {
        cursor.exhausted = true;
        return rm;
    }
    const tg = win.bsp[cursor.k];
    const ca = (rm * live.fn) / FEE_MUL;
    const fx = zeroForOne ? raydiumDelta0(cursor.l, tg, cursor.sp, true) : raydiumDelta1(cursor.l, cursor.sp, tg, true);
    let nx = tg;
    if (fx > ca)
        nx = zeroForOne ? raydiumNextSqrt0(cursor.sp, cursor.l, ca) : cursor.sp + (ca << 64n) / cursor.l;
    if (nx === 0n) {
        cursor.exhausted = true;
        return rm;
    }
    const ou = zeroForOne ? raydiumDelta1(cursor.l, nx, cursor.sp, false) : raydiumDelta0(cursor.l, cursor.sp, nx, false);
    let i2 = fx;
    if (nx !== tg || fx >= SENT) {
        i2 = zeroForOne ? raydiumDelta0(cursor.l, nx, cursor.sp, true) : raydiumDelta1(cursor.l, cursor.sp, nx, true);
    }
    if (ou >= SENT || i2 >= SENT) {
        cursor.exhausted = true;
        return rm;
    }
    let fe;
    if (nx === tg) {
        fe = (i2 * live.fr + live.fn - 1n) / live.fn;
        if (i2 + fe > rm) {
            cursor.exhausted = true;
            return rm;
        }
    }
    else {
        if (i2 > rm) {
            cursor.exhausted = true;
            return rm;
        }
        fe = rm - i2;
    }
    rm -= i2 + fe;
    cursor.out += ou;
    cursor.sp = nx;
    if (nx === tg) {
        if (cursor.k < nb) {
            const raw = win.bnt[cursor.k];
            const positive = raw < S127;
            if (positive === zeroForOne) {
                const sub = positive ? raw : Q128 - raw;
                if (cursor.l < sub) {
                    cursor.exhausted = true;
                    return rm;
                }
                cursor.l -= sub;
            }
            else {
                const add = positive ? raw : Q128 - raw;
                cursor.l += add;
                if (cursor.l >= Q128) {
                    cursor.exhausted = true;
                    return rm;
                }
            }
        }
        cursor.k += 1;
    }
    return rm;
}
function coldWalk(win, live, zeroForOne, x) {
    if (!win.valid || x === 0n)
        return x === 0n ? 0n : null;
    const cursor = { sp: live.sp, l: live.l, k: 0, exhausted: false, out: 0n };
    let rm = x;
    for (let it = 0; it < WALK_BOUND && rm > 0n && !cursor.exhausted; it++)
        rm = walkStep(cursor, win, live, zeroForOne, rm);
    return cursor.exhausted || rm > 0n ? null : cursor.out;
}
/** Capacity-clamped cold walk: never null — reports (productive input consumed, output). */
function coldWalkClamped(win, live, zeroForOne, x) {
    if (!win.valid || x <= 0n)
        return { out: 0n, cap: 0n };
    const cursor = { sp: live.sp, l: live.l, k: 0, exhausted: false, out: 0n };
    let rm = x;
    for (let it = 0; it < WALK_BOUND && rm > 0n && !cursor.exhausted; it++)
        rm = walkStep(cursor, win, live, zeroForOne, rm);
    return { out: cursor.out, cap: x - rm };
}
const ref = (slot, role) => `s${slot}:${role}`;
function emitWalkStep(p, zeroForOne, v, indent) {
    const dIn = (lo, hi) => `rcD0(${v.l}, ${lo}, ${hi}, 1)`;
    const dInB = (lo, hi) => `rcD1(${v.l}, ${lo}, ${hi}, 1)`;
    const full = zeroForOne ? dIn(`${p}tg`, v.sp) : dInB(v.sp, `${p}tg`);
    const out = zeroForOne ? `rcD1(${v.l}, ${p}nx, ${v.sp}, 0)` : `rcD0(${v.l}, ${v.sp}, ${p}nx, 0)`;
    const outFull = zeroForOne ? `rcD1(${v.l}, ${p}tg, ${v.sp}, 0)` : `rcD0(${v.l}, ${v.sp}, ${p}tg, 0)`;
    const inRe = zeroForOne ? dIn(`${p}nx`, v.sp) : dInB(v.sp, `${p}nx`);
    const next = zeroForOne ? `rcNx0(${v.sp}, ${v.l}, ${p}ca)` : `${v.sp} + ((${p}ca << 64) / ${v.l})`;
    const cross = (indent2) => zeroForOne
        ? [
            `${indent2}${p}nw = ${p}bnt[${v.k}];`,
            `${indent2}if (${p}nw < ${S127}) { if (${v.l} < ${p}nw) { ${v.ex} = 1 } else { ${v.l} = ${v.l} - ${p}nw } }`,
            `${indent2}else { ${v.l} = ${v.l} + ${Q128} - ${p}nw; if (${v.l} >= ${Q128}) { ${v.ex} = 1 } }`,
        ]
        : [
            `${indent2}${p}nw = ${p}bnt[${v.k}];`,
            `${indent2}if (${p}nw < ${S127}) { ${v.l} = ${v.l} + ${p}nw; if (${v.l} >= ${Q128}) { ${v.ex} = 1 } }`,
            `${indent2}else { if (${v.l} < ${Q128} - ${p}nw) { ${v.ex} = 1 } else { ${v.l} = ${v.l} - (${Q128} - ${p}nw) } }`,
        ];
    return [
        `${indent}if (${v.k} >= ${p}nbv) { ${v.ex} = 1 }`,
        `${indent}else {`,
        `${indent}  ${p}tg = ${p}bsp[${v.k}];`,
        `${indent}  ${p}ca = (${v.rm} * ${p}fn) / ${FEE_MUL};`,
        `${indent}  if (${v.k} < ${p}kmx) { ${p}fx = ${p}fxa[${v.k}] }`,
        `${indent}  else { ${p}fx = ${full} }`,
        `${indent}  if (${p}fx <= ${p}ca) {`,
        `${indent}    if (${v.k} < ${p}kmx) {`,
        `${indent}      ${p}fe = ${p}csn[${v.k}];`,
        `${indent}      if (${p}fe > ${v.rm}) { ${v.ex} = 1 }`,
        `${indent}      else {`,
        `${indent}        ${v.rm} = ${v.rm} - ${p}fe;`,
        `${indent}        ${v.out} = ${v.out} + ${p}cot[${v.k}];`,
        `${indent}        ${v.l} = ${p}lps[${v.k}];`,
        `${indent}        ${v.sp} = ${p}tg;`,
        `${indent}        ${v.k} = ${v.k} + 1;`,
        `${indent}      }`,
        `${indent}    } else {`,
        `${indent}      ${p}ou = ${outFull};`,
        `${indent}      ${p}fe = (${p}fx * ${p}fr + ${p}fn - 1) / ${p}fn;`,
        `${indent}      if (${p}ou >= ${SENT} || ${p}fx + ${p}fe > ${v.rm}) { ${v.ex} = 1 }`,
        `${indent}      else {`,
        `${indent}        ${v.rm} = ${v.rm} - ${p}fx - ${p}fe;`,
        `${indent}        ${v.out} = ${v.out} + ${p}ou;`,
        `${indent}        ${v.sp} = ${p}tg;`,
        ...cross(`${indent}        `),
        `${indent}        if (${v.ex} === 0) {`,
        `${indent}          ${p}fxa[${v.k}] = ${p}fx; ${p}csn[${v.k}] = ${p}fx + ${p}fe; ${p}cot[${v.k}] = ${p}ou; ${p}lps[${v.k}] = ${v.l};`,
        `${indent}          ${p}kmx = ${v.k} + 1;`,
        `${indent}          ${v.k} = ${v.k} + 1;`,
        `${indent}        }`,
        `${indent}      }`,
        `${indent}    }`,
        `${indent}  } else {`,
        `${indent}    ${p}nx = ${next};`,
        `${indent}    if (${p}nx === 0) { ${v.ex} = 1 }`,
        `${indent}    else {`,
        `${indent}      ${p}i2 = ${inRe};`,
        `${indent}      ${p}ou = ${out};`,
        `${indent}      if (${p}ou + ${p}i2 >= ${SENT}) { ${v.ex} = 1 }`,
        `${indent}      else {`,
        `${indent}        if (${p}nx === ${p}tg) {`,
        `${indent}          ${p}fe = (${p}i2 * ${p}fr + ${p}fn - 1) / ${p}fn;`,
        `${indent}          if (${p}i2 + ${p}fe > ${v.rm}) { ${v.ex} = 1 }`,
        `${indent}          else {`,
        `${indent}            ${v.rm} = ${v.rm} - ${p}i2 - ${p}fe;`,
        `${indent}            ${v.out} = ${v.out} + ${p}ou;`,
        `${indent}            ${v.sp} = ${p}tg;`,
        ...cross(`${indent}            `),
        `${indent}            if (${v.ex} === 0) { ${v.k} = ${v.k} + 1 }`,
        `${indent}          }`,
        `${indent}        } else {`,
        `${indent}          if (${p}i2 > ${v.rm}) { ${v.ex} = 1 }`,
        `${indent}          else {`,
        `${indent}            ${v.rm} = 0;`,
        `${indent}            ${v.out} = ${v.out} + ${p}ou;`,
        `${indent}            ${v.sp} = ${p}nx;`,
        `${indent}          }`,
        `${indent}        }`,
        `${indent}      }`,
        `${indent}    }`,
        `${indent}  }`,
        `${indent}}`,
    ];
}
/** The per-boundary live verification (unrolled; account refs are compile-time). */
function emitBoundary(p, slot, k, zeroForOne, params) {
    const keep = zeroForOne ? `${p}t2 <= ${p}bt` : `${p}t2 > ${p}bt`;
    const readArm = (a) => [
        `        ${p}t5 = accountUint(${JSON.stringify(ref(slot, `ta${a}`))}, ${OFF_TA_TICKS} + ${p}t3 * ${TICK_LEN} + ${OFF_TICK_LIQ_GROSS}, 16);`,
        `        if (${p}t5 !== 0) { ${p}t6 = accountUint(${JSON.stringify(ref(slot, `ta${a}`))}, ${OFF_TA_TICKS} + ${p}t3 * ${TICK_LEN} + ${OFF_TICK_LIQ_NET}, 16) }`,
    ];
    return [
        `    if (${params[0]} > ${k}) {`,
        `      ${p}t1 = ${params[1 + 3 * k]};`,
        `      ${p}t2 = ${p}t1 & ${M32};`,
        `      if (${keep}) {`,
        `        ${p}t3 = (${p}t1 >> 32) & 127;`,
        `        ${p}t4 = ${p}t1 >> 39;`,
        `        ${p}t5 = 0;`,
        `        ${p}t6 = 0;`,
        `        if (${p}t4 === 0) {`,
        ...readArm(0).map((line) => '  ' + line),
        `        } else { if (${p}t4 === 1) {`,
        ...readArm(1).map((line) => '  ' + line),
        `        } else {`,
        ...readArm(2).map((line) => '  ' + line),
        `        } }`,
        `        if (${p}t5 !== 0) {`,
        `          ${p}bsp[${p}nbv] = (${params[2 + 3 * k]} << 64) | ${params[3 + 3 * k]};`,
        `          ${p}bnt[${p}nbv] = ${p}t6;`,
        `          ${p}nbv = ${p}nbv + 1;`,
        `        }`,
        `      }`,
        `    }`,
    ];
}
export const stabbleClmmLadder = {
    slug: SLUG,
    /** 2 rungs by default — a CLMM rung is a full cold walk, same class as raydium-clmm/whirlpool. */
    defaultRungs: 2,
    shapeKey(base) {
        return `${SLUG}:${sbConfig(base).direction}`;
    },
    helpers() {
        return HELPERS;
    },
    paramCount: PARAM_COUNT,
    paramsFor(base) {
        const window = windowFor(sbConfig(base));
        const words = [BigInt(window.boundaries.length)];
        for (let k = 0; k < STABBLE_CLMM_MAX_BOUNDARIES; k++) {
            const boundary = window.boundaries[k];
            if (boundary === undefined) {
                words.push(0n, 0n, 0n);
                continue;
            }
            words.push((BigInt(boundary.tick) + BIAS) | (BigInt(boundary.offset) << 32n) | (BigInt(boundary.arrayIndex) << 39n), boundary.sqrtPrice >> 64n, boundary.sqrtPrice & U64_MAX);
        }
        if (window.edge === null)
            words.push(0n, 0n, 0n);
        else
            words.push(BigInt(window.edge.tick) + BIAS, window.edge.sqrtPrice >> 64n, window.edge.sqrtPrice & U64_MAX);
        return words;
    },
    quoteRefs(base, slot) {
        const cfg = sbConfig(base);
        const window = windowFor(cfg);
        const referenced = new Set(window.boundaries.map((boundary) => boundary.arrayIndex));
        return [
            { ref: ref(slot, 'pool'), address: cfg.pool },
            { ref: ref(slot, 'cfg'), address: cfg.ammConfig },
            ...window.tickArrays.map((addr, i) => ({
                ref: ref(slot, `ta${i}`),
                address: addr,
                ...(referenced.has(i) ? {} : { optional: true }),
            })),
        ];
    },
    emitSetup(base, slot, params, enableVar) {
        const cfg = sbConfig(base);
        const zeroForOne = cfg.direction === '0to1';
        const p = `s${slot}`;
        const pool = JSON.stringify(ref(slot, 'pool'));
        const config = JSON.stringify(ref(slot, 'cfg'));
        const enabled = enableVar ?? `${p}en`;
        const edgeKeep = zeroForOne ? `${p}t1 <= ${p}bt` : `${p}t1 > ${p}bt`;
        const lines = [
            `  const ${p}l0 = accountUint(${pool}, ${OFF_LIQUIDITY}, 16);`,
            `  const ${p}sp0 = accountUint(${pool}, ${OFF_SQRT_PRICE}, 16);`,
            `  const ${p}bt = (accountUint(${pool}, ${OFF_TICK_CURRENT}, 4) + ${BIAS}) & ${M32};`,
            `  const ${p}fr = accountUint(${config}, ${OFF_CFG_TRADE_FEE_RATE}, 4);`,
            `  const ${p}fn = ${FEE_MUL} - ${p}fr;`,
            `  let ${p}nbv = 0;`,
            `  let ${p}kmx = 0;`,
            `  const ${p}bsp = new Array(${STABBLE_CLMM_MAX_BOUNDARIES + 1});`,
            `  const ${p}bnt = new Array(${STABBLE_CLMM_MAX_BOUNDARIES + 1});`,
            `  const ${p}fxa = new Array(${STABBLE_CLMM_MAX_BOUNDARIES + 1});`,
            `  const ${p}csn = new Array(${STABBLE_CLMM_MAX_BOUNDARIES + 1});`,
            `  const ${p}cot = new Array(${STABBLE_CLMM_MAX_BOUNDARIES + 1});`,
            `  const ${p}lps = new Array(${STABBLE_CLMM_MAX_BOUNDARIES + 1});`,
            `  let ${p}t1 = 0; let ${p}t2 = 0; let ${p}t3 = 0; let ${p}t4 = 0; let ${p}t5 = 0; let ${p}t6 = 0;`,
            `  let ${p}tg = 0; let ${p}ca = 0; let ${p}fx = 0; let ${p}nx = 0; let ${p}ou = 0; let ${p}i2 = 0; let ${p}fe = 0; let ${p}nw = 0;`,
            `  let ${p}wsp = 0; let ${p}wl = 0; let ${p}wk = 0; let ${p}wex = 0; let ${p}wout = 0; let ${p}rm = 0;`,
            `  let ${p}lo = 0; let ${p}lx = 0; let ${p}wcx = 0;`,
            `  if (${enabled} !== 0) {`,
            ...Array.from({ length: STABBLE_CLMM_MAX_BOUNDARIES }, (_, k) => emitBoundary(p, slot, k, zeroForOne, params)).flat(),
            `    ${p}t1 = ${params[1 + 3 * STABBLE_CLMM_MAX_BOUNDARIES]};`,
            `    if (${p}t1 !== 0 && (${edgeKeep})) {`,
            `      ${p}bsp[${p}nbv] = (${params[2 + 3 * STABBLE_CLMM_MAX_BOUNDARIES]} << 64) | ${params[3 + 3 * STABBLE_CLMM_MAX_BOUNDARIES]};`,
            `      ${p}bnt[${p}nbv] = 0;`,
            `      ${p}nbv = ${p}nbv + 1;`,
            `    }`,
            `  }`,
            `  let ${p}vld = 0;`,
            `  if (${p}nbv > 0) { ${p}vld = 1 }`,
        ];
        return lines.join('\n');
    },
    emitLadderQuote(base, slot, rung, x, outVar) {
        const cfg = sbConfig(base);
        const zeroForOne = cfg.direction === '0to1';
        const p = `s${slot}`;
        const v = { sp: `${p}wsp`, l: `${p}wl`, k: `${p}wk`, ex: `${p}wex`, out: `${p}wout`, rm: `${p}rm` };
        return [
            `    if (${p}vld !== 0 && ${p}wcx === 0 && ${x} > 0) {`,
            `      ${p}wsp = ${p}sp0; ${p}wl = ${p}l0; ${p}wk = 0; ${p}wex = 0; ${p}wout = 0;`,
            `      ${p}rm = ${x};`,
            `      for (let ${p}w${rung} = 0; ${p}w${rung} < ${WALK_BOUND} && ${p}rm > 0 && ${p}wex === 0; ${p}w${rung}++) {`,
            ...emitWalkStep(p, zeroForOne, v, '        '),
            `      }`,
            `      if (${p}wex === 0 && ${p}rm === 0) { ${p}lo = ${p}wout; ${p}lx = ${x} }`,
            `      else { ${p}lo = ${p}wout; ${p}lx = ${x} - ${p}rm; ${p}wcx = 1 }`,
            `    }`,
            `    const ${outVar} = ${p}lo;`,
        ].join('\n');
    },
    capacityInputVar(slot) {
        return `s${slot}lx`;
    },
    emitFinalQuote(base, slot, x, outVar) {
        const cfg = sbConfig(base);
        const zeroForOne = cfg.direction === '0to1';
        const p = `s${slot}`;
        const v = { sp: `${p}fsp`, l: `${p}fl`, k: `${p}fk`, ex: `${p}fex`, out: `${p}fo`, rm: `${p}frm` };
        return [
            `  let ${outVar} = 0;`,
            `  if (${p}vld !== 0 && ${x} > 0) {`,
            `    if (${p}lx === ${x}) { ${outVar} = ${p}lo }`,
            `    else {`,
            `      let ${p}fsp = ${p}sp0; let ${p}fl = ${p}l0; let ${p}fk = 0; let ${p}fex = 0; let ${p}fo = 0;`,
            `      let ${p}frm = ${x};`,
            `      for (let ${p}wf = 0; ${p}wf < ${WALK_BOUND} && ${p}frm > 0 && ${p}fex === 0; ${p}wf++) {`,
            ...emitWalkStep(p, zeroForOne, v, '        '),
            `      }`,
            `      if (${p}fex === 0 && ${p}frm === 0) { ${outVar} = ${p}fo }`,
            `    }`,
            `  }`,
        ].join('\n');
    },
    buildSwapV2(base, slot, user) {
        const cfg = sbConfig(base);
        const zeroForOne = cfg.direction === '0to1';
        const window = windowFor(cfg);
        // swap_v2: disc(8) ++ amount u64 LE (runtime-patched) ++
        // other_amount_threshold u64 LE = 1 ++ sqrt_price_limit_x64 u128 LE = 0
        // ++ is_base_input = 1 — same 41-byte layout verified live (./index.ts).
        const suffix = new Uint8Array(8 + 16 + 1);
        suffix[0] = 1; // other_amount_threshold = 1 (terminal outAta delta enforces the real bound)
        suffix[24] = 1; // is_base_input = true
        const inputVault = zeroForOne ? cfg.tokenVault0 : cfg.tokenVault1;
        const outputVault = zeroForOne ? cfg.tokenVault1 : cfg.tokenVault0;
        const inputMint = zeroForOne ? cfg.tokenMint0 : cfg.tokenMint1;
        const outputMint = zeroForOne ? cfg.tokenMint1 : cfg.tokenMint0;
        const roled = (role, addr, writable) => writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
        return {
            programId: STABBLE_CLMM_PROGRAM_ID,
            prefix: Uint8Array.from(SWAP_V2_DISCRIMINATOR),
            suffix,
            patch: 'in',
            accounts: [
                { ref: user.owner, signer: true },
                roled('cfg', cfg.ammConfig),
                roled('pool', cfg.pool, true),
                { ref: user.inAta, writable: true },
                { ref: user.outAta, writable: true },
                roled('iv', inputVault, true),
                roled('ov', outputVault, true),
                roled('obs', cfg.observation, true),
                roled('tp', TOKEN_PROGRAM),
                roled('tp22', TOKEN_2022_PROGRAM),
                roled('memo', MEMO_PROGRAM),
                roled('im', inputMint),
                roled('om', outputMint),
                // remaining accounts: the bitmap extension (first) then the walk arrays.
                roled('bmx', cfg.bitmapExtension),
                roled('ta0', window.tickArrays[0], true),
                roled('ta1', window.tickArrays[1], true),
                roled('ta2', window.tickArrays[2], true),
            ],
        };
    },
    referenceQuote(base, state, params) {
        const cfg = sbConfig(base);
        const zeroForOne = cfg.direction === '0to1';
        const live = liveFromState(cfg, state);
        const win = effectiveWindow(cfg, state, live, params);
        return (x) => coldWalk(win, live, zeroForOne, x) ?? 0n;
    },
    referenceLadderQuotes(base, state, params) {
        const cfg = sbConfig(base);
        const zeroForOne = cfg.direction === '0to1';
        const live = liveFromState(cfg, state);
        const win = effectiveWindow(cfg, state, live, params);
        return (grid) => {
            let lo = 0n;
            let capped = false;
            return grid.map((g) => {
                if (win.valid && !capped && g > 0n) {
                    const { out, cap } = coldWalkClamped(win, live, zeroForOne, g);
                    lo = out;
                    if (cap < g)
                        capped = true;
                }
                return lo;
            });
        };
    },
    referenceCapacities(base, state, params) {
        const cfg = sbConfig(base);
        const zeroForOne = cfg.direction === '0to1';
        const live = liveFromState(cfg, state);
        const win = effectiveWindow(cfg, state, live, params);
        return (grid) => {
            let cap = 0n;
            let capped = false;
            return grid.map((g) => {
                if (win.valid && !capped && g > 0n) {
                    const clamped = coldWalkClamped(win, live, zeroForOne, g);
                    cap = clamped.cap;
                    if (clamped.cap < g)
                        capped = true;
                }
                return cap;
            });
        };
    },
    depthReserves(base, state) {
        const cfg = sbConfig(base);
        const live = liveFromState(cfg, state);
        if (live.sp === 0n)
            return { reserveIn: 0n, reserveOut: 0n };
        const a = (live.l << 64n) / live.sp;
        const b = (live.l * live.sp) >> 64n;
        return cfg.direction === '0to1' ? { reserveIn: a, reserveOut: b } : { reserveIn: b, reserveOut: a };
    },
    continuousFees(base, state) {
        const cfg = sbConfig(base);
        const live = liveFromState(cfg, state);
        return { gammaPpm: FEE_MUL - live.fr, muPpm: FEE_MUL };
    },
};
//# sourceMappingURL=ladder.js.map