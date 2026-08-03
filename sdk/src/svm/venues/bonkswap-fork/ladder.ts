/**
 * Bonkswap / Guacswap LADDER fragments (SvmRoute adapter contract v2) — see
 * ./index.ts's module header for the shared account layout / swap-ix / fee
 * rationale. One factory instantiated per deployed fork; only the swap CPI's
 * `programId` (buildSwapV2) and the fork's own `programAuthority`/`state`
 * PDAs differ per fork.
 *
 * MATH — a shifted constant-product curve (the reference BonkLabs
 * `bonkswap-amm-integration` SDK's own `getDeltaOut`):
 *
 *   fraction = constK / (reserveIn + x)
 *   deltaOut = reserveOut - fraction
 *   fee_i    = ceil(deltaOut * feeRate_i / 1e12)   for i in {lp, buyback, project, mercanti}
 *   out      = deltaOut - sum(fee_i)
 *
 * ONE PLACE THIS FRAGMENT CORRECTS THE REFERENCE SDK: the reference computes
 * `fraction` with FLOOR division (`constK.div(denominator)`), but the real
 * deployed program uses CEILING division there — proven via a REAL-CPI
 * LiteSVM run against both dumped binaries (bonkswap.so and guacswap.so) at
 * 2 directions x 3 sizes (spanning ~0.001 to ~500B raw-unit inputs) on a
 * mercanti-fee-zero Bonkswap pool AND a mercanti-fee-nonzero Guacswap pool:
 * the reference (floor) formula was off by EXACTLY 1 unit of output in
 * every one of the 12 cases before this correction, and bit-exact in all 12
 * after it (see test/svm/venues/bonkswap-fork.test.ts's "ceiling correction"
 * cases for the pinned real-binary numbers). `ceil(constK/denom)` is
 * `(constK + denom - 1) / denom` — safe for any denom > 0, which every live
 * pool guarantees (reserveIn > 0, x >= 0).
 *
 * MERCANTI FEE IS EXCLUDED FROM THE PREDICTED OUTPUT, DELIBERATELY: the
 * on-chain `swap` instruction always pays `mercantiFee`'s slice of `deltaOut`
 * out as a real SPL transfer to whatever `referrerXAccount`/`referrerYAccount`
 * the caller supplies (see ./index.ts's SELF-REFERRAL section) — this
 * ladder's `buildSwapV2` always points those at the SAME accounts as the
 * swapper's own (`referrer = swapper`), so the mercanti-fee leg rebates back
 * to the trade. Predicting `deltaOut - lpFee - buybackFee - projectFee`
 * (mercantiFee held back) is therefore the BIT-EXACT realized output for
 * THIS adapter's own swap construction, confirmed via the same real-CPI run
 * above (self-referral case matches this 3-fee model exactly; a control run
 * with an unrelated external referrer instead matches the naive 4-fee model
 * exactly, confirming the mechanism rather than assuming it).
 *
 * `constK` (Product, u128) is baked at fetch time as two u64 params (hi/lo),
 * reconstructed in the fragment via `(hi << 64) | lo` — identical pattern to
 * obric-v2's `bigK` (`@eco-incorp/sauce-sdk/svm`'s obric-v2 ladder): it is a
 * liquidity-event invariant (changed only by add/remove-liquidity, never by
 * a swap), so baking it avoids a live u128 account read on every quote while
 * the live reserves (which DO move every swap) are still read fresh in
 * emitSetup. Fee rates are likewise admin-configured constants, baked the
 * same way.
 */
import type { Address } from '@solana/kit';
import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SvmVenueLadder, SwapUser, VenueAccount } from '../types.js';
import {
  bonkswapForkConfig,
  bonkswapReadUintLE,
  BONKSWAP_PROGRAM_AUTHORITY,
  BONKSWAP_PROGRAM_ID,
  BONKSWAP_STATE,
  FEE_DENOMINATOR,
  GUACSWAP_PROGRAM_AUTHORITY,
  GUACSWAP_PROGRAM_ID,
  GUACSWAP_STATE,
  OFF_TOKEN_X_RESERVE,
  OFF_TOKEN_Y_RESERVE,
} from './index.js';

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

const ref = (slug: string, slot: number, role: string): string => `${slug}:s${slot}:${role}`;

/** Ceiling division: smallest q with q * b >= a. Non-negative dividends/positive divisors only. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * One ladder per deployed Bonkswap fork — same math/CPI shape (see module
 * header), parameterized by the fork's own program id + PDAs.
 */
export function makeBonkswapForkLadder(slug: string, programId: Address, programAuthority: Address, state: Address): SvmVenueLadder {
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
    buildSwapV2(base, slot, user: SwapUser): LadderSwapTemplate {
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

      const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
        writable ? { ref: ref(slug, slot, role), address: addr, writable: true } : { ref: ref(slug, slot, role), address: addr };
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
          roled('sys', '11111111111111111111111111111111' as Address),
          roled('tp', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address),
          roled('atp', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' as Address),
          roled('rent', 'SysvarRent111111111111111111111111111111111' as Address),
        ],
      };
    },
    referenceQuote(base, state: AccountBytesMap, params: readonly bigint[]) {
      const cfg = bonkswapForkConfig(slug, base);
      const xToY = cfg.direction === 'xToY';
      const bytes = (addr: Address): Uint8Array => {
        const data = state[addr];
        if (data === undefined) throw new Error(`${slug} ladder reference is missing account ${addr}`);
        return data;
      };
      const pool = bytes(cfg.pool);
      const [inOff, outOff] = xToY ? [OFF_TOKEN_X_RESERVE, OFF_TOKEN_Y_RESERVE] : [OFF_TOKEN_Y_RESERVE, OFF_TOKEN_X_RESERVE];
      const rin = bonkswapReadUintLE(pool, inOff, 8);
      const rout = bonkswapReadUintLE(pool, outOff, 8);
      const [kHi, kLo, lpFee, buybackFee, projectFee] = params;
      const k = (kHi << 64n) | kLo;
      return (x: bigint): bigint => {
        if (x === 0n) return 0n;
        const denom = x + rin;
        const fraction = ceilDiv(k, denom);
        if (fraction >= rout) return 0n;
        const deltaOut = rout - fraction;
        const totalFee = ceilDiv(deltaOut * lpFee, FEE_DENOMINATOR) + ceilDiv(deltaOut * buybackFee, FEE_DENOMINATOR) + ceilDiv(deltaOut * projectFee, FEE_DENOMINATOR);
        if (totalFee >= deltaOut) return 0n;
        return deltaOut - totalFee;
      };
    },
    depthReserves(base, state: AccountBytesMap) {
      const cfg = bonkswapForkConfig(slug, base);
      const xToY = cfg.direction === 'xToY';
      const pool = state[cfg.pool];
      if (pool === undefined) throw new Error(`${slug} ladder depth is missing account ${cfg.pool}`);
      const [inOff, outOff] = xToY ? [OFF_TOKEN_X_RESERVE, OFF_TOKEN_Y_RESERVE] : [OFF_TOKEN_Y_RESERVE, OFF_TOKEN_X_RESERVE];
      return { reserveIn: bonkswapReadUintLE(pool, inOff, 8), reserveOut: bonkswapReadUintLE(pool, outOff, 8) };
    },
    continuousFees(base: PoolConfig) {
      const cfg = bonkswapForkConfig(slug, base);
      const totalFeePpt = cfg.lpFee + cfg.buybackFee + cfg.projectFee;
      // FEE_DENOMINATOR is 1e12 (ppt); the oracle wants ppm (1e6) — scale down.
      const totalFeePpm = totalFeePpt / 1_000_000n;
      return { gammaPpm: 1_000_000n - totalFeePpm, muPpm: 1_000_000n };
    },
  };
}

export const bonkswapForkPriceLimitU128Max = U128_MAX;

export const bonkswapLadder = makeBonkswapForkLadder('bonkswap', BONKSWAP_PROGRAM_ID, BONKSWAP_PROGRAM_AUTHORITY, BONKSWAP_STATE);
export const guacswapLadder = makeBonkswapForkLadder('guacswap', GUACSWAP_PROGRAM_ID, GUACSWAP_PROGRAM_AUTHORITY, GUACSWAP_STATE);
