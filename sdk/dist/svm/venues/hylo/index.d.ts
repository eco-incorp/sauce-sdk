import type { Address } from '@solana/kit';
import type { PoolConfig, SvmVenueAdapter } from '../types.js';
declare const SLUG = "hylo";
export declare const HYLO_PROGRAM_ID: Address<"HYEXCHtHkBagdStcJCp3xbbb9B7sdMdWXFNj6mdsG4hn">;
export declare const USDC_MINT: Address<"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v">;
/** PDA(["hyUSD"], HYLO_PROGRAM_ID). */
export declare const HYUSD_MINT: Address<"5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E">;
/** PDA(["hylo"], HYLO_PROGRAM_ID) — the program's singleton config account. */
export declare const HYLO_ACCOUNT: Address<"9cd2sAfbBvKs4SX9YKo4dcjwP3TgTVQ8dT5koshGcDND">;
/** PDA(["usdc_pair"], HYLO_PROGRAM_ID) — the singleton USDC<->hyUSD pair account (this venue's `pool`). */
export declare const USDC_PAIR_ACCOUNT: Address<"CMNPACEDebyvNJDgBxRc5fbScF8kmx52ZPBY4Cu4wuwS">;
/** ATA(USDC_VAULT_AUTH, USDC_MINT) — the real USDC collateral backing hyUSD minted via this leg. */
export declare const USDC_COLLATERAL_VAULT: Address<"5ykRvDpEXwKEdoE6yfZ45zeuZ62CcRQRUoZoye4tTJd7">;
/** The live USDC/USD Pyth push-oracle account (pyth-solana-receiver PriceUpdateV2), program-agnostic. */
export declare const USDC_USD_PYTH_FEED: Address<"6HAuqASbHEh4w4REJEUUUCginTLfj1kwCh215ZLtMkrT">;
export declare const HYLO_ACCOUNT_SIZE = 511;
/** sha256('account:Hylo')[0..8]. */
export declare const HYLO_DISCRIMINATOR: number[];
export declare const USDC_PAIR_ACCOUNT_SIZE = 173;
/** sha256('account:UsdcPair')[0..8]. */
export declare const USDC_PAIR_DISCRIMINATOR: number[];
export interface HyloPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'aToB': mint (USDC in -> hyUSD out). 'bToA': redeem (hyUSD in -> USDC out). */
    direction: 'aToB' | 'bToA';
    /** 10^(9-|exponent|) — baked from the Pyth feed's exponent at fetch time (see module header MATH). */
    priceScale: bigint;
    /** Prepare-time snapshot — see module header GATES; `gate()` re-derives freshness from these. */
    protocolPausedAtFetch: boolean;
    pairPausedAtFetch: boolean;
    verificationTagAtFetch: number;
    priceRawAtFetch: bigint;
    confRawAtFetch: bigint;
    publishTimeAtFetch: bigint;
    intervalSecsAtFetch: bigint;
    confToleranceBitsAtFetch: bigint;
}
/**
 * Prepare-time SELF-DROP gate (see module header GATES): pause state (recoverable) and the
 * USDC/USD Pyth oracle's own validity (verification level, confidence, staleness vs `now` —
 * mirrors `hylo_core::pyth::query_pyth_oracle` except the `posted_slot` sub-check, which needs
 * the live SLOT this hook does not receive — disclosed narrower-than-real-gate residual). All
 * from the FETCH-TIME snapshot (this hook has no loader) — a live CPI still enforces the real,
 * current state regardless (SVM execution-time re-check is a platform impossibility).
 */
export declare function hyloGate(cfg: PoolConfig, now: bigint): void;
/**
 * Recoverable live-state drift (pause / stale-or-low-confidence oracle) between discovery and
 * prepare — the SAME class `the consuming app SVM solver entry`'s own `SvmWindowDriftError` names (that class
 * is private to index.ts, so this venue module carries an identically-treated local marker;
 * `the consuming app SVM solver entry`'s FAMILIES wiring re-throws this as its own `SvmWindowDriftError` so the
 * self-drop classification stays centralized there).
 */
export declare class SvmHyloDriftError extends Error {
}
/** Live oracle + pair state a quote needs — read fresh (not cached) every trade. */
interface HyloLiveState {
    feeBits: bigint;
    vsupply: bigint;
    priceRaw: bigint;
    confRaw: bigint;
    vaultBalance: bigint;
}
/** TS mirror of the emitted mint (aToB) fragment. */
export declare function hyloMintOut(live: HyloLiveState, priceScale: bigint, x: bigint): bigint;
/** The redeem-direction input cap (see module header CAPACITY) — 0 when the pool is unquotable. */
export declare function hyloRedeemCapacity(live: HyloLiveState, priceScale: bigint): bigint;
/** TS mirror of the emitted redeem (bToA) fragment — `x` already clamped to the capacity above. */
export declare function hyloRedeemOut(live: HyloLiveState, priceScale: bigint, x: bigint): bigint;
export declare const hylo: SvmVenueAdapter;
export {};
//# sourceMappingURL=index.d.ts.map