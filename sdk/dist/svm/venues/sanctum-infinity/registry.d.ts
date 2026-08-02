import type { Address } from '@solana/kit';
export type SanctumInfinityCalcFamily = 'spl' | 'sanctumSpl' | 'sanctumSplMulti';
export interface SanctumInfinityRegistryEntry {
    family: SanctumInfinityCalcFamily;
    /** The specific stake-pool account this LST's calculator CPI reads (total_lamports/pool_token_supply). */
    stakePool: Address;
}
/** wSOL — the one `wsol`-family leg live in the pool; handled without a registry row (see the adapter). */
export declare const WSOL_MINT: Address;
/** mint (base58) -> registry entry. */
export declare const SANCTUM_INFINITY_REGISTRY: ReadonlyMap<string, SanctumInfinityRegistryEntry>;
/** Row count — cross-checked in `sanctum-infinity.test.ts` against a live-dumped fixture. */
export declare const SANCTUM_INFINITY_REGISTRY_SIZE: number;
//# sourceMappingURL=registry.d.ts.map