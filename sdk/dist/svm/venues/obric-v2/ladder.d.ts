import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
/** Floor integer square root (mirrors the engine's SQRT op). */
export declare function isqrt(value: bigint): bigint;
/**
 * The COLD (final, venue-exact) oracle-anchored quote: the shifted-CP output
 * for gross input x, or 0 PAST CAPACITY (output would exceed reserveOut — the
 * venue's "Insufficient active" revert; a 0 final quote skips the CPI). This
 * is the predicted output the minOut check and the real swap see. `kq` is the
 * quote bigK (0 ⇒ deactivated: out-of-band oracle / underflow).
 */
export declare function obricColdQuote(x: bigint, cIn: bigint, cOut: bigint, kq: bigint, rOut: bigint, fee: bigint): bigint;
export declare const obricV2Ladder: {
    slug: string;
    /** CP-class: a closed-form quote (one isqrt + a division per rung), 4 rungs. */
    defaultRungs: number;
    shapeKey(base: PoolConfig): string;
    /** The quote is inline statement-form (last-good ladder / cold final) — no shared helper. */
    helpers(): {
        name: string;
        source: string;
    }[];
    paramCount: number;
    paramsFor(base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string;
    /**
     * Ladder rung at cumulative grid point `x`: the shifted-CP output, reported
     * as the LAST-GOOD value once the walk passes capacity (g > reserveOut) — so
     * a capped rung's dOut is 0 and the merge never over-fills obric past what
     * the venue can pay. Monotone nondecreasing; quote(0)=0. Mirrored by
     * referenceLadderQuotes.
     */
    emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string;
    /** Cold final quote at the elected slice: g(fill)−fee, or 0 past capacity (skip the CPI). */
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    /** The COLD final quote (0 past capacity) — the lamport-exact target for emitFinalQuote. */
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint;
    /** The LAST-GOOD ladder chain — mirrors emitLadderQuote (monotone, flat past capacity). */
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
    /**
     * Depth = the actual VAULT balances (isqrt(reserveIn·reserveOut)). A drained
     * Obric pool (thin inventory — the prop-AMM reality) reads 0 depth and drops
     * out of the relative-depth filter, exactly as the venue's own "Insufficient
     * active" guard would refuse the fill.
     */
    depthReserves(base: PoolConfig, state: AccountBytesMap): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    continuousFees(base: PoolConfig): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
//# sourceMappingURL=ladder.d.ts.map