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
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
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