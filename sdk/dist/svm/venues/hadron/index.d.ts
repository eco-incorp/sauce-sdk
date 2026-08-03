import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, VenueAccount } from '../types.js';
declare const SLUG = "hadron";
export declare const HADRON_PROGRAM_ID: Address<"HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8">;
export declare const HADRON_TOKEN_PROGRAM: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
export declare const HADRON_CLOCK_SYSVAR: Address<"SysvarC1ock11111111111111111111111111111111">;
/**
 * Single venue-wide fee-treasury wallet — the fee-destination account for
 * ANY input mint is `findAssociatedTokenPda({owner: HADRON_FEE_AUTHORITY,
 * mint})`, verified exact against 3 different mints' real fee-destination
 * addresses observed in real landed transactions.
 */
export declare const HADRON_FEE_AUTHORITY: Address<"7Ly5vZTDz2ZJGrqTa9gCP2NWjFDvnxSLVQEdmvMcVaVn">;
export declare const HADRON_PAIR_ACCOUNT_SIZE = 724;
export declare const HADRON_OFF_MINT_A = 41;
export declare const HADRON_OFF_MINT_B = 73;
/** mintB's own "role-B" record address sits right after mintB in the PAIR account. */
export declare const HADRON_OFF_ASSET_CFG_B = 106;
/** SPL token account `amount` field offset (standard layout). */
export declare const HADRON_AMOUNT_OFF = 64;
export declare const HADRON_SPL_TOKEN_ACCOUNT_SIZE = 165;
/** Live oracle price field inside mintA's 128-byte AssetConfig — see ladder.ts's header. */
export declare const HADRON_PRICE_OFFSET = 40;
/** Q32.32 fixed-point scale the price field is carried in. */
export declare const HADRON_PRICE_SCALE: bigint;
/** Measured EXACT on both directions of both validated pairs — see ladder.ts's header. */
export declare const HADRON_FEE_PPM = 10n;
export declare const HADRON_PPM_DENOM = 1000000n;
/** Kept fraction after the conservative safety haircut (99.7% kept, 30 bps cut) — see ladder.ts's header. */
export declare const HADRON_HAIRCUT_PPM = 997000n;
/**
 * Vendored per-mintA registry: the 3 auxiliary per-asset accounts that
 * cannot be derived from the PAIR account or any recovered PDA seed
 * (`assetCfgA`/`growingA`/`metaA`), plus the pair-scoped `global` config,
 * PLUS the ONE mintB the live oracle price field at `assetCfgA`'s
 * `HADRON_PRICE_OFFSET` has been ground-truthed against (see file header
 * "SCOPE") — a pool whose live mintB differs self-drops rather than reuse
 * the field for an unvalidated denomination.
 */
interface HadronAssetEntry {
    mintB: Address;
    assetCfgA: Address;
    growingA: Address;
    metaA: Address;
    global: Address;
}
export declare const HADRON_ASSET_REGISTRY: Partial<Record<Address, HadronAssetEntry>>;
export interface HadronPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'AtoB' (default, mintA in) | 'BtoA'. */
    direction: 'AtoB' | 'BtoA';
    mintA: Address;
    mintB: Address;
    vaultA: Address;
    vaultB: Address;
    assetCfgA: Address;
    assetCfgB: Address;
    growingA: Address;
    metaA: Address;
    global: Address;
    feeVaultA: Address;
    feeVaultB: Address;
}
export declare function hadronConfig(cfg: PoolConfig): HadronPoolConfig;
export declare function fetchHadronConfig(load: AccountLoader, pool: Address): Promise<HadronPoolConfig>;
declare function quoteAccounts(base: PoolConfig): VenueAccount[];
export declare const hadron: {
    slug: string;
    kind: "constant-product";
    programId: Address<"HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8">;
    fetchPoolConfig: typeof fetchHadronConfig;
    quoteAccounts: typeof quoteAccounts;
};
export {};
//# sourceMappingURL=index.d.ts.map