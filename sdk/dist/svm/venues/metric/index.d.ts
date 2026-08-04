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
 * Conservative quote haircut, in parts-per-million, folded into the baked scale so the quote is a
 * lower bound on the realized fill (never an over-quote).
 *
 * WHY IT EXISTS — a measured, not guessed, correction. A paired-differential simulation of the REAL
 * swap on real mainnet pools (impersonating a funded recent trader; sizes spanning 667x — 3, 100 and
 * 2000 tokens — pinned to one context slot) found the raw oracle-price prediction (`in * bid/2^64`)
 * OVER-quotes the realized output by a small, strikingly SIZE-INDEPENDENT margin: 3, 3 and 4 ppm at
 * x = 3, 100, 2000 tokens respectively. Size-independence is the decisive result — it confirms this
 * oracle-priced PMM fills at a flat price with NO slippage curve (a capacity-aware bin-walk would
 * address slippage that measurably does not exist here), so the flat stateless rung is correct and
 * the only correction needed is this small constant offset. The offset itself is the oracle's own
 * bid/ask micro-spread plus price drift between the off-chain bake and the on-chain cook slot, not a
 * curve.
 *
 * The haircut is set an order of magnitude above the measured ~4 ppm so `predicted <= realized`
 * holds with margin across the whole measured size range AND absorbs additional bake-to-cook oracle
 * micro-drift over a real routing window. Priced INTO the scale (not deducted afterward), so
 * `continuousFees` stays the identity — the same convention zerofi/obric-v2 use. An under-quote is
 * safe (at worst Metric is not elected when it was marginally best); an over-quote is the hazard
 * this removes, because Metric's own swap reverts if its `minOut` is unmet and the engine's CATCH is
 * pre-flight-only, so an over-optimistic quote is a whole-cook-abort risk, not just a bad fill.
 */
export declare const METRIC_QUOTE_HAIRCUT_PPM = 50n;
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
    /** Baked oracle read (32-byte off-chain oracle-read return data, u128 LE halves) — see module doc. */
    bidQ64: bigint;
    askQ64: bigint;
    /**
     * This direction's baked scale, already decimals-adjusted, haircut-folded
     * (`METRIC_QUOTE_HAIRCUT_PPM`, so `out` is a conservative lower bound) and gcd-reduced:
     * `out = in * scaleNum / scaleDen`.
     */
    scaleNum: bigint;
    scaleDen: bigint;
    /** This direction's baked price (bidQ64 for dir 0, askQ64 for dir 1) — informational; the quote uses scaleNum/scaleDen. */
    bakedPrice: bigint;
}
/**
 * Fold a Q64.64 price (quote-per-base atoms-agnostic) plus the two mints' decimals into a
 * gcd-reduced (num, den) atoms-to-atoms scale: `outAtoms = inAtoms * num / den`.
 * `reciprocal` computes the OTHER direction's scale from the SAME price (division, not a second
 * baked value) — mirrors zerofi's ieee754ScaleParams direction-flip (swap num<->den AND which side
 * carries the decimals adjustment).
 *
 * A `METRIC_QUOTE_HAIRCUT_PPM` haircut is folded in (num scaled down by `(1e6 - haircut)/1e6`) so
 * the result is a lower bound on the realized fill — see that constant's doc for the measurement
 * that sized it. The haircut rides in the exact (num, den) pair, so `referenceQuote` stays lamport-
 * exact against the SAME params the emitted fragment uses.
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