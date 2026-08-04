import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "gamma";
export declare const GAMMA_PROGRAM_ID: Address<"GAMMA7meSFWaBXF25oSUgmGRwaW6sCMFLmBNiMSdbHVT">;
export interface GammaPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    ammConfig: Address;
    token0Vault: Address;
    token1Vault: Address;
    token0Mint: Address;
    token1Mint: Address;
    token0Program: Address;
    token1Program: Address;
    observation: Address;
    /** Bitfield; bit2 (value 4) = swap disabled. Gated at fetch time. */
    status: number;
    /** Unix seconds; the program rejects swaps while now < openTime. */
    openTime: bigint;
    /** Swap direction: true = token_0 in, token_1 out. fetchPoolConfig defaults to true; flip for the reverse direction. */
    inputIsToken0: boolean;
}
/** Fetch + decode one GAMMA pool (mirrors raydium-cp-swap's fetchPoolConfig gates). Read-only against the loader. */
export declare function fetchGammaPoolConfig(load: AccountLoader, pool: Address): Promise<GammaPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only, like raydium-amm-v4/raydium-cp-swap). */
export declare const gamma: {
    slug: string;
    programId: Address<"GAMMA7meSFWaBXF25oSUgmGRwaW6sCMFLmBNiMSdbHVT">;
    fetchPoolConfig: typeof fetchGammaPoolConfig;
};
export {};
//# sourceMappingURL=index.d.ts.map