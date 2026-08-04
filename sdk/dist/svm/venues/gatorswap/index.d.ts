import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SvmVenueLadder, VenueAccount } from '../types.js';
declare const SLUG = "gatorswap";
export declare const GATORSWAP_PROGRAM_ID: Address<"gatorLx9aC1e5ZWAXscv5QRKiLXnLPLXjftVc81h1Hr">;
/** `PDA(gatorLx9a, ["pool", mintA, mintB])` — documentation/testing only; discovery supplies `pool` directly. */
export declare function deriveGatorswapPool(mintA: Address, mintB: Address): Promise<Address>;
export interface GatorswapPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 0 = mintA in / mintB out, 1 = mintB in / mintA out. */
    direction: 0 | 1;
    mintA: Address;
    mintB: Address;
    vaultA: Address;
    vaultB: Address;
    /** The referenced PumpSwap pool priced for this pair — read-only, never CPI'd into. */
    refPool: Address;
    refBaseMint: Address;
    refQuoteMint: Address;
    refBaseVault: Address;
    refQuoteVault: Address;
}
declare function fetchPoolConfig(load: AccountLoader, pool: Address): Promise<GatorswapPoolConfig>;
declare function quoteAccounts(base: PoolConfig): VenueAccount[];
export declare const gatorswap: {
    slug: string;
    kind: "constant-product";
    programId: Address<"gatorLx9aC1e5ZWAXscv5QRKiLXnLPLXjftVc81h1Hr">;
    fetchPoolConfig: typeof fetchPoolConfig;
    quoteAccounts: typeof quoteAccounts;
};
export declare const gatorswapLadder: SvmVenueLadder;
export {};
//# sourceMappingURL=index.d.ts.map