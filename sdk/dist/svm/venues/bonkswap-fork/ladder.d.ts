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
import type { SvmVenueLadder } from '../types.js';
/**
 * One ladder per deployed Bonkswap fork — same math/CPI shape (see module
 * header), parameterized by the fork's own program id + PDAs.
 */
export declare function makeBonkswapForkLadder(slug: string, programId: Address, programAuthority: Address, state: Address): SvmVenueLadder;
export declare const bonkswapForkPriceLimitU128Max: bigint;
export declare const bonkswapLadder: SvmVenueLadder;
export declare const guacswapLadder: SvmVenueLadder;
//# sourceMappingURL=ladder.d.ts.map