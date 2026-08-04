import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
/** The Earn Pool program — this family's discovered-pool owner. */
export declare const HYLO_STABILITY_POOL_PROGRAM_ID: Address<"HysTabVUfmQBFcmzu1ctRd1Y1fxd66RBpboy1bmtDSQQ">;
/** PDA(["pool_config"], EARN_PROGRAM) — the single global pool config account. */
export declare const HYLO_STABILITY_POOL_CONFIG: Address<"2jk7miWrsTbt5hUSaCXPkEQPvuUMgbFLpgMzMQw3Z6ar">;
/** PDA(["hyUSD"], CORE_PROGRAM) — the hyUSD mint. Exported: index.ts's FAMILIES.mints() needs it
 *  (this adapter's PoolConfig decode carries no mint fields — both mints are fixed constants). */
export declare const HYLO_STABILITY_POOL_STABLECOIN_MINT: Address<"5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E">;
/** PDA(["staked_hyUSD"], EARN_PROGRAM) — the sHYUSD (LP share) mint. Exported for the same reason. */
export declare const HYLO_STABILITY_POOL_LP_TOKEN_MINT: Address<"HnnGv3HrSqjRpgdFmx7vQGjntNEoex1SU4e9Lxcxuihz">;
export type HyloStabilityPoolDirection = 'deposit' | 'withdraw';
export interface HyloStabilityPoolConfig extends PoolConfig {
    venue: 'hylo-stability-pool';
    direction: HyloStabilityPoolDirection;
    paused: boolean;
    withdrawalFeeBits: bigint;
    withdrawalFeeExp: number;
    depositLimitBits: bigint;
    withdrawalLimitBits: bigint;
}
export declare const hyloStabilityPool: {
    slug: "hylo-stability-pool";
    programId: Address<"HysTabVUfmQBFcmzu1ctRd1Y1fxd66RBpboy1bmtDSQQ">;
    fetchPoolConfig: (load: AccountLoader, pool: Address) => Promise<HyloStabilityPoolConfig>;
};
//# sourceMappingURL=index.d.ts.map