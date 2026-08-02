import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
export declare const stabbleWeightedSwapLadder: {
    slug: string;
    shapeKey(base: PoolConfig): string;
    helpers(): {
        name: string;
        source: string;
    }[];
    paramCount: number;
    paramsFor(): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, _params: readonly string[], enableVar?: string): string;
    /** Wraps + clamps `x` to the (live) MAX_IN_RATIO cap, latching permanently once exceeded, then evaluates the core weighted quote + swap fee. */
    emitLadderQuote(base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string;
    capacityInputVar(slot: number): string;
    /** Cold final quote: cache-hit when x lands exactly on the ladder's last checkpoint, else a fresh (clamped) recompute — never a stale value. */
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap): (x: bigint) => bigint;
    /**
     * THE CAPACITY COLLAPSE — FIXED. Unlike emitLadderQuote/emitFinalQuote/
     * referenceQuote (which all clamp `wrapped` to `xcap` BEFORE computing the
     * output, so they already saturate correctly and never collapse), this
     * function used to freeze `lx` at whatever smaller grid point last
     * succeeded the moment a grid point's wrapped input first exceeded `xcap`
     * — under-reporting the true capacity whenever the grid skips the narrow
     * boundary. Fixed: bump `lx` up to `calcUnwrappedAmount(xcap, tokenIn)` —
     * the exact inverse of calcWrappedAmount, so re-wrapping it is guaranteed
     * <= xcap (safe, never over-promising; exact when NOT scalingUp, floor-
     * safe when scalingUp) — before latching.
     */
    referenceCapacities(base: PoolConfig, state: AccountBytesMap): (grid: readonly bigint[]) => bigint[];
    depthReserves(base: PoolConfig, state: AccountBytesMap): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    continuousFees(base: PoolConfig, state: AccountBytesMap): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
//# sourceMappingURL=ladder.d.ts.map