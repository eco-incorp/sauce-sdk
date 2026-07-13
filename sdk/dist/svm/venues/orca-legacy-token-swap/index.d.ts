import type { Address } from '@solana/kit';
import type { AccountBytesMap, AccountLoader, PoolConfig, SwapUser, VenueAccount, VenueSwap } from '../types.js';
declare const SLUG = "orca-legacy-token-swap";
export interface OrcaLegacyPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** Swap-authority PDA: create_program_address([pool, [bump_seed@2]], program). */
    swapAuthority: Address;
    /** token_program_id @3. */
    tokenProgram: Address;
    /** Vault of the input mint (token_a @35 — quote direction is A → B). */
    vaultIn: Address;
    /** Vault of the output mint (token_b @67). */
    vaultOut: Address;
    /** pool_mint @99 — writable in the swap ix (owner fee is minted as LP tokens). */
    poolMint: Address;
    /** pool_fee_account @195 — pool-mint token account receiving the owner fee. */
    poolFeeAccount: Address;
    /** token_a_mint @131. */
    inputMint: Address;
    /** token_b_mint @163. */
    outputMint: Address;
    /** trade_fee_numerator @227 / trade_fee_denominator @235 (25/10000 on the fixture). */
    tradeFeeNumerator: bigint;
    tradeFeeDenominator: bigint;
    /** owner_trade_fee_numerator @243 / owner_trade_fee_denominator @251 (5/10000 on the fixture). */
    ownerTradeFeeNumerator: bigint;
    ownerTradeFeeDenominator: bigint;
    /** bump_seed @2 — the stored (not necessarily canonical) swap-authority nonce. */
    bumpSeed: number;
}
export declare const orcaLegacyTokenSwap: {
    slug: string;
    kind: "constant-product";
    programId: Address;
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<OrcaLegacyPoolConfig>;
    quoteAccounts(cfg: OrcaLegacyPoolConfig): VenueAccount[];
    emitQuote(cfg: OrcaLegacyPoolConfig, i: number, amountIn: bigint): string;
    buildSwap(cfg: OrcaLegacyPoolConfig, user: SwapUser, amountIn: bigint): VenueSwap;
    referenceQuote(cfg: OrcaLegacyPoolConfig, state: AccountBytesMap, amountIn: bigint, _now: bigint): bigint;
};
export {};
//# sourceMappingURL=index.d.ts.map