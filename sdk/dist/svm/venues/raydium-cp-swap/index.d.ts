import type { Address } from '@solana/kit';
import type { AccountBytesMap, AccountLoader, PoolConfig, SwapUser, VenueAccount, VenueSwap } from '../types.js';
declare const SLUG = "raydium-cp-swap";
export interface RaydiumCpSwapPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    ammConfig: Address;
    token0Vault: Address;
    token1Vault: Address;
    token0Mint: Address;
    token1Mint: Address;
    token0Program: Address;
    token1Program: Address;
    observation: Address;
    /** Bitfield; bit2 (value 4) = swap disabled. Gated at fetch time. */
    status: number;
    /** Unix seconds; the program rejects swaps while now < openTime. */
    openTime: bigint;
    /** 0 = BothToken (creator fee on input), 1 = OnlyToken0, 2 = OnlyToken1. */
    creatorFeeOn: number;
    /** When false the effective creator fee rate is 0 regardless of AmmConfig. */
    enableCreatorFee: boolean;
    /** AmmConfig.trade_fee_rate, parts per 1e6 of amount_in (snapshot; the quote re-reads it live). */
    tradeFeeRate: bigint;
    /** AmmConfig.creator_fee_rate, parts per 1e6 (snapshot; the quote re-reads it live). */
    creatorFeeRate: bigint;
    /** Swap direction: true = ZeroForOne (token_0 in, token_1 out). fetchPoolConfig defaults to true; flip for the reverse direction. */
    inputIsToken0: boolean;
}
export declare const raydiumCpSwap: {
    slug: string;
    kind: "constant-product";
    programId: Address<"CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C">;
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<RaydiumCpSwapPoolConfig>;
    quoteAccounts(base: PoolConfig): VenueAccount[];
    emitQuote(base: PoolConfig, i: number, amountIn: bigint): string;
    buildSwap(base: PoolConfig, user: SwapUser, amountIn: bigint): VenueSwap;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, amountIn: bigint, now: bigint): bigint;
};
export {};
//# sourceMappingURL=index.d.ts.map