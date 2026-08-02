import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
import type { GoonfiV2PoolConfig } from './index.js';
interface LiveState {
    pr: bigint;
    da: bigint;
    rout: bigint;
    active: boolean;
    thresholds: readonly bigint[];
    fees: readonly bigint[];
    /** The price+fee-tier output AT x=thresholds[8] (the tier ceiling itself,
     *  using the last/fees[8] tier), vault-clamped -- x-independent, computed
     *  once. See goonfiColdQuote's "THE TIER-CEILING + VAULT-CLAMP COLLAPSE"
     *  fix. */
    tierCeilOut: bigint;
}
/**
 * The COLD (final, venue-approximating) quote: price+fee model for gross
 * input x -- the lamport-exact target for emitFinalQuote.
 *
 * THE TIER-CEILING + VAULT-CLAMP COLLAPSE -- FIXED (was: 0 past either
 * deactivation edge, violating "nondecreasing in x, quote(0)=0"). x beyond
 * the tier ceiling now reports tierCeilOut (the setup-computed output AT the
 * ceiling itself -- the fee schedule has no tier past it, so nothing larger
 * is ever deliverable); the vault clamp now saturates at rout (this venue's
 * live balance) instead of collapsing, mirroring the on-chain fragment's own
 * per-call behavior (see emitLadderQuote's doc for the on-chain twin).
 */
export declare function goonfiColdQuote(cfg: GoonfiV2PoolConfig, x: bigint, live: LiveState): bigint;
export declare const goonfiV2Ladder: {
    slug: string;
    /** CP-class: a closed-form quote (one mulDiv + a tier lookup per rung), 4 rungs. */
    defaultRungs: number;
    shapeKey(base: PoolConfig): string;
    /** The quote is inline statement-form (last-good ladder / cold final) — no shared helper,
     *  mirroring obric-v2 (both deactivation edges must reuse the setup-declared slot locals, not a
     *  standalone pure-scalar helper — see module doc). */
    helpers(): {
        name: string;
        source: string;
    }[];
    paramCount: number;
    paramsFor(base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, params: readonly string[]): string;
    /**
     * Ladder rung at cumulative grid point `x`: the price+fee-tier output, reported as the LAST-GOOD
     * value once the walk passes either deactivation edge (the tier ceiling or the live vaultOut
     * clamp) — a capped rung's dOut is 0 and the merge never over-fills goonfi-v2 past what the
     * venue's own configured capacity or its live vault can pay. Monotone nondecreasing; quote(0)=0.
     * `${p}lx` (capacityInputVar) freezes alongside `${p}lo` at the last genuinely-productive
     * cumulative input, so a rung past either edge reports zero PRODUCTIVE input too (not the raw,
     * over-capacity grid point) — the merge-reachable half of the ladder-contract guard's required
     * capacityInputVar/referenceCapacities pair. Mirrored by referenceLadderQuotes/referenceCapacities.
     *
     * THE TIER-CEILING + VAULT-CLAMP COLLAPSE — FIXED. Both edges used to
     * latch WITHOUT recording anything, collapsing to whatever smaller grid
     * point last succeeded (measured non-monotone: maxCap/maxOut both flip to
     * 0 once the grid steps past either edge). Fixed distinctly per edge:
     * (a) the tier-ceiling edge (`x > t9`) bumps (lo, lx) up to the
     * setup-computed (tierCeilOut, t9) -- the price+fee-tier output AT the
     * ceiling itself, vault-clamped -- since ANY x beyond t9 can never exceed
     * what the ceiling itself delivers (the fee schedule has no tier past t9).
     * (b) the vault-clamp edge (`net > rout`) saturates net AT THIS x directly
     * (no inversion needed -- raw/fee are already computed for x) and records
     * (rout, x), mirroring solfi-v2/the window-walking families' own
     * saturate-in-place convention.
     */
    emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string;
    /** Names the slot-local capacityInputVar freezes (see emitLadderQuote's doc). */
    capacityInputVar(slot: number): string;
    /**
     * Cold final quote at the elected slice: price+fee model, or the same
     * tier-ceiling/vault-clamp fallback emitLadderQuote uses (see its doc) --
     * never collapses to 0 past either edge.
     */
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    /** The COLD final quote (0 past either deactivation edge) — the lamport-exact target for
     *  emitFinalQuote. */
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint;
    /** The LAST-GOOD ladder chain — mirrors emitLadderQuote (monotone, flat past either
     *  deactivation edge). */
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
    /** Mirror of capacityInputVar: the cumulative PRODUCTIVE input at each grid point — freezes at
     *  the same rung referenceLadderQuotes freezes its output at (both derive from the same walk). */
    referenceCapacities(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
    /** Depth = the actual VAULT balances (matches every other CP-family adapter). A vault drained on
     *  either side reads 0 depth and drops out of the relative-depth filter. */
    depthReserves(base: PoolConfig, state: AccountBytesMap): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    /** Measurement-only oracle (never a gate): the smallest tier's fee is the near-zero-size
     *  marginal rate, the honest representative continuous fee for this venue. */
    continuousFees(base: PoolConfig): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
export {};
//# sourceMappingURL=ladder.d.ts.map