import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
import { WHIRLPOOL_MAX_BOUNDARIES } from './index.js';
import { whirlpoolSqrtPriceAtTick } from './tick-math.js';
export { whirlpoolSqrtPriceAtTick, WHIRLPOOL_MAX_BOUNDARIES };
/** TS mirror of wpDA. */
export declare function whirlpoolDeltaA(l: bigint, lo: bigint, hi: bigint, roundUp: boolean): bigint;
/** TS mirror of wpDB. */
export declare function whirlpoolDeltaB(l: bigint, lo: bigint, hi: bigint, roundUp: boolean): bigint;
/** TS mirror of wpNxA. */
export declare function whirlpoolNextSqrtA(sp: bigint, l: bigint, amt: bigint): bigint;
export declare const orcaWhirlpoolLadder: {
    slug: string;
    /**
     * 2 rungs by default: a rung is a full cold walk (each crossed boundary
     * ~45k CU on the interpreter), the same economics that put the stable
     * families at 2 (see recipes/ecoswap/svm/budget.ts).
     */
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
    /**
     * Exact mirror of the emitted fragment given the SAME cfg + params the
     * blob was prepared with, over live account bytes — the boundary set rides
     * the params, so callers mirroring a drifted execution must pass the
     * prepare-time cfg/params (as the orchestrator and the e2e suites do).
     */
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint;
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
    referenceCapacities(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
    /**
     * Full-range CP-equivalent VIRTUAL reserves at the live spot (Q64.64):
     * a = L<<64/sp, b = L*sp>>64 — isqrt(a*b) == L, the canonical CLMM depth.
     * Same convention (and same honesty caveat) as meteora-damm-v2.
     */
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