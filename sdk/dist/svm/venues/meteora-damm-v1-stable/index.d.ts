import type { Address } from '@solana/kit';
import type { PoolConfig, SvmVenueAdapter } from '../types.js';
export interface MeteoraDammV1StablePoolConfig extends PoolConfig {
    tokenAMint: Address;
    tokenBMint: Address;
    aVault: Address;
    bVault: Address;
    /** Pool-owned SPL token account holding vault A LP (also the pool authority PDA). */
    aVaultLp: Address;
    bVaultLp: Address;
    /** Protocol-fee token account of the INPUT (A) side — swap account 11 for A->B. */
    protocolTokenAFee: Address;
    /** VaultA.token_vault — the vault's idle SPL float, swap account 5. */
    aTokenVault: Address;
    /** VaultB.token_vault — out-side idle float; bounds the quote (strict <). */
    bTokenVault: Address;
    /** VaultA.lp_mint read from vault offset 115 (NOT reliably the canonical PDA). */
    aLpMint: Address;
    bLpMint: Address;
    tradeFeeNumerator: bigint;
    tradeFeeDenominator: bigint;
    protocolTradeFeeNumerator: bigint;
    protocolTradeFeeDenominator: bigint;
    /** Amplification coefficient, used directly (ann = amp * 2 inside the helpers). */
    amp: bigint;
    /** 10^(precision_factor - decimals); 1 for equal-decimal pairs. Immutable. */
    tokenAMultiplier: bigint;
    tokenBMultiplier: bigint;
    /** Non-zero only for bootstrapping pools; unit selected by activationType. */
    activationPoint: bigint;
    /** 0 = slot, 1 = unix timestamp. */
    activationType: number;
}
export declare const meteoraDammV1Stable: SvmVenueAdapter;
//# sourceMappingURL=index.d.ts.map