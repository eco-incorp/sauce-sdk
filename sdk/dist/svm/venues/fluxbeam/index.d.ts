import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadderV2 } from '../types.js';
declare const SLUG = "fluxbeam";
export declare const FLUXBEAM_PROGRAM_ID: Address<"FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X">;
/** `SwapVersion::pack` = 1-byte version tag + the 323-byte `SwapV1` body. */
export declare const FLUXBEAM_POOL_SIZE = 324;
export interface FluxBeamFeeTier {
    epoch: bigint;
    max: bigint;
    bps: bigint;
}
export interface FluxBeamPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    swapAuthority: Address;
    tokenProgramPool: Address;
    vaultA: Address;
    vaultB: Address;
    poolMint: Address;
    mintA: Address;
    mintB: Address;
    poolFeeAccount: Address;
    tokenProgramA: Address;
    tokenProgramB: Address;
    tradeFeeNumerator: bigint;
    tradeFeeDenominator: bigint;
    ownerTradeFeeNumerator: bigint;
    ownerTradeFeeDenominator: bigint;
    /** Wire (Token-2022) transfer fee on the mintA leg — {0n,0n} when classic or fee-less. */
    feeA: {
        bps: bigint;
        max: bigint;
    };
    /** Wire (Token-2022) transfer fee on the mintB leg — {0n,0n} when classic or fee-less. */
    feeB: {
        bps: bigint;
        max: bigint;
    };
}
export declare function fetchFluxBeamPoolConfig(load: AccountLoader, pool: Address): Promise<FluxBeamPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only, like orca-legacy-token-swap). */
export declare const fluxbeam: {
    slug: string;
    programId: Address<"FLUXubRmkEi2q6K3Y9kBPg9248ggaZVsoSFhtJHSrm1X">;
    fetchPoolConfig: typeof fetchFluxBeamPoolConfig;
};
export declare const fluxbeamLadder: SvmVenueLadderV2;
export {};
//# sourceMappingURL=index.d.ts.map