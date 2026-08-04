import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, VenueAccount } from '../types.js';
declare const SLUG = "bisonfi";
export declare const BISONFI_PROGRAM_ID: Address<"BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi">;
export declare const TOKEN_PROGRAM: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
export declare const POOL_ACCOUNT_SIZE = 2048;
export declare const OFF_VAULT_A = 120;
export declare const OFF_VAULT_B = 152;
export declare const OFF_MINT_A = 184;
export declare const OFF_MINT_B = 216;
/** u64 LE, Q24.40 (divide by 2^40), human quote(mintB)-per-whole-base(mintA) — see module doc. */
export declare const PRICE_OFFSET = 838;
/** u64 LE, unix NANOSECONDS — the keeper's own last-push timestamp (see module doc). */
export declare const TS_OFFSET = 88;
/** u16 LE, basis points — fee charged when mint A is the input side. */
export declare const FEE_BPS_OFF_A = 852;
/** u16 LE, basis points — fee charged when mint B is the input side. */
export declare const FEE_BPS_OFF_B = 860;
/** SPL token account `amount` field offset (standard layout). */
export declare const AMOUNT_OFF = 64;
export declare const PRICE_SCALE: bigint;
/**
 * Freshness bound, seconds — see module doc "Freshness gate": the live
 * population never exceeded 1s of age in a full 18-pool sweep; the stale
 * population's closest gap was ~1.6M seconds. 60s is comfortably inside that
 * gap while tolerating ordinary keeper-push/RPC jitter.
 */
export declare const STALE_SECONDS = 60n;
/** Conservative quotable-capacity divisor — see module doc "Capacity". */
export declare const CAP_DIVISOR = 20n;
/** disc(1) ++ amountIn u64 LE (patched) ++ minOut u64 LE(=1) ++ direction(1) ++ flag(1) = 19 bytes. */
export declare const SWAP_DISCRIMINATOR = 7;
/** Byte 18 — see module doc "Swap instruction": every real sample carries 0x04. */
export declare const TAIL_FLAG = 4;
export interface BisonfiPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 0 = mintA in / mintB out, 1 = mintB in / mintA out. */
    direction: 0 | 1;
    mintA: Address;
    mintB: Address;
    vaultA: Address;
    vaultB: Address;
    /**
     * Decimals-adjustment rational baked at fetch time, direction-neutral
     * (see ladder.ts): out = mulDiv(x, livePrice*scaleNum, PRICE_SCALE*scaleDen)
     * for direction 0, and the exact reciprocal for direction 1.
     */
    scaleNum: bigint;
    scaleDen: bigint;
}
export declare function bisonfiConfig(cfg: PoolConfig): BisonfiPoolConfig;
declare function fetchPoolConfig(load: AccountLoader, pool: Address, direction?: 0 | 1): Promise<BisonfiPoolConfig>;
declare function quoteAccounts(base: PoolConfig): VenueAccount[];
/** Family facade for the consuming app's orchestrator. */
export declare const bisonfi: {
    slug: string;
    kind: "constant-product";
    programId: Address<"BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi">;
    fetchPoolConfig: typeof fetchPoolConfig;
    quoteAccounts: typeof quoteAccounts;
};
export {};
//# sourceMappingURL=index.d.ts.map