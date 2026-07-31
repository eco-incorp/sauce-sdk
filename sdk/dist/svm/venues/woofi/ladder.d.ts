import type { SvmVenueLadderV2 } from '../types.js';
interface PriceOutInputs {
    now: bigint;
    wooraclePrice: bigint;
    updatedAt: bigint;
    staleDuration: bigint;
    bound: bigint;
    rangeMin: bigint;
    rangeMax: bigint;
    maximumAge: bigint;
    basePythPrice: bigint;
    basePythPublishTime: bigint;
    basePythVerified: boolean;
    quotePythPrice: bigint;
    quotePythPublishTime: bigint;
    quotePythVerified: boolean;
    pythQuoteDecPow: bigint;
    paused: boolean;
}
/** `get_price_impl`, mirrored bit-for-bit (see file header). Returns 0 on any self-drop condition. */
export declare function woofiPriceOut(i: PriceOutInputs): bigint;
/** `calc_quote_amount_sell_base` (swap_math.rs), mirrored bit-for-bit. 0 on any of its own requires failing. */
export declare function woofiCalcQuoteAmountSellBase(x: bigint, priceOut: bigint, coeff: bigint, spread: bigint, priceDec: bigint, quoteDec: bigint, baseDec: bigint, maxGamma: bigint, maxNotionalSwap: bigint): bigint;
/** `calc_base_amount_sell_quote` (swap_math.rs), mirrored bit-for-bit. */
export declare function woofiCalcBaseAmountSellQuote(q: bigint, priceOut: bigint, coeff: bigint, spread: bigint, priceDec: bigint, quoteDec: bigint, baseDec: bigint, maxGamma: bigint, maxNotionalSwap: bigint): bigint;
/** The fee both directions charge once, ROUNDING UP (see file header). Returns the NET quote amount (never negative). */
export declare function woofiApplyFee(quoteAmount: bigint, feeRate: bigint): bigint;
/** sellBase capacity: the largest x (base units) that keeps every closed-form cap satisfied (0 if priceOut deactivated). */
export declare function woofiSellBaseCapacity(priceOut: bigint, priceDec: bigint, quoteDec: bigint, baseDec: bigint, coeff: bigint, maxGamma: bigint, maxNotionalSwap: bigint, capBal: bigint, minSwapAmount: bigint, quoteVaultAvailable: bigint): bigint;
/** sellQuote capacity: the largest x (quote units) that keeps every closed-form cap satisfied. */
export declare function woofiSellQuoteCapacity(priceOut: bigint, priceDec: bigint, quoteDec: bigint, baseDec: bigint, coeff: bigint, maxGamma: bigint, maxNotionalSwap: bigint, capBal: bigint, baseVaultAvailable: bigint): bigint;
export declare const woofiLadder: SvmVenueLadderV2;
export {};
//# sourceMappingURL=ladder.d.ts.map