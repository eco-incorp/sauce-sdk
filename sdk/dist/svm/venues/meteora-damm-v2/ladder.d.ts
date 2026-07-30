import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
/**
 * aToB capacity: the largest gross input x with next_sqrt_price >= smin
 * (the band never violated). smin <= 1 cannot bind (nx is always >= 1) —
 * U64_MAX, the uncapped sentinel.
 */
export declare function meteoraDammV2CapacityAtoB(l: bigint, sp: bigint, smin: bigint): bigint;
/**
 * bToA capacity in RAW x-space: dinCap directly when collect_fee_mode == 0
 * (din == x, fee charged on output); the fee-on-input inversion above
 * otherwise. `f` (the live fee numerator) is always < FEE_DENOMINATOR (the
 * version cap tops out at 990_000_000 < 1e9), so `D − f` is always positive.
 */
export declare function meteoraDammV2CapacityBtoA(l: bigint, sp: bigint, smax: bigint, f: bigint, cm: bigint): bigint;
export declare const meteoraDammV2Ladder: {
    slug: string;
    shapeKey(base: PoolConfig): string;
    helpers(base: PoolConfig): {
        name: string;
        source: string;
    }[];
    /** Everything is a live read — no per-trade params. */
    paramCount: number;
    paramsFor(_base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number): string;
    capacityInputVar(slot: number): string;
    /**
     * Statement-mode rung: clamp x to the closed-form capacity, THEN call the
     * (still band-checked, now-defensive) helper — qRaw(min(x, C)) saturates
     * instead of the old pointwise qRaw(x) collapsing past C. `rung` is unused
     * (no warm-start state to thread — every rung is an independent closed-form
     * evaluation, byte-identical to the cold quote at that grid point).
     */
    emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string;
    /** Cold final quote — same capacity clamp, fresh locals (no rung state to reuse). */
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    referenceQuote(base: PoolConfig, state: AccountBytesMap, _params?: readonly bigint[]): (x: bigint) => bigint;
    /**
     * Cumulative productive input per ORDERED grid point — `min(g, C)`. Every
     * rung's dIn folds to its in-band portion (0 once fully past C), mirroring
     * `capacityInputVar` lamport-for-lamport (see the file header derivation).
     */
    referenceCapacities(base: PoolConfig, state: AccountBytesMap, _params?: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
    /**
     * Full-range CP-equivalent VIRTUAL reserves at the live spot (Q64.64
     * sqrt_price): a = L·2^64/sp, b = L·sp/2^64 — so isqrt(a·b) == L, the
     * canonical CLMM depth. Locally exact for the single-step in-band quote; a
     * concentrated pool's virtual depth overstates its vault balances, which
     * only ever ADMITS such a pool (the filter is relative) — the band clamp
     * in the quote keeps the math honest.
     */
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