import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
export declare const meteoraDammV1StableLadder: {
    slug: string;
    /** Stable slots default to 2 rungs (cap 4) — see recipes/ecoswap/svm/budget.ts. */
    defaultRungs: number;
    shapeKey(): string;
    helpers(): {
        name: string;
        source: string;
    }[];
    /** Everything is a live read — no per-trade params. */
    paramCount: number;
    paramsFor(_base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, _params: readonly string[], enableVar?: string): string;
    emitQuoteCall: undefined;
    /**
     * Ladder rung at cumulative grid point x: skips all computation once
     * `s<slot>cap` has latched (a prior rung's candidate already reached the
     * idle float — permanent and monotonic, so every later rung would only
     * re-confirm the same breach); otherwise runs the fee/vault/Newton chain
     * and either latches cap (candidate >= idle) or records the new
     * (lo, lx) = (output, cumulative input) checkpoint. Reports the CURRENT
     * checkpoint every rung — 0 dOut/dIn once frozen, exactly the
     * window-walking convention (types.ts's capacityInputVar doc).
     */
    emitLadderQuote(_base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string;
    capacityInputVar(slot: number): string;
    /** Cold final quote: reuse the ladder's last-good value if x lands exactly there, else recompute fresh from D (byte-identical to the venue's own swap path) — the DECLARED, merge-unreachable, latent collapse past the idle float (see this file's module doc). */
    emitFinalQuote(_base: PoolConfig, slot: number, x: string, outVar: string): string;
    /**
     * Shared fee/vault/Newton computation up to the post-vault-withdraw
     * candidate `<v>ov`; `warm` threads the shared `s<slot>wy` cursor
     * (mutated in place) and TAILS into the capacity FREEZE (latch cap,
     * or record the new checkpoint); cold declares a fresh `y` const and
     * TAILS into the raw idle-float COLLAPSE, assigning `coldOutVar`.
     */
    emitQuoteAt(slot: number, tag: string, x: string, y0: string, warm: boolean, coldOutVar?: string): string[];
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], now?: bigint): (x: bigint) => bigint;
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], now?: bigint): (grid: readonly bigint[]) => bigint[];
    /** Mirror of capacityInputVar: the cumulative PRODUCTIVE input at each ordered grid point — frozen at the last checkpoint below the idle float once the cap latches. Lockstep with referenceLadderQuotes (same walk, same latch condition). */
    referenceCapacities(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], now?: bigint): (grid: readonly bigint[]) => bigint[];
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