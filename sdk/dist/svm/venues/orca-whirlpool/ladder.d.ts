import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
import { WHIRLPOOL_MAX_BOUNDARIES } from './index.js';
import { whirlpoolSqrtPriceAtTick } from './tick-math.js';
export { whirlpoolSqrtPriceAtTick, WHIRLPOOL_MAX_BOUNDARIES };
/** TS mirror of wpDA. */
export declare function whirlpoolDeltaA(l: bigint, lo: bigint, hi: bigint, roundUp: boolean): bigint;
/** TS mirror of wpDB. */
export declare function whirlpoolDeltaB(l: bigint, lo: bigint, hi: bigint, roundUp: boolean): bigint;
/** TS mirror of wpNxA. */
export declare function whirlpoolNextSqrtA(sp: bigint, l: bigint, amt: bigint): bigint;
export declare const orcaWhirlpoolLadder: {
    slug: string;
    /**
     * 2 rungs by default: a rung is a full cold walk (each crossed boundary
     * ~45k CU on the interpreter), the same economics that put the stable
     * families at 2 (see recipes/ecoswap/svm/budget.ts).
     */
    defaultRungs: number;
    shapeKey(base: PoolConfig): string;
    helpers(): {
        name: string;
        source: string;
    }[];
    /** [nb, (meta,sqrtHi,sqrtLo) x MAX_BOUNDARIES, edgeTick, edgeHi, edgeLo]. */
    paramCount: number;
    paramsFor(base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string;
    emitLadderQuote(base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string;
    capacityInputVar(slot: number): string;
    /**
     * THE COLD-QUOTE COLLAPSE — FIXED (on-chain fragment twin of
     * referenceQuote's own fix). Used to gate the walk's own output behind
     * full absorption (`if (fex===0 && frm===0) { outVar = fo }`), leaving
     * outVar at 0 for any x past the window's capacity — even though `fo`
     * already holds the correct, fully-saturated output by the time the walk
     * loop exits (each fully-consumed tick range's contribution is added to
     * `fo` unconditionally as the walk proceeds; a partial/final range's
     * contribution is added the same way before `frm` is zeroed). The gate was
     * never necessary: assigning `outVar = fo` unconditionally reproduces the
     * exact coldWalkClamped semantics the JS mirror now uses.
     */
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    /**
     * Exact mirror of the emitted fragment given the SAME cfg + params the
     * blob was prepared with, over live account bytes — the boundary set rides
     * the params, so callers mirroring a drifted execution must pass the
     * prepare-time cfg/params (as the orchestrator and the e2e suites do).
     */
    /**
     * THE COLD-QUOTE COLLAPSE — FIXED. Used to be `coldWalk(...) ?? 0n`:
     * coldWalk requires x to be FULLY absorbed (rm reaches exactly 0) to
     * return non-null, so any x exceeding the shipped window's capacity
     * collapsed straight to 0 instead of the window's own true saturated
     * output — violating "nondecreasing in x, quote(0)=0" (measured:
     * referenceQuote = 88,802,545,193 at x = 2^40, then 0 at x = 2^41 and
     * beyond, on a real mainnet fixture whose referenceCapacities correctly
     * saturates at 1,818,415,775,132 — only the cold quote was wrong).
     * coldWalkClamped runs the IDENTICAL walk but never returns null (it
     * reports whatever the window actually delivers, capping gracefully
     * instead of demanding full absorption) — for any x already within
     * capacity it returns the exact same `.out` coldWalk would have, and for
     * x beyond capacity it returns the window's true saturated output instead
     * of nothing. No approximation/haircut needed here (unlike solfi-v2's
     * spline-based satCap/satOut): the walk itself IS the closed form, and
     * coldWalkClamped is already the exact, no-compromise saturating version
     * of it -- referenceLadderQuotes/referenceCapacities already use it below.
     */
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint;
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
    referenceCapacities(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
    /**
     * Full-range CP-equivalent VIRTUAL reserves at the live spot (Q64.64):
     * a = L<<64/sp, b = L*sp>>64 — isqrt(a*b) == L, the canonical CLMM depth.
     * Same convention (and same honesty caveat) as meteora-damm-v2.
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