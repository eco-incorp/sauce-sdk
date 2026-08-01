import type { Address } from '@solana/kit';
import type { PoolConfig, SvmVenueAdapter, SwapUser, VenueAccount } from '../types.js';
declare const SLUG = "huma";
export declare const HUMA_PROGRAM_ID: Address<"HumaXepHnjaRCpjYTokxY4UtaJcmx41prQ8cxGmFC5fn">;
export declare const HUMA_CURATED_MODE_CONFIGS: Readonly<Record<string, Address>>;
export interface HumaFeeTier {
    /** Liquid-asset-ratio bps threshold: this tier applies when the ratio is BELOW it. */
    ltBps: bigint;
    feeBps: bigint;
}
export interface HumaPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'deposit' (underlying -> mode share) | 'withdraw' (mode share -> underlying). */
    direction: 'deposit' | 'withdraw';
    /** = cfg.pool: the ModeConfig account address (uniquely identifies this tradeable instrument). */
    modeConfig: Address;
    poolConfigAccount: Address;
    poolState: Address;
    modeMint: Address;
    poolAuthority: Address;
    poolUnderlyingToken: Address;
    underlyingMint: Address;
    humaConfig: Address;
    poolOwnerTreasuryUnderlyingToken: Address;
    /** Byte offset of this mode's ModeState.assets (u128) within the fetched PoolState account. */
    modeAssetsOffset: number;
    /** Byte offset of PoolState.liquid_assets_deployed (u64) — pool-wide, mode-index-independent. */
    liquidAssetsDeployedOffset: number;
    /** Byte offset of PoolState.disbursement_reserve (u128) — always fixed (before any Vec). */
    disbursementReserveOffset: number;
    /** LPConfig.liquidity_cap (u128, baked) — deposit-side cap. */
    liquidityCap: bigint;
    /** LPConfig.min_deposit_amount (u64, baked) — deposit dust floor. */
    minDepositAmount: bigint;
    /** InstantWithdrawalConfig.instant_withdrawal_reserve_limit (u64, baked) — withdraw-side cap. */
    reserveLimit: bigint;
    /** InstantWithdrawalConfig.instant_withdrawal_fee_configs, ascending by ltBps (baked). */
    feeTiers: readonly HumaFeeTier[];
    /** InstantWithdrawalConfig.liquidity_source (Option<Pubkey>, baked), if the pool has one configured. */
    liquidityDeploymentConfig: Address | null;
    /** PDA(["deployment_state", liquidityDeploymentConfig]), present iff liquidityDeploymentConfig is. */
    liquidityDeploymentState: Address | null;
}
/** PDA(["lender_state", modeConfig, lender], HUMA_PROGRAM_ID) — a per-(mode,owner) precondition account; see the module doc. */
export declare function humaLenderStatePda(modeConfig: Address, lender: Address): Promise<Address>;
declare const MODE_STATE_SIZE = 216;
/** The tier fee (bps) applying at a given liquid-asset-ratio (bps): the first (smallest threshold) tier the ratio is strictly below; 0 if none match. */
export declare function humaFeeBpsFor(liquidRatioBps: bigint, feeTiers: readonly HumaFeeTier[]): bigint;
export declare const huma: SvmVenueAdapter;
/**
 * Builds the tiered instant-withdrawal fee lookup as a flat `let` + sequence
 * of top-level `if` reassignments — NO ternaries (the compiler rejects a
 * nested/chained ConditionalExpression; see this file's emitQuote doc).
 * Tiers are ascending by ltBps; checked in DESCENDING order so the LAST if to
 * fire (the smallest matching threshold — the correct, most-conservative
 * tier) is the one left standing, reproducing "first ascending match wins"
 * exactly.
 */
export declare function humaFeeAssignLines(c: HumaPoolConfig, ratioVar: string, feeVar: string): string[];
declare function encodeDepositData(assets: bigint): Uint8Array;
declare function encodeInstantWithdrawData(shares: bigint): Uint8Array;
declare function depositAccounts(c: HumaPoolConfig, user: SwapUser): VenueAccount[];
declare function instantWithdrawAccounts(c: HumaPoolConfig, user: SwapUser): VenueAccount[];
export { depositAccounts as humaDepositAccounts, instantWithdrawAccounts as humaInstantWithdrawAccounts };
export { encodeDepositData as humaEncodeDepositData, encodeInstantWithdrawData as humaEncodeInstantWithdrawData };
export { MODE_STATE_SIZE as HUMA_MODE_STATE_SIZE };
//# sourceMappingURL=index.d.ts.map