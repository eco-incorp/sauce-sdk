/**
 * Orca Whirlpools tick math — exact transcription of
 * programs/whirlpool/src/math/tick_math.rs sqrt_price_from_tick_index:
 * positive ticks accumulate in Q96 with (r*C) >> 96 steps and a final >> 32,
 * negative ticks accumulate in Q64 with (r*C) >> 64 steps. Verified against
 * the source's own pinned bit-value test table (see the unit suite).
 *
 * Shared by fetchPoolConfig (deriving the shipped boundary sqrt prices), the
 * ladder mirror and the test fixtures. sqrt_price_from_tick_index is a pure
 * function of the tick, which is why a prepare-shipped sqrt price is exact
 * by construction — the engine-side fragment never recomputes it (an in-VM
 * bit ladder costs ~54k CU per call on the interpreter).
 */
export declare const MIN_TICK_INDEX = -443636;
export declare const MAX_TICK_INDEX = 443636;
export declare const MIN_SQRT_PRICE = 4295048016n;
export declare const MAX_SQRT_PRICE = 79226673515401279992447579055n;
/** sqrt_price_from_tick_index (Q64.64) over the UNBIASED tick. */
export declare function whirlpoolSqrtPriceAtTick(tick: number): bigint;
//# sourceMappingURL=tick-math.d.ts.map