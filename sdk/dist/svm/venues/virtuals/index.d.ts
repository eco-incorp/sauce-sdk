import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG: "virtuals";
export declare const VIRTUALS_PROGRAM_ID: Address;
/** The program's own quote SPL mint — fixed, baked into every buy/sell account list (see header). */
export declare const VIRTUALS_MINT: Address;
export declare const POOL_ACCOUNT_SIZE = 90;
export interface VirtualsPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** exactIn side: 'quoteToBase' (default, buy — VIRTUAL in, token out) | 'baseToQuote' (sell). */
    direction: 'quoteToBase' | 'baseToQuote';
    baseMint: Address;
    /** Read live off the pool account (see header) — NOT hardcoded despite being identical across
     *  every sampled pool. */
    virtualY: bigint;
    vpoolTokenAta: Address;
    vpoolVirtualsAta: Address;
    platformPrototypeVirtualsAta: Address;
}
export declare const virtuals: {
    slug: "virtuals";
    kind: "constant-product";
    programId: Address;
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<VirtualsPoolConfig>;
};
export {};
//# sourceMappingURL=index.d.ts.map