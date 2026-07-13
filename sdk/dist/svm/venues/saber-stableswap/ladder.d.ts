import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
export declare const saberStableswapLadder: {
    slug: string;
    /** Stable slots default to 2 rungs (cap 4) — a Newton quote is ~2 orders costlier than a CP one. */
    defaultRungs: number;
    shapeKey(): string;
    helpers(): {
        name: string;
        source: string;
    }[];
    /** Everything is a live read — no per-trade params. */
    paramCount: number;
    paramsFor(_base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, _params: readonly string[], enableVar?: string): string;
    emitLadderQuote(_base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string;
    emitFinalQuote(_base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], now?: bigint): (x: bigint) => bigint;
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], now?: bigint): (grid: readonly bigint[]) => bigint[];
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