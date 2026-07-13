import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SwapUser, VenueAccount, VenueSwap } from '../types.js';
import type { CpiTier } from '../../cpi-probe.js';
declare const SLUG = "obric-v2";
export declare const OBRIC_V2_PROGRAM_ID: Address<"obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y">;
/** The Pyth-v2-format relay program Obric migrated onto (documented layout). */
export declare const PYTH_V2_RELAY_OWNER = "Feed29BgSBmKrK5jQsLR4VcwJpJr1eHfg5sX4TQbLGrV";
/** sha256('global:swap')[0..8] (Obric's unified swap; == meteora's, both "global:swap"). */
export declare const OBRIC_SWAP_DISCRIMINATOR: number[];
export declare const OFF_INITIALIZED = 8;
export declare const OFF_X_FEED = 9;
export declare const OFF_Y_FEED = 41;
export declare const OFF_RESERVE_X = 73;
export declare const OFF_RESERVE_Y = 105;
export declare const OFF_PROTO_FEE_X = 137;
export declare const OFF_PROTO_FEE_Y = 169;
export declare const OFF_MINT_X = 202;
export declare const OFF_MINT_Y = 234;
export declare const OFF_BIG_K = 274;
export declare const OFF_TARGET_X = 290;
export declare const OFF_MULT_X = 306;
export declare const OFF_MULT_Y = 314;
export declare const OFF_FEE_MILLIONTH = 322;
export declare const OFF_REBATE_PCT = 330;
export declare const OFF_PROTO_FEE_SHARE = 338;
/** Default sanity band (bps of the stored mult ratio): a wide gross-corruption guard for the documented P-A feed. */
export declare const OBRIC_DEFAULT_BAND_BPS = 2500n;
export interface ObricV2PoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 'xToY' (default — mintX in, mintY out) | 'yToX'. */
    direction: 'xToY' | 'yToX';
    mintX: Address;
    mintY: Address;
    /** Vault token accounts (amount@64 read live for the reserves). */
    reserveXVault: Address;
    reserveYVault: Address;
    /** Protocol-fee vaults (the swap ix's account #7 is the OUTPUT side's). */
    protocolFeeX: Address;
    protocolFeeY: Address;
    feedX: Address;
    feedY: Address;
    /** Both mints share this token program (classic Tokenkeg — the recipe class). */
    tokenProgram: Address;
    /** Drift-invariant curve shape (baked): virtual-reserve product. */
    bigK: bigint;
    targetX: bigint;
    feeMillionth: bigint;
    /** Oracle scaling per side: mult = floor(rawPrice / div) * mul (reproduces the SDK getPrice + decimalMult). */
    divX: bigint;
    mulX: bigint;
    divY: bigint;
    mulY: bigint;
    /** Live price offset within each feed (Pyth-v2 relay: 208). */
    priceOffX: bigint;
    priceOffY: bigint;
    /** Sanity band (bps of the stored mult ratio); 0 disables. */
    bandBps: bigint;
    /** Fetch-time oracle snapshot (the quote re-reads the feeds live). */
    storedMultX: bigint;
    storedMultY: bigint;
    /** CPI-acceptance classification (P-A for the admitted Pyth-relay pools). */
    cpiTier: CpiTier;
}
export declare const obricV2: {
    slug: string;
    kind: "constant-product";
    programId: Address<"obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y">;
    /**
     * Off-chain gate + oracle classification. Rejects: wrong size/disc,
     * uninitialized, bigK=0 (drained), token-2022 mints (Tokenkeg-only class),
     * and — the CPI-acceptance discriminant — a feed pointing at the
     * instructions sysvar (the introspecting P-C pools) or a feed whose layout
     * is not the documented Pyth-v2 relay (Doves/Minimox — P-B, unpinned layout).
     */
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<ObricV2PoolConfig>;
    quoteAccounts(cfg: PoolConfig): VenueAccount[];
    /** v1 swap CPI (amount baked) — the unified `swap` ix. */
    buildSwap(cfg: PoolConfig, user: SwapUser, amountIn: bigint): VenueSwap;
};
/** The 12-account order for Obric's unified `swap` (shared by v1 buildSwap and v2 buildSwapV2). */
export declare function swapAccounts(c: ObricV2PoolConfig, user: SwapUser, make: (ref: string, addr: Address, writable?: boolean) => VenueAccount, refFor?: (role: string) => string): VenueAccount[];
export {};
//# sourceMappingURL=index.d.ts.map