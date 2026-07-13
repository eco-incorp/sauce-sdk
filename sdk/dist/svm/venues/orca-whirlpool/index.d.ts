import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
import { MAX_TICK_INDEX, MIN_TICK_INDEX } from './tick-math.js';
declare const SLUG = "orca-whirlpool";
export declare const ORCA_WHIRLPOOL_PROGRAM_ID: Address<"whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc">;
export declare const WHIRLPOOL_ACCOUNT_SIZE = 653;
export declare const TICK_ARRAY_ACCOUNT_SIZE = 9988;
/** sha256('account:Whirlpool')[0..8]. */
export declare const WHIRLPOOL_DISCRIMINATOR: number[];
/** sha256('account:TickArray')[0..8] — the FIXED tick array (the only readable kind). */
export declare const TICK_ARRAY_DISCRIMINATOR: number[];
export declare const TICK_ARRAY_SIZE = 88;
export { MAX_TICK_INDEX, MIN_TICK_INDEX };
/**
 * Shipped initialized-tick boundaries per direction. Sized against the
 * engine's measured per-step cost (a crossed boundary is ~45k CU in the
 * walk); raising it widens per-slot capacity at ~3 cfg words + one walk
 * iteration apiece and must move in lockstep with the fragment's unrolled
 * setup (ladder.ts) and the mirror.
 */
export declare const WHIRLPOOL_MAX_BOUNDARIES = 4;
export declare const OFF_TICK_SPACING = 41;
export declare const OFF_FEE_TIER_INDEX = 43;
export declare const OFF_FEE_RATE = 45;
export declare const OFF_LIQUIDITY = 49;
export declare const OFF_SQRT_PRICE = 65;
export declare const OFF_TICK_CURRENT = 81;
export declare const OFF_TA_START = 8;
export declare const OFF_TA_TICKS = 12;
export declare const TICK_LEN = 113;
export declare const OFF_TA_WHIRLPOOL = 9956;
export interface WhirlpoolBoundary {
    /** Index into the window's tickArrays (0..2). */
    arrayIndex: number;
    /** Tick offset within that array (0..87) — the live flag/net cell. */
    offset: number;
    /** UNBIASED tick index (= start + offset * spacing, PDA-pinned). */
    tick: number;
    /** sqrt_price_from_tick_index(tick) — pure function of the tick. */
    sqrtPrice: bigint;
}
export interface WhirlpoolWindow {
    /** The three swap-sequence tick array PDAs, nearest first (walk order). */
    tickArrays: [Address, Address, Address];
    /** start_tick_index encoded in each PDA (walk order). */
    startTicks: [number, number, number];
    /**
     * Initialized-tick boundaries in walk order (<= WHIRLPOOL_MAX_BOUNDARIES),
     * scanned at prepare over the readable (contiguous initialized FIXED)
     * array prefix.
     */
    boundaries: WhirlpoolBoundary[];
    /**
     * The swap-sequence bound of the readable window (the venue's last-array
     * start for aToB / start + 88*ts - 1 for bToA, clamped to MIN/MAX tick) —
     * null when the boundary scan stopped at WHIRLPOOL_MAX_BOUNDARIES, i.e.
     * deeper initialized ticks exist that the model does not carry, so the
     * walk must not step past the last shipped boundary.
     */
    edge: {
        tick: number;
        sqrtPrice: bigint;
    } | null;
    /** Contiguous prefix of tickArrays that existed as FIXED arrays at prepare. */
    readable: number;
}
export interface OrcaWhirlpoolPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** Trade direction: 'aToB' (default) sells token A for token B. */
    direction: 'aToB' | 'bToA';
    tokenMintA: Address;
    tokenMintB: Address;
    tokenVaultA: Address;
    tokenVaultB: Address;
    /** PDA ['oracle', whirlpool] — uninitialized for static-fee pools, but the swap ix requires it. */
    oracle: Address;
    tickSpacing: number;
    /** Snapshot at fetch time (the fragment re-reads it live; hundredths of a bp, denominator 1e6). */
    feeRate: number;
    /** Snapshots at fetch time (the fragment re-reads them live). */
    liquidity: bigint;
    sqrtPrice: bigint;
    tickCurrentIndex: number;
    /** Direction-keyed prepare-declared windows (see the header). */
    windows: {
        aToB: WhirlpoolWindow;
        bToA: WhirlpoolWindow;
    };
}
/** The direction's window (the ladder adapter and the orchestrator gate read through this). */
export declare function windowFor(cfg: OrcaWhirlpoolPoolConfig): WhirlpoolWindow;
/**
 * The program's expected window start indexes for a direction
 * (sparse_swap.rs get_start_tick_indexes), unfiltered: exactly three,
 * including any outside the initializable range (those PDAs never exist and
 * stay beyond `readable`).
 */
export declare function windowStartTicks(tickCurrentIndex: number, tickSpacing: number, aToB: boolean): [number, number, number];
/**
 * Fetch + gate one whirlpool (see the header for the gate list) and freeze
 * both directions' boundary windows. Read-only against the loader.
 */
export declare function fetchOrcaWhirlpoolConfig(load: AccountLoader, pool: Address): Promise<OrcaWhirlpoolPoolConfig>;
/**
 * Family facade for the recipe orchestrator (this venue is ladder-only — it
 * has no v1 SvmVenueAdapter and is not in the v1 registry).
 */
export declare const orcaWhirlpool: {
    slug: string;
    programId: Address<"whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchOrcaWhirlpoolConfig;
};
//# sourceMappingURL=index.d.ts.map