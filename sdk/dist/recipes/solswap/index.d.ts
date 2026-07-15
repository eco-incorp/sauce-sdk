/**
 * Solswap recipe: N-pool on-chain quote-and-swap for the SVM engine.
 *
 * Attaches N pool state accounts read-only, quotes every pool IN the VM from
 * `accountData` reads, branches to the single best venue, makes ONE CPI to the
 * winner, enforces minOut (inclusive: bestOut == minOut passes), and returns
 * bestOut. On an exact quote tie the first-listed pool wins (the scan is
 * strictly-greater). Quoting N venues costs N read-only accounts; every
 * venue's swap accounts are attached with their declared flags, but only the
 * winner's swap accounts are written.
 *
 * v1 scope (deliberate): real AMM adapters (Raydium/Orca layouts, little-endian
 * u64 reserve decoding, CLMM tick math) are out of scope — the pool layout here
 * is the recipe's own canonical big-endian fixture layout (32-byte BE reserves
 * at caller-given offsets), and the "swap" CPI is whatever instruction the
 * caller bakes per pool (the e2e suite uses a system-program transfer standing
 * in for the venue call). The value is the compiled control-flow/account-plan
 * shape, which is venue-agnostic. See README.md.
 *
 * Overflow assumption: engine arithmetic wraps (no overflow revert). The quote
 * `mulDiv(ainFee, rOut, rIn * 10000 + ainFee)` is full-precision in the
 * numerator product, so the only wrap hazards are the denominator sum and the
 * quotient; both are safe while reserves and amountIn stay below 2^128 —
 * astronomically above real token magnitudes. Callers must not feed values
 * near 2^240.
 */
import type { Address } from "@solana/kit";
import type { AccountPlan } from "@eco-incorp/sauce-compiler";
import type { AccountLoader, VenueSwap } from "../../svm/venues/types.js";
export interface SolswapPool {
    /** Account ref of the pool state account (attached readonly, quoted in-VM). */
    ref: string;
    /** Byte offset of the 32-byte big-endian reserveIn word in the pool account data. */
    reserveInOffset: number;
    /** Byte offset of the 32-byte big-endian reserveOut word in the pool account data. */
    reserveOutOffset: number;
    /** Swap fee in basis points (e.g. 30n = 0.30%). */
    feeBps: bigint;
    /** What to CPI when this pool wins. */
    swap: {
        /** Ref of the venue program account (must be attached for the CPI to resolve). */
        programRef: string;
        /** The venue program id (32 bytes) — baked into the bytecode as the CALL target. */
        programId: Uint8Array;
        /** Raw CPI instruction data (venue discriminator included). */
        calldata: Uint8Array;
        accounts: {
            ref: string;
            writable?: boolean;
            signer?: boolean;
        }[];
    };
}
export interface SolswapConfig {
    /** Candidate pools in preference order — the first-listed pool wins an exact quote tie. */
    pools: SolswapPool[];
    amountIn: bigint;
    /** Minimum acceptable bestOut, inclusive: the program reverts only when bestOut < minOut. */
    minOut: bigint;
}
export interface SolswapOutput {
    /** Generated SauceScript source (for debugging). */
    source: string;
    /** Compiled `target: 'svm'` bytecode for one engine execute instruction. */
    bytecode: Uint8Array;
    /**
     * Ordered user-account plan: metas[i] is user-account index i (instruction
     * account 3+i). Venue program metas carry their pubkey (from swap.programId),
     * so `resolveAccounts` binds them without a resolution entry.
     */
    accountPlan: AccountPlan;
    warnings: string[];
}
/**
 * Constant-product quote with fee — the exact integer math the generated
 * bytecode runs on-chain, for computing expected outputs off-chain:
 * `out = (amountIn * (10000 - feeBps) * reserveOut) / (reserveIn * 10000 + amountIn * (10000 - feeBps))`.
 */
export declare function solswapQuote(amountIn: bigint, feeBps: bigint, reserveIn: bigint, reserveOut: bigint): bigint;
/**
 * Generate and compile the quote-and-swap program for `config.pools`
 * (unrolled per pool, 2..8 pools). Pure and off-line: no RPC — callers
 * resolve the plan and send via `@eco-incorp/sauce-sdk`'s /svm module.
 */
export declare function solswap(config: SolswapConfig): SolswapOutput;
/** A live-quoted venue pool: the adapter reads its state in-VM at execute time. */
export interface SolswapBestVenuePool {
    /** Venue adapter slug (see listVenues()). */
    venue: string;
    /** Pool state account address. */
    pool: Address;
}
/**
 * An external-quote entry: `quotedOut` was produced off-chain (see
 * quoteViaSimulation) and is baked into the bytecode as a constant candidate.
 * Exact at quote time ONLY — the recipe's post-swap outAta delta check is the
 * on-chain safety net against staleness.
 */
export interface SolswapBestExternalPool {
    external: {
        /** Human-readable name, reported as `pool` in the quotes result. */
        label: string;
        quotedOut: bigint;
        swap: VenueSwap;
    };
}
export type SolswapBestPool = SolswapBestVenuePool | SolswapBestExternalPool;
/** User-side account refs (resolved by the caller when sending). */
export interface SolswapBestUser {
    /** Ref of the user's output-token account (delta-checked post-swap). */
    outAta: string;
    /** Ref of the user's input-token account. */
    inAta: string;
    /** Ref of the user's wallet — token authority, attached as signer. */
    owner: string;
}
export interface SolswapBestConfig {
    amountIn: bigint;
    /** Minimum realized outAta delta, inclusive — checked pre-CPI on the best quote and post-CPI on the delta. */
    minOut: bigint;
    /** Candidate pools in preference order — the first-listed pool wins an exact quote tie. 2..8 entries. */
    pools: SolswapBestPool[];
    user: SolswapBestUser;
    /** RPC-or-fixture account source for fetchPoolConfig and the reference quotes. */
    load: AccountLoader;
}
export interface SolswapBestQuote {
    /** Pool address for live entries; the external entry's label otherwise. */
    pool: string;
    /** Off-chain reference quote from the loader's state (external: quotedOut as given). */
    reference: bigint;
}
export interface SolswapBestOutput {
    source: string;
    bytecode: Uint8Array;
    /** Venue-resolved refs carry their pubkey — callers resolve only their own refs. */
    accountPlan: AccountPlan;
    /** Compile warnings plus the estimatePacket budget warnings (deduplicated). */
    warnings: string[];
    quotes: SolswapBestQuote[];
}
/**
 * Shared stable-curve Newton helpers, declared ONCE when any stable-kind pool
 * is present. Signatures and semantics are the adapter contract (the saber
 * and meteora-damm-v1-stable fragments call them): ann = amp * 2 computed
 * inside, at most 256 iterations, converged when successive estimates differ
 * by <= 1, floor division throughout — numerically identical to the adapters'
 * TS computeD/computeY mirrors. `break` does not exist on the v12 target, so
 * convergence rides in the loop condition: `diff` starts at the sentinel 2
 * (> 1, guaranteeing the first iteration) and each pass recomputes it, exactly
 * reproducing the mirrors' iterate-then-break sequence. Math.mulDiv (512-bit
 * intermediate) carries the d^3-scale Newton products; the remaining plain
 * products stay far below the 256-bit wrap for the documented per-venue
 * bounds (u64 reserves, D of multiplier-upscaled stable pairs < 2^100).
 */
export declare const SOLSWAP_STABLE_HELPERS: string;
/**
 * Multi-venue best-quote solswap: quote every candidate pool in-VM through
 * its venue adapter (or as a baked external constant), pick the strictly
 * best, enforce minOut before the single winner CPI, and verify the realized
 * outAta delta after it (revert payload "out"). Returns the realized delta,
 * not the predicted quote. Async and read-only against `load` — nothing is
 * sent; callers resolve the plan and send via `@eco-incorp/sauce-sdk`'s /svm
 * module.
 */
export declare function solswapBest(config: SolswapBestConfig): Promise<SolswapBestOutput>;
//# sourceMappingURL=index.d.ts.map