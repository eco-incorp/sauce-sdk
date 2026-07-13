import type { Address } from '@solana/kit';
import type { AccountBytesMap, AccountLoader, PoolConfig, SwapUser, VenueAccount, VenueSwap } from '../types.js';
declare const SLUG = "meteora-damm-v2";
export interface MeteoraDammV2PoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /**
     * Trade direction: 'aToB' when the input mint is tokenAMint (the default —
     * fetchPoolConfig cannot see the trade). Callers flip this to 'bToA' when
     * the input mint is tokenBMint; the mints are exposed for that decision.
     */
    direction: 'aToB' | 'bToA';
    tokenAMint: Address;
    tokenBMint: Address;
    tokenAVault: Address;
    tokenBVault: Address;
    tokenAProgram: Address;
    tokenBProgram: Address;
    /** 0 = BothToken (fee on output), 1 = OnlyB (fee on input for bToA). */
    collectFeeMode: number;
    /** Static base trade-fee numerator over 1e9. */
    cliffFeeNumerator: bigint;
    /** Fee cap by fee_version: 5e8 (v0) or 9.9e8 (v1). */
    maxFeeNumerator: bigint;
    /**
     * Non-null when dynamic_fee.initialized == 1: the quote adds
     * ceil((volatility_accumulator * binStep)^2 * variableFeeControl / 1e11)
     * to the base fee (exact only within filter_period — the program refreshes
     * volatility references from elapsed time pre-swap).
     */
    dynamicFee: {
        binStep: bigint;
        variableFeeControl: bigint;
    } | null;
    activationPoint: bigint;
    /** 0 = slot, 1 = unix timestamp — the unit of activationPoint. */
    activationType: number;
    sqrtMinPrice: bigint;
    sqrtMaxPrice: bigint;
    /** Snapshot at fetch time (the quote re-reads it live). */
    liquidity: bigint;
    /** Snapshot at fetch time (the quote re-reads it live). */
    sqrtPrice: bigint;
}
export declare const meteoraDammV2: {
    slug: string;
    kind: "sqrt-price";
    programId: Address<"cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG">;
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<MeteoraDammV2PoolConfig>;
    quoteAccounts(cfg: PoolConfig): VenueAccount[];
    emitQuote(cfg: PoolConfig, i: number, amountIn: bigint): string;
    buildSwap(cfg: PoolConfig, user: SwapUser, amountIn: bigint): VenueSwap;
    referenceQuote(cfg: PoolConfig, state: AccountBytesMap, amountIn: bigint, now: bigint): bigint;
};
export {};
//# sourceMappingURL=index.d.ts.map