import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
import { MAX_BIN_ID, MIN_BIN_ID } from './bin-math.js';
declare const SLUG = "meteora-dlmm";
export declare const METEORA_DLMM_PROGRAM_ID: Address<"LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo">;
export declare const LB_PAIR_ACCOUNT_SIZE = 904;
export declare const BIN_ARRAY_ACCOUNT_SIZE = 10136;
/** sha256('account:LbPair')[0..8]. */
export declare const LB_PAIR_DISCRIMINATOR: number[];
/** sha256('account:BinArray')[0..8]. */
export declare const BIN_ARRAY_DISCRIMINATOR: number[];
export declare const BINS_PER_ARRAY = 70;
export { MAX_BIN_ID, MIN_BIN_ID };
/**
 * Shipped liquid bins per direction. Each bin is a discrete walk step (cheap
 * arithmetic + one live reserve read), so this can be larger than the CLMM
 * boundary window; sized against the engine's measured per-bin cost and moved
 * in lockstep with the fragment's unrolled setup (ladder.ts) and the mirror.
 */
export declare const METEORA_DLMM_MAX_BINS = 8;
export declare const OFF_BASE_FACTOR = 8;
export declare const OFF_FILTER_PERIOD = 10;
export declare const OFF_DECAY_PERIOD = 12;
export declare const OFF_REDUCTION_FACTOR = 14;
export declare const OFF_VARIABLE_FEE_CONTROL = 16;
export declare const OFF_MAX_VOLATILITY_ACC = 20;
export declare const OFF_PROTOCOL_SHARE = 32;
export declare const OFF_BASE_FEE_POWER_FACTOR = 34;
export declare const OFF_FUNCTION_TYPE = 35;
export declare const OFF_COLLECT_FEE_MODE = 36;
export declare const OFF_VOLATILITY_ACC = 40;
export declare const OFF_VOLATILITY_REF = 44;
export declare const OFF_INDEX_REF = 48;
export declare const OFF_LAST_UPDATE = 56;
export declare const OFF_PAIR_TYPE = 75;
export declare const OFF_ACTIVE_ID = 76;
export declare const OFF_BIN_STEP = 80;
export declare const OFF_STATUS = 82;
export declare const OFF_ACTIVATION_TYPE = 86;
export declare const OFF_ACTIVATION_POINT = 816;
export declare const OFF_BA_INDEX = 8;
export declare const OFF_BA_BINS = 56;
export declare const BIN_LEN = 144;
export declare const OFF_BIN_AMOUNT_X = 0;
export declare const OFF_BIN_AMOUNT_Y = 8;
export interface DlmmBin {
    /** Index into the window's binArrays (0..2). */
    arrayIndex: number;
    /** Bin offset within that array (0..69) — the live amount_x/amount_y cell. */
    offset: number;
    /** UNBIASED bin id. */
    binId: number;
    /** priceFromId(binId, binStep) — Q64.64, pure function of the id. */
    price: bigint;
}
export interface DlmmWindow {
    /** The bin-array PDAs covering the walk, nearest first (walk order). */
    binArrays: [Address, Address, Address];
    /** bin-array index encoded in each PDA (walk order). */
    arrayIndexes: [number, number, number];
    /** Liquid bins in walk order (<= METEORA_DLMM_MAX_BINS). */
    bins: DlmmBin[];
    /** Contiguous prefix of binArrays that existed as BinArray accounts at prepare. */
    readable: number;
}
export interface MeteoraDlmmPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** Trade direction: 'xToY' (default) sells token_x for token_y (swap_for_y, price down). */
    direction: 'xToY' | 'yToX';
    tokenXMint: Address;
    tokenYMint: Address;
    reserveX: Address;
    reserveY: Address;
    oracle: Address;
    /** ['bitmap', lb_pair] — required by the swap when the walk leaves the default bitmap. */
    bitmapExtension: Address;
    binStep: number;
    activeId: number;
    /** Immutable fee params (StaticParameters) — shipped as cfg words. */
    baseFactor: number;
    baseFeePowerFactor: number;
    variableFeeControl: number;
    maxVolatilityAccumulator: number;
    reductionFactor: number;
    filterPeriod: number;
    decayPeriod: number;
    collectFeeMode: number;
    /** Direction-keyed prepare-declared windows (see the header). */
    windows: {
        xToY: DlmmWindow;
        yToX: DlmmWindow;
    };
}
/** The direction's window (the ladder adapter and the orchestrator gate read through this). */
export declare function windowFor(cfg: MeteoraDlmmPoolConfig): DlmmWindow;
/** The three bin-array indexes the walk touches: the active array then two more in the walk direction. */
export declare function windowArrayIndexes(activeId: number, swapForY: boolean): [number, number, number];
/**
 * Fetch + gate one DLMM pair (see the header for the gate list) and freeze
 * both directions' bin windows. Read-only against the loader.
 */
export declare function fetchMeteoraDlmmConfig(load: AccountLoader, pair: Address): Promise<MeteoraDlmmPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only — no v1 adapter). */
export declare const meteoraDlmm: {
    slug: string;
    programId: Address<"LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchMeteoraDlmmConfig;
};
//# sourceMappingURL=index.d.ts.map