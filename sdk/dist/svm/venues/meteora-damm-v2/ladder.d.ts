import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
export declare const meteoraDammV2Ladder: {
    slug: string;
    shapeKey(base: PoolConfig): string;
    helpers(base: PoolConfig): {
        name: string;
        source: string;
    }[];
    /** Everything is a live read — no per-trade params. */
    paramCount: number;
    paramsFor(_base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number): string;
    emitQuoteCall(base: PoolConfig, slot: number, x: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, _params?: readonly bigint[]): (x: bigint) => bigint;
    /**
     * Full-range CP-equivalent VIRTUAL reserves at the live spot (Q64.64
     * sqrt_price): a = L·2^64/sp, b = L·sp/2^64 — so isqrt(a·b) == L, the
     * canonical CLMM depth. Locally exact for the single-step in-band quote; a
     * concentrated pool's virtual depth overstates its vault balances, which
     * only ever ADMITS such a pool (the filter is relative) — the band clamp
     * in the quote keeps the math honest.
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