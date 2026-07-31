import { ceilDiv, readUintLE } from '../math.js';
import { DERIVERSE_PROGRAM_ID, MASK_SUSPENDED, OFF_ASSET_TOKENS, OFF_CRNCY_TOKENS, OFF_DEC_FACTOR, OFF_LAST_PX, OFF_MASK, deriverseSwapAccounts } from './index.js';
const SLUG = 'deriverse';
const FEE_DEN = 1000000n;
function deriverseConfig(base) {
    if (base.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${base.venue}' pool config`);
    return base;
}
const ref = (slot, role) => `s${slot}:${role}`;
/** Floor integer square root (mirrors the engine's Math.sqrt op / obric-v2's own isqrt). */
export function deriverseIsqrt(value) {
    if (value < 0n)
        throw new Error(`deriverseIsqrt needs a non-negative value, got ${value}`);
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
/** Ceiling integer square root: smallest r with r*r >= value. */
export function deriverseCeilIsqrt(value) {
    const r = deriverseIsqrt(value);
    return r * r === value ? r : r + 1n;
}
function liveCurve(cfg, state) {
    const pool = state[cfg.pool];
    if (pool === undefined)
        throw new Error(`${SLUG} reference is missing pool ${cfg.pool}`);
    const mask = readUintLE(pool, OFF_MASK, 4);
    const a = readUintLE(pool, OFF_ASSET_TOKENS, 8);
    const b = readUintLE(pool, OFF_CRNCY_TOKENS, 8);
    const df = readUintLE(pool, OFF_DEC_FACTOR, 8);
    const px = readUintLE(pool, OFF_LAST_PX, 8);
    const enabled = (mask & BigInt(MASK_SUSPENDED)) === 0n && a > 0n && b > 0n && df > 0n && px > 0n;
    return { enabled, a, b, k: enabled ? a * b : 0n, df, px, feePpm: cfg.feePpm };
}
/** The (icap, k) pair the SELL/BUY caps reduce to — see the file header derivation. */
function capacity(curve, side) {
    if (!curve.enabled)
        return 0n;
    const { a, b, k, df, feePpm } = curve;
    const maxDiff = curve.px >> 4n;
    const kdf = k * df;
    if (side === 'sell') {
        const floorPx = curve.px - maxDiff;
        const newAMax = deriverseIsqrt(kdf / floorPx);
        const cap = newAMax - a;
        return cap > 0n ? cap : 0n;
    }
    const ceilPx = curve.px + maxDiff;
    const newAMin = deriverseCeilIsqrt(ceilDiv(kdf, ceilPx));
    let netInCap = k / newAMin - b;
    if (netInCap < 0n)
        netInCap = 0n;
    return (netInCap * (FEE_DEN + feePpm)) / FEE_DEN;
}
/** The COLD (venue-exact) quote at gross input x, SATURATING at the capacity clamp — see the file header. */
export function deriverseRawQuote(x, curve, side, icap) {
    if (!curve.enabled)
        return 0n;
    const cx = x > icap ? icap : x;
    if (cx <= 0n)
        return 0n;
    const { a, b, k, feePpm } = curve;
    if (side === 'sell') {
        const newA = a + cx;
        const raw0 = b - k / newA;
        const raw = raw0 > 0n ? raw0 - 1n : 0n;
        const fee = ceilDiv(raw * feePpm, FEE_DEN);
        return raw > fee ? raw - fee : 0n;
    }
    const netIn = (cx * FEE_DEN) / (FEE_DEN + feePpm);
    if (netIn <= 0n)
        return 0n;
    const newB = b + netIn;
    const raw0 = a - k / newB;
    return raw0 > 0n ? raw0 - 1n : 0n;
}
export const deriverseLadder = {
    slug: SLUG,
    /** CP-class: a closed-form quote (one deriverseIsqrt-derived cap + a division), 4 rungs. */
    defaultRungs: 4,
    shapeKey(base) {
        return `${SLUG}:${deriverseConfig(base).side}`;
    },
    helpers() {
        return [
            {
                name: 'drvCeilDiv',
                source: ['function drvCeilDiv(a, b) {', '  return (a + b - 1) / b;', '}'].join('\n'),
            },
            {
                name: 'drvCeilIsqrt',
                source: [
                    'function drvCeilIsqrt(n) {',
                    '  const r = Math.sqrt(n);',
                    '  if (r * r === n) { return r }',
                    '  return r + 1;',
                    '}',
                ].join('\n'),
            },
        ];
    },
    paramCount: 1,
    paramsFor(base) {
        return [deriverseConfig(base).feePpm];
    },
    quoteRefs(base, slot) {
        const c = deriverseConfig(base);
        return [{ ref: ref(slot, 'pool'), address: c.pool }];
    },
    emitSetup(base, slot, params, enableVar) {
        const c = deriverseConfig(base);
        const p = `s${slot}`;
        const en = enableVar ?? `${p}en`;
        const pool = JSON.stringify(ref(slot, 'pool'));
        const [feePpm] = params;
        const capLines = c.side === 'sell'
            ? [
                `      const ${p}floorpx = ${p}px - ${p}maxdiff;`,
                `      const ${p}newamax = Math.sqrt(${p}kdf / ${p}floorpx);`,
                `      let ${p}cap = ${p}newamax - ${p}a;`,
                `      if (${p}cap < 0) { ${p}cap = 0 }`,
                `      ${p}icap = ${p}cap;`,
            ]
            : [
                `      const ${p}ceilpx = ${p}px + ${p}maxdiff;`,
                `      const ${p}newamin = drvCeilIsqrt(drvCeilDiv(${p}kdf, ${p}ceilpx));`,
                `      let ${p}netincap = ${p}k / ${p}newamin - ${p}b;`,
                `      if (${p}netincap < 0) { ${p}netincap = 0 }`,
                `      ${p}icap = ${p}netincap * (1000000 + ${feePpm}) / 1000000;`,
            ];
        // Rung-scratch locals emitLadderQuote ASSIGNS (never re-declares) on every
        // rung call — it runs once PER RUNG in the same function scope, so these
        // must be declared exactly once, here (the same shape obric-v2 uses for
        // its own s<slot>ni/no/gg rung scratch).
        const scratchDecl = c.side === 'sell'
            ? [`  let ${p}newa = 0;`, `  let ${p}raw0 = 0;`, `  let ${p}raw = 0;`, `  let ${p}rfee = 0;`]
            : [`  let ${p}netin = 0;`, `  let ${p}newb = 0;`, `  let ${p}raw0 = 0;`];
        return [
            // LIVE reads (unconditional — one account, the instrument itself).
            `  const ${p}mask = accountUint(${pool}, ${OFF_MASK}, 4);`,
            `  const ${p}a = accountUint(${pool}, ${OFF_ASSET_TOKENS}, 8);`,
            `  const ${p}b = accountUint(${pool}, ${OFF_CRNCY_TOKENS}, 8);`,
            `  const ${p}df = accountUint(${pool}, ${OFF_DEC_FACTOR}, 8);`,
            `  const ${p}px = accountUint(${pool}, ${OFF_LAST_PX}, 8);`,
            // feePpm is a baked param (see index.ts's conservativeFeePpm) — captured
            // in a slot local so emitLadderQuote/emitFinalQuote can reference it
            // without re-threading params (they receive no `params` argument).
            `  const ${p}fee = ${feePpm};`,
            `  let ${p}k = 0;`,
            `  let ${p}icap = 0;`,
            `  let ${p}cx = 0;`,
            ...scratchDecl,
            `  if (${en} !== 0) {`,
            `    let ${p}ok = 1;`,
            `    if ((${p}mask & ${MASK_SUSPENDED}) !== 0) { ${p}ok = 0 }`,
            `    if (${p}a <= 0) { ${p}ok = 0 }`,
            `    if (${p}b <= 0) { ${p}ok = 0 }`,
            `    if (${p}df <= 0) { ${p}ok = 0 }`,
            `    if (${p}px <= 0) { ${p}ok = 0 }`,
            `    if (${p}ok !== 0) {`,
            `      ${p}k = ${p}a * ${p}b;`,
            `      const ${p}maxdiff = ${p}px >> 4;`,
            `      const ${p}kdf = ${p}k * ${p}df;`,
            ...capLines,
            `    }`,
            `  }`,
        ].join('\n');
    },
    capacityInputVar(slot) {
        return `s${slot}cx`;
    },
    /** Ladder rung at cumulative grid point `x`: qRaw(min(x, icap)) — stateless, mirrors deriverseRawQuote. */
    emitLadderQuote(base, slot, _rung, x, outVar) {
        const c = deriverseConfig(base);
        const p = `s${slot}`;
        const feeExpr = `${p}fee`;
        // ASSIGN (never re-declare) the scratch locals emitSetup pre-declared —
        // this function runs once per rung in one shared scope.
        const quoteLines = c.side === 'sell'
            ? [
                `      ${p}newa = ${p}a + ${p}cx;`,
                `      ${p}raw0 = ${p}b - ${p}k / ${p}newa;`,
                `      ${p}raw = 0;`,
                `      if (${p}raw0 > 0) { ${p}raw = ${p}raw0 - 1 }`,
                `      ${p}rfee = drvCeilDiv(${p}raw * ${feeExpr}, 1000000);`,
                `      if (${p}raw > ${p}rfee) { ${outVar} = ${p}raw - ${p}rfee }`,
            ]
            : [
                `      ${p}netin = ${p}cx * 1000000 / (1000000 + ${feeExpr});`,
                `      if (${p}netin > 0) {`,
                `        ${p}newb = ${p}b + ${p}netin;`,
                `        ${p}raw0 = ${p}a - ${p}k / ${p}newb;`,
                `        if (${p}raw0 > 0) { ${outVar} = ${p}raw0 - 1 }`,
                `      }`,
            ];
        return [
            `    ${p}cx = ${x};`,
            `    if (${p}cx > ${p}icap) { ${p}cx = ${p}icap }`,
            `    let ${outVar} = 0;`,
            `    if (${p}cx > 0 && ${p}k !== 0) {`,
            ...quoteLines,
            `    }`,
        ].join('\n');
    },
    /** Cold final quote — same capacity clamp, fresh locals (no rung state to reuse). */
    emitFinalQuote(base, slot, x, outVar) {
        const c = deriverseConfig(base);
        const p = `s${slot}`;
        const feeExpr = `${p}fee`;
        const quoteLines = c.side === 'sell'
            ? [
                `    const ${p}fnewa = ${p}fcx + ${p}a;`,
                `    const ${p}fraw0 = ${p}b - ${p}k / ${p}fnewa;`,
                `    let ${p}fraw = 0;`,
                `    if (${p}fraw0 > 0) { ${p}fraw = ${p}fraw0 - 1 }`,
                `    const ${p}ffee = drvCeilDiv(${p}fraw * ${feeExpr}, 1000000);`,
                `    if (${p}fraw > ${p}ffee) { ${outVar} = ${p}fraw - ${p}ffee }`,
            ]
            : [
                `    const ${p}fnetin = ${p}fcx * 1000000 / (1000000 + ${feeExpr});`,
                `    if (${p}fnetin > 0) {`,
                `      const ${p}fnewb = ${p}b + ${p}fnetin;`,
                `      const ${p}fraw0 = ${p}a - ${p}k / ${p}fnewb;`,
                `      if (${p}fraw0 > 0) { ${outVar} = ${p}fraw0 - 1 }`,
                `    }`,
            ];
        return [
            `  let ${p}fcx = ${x};`,
            `  if (${p}fcx > ${p}icap) { ${p}fcx = ${p}icap }`,
            `  let ${outVar} = 0;`,
            `  if (${p}fcx > 0 && ${p}k !== 0) {`,
            ...quoteLines,
            `  }`,
        ].join('\n');
    },
    buildSwapV2(base, slot, user) {
        const c = deriverseConfig(base);
        // Swap (disc 26): tag(1) input_crncy(1) padding_u16(2) instr_id(4) price
        // i64(8)=0 ++ amount u64 LE (runtime-patched) ++ min_amount_out i64(8)=1.
        const prefix = new Uint8Array(16);
        const dv = new DataView(prefix.buffer);
        prefix[0] = 26;
        prefix[1] = c.side === 'buy' ? 1 : 0;
        dv.setUint32(4, c.instrId, true);
        dv.setBigInt64(8, 0n, true);
        const suffix = new Uint8Array(8);
        new DataView(suffix.buffer).setBigInt64(0, 1n, true);
        const make = (r, addr, writable) => writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
        return {
            programId: DERIVERSE_PROGRAM_ID,
            prefix,
            suffix,
            patch: 'in',
            accounts: deriverseSwapAccounts(c, user, make, (role) => ref(slot, role)),
        };
    },
    referenceQuote(base, state, params) {
        const c = deriverseConfig(base);
        const curve = liveCurveWithParams(c, state, params);
        const icap = capacity(curve, c.side);
        return (x) => deriverseRawQuote(x, curve, c.side, icap);
    },
    /** Stateless (every grid point is its own closed-form evaluation) — mirrors emitLadderQuote's min(x, icap) clamp. */
    referenceLadderQuotes(base, state, params) {
        const c = deriverseConfig(base);
        const curve = liveCurveWithParams(c, state, params);
        const icap = capacity(curve, c.side);
        return (grid) => grid.map((x) => deriverseRawQuote(x, curve, c.side, icap));
    },
    /** Cumulative productive input per ORDERED grid point — min(g, icap), mirroring capacityInputVar lamport-for-lamport. */
    referenceCapacities(base, state, params) {
        const c = deriverseConfig(base);
        const curve = liveCurveWithParams(c, state, params);
        const icap = capacity(curve, c.side);
        return (grid) => grid.map((g) => (g > icap ? icap : g));
    },
    /** Depth = the embedded AMM's own reserves (0 for a book-only instrument — the honest, disclosed under-quote). */
    depthReserves(base, state) {
        const c = deriverseConfig(base);
        const curve = liveCurve(c, state);
        return c.side === 'sell' ? { reserveIn: curve.a, reserveOut: curve.b } : { reserveIn: curve.b, reserveOut: curve.a };
    },
    continuousFees(base) {
        const c = deriverseConfig(base);
        const feePpm = c.feePpm > FEE_DEN ? FEE_DEN : c.feePpm;
        return { gammaPpm: FEE_DEN, muPpm: FEE_DEN - feePpm };
    },
};
/** referenceQuote/referenceLadderQuotes/referenceCapacities all need the SAME live curve + baked feePpm. */
function liveCurveWithParams(cfg, state, params) {
    const [feePpm] = params;
    const base = liveCurve(cfg, state);
    return { ...base, feePpm };
}
//# sourceMappingURL=ladder.js.map