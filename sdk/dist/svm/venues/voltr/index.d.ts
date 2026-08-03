import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadder } from '../types.js';
declare const SLUG = "voltr";
export declare const VOLTR_PROGRAM_ID: Address<'vVoLTRjQmtFpiYoegx285Ze4gsLJ8ZxgFKVcuvmG1a8'>;
export declare const SPL_TOKEN_PROGRAM_ID: Address<'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'>;
export interface VoltrPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'assetToLp' (deposit_vault, default) | 'lpToAsset' (instant_withdraw_vault). */
    direction: 'assetToLp' | 'lpToAsset';
    assetMint: Address;
    lpMint: Address;
    protocol: Address;
    vaultAssetIdleAuth: Address;
    vaultAssetIdleAta: Address;
    vaultLpMintAuth: Address;
    assetDecimals: number;
    lpDecimals: number;
}
/**
 * Off-chain, once per pool: derive every PDA the CPI needs, verify the
 * stored LP mint address matches its own seed derivation (a cheap
 * self-consistency check — a mismatch means a wrong/spoofed account), and
 * read the two mints' decimals (needed only for the empty-vault bootstrap
 * case, fixed forever per vault so safe to bake at prepare time).
 */
export declare function fetchVoltrConfig(load: AccountLoader, pool: Address): Promise<VoltrPoolConfig>;
export declare const voltrLadder: SvmVenueLadder;
export {};
//# sourceMappingURL=index.d.ts.map