import { readUintLE } from '../math.js';
import { OFF_FEE_RATE, OFF_LIQUIDITY, OFF_SQRT_PRICE, OFF_TA_TICKS, OFF_TICK_CURRENT, ORCA_WHIRLPOOL_PROGRAM_ID, TICK_LEN, WHIRLPOOL_MAX_BOUNDARIES, windowFor, } from './index.js';
import { MAX_SQRT_PRICE, MIN_SQRT_PRICE, whirlpoolSqrtPriceAtTick } from './tick-math.js';
export { whirlpoolSqrtPriceAtTick, WHIRLPOOL_MAX_BOUNDARIES };
const SLUG = 'orca-whirlpool';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** sha256('global:swap')[0..8] — the v1 exact-in/out swap instruction. */
const SWAP_DISCRIMINATOR = [248, 198, 158, 145, 225, 117, 135, 200];
/** Walk loop bound: MAX_BOUNDARIES full steps + the edge step + one partial. */
const WALK_BOUND = WHIRLPOOL_MAX_BOUNDARIES + 2;
/** cfg words per slot: nb + (meta,hi,lo) per boundary + (tick,hi,lo) edge. */
const PARAM_COUNT = 1 + 3 * WHIRLPOOL_MAX_BOUNDARIES + 3;
// Shared numeric constants (fragment literals == mirror bigints).
const BIAS = 2147483648n; // 2^31 tick bias
const M32 = 4294967295n;
const S127 = 1n << 127n; // i128 sign bit
const Q128 = 1n << 128n;
const G192 = 1n << 192n; // the venue's U256 shift-word-left overflow bound
const U64_MAX = (1n << 64n) - 1n;
/** "Exceeds u64" sentinel: 2^65 — above any valid amount, below any wrap hazard. */
const SENT = 1n << 65n;
const FEE_MUL = 1000000n;
// ---------------------------------------------------------------------------
// Delta / next-price helpers (token_math.rs, bit_math.rs). SENT (2^65) means
// "the venue would refuse this amount" — callers treat >= SENT per call site.
// ---------------------------------------------------------------------------
const HELPERS = [
    {
        name: 'wpDA',
        // get_amount_delta_a: (l*ds << 64) / (hi*lo), remainder-round-up. The
        // l*ds >= 2^192 case is the venue's U256 shift overflow (abort class) and
        // the q > u64::MAX case its TokenMaxExceeded — both surface as SENT.
        source: [
            'function wpDA(l, lo, hi, up) {',
            '  if (hi <= lo || l === 0) { return 0 }',
            '  const t = l * (hi - lo);',
            `  if (t >= ${G192}) { return ${SENT} }`,
            '  const num = t << 64;',
            '  const den = hi * lo;',
            '  let q = num / den;',
            '  if (up !== 0 && q * den < num) { q = q + 1 }',
            `  if (q > ${U64_MAX}) { return ${SENT} }`,
            '  return q;',
            '}',
        ].join('\n'),
    },
    {
        name: 'wpDB',
        // get_amount_delta_b: (l*ds) >> 64, low-64-remainder round-up; the u128
        // product overflow and the round-at-u64::MAX case both surface as SENT.
        source: [
            'function wpDB(l, lo, hi, up) {',
            '  if (hi <= lo || l === 0) { return 0 }',
            '  const p = l * (hi - lo);',
            `  if (p >= ${Q128}) { return ${SENT} }`,
            '  let q = p >> 64;',
            `  if (up !== 0 && (p & ${U64_MAX}) !== 0) { q = q + 1 }`,
            `  if (q > ${U64_MAX}) { return ${SENT} }`,
            '  return q;',
            '}',
        ].join('\n'),
    },
    {
        name: 'wpNxA',
        // get_next_sqrt_price_from_a_round_up: ceil((l*sp << 64) / ((l << 64) +
        // amt*sp)); 0 = the venue's abort class (U256 shift overflow, price out
        // of the global sqrt bounds) — 0 is impossible for a real sqrt price.
        source: [
            'function wpNxA(sp, l, amt) {',
            '  if (amt === 0) { return sp }',
            '  if (l === 0) { return 0 }',
            '  const t = l * sp;',
            `  if (t >= ${G192}) { return 0 }`,
            '  const num = t << 64;',
            '  const den = (l << 64) + amt * sp;',
            '  let q = num / den;',
            '  if (q * den < num) { q = q + 1 }',
            `  if (q < ${MIN_SQRT_PRICE}) { return 0 }`,
            `  if (q > ${MAX_SQRT_PRICE}) { return 0 }`,
            '  return q;',
            '}',
        ].join('\n'),
    },
];
/** TS mirror of wpDA. */
export function whirlpoolDeltaA(l, lo, hi, roundUp) {
    if (hi <= lo || l === 0n)
        return 0n;
    const t = l * (hi - lo);
    if (t >= G192)
        return SENT;
    const num = t << 64n;
    const den = hi * lo;
    let q = num / den;
    if (roundUp && q * den < num)
        q += 1n;
    return q > U64_MAX ? SENT : q;
}
/** TS mirror of wpDB. */
export function whirlpoolDeltaB(l, lo, hi, roundUp) {
    if (hi <= lo || l === 0n)
        return 0n;
    const p = l * (hi - lo);
    if (p >= Q128)
        return SENT;
    let q = p >> 64n;
    if (roundUp && (p & U64_MAX) !== 0n)
        q += 1n;
    return q > U64_MAX ? SENT : q;
}
/** TS mirror of wpNxA. */
export function whirlpoolNextSqrtA(sp, l, amt) {
    if (amt === 0n)
        return sp;
    if (l === 0n)
        return 0n;
    const t = l * sp;
    if (t >= G192)
        return 0n;
    const num = t << 64n;
    const den = (l << 64n) + amt * sp;
    let q = num / den;
    if (q * den < num)
        q += 1n;
    if (q < MIN_SQRT_PRICE || q > MAX_SQRT_PRICE)
        return 0n;
    return q;
}
function whirlConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
function liveFromState(cfg, state) {
    const pool = state[cfg.pool];
    if (pool === undefined)
        throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
    const fr = readUintLE(pool, OFF_FEE_RATE, 2);
    return {
        l: readUintLE(pool, OFF_LIQUIDITY, 16),
        sp: readUintLE(pool, OFF_SQRT_PRICE, 16),
        bt: (readUintLE(pool, OFF_TICK_CURRENT, 4) + BIAS) & M32,
        fr,
        fn: FEE_MUL - fr,
    };
}
/**
 * The setup's live verification over the SHIPPED params: drop boundaries
 * behind the live tick (aToB keeps tick <= live — the venue's inclusive
 * down-search; bToA keeps tick > live), drop flag-0 boundaries (removed
 * positions), read each survivor's raw net, admit the edge if still ahead.
 * Transcribed by emitSetup.
 */
function effectiveWindow(cfg, state, live, params) {
    const aToB = cfg.direction === 'aToB';
    const window = windowFor(cfg);
    const result = { valid: false, bsp: [], bnt: [] };
    const nb = Number(params[0] ?? 0n);
    for (let k = 0; k < WHIRLPOOL_MAX_BOUNDARIES && k < nb; k++) {
        const meta = params[1 + 3 * k];
        const btick = meta & M32;
        if (aToB ? btick > live.bt : btick <= live.bt)
            continue; // behind the live tick
        const offset = Number((meta >> 32n) & 127n);
        const arrayIndex = Number(meta >> 39n);
        const data = state[window.tickArrays[arrayIndex]];
        if (data === undefined) {
            throw new Error(`${SLUG} ladder reference is missing account ${window.tickArrays[arrayIndex]}`);
        }
        const cell = OFF_TA_TICKS + offset * TICK_LEN;
        if (data[cell] !== 1)
            continue; // removed since prepare — the venue skips it too
        result.bsp.push((params[2 + 3 * k] << 64n) | params[3 + 3 * k]);
        result.bnt.push(readUintLE(data, cell + 1, 16));
    }
    const edgeTick = params[1 + 3 * WHIRLPOOL_MAX_BOUNDARIES] ?? 0n;
    if (edgeTick !== 0n && (aToB ? edgeTick <= live.bt : edgeTick > live.bt)) {
        result.bsp.push((params[2 + 3 * WHIRLPOOL_MAX_BOUNDARIES] << 64n) | params[3 + 3 * WHIRLPOOL_MAX_BOUNDARIES]);
        result.bnt.push(0n); // no-op cross
    }
    result.valid = result.bsp.length > 0;
    return result;
}
/**
 * One compute_swap step toward the cursor's next target, consuming from
 * `rm`. Returns the remaining amount; flags the cursor exhausted on any
 * venue-abort-class event or when the window has nothing left. Transcribed
 * by the emitted walk block — same branch order, same integer ops.
 */
function walkStep(cursor, win, live, aToB, rm) {
    const nb = win.bsp.length;
    if (cursor.k >= nb) {
        cursor.exhausted = true;
        return rm;
    }
    const tg = win.bsp[cursor.k];
    const ca = (rm * live.fn) / FEE_MUL;
    const fx = aToB ? whirlpoolDeltaA(cursor.l, tg, cursor.sp, true) : whirlpoolDeltaB(cursor.l, cursor.sp, tg, true);
    let nx = tg;
    if (fx > ca)
        nx = aToB ? whirlpoolNextSqrtA(cursor.sp, cursor.l, ca) : cursor.sp + (ca << 64n) / cursor.l;
    if (nx === 0n) {
        cursor.exhausted = true;
        return rm;
    }
    const ou = aToB ? whirlpoolDeltaB(cursor.l, nx, cursor.sp, false) : whirlpoolDeltaA(cursor.l, cursor.sp, nx, false);
    let i2 = fx;
    if (nx !== tg || fx >= SENT) {
        i2 = aToB ? whirlpoolDeltaA(cursor.l, nx, cursor.sp, true) : whirlpoolDeltaB(cursor.l, cursor.sp, nx, true);
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
            if (positive === aToB) {
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
/** Cold walk (the venue's own from-scratch loop); null when x exceeds window capacity. */
function coldWalk(win, live, aToB, x) {
    if (!win.valid || x === 0n)
        return x === 0n ? 0n : null;
    const cursor = { sp: live.sp, l: live.l, k: 0, exhausted: false, out: 0n };
    let rm = x;
    for (let it = 0; it < WALK_BOUND && rm > 0n && !cursor.exhausted; it++)
        rm = walkStep(cursor, win, live, aToB, rm);
    return cursor.exhausted || rm > 0n ? null : cursor.out;
}
/**
 * Capacity-clamped cold walk: the same loop, but never null — it reports the
 * PRODUCTIVE gross input actually consumed (`cap = x − remaining`) and the
 * output at that point. cap === x for a fully-absorbed x; cap < x once the
 * walk exhausts the shipped window (the venue's real depth for this trade).
 * The lamport twin of the emitted rung's `lx`/`lo` capped booking.
 */
function coldWalkClamped(win, live, aToB, x) {
    if (!win.valid || x <= 0n)
        return { out: 0n, cap: 0n };
    const cursor = { sp: live.sp, l: live.l, k: 0, exhausted: false, out: 0n };
    let rm = x;
    for (let it = 0; it < WALK_BOUND && rm > 0n && !cursor.exhausted; it++)
        rm = walkStep(cursor, win, live, aToB, rm);
    return { out: cursor.out, cap: x - rm };
}
// ---------------------------------------------------------------------------
// Fragment emission. Slot-local names are s<i>-prefixed short codes; the
// reserved codegen surface (s<i>en, s<i>p<k>, s<i>g<j>, s<i>o<j>, amountIn,
// minOut) is untouched.
// ---------------------------------------------------------------------------
const ref = (slot, role) => `s${slot}:${role}`;
/**
 * One emitted compute_swap step (the fragment twin of walkStep), operating on
 * the given cursor variable names. `indent` is the enclosing block prefix.
 *
 * The FULL-STEP branch is memoized across walks: a boundary's fixed input,
 * consumed gross (input + ceil fee), output and post-cross liquidity depend
 * only on the segment — every walk (all rungs and the final quote start from
 * the live spot) traverses the identical segment path, so the first walk to
 * cross boundary k stores (fxa, csn, cot, lps)[k] and later walks replay
 * them by INDEX. Value-transparent: a memo hit equals recomputation
 * bit-for-bit, so the plain mirror needs no memo model.
 */
function emitWalkStep(p, aToB, v, indent) {
    const dIn = (lo, hi) => `wpDA(${v.l}, ${lo}, ${hi}, 1)`;
    const dInB = (lo, hi) => `wpDB(${v.l}, ${lo}, ${hi}, 1)`;
    const full = aToB ? dIn(`${p}tg`, v.sp) : dInB(v.sp, `${p}tg`);
    const out = aToB ? `wpDB(${v.l}, ${p}nx, ${v.sp}, 0)` : `wpDA(${v.l}, ${v.sp}, ${p}nx, 0)`;
    const outFull = aToB ? `wpDB(${v.l}, ${p}tg, ${v.sp}, 0)` : `wpDA(${v.l}, ${v.sp}, ${p}tg, 0)`;
    const inRe = aToB ? dIn(`${p}nx`, v.sp) : dInB(v.sp, `${p}nx`);
    const next = aToB ? `wpNxA(${v.sp}, ${v.l}, ${p}ca)` : `${v.sp} + ((${p}ca << 64) / ${v.l})`;
    const cross = (indent2) => aToB
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
        // ── full step to the boundary, then cross ──
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
        // ── partial step inside the segment (or is_max via next == target) ──
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
function emitBoundary(p, slot, k, aToB, params) {
    const keep = aToB ? `${p}t2 <= ${p}bt` : `${p}t2 > ${p}bt`;
    const readArm = (a) => [
        `        ${p}t5 = accountUint(${JSON.stringify(ref(slot, `ta${a}`))}, ${OFF_TA_TICKS} + ${p}t3 * ${TICK_LEN}, 1);`,
        `        if (${p}t5 === 1) { ${p}t6 = accountUint(${JSON.stringify(ref(slot, `ta${a}`))}, ${OFF_TA_TICKS} + ${p}t3 * ${TICK_LEN} + 1, 16) }`,
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
        `        if (${p}t5 === 1) {`,
        `          ${p}bsp[${p}nbv] = (${params[2 + 3 * k]} << 64) | ${params[3 + 3 * k]};`,
        `          ${p}bnt[${p}nbv] = ${p}t6;`,
        `          ${p}nbv = ${p}nbv + 1;`,
        `        }`,
        `      }`,
        `    }`,
    ];
}
export const orcaWhirlpoolLadder = {
    slug: SLUG,
    /**
     * 2 rungs by default: a rung is a full cold walk (each crossed boundary
     * ~45k CU on the interpreter), the same economics that put the stable
     * families at 2 (see recipes/ecoswap/svm/budget.ts).
     */
    defaultRungs: 2,
    shapeKey(base) {
        return `${SLUG}:${whirlConfig(base).direction}`;
    },
    helpers() {
        return HELPERS;
    },
    /** [nb, (meta,sqrtHi,sqrtLo) x MAX_BOUNDARIES, edgeTick, edgeHi, edgeLo]. */
    paramCount: PARAM_COUNT,
    paramsFor(base) {
        const window = windowFor(whirlConfig(base));
        const words = [BigInt(window.boundaries.length)];
        for (let k = 0; k < WHIRLPOOL_MAX_BOUNDARIES; k++) {
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
        const cfg = whirlConfig(base);
        const window = windowFor(cfg);
        const referenced = new Set(window.boundaries.map((boundary) => boundary.arrayIndex));
        return [
            { ref: ref(slot, 'pool'), address: cfg.pool },
            // All three window PDAs ride the plan (the swap ix needs them and the
            // blob is shape-generic); the ones hosting no shipped boundary may not
            // even exist on-chain — the fragment never reads them and the
            // orchestrator's state fetch skips them (optional).
            ...window.tickArrays.map((address, i) => ({
                ref: ref(slot, `ta${i}`),
                address,
                ...(referenced.has(i) ? {} : { optional: true }),
            })),
        ];
    },
    emitSetup(base, slot, params, enableVar) {
        const cfg = whirlConfig(base);
        const aToB = cfg.direction === 'aToB';
        const p = `s${slot}`;
        const pool = JSON.stringify(ref(slot, 'pool'));
        const enabled = enableVar ?? `${p}en`;
        const edgeKeep = aToB ? `${p}t1 <= ${p}bt` : `${p}t1 > ${p}bt`;
        const lines = [
            `  const ${p}l0 = accountUint(${pool}, ${OFF_LIQUIDITY}, 16);`,
            `  const ${p}sp0 = accountUint(${pool}, ${OFF_SQRT_PRICE}, 16);`,
            `  const ${p}bt = (accountUint(${pool}, ${OFF_TICK_CURRENT}, 4) + ${BIAS}) & ${M32};`,
            `  const ${p}fr = accountUint(${pool}, ${OFF_FEE_RATE}, 2);`,
            `  const ${p}fn = ${FEE_MUL} - ${p}fr;`,
            `  let ${p}nbv = 0;`,
            `  let ${p}kmx = 0;`,
            // bsp/bnt: live-verified targets (+ the edge as a zero-net entry);
            // fxa/csn/cot/lps: the cross-walk full-step memo (see emitWalkStep).
            `  const ${p}bsp = new Array(${WHIRLPOOL_MAX_BOUNDARIES + 1});`,
            `  const ${p}bnt = new Array(${WHIRLPOOL_MAX_BOUNDARIES + 1});`,
            `  const ${p}fxa = new Array(${WHIRLPOOL_MAX_BOUNDARIES + 1});`,
            `  const ${p}csn = new Array(${WHIRLPOOL_MAX_BOUNDARIES + 1});`,
            `  const ${p}cot = new Array(${WHIRLPOOL_MAX_BOUNDARIES + 1});`,
            `  const ${p}lps = new Array(${WHIRLPOOL_MAX_BOUNDARIES + 1});`,
            `  let ${p}t1 = 0; let ${p}t2 = 0; let ${p}t3 = 0; let ${p}t4 = 0; let ${p}t5 = 0; let ${p}t6 = 0;`,
            // Walk step temps + the ladder chain cursor (shared by the rungs and
            // the cold final quote, so they live at main scope).
            `  let ${p}tg = 0; let ${p}ca = 0; let ${p}fx = 0; let ${p}nx = 0; let ${p}ou = 0; let ${p}i2 = 0; let ${p}fe = 0; let ${p}nw = 0;`,
            `  let ${p}wsp = 0; let ${p}wl = 0; let ${p}wk = 0; let ${p}wex = 0; let ${p}wout = 0; let ${p}rm = 0;`,
            `  let ${p}lo = 0; let ${p}lx = 0; let ${p}wcx = 0;`,
            `  if (${enabled} !== 0) {`,
            ...Array.from({ length: WHIRLPOOL_MAX_BOUNDARIES }, (_, k) => emitBoundary(p, slot, k, aToB, params)).flat(),
            `    ${p}t1 = ${params[1 + 3 * WHIRLPOOL_MAX_BOUNDARIES]};`,
            `    if (${p}t1 !== 0 && (${edgeKeep})) {`,
            `      ${p}bsp[${p}nbv] = (${params[2 + 3 * WHIRLPOOL_MAX_BOUNDARIES]} << 64) | ${params[3 + 3 * WHIRLPOOL_MAX_BOUNDARIES]};`,
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
        const cfg = whirlConfig(base);
        const aToB = cfg.direction === 'aToB';
        const p = `s${slot}`;
        const v = { sp: `${p}wsp`, l: `${p}wl`, k: `${p}wk`, ex: `${p}wex`, out: `${p}wout`, rm: `${p}rm` };
        const lines = [];
        lines.push(
        // COLD rung: walk from the LIVE spot; once one rung exhausts, all
        // rungs above report the last good output (dOut 0 — merge-safe).
        // lx/lo remember the last SUCCESSFUL grid point and its output — the
        // final predicted quote reuses them when the elected fill lands there.
        `    if (${p}vld !== 0 && ${p}wcx === 0 && ${x} > 0) {`, `      ${p}wsp = ${p}sp0; ${p}wl = ${p}l0; ${p}wk = 0; ${p}wex = 0; ${p}wout = 0;`, `      ${p}rm = ${x};`, `      for (let ${p}w${rung} = 0; ${p}w${rung} < ${WALK_BOUND} && ${p}rm > 0 && ${p}wex === 0; ${p}w${rung}++) {`, ...emitWalkStep(p, aToB, v, '        '), `      }`, 
        // Capacity-aware booking: a fully-absorbed rung records (grid point,
        // output); an exhausted rung records the PRODUCTIVE input consumed
        // (x − remaining, the window cap) and the output at the cap, then
        // latches wcx so higher rungs reuse the cap (their dIn folds to 0). lx
        // therefore always holds the cumulative productive input — the codegen
        // books dIn from its delta so the venue self-caps at real depth.
        `      if (${p}wex === 0 && ${p}rm === 0) { ${p}lo = ${p}wout; ${p}lx = ${x} }`, `      else { ${p}lo = ${p}wout; ${p}lx = ${x} - ${p}rm; ${p}wcx = 1 }`, `    }`, `    const ${outVar} = ${p}lo;`);
        return lines.join('\n');
    },
    capacityInputVar(slot) {
        return `s${slot}lx`;
    },
    emitFinalQuote(base, slot, x, outVar) {
        const cfg = whirlConfig(base);
        const aToB = cfg.direction === 'aToB';
        const p = `s${slot}`;
        const v = { sp: `${p}fsp`, l: `${p}fl`, k: `${p}fk`, ex: `${p}fex`, out: `${p}fo`, rm: `${p}frm` };
        return [
            `  let ${outVar} = 0;`,
            // Reuse the last successful ladder value when the elected fill lands
            // exactly on that grid point (the whole-trade case and any fully
            // consumed slot) — lx is only set on UNCAPPED rungs, where the ladder
            // value equals this cold walk bit-for-bit.
            `  if (${p}vld !== 0 && ${x} > 0) {`,
            `    if (${p}lx === ${x}) { ${outVar} = ${p}lo }`,
            `    else {`,
            `      let ${p}fsp = ${p}sp0; let ${p}fl = ${p}l0; let ${p}fk = 0; let ${p}fex = 0; let ${p}fo = 0;`,
            `      let ${p}frm = ${x};`,
            `      for (let ${p}wf = 0; ${p}wf < ${WALK_BOUND} && ${p}frm > 0 && ${p}fex === 0; ${p}wf++) {`,
            ...emitWalkStep(p, aToB, v, '        '),
            `      }`,
            `      if (${p}fex === 0 && ${p}frm === 0) { ${outVar} = ${p}fo }`,
            `    }`,
            `  }`,
        ].join('\n');
    },
    buildSwapV2(base, slot, user) {
        const cfg = whirlConfig(base);
        const aToB = cfg.direction === 'aToB';
        const window = windowFor(cfg);
        // swap: disc(8) ++ amount u64 LE (runtime-patched) ++
        // other_amount_threshold u64 LE = 1 ++ sqrt_price_limit u128 LE = 0
        // (NO_EXPLICIT_SQRT_PRICE_LIMIT — the program substitutes the global
        // MIN/MAX bound; the capacity clamp keeps the walk inside the window, so
        // an explicit per-pool limit would be dead data in a shape-generic blob)
        // ++ amount_specified_is_input = 1 ++ a_to_b.
        const suffix = new Uint8Array(8 + 16 + 1 + 1);
        suffix[0] = 1; // other_amount_threshold = 1 (terminal outAta delta enforces the real bound)
        suffix[24] = 1; // amount_specified_is_input = true
        suffix[25] = aToB ? 1 : 0;
        const roled = (role, addr, writable) => writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
        return {
            programId: ORCA_WHIRLPOOL_PROGRAM_ID,
            prefix: Uint8Array.from(SWAP_DISCRIMINATOR),
            suffix,
            patch: 'in',
            accounts: [
                roled('tp', TOKEN_PROGRAM),
                { ref: user.owner, signer: true },
                roled('pool', cfg.pool, true),
                { ref: aToB ? user.inAta : user.outAta, writable: true }, // token_owner_account_a
                roled('va', cfg.tokenVaultA, true),
                { ref: aToB ? user.outAta : user.inAta, writable: true }, // token_owner_account_b
                roled('vb', cfg.tokenVaultB, true),
                roled('ta0', window.tickArrays[0], true),
                roled('ta1', window.tickArrays[1], true),
                roled('ta2', window.tickArrays[2], true),
                roled('orc', cfg.oracle),
            ],
        };
    },
    /**
     * Exact mirror of the emitted fragment given the SAME cfg + params the
     * blob was prepared with, over live account bytes — the boundary set rides
     * the params, so callers mirroring a drifted execution must pass the
     * prepare-time cfg/params (as the orchestrator and the e2e suites do).
     */
    referenceQuote(base, state, params) {
        const cfg = whirlConfig(base);
        const aToB = cfg.direction === 'aToB';
        const live = liveFromState(cfg, state);
        const win = effectiveWindow(cfg, state, live, params);
        return (x) => coldWalk(win, live, aToB, x) ?? 0n;
    },
    referenceLadderQuotes(base, state, params) {
        const cfg = whirlConfig(base);
        const aToB = cfg.direction === 'aToB';
        const live = liveFromState(cfg, state);
        const win = effectiveWindow(cfg, state, live, params);
        return (grid) => {
            let lo = 0n;
            let capped = false;
            return grid.map((g) => {
                if (win.valid && !capped && g > 0n) {
                    const { out, cap } = coldWalkClamped(win, live, aToB, g);
                    lo = out; // fully absorbed: q(g); exhausted: q(cap) at the window edge
                    if (cap < g)
                        capped = true;
                }
                return lo;
            });
        };
    },
    referenceCapacities(base, state, params) {
        const cfg = whirlConfig(base);
        const aToB = cfg.direction === 'aToB';
        const live = liveFromState(cfg, state);
        const win = effectiveWindow(cfg, state, live, params);
        return (grid) => {
            let cap = 0n;
            let capped = false;
            return grid.map((g) => {
                if (win.valid && !capped && g > 0n) {
                    const clamped = coldWalkClamped(win, live, aToB, g);
                    cap = clamped.cap; // grid point when absorbed; productive input at the window edge
                    if (clamped.cap < g)
                        capped = true;
                }
                return cap;
            });
        };
    },
    /**
     * Full-range CP-equivalent VIRTUAL reserves at the live spot (Q64.64):
     * a = L<<64/sp, b = L*sp>>64 — isqrt(a*b) == L, the canonical CLMM depth.
     * Same convention (and same honesty caveat) as meteora-damm-v2.
     */
    depthReserves(base, state) {
        const cfg = whirlConfig(base);
        const live = liveFromState(cfg, state);
        if (live.sp === 0n)
            return { reserveIn: 0n, reserveOut: 0n };
        const a = (live.l << 64n) / live.sp;
        const b = (live.l * live.sp) >> 64n;
        return cfg.direction === 'aToB' ? { reserveIn: a, reserveOut: b } : { reserveIn: b, reserveOut: a };
    },
    continuousFees(base, state) {
        const cfg = whirlConfig(base);
        const live = liveFromState(cfg, state);
        // fee_rate is hundredths of a bp == ppm directly; charged on the INPUT.
        return { gammaPpm: FEE_MUL - live.fr, muPpm: FEE_MUL };
    },
};
//# sourceMappingURL=ladder.js.map