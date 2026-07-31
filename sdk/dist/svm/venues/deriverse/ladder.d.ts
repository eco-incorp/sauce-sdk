import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
/** Floor integer square root (mirrors the engine's Math.sqrt op / obric-v2's own isqrt). */
export declare function deriverseIsqrt(value: bigint): bigint;
/** Ceiling integer square root: smallest r with r*r >= value. */
export declare function deriverseCeilIsqrt(value: bigint): bigint;
interface LiveCurve {
    enabled: boolean;
    a: bigint;
    b: bigint;
    k: bigint;
    df: bigint;
    px: bigint;
    feePpm: bigint;
}
/** The COLD (venue-exact) quote at gross input x, SATURATING at the capacity clamp — see the file header. */
export declare function deriverseRawQuote(x: bigint, curve: LiveCurve, side: 'buy' | 'sell', icap: bigint): bigint;
export declare const deriverseLadder: {
    slug: string;
    /** CP-class: a closed-form quote (one deriverseIsqrt-derived cap + a division), 4 rungs. */
    defaultRungs: number;
    shapeKey(base: PoolConfig): string;
    helpers(): {
        name: string;
        source: string;
    }[];
    paramCount: number;
    paramsFor(base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string;
    capacityInputVar(slot: number): string;
    /** Ladder rung at cumulative grid point `x`: qRaw(min(x, icap)) — stateless, mirrors deriverseRawQuote. */
    emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string;
    /** Cold final quote — same capacity clamp, fresh locals (no rung state to reuse). */
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint;
    /** Stateless (every grid point is its own closed-form evaluation) — mirrors emitLadderQuote's min(x, icap) clamp. */
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
    /** Cumulative productive input per ORDERED grid point — min(g, icap), mirroring capacityInputVar lamport-for-lamport. */
    referenceCapacities(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
    /** Depth = the embedded AMM's own reserves (0 for a book-only instrument — the honest, disclosed under-quote). */
    depthReserves(base: PoolConfig, state: AccountBytesMap): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    continuousFees(base: PoolConfig): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
export {};
//# sourceMappingURL=ladder.d.ts.map