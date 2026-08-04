import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "mercurial";
export declare const MERCURIAL_PROGRAM_ID: Address<"MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky">;
export interface MercurialPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    direction: 'aToB' | 'bToA';
    nonce: number;
    authority: Address;
    vaultA: Address;
    vaultB: Address;
    mintA: Address;
    mintB: Address;
}
/** Fetch + decode one Mercurial SwapV2 pool, plus its two vaults' mints. Read-only against the loader. */
export declare function fetchMercurialPoolConfig(load: AccountLoader, pool: Address): Promise<MercurialPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only, like orca-whirlpool/raydium-clmm/saber-stableswap). */
export declare const mercurial: {
    slug: string;
    programId: Address<"MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchMercurialPoolConfig;
};
export {};
//# sourceMappingURL=index.d.ts.map