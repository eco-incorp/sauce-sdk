import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadder } from '../types.js';
declare const SLUG = "taurusfi";
export declare const TAURUSFI_PROGRAM_ID: Address<'9VX8EKBg6vM6tA68xaDsPkbrx26XConZjkQmhVApUptc'>;
/** Fixed-point scale for the decoded price (10^9 — ~9-10 significant decimal digits of headroom). */
export declare const TAURUSFI_PRICE_SCALE = 1000000000n;
/**
 * Decodes a raw f64 bit pattern (as read off-chain OR the exact on-chain
 * `accountUint` value) into a `TAURUSFI_PRICE_SCALE`-fixed-point integer,
 * LOCKSTEP with the on-chain formula in `emitSetup` below (same masks, same
 * mulDiv-shaped floor division) — bit-exact by construction, not merely
 * "close". Degrades to exactly 0 for an unpriced market (bits === 0n) with
 * no special case (see file header).
 */
export declare function decodeTaurusFiPriceScaled(bits: bigint): bigint;
export interface TaurusFiRegistryEntry {
    /** BASE mint's SPL vault. */
    vault0: Address;
    /** QUOTE mint's SPL vault. */
    vault1: Address;
    mint0: Address;
    mint1: Address;
    decimals0: number;
    decimals1: number;
    /** PDA owning both vaults (SPL "owner" field of both — confirmed identical). */
    vaultAuthority: Address;
    /** Venue-wide fixed account, account 6 in the swap ix — exact role not recovered. */
    globalConfig: Address;
    /** Venue-wide fixed account, account 8 in the swap ix — exact role not recovered; never a signer. */
    globalAuthority: Address;
    /** The market's own price/oracle state PDA (also the registry key). */
    priceAccount: Address;
}
/**
 * Hand-verified TaurusFi markets: for each, a real mainnet swap CPI (inside a
 * Jupiter route) was decoded and the vault/mint addresses were cross-checked
 * against `preTokenBalances`/`postTokenBalances`, and the price account was
 * independently confirmed against a same-slot keeper-crank update. Only one
 * live-priced market was observed during integration; a second market
 * account (`HFqA7kAqgUMjNCo5zDSN1tnKvE8GVBXGPDyK2nizJm11`) exists but reads an
 * all-zero (unpriced/inactive) price and has no known vault/mint pair, so it
 * is deliberately NOT seeded here — extend by repeating the same
 * verification once it (or another market) goes live.
 */
export declare const TAURUSFI_POOL_REGISTRY: Record<string, TaurusFiRegistryEntry>;
export interface TaurusFiPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** '0to1' (default) sells mint0 for mint1; '1to0' sells mint1 for mint0. */
    direction: '0to1' | '1to0';
    vault0: Address;
    vault1: Address;
    mint0: Address;
    mint1: Address;
    decimals0: number;
    decimals1: number;
    vaultAuthority: Address;
    globalConfig: Address;
    globalAuthority: Address;
    priceAccount: Address;
    /** Decoded once at fetch time — the gate's ONLY read (see the recipe's `FAMILIES.taurusfi.gate`). */
    priceScaled: bigint;
}
/**
 * Registry lookup + live decode: reads the market's price account (for the
 * gate) and both vaults (mint-integrity check, mirroring gamma's/bisonfi's
 * own vault verification) — nothing else is decodable off this venue's pool
 * state (no plaintext pool-identity account exists at all; see file header).
 */
export declare function fetchTaurusFiConfig(load: AccountLoader, pool: Address): Promise<TaurusFiPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only, like raydium-amm-v4/raydium-cp-swap). */
export declare const taurusfi: {
    slug: string;
    programId: Address<"9VX8EKBg6vM6tA68xaDsPkbrx26XConZjkQmhVApUptc">;
    fetchPoolConfig: typeof fetchTaurusFiConfig;
};
export declare const taurusFiLadder: SvmVenueLadder;
export {};
//# sourceMappingURL=index.d.ts.map