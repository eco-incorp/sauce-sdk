import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SwapUser, VenueAccount, VenueSwap } from '../types.js';
declare const SLUG = "woofi";
export declare const WOOFI_PROGRAM_ID: Address<"WooFif76YGRNjk1pA8wCsN67aQsD9f9iLsz4NcJ1AVb">;
/** Anchor `sha256("global:swap")[0..8]` — program-independent (same bytes obric-v2/meteora use for their own "swap" ix). */
export declare const WOOFI_SWAP_DISCRIMINATOR: number[];
export declare const WOOFI_AMM_POOL_SIZE = 617;
export declare const WOOFI_WOOPOOL_SIZE = 284;
export declare const WOOFI_WOORACLE_SIZE = 363;
export declare const WOOFI_PRICE_UPDATE_SIZE = 134;
export declare const OFF_AMM_WOORACLE_A = 73;
export declare const OFF_AMM_WOOPOOL_A = 105;
export declare const OFF_AMM_TOKEN_MINT_A = 201;
export declare const OFF_AMM_TOKEN_VAULT_A = 233;
export declare const OFF_AMM_WOORACLE_B = 265;
export declare const OFF_AMM_WOOPOOL_B = 297;
export declare const OFF_AMM_TOKEN_MINT_B = 393;
export declare const OFF_AMM_TOKEN_VAULT_B = 425;
export declare const OFF_AMM_QUOTE_TOKEN_MINT = 457;
export declare const OFF_ORACLE_WOOCONFIG = 8;
export declare const OFF_ORACLE_PRICE_UPDATE = 136;
export declare const OFF_ORACLE_MAXIMUM_AGE = 168;
export declare const OFF_ORACLE_PRICE_DECIMALS = 176;
export declare const OFF_ORACLE_QUOTE_DECIMALS = 177;
export declare const OFF_ORACLE_UPDATED_AT = 179;
export declare const OFF_ORACLE_STALE_DURATION = 187;
export declare const OFF_ORACLE_BOUND = 195;
export declare const OFF_ORACLE_PRICE = 203;
export declare const OFF_ORACLE_COEFF = 219;
export declare const OFF_ORACLE_SPREAD = 227;
export declare const OFF_ORACLE_RANGE_MIN = 235;
export declare const OFF_ORACLE_RANGE_MAX = 251;
export declare const OFF_ORACLE_QUOTE_PRICE_UPDATE = 331;
export declare const OFF_POOL_FEE_RATE = 105;
export declare const OFF_POOL_MAX_GAMMA = 107;
export declare const OFF_POOL_MAX_NOTIONAL_SWAP = 123;
export declare const OFF_POOL_CAP_BAL = 139;
export declare const OFF_POOL_MIN_SWAP_AMOUNT = 155;
export declare const OFF_POOL_TOKEN_MINT = 187;
export declare const OFF_POOL_TOKEN_VAULT = 219;
export declare const OFF_POOL_BASE_DECIMALS = 283;
export declare const OFF_PYTH_VERIFICATION_TAG = 40;
export declare const OFF_PYTH_PRICE = 73;
export declare const OFF_PYTH_EXPONENT = 89;
export declare const OFF_PYTH_PUBLISH_TIME = 93;
export declare const PYTH_VERIFICATION_FULL = 1;
export declare const ONE_E18 = 1000000000000000000n;
export declare const ONE_E5 = 100000n;
export interface WoofiPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'sellBase' (default) sells the non-quote side for quote; 'sellQuote' is the reverse. */
    direction: 'sellBase' | 'sellQuote';
    wooconfig: Address;
    wooracleBase: Address;
    woopoolBase: Address;
    tokenMintBase: Address;
    tokenVaultBase: Address;
    priceUpdateBase: Address;
    wooracleQuote: Address;
    woopoolQuote: Address;
    quoteTokenMint: Address;
    quoteTokenVault: Address;
    priceUpdateQuote: Address;
    tokenProgram: Address;
    /** 10 ** wooracleBase.price_decimals. */
    priceDec: bigint;
    /** 10 ** wooracleBase.quote_decimals (the WooFi-internal quote decimals, e.g. 1e6). */
    quoteDec: bigint;
    /** 10 ** woopoolBase.base_decimals. */
    baseDec: bigint;
    /** wooracleBase.coeff (WAD) — baked (admin-set; the swap never mutates it). */
    coeff: bigint;
    /** woopoolBase.fee_rate (1e5-scaled) — the fee_rate BOTH single-leg directions charge. */
    feeRate: bigint;
    maxGamma: bigint;
    maxNotionalSwap: bigint;
    /** woopoolBase.cap_bal — undocumented upstream; modeled as a base-token-unit cap (see file header). */
    capBal: bigint;
    /** woopoolBase.min_swap_amount — 0 on every live pool today. */
    minSwapAmount: bigint;
    bound: bigint;
    staleDuration: bigint;
    rangeMin: bigint;
    rangeMax: bigint;
    maximumAge: bigint;
    /** 10 ** abs(quote Pyth feed's exponent) — baked (static feed metadata). */
    pythQuoteDecPow: bigint;
}
/**
 * Fetch + gate one WooFi pool. QUOTE-PAIRED ONLY (see file header): exactly
 * one of the bundle's two sides must equal `quoteTokenMint`, else this is a
 * genuine base-to-base pair and this adapter throws (not yet wired — a
 * follow-up, not a permission gate).
 */
export declare function fetchWoofiConfig(load: AccountLoader, pool: Address): Promise<WoofiPoolConfig>;
/** The 17-account order `Swap` expects (swap.rs, verified against 6 real mainnet transactions). */
export declare function woofiSwapAccounts(c: WoofiPoolConfig, user: SwapUser, make: (ref: string, addr: Address, writable?: boolean) => VenueAccount, refFor?: (role: string) => string): VenueAccount[];
export declare const woofi: {
    slug: string;
    programId: Address<"WooFif76YGRNjk1pA8wCsN67aQsD9f9iLsz4NcJ1AVb">;
    fetchPoolConfig: typeof fetchWoofiConfig;
    quoteAccounts(cfg: PoolConfig): VenueAccount[];
    /** v1 swap CPI (amount baked). */
    buildSwap(cfg: PoolConfig, user: SwapUser, amountIn: bigint): VenueSwap;
};
export {};
//# sourceMappingURL=index.d.ts.map