/**
 * Meteora DLMM bin math — exact transcription of the lb_clmm program's price
 * and amount conversions (github.com/MeteoraAg/dlmm-sdk commons/src/math/
 * {price_math,u64x64_math,u128x128_math}.rs, commons/src/extensions/bin.rs).
 *
 * A bin's PRICE is `(1 + bin_step/10000)^bin_id` in Q64.64 fixed point
 * (get_price_from_id → pow), a pure function of (bin_id, bin_step) — so it is
 * DRIFT-INVARIANT and shipped as a prepare param (the in-VM fragment never
 * runs the pow). `get_or_store_bin_price` lazily fills a bin's stored price
 * with exactly this value, so the shipped price also equals the live stored
 * field for any bin that has ever held liquidity.
 *
 * Amount conversions (SCALE_OFFSET = 64):
 * - swap_for_y (X in, Y out): out = round(price·x / 2^64); in = round(y·2^64 / price)
 * - !swap_for_y (Y in, X out): out = round(x·2^64 / price); in = round(y·price / 2^64)
 *
 * Verified against the live SOL/USDC bin_step=4 pair 5rCf1DM8... — the shipped
 * pow price equals the stored bin.price on every liquid fixture bin.
 */
export declare const SCALE_OFFSET = 64n;
export declare const ONE: bigint;
export declare const BASIS_POINT_MAX = 10000n;
export declare const MAX_BIN_PER_ARRAY = 70;
export declare const MIN_BIN_ID = -443636;
export declare const MAX_BIN_ID = 443636;
export type Rounding = 'up' | 'down';
/** mul_shr(x, y, 64, rounding) = round(x·y / 2^64). */
export declare function mulShr(x: bigint, y: bigint, rounding: Rounding): bigint;
/** shl_div(x, y, 64, rounding) = round(x·2^64 / y). */
export declare function shlDiv(x: bigint, y: bigint, rounding: Rounding): bigint;
/**
 * pow(base, exp) in Q64.64 — the u64x64_math.rs binary-exponentiation with
 * per-step `>> 64`, the reciprocal trick for base >= ONE, and the final invert
 * for negative exponents. Returns null on the venue's overflow/exp-cap aborts.
 */
export declare function pow(base: bigint, exp: number): bigint | null;
/** get_price_from_id(bin_id, bin_step): (1 + bin_step/1e4)^bin_id in Q64.64. */
export declare function priceFromId(binId: number, binStep: number): bigint;
/** get_amount_out(amount_in, price, swap_for_y, rounding). */
export declare function amountOut(amountIn: bigint, price: bigint, swapForY: boolean, rounding: Rounding): bigint;
/** get_amount_in(amount_out, price, swap_for_y, rounding). */
export declare function amountIn(amountOutValue: bigint, price: bigint, swapForY: boolean, rounding: Rounding): bigint;
/** floor(bin_id / 70) — the bin array index (toward negative infinity). */
export declare function binArrayIndex(binId: number): number;
//# sourceMappingURL=bin-math.d.ts.map