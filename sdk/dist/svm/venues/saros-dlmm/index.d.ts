import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "saros-dlmm";
export declare const SAROS_DLMM_PROGRAM_ID: Address<"1qbkdrr3z4ryLA7pZykqxvxWPoeifcVKo6ZG9CfkvVE">;
declare const MEMO_PROGRAM: Address<"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr">;
export declare const PAIR_ACCOUNT_SIZE = 204;
export declare const BIN_ARRAY_ACCOUNT_SIZE = 8248;
/** sha256('account:Pair')[0..8]. */
export declare const PAIR_DISCRIMINATOR: number[];
/** sha256('account:BinArray')[0..8] — identical to meteora-dlmm's (same type name). */
export declare const BIN_ARRAY_DISCRIMINATOR: number[];
export declare const BINS_PER_ARRAY = 256;
export declare const CENTER_BIN_ID = 8388608;
/**
 * Shipped liquid bins per direction — the meteora-dlmm-style bounded walk,
 * sized the same as METEORA_DLMM_MAX_BINS pending CU re-measurement against
 * this family's own compiled ladder (see budget.ts CU_FAMILIES).
 */
export declare const SAROS_DLMM_MAX_BINS = 8;
export declare const OFF_ACTIVE_ID = 127;
export declare const OFF_LAST_UPDATE = 131;
export declare const OFF_VOLATILITY_ACC = 139;
export declare const OFF_VOLATILITY_REF = 143;
export declare const OFF_INDEX_REF = 147;
export declare const OFF_BA_INDEX = 8232;
export declare const OFF_BA_BINS = 40;
export declare const BIN_LEN = 32;
export declare const OFF_BIN_RESERVE_X = 16;
export declare const OFF_BIN_RESERVE_Y = 24;
export interface SarosDlmmBin {
    /** Index into the window's [binArrayLower, binArrayUpper] pair (0 or 1). */
    arrayIndex: 0 | 1;
    /** Bin offset within that array (0..255). */
    offset: number;
    /** The RAW (already-biased) bin id — active_id's own units. */
    binId: number;
    /** priceFromId-equivalent: (1+binStep/1e4)^(binId-CENTER_BIN_ID) in Q64.64. */
    price: bigint;
}
export interface SarosDlmmWindow {
    /** The two bracketing bin-array PDAs (ascending index; both ALWAYS required by the swap ix). */
    binArrayLower: Address;
    binArrayUpper: Address;
    lowerIndex: number;
    upperIndex: number;
    /** Liquid bins in walk order (<= SAROS_DLMM_MAX_BINS); empty when either bracket array is missing/invalid. */
    bins: SarosDlmmBin[];
}
export interface SarosDlmmPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** Trade direction: 'xToY' (default) sells token_x for token_y (swap_for_y, price down). */
    direction: 'xToY' | 'yToX';
    tokenXMint: Address;
    tokenYMint: Address;
    vaultX: Address;
    vaultY: Address;
    binStep: number;
    activeId: number;
    baseFactor: number;
    variableFeeControl: number;
    maxVolatilityAccumulator: number;
    reductionFactor: number;
    filterPeriod: number;
    decayPeriod: number;
    windows: {
        xToY: SarosDlmmWindow;
        yToX: SarosDlmmWindow;
    };
}
/** The direction's window (the ladder adapter and the orchestrator gate read through this). */
export declare function windowFor(cfg: SarosDlmmPoolConfig): SarosDlmmWindow;
/**
 * The two bracketing bin-array indices for `activeId` — matching the real
 * program's own swap-account convention (cross-validated: the pair chosen
 * this way is exactly what a real swap accepts, both directions, at every
 * tested size — see the module header). `lowerIndex < upperIndex` always;
 * both cover `SAROS_DLMM_MAX_BINS` worth of headroom on either side of
 * `activeId` (256-bin arrays, an 8-bin walk never needs a third array).
 */
export declare function pairArrayIndexes(activeId: number): [number, number];
export declare function priceFromId(binId: number, binStep: number): bigint;
/**
 * Fetch + gate one Saros DLMM pair (see the module header for the gate list)
 * and freeze both directions' bin windows. Read-only against the loader.
 */
export declare function fetchSarosDlmmConfig(load: AccountLoader, pair: Address): Promise<SarosDlmmPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only — no v1 adapter). */
export declare const sarosDlmm: {
    slug: string;
    programId: Address<"1qbkdrr3z4ryLA7pZykqxvxWPoeifcVKo6ZG9CfkvVE">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchSarosDlmmConfig;
};
export { MEMO_PROGRAM as SAROS_DLMM_MEMO_PROGRAM };
//# sourceMappingURL=index.d.ts.map