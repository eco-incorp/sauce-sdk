import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, VenueAccount } from '../types.js';
declare const SLUG = "saber-decimals-wrapper";
export declare const SABER_DECIMALS_WRAPPER_PROGRAM_ID: Address<"DecZY86MU5Gj7kppfUCEmd4LbXXuyZH1yHaP2NTqdiZB">;
export declare const OFF_DECIMALS = 8;
export declare const OFF_MULTIPLIER = 9;
export declare const OFF_UNDERLYING_MINT = 17;
export declare const OFF_UNDERLYING_TOKENS = 49;
export declare const OFF_WRAPPER_MINT = 81;
export type SaberDecimalsWrapperDirection = 'deposit' | 'withdraw';
export interface SaberDecimalsWrapperPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    decimals: number;
    multiplier: bigint;
    underlyingMint: Address;
    vault: Address;
    wrapperMint: Address;
    direction: SaberDecimalsWrapperDirection;
}
declare function fetchPoolConfig(load: AccountLoader, pool: Address): Promise<SaberDecimalsWrapperPoolConfig>;
declare function quoteAccounts(base: PoolConfig): VenueAccount[];
export declare const saberDecimalsWrapper: {
    slug: string;
    kind: "constant-product";
    programId: Address<"DecZY86MU5Gj7kppfUCEmd4LbXXuyZH1yHaP2NTqdiZB">;
    fetchPoolConfig: typeof fetchPoolConfig;
    quoteAccounts: typeof quoteAccounts;
};
export {};
//# sourceMappingURL=index.d.ts.map