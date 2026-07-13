import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "manifest";
export declare const MANIFEST_PROGRAM_ID: Address<"MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms">;
/** MarketFixed size — the dynamic RB-tree/free-list region begins here. */
export declare const MARKET_FIXED_SIZE = 256;
/** sha256-independent packed discriminant (u64 LE @0) — MARKET_FIXED_DISCRIMINANT. */
export declare const MARKET_DISCRIMINANT = 4859840929024028656n;
/** Price is stored as QuoteAtomsPerBaseAtom.inner = price * 1e18 (u128 LE). */
export declare const PRICE_D18 = 1000000000000000000n;
export declare const OFF_BASE_MINT_DECIMALS = 9;
export declare const OFF_QUOTE_MINT_DECIMALS = 10;
export declare const OFF_BIDS_ROOT = 156;
export declare const OFF_BIDS_BEST = 160;
export declare const OFF_ASKS_ROOT = 164;
export declare const OFF_ASKS_BEST = 168;
export declare const OFF_NODE_LEFT = 0;
export declare const OFF_NODE_RIGHT = 4;
export declare const OFF_NODE_PARENT = 8;
export declare const OFF_ORDER_PRICE = 16;
export declare const OFF_ORDER_SIZE = 32;
export declare const OFF_ORDER_SEQ = 40;
export declare const OFF_ORDER_LAST_VALID_SLOT = 52;
export declare const OFF_ORDER_IS_BID = 56;
export declare const OFF_ORDER_TYPE = 57;
/** u32::MAX — the tree/free-list null pointer (state/hypertree.rs). */
export declare const NIL = 4294967295;
/** OrderType::Global — draws from a separate global account; a taker halts at it. */
export declare const ORDER_TYPE_GLOBAL = 3;
/** RestingOrder.last_valid_slot sentinel for "no expiration". */
export declare const NO_EXPIRATION_LAST_VALID_SLOT = 0;
/**
 * Shipped top-of-book levels per direction. Each level is ~2 cfg words
 * (DataIndex + sequence_number) + one walk iteration; sized against the
 * interpreter's per-order cost (measured in budget.ts / the CU suite). Moves
 * in lockstep with the fragment's unrolled setup (ladder.ts) and the mirror.
 */
export declare const MANIFEST_MAX_ORDERS = 16;
export interface ManifestOrder {
    /** Byte offset of the order's block within the dynamic region (DataIndex). */
    dataIndex: number;
    /** Monotonic per-order id — the drift-invariant live identity anchor. */
    sequenceNumber: bigint;
}
export interface ManifestWindow {
    /** Best-first resting orders (walk order) — the taker's match sequence. */
    orders: ManifestOrder[];
}
export interface ManifestPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'baseIn' (default) sells base for quote; 'quoteIn' buys base with quote. */
    direction: 'baseIn' | 'quoteIn';
    baseMint: Address;
    quoteMint: Address;
    baseVault: Address;
    quoteVault: Address;
    baseDecimals: number;
    quoteDecimals: number;
    /** Direction-keyed prepare-declared order windows (see the header). */
    windows: {
        baseIn: ManifestWindow;
        quoteIn: ManifestWindow;
    };
}
/** The direction's window (the ladder adapter and the orchestrator gate read through this). */
export declare function manifestWindowFor(cfg: ManifestPoolConfig): ManifestWindow;
/**
 * Fetch + gate one Manifest market (see the header for the gate list) and
 * freeze both directions' top-of-book order windows. Read-only against the
 * loader; the whole book is in this one account, so a quote needs no other
 * account.
 */
export declare function fetchManifestConfig(load: AccountLoader, pool: Address): Promise<ManifestPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only — no v1 adapter, not in the v1 registry). */
export declare const manifest: {
    slug: string;
    programId: Address<"MNFSTqtC93rEfYHB6hF82sKdZpUDFWkViLByLd1k1Ms">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchManifestConfig;
};
export {};
//# sourceMappingURL=index.d.ts.map