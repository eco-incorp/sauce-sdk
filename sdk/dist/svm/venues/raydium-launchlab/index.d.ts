import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadderV2 } from '../types.js';
declare const SLUG: "raydium-launchlab";
export declare const RAYDIUM_LAUNCHLAB_PROGRAM_ID: Address;
export interface RaydiumLaunchlabPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** exactIn side: 'quoteToBase' (default, buy_exact_in) | 'baseToQuote' (sell_exact_in). */
    direction: 'quoteToBase' | 'baseToQuote';
    globalConfig: Address;
    platformConfig: Address;
    baseMint: Address;
    quoteMint: Address;
    baseVault: Address;
    quoteVault: Address;
    baseTokenProgram: Address;
    platformVault: Address;
    creatorVault: Address;
}
export declare const raydiumLaunchlab: {
    slug: "raydium-launchlab";
    kind: "constant-product";
    programId: Address;
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<RaydiumLaunchlabPoolConfig>;
};
export declare const raydiumLaunchlabLadder: SvmVenueLadderV2;
export {};
//# sourceMappingURL=index.d.ts.map