import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadderV2 } from '../types.js';
declare const SLUG = "defituna";
export declare const DEFITUNA_PROGRAM_ID: Address<"fUSioN9YKKSa3CUC2YUc4tPkHJ5Y6XW1yz8y6F7qWz9">;
export declare const FUSION_POOL_ACCOUNT_SIZE = 423;
/** sha256('account:FusionPool')[0..8] (IDL-given: [254,204,207,98,25,181,29,67]). */
export declare const FUSION_POOL_DISCRIMINATOR: number[];
/** sha256('account:TickArray')[0..8] (IDL-given: [85,1,199,2,188,97,101,139]). */
export declare const TICK_ARRAY_DISCRIMINATOR: number[];
export declare const TICK_ARRAY_SIZE = 88;
/** Borsh-tagged-enum per-tick size when Initialized (1-byte tag + 112-byte TickData); 1 byte when Uninitialized. */
export declare const TICK_LEN_INITIALIZED = 113;
/** Minimum possible TickArray account length (all 88 ticks uninitialized): 8 + 4 + 32 + 88. */
export declare const TICK_ARRAY_MIN_LEN = 132;
/**
 * Shipped initialized-tick boundaries per direction — same budget class as
 * orca-whirlpool/raydium-clmm (2 rungs default, degrade-first CU kind).
 */
export declare const DEFITUNA_MAX_BOUNDARIES = 4;
export interface DefiTunaBoundary {
    arrayIndex: number;
    /** ABSOLUTE byte offset of the tick's tag byte within its TickArray account (see header — NOT offset*stride). */
    byteOffset: number;
    tick: number;
    sqrtPrice: bigint;
}
export interface DefiTunaWindow {
    tickArrays: [Address, Address, Address];
    startTicks: [number, number, number];
    boundaries: DefiTunaBoundary[];
    edge: {
        tick: number;
        sqrtPrice: bigint;
    } | null;
    /** Contiguous prefix of tickArrays that existed as real TickArray accounts at prepare. */
    readable: number;
    /** True when a SHIPPED boundary carries a live resting limit order (see header gate). */
    hasActiveOrder: boolean;
}
export interface DefiTunaPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    direction: 'aToB' | 'bToA';
    tokenMintA: Address;
    tokenMintB: Address;
    tokenVaultA: Address;
    tokenVaultB: Address;
    tickSpacing: number;
    feeRate: number;
    liquidity: bigint;
    sqrtPrice: bigint;
    tickCurrentIndex: number;
    windows: {
        aToB: DefiTunaWindow;
        bToA: DefiTunaWindow;
    };
}
/** The direction's window (the ladder adapter and the orchestrator gate read through this). */
export declare function defitunaWindowFor(cfg: DefiTunaPoolConfig): DefiTunaWindow;
/** Fetch + decode one FusionPool and freeze both directions' boundary windows. Read-only against the loader. */
export declare function fetchDefiTunaPoolConfig(load: AccountLoader, pool: Address): Promise<DefiTunaPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only, like orca-whirlpool/raydium-clmm/byreal). */
export declare const defituna: {
    slug: string;
    programId: Address<"fUSioN9YKKSa3CUC2YUc4tPkHJ5Y6XW1yz8y6F7qWz9">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchDefiTunaPoolConfig;
};
export declare const defitunaLadder: SvmVenueLadderV2;
export {};
//# sourceMappingURL=index.d.ts.map