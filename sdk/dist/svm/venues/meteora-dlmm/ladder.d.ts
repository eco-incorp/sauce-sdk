import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
import { METEORA_DLMM_MAX_BINS } from './index.js';
import { priceFromId } from './bin-math.js';
export { priceFromId, METEORA_DLMM_MAX_BINS };
export declare const meteoraDlmmLadder: {
    slug: string;
    /** 2 rungs by default: a rung is a full cold bin walk (degrade-first class, like the CLMMs). */
    defaultRungs: number;
    shapeKey(base: PoolConfig): string;
    helpers(): {
        name: string;
        source: string;
    }[];
    /** [baseFee, binStep, vfc, maxVfa, reductionFactor, filterPeriod, decayPeriod, nb, (meta,priceHi,priceLo) x MAX_BINS]. */
    paramCount: number;
    paramsFor(base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string;
    emitLadderQuote(base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string;
    capacityInputVar(slot: number): string;
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[], now?: bigint): (x: bigint) => bigint;
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[], now?: bigint): (grid: readonly bigint[]) => bigint[];
    referenceCapacities(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[], now?: bigint): (grid: readonly bigint[]) => bigint[];
    /** Depth proxy: the shipped window's out-side liquidity + the input to drain it. */
    depthReserves(base: PoolConfig, state: AccountBytesMap, now?: bigint): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    continuousFees(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
//# sourceMappingURL=ladder.d.ts.map