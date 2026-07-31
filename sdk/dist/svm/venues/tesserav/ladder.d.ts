import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
/** Conservative haircut applied to price0 before quoting — see the file header. 20 bps. */
export declare const SAFETY_NUM = 998n;
export declare const SAFETY_DEN = 1000n;
/** TS mirror of qTvAB. */
export declare function tesseraVQuoteAB(x: bigint, price0: bigint, mid: bigint, capIn: bigint): bigint;
/** TS mirror of qTvBA. */
export declare function tesseraVQuoteBA(x: bigint, price0: bigint, mid: bigint, capIn: bigint): bigint;
export declare const tesseravLadder: {
    slug: string;
    shapeKey(base: PoolConfig): string;
    helpers(base: PoolConfig): {
        name: string;
        source: string;
    }[];
    paramCount: number;
    paramsFor(): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number): string;
    emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string;
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    capacityInputVar(slot: number): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap): (x: bigint) => bigint;
    referenceCapacities(base: PoolConfig, state: AccountBytesMap): (grid: readonly bigint[]) => bigint[];
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