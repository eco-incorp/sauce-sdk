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
     * `s<slot>cap` has latched (a prior rung's own grid point already exceeded
     * the analytic clamp `s<slot>xc` — permanent, since rungs are
     * non-decreasing cumulative inputs, so nothing later can ever be
     * smaller); otherwise clamps this rung's input to `min(x, xc)` (latching
     * `cap` if the clamp bound) and runs the WARM fee/vault/Newton chain,
     * which records the new (lo, lx) = (output, cumulative input) checkpoint
     * whenever the forward-evaluated candidate genuinely clears the idle
     * float. Reports the CURRENT checkpoint every rung — 0 dOut/dIn once
     * frozen, exactly the window-walking convention (types.ts's
     * capacityInputVar doc).
     */
    emitLadderQuote(_base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string;
    capacityInputVar(slot: number): string;
    /** Cold final quote: reuse the ladder's last-good value if x lands exactly there, else recompute fresh from D (byte-identical to the venue's own swap path) — the DECLARED, merge-unreachable, latent collapse past the idle float (see this file's module doc). */
    emitFinalQuote(_base: PoolConfig, slot: number, x: string, outVar: string): string;
    /**
     * Shared fee/vault/Newton computation up to the post-vault-withdraw
     * candidate `<v>ov`; `warm` threads the shared `s<slot>wy` cursor
     * (mutated in place) and TAILS into a residual never-over-quote guard
     * (the caller already clamped `x` to the analytic capacity, so `<v>ov` is
     * PROVEN to clear the idle float — this guard only ever fails to fire,
     * see this file's module doc); cold declares a fresh `y` const and TAILS
     * into the raw idle-float COLLAPSE, assigning `coldOutVar` — the declared,
     * merge-unreachable, latent idle-float cliff (see this file's module doc and
     * `emitFinalQuote`). It sits in the same GENERAL class of merge-unreachable
     * cold-quote gap as orca-whirlpool/raydium-clmm/meteora-dlmm/solfi-v2 — a
     * standalone cold `referenceQuote` that collapses past a bound the caller's
     * analytic-capacity clamp keeps off the merge path — but NOT the same
     * MECHANISM: the three CL families' cliff is a tick/bin cold-walk window
     * exhaustion (their `coldWalkClamped` convention, see this file's module doc)
     * and solfi-v2's is a closed-form output-vault saturation, whereas this
     * family's is the idle-float / double-floor vault-withdraw collapse. And of
     * the five, only THIS family's cold quote still collapses: the other four
     * were saturated by the five-family correctness batch, leaving this the sole
     * `declaredCliffs` entry (see sdk/test/svm/venues/ladder-contract.test.ts).
     */
    emitQuoteAt(slot: number, tag: string, x: string, y0: string, warm: boolean, coldOutVar?: string): string[];
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], now?: bigint): (x: bigint) => bigint;
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], now?: bigint): (grid: readonly bigint[]) => bigint[];
    /**
     * Mirror of capacityInputVar: the cumulative PRODUCTIVE input at each
     * ordered grid point — clamped to the analytic capacity `xc` once a
     * rung's own grid point would exceed it (never the raw grid point past
     * that; see this file's module doc), frozen forever after. Lockstep with
     * referenceLadderQuotes (same walk, same clamp).
     */
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