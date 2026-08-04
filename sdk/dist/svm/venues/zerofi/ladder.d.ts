import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
export declare const zerofiLadder: {
    slug: string;
    defaultRungs: number;
    shapeKey(base: PoolConfig): string;
    helpers(): {
        name: string;
        source: string;
    }[];
    /** [bakedTop, shiftPre, num, den, feePpm] — baked in fetchPoolConfig (index.ts), see ./ieee754.ts. */
    paramCount: number;
    paramsFor(base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, params: readonly string[]): string;
    /** Stateless closed-form — every rung (and the cold final quote) is independently evaluated. */
    emitQuoteCall(_base: PoolConfig, slot: number, x: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint;
    depthReserves(base: PoolConfig, state: AccountBytesMap): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    /**
     * Measurement only (see the SvmVenueLadder doc) — this venue's realized
     * curve is FLAT (no measured curvature across a ~1000x range, see
     * index.ts's module doc), so gamma is the identity and mu is the
     * measured fee retention, mirroring obric-v2's own P-A convention.
     */
    continuousFees(base: PoolConfig): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
//# sourceMappingURL=ladder.d.ts.map