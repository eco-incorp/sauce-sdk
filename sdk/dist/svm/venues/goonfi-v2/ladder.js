import { readUintLE } from '../math.js';
import { denomAdjustedFor, GOONFI_ASSUMED_DENOM, GOONFI_V2_PROGRAM_ID, GOONFI_SWAP_TAG, goonfiSwapAccounts, OFF_ORACLE_DENOM, OFF_ORACLE_P1, OFF_ORACLE_P2, } from './index.js';
const SLUG = 'goonfi-v2';
const AMOUNT_OFF = 64; // SPL token account amount field.
const FEE_DEN = 1000000n;
/** 1 (da) + 9 (size thresholds) + 9 (fee-ppm tiers). */
const PARAM_COUNT = 19;
const TIER_COUNT = 9;
function goonfiConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
const ref = (slot, role) => `s${slot}:${role}`;
function rawExpr(c, p, x) {
    return c.direction === 'xToY' ? `Math.mulDiv(${x}, ${p}pr, ${p}da)` : `Math.mulDiv(${x}, ${p}da, ${p}pr)`;
}
/** Fee-tier lookup: assigns the slot's `${p}fee` local by walking the 9 ascending thresholds. */
function feeAssignLines(p, x) {
    return [
        `      ${p}fee = ${p}f1;`,
        `      if (${x} > ${p}t1) { ${p}fee = ${p}f2 }`,
        `      if (${x} > ${p}t2) { ${p}fee = ${p}f3 }`,
        `      if (${x} > ${p}t3) { ${p}fee = ${p}f4 }`,
        `      if (${x} > ${p}t4) { ${p}fee = ${p}f5 }`,
        `      if (${x} > ${p}t5) { ${p}fee = ${p}f6 }`,
        `      if (${x} > ${p}t6) { ${p}fee = ${p}f7 }`,
        `      if (${x} > ${p}t7) { ${p}fee = ${p}f8 }`,
        `      if (${x} > ${p}t8) { ${p}fee = ${p}f9 }`,
    ];
}
/** The reference twin of emitSetup: derive the live price/gate + baked params from account bytes. */
function liveState(cfg, state, params) {
    const oracle = state[cfg.oracle];
    if (oracle === undefined)
        throw new Error(`${SLUG} reference is missing oracle-relay ${cfg.oracle}`);
    const voutAddr = cfg.direction === 'yToX' ? cfg.vaultA : cfg.vaultB;
    const vout = state[voutAddr];
    if (vout === undefined)
        throw new Error(`${SLUG} reference is missing vault ${voutAddr}`);
    const p1 = readUintLE(oracle, OFF_ORACLE_P1, 8);
    const p2 = readUintLE(oracle, OFF_ORACLE_P2, 8);
    const dn = readUintLE(oracle, OFF_ORACLE_DENOM, 4);
    const rout = readUintLE(vout, AMOUNT_OFF, 8);
    const pr = cfg.direction === 'xToY' ? (p2 !== 0n && p2 < p1 ? p2 : p1) : p2 > p1 ? p2 : p1;
    const active = p1 !== 0n && p2 !== 0n && dn === GOONFI_ASSUMED_DENOM;
    const [da, ...rest] = params;
    const thresholds = rest.slice(0, TIER_COUNT);
    const fees = rest.slice(TIER_COUNT, 2 * TIER_COUNT);
    return { pr, da: da, rout, active, thresholds, fees };
}
/** The COLD (final, venue-approximating) quote: price+fee model for gross input x, 0 past either
 *  deactivation edge (the size ceiling or the live vaultOut clamp) — the lamport-exact target for
 *  emitFinalQuote. */
export function goonfiColdQuote(cfg, x, live) {
    if (x === 0n || !live.active)
        return 0n;
    if (x > live.thresholds[8])
        return 0n;
    let fee = live.fees[0];
    for (let i = 0; i < TIER_COUNT - 1; i++) {
        if (x > live.thresholds[i])
            fee = live.fees[i + 1];
    }
    const raw = cfg.direction === 'xToY' ? (x * live.pr) / live.da : (x * live.da) / live.pr;
    const net = raw - (raw * fee) / FEE_DEN;
    if (net > live.rout)
        return 0n;
    return net;
}
/** Shared walk backing both referenceLadderQuotes and referenceCapacities — mirrors
 *  emitLadderQuote exactly (monotone, flat past either deactivation edge). */
function referenceWalk(cfg, live, grid) {
    let lo = 0n;
    let lx = 0n;
    let capped = false;
    const outs = [];
    const caps = [];
    for (const x of grid) {
        if (!capped && x > 0n && live.active) {
            if (x > live.thresholds[8]) {
                capped = true;
            }
            else {
                let fee = live.fees[0];
                for (let i = 0; i < TIER_COUNT - 1; i++) {
                    if (x > live.thresholds[i])
                        fee = live.fees[i + 1];
                }
                const raw = cfg.direction === 'xToY' ? (x * live.pr) / live.da : (x * live.da) / live.pr;
                const net = raw - (raw * fee) / FEE_DEN;
                if (net > live.rout)
                    capped = true;
                else {
                    lo = net;
                    lx = x;
                }
            }
        }
        outs.push(lo);
        caps.push(lx);
    }
    return { outs, caps };
}
export const goonfiV2Ladder = {
    slug: SLUG,
    /** CP-class: a closed-form quote (one mulDiv + a tier lookup per rung), 4 rungs. */
    defaultRungs: 4,
    shapeKey(base) {
        return `${SLUG}:${goonfiConfig(base).direction}`;
    },
    /** The quote is inline statement-form (last-good ladder / cold final) — no shared helper,
     *  mirroring obric-v2 (both deactivation edges must reuse the setup-declared slot locals, not a
     *  standalone pure-scalar helper — see module doc). */
    helpers() {
        return [];
    },
    paramCount: PARAM_COUNT,
    paramsFor(base) {
        const c = goonfiConfig(base);
        const da = denomAdjustedFor(c.decimalsA, c.decimalsB);
        return [da, ...c.feeSchedule.sizeTiers, ...c.feeSchedule.feeTiersPpm];
    },
    quoteRefs(base, slot) {
        const c = goonfiConfig(base);
        return [
            { ref: ref(slot, 'pool'), address: c.pool },
            { ref: ref(slot, 'oracle'), address: c.oracle },
            { ref: ref(slot, 'va'), address: c.vaultA },
            { ref: ref(slot, 'vb'), address: c.vaultB },
        ];
    },
    emitSetup(base, slot, params) {
        const c = goonfiConfig(base);
        const p = `s${slot}`;
        const oracle = JSON.stringify(ref(slot, 'oracle'));
        const voutRole = c.direction === 'yToX' ? 'va' : 'vb';
        const vout = JSON.stringify(ref(slot, voutRole));
        const [da, t1, t2, t3, t4, t5, t6, t7, t8, t9, f1, f2, f3, f4, f5, f6, f7, f8, f9] = params;
        return [
            `  const ${p}p1 = accountUint(${oracle}, ${OFF_ORACLE_P1}, 8);`,
            `  const ${p}p2 = accountUint(${oracle}, ${OFF_ORACLE_P2}, 8);`,
            `  const ${p}dn = accountUint(${oracle}, ${OFF_ORACLE_DENOM}, 4);`,
            `  const ${p}rout = accountUint(${vout}, ${AMOUNT_OFF}, 8);`,
            `  let ${p}pr = ${p}p1;`,
            c.direction === 'xToY'
                ? `  if (${p}p2 !== 0 && ${p}p2 < ${p}pr) { ${p}pr = ${p}p2 }`
                : `  if (${p}p2 > ${p}pr) { ${p}pr = ${p}p2 }`,
            `  let ${p}kq = 1;`,
            `  if (${p}p1 === 0) { ${p}kq = 0 }`,
            `  if (${p}p2 === 0) { ${p}kq = 0 }`,
            `  if (${p}dn !== ${GOONFI_ASSUMED_DENOM.toString()}) { ${p}kq = 0 }`,
            `  const ${p}da = ${da};`,
            `  const ${p}t1 = ${t1}; const ${p}t2 = ${t2}; const ${p}t3 = ${t3}; const ${p}t4 = ${t4}; const ${p}t5 = ${t5};`,
            `  const ${p}t6 = ${t6}; const ${p}t7 = ${t7}; const ${p}t8 = ${t8}; const ${p}t9 = ${t9};`,
            `  const ${p}f1 = ${f1}; const ${p}f2 = ${f2}; const ${p}f3 = ${f3}; const ${p}f4 = ${f4}; const ${p}f5 = ${f5};`,
            `  const ${p}f6 = ${f6}; const ${p}f7 = ${f7}; const ${p}f8 = ${f8}; const ${p}f9 = ${f9};`,
            `  let ${p}raw = 0; let ${p}fee = 0; let ${p}net = 0;`,
            `  let ${p}lo = 0; let ${p}lx = 0; let ${p}cap = 0;`,
        ].join('\n');
    },
    /**
     * Ladder rung at cumulative grid point `x`: the price+fee-tier output, reported as the LAST-GOOD
     * value once the walk passes either deactivation edge (the tier ceiling or the live vaultOut
     * clamp) — a capped rung's dOut is 0 and the merge never over-fills goonfi-v2 past what the
     * venue's own configured capacity or its live vault can pay. Monotone nondecreasing; quote(0)=0.
     * `${p}lx` (capacityInputVar) freezes alongside `${p}lo` at the last genuinely-productive
     * cumulative input, so a rung past either edge reports zero PRODUCTIVE input too (not the raw,
     * over-capacity grid point) — the merge-reachable half of the ladder-contract guard's required
     * capacityInputVar/referenceCapacities pair. Mirrored by referenceLadderQuotes/referenceCapacities.
     */
    emitLadderQuote(base, slot, _rung, x, outVar) {
        const c = goonfiConfig(base);
        const p = `s${slot}`;
        return [
            `    if (${p}cap === 0 && ${x} > 0 && ${p}kq !== 0) {`,
            `      if (${x} > ${p}t9) { ${p}cap = 1 }`,
            `      else {`,
            `        ${p}raw = ${rawExpr(c, p, x)};`,
            ...feeAssignLines(p, x).map((l) => '  ' + l),
            `        ${p}net = ${p}raw - Math.mulDiv(${p}raw, ${p}fee, ${FEE_DEN});`,
            `        if (${p}net > ${p}rout) { ${p}cap = 1 } else { ${p}lo = ${p}net; ${p}lx = ${x} }`,
            `      }`,
            `    }`,
            `    const ${outVar} = ${p}lo;`,
        ].join('\n');
    },
    /** Names the slot-local capacityInputVar freezes (see emitLadderQuote's doc). */
    capacityInputVar(slot) {
        return `s${slot}lx`;
    },
    /** Cold final quote at the elected slice: price+fee model, or 0 past either deactivation edge
     *  (skip the CPI). */
    emitFinalQuote(base, slot, x, outVar) {
        const c = goonfiConfig(base);
        const p = `s${slot}`;
        return [
            `  let ${outVar} = 0;`,
            `  if (${x} > 0 && ${p}kq !== 0 && ${x} <= ${p}t9) {`,
            `    ${p}raw = ${rawExpr(c, p, x)};`,
            ...feeAssignLines(p, x),
            `    ${p}net = ${p}raw - Math.mulDiv(${p}raw, ${p}fee, ${FEE_DEN});`,
            `    if (${p}net <= ${p}rout) { ${outVar} = ${p}net }`,
            `  }`,
        ].join('\n');
    },
    buildSwapV2(base, slot, user) {
        const c = goonfiConfig(base);
        const yToX = c.direction === 'yToX';
        const make = (r, addr, writable) => writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
        // swap: tag(1)=1 ++ direction(1) ++ input u64 LE (runtime-patched) ++ minOut u64 LE = 1 ++
        // trailing byte = 0 (matches the real captured 19-byte instruction exactly).
        return {
            programId: GOONFI_V2_PROGRAM_ID,
            prefix: Uint8Array.from([GOONFI_SWAP_TAG, yToX ? 1 : 0]),
            suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0]),
            patch: 'in',
            accounts: goonfiSwapAccounts(c, user, make, (role) => ref(slot, role)),
        };
    },
    /** The COLD final quote (0 past either deactivation edge) — the lamport-exact target for
     *  emitFinalQuote. */
    referenceQuote(base, state, params) {
        const cfg = goonfiConfig(base);
        const live = liveState(cfg, state, params);
        return (x) => goonfiColdQuote(cfg, x, live);
    },
    /** The LAST-GOOD ladder chain — mirrors emitLadderQuote (monotone, flat past either
     *  deactivation edge). */
    referenceLadderQuotes(base, state, params) {
        const cfg = goonfiConfig(base);
        const live = liveState(cfg, state, params);
        return (grid) => referenceWalk(cfg, live, grid).outs;
    },
    /** Mirror of capacityInputVar: the cumulative PRODUCTIVE input at each grid point — freezes at
     *  the same rung referenceLadderQuotes freezes its output at (both derive from the same walk). */
    referenceCapacities(base, state, params) {
        const cfg = goonfiConfig(base);
        const live = liveState(cfg, state, params);
        return (grid) => referenceWalk(cfg, live, grid).caps;
    },
    /** Depth = the actual VAULT balances (matches every other CP-family adapter). A vault drained on
     *  either side reads 0 depth and drops out of the relative-depth filter. */
    depthReserves(base, state) {
        const cfg = goonfiConfig(base);
        const va = state[cfg.vaultA];
        const vb = state[cfg.vaultB];
        if (va === undefined || vb === undefined)
            throw new Error(`${SLUG} depth is missing a vault`);
        const ra = readUintLE(va, AMOUNT_OFF, 8);
        const rb = readUintLE(vb, AMOUNT_OFF, 8);
        return cfg.direction === 'xToY' ? { reserveIn: ra, reserveOut: rb } : { reserveIn: rb, reserveOut: ra };
    },
    /** Measurement-only oracle (never a gate): the smallest tier's fee is the near-zero-size
     *  marginal rate, the honest representative continuous fee for this venue. */
    continuousFees(base) {
        const c = goonfiConfig(base);
        const fee0 = c.feeSchedule.feeTiersPpm[0] ?? 0n;
        const feePpm = fee0 > FEE_DEN ? FEE_DEN : fee0;
        return { gammaPpm: FEE_DEN, muPpm: FEE_DEN - feePpm };
    },
};
//# sourceMappingURL=ladder.js.map