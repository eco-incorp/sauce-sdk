import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
export declare const meteoraDammV1StableLadder: {
    slug: string;
    /** Stable slots default to 2 rungs (cap 4) — see recipes/ecoswap/svm/budget.ts. */
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
    emitQuoteCall: undefined;
    emitLadderQuote(_base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string;
    emitFinalQuote(_base: PoolConfig, slot: number, x: string, outVar: string): string;
    /** Shared quote body; `warm` threads the y cursor local, cold reads y0 fresh. */
    emitQuoteBody(slot: number, tag: string, x: string, outVar: string, y0: string, warm: boolean): string[];
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], now?: bigint): (x: bigint) => bigint;
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], now?: bigint): (grid: readonly bigint[]) => bigint[];
    depthReserves(base: PoolConfig, state: AccountBytesMap, now?: bigint): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    continuousFees(base: PoolConfig, state: AccountBytesMap): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
//# sourceMappingURL=ladder.d.ts.map