import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "gavel";
export declare const GAVEL_PROGRAM_ID: Address<"srAMMzfVHVAtgSJc8iH6CfKzuWuUTzLHVCE81QU1rgi">;
/** u64 LE @0 — accounts.rs POOL_ACCOUNT_DISCRIMINATOR ([116,210,187,119,196,196,52,137]). */
export declare const GAVEL_POOL_DISCRIMINANT = 9886743430086513268n;
/** PoolHeader (528) + Amm (96) — bytemuck::Pod, cast at offset 0, no prefix. */
export declare const GAVEL_POOL_SIZE = 624;
/** processor/swap.rs / lib.rs — the sr-AMM snapshot rotates every 4 slots (~1.6-2s). */
export declare const GAVEL_LEADER_SLOT_WINDOW = 4n;
export interface GavelPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'baseIn' (default) sells base for quote; 'quoteIn' buys base with quote. */
    direction: 'baseIn' | 'quoteIn';
    baseMint: Address;
    quoteMint: Address;
    baseVault: Address;
    quoteVault: Address;
    baseDecimals: number;
    quoteDecimals: number;
    /** bps, immutable post-init — baked as a compile-time param. */
    feeInBps: bigint;
}
/**
 * Fetch + gate one Gavel/Plasma pool: discriminant + size, a live LP-share /
 * reserve liveness gate (mirrors every other family's "one bad pool never
 * kills a cook" self-drop), and classic-SPL-only mints (the program's own
 * token_program is hardcoded to Tokenkeg — see the module header).
 */
export declare function fetchGavelConfig(load: AccountLoader, pool: Address): Promise<GavelPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only — no v1 adapter, not in the v1 registry). */
export declare const gavel: {
    slug: string;
    programId: Address<"srAMMzfVHVAtgSJc8iH6CfKzuWuUTzLHVCE81QU1rgi">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchGavelConfig;
};
export {};
//# sourceMappingURL=index.d.ts.map