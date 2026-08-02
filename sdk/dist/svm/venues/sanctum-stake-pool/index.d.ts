import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadderV2 } from '../types.js';
export declare const SANCTUM_STAKE_POOL_PROGRAM_ID: Address<"SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy">;
export declare const SANCTUM_STAKE_POOL_2_PROGRAM_ID: Address<"SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY">;
export declare const SANCTUM_STAKE_POOL_3_PROGRAM_ID: Address<"SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn">;
export declare const SANCTUM_STAKE_POOL_4_PROGRAM_ID: Address<"stkitrT1Uoy18Dk1fTrgPw8W6MVzoCfYoAFT4MLsmhq">;
/** The recipe-wide vocabulary for "the user is trading SOL" — see module header's ACCOUNTS caveat. */
export declare const WSOL_MINT: Address<"So11111111111111111111111111111111111111112">;
export interface SanctumStakePoolConfig extends PoolConfig {
    venue: 'sanctum-stake-pool' | 'sanctum-stake-pool-2' | 'sanctum-stake-pool-3' | 'sanctum-stake-pool-4';
    poolMint: Address;
    reserveStake: Address;
    managerFeeAccount: Address;
    /** `create_program_address([pool, "withdraw", [bump]], programId)` — computed once at fetch time. */
    withdrawAuthority: Address;
    solDepositFeeNumerator: bigint;
    solDepositFeeDenominator: bigint;
    /** Fixed at the framework's single `direction` value — this family only quotes SOL -> LST. */
    direction: 'solToLst';
}
export declare const sanctumStakePool: {
    slug: "sanctum-stake-pool" | "sanctum-stake-pool-2" | "sanctum-stake-pool-3" | "sanctum-stake-pool-4";
    programId: Address;
    fetchPoolConfig: (load: AccountLoader, pool: Address) => Promise<SanctumStakePoolConfig>;
};
export declare const sanctumStakePool2: {
    slug: "sanctum-stake-pool" | "sanctum-stake-pool-2" | "sanctum-stake-pool-3" | "sanctum-stake-pool-4";
    programId: Address;
    fetchPoolConfig: (load: AccountLoader, pool: Address) => Promise<SanctumStakePoolConfig>;
};
export declare const sanctumStakePool3: {
    slug: "sanctum-stake-pool" | "sanctum-stake-pool-2" | "sanctum-stake-pool-3" | "sanctum-stake-pool-4";
    programId: Address;
    fetchPoolConfig: (load: AccountLoader, pool: Address) => Promise<SanctumStakePoolConfig>;
};
export declare const sanctumStakePool4: {
    slug: "sanctum-stake-pool" | "sanctum-stake-pool-2" | "sanctum-stake-pool-3" | "sanctum-stake-pool-4";
    programId: Address;
    fetchPoolConfig: (load: AccountLoader, pool: Address) => Promise<SanctumStakePoolConfig>;
};
export declare const sanctumStakePoolLadder: SvmVenueLadderV2;
export declare const sanctumStakePool2Ladder: SvmVenueLadderV2;
export declare const sanctumStakePool3Ladder: SvmVenueLadderV2;
export declare const sanctumStakePool4Ladder: SvmVenueLadderV2;
//# sourceMappingURL=index.d.ts.map