import type { Address } from '@solana/kit';
import type { AccountLoader, SvmVenueLadderV2 } from '../types.js';
import type { RaydiumClmmPoolConfig, RaydiumClmmWindow } from '../raydium-clmm/index.js';
declare const SLUG: "byreal";
/** Byreal's deployed program — a different program id than raydium-clmm's CAMMC... deployment. */
export declare const BYREAL_PROGRAM_ID: Address<"REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2">;
export interface ByrealPoolConfig extends Omit<RaydiumClmmPoolConfig, 'venue'> {
    venue: typeof SLUG;
}
/** The direction's window (mirrors raydium-clmm's own windowFor). */
export declare function byrealWindowFor(cfg: ByrealPoolConfig): RaydiumClmmWindow;
/**
 * Fetch + gate one Byreal pool and freeze both directions' boundary windows.
 * A deliberate, minimal fork of fetchRaydiumClmmConfig — see the header for
 * why (PDA derivation must use BYREAL_PROGRAM_ID, not raydium-clmm's).
 * Read-only against the loader.
 */
export declare function fetchByrealPoolConfig(load: AccountLoader, pool: Address): Promise<ByrealPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only, like raydium-clmm — no v1 adapter). */
export declare const byreal: {
    slug: "byreal";
    programId: Address<"REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    token2022Program: Address<"TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb">;
    memoProgram: Address<"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr">;
    fetchPoolConfig: typeof fetchByrealPoolConfig;
};
/**
 * Byreal's ladder — IDL-identical math to raydium-clmm, delegated verbatim
 * (see the header). Only `shapeKey` (own family prefix, no collision with
 * real raydium-clmm shapes) and `buildSwapV2` (CPI target program) are
 * genuinely different from upstream.
 */
export declare const byrealLadder: SvmVenueLadderV2;
export {};
//# sourceMappingURL=index.d.ts.map