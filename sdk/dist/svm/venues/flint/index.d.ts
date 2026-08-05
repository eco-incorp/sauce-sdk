import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig, VenueAccount } from '../types.js';
declare const SLUG = "flint";
export declare const FLINT_PROGRAM_ID: Address<"FLiNTXPwppyoJabCoxc2uiiRygAHpmMXajiDXo2Ub1z">;
/**
 * Per-direction haircut applied ON TOP OF naive constant-product (ppm of
 * 1_000_000) — see the file header "Quote curve" section for the exact real
 * fill data and margin behind each of these three constants. Naive CP alone
 * is NOT reliably conservative for this venue (unlike bisonfi/humidifi), so
 * there is no single global constant.
 */
export declare const FLINT_HAIRCUT_USDT_USDC_PPM = 700000n;
export declare const FLINT_HAIRCUT_PUMPCMXQ_TO_USDT_PPM = 900000n;
export declare const FLINT_HAIRCUT_USDT_TO_PUMPCMXQ_PPM = 150000n;
/** One curated Flint pair, in its DEFAULT (A -> B) orientation. */
export interface FlintPairEntry {
    marketA: Address;
    vaultA: Address;
    mintA: Address;
    tokenProgramA: Address;
    marketB: Address;
    vaultB: Address;
    mintB: Address;
    tokenProgramB: Address;
    /** Real, chain-recovered instruction discriminator for THIS pair (see file header). */
    disc: number;
    /** Zero-byte tail length after the patched amountIn u64 (see file header). */
    tailZeros: number;
    /** The Token-2022 side's mint, if either side is Token-2022 (needed for transferChecked). */
    checkedMint?: Address;
    /** Whether the B->A direction is ALSO real-evidence-confirmed (see file header "Scope"). */
    reversible: boolean;
    /** Haircut (ppm) for the A->B direction — see file header "Quote curve" for the real-fill basis. */
    haircutAtoBPpm: bigint;
    /** Haircut (ppm) for the B->A direction — REQUIRED iff reversible (a DIFFERENT margin; see file header). */
    haircutBtoAPpm?: bigint;
}
/**
 * Curated registry, keyed by the "pool" address this family is discovered
 * under — the NON-USDT side of each pair (USDT is the common factor in both
 * shipped pairs today). See file header "Scope" for the evidence backing
 * each entry and each entry's reversibility.
 */
export declare const FLINT_PAIR_REGISTRY: Record<string, FlintPairEntry>;
export interface FlintPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    entry: FlintPairEntry;
    /** 'AtoB' = entry's default orientation; 'BtoA' only when entry.reversible. */
    direction: 'AtoB' | 'BtoA';
}
declare function fetchPoolConfig(load: AccountLoader, pool: Address): Promise<FlintPoolConfig>;
declare function quoteAccounts(base: PoolConfig): VenueAccount[];
export declare const flint: {
    slug: string;
    kind: "constant-product";
    programId: Address<"FLiNTXPwppyoJabCoxc2uiiRygAHpmMXajiDXo2Ub1z">;
    fetchPoolConfig: typeof fetchPoolConfig;
    quoteAccounts: typeof quoteAccounts;
};
export {};
//# sourceMappingURL=index.d.ts.map