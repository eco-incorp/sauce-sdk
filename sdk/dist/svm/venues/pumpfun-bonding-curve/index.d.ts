import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadder } from '../types.js';
declare const SLUG: "pumpfun-bonding-curve";
export declare const PUMPFUN_BONDING_CURVE_PROGRAM_ID: Address;
export interface PumpfunBondingCurvePoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** exactIn side: 'quoteToBase' (default, buy_exact_quote_in_v2) | 'baseToQuote' (sell_v2). */
    direction: 'quoteToBase' | 'baseToQuote';
    baseMint: Address;
    baseTokenProgram: Address;
    creator: Address;
    protocolFeeBps: bigint;
    creatorFeeBps: bigint;
    feeRecipient: Address;
    associatedQuoteFeeRecipient: Address;
    buybackFeeRecipient: Address;
    associatedQuoteBuybackFeeRecipient: Address;
    associatedBaseBondingCurve: Address;
    associatedQuoteBondingCurve: Address;
    creatorVault: Address;
    associatedCreatorVault: Address;
    sharingConfig: Address;
}
/**
 * The user-scoped remaining PDAs the CLASSIC v1 adapter shape does not (and cannot,
 * being pool-scoped) precompute: `user_volume_accumulator` and its wSOL ATA. Every
 * caller building a real CPI (or resolving these ladder refs) must derive them from
 * the REAL trading wallet at execute/resolve time — mirroring pumpswap's
 * `USER_VOLUME_ACCUMULATOR_REF` pattern, just two refs instead of one (buy_exact_quote_in_v2
 * / sell_v2 both need the account; sell_v2 additionally needs its ATA at a
 * different fixed position — see buildSwapV2 below).
 */
export declare const PUMPFUN_BONDING_CURVE_USER_VOLUME_ACCUMULATOR_REF = "pumpfun-bonding-curve-user-volume-accumulator";
export declare const PUMPFUN_BONDING_CURVE_ASSOCIATED_USER_VOLUME_ACCUMULATOR_REF = "pumpfun-bonding-curve-associated-user-volume-accumulator";
/** PDA(["user_volume_accumulator", user], PROGRAM) — resolve at execute time with the real wallet. */
export declare function pumpfunBondingCurveUserVolumeAccumulatorPda(user: Address): Promise<Address>;
/** ATA(userVolumeAccumulator, TOKEN_PROGRAM, wSOL) — resolve at execute time with the real wallet. */
export declare function pumpfunBondingCurveAssociatedUserVolumeAccumulator(user: Address): Promise<Address>;
export declare const pumpfunBondingCurve: {
    slug: "pumpfun-bonding-curve";
    kind: "constant-product";
    programId: Address;
    /**
     * `pool` is the bonding-curve PDA (owner-verified against
     * PUMPFUN_BONDING_CURVE_PROGRAM_ID by the generic discovery/compile-path safety
     * net); `mint` is REQUIRED (see the module header on why the account can't embed
     * it) — `ecoswap/svm/index.ts`'s FAMILIES entry enforces its presence and throws
     * a named error if a caller omits it.
     */
    fetchPoolConfig(load: AccountLoader, pool: Address, mint: Address): Promise<PumpfunBondingCurvePoolConfig>;
};
export declare const pumpfunBondingCurveLadder: SvmVenueLadder;
export {};
//# sourceMappingURL=index.d.ts.map