import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
/** Off-chain mirror of solfiSpline (arg order matches exactly). */
export declare function solfiSplineRef(knots: {
    x: bigint[];
    y: bigint[];
    len: bigint;
}, q: bigint): bigint;
export declare const solfiV2Ladder: {
    slug: string;
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
     * Ladder rung at cumulative grid point x: freezes (cap = 1) the first time
     * this rung would trip the impact-overflow or 110%-of-vault revert boundary
     * (the real venue would abort the whole swap past either), otherwise
     * records the (possibly outVault-saturated) output as the new last-good
     * point. Once capped, all higher rungs report the SAME last-good value —
     * dOut is 0 for them, exactly the window-walking convention.
     *
     * BUMP-THEN-LATCH: the first rung to actually trip either boundary would,
     * pre-fix, freeze at whatever smaller grid point last succeeded — which
     * under-reports the true capacity whenever the grid skips the narrow
     * satCap..outCap110 saturation zone (the exact "coarse ladder gets
     * allocated ZERO" hazard). Both trip branches now bump (lo, lx) up to
     * (satOut, satCap) — the setup-computed, provably-reachable saturation
     * point — before latching, so the frozen value is never worse than what
     * setup already proved deliverable.
     */
    emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string;
    capacityInputVar(slot: number): string;
    /**
     * Cold final quote: reuse the ladder's last-good value if x lands exactly
     * there, else recompute fresh. Past either revert boundary, falls back to
     * satOut (the setup-computed, provably-reachable saturation point) when x
     * is at or beyond satCap, instead of collapsing to 0 — the one-shot twin
     * of emitLadderQuote's bump-then-latch fix (see its doc).
     */
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    /** Exact TS mirror of the emitted fragment. `now`, if given, overrides the live slot (else state must carry it — see below). */
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[], now?: bigint): (x: bigint) => bigint;
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[], now?: bigint): (grid: readonly bigint[]) => bigint[];
    referenceCapacities(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[], now?: bigint): (grid: readonly bigint[]) => bigint[];
    depthReserves(base: PoolConfig, state: AccountBytesMap): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    continuousFees(): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
//# sourceMappingURL=ladder.d.ts.map