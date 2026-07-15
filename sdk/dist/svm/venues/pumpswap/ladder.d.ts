import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
export declare const pumpswapLadder: {
    slug: string;
    shapeKey(base: PoolConfig): string;
    helpers(base: PoolConfig): {
        name: string;
        source: string;
    }[];
    /** Three params: lpFeeBps, protocolFeeBps, creatorFeeBps. */
    paramCount: number;
    paramsFor(base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, params: readonly string[]): string;
    emitQuoteCall(base: PoolConfig, slot: number, x: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint;
    depthReserves(base: PoolConfig, state: AccountBytesMap): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    continuousFees(base: PoolConfig, _state: AccountBytesMap, params: readonly bigint[]): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
//# sourceMappingURL=ladder.d.ts.map