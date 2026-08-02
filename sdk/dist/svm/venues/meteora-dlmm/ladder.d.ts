import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
import { METEORA_DLMM_MAX_BINS } from './index.js';
import { priceFromId } from './bin-math.js';
export { priceFromId, METEORA_DLMM_MAX_BINS };
export declare const meteoraDlmmLadder: {
    slug: string;
    /** 2 rungs by default: a rung is a full cold bin walk (degrade-first class, like the CLMMs). */
    defaultRungs: number;
    shapeKey(base: PoolConfig): string;
    helpers(): {
        name: string;
        source: string;
    }[];
    /** [baseFee, binStep, vfc, maxVfa, reductionFactor, filterPeriod, decayPeriod, nb, (meta,priceHi,priceLo) x MAX_BINS]. */
    paramCount: number;
    paramsFor(base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string;
    /**
     * Ladder rung at cumulative grid point x: uses emitBinWalkIncremental
     * (resumes from the persisted wk/wcb/wob cursor set up in emitSetup)
     * instead of a full restart-from-bin-0 walk -- measured -34.35% CU per
     * marginal rung (194,368 -> 127,613 CU) on a real fixture, verified
     * lamport-exact against the restart model across multiple sizes and rung
     * counts (see emitBinWalkIncremental's doc for why this is exact, not an
     * approximation). Rung count is unchanged; only the per-rung cost drops.
     */
    emitLadderQuote(base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string;
    capacityInputVar(slot: number): string;
    /**
     * THE COLD-QUOTE COLLAPSE — FIXED (on-chain fragment twin of
     * referenceQuote's own fix — see orca-whirlpool's emitFinalQuote doc for
     * the full mechanism). Used to gate the walk's own output behind full
     * absorption, leaving outVar at 0 for any x past the window's capacity
     * even though `fout` already holds the correct saturated output. Assigning
     * outVar = fout unconditionally reproduces coldWalkClamped's semantics.
     */
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    /**
     * THE COLD-QUOTE COLLAPSE — FIXED. Same defect and same fix as
     * orca-whirlpool/raydium-clmm's referenceQuote (see orca-whirlpool's doc
     * for the full mechanism): `coldWalk(...) ?? 0n` required full absorption
     * to return non-null, so any x past the shipped bin window's capacity
     * collapsed to 0 forever instead of the window's own true saturated
     * output (measured, both directions: xToY last-nonzero 179,539,068,913 at
     * 2^41 -> 0 at 2^42 while referenceCapacities correctly saturates at
     * 2,518,898,410,454; yToX last-nonzero 1,678,147,206,870 at 2^37 -> 0 at
     * 2^38 while referenceCapacities saturates at 210,552,340,323).
     * coldWalkClamped runs the identical bin walk but never returns null —
     * exact, no approximation needed, same as orca-whirlpool/raydium-clmm.
     */
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[], now?: bigint): (x: bigint) => bigint;
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[], now?: bigint): (grid: readonly bigint[]) => bigint[];
    referenceCapacities(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[], now?: bigint): (grid: readonly bigint[]) => bigint[];
    /** Depth proxy: the shipped window's out-side liquidity + the input to drain it. */
    depthReserves(base: PoolConfig, state: AccountBytesMap, now?: bigint): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    continuousFees(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
//# sourceMappingURL=ladder.d.ts.map