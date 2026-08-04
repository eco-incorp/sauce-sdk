import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
export declare const metricLadder: {
    slug: string;
    defaultRungs: number;
    shapeKey(base: PoolConfig): string;
    helpers(): {
        name: string;
        source: string;
    }[];
    /** [scaleNum, scaleDen, bakedPrice] — baked in fetchPoolConfig (index.ts) from the oracle CPI. */
    paramCount: number;
    paramsFor(base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string;
    emitQuoteCall(_base: PoolConfig, slot: number, x: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    /**
     * TS mirror. Assumes the on-chain drift gate PASSES (baked-at-fetch == live-at-cook) — the
     * genuine oracle transform cannot be reproduced from `state` bytes at all (see index.ts's module
     * doc); this is a disclosed, narrow divergence from a true on-chain self-drop, never a fill-
     * quality gate (minOut remains the sole atomic backstop).
     */
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint;
    depthReserves(base: PoolConfig, state: AccountBytesMap): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    /**
     * Measurement only. The oracle spread (bid/ask, ~1bp measured — see index.ts's module doc) is
     * already folded into the baked scale, not a separate fee this ladder charges on top — so gamma
     * is the identity and mu is full retention, the same convention obric-v2/zerofi use when their
     * own venue fee is priced INTO the quote rather than deducted afterward.
     */
    continuousFees(): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
//# sourceMappingURL=ladder.d.ts.map