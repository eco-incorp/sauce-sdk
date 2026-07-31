import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SwapUser, VenueAccount } from '../types.js';
declare const SLUG = "solfi-v2";
export declare const SOLFI_V2_PROGRAM_ID: Address<"SV2EYYJyRz2YhfXwXnhNAevDEui5Q6yrfyo13WtupPF">;
export declare const OFF_ORACLE = 24;
export declare const OFF_MINT_A = 56;
export declare const OFF_MINT_B = 88;
export declare const OFF_VAULT_A = 120;
export declare const OFF_VAULT_B = 152;
export declare const OFF_REGISTRY = 256;
export declare const CFG = 704;
/** Four splines, stride 0x88 from CFG; d0/d1 select by TRADE DIRECTION (not stride order). */
export declare const OFF_SPLINE_D1: number;
export declare const OFF_SPLINE_D0: number;
export declare const OFF_SPLINE_AGE: number;
export declare const OFF_SPLINE_SF: number;
export declare const OFF_CACHED_TS: number;
export declare const OFF_SPREAD_DIR1: number;
export declare const OFF_SPREAD_DIR0: number;
export declare const OFF_THRESHOLD: number;
export declare const OFF_SKEW_NUM: number;
export declare const OFF_SKEW_DEN: number;
export declare const OFF_SKEW_HI: number;
export declare const OFF_SKEW_LO_MAG: number;
export declare const OFF_DECAY_PPM: number;
export declare const OFF_LAST_SWAP_SLOT: number;
export declare const OFF_FEE_SCALE: number;
/** Spline struct: x[0..7] u64 @+0x00, y[0..7] u64 @+0x40, len u64 @+0x80. 136 bytes. */
export declare const SPLINE_X_STRIDE = 0;
export declare const SPLINE_Y_STRIDE = 64;
export declare const SPLINE_LEN_STRIDE = 128;
export declare const SPLINE_SIZE = 136;
export declare const ORACLE_OFF_EXP = 0;
export declare const ORACLE_OFF_MAN = 8;
export declare const ORACLE_OFF_SLOT = 16;
export declare const ORACLE_OFF_TS = 24;
export declare const ORACLE_OFF_CONF = 32;
export declare const ORACLE_OFF_EXPIRY_SLOT = 40;
export declare const ORACLE_OFF_FEE_WORD = 56;
/**
 * 168-byte XOR keystream (21 u64 words), recovered from fn 0x26328
 * (0x26380-0x264a8 stores it as 21 immediates; XOR loop at 0x264c0-0x26518).
 * Word i covers plaintext bytes [8i, 8i+8). Only the words this adapter
 * actually reads are listed; word 3 (bytes 24..31, the ms timestamp) is
 * literally 0 — that field is plaintext in the raw account.
 */
export declare const ORACLE_KEY_WORDS: Record<number, bigint>;
/**
 * The one un-derived additive constant (units of 1e-7 impact), keyed by POOL —
 * see ladder.ts's module doc "residualRisk" for how it composes on-chain.
 *
 * FIXED (2026-07): this table used to be keyed by REGISTRY, not pool, on the
 * false premise that every pool sharing a registry shares its K. It does not:
 * registry QoFvFhDZg9TaZEi4SsasWpH5xXzk3zBqfRyicGexfNQ alone carries at least
 * two pools with DIFFERENT, independently-fitted K (K in [0, 12000] bisected
 * against drift-free bursts) — FkEB6uvyzuoaGpgs4yRtFtxC4WJxhejNFbUkj5R6wR32
 * (USDT/USDC) needs K=0, 2Q6S8p9iZNzMvpTemiC56HqCJ3F3szNoyRkvqEKfCanY needs
 * K=5832 — and the old registry-keyed table quoted BOTH with 5832, so the
 * USDT pool was systematically wrong by 5832 units of 1e-7 impact (5.832 bps),
 * understating the true impact and so OVER-quoting the output by that amount
 * on every trade — not the "<=1 unit, always-safe" residual the old comment
 * claimed (that claim was true of ONE pool, 65ZHSArs..., and was written as if
 * venue-wide). fetchPoolConfig read the registry key blindly, admitting all
 * ~18 pools on that registry with an unverified, borrowed K.
 *
 * Fixed: keyed by POOL. A pool whose K has not been independently verified
 * throws at fetchPoolConfig instead of borrowing its registry-mate's value —
 * REFUSE, don't guess (see fetchPoolConfig below). Each entry below is
 * verified wei-exact against fresh mainnet `simulateTransaction` calls at
 * that SPECIFIC pool (65ZHSArs...: 84+ calls, 0 mismatch, within one
 * oracle-publish burst — see ladder.ts's module doc and solfi-v2.test.ts;
 * FkEB6uvy.../2Q6S8p9i...: bisected against drift-free bursts, K in
 * [0, 12000]).
 */
export declare const POOL_K: Record<string, bigint>;
export interface SolfiV2PoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 0 = mintA -> mintB, 1 = mintB -> mintA. */
    direction: 0 | 1;
    mintA: Address;
    mintB: Address;
    vaultA: Address;
    vaultB: Address;
    oracle: Address;
    registry: Address;
    tokenProgram: Address;
    /**
     * Additive impact constant (1e-7 units), resolved PER POOL (see POOL_K —
     * pools on the same registry are not guaranteed to share one).
     */
    additiveK: bigint;
}
export declare const solfiV2: {
    slug: string;
    kind: "constant-product";
    programId: Address<"SV2EYYJyRz2YhfXwXnhNAevDEui5Q6yrfyo13WtupPF">;
    /**
     * Off-chain gate + decode. Rejects: wrong pool/oracle size, a pool whose
     * additive-impact constant K has never been independently verified (see
     * POOL_K — keyed by POOL, not registry: pools sharing a registry are NOT
     * guaranteed to share K, see POOL_K's header), and a missing
     * mint/oracle/registry account. direction is caller-supplied (0 or 1); both
     * directions share one pool account.
     */
    fetchPoolConfig(load: AccountLoader, pool: Address, direction?: 0 | 1): Promise<SolfiV2PoolConfig>;
    quoteAccounts(cfg: PoolConfig): VenueAccount[];
    /** v1 swap CPI (amount baked). disc(1) || amountIn u64 LE || minOut u64 LE=1 || direction u8. */
    buildSwap(cfg: PoolConfig, user: SwapUser, amountIn: bigint): {
        programId: Address<"SV2EYYJyRz2YhfXwXnhNAevDEui5Q6yrfyo13WtupPF">;
        data: Uint8Array<ArrayBuffer>;
        accounts: VenueAccount[];
    };
};
/**
 * The 13-account order for SolFi V2's swap (disc 0x07), shared by v1 buildSwap
 * and v2 buildSwapV2. Decoded from landed simulations, not docs (no IDL/docs
 * exist for this venue): [signer, pool, oracle, registry, vaultA, vaultB,
 * userA, userB, mintA, mintB, TOKEN, TOKEN (slot repeated), instructions
 * sysvar]. userA/userB are POSITIONAL BY MINT, never by direction.
 */
export declare function solfiSwapAccounts(c: SolfiV2PoolConfig, user: SwapUser, make: (ref: string, addr: Address, writable?: boolean) => VenueAccount, refFor?: (role: string) => string): VenueAccount[];
/** Re-exported for the ladder mirror + tests (avoids a second copy of the offset table). */
export declare function readAccountU64(data: Uint8Array, offset: number): bigint;
export {};
//# sourceMappingURL=index.d.ts.map