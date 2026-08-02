import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadderV2 } from '../types.js';
declare const SLUG = "jupiter-lend-earn";
export declare const JUPITER_LEND_EARN_PROGRAM_ID: Address<"jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9">;
/** The Liquidity layer every deposit/redeem CPI delegates real token accounting to. */
export declare const JUPITER_LEND_LIQUIDITY_PROGRAM_ID: Address<"jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC">;
export declare const LENDING_ACCOUNT_SIZE = 196;
export interface JupiterLendEarnPoolConfig extends PoolConfig {
    venue: 'jupiter-lend-earn';
    mint: Address;
    fTokenMint: Address;
    rewardsRateModel: Address;
    rateModel: Address;
    liquidityReserve: Address;
    supplyPositionOnLiquidity: Address;
    vault: Address;
    tokenProgram: Address;
    /** Fixed at the framework's single `direction` value the family default resolves to. */
    direction: 'deposit' | 'redeem';
}
export declare const jupiterLendEarn: {
    slug: typeof SLUG;
    programId: Address;
    fetchPoolConfig: (load: AccountLoader, pool: Address) => Promise<PoolConfig>;
};
export declare const jupiterLendEarnLadder: SvmVenueLadderV2;
export {};
//# sourceMappingURL=index.d.ts.map