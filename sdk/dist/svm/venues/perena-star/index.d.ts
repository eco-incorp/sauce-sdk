import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
export declare const PERENA_STAR_PROGRAM_ID: Address<"save8RQVPMWNTzU18t3GBvBkN9hT7jsGjiCQ28FpD9H">;
export interface PerenaStarPoolConfig extends PoolConfig {
    venue: 'perena-star';
    bank: Address;
    bankMint: Address;
    juniorMint: Address;
    escrowAta: Address;
    lockedSharesAta: Address;
    /** Prepare-time snapshot of BankStatus — re-checked live in the fragment (see module header). */
    isHaltedDeposit: boolean;
    isHaltedWithdrawal: boolean;
    /** 'stake' (default, bank mint in / junior shares out) | 'unstake' (junior shares in / bank mint out). */
    direction: 'stake' | 'unstake';
}
declare function fetchPerenaStarPoolConfig(load: AccountLoader, pool: Address): Promise<PerenaStarPoolConfig>;
export declare const perenaStar: {
    slug: "perena-star";
    programId: Address<"save8RQVPMWNTzU18t3GBvBkN9hT7jsGjiCQ28FpD9H">;
    fetchPoolConfig: typeof fetchPerenaStarPoolConfig;
};
export {};
//# sourceMappingURL=index.d.ts.map