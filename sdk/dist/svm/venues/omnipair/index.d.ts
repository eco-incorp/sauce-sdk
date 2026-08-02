import type { Address } from '@solana/kit';
import type { AccountBytesMap, AccountLoader, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
declare const SLUG = "omnipair";
export declare const OMNIPAIR_PROGRAM_ID: Address<"omnixgS8fnqHfCcTGKWj6JtKjzpJZ1Y5y9pyFkQDkYE">;
export declare const PAIR_ACCOUNT_SIZE = 350;
/** sha256('account:Pair')[0..8]. */
export declare const PAIR_DISCRIMINATOR: number[];
export interface OmnipairPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'aToB' (default, token0 in / token1 out) | 'bToA'. */
    direction: 'aToB' | 'bToA';
    token0Mint: Address;
    token1Mint: Address;
    rateModel: Address;
    futarchyAuthority: Address;
    eventAuthority: Address;
    reserveVault0: Address;
    reserveVault1: Address;
    /** Immutable per-pair Borsh option-tag offset for reserve0 (147 tag=None, 149 tag=Some) — part of the shape key. */
    reserveBase: 147 | 149;
    token0Decimals: number;
    token1Decimals: number;
}
/** Fetch + decode one Pair, deriving the fixed accounts the swap CPI needs. Read-only against the loader. */
export declare function fetchOmnipairPoolConfig(load: AccountLoader, pool: Address): Promise<OmnipairPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only, like orca-whirlpool/raydium-clmm/defituna). */
export declare const omnipair: {
    slug: string;
    programId: Address<"omnixgS8fnqHfCcTGKWj6JtKjzpJZ1Y5y9pyFkQDkYE">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchOmnipairPoolConfig;
};
/**
 * Closed-form capacity: the largest gross input `x` for which
 * `amountOut(x) <= cashOut` holds (see the module header derivation).
 * `U64_MAX` when `reserveOut <= cashOut` (never binds).
 */
export declare function omnipairCapacity(reserveIn: bigint, reserveOut: bigint, cashOut: bigint, feeBps: bigint): bigint;
/** The COLD (venue-exact) quote for gross input x, saturating at the capacity clamp. */
export declare function omnipairQuote(x: bigint, ri: bigint, ro: bigint, fb: bigint, icap: bigint): bigint;
export declare const omnipairLadder: {
    slug: string;
    /** CP-class: one mul + one div per rung (plus the capacity clamp), 4 rungs. */
    defaultRungs: number;
    shapeKey(base: PoolConfig): string;
    /** Everything is inline statement-form (capacity-aware, like obric-v2) — no shared helper. */
    helpers(_base: PoolConfig): {
        name: string;
        source: string;
    }[];
    paramCount: number;
    paramsFor(_base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, _params: readonly string[], enableVar?: string): string;
    capacityInputVar(slot: number): string;
    /**
     * Ladder rung at cumulative grid point `x`: `qOmnipair(min(x, icap))` —
     * SATURATING (never collapses past the live cash-reserve capacity). Stateless
     * (every rung is an independent closed-form evaluation) — `rung` is unused.
     */
    emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string;
    /** Cold final quote — same capacity clamp, fresh locals (no rung state to reuse). */
    emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string;
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    /** The COLD final quote (0 past capacity) — the lamport-exact target for emitFinalQuote. No per-trade params (paramCount 0); `now` is unused (no time-dependent state). */
    referenceQuote(base: PoolConfig, state: AccountBytesMap, _params?: readonly bigint[], _now?: bigint): (x: bigint) => bigint;
    /** Stateless (every grid point is its own closed-form evaluation) — mirrors emitLadderQuote's `min(x, icap)` clamp. */
    referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap, _params?: readonly bigint[], _now?: bigint): (grid: readonly bigint[]) => bigint[];
    /**
     * Cumulative productive input per ORDERED grid point — `min(g, icap)`.
     * Mirrors `capacityInputVar` lamport-for-lamport (see the module header).
     */
    referenceCapacities(base: PoolConfig, state: AccountBytesMap, _params?: readonly bigint[], _now?: bigint): (grid: readonly bigint[]) => bigint[];
    /**
     * Depth = the CASH reserves (the real swappable liquidity), not the virtual
     * curve reserves — a heavily-borrowed-against pair reads thinner depth than
     * its notional reserve suggests, matching the relative-depth filter's
     * intent (mirrors obric-v2's "actual vault balance, not notional" choice).
     */
    depthReserves(base: PoolConfig, state: AccountBytesMap, _now?: bigint): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    continuousFees(base: PoolConfig, state: AccountBytesMap, _params?: readonly bigint[]): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
export {};
//# sourceMappingURL=index.d.ts.map