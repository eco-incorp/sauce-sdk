import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "openbook-v2";
export declare const OPENBOOK_V2_PROGRAM_ID: Address<"opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb">;
export declare const MARKET_ACCOUNT_SIZE = 848;
export declare const BOOKSIDE_ACCOUNT_SIZE = 90952;
/** Shipped resting-order window depth per direction — a heavy fixed setup cost (unrolled live
 * reads over a 90KB BookSide account), same 'stable'/degrade-first class as manifest/whirlpool. */
export declare const OPENBOOK_V2_MAX_ORDERS = 4;
/** One shipped, prepare-time-selected resting order (see the header for the identity contract). */
export interface OpenBookV2Order {
    /** Absolute byte offset of this order's LeafNode within its BookSide account. */
    nodeOffset: number;
    /** The order's full 128-bit tree key — the live-drift identity anchor. */
    key: bigint;
    /** price_lots, derived from the SAME key (top 64 bits) — shipped separately so the fragment
     * never has to right-shift a 128-bit value. */
    priceLots: bigint;
}
export interface OpenBookV2Window {
    /** Best-first (see the header: descending key for bids, ascending for asks), up to
     * OPENBOOK_V2_MAX_ORDERS entries. */
    orders: OpenBookV2Order[];
}
export interface OpenBookV2PoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'baseIn' (default, sell base — opposes bids) | 'quoteIn' (buy base — opposes asks). */
    direction: 'baseIn' | 'quoteIn';
    baseMint: Address;
    quoteMint: Address;
    bidsAccount: Address;
    asksAccount: Address;
    eventHeap: Address;
    marketBaseVault: Address;
    marketQuoteVault: Address;
    marketAuthority: Address;
    baseDecimals: number;
    quoteDecimals: number;
    baseLotSize: bigint;
    quoteLotSize: bigint;
    /** Always >= 0 (the venue's own invariant). */
    takerFeePpm: bigint;
    /** 0 whenever the market's own makerFee is non-negative (the common case — no rebate). */
    makerRebatePpm: bigint;
    timeExpiry: bigint;
    /** None encodes as the program id sentinel in buildSwapV2 (Anchor's optional-account convention). */
    oracleA?: Address;
    oracleB?: Address;
    windows: {
        baseIn: OpenBookV2Window;
        quoteIn: OpenBookV2Window;
    };
}
export declare function fetchOpenBookV2Config(load: AccountLoader, pool: Address): Promise<OpenBookV2PoolConfig>;
export {};
//# sourceMappingURL=index.d.ts.map