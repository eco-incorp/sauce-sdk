import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
import { MAX_TICK, MIN_TICK } from './tick-math.js';
declare const SLUG = "raydium-clmm";
export declare const RAYDIUM_CLMM_PROGRAM_ID: Address<"CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK">;
export declare const POOL_ACCOUNT_SIZE = 1544;
export declare const AMM_CONFIG_ACCOUNT_SIZE = 117;
export declare const TICK_ARRAY_ACCOUNT_SIZE = 10240;
/** sha256('account:PoolState')[0..8] (shared with raydium-cp — size+owner discriminate). */
export declare const POOL_DISCRIMINATOR: number[];
/** sha256('account:AmmConfig')[0..8]. */
export declare const AMM_CONFIG_DISCRIMINATOR: number[];
/** sha256('account:TickArrayState')[0..8]. */
export declare const TICK_ARRAY_DISCRIMINATOR: number[];
export declare const TICK_ARRAY_SIZE = 60;
export { MAX_TICK, MIN_TICK };
/**
 * Shipped initialized-tick boundaries per direction (matches whirlpool: each
 * crossed boundary is a walk step ~tens of k CU on the interpreter). Moves in
 * lockstep with the fragment's unrolled setup (ladder.ts) and the mirror.
 */
export declare const RAYDIUM_CLMM_MAX_BOUNDARIES = 4;
export declare const OFF_AMM_CONFIG = 9;
export declare const OFF_TOKEN_MINT_0 = 73;
export declare const OFF_TOKEN_MINT_1 = 105;
export declare const OFF_TOKEN_VAULT_0 = 137;
export declare const OFF_TOKEN_VAULT_1 = 169;
export declare const OFF_OBSERVATION_KEY = 201;
export declare const OFF_TICK_SPACING = 235;
export declare const OFF_LIQUIDITY = 237;
export declare const OFF_SQRT_PRICE = 253;
export declare const OFF_TICK_CURRENT = 269;
export declare const OFF_STATUS = 389;
export declare const OFF_FEE_ON = 390;
export declare const OFF_OPEN_TIME = 1080;
export declare const OFF_DYNAMIC_FEE_INFO = 1096;
export declare const DYNAMIC_FEE_INFO_LEN = 80;
/** AmmConfig: trade_fee_rate u32 @47 (hundredths of a bip, denominator 1e6). */
export declare const OFF_CFG_TRADE_FEE_RATE = 47;
export declare const OFF_TA_POOL = 8;
export declare const OFF_TA_START = 40;
export declare const OFF_TA_TICKS = 44;
export declare const TICK_LEN = 168;
export declare const OFF_TICK_LIQ_NET = 4;
export declare const OFF_TICK_LIQ_GROSS = 20;
export declare const OFF_TICK_ORDERS_AMOUNT = 124;
export declare const OFF_TICK_PART_FILLED_ORDERS = 132;
export interface RaydiumClmmBoundary {
    /** Index into the window's tickArrays (0..2). */
    arrayIndex: number;
    /** Tick offset within that array (0..59) — the live liquidity_gross/net cell. */
    offset: number;
    /** UNBIASED tick index (= start + offset * spacing, PDA-pinned). */
    tick: number;
    /** raydiumSqrtPriceAtTick(tick) — pure function of the tick. */
    sqrtPrice: bigint;
}
export interface RaydiumClmmWindow {
    /** The three swap-sequence tick array PDAs, nearest first (walk order). */
    tickArrays: [Address, Address, Address];
    /** start_tick_index encoded in each PDA (walk order). */
    startTicks: [number, number, number];
    /** Initialized-tick boundaries in walk order (<= RAYDIUM_CLMM_MAX_BOUNDARIES). */
    boundaries: RaydiumClmmBoundary[];
    /**
     * The swap-sequence bound of the readable window — null when the boundary
     * scan stopped at RAYDIUM_CLMM_MAX_BOUNDARIES (deeper ticks the model does
     * not carry, so the walk must not step past the last shipped boundary).
     */
    edge: {
        tick: number;
        sqrtPrice: bigint;
    } | null;
    /** Contiguous prefix of tickArrays that existed as TickArrayState at prepare. */
    readable: number;
}
export interface RaydiumClmmPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** Trade direction: '0to1' (default) sells token_0 for token_1 (zero_for_one, price down). */
    direction: '0to1' | '1to0';
    ammConfig: Address;
    tokenMint0: Address;
    tokenMint1: Address;
    tokenVault0: Address;
    tokenVault1: Address;
    observation: Address;
    /** ['pool_tick_array_bitmap_extension', pool] — required by the swap when the walk leaves the default bitmap. */
    bitmapExtension: Address;
    tickSpacing: number;
    /** Snapshot at fetch time (the fragment re-reads it live from the AmmConfig). */
    tradeFeeRate: number;
    /** Snapshots at fetch time (the fragment re-reads them live from the pool). */
    liquidity: bigint;
    sqrtPrice: bigint;
    tickCurrentIndex: number;
    /** Direction-keyed prepare-declared windows (see the header). */
    windows: {
        '0to1': RaydiumClmmWindow;
        '1to0': RaydiumClmmWindow;
    };
}
/** The direction's window (the ladder adapter and the orchestrator gate read through this). */
export declare function windowFor(cfg: RaydiumClmmPoolConfig): RaydiumClmmWindow;
/** floor division toward negative infinity (TickArrayState::get_array_start_index). */
export declare function arrayStartIndex(tickIndex: number, tickSpacing: number): number;
/**
 * The three swap-sequence array starts for a direction: the array containing
 * the live tick, then two more in the walk direction (down for zero_for_one).
 * Raydium's first swap array is always the live-tick array (no whirlpool-style
 * shifted-window rule — next_initialized_tick searches within it first).
 */
export declare function windowStartTicks(tickCurrentIndex: number, tickSpacing: number, zeroForOne: boolean): [number, number, number];
/**
 * Fetch + gate one Raydium CLMM pool (see the header for the gate list) and
 * freeze both directions' boundary windows. Read-only against the loader.
 */
export declare function fetchRaydiumClmmConfig(load: AccountLoader, pool: Address): Promise<RaydiumClmmPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only — no v1 adapter). */
export declare const raydiumClmm: {
    slug: string;
    programId: Address<"CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    token2022Program: Address<"TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb">;
    memoProgram: Address<"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr">;
    fetchPoolConfig: typeof fetchRaydiumClmmConfig;
};
//# sourceMappingURL=index.d.ts.map