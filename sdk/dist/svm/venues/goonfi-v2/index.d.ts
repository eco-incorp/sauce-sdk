import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SwapUser, VenueAccount, VenueSwap } from '../types.js';
declare const SLUG = "goonfi-v2";
export declare const GOONFI_V2_PROGRAM_ID: Address<"goonuddtQRrWqqn5nFyczVKaie28f3kDkHWkHtURSLE">;
/** The 719,000-byte account every sampled pool's swap attaches read-only (account #9) — owned by
 *  the GoonFi program itself, NOT written by swap (confirmed via the real tx's writable-flags
 *  decode), so it is genuine keeper-maintained state the swap only consults. Its internal layout
 *  is >98% zero-padded and not yet decoded; this adapter does not read it directly (the per-pool
 *  oracle-relay account below carries the live price signal instead). */
export declare const GOONFI_GLOBAL_STATE: Address<"BNrK9LpEn65QA4TyBLVSMdngW3XHj3xLfFPwGdCBv8wV">;
/** sha256-style single-byte tag observed on all 4 real captured swaps. */
export declare const GOONFI_SWAP_TAG = 1;
export declare const GOONFI_OFF_MINT_A = 80;
export declare const GOONFI_OFF_MINT_B = 112;
export declare const GOONFI_OFF_VAULT_A = 144;
export declare const GOONFI_OFF_VAULT_B = 176;
/** The per-pool oracle-relay account (swap account #8; see module doc). */
export declare const GOONFI_OFF_ORACLE = 208;
export declare const OFF_ORACLE_P1 = 0;
export declare const OFF_ORACLE_P2 = 8;
export declare const OFF_ORACLE_SLOT = 16;
export declare const OFF_ORACLE_DENOM = 20;
/** The denominator observed on all 4 sampled oracle-relay accounts — a fail-closed assumption:
 *  the live denom is still read and gated against this at cook time (see ladder.ts), so a future
 *  pool with a genuinely different denom self-deactivates instead of silently mispricing. */
export declare const GOONFI_ASSUMED_DENOM = 1000000n;
/** The empirically-validated fee schedule (ppm, i.e. parts-per-1e6) — see module doc for the
 *  measurement this pins against (tier 5 = 2200 ppm = 22.00 bps, matching a real Jupiter-quoted
 *  10,000 USDC price impact of ~21.8 bps). Read LIVE from the pool's own bytes (not baked) so a
 *  pool with a genuinely different admin-configured schedule is priced from its own table.
 */
export interface GoonfiFeeSchedule {
    /** 9 ascending cumulative-size thresholds, in the CALLER-SIDE mint's raw units for this
     *  direction (already decimals-adjusted at fetch time — see paramsFor in ladder.ts). */
    sizeTiers: readonly bigint[];
    /** 9 fee rates in ppm, ascending, one per tier upper bound. */
    feeTiersPpm: readonly bigint[];
}
export interface GoonfiV2PoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'xToY' (default — mintA in, mintB out) | 'yToX'. */
    direction: 'xToY' | 'yToX';
    mintA: Address;
    mintB: Address;
    decimalsA: number;
    decimalsB: number;
    vaultA: Address;
    vaultB: Address;
    oracle: Address;
    tokenProgram: Address;
    /** Fee schedule read from the pool's own bytes, already oriented for `direction` (mintB-raw
     *  cumulative thresholds for yToX; snapshot-price-converted to mintA-raw for xToY — see
     *  ladder.ts's paramsFor doc for why xToY's thresholds are a one-time approximation). */
    feeSchedule: GoonfiFeeSchedule;
}
/** denomAdjusted = ASSUMED_DENOM * 10^decimalsA / 10^decimalsB — the single scale constant the
 *  live-price formula divides (xToY) or multiplies (yToX) by. Shared between fetchPoolConfig
 *  (threshold baking) and the ladder (the runtime param) so the two can never diverge. */
export declare function denomAdjustedFor(decimalsA: number, decimalsB: number): bigint;
export declare const goonfiV2: {
    slug: string;
    kind: "constant-product";
    programId: Address<"goonuddtQRrWqqn5nFyczVKaie28f3kDkHWkHtURSLE">;
    /**
     * Off-chain gate + decode. Rejects: wrong size/discriminator, an unreadable
     * oracle-relay or mint account, a non-ascending fee-tier table (a corrupt or
     * unrecognized layout variant — fail closed rather than guess).
     */
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<GoonfiV2PoolConfig>;
    quoteAccounts(cfg: PoolConfig): VenueAccount[];
    /** v1 swap CPI (amount baked) — the real 14-account `swap` ix (tag 1). */
    buildSwap(cfg: PoolConfig, user: SwapUser, amountIn: bigint): VenueSwap;
};
/**
 * The 14-account order for GoonFi's real `swap` (shared by v1 buildSwap and v2 buildSwapV2) — read
 * back off a real captured transaction's own writable/signer flags (not guessed):
 *   0 user(signer,w) · 1 pool(w) · 2 user mintA-ATA(w) · 3 user mintB-ATA(w) · 4 vaultA(w) ·
 *   5 vaultB(w) · 6 mintA · 7 mintB · 8 oracle-relay · 9 GOONFI_GLOBAL_STATE · 10 ix-sysvar ·
 *   11 token program · 12 token program (again) · 13 GOONFI_CONST_ACCOUNT_13.
 * User ATA order is FIXED (mintA-ATA, mintB-ATA) regardless of direction — only the tag-1 direction
 * byte decides which side is pulled from vs paid into, exactly like vaultA/vaultB.
 */
export declare function goonfiSwapAccounts(c: GoonfiV2PoolConfig, user: SwapUser, make: (ref: string, addr: Address, writable?: boolean) => VenueAccount, refFor?: (role: string) => string): VenueAccount[];
export {};
//# sourceMappingURL=index.d.ts.map