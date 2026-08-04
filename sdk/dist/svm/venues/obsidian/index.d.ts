import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, VenueAccount } from '../types.js';
declare const SLUG = "obsidian";
export declare const OBSIDIAN_PROGRAM_ID: Address<"HBVw6bZtcCaezhcBrmfyXBSBRWCdv72271xQ4GPvms2z">;
export declare const OFF_MINT_A = 80;
export declare const OFF_MINT_B = 112;
export declare const OFF_VAULT_A = 144;
export declare const OFF_VAULT_B = 176;
export declare const OFF_LAST_UPDATE_SLOT = 536;
export declare const OFF_PRICE = 544;
/** SPL mint account decimals field offset (standard layout: after COption<Pubkey> + u64 supply). */
export declare const MINT_DECIMALS_OFF = 44;
/**
 * Freshness bound for the off-chain prepare gate (slots; ~600 slots is ~4
 * minutes at 400ms/slot). Conservative-tight by design: we have no ground
 * truth for the program's own enforced threshold (only that ~15.9M slots of
 * staleness reverts), and under-estimating freshness only costs a missed
 * quote — over-estimating risks admitting a pool that reverts on-chain,
 * which aborts the WHOLE cook (see the file header). Re-tune once the real
 * threshold is known (e.g. once a keeper is observed refreshing on a known
 * cadence).
 */
export declare const MAX_STALE_SLOTS = 600n;
export interface ObsidianPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 0 = mintA in / mintB out, 1 = mintB in / mintA out (POSITIONAL BY MINT — see the file header). */
    direction: 0 | 1;
    mintA: Address;
    mintB: Address;
    vaultA: Address;
    vaultB: Address;
    decimalsA: number;
    decimalsB: number;
}
/**
 * Off-chain gate + decode. Rejects: wrong pool size, a missing mint/decimals
 * read, and — the load-bearing check — a STALE crank price (see the file
 * header "Live-state honesty"). direction is caller-supplied (0 or 1); both
 * directions share one pool account.
 */
declare function fetchPoolConfig(load: AccountLoader, pool: Address, direction?: 0 | 1): Promise<ObsidianPoolConfig>;
declare function quoteAccounts(base: PoolConfig): VenueAccount[];
export declare const obsidian: {
    slug: string;
    kind: "constant-product";
    programId: Address<"HBVw6bZtcCaezhcBrmfyXBSBRWCdv72271xQ4GPvms2z">;
    fetchPoolConfig: typeof fetchPoolConfig;
    quoteAccounts: typeof quoteAccounts;
};
export {};
//# sourceMappingURL=index.d.ts.map