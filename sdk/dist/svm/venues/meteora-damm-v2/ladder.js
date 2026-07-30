import { ceilDiv, readUintLE } from '../math.js';
import { meteoraDammV2 } from './index.js';
const SLUG = 'meteora-damm-v2';
/** Constant PDA ['pool_authority'] — owner of both vaults. */
const POOL_AUTHORITY = 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC';
/** Constant PDA ['__event_authority'] (Anchor event_cpi). */
const EVENT_AUTHORITY = '3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet';
/** sha256('global:swap')[0..8]. */
const SWAP_DISCRIMINATOR = [248, 198, 158, 145, 225, 117, 135, 200];
const Q128 = 1n << 128n;
const FEE_DENOMINATOR = 1000000000n;
const MAX_FEE_NUMERATOR_V0 = 500000000n;
const MAX_FEE_NUMERATOR_V1 = 990000000n;
/**
 * "No practical cap" sentinel for the aToB capacity clamp (smin <= 1, so the
 * band can never bind): u64::MAX. Every payload amount rides a u64 cfg word,
 * so `min(x, U64_MAX)` is a no-op clamp for any real x — cheaper and just as
 * exact as branching the clamp away.
 */
const U64_MAX = (1n << 64n) - 1n;
// Pool account offsets (docs/svm-venues.md).
const OFF_CLIFF_FEE = 8;
const OFF_DYN_INITIALIZED = 56;
const OFF_DYN_VFC = 68;
const OFF_DYN_BIN_STEP = 72;
const OFF_DYN_VOLATILITY = 120;
const OFF_LIQUIDITY = 360;
const OFF_SQRT_MIN = 424;
const OFF_SQRT_MAX = 440;
const OFF_SQRT_PRICE = 456;
const OFF_COLLECT_FEE_MODE = 484;
const OFF_FEE_VERSION = 486;
function v2Config(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
const ref = (slot, role) => `s${slot}:${role}`;
/** total_fee_numerator over live pool bytes — base + stored-volatility term, version-capped. */
function liveFeeNumerator(pool) {
    let fee = readUintLE(pool, OFF_CLIFF_FEE, 8);
    if (pool[OFF_DYN_INITIALIZED] === 1) {
        const scaled = readUintLE(pool, OFF_DYN_VOLATILITY, 16) * readUintLE(pool, OFF_DYN_BIN_STEP, 2);
        fee += ceilDiv(scaled * scaled * readUintLE(pool, OFF_DYN_VFC, 4), 100000000000n);
    }
    const cap = pool[OFF_FEE_VERSION] === 0 ? MAX_FEE_NUMERATOR_V0 : MAX_FEE_NUMERATOR_V1;
    return fee > cap ? cap : fee;
}
// ---------------------------------------------------------------------------
// Closed-form capacity: the largest gross input the live band can absorb
// without qRaw collapsing. Same formulas emitted on-chain (emitSetup) and
// mirrored here — change them together or the lamport-exact gate breaks.
// Derivation (aToB): nx = ceil(L·sp/(L+x·sp)) >= smin
//   ⟺ L·sp > (smin−1)·(L+x·sp)  ⟺  x < L·(sp−smin+1) / ((smin−1)·sp)
//   ⟹ C = (L·(sp−smin+1) − 1) div ((smin−1)·sp)      [floor, smin > 1]
// Derivation (bToA, din-space): nx = sp + floor(din·2^128/L) <= smax
//   ⟺ din·2^128 < (smax−sp+1)·L  ⟹  dinCap = ceilDiv((smax−sp+1)·L, 2^128) − 1
// bToA fee-on-input (collect_fee_mode != 0) inverts din(x) = x − ceil(x·f/D)
// (non-decreasing in x for f < D, always true — the fee cap is < D) back to
// raw x-space: din(x) <= dinCap ⟺ x < D·(dinCap+1) / (D−f)
//   ⟹ xCap = ceilDiv(D·(dinCap+1), D−f) − 1
// ---------------------------------------------------------------------------
/**
 * aToB capacity: the largest gross input x with next_sqrt_price >= smin
 * (the band never violated). smin <= 1 cannot bind (nx is always >= 1) —
 * U64_MAX, the uncapped sentinel.
 */
export function meteoraDammV2CapacityAtoB(l, sp, smin) {
    if (smin <= 1n)
        return U64_MAX;
    return (l * (sp - smin + 1n) - 1n) / ((smin - 1n) * sp);
}
/** bToA capacity in fee-adjusted din-space (see derivation above). */
function bToADinCapacity(l, sp, smax) {
    return ceilDiv((smax - sp + 1n) * l, Q128) - 1n;
}
/**
 * bToA capacity in RAW x-space: dinCap directly when collect_fee_mode == 0
 * (din == x, fee charged on output); the fee-on-input inversion above
 * otherwise. `f` (the live fee numerator) is always < FEE_DENOMINATOR (the
 * version cap tops out at 990_000_000 < 1e9), so `D − f` is always positive.
 */
export function meteoraDammV2CapacityBtoA(l, sp, smax, f, cm) {
    const dinCap = bToADinCapacity(l, sp, smax);
    if (cm === 0n)
        return dinCap;
    const dMinusF = FEE_DENOMINATOR - f;
    if (dMinusF <= 0n)
        return 0n;
    return ceilDiv(FEE_DENOMINATOR * (dinCap + 1n), dMinusF) - 1n;
}
/** Raw aToB quote (no capacity clamp) — the exact body qDammV2A transcribes. */
function rawQuoteA(x, l, sp, f, smin) {
    if (x === 0n || l === 0n)
        return 0n;
    const den = l + x * sp;
    const nx = (l * sp + den - 1n) / den;
    if (nx < smin)
        return 0n; // defensive — unreachable once x is capacity-clamped
    const g = (l * (sp - nx)) / Q128;
    return g - (g * f + 999999999n) / FEE_DENOMINATOR;
}
/** Raw bToA quote (no capacity clamp) — the exact body qDammV2B transcribes. */
function rawQuoteB(x, l, sp, f, smax, cm) {
    if (x === 0n || l === 0n)
        return 0n;
    let din = x;
    if (cm !== 0n)
        din = x - (x * f + 999999999n) / FEE_DENOMINATOR;
    const nx = sp + (din * Q128) / l;
    if (nx > smax)
        return 0n; // defensive — unreachable once x is capacity-clamped
    const g = (l * (nx - sp)) / (sp * nx);
    if (cm !== 0n)
        return g;
    return g - (g * f + 999999999n) / FEE_DENOMINATOR;
}
export const meteoraDammV2Ladder = {
    slug: SLUG,
    shapeKey(base) {
        return `${SLUG}:${v2Config(base).direction}`;
    },
    helpers(base) {
        if (v2Config(base).direction === 'aToB') {
            // next = ceil(L·sp / (L + x·sp)); delta_b floors; fee ceils on OUTPUT
            // (fees are never on input for aToB). Band crossing → 0.
            return [
                {
                    name: 'qDammV2A',
                    source: [
                        'function qDammV2A(x, l, sp, f, smin) {',
                        '  if (x === 0) { return 0 }',
                        '  if (l === 0) { return 0 }',
                        '  const den = l + x * sp;',
                        '  const nx = (l * sp + den - 1) / den;',
                        '  if (nx < smin) { return 0 }',
                        `  const g = (l * (sp - nx)) / ${Q128};`,
                        '  return g - (g * f + 999999999) / 1000000000;',
                        '}',
                    ].join('\n'),
                },
            ];
        }
        // bToA: next = sp + floor(x << 128 / L); delta_a floors; fee ceils on
        // INPUT when collect_fee_mode != 0 (OnlyB), on OUTPUT when 0. The band
        // check runs BEFORE the delta so sp·nx never wraps.
        return [
            {
                name: 'qDammV2B',
                source: [
                    'function qDammV2B(x, l, sp, f, smax, cm) {',
                    '  if (x === 0) { return 0 }',
                    '  if (l === 0) { return 0 }',
                    '  let din = x;',
                    '  if (cm !== 0) { din = x - (x * f + 999999999) / 1000000000 }',
                    `  const nx = sp + (din * ${Q128}) / l;`,
                    '  if (nx > smax) { return 0 }',
                    '  const g = (l * (nx - sp)) / (sp * nx);',
                    '  if (cm !== 0) { return g }',
                    '  return g - (g * f + 999999999) / 1000000000;',
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
        return [{ ref: ref(slot, 'pool'), address: v2Config(base).pool }];
    },
    emitSetup(base, slot) {
        const cfg = v2Config(base);
        const pool = JSON.stringify(ref(slot, 'pool'));
        const lines = [
            `  const s${slot}l = accountUint(${pool}, ${OFF_LIQUIDITY}, 16);`,
            `  const s${slot}sp = accountUint(${pool}, ${OFF_SQRT_PRICE}, 16);`,
            `  let s${slot}f = accountUint(${pool}, ${OFF_CLIFF_FEE}, 8);`,
            `  if (accountUint(${pool}, ${OFF_DYN_INITIALIZED}, 1) === 1) {`,
            `    const s${slot}v = accountUint(${pool}, ${OFF_DYN_VOLATILITY}, 16) * accountUint(${pool}, ${OFF_DYN_BIN_STEP}, 2);`,
            `    s${slot}f = s${slot}f + (s${slot}v * s${slot}v * accountUint(${pool}, ${OFF_DYN_VFC}, 4) + 99999999999) / 100000000000;`,
            '  }',
            `  let s${slot}cap = ${MAX_FEE_NUMERATOR_V0};`,
            `  if (accountUint(${pool}, ${OFF_FEE_VERSION}, 1) !== 0) { s${slot}cap = ${MAX_FEE_NUMERATOR_V1} }`,
            `  if (s${slot}f > s${slot}cap) { s${slot}f = s${slot}cap }`,
        ];
        if (cfg.direction === 'aToB') {
            lines.push(`  const s${slot}mn = accountUint(${pool}, ${OFF_SQRT_MIN}, 16);`, 
            // Capacity: largest x with next_sqrt_price >= smin (see the file
            // header derivation). smin <= 1 cannot bind — uncapped (U64_MAX).
            `  let s${slot}icap = ${U64_MAX};`, `  if (s${slot}mn > 1) {`, `    s${slot}icap = (s${slot}l * (s${slot}sp - s${slot}mn + 1) - 1) / ((s${slot}mn - 1) * s${slot}sp);`, '  }', `  let s${slot}cx = 0;`);
        }
        else {
            lines.push(`  const s${slot}mx = accountUint(${pool}, ${OFF_SQRT_MAX}, 16);`, `  const s${slot}cm = accountUint(${pool}, ${OFF_COLLECT_FEE_MODE}, 1);`, 
            // Capacity in fee-adjusted din-space, then inverted to raw x-space
            // when the fee is charged on input (see the file header derivation).
            // f is always < 1e9 (the version cap tops out at 990_000_000), so
            // the fee-on-input divisor below is always positive.
            `  const s${slot}idcap = ((s${slot}mx - s${slot}sp + 1) * s${slot}l + ${Q128} - 1) / ${Q128} - 1;`, `  let s${slot}ixcap = s${slot}idcap;`, `  if (s${slot}cm !== 0) {`, `    const s${slot}dmf = 1000000000 - s${slot}f;`, `    s${slot}ixcap = (1000000000 * (s${slot}idcap + 1) + s${slot}dmf - 1) / s${slot}dmf - 1;`, '  }', `  let s${slot}cx = 0;`);
        }
        return lines.join('\n');
    },
    capacityInputVar(slot) {
        return `s${slot}cx`;
    },
    /**
     * Statement-mode rung: clamp x to the closed-form capacity, THEN call the
     * (still band-checked, now-defensive) helper — qRaw(min(x, C)) saturates
     * instead of the old pointwise qRaw(x) collapsing past C. `rung` is unused
     * (no warm-start state to thread — every rung is an independent closed-form
     * evaluation, byte-identical to the cold quote at that grid point).
     */
    emitLadderQuote(base, slot, _rung, x, outVar) {
        const cfg = v2Config(base);
        const p = `s${slot}`;
        if (cfg.direction === 'aToB') {
            return [
                `    ${p}cx = ${x};`,
                `    if (${p}cx > ${p}icap) { ${p}cx = ${p}icap }`,
                `    const ${outVar} = qDammV2A(${p}cx, ${p}l, ${p}sp, ${p}f, ${p}mn);`,
            ].join('\n');
        }
        return [
            `    ${p}cx = ${x};`,
            `    if (${p}cx > ${p}ixcap) { ${p}cx = ${p}ixcap }`,
            `    const ${outVar} = qDammV2B(${p}cx, ${p}l, ${p}sp, ${p}f, ${p}mx, ${p}cm);`,
        ].join('\n');
    },
    /** Cold final quote — same capacity clamp, fresh locals (no rung state to reuse). */
    emitFinalQuote(base, slot, x, outVar) {
        const cfg = v2Config(base);
        const p = `s${slot}`;
        if (cfg.direction === 'aToB') {
            return [
                `  let ${p}fcx = ${x};`,
                `  if (${p}fcx > ${p}icap) { ${p}fcx = ${p}icap }`,
                `  const ${outVar} = qDammV2A(${p}fcx, ${p}l, ${p}sp, ${p}f, ${p}mn);`,
            ].join('\n');
        }
        return [
            `  let ${p}fcx = ${x};`,
            `  if (${p}fcx > ${p}ixcap) { ${p}fcx = ${p}ixcap }`,
            `  const ${outVar} = qDammV2B(${p}fcx, ${p}l, ${p}sp, ${p}f, ${p}mx, ${p}cm);`,
        ].join('\n');
    },
    buildSwapV2(base, slot, user) {
        const cfg = v2Config(base);
        // swap: disc(8) ++ amount_in u64 LE (runtime-patched) ++
        // minimum_amount_out u64 LE = 1.
        const roled = (role, addr, writable) => writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
        return {
            programId: meteoraDammV2.programId,
            prefix: Uint8Array.from(SWAP_DISCRIMINATOR),
            suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
            patch: 'in',
            accounts: [
                roled('auth', POOL_AUTHORITY),
                roled('pool', cfg.pool, true),
                { ref: user.inAta, writable: true },
                { ref: user.outAta, writable: true },
                roled('va', cfg.tokenAVault, true),
                roled('vb', cfg.tokenBVault, true),
                roled('ma', cfg.tokenAMint),
                roled('mb', cfg.tokenBMint),
                { ref: user.owner, signer: true },
                roled('tpa', cfg.tokenAProgram),
                roled('tpb', cfg.tokenBProgram),
                // Anchor-optional referral_token_account: the program id readonly is
                // the none-placeholder.
                roled('prog', meteoraDammV2.programId),
                roled('evt', EVENT_AUTHORITY),
                roled('prog', meteoraDammV2.programId),
            ],
        };
    },
    referenceQuote(base, state, _params) {
        const cfg = v2Config(base);
        const pool = state[cfg.pool];
        if (pool === undefined)
            throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
        const l = readUintLE(pool, OFF_LIQUIDITY, 16);
        const sp = readUintLE(pool, OFF_SQRT_PRICE, 16);
        const f = liveFeeNumerator(pool);
        if (cfg.direction === 'aToB') {
            const smin = readUintLE(pool, OFF_SQRT_MIN, 16);
            const cap = meteoraDammV2CapacityAtoB(l, sp, smin);
            return (x) => rawQuoteA(x > cap ? cap : x, l, sp, f, smin);
        }
        const smax = readUintLE(pool, OFF_SQRT_MAX, 16);
        const cm = BigInt(pool[OFF_COLLECT_FEE_MODE]);
        const cap = meteoraDammV2CapacityBtoA(l, sp, smax, f, cm);
        return (x) => rawQuoteB(x > cap ? cap : x, l, sp, f, smax, cm);
    },
    /**
     * Cumulative productive input per ORDERED grid point — `min(g, C)`. Every
     * rung's dIn folds to its in-band portion (0 once fully past C), mirroring
     * `capacityInputVar` lamport-for-lamport (see the file header derivation).
     */
    referenceCapacities(base, state, _params) {
        const cfg = v2Config(base);
        const pool = state[cfg.pool];
        if (pool === undefined)
            throw new Error(`${SLUG} ladder reference is missing account ${cfg.pool}`);
        const l = readUintLE(pool, OFF_LIQUIDITY, 16);
        const sp = readUintLE(pool, OFF_SQRT_PRICE, 16);
        let cap;
        if (cfg.direction === 'aToB') {
            const smin = readUintLE(pool, OFF_SQRT_MIN, 16);
            cap = meteoraDammV2CapacityAtoB(l, sp, smin);
        }
        else {
            const smax = readUintLE(pool, OFF_SQRT_MAX, 16);
            const f = liveFeeNumerator(pool);
            const cm = BigInt(pool[OFF_COLLECT_FEE_MODE]);
            cap = meteoraDammV2CapacityBtoA(l, sp, smax, f, cm);
        }
        return (grid) => grid.map((g) => (g > cap ? cap : g));
    },
    /**
     * Full-range CP-equivalent VIRTUAL reserves at the live spot (Q64.64
     * sqrt_price): a = L·2^64/sp, b = L·sp/2^64 — so isqrt(a·b) == L, the
     * canonical CLMM depth. Locally exact for the single-step in-band quote; a
     * concentrated pool's virtual depth overstates its vault balances, which
     * only ever ADMITS such a pool (the filter is relative) — the band clamp
     * in the quote keeps the math honest.
     */
    depthReserves(base, state) {
        const cfg = v2Config(base);
        const pool = state[cfg.pool];
        if (pool === undefined)
            throw new Error(`${SLUG} ladder depth is missing account ${cfg.pool}`);
        const l = readUintLE(pool, OFF_LIQUIDITY, 16);
        const sp = readUintLE(pool, OFF_SQRT_PRICE, 16);
        if (sp === 0n)
            return { reserveIn: 0n, reserveOut: 0n };
        const a = (l << 64n) / sp;
        const b = (l * sp) >> 64n;
        return cfg.direction === 'aToB' ? { reserveIn: a, reserveOut: b } : { reserveIn: b, reserveOut: a };
    },
    continuousFees(base, state) {
        const cfg = v2Config(base);
        const pool = state[cfg.pool];
        if (pool === undefined)
            throw new Error(`${SLUG} ladder fees are missing account ${cfg.pool}`);
        const feePpm = liveFeeNumerator(pool) / 1000n; // 1e9-denominated → ppm
        const feesOnInput = cfg.direction === 'bToA' && pool[OFF_COLLECT_FEE_MODE] !== 0;
        return feesOnInput
            ? { gammaPpm: 1000000n - feePpm, muPpm: 1000000n }
            : { gammaPpm: 1000000n, muPpm: 1000000n - feePpm };
    },
};
//# sourceMappingURL=ladder.js.map