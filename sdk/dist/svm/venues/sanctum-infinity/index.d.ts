import type { Address } from '@solana/kit';
import type { AccountBytesMap, AccountLoader, LadderSwapTemplate, PoolConfig, SwapUser, VenueAccount } from '../types.js';
declare const SLUG = "sanctum-infinity";
/** The S-controller ("INF") program — `SVM_VENUE_PROGRAM_IDS['sanctum-infinity']`. */
export declare const SANCTUM_INFINITY_PROGRAM_ID: Address<"5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx">;
export declare const POOL_STATE_ID: Address<"AYhux5gJzCoeoc1PoJ1VxwPDe22RwcvpHviLDD1oCGvW">;
export declare const LST_STATE_LIST_ID: Address<"Gb7m4daakbVbrFLR33FKMDVMHAprRZ66CSYt4bpFwUgS">;
/** The FlatSlab pricing program (== the live pool's `pricingProgram`, verified 2026-07-31). */
export declare const FLAT_SLAB_PROGRAM_ID: Address<"s1b6NRXj6ygNu1QMKXh2H9LUR2aPApAAm1UQ2DjdhNV">;
/** FlatSlab's one global fee-schedule account (PDA seed `b"slab"`). */
export declare const SLAB_ID: Address<"4T9YzXnmQFMyYi2nrxyXjhtUANavmCkxGCsU3GKaNjwT">;
/** The wSOL calculator: no state/pool_prog/pool_progdata — pure identity math, zero suf accounts. */
export declare const WSOL_CALC_PROGRAM_ID: Address<"wsoGmxQLSvwWpuaidCApxN5kEowLe2HLQLJhCQnj4bE">;
export interface SanctumInfinityLegConfig {
    mint: Address;
    isWsol: boolean;
    /** Absent iff isWsol. */
    stakePool?: Address;
    poolReserves: Address;
    /** Index of this LST within `lst_state_list` at fetch time — baked into the swap ix. */
    lstIndex: number;
    isInputDisabled: boolean;
    /** Withdrawal fee ratio (0/1 for wsol). */
    feeNum: bigint;
    feeDenom: bigint;
    /** FlatSlab per-mint fee-schedule entry (i32 nanos; can be negative — a rebate). */
    inpFeeNanos: bigint;
    outFeeNanos: bigint;
}
export interface SanctumInfinityPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    in: SanctumInfinityLegConfig;
    out: SanctumInfinityLegConfig;
}
/** Mint (or re-mint, idempotently) the synthetic discovery key for a directed pair. */
export declare function sanctumInfinityPoolKey(inMint: Address, outMint: Address): Address;
export declare const sanctumInfinity: {
    slug: string;
    kind: "constant-product";
    programId: Address<"5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx">;
    /**
     * `pool` is the synthetic per-directed-pair key from
     * `sanctumInfinityPoolKey` (see this file's discovery-key doc) — NEVER an
     * on-chain address. Reads `lst_state_list` + `slab` once, resolves both
     * legs (self-dropping the whole pair on ANY unsupported/missing leg —
     * a per-pair gate, since a pair genuinely needs both legs to be
     * servable), and gates on `pool_state.{is_disabled,is_rebalancing}` and
     * the INPUT leg's `is_input_disabled` (the on-chain check only inspects
     * the src side — see `verify_swap_v2`).
     */
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<SanctumInfinityPoolConfig>;
    quoteAccounts(base: PoolConfig): VenueAccount[];
};
export declare const sanctumInfinityLadder: {
    slug: string;
    /**
     * Shape varies by which side (if either) is wSOL — a wsol leg attaches no
     * stake-pool account and its setup emits a literal `1`/`1` sentinel pair
     * instead of an `accountUint` read (see `emitSetup`); the shared helper
     * (`qSanctumInfinity`) computes the plain identity from those sentinels
     * with NO runtime branch (totalLamports==poolTokenSupply==1, feeNum==0 ⇒
     * the general ratio math reduces to `x` exactly — see the helper source).
     */
    shapeKey(base: PoolConfig): string;
    helpers(_base: PoolConfig): {
        name: string;
        source: string;
    }[];
    paramCount: number;
    paramsFor(base: PoolConfig): bigint[];
    quoteRefs(base: PoolConfig, slot: number): VenueAccount[];
    emitSetup(base: PoolConfig, slot: number, params: readonly string[]): string;
    emitQuoteCall(_base: PoolConfig, slot: number, x: string): string;
    /**
     * `swapExactInV2` (disc 23) — see the module doc for the full account-
     * order citation trail. `limit` (min_amount_out) is 1, matching every
     * other adapter — the recipe's own outAta delta check is the real floor.
     */
    buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate;
    /** TS mirror of `qSanctumInfinity` — see that helper for the line-for-line derivation. */
    referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint;
    depthReserves(base: PoolConfig, state: AccountBytesMap): {
        reserveIn: bigint;
        reserveOut: bigint;
    };
    /**
     * Measurement-only approximation: `gammaPpm` folds the flat FlatSlab fee
     * (nanos -> ppm) — there is no curve, so this is exact for THIS venue
     * (unlike CP families, where the continuous-fee oracle is an
     * approximation of a real curve).
     */
    continuousFees(_base: PoolConfig, _state: AccountBytesMap, params: readonly bigint[]): {
        gammaPpm: bigint;
        muPpm: bigint;
    };
};
/** Test/tooling seam: clear the discovery-key registry between fixtures. */
export declare function __resetSanctumInfinityKeysForTest(): void;
/** Test/tooling seam: look up a previously-minted discovery key (mirrors what `fetchPoolConfig` does). */
export declare function sanctumInfinityLookupPair(pool: Address): {
    inMint: Address;
    outMint: Address;
} | undefined;
export {};
//# sourceMappingURL=index.d.ts.map