import type { Address } from '@solana/kit';
import type { PoolConfig, SvmVenueAdapter } from '../types.js';
export interface MeteoraDammV1CpPoolConfig extends PoolConfig {
    tokenAMint: Address;
    tokenBMint: Address;
    aVault: Address;
    bVault: Address;
    aVaultLp: Address;
    bVaultLp: Address;
    /** Protocol-fee token account of the INPUT (A) side — swap account 11 for A->B. */
    protocolTokenAFee: Address;
    protocolTokenBFee: Address;
    aTokenVault: Address;
    bTokenVault: Address;
    aLpMint: Address;
    bLpMint: Address;
    tradeFeeNumerator: bigint;
    tradeFeeDenominator: bigint;
    protocolTradeFeeNumerator: bigint;
    protocolTradeFeeDenominator: bigint;
    /** Non-zero only for bootstrapping pools; unit selected by activationType. */
    activationPoint: bigint;
    /** 0 = slot, 1 = unix timestamp. */
    activationType: number;
}
export declare const meteoraDammV1Cp: SvmVenueAdapter;
//# sourceMappingURL=index.d.ts.map