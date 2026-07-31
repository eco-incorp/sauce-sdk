import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "tesserav";
export declare const TESSERAV_PROGRAM_ID: Address<"TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH">;
export declare const TOKEN_PROGRAM: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
export declare const OFF_MID = 144;
export declare const MID_SCALE = 1000000000000000n;
export declare const OFF_LADDER_AB = 168;
export declare const AB_STRIDE = 24;
export declare const AB_OFF_PRICE = 0;
export declare const AB_OFF_CUM = 16;
export declare const OFF_LADDER_BA = 640;
export declare const BA_STRIDE = 24;
export declare const BA_OFF_CUM = 0;
export declare const BA_OFF_PRICE = 8;
export declare const TESSERAV_LEVEL_SLOTS = 10;
export declare const PRICE_PPM_DEN = 1000000n;
/** Minimum pool account size this adapter reads from (level 9's last byte + 1). */
export declare const TESSERAV_MIN_POOL_SIZE: number;
export interface TesseraVPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'aToB' sells mintA for mintB (ix direction byte 1); 'bToA' is the reverse (byte 0). */
    direction: 'aToB' | 'bToA';
    mintA: Address;
    mintB: Address;
    /** The program's shared vault-authority/registry PDA — read-only in the swap ix. */
    auth: Address;
    vaultA: Address;
    vaultB: Address;
}
/** Level-0 price (ppm of 1e6) for a direction — non-increasing across slots, this adapter ships slot 0 only. */
export declare function level0PriceOffset(direction: 'aToB' | 'bToA'): number;
/** Level-0 capacity, in OUTPUT-token raw units, for a direction. */
export declare function level0CumOffset(direction: 'aToB' | 'bToA'): number;
/**
 * Fetch + gate one TesseraV pool. Read-only against the loader. Gates: wrong
 * owner/size, an unprimed mid (0 — a pool the maker bot has never quoted),
 * and a zero/absent level-0 price or capacity (an empty book for this
 * direction — self-drop, not a revert, at the orchestrator layer).
 */
export declare function fetchTesseraVConfig(load: AccountLoader, pool: Address, direction: 'aToB' | 'bToA'): Promise<TesseraVPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only — not in the v1 registry). */
export declare const tesserav: {
    slug: string;
    programId: Address<"TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchTesseraVConfig;
};
export {};
//# sourceMappingURL=index.d.ts.map