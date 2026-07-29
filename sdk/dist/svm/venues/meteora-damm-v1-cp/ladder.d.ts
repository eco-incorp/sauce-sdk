import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
export declare const meteoraDammV1CpLadder: {
    slug: string;
    /** CP default — no explicit defaultRungs (the codegen falls back to 4). */
    shapeKey(): string;
    helpers(): {
        name: string;
        source: string;
    }[];
    /** Everything is a live read — no per-trade params (matches the stable sibling). */
    paramCount: number;
    paramsFor(_base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number): string;
    emitQuoteCall(_base: PoolConfig, slot: number, x: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], now?: bigint): (x: bigint) => bigint;
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