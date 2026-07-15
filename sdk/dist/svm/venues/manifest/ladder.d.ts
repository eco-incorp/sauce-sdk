import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
import { MANIFEST_MAX_ORDERS } from './index.js';
export { MANIFEST_MAX_ORDERS };
/** TS mirror of mfQfb (checked_quote_for_base). */
export declare function manifestQuoteForBase(inner: bigint, base: bigint, roundUp: boolean): bigint;
/** TS mirror of mfBfq (checked_base_for_quote). */
export declare function manifestBaseForQuote(inner: bigint, quote: bigint, roundUp: boolean): bigint;
export declare const manifestLadder: {
    slug: string;
    /**
     * 2 rungs by default: the setup (MANIFEST_MAX_ORDERS unrolled live reads over
     * the whole book account) is a heavy fixed cost, so a manifest slot is a
     * degrade-first 'stable'-class family like whirlpool (see
     * recipes/ecoswap/svm/budget.ts). The cold walk is exact at any point, so a
     * coarser rung grid only affects the split quantization, not correctness.
     */
    defaultRungs: number;
    shapeKey(base: PoolConfig): string;
    helpers(): {
        name: string;
        source: string;
    }[];
    /** [nb, (DataIndex, sequenceNumber) x MANIFEST_MAX_ORDERS]. */
    paramCount: number;
    paramsFor(base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string;
    emitLadderQuote(base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string;
    capacityInputVar(slot: number): string;
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    /**
     * Exact mirror of the emitted fragment given the SAME cfg + params the blob
     * was prepared with, over live account bytes — the shipped order set rides
     * the params (DataIndex + seq), so callers mirroring a drifted execution must
     * pass the prepare-time cfg/params (as the orchestrator and e2e suites do).
     */
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint;
    /**
     * Pointwise mirror of the emitted `lx` booking: the productive gross input
     * matched at each grid point (== the point while the book absorbs it, the
     * book depth beyond). No capped carry — each rung walks independently, so
     * the emit recomputes lx per rung and this maps each grid point on its own.
     */
    referenceCapacities(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
    /**
     * Depth for the relative filter: the shipped top-of-book aggregate. reserveIn
     * = total input capacity across the shipped levels, reserveOut = total output
     * — isqrt(in*out) gives a book-depth metric comparable to a pool's reserves.
     */
    depthReserves(base: PoolConfig, state: AccountBytesMap): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    /**
     * Manifest is ZERO-fee and not a constant-product curve — the continuous CP
     * oracle is meaningless here (it is measurement-only and CP-class-only). No
     * fee, unit multiplier.
     */
    continuousFees(): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
//# sourceMappingURL=ladder.d.ts.map