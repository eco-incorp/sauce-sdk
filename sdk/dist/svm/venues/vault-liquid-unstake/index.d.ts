import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadderV2, VenueAccount } from '../types.js';
declare const SLUG = "vault-liquid-unstake";
export interface VaultLiquidUnstakePoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** The LST mint this LstInfo trades (inMint; outMint is always wrapped SOL). */
    mint: Address;
    /** The underlying SPL Stake Pool account backing this LST's exchange rate. */
    stakePool: Address;
    /** ATA(POOL_ADDRESS, mint) — the pool's own LST inventory account (account index 1 of `sell_lst`). */
    poolLstAta: Address;
}
/**
 * The pure quote math, LOCKSTEP with the emitted SauceScript helper below
 * (`qVaultLiquidUnstake`) — same integer ops, same rounding (ceil the fee,
 * so the on-chain and off-chain outputs match to the wei and both stay on
 * the conservative side of the real program).
 */
export declare function vaultLiquidUnstakeQuote(x: bigint, rateNum: bigint, rateDen: bigint, before: bigint, target: bigint): bigint;
export declare const vaultLiquidUnstake: {
    slug: string;
    kind: "constant-product";
    programId: Address<"2rU1oCHtQ7WJUvy15tKtFvxdYNNSc3id7AzUcjeFSddo">;
    /**
     * Off-chain, once per pool. `pool` is the LstInfo account address (this
     * family's "pool", matching every other family's convention — see
     * EcoSwapSvmPoolSpec). Rejects: a missing/undecodable LstInfo, the wrong
     * discriminator, the unsupported 225-byte extended layout (SCOPE, module
     * doc), a missing/malformed global Pool singleton, or a stake-pool
     * account whose shape doesn't match the canonical SPL Stake Pool struct.
     */
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<VaultLiquidUnstakePoolConfig>;
    quoteAccounts(cfg: PoolConfig): VenueAccount[];
};
export declare const vaultLiquidUnstakeLadder: SvmVenueLadderV2;
export {};
//# sourceMappingURL=index.d.ts.map