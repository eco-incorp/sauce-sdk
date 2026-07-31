import type { Address } from '@solana/kit';
import { calcRoundedAmount, type StabbleTokenScale } from '../stabble-common.js';
import type { PoolConfig, SvmVenueAdapter } from '../types.js';
declare const SLUG = "stabble-stable-swap";
export interface StabbleStableToken extends StabbleTokenScale {
    mint: Address;
    decimals: number;
    balance: bigint;
    /** ATA(vaultAuthority, mint) under classic SPL Token — resolved once at fetch time. */
    vaultTokenAccount: Address;
}
export interface StabbleStableSwapPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    vault: Address;
    authorityBump: number;
    isActive: boolean;
    ampInitialFactor: number;
    ampTargetFactor: number;
    rampStartTs: bigint;
    rampStopTs: bigint;
    swapFee: bigint;
    tokens: StabbleStableToken[];
    vaultAuthority: Address;
    withdrawAuthority: Address;
    beneficiary: Address;
    beneficiaryTokenOut: Address;
}
export declare const stabbleStableSwap: SvmVenueAdapter;
export { calcRoundedAmount as stabbleStableSwapCalcRoundedAmount };
//# sourceMappingURL=index.d.ts.map