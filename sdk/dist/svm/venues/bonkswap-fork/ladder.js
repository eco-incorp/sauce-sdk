import { bonkswapForkConfig, bonkswapReadUintLE, BONKSWAP_PROGRAM_AUTHORITY, BONKSWAP_PROGRAM_ID, BONKSWAP_STATE, FEE_DENOMINATOR, GUACSWAP_PROGRAM_AUTHORITY, GUACSWAP_PROGRAM_ID, GUACSWAP_STATE, OFF_TOKEN_X_RESERVE, OFF_TOKEN_Y_RESERVE, } from './index.js';
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const ref = (slug, slot, role) => `${slug}:s${slot}:${role}`;
/** Ceiling division: smallest q with q * b >= a. Non-negative dividends/positive divisors only. */
function ceilDiv(a, b) {
    return (a + b - 1n) / b;
}
/**
 * One ladder per deployed Bonkswap fork — same math/CPI shape (see module
 * header), parameterized by the fork's own program id + PDAs.
 */
export function makeBonkswapForkLadder(slug, programId, programAuthority, state) {
    return {
        slug,
        shapeKey(base) {
            const cfg = bonkswapForkConfig(slug, base);
            return `${slug}:${cfg.direction}`;
        },
        helpers() {
            return [
                {
                    name: 'qBonkswapFork',
                    source: [
                        'function qBonkswapFork(x, rin, rout, kHi, kLo, lpFee, buybackFee, projectFee) {',
                        '  if (x === 0) { return 0 }',
                        '  const k = (kHi << 64) | kLo;',
                        '  const denom = x + rin;',
                        '  const fraction = (k + denom - 1) / denom;',
                        '  if (fraction >= rout) { return 0 }',
                        '  const deltaOut = rout - fraction;',
                        `  const lpFeeAmt = (deltaOut * lpFee + ${FEE_DENOMINATOR - 1n}) / ${FEE_DENOMINATOR};`,
                        `  const buybackFeeAmt = (deltaOut * buybackFee + ${FEE_DENOMINATOR - 1n}) / ${FEE_DENOMINATOR};`,
                        `  const projectFeeAmt = (deltaOut * projectFee + ${FEE_DENOMINATOR - 1n}) / ${FEE_DENOMINATOR};`,
                        '  const totalFee = lpFeeAmt + buybackFeeAmt + projectFeeAmt;',
                        '  if (totalFee >= deltaOut) { return 0 }',
                        '  return deltaOut - totalFee;',
                        '}',
                    ].join('\n'),
                },
            ];
        },
        /** constK hi/lo + lpFee + buybackFee + projectFee — mercantiFee is excluded (see module header). */
        paramCount: 5,
        paramsFor(base) {
            const cfg = bonkswapForkConfig(slug, base);
            return [cfg.constKHi, cfg.constKLo, cfg.lpFee, cfg.buybackFee, cfg.projectFee];
        },
        quoteRefs(base, slot) {
            const cfg = bonkswapForkConfig(slug, base);
            return [{ ref: ref(slug, slot, 'pool'), address: cfg.pool }];
        },
        emitSetup(base, slot, params) {
            const cfg = bonkswapForkConfig(slug, base);
            const xToY = cfg.direction === 'xToY';
            const pool = JSON.stringify(ref(slug, slot, 'pool'));
            const [inOff, outOff] = xToY ? [OFF_TOKEN_X_RESERVE, OFF_TOKEN_Y_RESERVE] : [OFF_TOKEN_Y_RESERVE, OFF_TOKEN_X_RESERVE];
            const [kHi, kLo, lpFee, buybackFee, projectFee] = params;
            return [
                `  const s${slot}rin = accountUint(${pool}, ${inOff}, 8);`,
                `  const s${slot}rout = accountUint(${pool}, ${outOff}, 8);`,
                `  const s${slot}khi = ${kHi};`,
                `  const s${slot}klo = ${kLo};`,
                `  const s${slot}lpfee = ${lpFee};`,
                `  const s${slot}bbfee = ${buybackFee};`,
                `  const s${slot}pjfee = ${projectFee};`,
            ].join('\n');
        },
        emitQuoteCall(_base, slot, x) {
            return `qBonkswapFork(${x}, s${slot}rin, s${slot}rout, s${slot}khi, s${slot}klo, s${slot}lpfee, s${slot}bbfee, s${slot}pjfee)`;
        },
        buildSwapV2(base, slot, user) {
            const cfg = bonkswapForkConfig(slug, base);
            const xToY = cfg.direction === 'xToY';
            const swapperXAccount = xToY ? user.inAta : user.outAta;
            const swapperYAccount = xToY ? user.outAta : user.inAta;
            // deltaIn: Token(u64, patched at runtime) ++ priceLimit: FixedPoint(u128) ++ xToY: bool.
            // priceLimit disables the venue-native check: 0 is a no-op MINIMUM for
            // xToY (price only falls when selling X), u128::MAX is a no-op MAXIMUM
            // for !xToY (price only rises when selling Y) — see ./index.ts's
            // PRICE LIMIT section. minOut protection is the recipe's own terminal
            // outAta delta check, same convention as every other wired ladder.
            const priceLimit = xToY ? 0n : U128_MAX;
            const priceLimitBuf = new Uint8Array(16);
            new DataView(priceLimitBuf.buffer).setBigUint64(0, priceLimit & U64_MAX, true);
            new DataView(priceLimitBuf.buffer).setBigUint64(8, priceLimit >> 64n, true);
            const suffix = new Uint8Array(17);
            suffix.set(priceLimitBuf, 0);
            suffix[16] = xToY ? 1 : 0;
            const roled = (role, addr, writable) => writable ? { ref: ref(slug, slot, role), address: addr, writable: true } : { ref: ref(slug, slot, role), address: addr };
            return {
                programId,
                // sha256("global:swap")[0..8].
                prefix: Uint8Array.from([0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]),
                suffix,
                patch: 'in',
                accounts: [
                    roled('state', state),
                    roled('pool', cfg.pool, true),
                    roled('tx', cfg.tokenX),
                    roled('ty', cfg.tokenY),
                    roled('vx', cfg.poolXAccount, true),
                    roled('vy', cfg.poolYAccount, true),
                    { ref: swapperXAccount, writable: true },
                    { ref: swapperYAccount, writable: true },
                    { ref: user.owner, signer: true, writable: true },
                    // Self-referral (see ./index.ts's SELF-REFERRAL section): the
                    // mercanti-fee leg pays out to these same accounts.
                    { ref: swapperXAccount, writable: true },
                    { ref: swapperYAccount, writable: true },
                    { ref: user.owner, writable: true },
                    roled('auth', programAuthority),
                    roled('sys', '11111111111111111111111111111111'),
                    roled('tp', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
                    roled('atp', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
                    roled('rent', 'SysvarRent111111111111111111111111111111111'),
                ],
            };
        },
        referenceQuote(base, state, params) {
            const cfg = bonkswapForkConfig(slug, base);
            const xToY = cfg.direction === 'xToY';
            const bytes = (addr) => {
                const data = state[addr];
                if (data === undefined)
                    throw new Error(`${slug} ladder reference is missing account ${addr}`);
                return data;
            };
            const pool = bytes(cfg.pool);
            const [inOff, outOff] = xToY ? [OFF_TOKEN_X_RESERVE, OFF_TOKEN_Y_RESERVE] : [OFF_TOKEN_Y_RESERVE, OFF_TOKEN_X_RESERVE];
            const rin = bonkswapReadUintLE(pool, inOff, 8);
            const rout = bonkswapReadUintLE(pool, outOff, 8);
            const [kHi, kLo, lpFee, buybackFee, projectFee] = params;
            const k = (kHi << 64n) | kLo;
            return (x) => {
                if (x === 0n)
                    return 0n;
                const denom = x + rin;
                const fraction = ceilDiv(k, denom);
                if (fraction >= rout)
                    return 0n;
                const deltaOut = rout - fraction;
                const totalFee = ceilDiv(deltaOut * lpFee, FEE_DENOMINATOR) + ceilDiv(deltaOut * buybackFee, FEE_DENOMINATOR) + ceilDiv(deltaOut * projectFee, FEE_DENOMINATOR);
                if (totalFee >= deltaOut)
                    return 0n;
                return deltaOut - totalFee;
            };
        },
        depthReserves(base, state) {
            const cfg = bonkswapForkConfig(slug, base);
            const xToY = cfg.direction === 'xToY';
            const pool = state[cfg.pool];
            if (pool === undefined)
                throw new Error(`${slug} ladder depth is missing account ${cfg.pool}`);
            const [inOff, outOff] = xToY ? [OFF_TOKEN_X_RESERVE, OFF_TOKEN_Y_RESERVE] : [OFF_TOKEN_Y_RESERVE, OFF_TOKEN_X_RESERVE];
            return { reserveIn: bonkswapReadUintLE(pool, inOff, 8), reserveOut: bonkswapReadUintLE(pool, outOff, 8) };
        },
        continuousFees(base) {
            const cfg = bonkswapForkConfig(slug, base);
            const totalFeePpt = cfg.lpFee + cfg.buybackFee + cfg.projectFee;
            // FEE_DENOMINATOR is 1e12 (ppt); the oracle wants ppm (1e6) — scale down.
            const totalFeePpm = totalFeePpt / 1000000n;
            return { gammaPpm: 1000000n - totalFeePpm, muPpm: 1000000n };
        },
    };
}
export const bonkswapForkPriceLimitU128Max = U128_MAX;
export const bonkswapLadder = makeBonkswapForkLadder('bonkswap', BONKSWAP_PROGRAM_ID, BONKSWAP_PROGRAM_AUTHORITY, BONKSWAP_STATE);
export const guacswapLadder = makeBonkswapForkLadder('guacswap', GUACSWAP_PROGRAM_ID, GUACSWAP_PROGRAM_AUTHORITY, GUACSWAP_STATE);
//# sourceMappingURL=ladder.js.map