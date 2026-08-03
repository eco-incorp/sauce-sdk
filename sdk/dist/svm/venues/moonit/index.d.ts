import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadder } from '../types.js';
declare const SLUG: "moonit";
export declare const MOONIT_PROGRAM_ID: Address;
/** Floor integer square root (mirrors the engine's SQRT op — same algorithm as obric-v2's isqrt). */
declare function isqrt(value: bigint): bigint;
export interface MoonitPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** exactIn side: 'quoteToBase' (default, buy: SOL in, tokens out) | 'baseToQuote' (sell). */
    direction: 'quoteToBase' | 'baseToQuote';
    mint: Address;
    curveTokenAccount: Address;
    dexFee: Address;
    helioFee: Address;
    /** coefA baked as (hi,lo) u64 halves at SCALE_A — see the module header. */
    awHi: bigint;
    awLo: bigint;
    /** coefB baked at SCALE_B (always fits a single u64). */
    bwFixed: bigint;
    /** 10^decimals. */
    tdScale: bigint;
    feeBps: bigint;
}
/** Derive coefA/coefB's fixed-point bakes from the CurveAccount's static fields (exact bigint, no rounding until the single final step). */
declare function bakeCoefficients(totalSupplyRaw: bigint, coefBRaw: bigint, marketcapThresholdRaw: bigint, decimals: bigint): {
    awHi: bigint;
    awLo: bigint;
    bwFixed: bigint;
    tdScale: bigint;
};
export declare const moonit: {
    slug: "moonit";
    programId: Address;
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<MoonitPoolConfig>;
};
/** BUY: exact gross collateral `y` in (fee taken off the input) -> tokens out, capped at the curve's live inventory. */
declare function referenceBuy(y: bigint, m: bigint, aw: bigint, bw: bigint, td: bigint, feeBps: bigint, curveAmount: bigint): bigint;
/** SELL: exact tokens `x` in (fee taken off the output) -> collateral out. Saturates at the live sold position (never over-sells). */
declare function referenceSell(x: bigint, m: bigint, aw: bigint, bw: bigint, td: bigint, feeBps: bigint): bigint;
export declare const moonitLadder: SvmVenueLadder;
export { referenceBuy as _referenceBuyForTest, referenceSell as _referenceSellForTest, bakeCoefficients as _bakeCoefficientsForTest, isqrt as _isqrtForTest };
//# sourceMappingURL=index.d.ts.map