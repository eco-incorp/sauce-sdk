import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, VenueAccount } from '../types.js';
declare const SLUG = "riptide";
export declare const RIPTIDE_PROGRAM_ID: Address<"riptK81hDxhe5pW5jSzSM9iRA8azgEgLJ4dXkPtBS7j">;
export declare const TOKEN_PROGRAM: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
export declare const ATA_PROGRAM: Address<"ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL">;
export declare const MEMO_PROGRAM: Address<"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr">;
export declare const SYSVAR_INSTRUCTIONS: Address<"Sysvar1nstructions1111111111111111111111111">;
/** Well-known anti-frontrun sentinel account present on every real Riptide swap observed. */
export declare const JITODONTFRONT: Address<"jitodontfront111111111111111111111111111111">;
export declare const POOL_ACCOUNT_SIZE = 1024;
export declare const OFF_MINT_A = 72;
export declare const OFF_MINT_B = 104;
/** SPL token account amount field offset (standard layout). */
export declare const AMOUNT_OFF = 64;
/** `ATA(owner, mint)` — the standard SPL associated-token derivation, no extra RPC. */
export declare function deriveAta(owner: Address, mint: Address): Promise<Address>;
export interface RiptidePoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 0 = mintA in / mintB out, 1 = mintB in / mintA out. */
    direction: 0 | 1;
    mintA: Address;
    mintB: Address;
    vaultA: Address;
    vaultB: Address;
}
export declare function riptideConfig(cfg: PoolConfig): RiptidePoolConfig;
export declare function fetchPoolConfig(load: AccountLoader, pool: Address, direction?: 0 | 1): Promise<RiptidePoolConfig>;
export declare function quoteAccounts(base: PoolConfig): VenueAccount[];
export declare const riptide: {
    slug: string;
    kind: "constant-product";
    programId: Address<"riptK81hDxhe5pW5jSzSM9iRA8azgEgLJ4dXkPtBS7j">;
    fetchPoolConfig: typeof fetchPoolConfig;
    quoteAccounts: typeof quoteAccounts;
};
export {};
//# sourceMappingURL=index.d.ts.map