import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, VenueAccount } from '../types.js';
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
/** Test/tooling seam: clear the discovery-key registry between fixtures. */
export declare function __resetSanctumInfinityKeysForTest(): void;
/** Test/tooling seam: look up a previously-minted discovery key (mirrors what `fetchPoolConfig` does). */
export declare function sanctumInfinityLookupPair(pool: Address): {
    inMint: Address;
    outMint: Address;
} | undefined;
export {};
//# sourceMappingURL=index.d.ts.map