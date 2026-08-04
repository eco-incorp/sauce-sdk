import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, SwapUser, VenueAccount, VenueSwap } from '../types.js';
declare const SLUG = "metric";
export declare const METRIC_PROGRAM_ID: Address<"Bvs46DPFxiFE6YHxLDLD6QAUcmy51FyRVPZJusPxLk3j">;
export declare const METRIC_ORACLE_PROGRAM_ID: Address<"CvGnk4HouriGypBTZhYc76esyN5kWBepWueYVeSpR1L1">;
export declare const OFF_MINT_A = 74;
export declare const OFF_VAULT_A = 106;
export declare const OFF_MINT_B = 138;
export declare const OFF_VAULT_B = 170;
export declare const OFF_ORACLE_CONFIG = 234;
/** Byte offset of the paired price account's pubkey inside the oracle config account. */
export declare const PRICE_ACCOUNT_OFFSET_IN_ORACLE_CONFIG = 103;
/** `swap`'s single-byte discriminator. */
export declare const METRIC_SWAP_DISCRIMINATOR = 1;
/**
 * Conservative quotable-capacity divisor (see module doc) — the ladder never quotes more than
 * `liveReserveOut / CAP_DIVISOR` output. Mirrors zerofi's own CAP_DIVISOR precedent and rationale:
 * the venue's real depth model (the pool's own variable-length bin tail) is unrecovered, so an
 * unbounded flat-price quote would be unsafe; this is a deliberately conservative substitute, not a
 * measured true capacity.
 */
export declare const CAP_DIVISOR = 20n;
/**
 * On-chain drift tolerance (bps) between the BAKED oracle price (from `fetchPoolConfig`'s
 * `fetchOracleQuote`) and the LIVE price the emitted fragment re-reads via its own CPI at cook
 * time — beyond this, the slot self-drops (zeroes its enable local) rather than quoting a stale
 * price. 50 bps is a deliberately conservative choice (the measured live spread itself is ~1bp);
 * this bounds staleness, not fill quality.
 */
export declare const METRIC_DRIFT_TOLERANCE_BPS = 50n;
export interface MetricPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /** 0 = mintA -> mintB (bid applies), 1 = mintB -> mintA (ask, reciprocal, applies). */
    direction: 0 | 1;
    mintA: Address;
    mintB: Address;
    vaultA: Address;
    vaultB: Address;
    oracleConfig: Address;
    priceAccount: Address;
    tokenProgramA: Address;
    tokenProgramB: Address;
    decimalsA: number;
    decimalsB: number;
    /** Baked oracle read (32-byte CPI return data, u128 LE halves) — see module doc. */
    bidQ64: bigint;
    askQ64: bigint;
    /** This direction's baked scale, already decimals-adjusted and gcd-reduced: out = in * scaleNum / scaleDen. */
    scaleNum: bigint;
    scaleDen: bigint;
    /** The baked price THIS direction's on-chain drift check compares the live re-read against (bidQ64 or askQ64). */
    bakedPrice: bigint;
}
/**
 * Fold a Q64.64 price (quote-per-base atoms-agnostic) plus the two mints' decimals into a
 * gcd-reduced (num, den) atoms-to-atoms scale: `outAtoms = inAtoms * num / den`.
 * `reciprocal` computes the OTHER direction's scale from the SAME price (division, not a second
 * baked value) — mirrors zerofi's ieee754ScaleParams direction-flip (swap num<->den AND which side
 * carries the decimals adjustment).
 */
export declare function metricScaleParams(priceQ64: bigint, decimalsIn: number, decimalsOut: number, reciprocal: boolean): {
    num: bigint;
    den: bigint;
};
export declare const metric: {
    slug: string;
    kind: "constant-product";
    programId: Address<"Bvs46DPFxiFE6YHxLDLD6QAUcmy51FyRVPZJusPxLk3j">;
    /**
     * Off-chain gate + decode. `pool` is the variable-length pool account (see module doc — only the
     * fixed 266-byte prefix is read; the trailing bin tail is not decoded). `fetchOracleQuote` is
     * REQUIRED in practice (throws when absent): it must run the oracle program's `[0x02, feedByte]`
     * read (any feedByte — see module doc) against `(oracleConfig, priceAccount)` and return its raw
     * 32-byte CPI return data — a capability plain `AccountLoader` byte reads cannot provide. The
     * consuming app supplies this via a real `simulateTransaction` (or a LiteSVM execution in tests);
     * this adapter stays free of any RPC/simulate dependency itself.
     */
    fetchPoolConfig(load: AccountLoader, pool: Address, direction?: 0 | 1, fetchOracleQuote?: (oracleProgram: Address, oracleConfig: Address, priceAccount: Address) => Promise<Uint8Array>): Promise<MetricPoolConfig>;
    quoteAccounts(cfg: PoolConfig): VenueAccount[];
    /**
     * v1 swap CPI (amount baked). disc(1) ++ amountIn u64 LE ++ [1] ++ direction u8 ++ minOut u128 LE=1.
     */
    buildSwap(cfg: PoolConfig, user: SwapUser, amountIn: bigint): VenueSwap;
};
/**
 * The 15-account order for Metric's `swap` (disc 0x01) — see module doc. `userAtaA`/`userAtaB`
 * ride FIXED slots 6/7 regardless of direction (always mintA's / mintB's side respectively); the
 * direction BYTE in the instruction data (not account order) tells the program which way to move
 * value.
 */
export declare function metricSwapAccounts(c: MetricPoolConfig, user: SwapUser, make: (ref: string, addr: Address, writable?: boolean) => VenueAccount, refFor?: (role: string) => string): VenueAccount[];
export {};
//# sourceMappingURL=index.d.ts.map