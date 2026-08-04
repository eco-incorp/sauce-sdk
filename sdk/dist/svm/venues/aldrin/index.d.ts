import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
export declare const ALDRIN_V1_PROGRAM_ID: Address<"AMM55ShdkoGRB5jVYPjWziwk8m5MpwyDgsMWHaMSQWH6">;
export declare const ALDRIN_V2_PROGRAM_ID: Address<"CURVGoZn8zycx6FXwwevgBTB2gVvdbGTEpvMJDbgs2t4">;
export type AldrinDirection = 'baseToQuote' | 'quoteToBase';
export interface AldrinPoolConfig extends PoolConfig {
    venue: 'aldrin' | 'aldrin-v2';
    version: 1 | 2;
    poolMint: Address;
    baseTokenVault: Address;
    baseTokenMint: Address;
    quoteTokenVault: Address;
    quoteTokenMint: Address;
    poolSigner: Address;
    feePoolTokenAccount: Address;
    tradeFeeNumerator: bigint;
    tradeFeeDenominator: bigint;
    ownerTradeFeeNumerator: bigint;
    ownerTradeFeeDenominator: bigint;
    /** V2 only — the external curve account the swap ix attaches (CP pools never read from it). */
    curve?: Address;
    direction: AldrinDirection;
}
export declare const aldrin: {
    slug: "aldrin";
    programId: Address<"AMM55ShdkoGRB5jVYPjWziwk8m5MpwyDgsMWHaMSQWH6">;
    fetchPoolConfig: (load: AccountLoader, pool: Address) => Promise<AldrinPoolConfig>;
};
export declare const aldrinV2: {
    slug: "aldrin-v2";
    programId: Address<"CURVGoZn8zycx6FXwwevgBTB2gVvdbGTEpvMJDbgs2t4">;
    fetchPoolConfig: (load: AccountLoader, pool: Address) => Promise<AldrinPoolConfig>;
};
//# sourceMappingURL=index.d.ts.map