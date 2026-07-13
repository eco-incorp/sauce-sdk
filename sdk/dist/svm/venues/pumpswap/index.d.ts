import type { Address } from '@solana/kit';
import type { AccountBytesMap, AccountLoader, PoolConfig, SwapUser, VenueAccount, VenueSwap } from '../types.js';
export declare const PUMPSWAP_PROGRAM_ID: Address<"pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA">;
/**
 * user_volume_accumulator (buy path only) is a PDA over the user's own wallet
 * address — ['user_volume_accumulator', user] under the amm program — so the
 * adapter cannot resolve it from pool state. buildSwap attaches it under this
 * ref for the caller to resolve.
 */
export declare const USER_VOLUME_ACCUMULATOR_REF = "pumpswap-user-volume-accumulator";
export interface PumpswapPoolConfig extends PoolConfig {
    venue: 'pumpswap';
    /** exactIn side: 'quoteToBase' = buy_exact_quote_in (default), 'baseToQuote' = sell. */
    direction: 'quoteToBase' | 'baseToQuote';
    baseMint: Address;
    quoteMint: Address;
    baseVault: Address;
    quoteVault: Address;
    baseTokenProgram: Address;
    quoteTokenProgram: Address;
    coinCreator: Address;
    /** creator == pump bonding curve pool-authority PDA — selects tiered fees. */
    canonical: boolean;
    /** Selected at fetch time: flat_fees, or the market-cap tier for canonical pools. */
    lpFeeBps: bigint;
    protocolFeeBps: bigint;
    creatorFeeBps: bigint;
    /** GlobalConfig.disable_flags (bit3 buy, bit4 sell). */
    disableFlags: number;
    protocolFeeRecipient: Address;
    protocolFeeRecipientTokenAccount: Address;
    coinCreatorVaultAuthority: Address;
    coinCreatorVaultAta: Address;
    /** ['pool-v2', base_mint] PDA, attached only when coin_creator is set. */
    poolV2?: Address;
    buybackFeeRecipient: Address;
    buybackFeeRecipientTokenAccount: Address;
}
export declare const pumpswapAdapter: {
    slug: string;
    kind: "constant-product";
    programId: Address<"pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA">;
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<PumpswapPoolConfig>;
    quoteAccounts(cfg: PoolConfig): VenueAccount[];
    emitQuote(cfg: PoolConfig, i: number, amountIn: bigint): string;
    buildSwap(cfg: PoolConfig, user: SwapUser, amountIn: bigint): VenueSwap;
    referenceQuote(cfg: PoolConfig, state: AccountBytesMap, amountIn: bigint, _now: bigint): bigint;
};
//# sourceMappingURL=index.d.ts.map