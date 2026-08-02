import type { Address } from '@solana/kit';
import { MAX_TICK_INDEX, MIN_TICK_INDEX } from '../orca-whirlpool/tick-math.js';
import type { AccountLoader, PoolConfig, SvmVenueLadderV2 } from '../types.js';
declare const SLUG = "crema";
export declare const CREMA_PROGRAM_ID: Address<"CLMM9tUoggJu2wagPkkqs9eFG4BWhVBZWkP1qv3Sp7tR">;
export declare const CLMMPOOL_ACCOUNT_SIZE = 748;
/** sha256('account:Clmmpool')[0..8]. */
export declare const CLMMPOOL_DISCRIMINATOR: number[];
export declare const TICK_ARRAY_ACCOUNT_SIZE = 8556;
/** sha256('account:TickArray')[0..8] — byte-identical to orca-whirlpool's own (name-derived, not program-derived). */
export declare const TICK_ARRAY_DISCRIMINATOR: number[];
export declare const TICK_ARRAY_MAP_ACCOUNT_SIZE = 876;
/** sha256('account:TickArrayMap')[0..8]. */
export declare const TICK_ARRAY_MAP_DISCRIMINATOR: number[];
export declare const TICK_ARRAY_SIZE = 64;
export { MAX_TICK_INDEX, MIN_TICK_INDEX };
export declare const OFF_TICK_SPACING = 168;
export declare const OFF_FEE_RATE = 172;
export declare const OFF_LIQUIDITY = 174;
export declare const OFF_SQRT_PRICE = 190;
export declare const OFF_TICK_CURRENT = 206;
export declare const OFF_TA_ARRAY_INDEX = 8;
export declare const OFF_TA_TICKS = 44;
export declare const TICK_LEN = 133;
/** Shipped initialized-tick boundaries per direction — same budget class as orca-whirlpool/raydium-clmm. */
export declare const CREMA_MAX_BOUNDARIES = 4;
export interface CremaBoundary {
    /** Index (0..2) into this window's `tickArrays`/`startTicks` — NOT the real Crema array index. */
    arrayIndex: number;
    /** Slot offset (0..63) within that tick array. */
    offset: number;
    tick: number;
    sqrtPrice: bigint;
}
export interface CremaWindow {
    tickArrays: [Address, Address, Address];
    /** Real Crema array indices the 3 slots above resolve to (bitmap-scan order, may be non-consecutive). */
    arrayIndices: [number, number, number];
    startTicks: [number, number, number];
    boundaries: CremaBoundary[];
    edge: {
        tick: number;
        sqrtPrice: bigint;
    } | null;
    /** Contiguous PREFIX of tickArrays that existed as real, valid TickArray accounts at prepare. */
    readable: number;
}
export interface CremaPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    direction: 'aToB' | 'bToA';
    tokenMintA: Address;
    tokenMintB: Address;
    tokenVaultA: Address;
    tokenVaultB: Address;
    clmmConfig: Address;
    tickArrayMap: Address;
    tickSpacing: number;
    feeRate: number;
    liquidity: bigint;
    sqrtPrice: bigint;
    tickCurrentIndex: number;
    windows: {
        aToB: CremaWindow;
        bToA: CremaWindow;
    };
}
/** The direction's window (the ladder adapter and the orchestrator gate read through this). */
export declare function cremaWindowFor(cfg: CremaPoolConfig): CremaWindow;
/** Fetch + decode one Clmmpool and freeze both directions' boundary windows. Read-only against the loader. */
export declare function fetchCremaPoolConfig(load: AccountLoader, pool: Address): Promise<CremaPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only, like orca-whirlpool/raydium-clmm). */
export declare const crema: {
    slug: string;
    programId: Address<"CLMM9tUoggJu2wagPkkqs9eFG4BWhVBZWkP1qv3Sp7tR">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchCremaPoolConfig;
};
export declare const cremaLadder: SvmVenueLadderV2;
//# sourceMappingURL=index.d.ts.map