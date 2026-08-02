import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
import { RAYDIUM_CLMM_MAX_BOUNDARIES } from './index.js';
import { raydiumSqrtPriceAtTick } from './tick-math.js';
export { raydiumSqrtPriceAtTick, RAYDIUM_CLMM_MAX_BOUNDARIES };
/** TS mirror of rcD0. */
export declare function raydiumDelta0(l: bigint, lo: bigint, hi: bigint, roundUp: boolean): bigint;
/** TS mirror of rcD1 (bit-identical to whirlpool wpDB). */
export declare function raydiumDelta1(l: bigint, lo: bigint, hi: bigint, roundUp: boolean): bigint;
/** TS mirror of rcNx0. */
export declare function raydiumNextSqrt0(sp: bigint, l: bigint, amt: bigint): bigint;
export declare const raydiumClmmLadder: {
    slug: string;
    /** 2 rungs by default (each rung is a full cold walk — CLMM economics, see budget.ts). */
    defaultRungs: number;
    shapeKey(base: PoolConfig): string;
    helpers(): {
        name: string;
        source: string;
    }[];
    /** [nb, (meta,sqrtHi,sqrtLo) x MAX_BOUNDARIES, edgeTick, edgeHi, edgeLo]. */
    paramCount: number;
    paramsFor(base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string;
    emitLadderQuote(base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string;
    capacityInputVar(slot: number): string;
    /**
     * THE COLD-QUOTE COLLAPSE — FIXED (on-chain fragment twin of
     * referenceQuote's own fix — see orca-whirlpool's emitFinalQuote doc for
     * the full mechanism). Used to gate the walk's own output behind full
     * absorption, leaving outVar at 0 for any x past the window's capacity
     * even though `fo` already holds the correct saturated output. Assigning
     * outVar = fo unconditionally reproduces coldWalkClamped's semantics.
     */
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    /**
     * THE COLD-QUOTE COLLAPSE — FIXED. Same defect and same fix as
     * orca-whirlpool's referenceQuote (see its doc for the full mechanism):
     * `coldWalk(...) ?? 0n` required full absorption to return non-null, so
     * any x past the shipped window's capacity collapsed to 0 forever instead
     * of the window's own true saturated output (measured, both directions:
     * 0to1 last-nonzero 5,617,442,468 at 2^36 -> 0 at 2^37 while
     * referenceCapacities correctly saturates at 95,185,556,484; 1to0
     * last-nonzero 104,951,027,622 at 2^33 -> 0 at 2^34 while
     * referenceCapacities saturates at 11,011,525,605). coldWalkClamped runs
     * the identical walk but never returns null — exact, no approximation
     * needed, same as orca-whirlpool.
     */
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint;
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
    referenceCapacities(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
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