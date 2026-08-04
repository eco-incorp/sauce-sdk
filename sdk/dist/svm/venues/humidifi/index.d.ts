import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "humidifi";
/** The swap-settlement program (NOT the `AubCGUt9...` route/setup program). */
export declare const HUMIDIFI_PROGRAM_ID: Address<'9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp'>;
/** The 8-byte XOR key, per the public "HumidiFi Swap Parser" gist (see file header, item 2). */
export declare const HUMIDIFI_XOR_KEY: readonly number[];
/** The 8-byte keystream for 8-byte chunk `pos` (0-based): `HUMIDIFI_XOR_KEY[j] ^ ((pos·0x0001_0001_0001_0001) bytes)[j]`. */
export declare function humidifiKeystream(pos: number): Uint8Array;
/** chunk 1 (bytes 8-15, amountIn) keystream, as a little-endian u64 — XORing a runtime LE value
 *  with this constant is byte-for-byte equivalent to XORing the two 8-byte arrays (see file header
 *  item 2 and `buildSwapV2` below), so this is exactly what `patchXorMaskIn` needs to be. */
export declare const HUMIDIFI_AMOUNT_XOR_MASK: bigint;
/** Deobfuscate a captured 25-byte HumidiFi swap instruction (test/verification use). */
export declare function humidifiDeobfuscate(data: Uint8Array): Uint8Array;
export interface HumidiFiRegistryEntry {
    baseVault: Address;
    quoteVault: Address;
    baseMint: Address;
    quoteMint: Address;
    baseDecimals: number;
    quoteDecimals: number;
}
/**
 * Hand-verified HumidiFi pools: for each, a real mainnet swap transaction was
 * decoded (obfuscation removed, account order matched) and the vault/mint
 * addresses were cross-checked against `preTokenBalances`/`postTokenBalances`
 * on that transaction. Ranked by observed activity in the sampled window;
 * extend by repeating the same verification (see docs/humidifi-evidence.md).
 */
export declare const HUMIDIFI_POOL_REGISTRY: Record<string, HumidiFiRegistryEntry>;
export interface HumidiFiPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'baseToQuote' (default, flag byte 0) sells the registry's baseMint; 'quoteToBase' (flag byte 1) sells quoteMint. */
    direction: 'baseToQuote' | 'quoteToBase';
    baseVault: Address;
    quoteVault: Address;
    baseMint: Address;
    quoteMint: Address;
    baseDecimals: number;
    quoteDecimals: number;
}
/**
 * Registry lookup + liveness check ONLY — this family's pool account carries
 * no plaintext structure we can decode (file header item 5), so there is
 * nothing further to read off it. `load(pool)` still runs once so a pool
 * whose account has since closed/reallocated (a stale registry entry) is
 * dropped like any other vanished pool, never silently misquoted.
 */
export declare function fetchHumidifiConfig(load: AccountLoader, pool: Address): Promise<HumidiFiPoolConfig>;
/**
 * Safety haircut on the INPUT before a plain constant-product curve — NOT a
 * claim about HumidiFi's real fee (unknown, see file header item 6). Only
 * 300,000 (of 1,000,000) = 30% of the input counts (a 70% haircut). Chosen
 * so the model stays below every one of 22 real sampled trades' realized
 * output ACROSS TWO DIFFERENT POOLS (worst-case margin 28.8%, on the
 * memecoin/USDC pool) — a 50% haircut passes the 21-trade SOL/USDC sample
 * but over-promises the second pool by 18.6%, so this constant is
 * calibrated against the worst pool sampled, not the best-sampled one.
 */
export declare const HUMIDIFI_SAFETY_FEE_PPM = 300000n;
export {};
//# sourceMappingURL=index.d.ts.map