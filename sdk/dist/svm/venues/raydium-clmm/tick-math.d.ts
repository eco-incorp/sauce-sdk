/**
 * Raydium CLMM tick math — exact transcription of
 * raydium-clmm/programs/amm/src/libraries/tick_math.rs `get_sqrt_price_at_tick`:
 * the STANDARD Uniswap-V3 magic-constant ladder, but emitting a Q64.64
 * sqrt price directly (each factor is `2^64 / 1.0001^(2^(i-1))`, accumulated
 * with `(ratio * magic) >> 64`, then reciprocated as `(2^128 - 1) / ratio`
 * for positive ticks). This is NOT Orca's whirlpool table — Raydium's
 * MAX_SQRT_PRICE (79226673521066979257578248091) differs from Orca's
 * (79226673515401279992447579055), so the two families need separate math.
 *
 * Verified against the source's pinned bounds AND the live SOL/USDC 0.04%
 * pool 3ucNos4N... (tick 0 -> 2^64; tick -25007 -> 5283561491725923125,
 * just below the pool's live mid-tick sqrt 5283759320557551589).
 *
 * Used ONLY off-chain (prepare + the mirror): a shipped boundary's sqrt price
 * is drift-invariant (a pure function of the PDA-pinned tick), so the in-VM
 * fragment never recomputes it (an in-VM bit ladder is unaffordable).
 */
export declare const MIN_TICK = -443636;
export declare const MAX_TICK = 443636;
export declare const MIN_SQRT_PRICE_X64 = 4295048016n;
export declare const MAX_SQRT_PRICE_X64 = 79226673521066979257578248091n;
/** sqrt_price_from_tick_index (Q64.64) over the UNBIASED tick. */
export declare function raydiumSqrtPriceAtTick(tick: number): bigint;
//# sourceMappingURL=tick-math.d.ts.map