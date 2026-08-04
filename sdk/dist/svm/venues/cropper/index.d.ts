import type { Address } from '@solana/kit';
import { TICK_ARRAY_ACCOUNT_SIZE, WHIRLPOOL_ACCOUNT_SIZE } from '../orca-whirlpool/index.js';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "cropper";
/** Cropper's AMM (Whirlpool-lineage CLMM) program. */
export declare const CROPPER_PROGRAM_ID: Address<"H8W3ctz92svYg6mkn1UtGfu2aQr2fnUFHM1RhScEtQDt">;
export { WHIRLPOOL_ACCOUNT_SIZE as CROPPER_POOL_ACCOUNT_SIZE, TICK_ARRAY_ACCOUNT_SIZE as CROPPER_TICK_ARRAY_ACCOUNT_SIZE };
/**
 * Sentinels the venue's `swap` substitutes when no explicit per-pool limit is
 * given (NOT exported by the SDK barrel — orca-whirlpool's own
 * MIN_SQRT_PRICE/MAX_SQRT_PRICE live in that venue's internal tick-math.ts,
 * unreachable through the public svm barrel — redeclared here byte-equal;
 * see docs/svm-venues.md-style provenance in the module header above).
 */
export declare const CROPPER_MIN_SQRT_PRICE = 4295048016n;
export declare const CROPPER_MAX_SQRT_PRICE = 79226673515401279992447579055n;
/**
 * Shipped initialized-tick boundaries per direction — independent of
 * orca-whirlpool's own WHIRLPOOL_MAX_BOUNDARIES by design (see the module
 * header), kept numerically equal (4) for the same measured per-step CU
 * economics (a crossed boundary is ~45k CU in the walk, per orca-whirlpool's
 * own budget.ts commentary).
 */
export declare const CROPPER_MAX_BOUNDARIES = 4;
export interface CropperBoundary {
    arrayIndex: number;
    offset: number;
    tick: number;
    sqrtPrice: bigint;
}
export interface CropperWindow {
    tickArrays: [Address, Address, Address];
    startTicks: [number, number, number];
    boundaries: CropperBoundary[];
    edge: {
        tick: number;
        sqrtPrice: bigint;
    } | null;
    readable: number;
}
export interface CropperPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** Trade direction: 'aToB' (default) sells token A for token B. */
    direction: 'aToB' | 'bToA';
    tokenMintA: Address;
    tokenMintB: Address;
    tokenVaultA: Address;
    tokenVaultB: Address;
    /** PDA ['oracle', pool] — uninitialized for static-fee pools, but the swap ix requires it. */
    oracle: Address;
    tickSpacing: number;
    feeRate: number;
    liquidity: bigint;
    sqrtPrice: bigint;
    tickCurrentIndex: number;
    windows: {
        aToB: CropperWindow;
        bToA: CropperWindow;
    };
}
/**
 * Fetch + gate one Cropper pool (see the header for the gate list) and
 * freeze both directions' boundary windows. Read-only against the loader.
 */
export declare function fetchCropperConfig(load: AccountLoader, pool: Address): Promise<CropperPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only — no v1 adapter). */
export declare const cropper: {
    slug: string;
    programId: Address<"H8W3ctz92svYg6mkn1UtGfu2aQr2fnUFHM1RhScEtQDt">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchCropperConfig;
};
//# sourceMappingURL=index.d.ts.map