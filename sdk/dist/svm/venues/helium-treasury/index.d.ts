import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "helium-treasury";
/** `TreasuryManagementV0`'s own program — recipe-side `SVM_VENUE_PROGRAM_IDS['helium-treasury']`. */
export declare const HELIUM_TREASURY_PROGRAM_ID: Address<"treaf4wWBBty3fHdyBpo35Mz84M8k3heKXmjmi9vFt5">;
/** The companion `circuit-breaker` program every treasury's transfer is CPI-gated through. */
export declare const HELIUM_CIRCUIT_BREAKER_PROGRAM_ID: Address<"circAbx64bbsscPbQzZAUvuXpHqrCe6fLMzc2uKXz9g">;
/** `u64::MAX` — the denominator `ThresholdType::Percent` divides by (`window.rs::get_threshold`). */
export declare const U64_MAX = 18446744073709551615n;
export interface HeliumTreasuryPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    treasuryMint: Address;
    supplyMint: Address;
    treasury: Address;
    circuitBreaker: Address;
    /** 0 = Percent (of the treasury's live balance), 1 = Absolute — `ThresholdType`. */
    thresholdType: 0 | 1;
    threshold: bigint;
    freezeUnixTime: bigint;
}
export declare function fetchHeliumTreasuryPoolConfig(load: AccountLoader, pool: Address): Promise<HeliumTreasuryPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only, like gamma/heaven). */
export declare const heliumTreasury: {
    slug: string;
    programId: Address<"treaf4wWBBty3fHdyBpo35Mz84M8k3heKXmjmi9vFt5">;
    fetchPoolConfig: typeof fetchHeliumTreasuryPoolConfig;
};
export {};
//# sourceMappingURL=index.d.ts.map