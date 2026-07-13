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
            lines.push(`  const s${slot}mn = accountUint(${pool}, ${OFF_SQRT_MIN}, 16);`);
        }
        else {
            lines.push(`  const s${slot}mx = accountUint(${pool}, ${OFF_SQRT_MAX}, 16);`, `  const s${slot}cm = accountUint(${pool}, ${OFF_COLLECT_FEE_MODE}, 1);`);
        }
        return lines.join('\n');
    },
    emitQuoteCall(base, slot, x) {
        return v2Config(base).direction === 'aToB'
            ? `qDammV2A(${x}, s${slot}l, s${slot}sp, s${slot}f, s${slot}mn)`
            : `qDammV2B(${x}, s${slot}l, s${slot}sp, s${slot}f, s${slot}mx, s${slot}cm)`;
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
            return (x) => {
                if (x === 0n || l === 0n)
                    return 0n;
                const den = l + x * sp;
                const nx = (l * sp + den - 1n) / den;
                if (nx < smin)
                    return 0n;
                const g = (l * (sp - nx)) / Q128;
                return g - (g * f + 999999999n) / FEE_DENOMINATOR;
            };
        }
        const smax = readUintLE(pool, OFF_SQRT_MAX, 16);
        const cm = BigInt(pool[OFF_COLLECT_FEE_MODE]);
        return (x) => {
            if (x === 0n || l === 0n)
                return 0n;
            let din = x;
            if (cm !== 0n)
                din = x - (x * f + 999999999n) / FEE_DENOMINATOR;
            const nx = sp + (din * Q128) / l;
            if (nx > smax)
                return 0n;
            const g = (l * (nx - sp)) / (sp * nx);
            if (cm !== 0n)
                return g;
            return g - (g * f + 999999999n) / FEE_DENOMINATOR;
        };
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