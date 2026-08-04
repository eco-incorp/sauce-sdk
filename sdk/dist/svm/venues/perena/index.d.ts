import type { Address } from '@solana/kit';
import type { PoolConfig, SvmVenueAdapter } from '../types.js';
declare const SLUG = "perena";
export declare const PERENA_PROGRAM_ID: Address<"NUMERUNsFCP3kuNmWZuXtm1AaQCPj9uw6Guv2Ekoi5P">;
export declare const STABLE_POOL_ACCOUNT_SIZE = 4024;
/** sha256('account:StablePool')[0..8]. */
export declare const STABLE_POOL_DISCRIMINATOR: number[];
export interface PerenaPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'aToB': pair 0 (A) in -> pair 1 (B) out. 'bToA' is the reverse. */
    direction: 'aToB' | 'bToA';
    aMint: Address;
    aVault: Address;
    aIs2022: boolean;
    bMint: Address;
    bVault: Address;
    bIs2022: boolean;
    /** Curve params (immutable post-creation — no admin instruction changes them), low 64 of the u128 fields. */
    ampRaw: bigint;
    /** curve_a == curve_b is REQUIRED (asserted at fetch time) — this is that shared value. */
    aRaw: bigint;
    /** Snapshot at fetch time — see module header STATUS/PAUSE. */
    pausedAtFetch: boolean;
    /** Snapshot at fetch time — see module header SCOPE (both pairs' rate must be 1:1). */
    rateOkAtFetch: boolean;
    /** Snapshot at fetch time — see module header SCOPE (both pairs must share decimals). */
    decimalsOkAtFetch: boolean;
}
export interface PerenaLiveState {
    ampRaw: bigint;
    aRaw: bigint;
    feeNum: bigint;
    feeDenom: bigint;
    xIn: bigint;
    yIn: bigint;
    lIn: bigint;
    xOut: bigint;
    yOut: bigint;
    lOut: bigint;
}
/**
 * TS mirror of the emitted fragment's per-rung quote — see module header
 * MATH for the 2-hop derivation and RESIDUAL for the measured, disclosed gap
 * to the real venue, and MARGIN_BPS for the conservative haircut applied
 * here.
 */
export declare function perenaSwapOut(live: PerenaLiveState, x: bigint): bigint;
export declare const perena: SvmVenueAdapter;
export {};
//# sourceMappingURL=index.d.ts.map