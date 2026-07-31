import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
export declare const meteoraDbcLadder: {
    slug: string;
    shapeKey(base: PoolConfig): string;
    helpers(_base: PoolConfig): {
        name: string;
        source: string;
    }[];
    paramCount: number;
    paramsFor(_base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number): string;
    capacityInputVar(slot: number): string;
    /** Statement-mode rung: clamp x to the closed-form capacity, then quote. `rung` is unused — every rung is an independent closed-form evaluation. */
    emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string;
    /** Cold final quote — same capacity clamp, fresh locals (no rung state to reuse). */
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, _params?: readonly bigint[], now?: bigint): (x: bigint) => bigint;
    referenceCapacities(base: PoolConfig, state: AccountBytesMap, _params?: readonly bigint[], now?: bigint): (grid: readonly bigint[]) => bigint[];
    /**
     * Full-range CP-equivalent VIRTUAL reserves of the ACTIVE segment at the
     * live spot (Q64.64 sqrt_price): a = L*2^64/sp, b = L*sp/2^64, so
     * isqrt(a*b) == L, the canonical CLMM depth (same shim meteora-damm-v2
     * uses). Locally exact for the single-segment in-band quote.
     */
    depthReserves(base: PoolConfig, state: AccountBytesMap, _now?: bigint): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    continuousFees(base: PoolConfig, state: AccountBytesMap, _params?: readonly bigint[]): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
//# sourceMappingURL=ladder.d.ts.map