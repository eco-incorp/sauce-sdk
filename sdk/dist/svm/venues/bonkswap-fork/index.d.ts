import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
export declare const OFF_TOKEN_X_RESERVE = 200;
export declare const OFF_TOKEN_Y_RESERVE = 208;
export declare const OFF_CONST_K = 312;
export declare const OFF_LP_FEE = 344;
export declare const OFF_BUYBACK_FEE = 360;
export declare const OFF_PROJECT_FEE = 376;
export declare const OFF_MERCANTI_FEE = 392;
/** DEFAULT_DENOMINATOR — every fee field is a rate scaled by 1e12 (100%). */
export declare const FEE_DENOMINATOR = 1000000000000n;
declare function readUintLE(data: Uint8Array, offset: number, width: number): bigint;
export interface BonkswapForkPoolConfig extends PoolConfig {
    tokenX: Address;
    tokenY: Address;
    poolXAccount: Address;
    poolYAccount: Address;
    /** constK (Product, u128), split hi/lo — a liquidity-event invariant, baked at fetch time (mirrors obric-v2's bigK). */
    constKHi: bigint;
    constKLo: bigint;
    /** Fee rates (ppt of 1e12) — admin-configured, baked at fetch time. */
    lpFee: bigint;
    buybackFee: bigint;
    projectFee: bigint;
    mercantiFee: bigint;
    /** 'xToY' (default, tokenX in) | 'yToX'. */
    direction: 'xToY' | 'yToX';
}
declare function forkConfig(slug: string, base: PoolConfig): BonkswapForkPoolConfig;
export interface BonkswapForkAdapter {
    slug: string;
    programId: Address;
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<BonkswapForkPoolConfig>;
}
/**
 * One adapter per deployed Bonkswap fork — same layout/math (see module
 * header), parameterized only by the fork's own program id.
 */
export declare function makeBonkswapForkAdapter(slug: string, programId: Address): BonkswapForkAdapter;
export { forkConfig as bonkswapForkConfig, readUintLE as bonkswapReadUintLE };
/** Bonkswap — the original deployment. */
export declare const BONKSWAP_PROGRAM_ID: Address;
/** Bonkswap's `state` PDA (seed "bonkswapstatev1") — verified via getProgramDerivedAddress and matches a real swap tx's account #0. */
export declare const BONKSWAP_STATE: Address;
/** Bonkswap's vault-owning authority PDA (State.programAuthority) — matches every pool's vault SPL-token `owner` field. */
export declare const BONKSWAP_PROGRAM_AUTHORITY: Address;
export declare const bonkswap: BonkswapForkAdapter;
/** Guacswap — a whitelabel fork (see module header). */
export declare const GUACSWAP_PROGRAM_ID: Address;
/** Guacswap's `state` PDA (seed "guacswapstatev1"). */
export declare const GUACSWAP_STATE: Address;
/** Guacswap's vault-owning authority PDA. */
export declare const GUACSWAP_PROGRAM_AUTHORITY: Address;
export declare const guacswap: BonkswapForkAdapter;
//# sourceMappingURL=index.d.ts.map