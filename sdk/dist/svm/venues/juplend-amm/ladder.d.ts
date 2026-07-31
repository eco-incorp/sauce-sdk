import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
export declare const juplendAmmLadder: {
    slug: string;
    /** A flat rate needs only its two endpoints — see file header. */
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
    /**
     * Ladder rung / final quote at cumulative grid point `x`: `qRaw(min(x,
     * C))` — SATURATING (never collapsing past the real position ceiling).
     * Stateless (no warm-start; every point is its own closed-form
     * evaluation, byte-identical to the cold quote) — `rung` is unused.
     */
    emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string;
    /** Cold final quote — same capacity clamp, fresh locals (no rung state to reuse). */
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    /**
     * swap_in CPI (amount runtime-patched): disc(8) ++ swap0to1(bool) ++
     * input u64 LE (patched) ++ amount_out_min u64 LE = 1.
     */
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    /** The slot-local emitLadderQuote reassigns per rung to the clamped `min(x, C)` input. */
    capacityInputVar(slot: number): string;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint;
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
    referenceCapacities(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
    /**
     * Depth proxy: (reserveIn, reserveOut) = (the capacity-clamp input bound,
     * the real byte-verified output cap) — the closest coherent analogue this
     * flat-rate model has to a CP curve's vault balances (see file header: the
     * model has no separate notion of "input reserve", only a derived
     * capacity). A drained/fully-utilized position (cap == 0) reads 0 depth
     * and drops out of the relative-depth filter, exactly as the venue's own
     * ceiling would refuse the fill.
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