import type { Address } from '@solana/kit';
import type { PoolConfig, SvmVenueAdapter } from '../types.js';
declare const SLUG = "saber-stableswap";
export declare const SABER_STABLESWAP_PROGRAM_ID: Address<"SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ">;
export interface SaberPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** Stored bump for the swap authority (SwapInfo byte 2) — create_program_address, NOT find. */
    nonce: number;
    /** create_program_address([pool (32B), [nonce]], programId) — owner of both vaults. */
    swapAuthority: Address;
    initialAmpFactor: bigint;
    targetAmpFactor: bigint;
    /** i64 unix seconds, read unsigned (sign bit never set for real timestamps). */
    startRampTs: bigint;
    /** i64 unix seconds; 0 or past means amp == targetAmpFactor. */
    stopRampTs: bigint;
    /** SPL token account holding token A reserves (quote-input side). */
    vaultA: Address;
    /** SPL token account holding token B reserves (quote-output side). */
    vaultB: Address;
    mintA: Address;
    mintB: Address;
    adminFeeA: Address;
    /** Admin fee account of the OUTPUT token for A -> B swaps (instruction account 7). */
    adminFeeB: Address;
    tradeFeeNumerator: bigint;
    tradeFeeDenominator: bigint;
    adminTradeFeeNumerator: bigint;
    adminTradeFeeDenominator: bigint;
}
export declare const saberStableswap: SvmVenueAdapter;
export {};
//# sourceMappingURL=index.d.ts.map