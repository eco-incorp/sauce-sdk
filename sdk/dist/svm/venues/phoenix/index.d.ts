import type { Address } from '@solana/kit';
import type { AccountBytesMap, AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "phoenix";
export declare const PHOENIX_PROGRAM_ID: Address<"PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY">;
/** u64 LE @0 — accounts.rs `check_discriminants` asserts this exact value for MarketHeader. */
export declare const MARKET_DISCRIMINANT = 8167313896524341111n;
export declare const OFF_TAKER_FEE_BPS: number;
/** Node array start of the `bids` tree — market-invariant (the allocator header is fixed size). */
export declare const BIDS_NODES_BASE: number;
/**
 * Shipped top-of-book levels per direction. Half of manifest's 16 (a
 * heavier per-level walk: two budget checks plus the fee-adjusted-budget
 * setup) — MEASURED (not guessed): 588,522 CU @2 rungs / 831,135 CU @4
 * rungs on the real engine against the checked-in real SOL/USDC fixture
 * (`the consuming app cu e2e test`, `CU_FAMILIES.phoenix` in budget.ts), both
 * comfortably under the ~1.19M admission budget with room for a companion
 * slot. At this depth the shipped bid window alone absorbs ~713 SOL before
 * exhausting (see `docs/phoenix-evidence.md`) — far beyond a typical trade
 * — so 8 is not a binding liquidity constraint at this snapshot; raise it
 * only if a future measurement shows CU headroom AND a real market where 8
 * levels genuinely caps absorption.
 */
export declare const PHOENIX_MAX_ORDERS = 8;
export interface PhoenixOrder {
    /** 1-based sokoban node index (register value, NOT a byte offset). */
    nodeIndex: number;
    /** Monotonic per-order id — the drift-invariant live identity anchor. */
    orderSequenceNumber: bigint;
}
export interface PhoenixWindow {
    /** Best-first resting orders (walk order) — the taker's match sequence. */
    orders: PhoenixOrder[];
}
export interface PhoenixPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'baseIn' (default) sells base for quote (matches BIDS); 'quoteIn' buys base with quote (matches ASKS). */
    direction: 'baseIn' | 'quoteIn';
    baseMint: Address;
    quoteMint: Address;
    baseVault: Address;
    quoteVault: Address;
    baseDecimals: number;
    quoteDecimals: number;
    /** Atoms per base lot (immutable post-init — no admin instruction mutates it). */
    baseLotSize: bigint;
    /** Atoms per quote lot (immutable post-init). */
    quoteLotSize: bigint;
    /** Base lots per whole base unit (immutable post-init). */
    baseLotsPerBaseUnit: bigint;
    /** Quote lots per base unit per tick (immutable post-init). */
    tickSizeInQuoteLotsPerBaseUnit: bigint;
    /** Node array start of the `asks` tree — per-market (depends on `bids_size`). */
    asksNodesBase: number;
    /** Direction-keyed prepare-declared order windows (see the header). */
    windows: {
        baseIn: PhoenixWindow;
        quoteIn: PhoenixWindow;
    };
}
/** The direction's window (the ladder adapter and the orchestrator gate read through this). */
export declare function phoenixWindowFor(cfg: PhoenixPoolConfig): PhoenixWindow;
/**
 * Fetch + gate one Phoenix market (account size/discriminant, classic-SPL
 * mints — the Swap ix has no separate mint accounts, so it is Tokenkeg-only,
 * mirroring manifest's identical gate) and freeze both directions' top-of-book
 * order windows. Read-only against the loader.
 */
export declare function fetchPhoenixConfig(load: AccountLoader, pool: Address): Promise<PhoenixPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only — no v1 adapter). */
export declare const phoenix: {
    slug: string;
    programId: Address<"PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchPhoenixConfig;
};
/**
 * Exact mirror of the emitted fragment given the SAME cfg + params + live fee
 * the blob was prepared with. `readFee` supplies `taker_fee_bps` from the SAME
 * live account bytes (the fragment reads it live too — see the module header).
 */
export declare function referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint;
/** Pointwise mirror of the emitted `lx` capacity booking — the productive gross input consumed. */
export declare function referenceCapacities(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (grid: readonly bigint[]) => bigint[];
/** Depth for the relative filter: the shipped top-of-book aggregate (atoms). */
export declare function depthReserves(base: PoolConfig, state: AccountBytesMap): {
    reserveIn: bigint;
    reserveOut: bigint;
};
export {};
//# sourceMappingURL=index.d.ts.map