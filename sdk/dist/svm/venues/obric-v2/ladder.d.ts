import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
/** Floor integer square root (mirrors the engine's SQRT op). */
export declare function isqrt(value: bigint): bigint;
/**
 * Closed-form capacity: the largest gross input C for which `gg(x) = cOut −
 * floor(kq/(cIn+x))` stays `<= rOut` (see the file header derivation).
 * `cOut <= rOut` can never bind (gg is always `<= cOut <= rOut`) — U64_MAX,
 * the uncapped sentinel. Clamped to 0 (never negative) if the live state is
 * already past capacity at x=0.
 */
export declare function obricCapacity(cIn: bigint, cOut: bigint, kq: bigint, rOut: bigint): bigint;
/**
 * The COLD (final, venue-exact) oracle-anchored quote: the shifted-CP output
 * for gross input x, SATURATING (not collapsing) once x pushes past the live
 * output vault's capacity (see the file header — the capacity clamp is
 * applied by the caller via obricCapacity; this is the raw, unclamped curve).
 * `kq` is the quote bigK (0 ⇒ deactivated: out-of-band oracle / underflow).
 */
export declare function obricRawQuote(x: bigint, cIn: bigint, cOut: bigint, kq: bigint, fee: bigint): bigint;
/**
 * The COLD (final, venue-exact) oracle-anchored quote, capacity-clamped:
 * `obricRawQuote(min(x, C))`. This is the predicted output the minOut check
 * and the real swap see. `kq` is the quote bigK (0 ⇒ deactivated: out-of-band
 * oracle / underflow).
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
    capacityInputVar(slot: number): string;
    /**
     * Ladder rung at cumulative grid point `x`: `qRaw(min(x, C))` — SATURATING,
     * never collapsing past the live output vault's capacity (see the file
     * header). Stateless (every rung is an independent closed-form evaluation,
     * byte-identical to the cold quote at that grid point) — `rung` is unused.
     * Monotone nondecreasing; quote(0)=0. Mirrored by referenceLadderQuotes.
     */
    emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string;
    /** Cold final quote — same capacity clamp, fresh locals (no rung state to reuse). */
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    /** The COLD final quote (0 past capacity) — the lamport-exact target for emitFinalQuote. */
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint;
    /** Stateless (every grid point is its own closed-form evaluation) — mirrors emitLadderQuote's `min(x, C)` clamp. */
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
    /**
     * Cumulative productive input per ORDERED grid point — `min(g, C)`. Every
     * rung's dIn folds to its in-band portion (flat once fully past C),
     * mirroring `capacityInputVar` lamport-for-lamport (see the file header).
     */
    referenceCapacities(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
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