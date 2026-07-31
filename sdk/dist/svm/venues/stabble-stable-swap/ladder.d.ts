import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
export declare const stabbleStableSwapLadder: {
    slug: string;
    /** 2-rung default (stable-kind pools budget for a heavier per-rung Newton) — see recipes/ecoswap/svm/budget.ts. */
    defaultRungs: number;
    shapeKey(base: PoolConfig): string;
    helpers(base: PoolConfig): {
        name: string;
        source: string;
    }[];
    paramCount: number;
    paramsFor(): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, _params: readonly string[], enableVar?: string): string;
    emitQuoteCall(base: PoolConfig, slot: number, x: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], now?: bigint): (x: bigint) => bigint;
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