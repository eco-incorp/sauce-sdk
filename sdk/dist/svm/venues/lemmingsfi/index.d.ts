import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadder, VenueAccount } from '../types.js';
declare const SLUG = "lemmingsfi";
export declare const LEMMINGSFI_PROGRAM_ID: Address<'BQEJZUB4CzoT6UhRffoCkqCyqQNrCPCSGHcPEmsdbEsX'>;
/**
 * The program's only 76-byte owned account, anywhere — a global singleton
 * both real pools' real swaps pass as account[1]. See file header.
 */
export declare const LEMMINGSFI_CONFIG: Address<'6DZQsK3i1YtvyQCsWxZpY1Ski8dmSjqYnjCUPQiMqT1Z'>;
export declare const OFF_MINT_A = 8;
export declare const OFF_MINT_B = 40;
export declare const OFF_VAULT_A = 72;
export declare const OFF_VAULT_B = 104;
export declare const OFF_PRICE_TICK = 168;
export declare const OFF_LAST_UPDATE_TS = 184;
/**
 * Self-drop threshold — see the file header's STALENESS section. Deliberately
 * far stricter than the keeper's own historical ~6s cadence; the real
 * on-chain threshold is not independently recovered.
 */
export declare const STALE_AFTER_SECONDS = 60n;
export interface LemmingsFiPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 0 = mintB in / mintA out, 1 = mintA in / mintB out. */
    direction: 0 | 1;
    mintA: Address;
    mintB: Address;
    vaultA: Address;
    vaultB: Address;
    /** Reduced `1000 * 10^decA / 10^decB` — see file header "PRICING MODEL". */
    kNum: bigint;
    kDen: bigint;
    /** Live at fetch time — the recipe-side `gate` re-checks it against `now`. */
    lastUpdateTs: bigint;
}
export declare function fetchLemmingsFiPoolConfig(load: AccountLoader, pool: Address): Promise<LemmingsFiPoolConfig>;
declare function quoteAccounts(base: PoolConfig): VenueAccount[];
export declare const lemmingsfi: {
    slug: string;
    kind: "constant-product";
    programId: Address<"BQEJZUB4CzoT6UhRffoCkqCyqQNrCPCSGHcPEmsdbEsX">;
    fetchPoolConfig: typeof fetchLemmingsFiPoolConfig;
    quoteAccounts: typeof quoteAccounts;
};
export declare const lemmingsfiLadder: SvmVenueLadder;
export {};
//# sourceMappingURL=index.d.ts.map