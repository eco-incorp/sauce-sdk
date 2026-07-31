import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "perps-jlp";
export declare const PERPS_JLP_PROGRAM_ID: Address<"PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu">;
/** The single production JLP pool (name "Pool", 6 custodies as of 2026-07-31). */
export declare const JLP_POOL_ADDRESS: Address<"5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq">;
/** sha256('global:swap2')[0..8]. */
export declare const SWAP2_DISCRIMINATOR: number[];
/** The full occupied Custody struct length (confirmed all-zero padding past this on 6 real mainnet custodies). */
export declare const CUSTODY_ACCOUNT_SIZE = 1117;
export declare const DOVES_PRICE_OFFSET = 73;
export declare const DOVES_EXPO_OFFSET = 81;
export declare const DOVES_TIMESTAMP_OFFSET = 82;
export declare const DOVES_FEED_SIZE = 91;
/**
 * A "the feed is dead, not just latent" sanity ceiling (seconds) — the
 * real on-chain custody enforces its OWN much tighter `oracle.maxPriceAgeSec`
 * (observed 5s on the real mainnet SOL/USDC custodies 2026-07-31) at swap2
 * execution time; that live, on-chain check is the authoritative freshness
 * backstop and reverts the whole cook for this slot if violated, exactly
 * like every other venue's runtime-failure self-drop. Trying to replicate a
 * 5s bound OFF-CHAIN at prepare time would self-drop this venue almost
 * unconditionally (any nonzero prepare-to-cook latency exceeds it) — a
 * "NO PREMATURE GATING" violation, not a safety measure. This constant only
 * catches a feed that has stopped updating entirely (an abandoned/broken
 * Doves keeper), not ordinary staleness.
 */
export declare const DOVES_MAX_AGE_SEC = 3600n;
/**
 * Baked scale for `floor(c1 * c2 * 10^(e1+e2-te))` — the shared shape of
 * every `checkedDecimalMul(c1, e1, c2, e2, te)` call this venue's math uses
 * (both the exchange-rate conversion and every USD conversion). Because
 * decimals/exponents are all baked (governance/feed constants), the SIGN of
 * `targetPower` is known off-chain, so the fragment never needs a runtime
 * branch: exactly one of `scaleUp`/`scaleDown` is ever != 1, so
 * `floor(c1 * c2 * scaleUp / scaleDown)` reproduces the reference's two-way
 * branch with ONE unconditional expression.
 */
export declare function bakedDecimalScale(e1: number, e2: number, targetExponent: number): {
    scaleUp: bigint;
    scaleDown: bigint;
};
/** `getSwapPrice`'s ORACLE_PRICE_SCALE / ORACLE_EXPONENT_SCALE constants. */
declare const ORACLE_PRICE_SCALE = 1000000000n;
export interface PerpsJlpPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    pool: Address;
    mintIn: Address;
    mintOut: Address;
    custodyIn: Address;
    custodyOut: Address;
    tokenAccountIn: Address;
    tokenAccountOut: Address;
    dovesOracleIn: Address;
    dovesOracleOut: Address;
    pythAccountIn: Address;
    pythAccountOut: Address;
    tokenProgram: Address;
    /** Program-wide constant PDAs, pre-derived at fetch time (buildSwapV2 is synchronous). */
    transferAuthority: Address;
    perpetuals: Address;
    eventAuthority: Address;
    decimalsIn: number;
    decimalsOut: number;
    /** Baked exchange-rate scale: amountOutBeforeFees = floor(amountIn * swapPriceCoeff * fxScaleUp / fxScaleDown). */
    fxScaleUp: bigint;
    fxScaleDown: bigint;
    /** Baked per-side USD-conversion scale (getAssetAmountUsd at this side's own decimals/expo). */
    usdScaleUpIn: bigint;
    usdScaleDownIn: bigint;
    usdScaleUpOut: bigint;
    usdScaleDownOut: bigint;
    isStableIn: boolean;
    isStableOut: boolean;
    targetRatioBpsIn: bigint;
    targetRatioBpsOut: bigint;
    /** The (baseFeeBps, taxFeeBps, multiplier) triple — stableSwap* iff BOTH custodies are stable. */
    baseFeeBps: bigint;
    taxFeeBps: bigint;
    multiplier: bigint;
    /** max(externalSwapFeeMultiplierBpsIn, externalSwapFeeMultiplierBpsOut, 10_000) — conservative bake, see module doc. */
    externalMultiplierBps: bigint;
    /** Dynamic byte offset of Pool.aumUsd (shifts if Jupiter ever adds/removes a custody or renames the pool). */
    poolAumUsdOffset: bigint;
    /** Dynamic byte offset of Pool.fees (== poolAumUsdOffset + 56, the Limit struct's fixed 40B + aumUsd's 16B). */
    poolFeesOffset: bigint;
}
declare function perpsJlpConfig(cfg: PoolConfig): PerpsJlpPoolConfig;
/** `findProgramAddress(["custody", pool, mint], PERPS_JLP_PROGRAM_ID)` — verified against real SOL custody. */
export declare function custodyPda(pool: Address, mint: Address): Promise<Address>;
/** `findProgramAddress(["transfer_authority"], PERPS_JLP_PROGRAM_ID)` — cached (program-wide constant). */
export declare function transferAuthorityPda(): Promise<Address>;
/** `findProgramAddress(["perpetuals"], PERPS_JLP_PROGRAM_ID)` — cached (program-wide constant). */
export declare function perpetualsPda(): Promise<Address>;
/** `findProgramAddress(["__event_authority"], PERPS_JLP_PROGRAM_ID)` — matches the published constant. */
export declare function eventAuthorityPda(): Promise<Address>;
/**
 * Fetch + gate one directed (mintIn -> mintOut) JLP swap. Unlike every other
 * family, this takes the DIRECTED PAIR (not just a pool-hint address) — see
 * the module doc for why. `poolHint` is accepted for API symmetry with the
 * other families' `fetch(load, pool)` shape (and sanity-asserted equal to
 * the freshly-derived custodyIn PDA) but is not otherwise used: the pair
 * fully determines both custody PDAs.
 */
/**
 * `custodyIn` is the account to decode DIRECTLY (its `mint` field IS mintIn —
 * self-discovered, never taken on faith from a caller) — the address-source
 * derives it deterministically from `pair.inMint` (see ladder discovery
 * wiring), so this function never needs the input mint as a separate
 * argument. `mintOut` is the ONE piece of information genuinely external:
 * a basket has no single account embedding both sides, so SOMETHING must
 * name which of the OTHER custodies this trade targets. Both this function's
 * callers (the discovery resolver and the pre-codegen re-fetch) have it —
 * the former from the requested pair directly, the latter from the spec's
 * own `direction` string (this family stores `mintOut`'s base58 there, see
 * ecoswap/svm/index.ts's FAMILIES entry) — so `fetchPoolConfig` never needs
 * a signature wider than every other family's `(load, pool)` PLUS this one
 * extra, always-a-plain-string `direction` parameter already threads through
 * both call sites unchanged.
 */
export declare function fetchPerpsJlpConfig(load: AccountLoader, custodyIn: Address, mintOut: Address, now?: bigint): Promise<PerpsJlpPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only — not in the v1 registry; see quantum/solfi-v2). */
export declare const perpsJlp: {
    slug: string;
    programId: Address<"PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    fetchPoolConfig: typeof fetchPerpsJlpConfig;
};
export { perpsJlpConfig, ORACLE_PRICE_SCALE };
//# sourceMappingURL=index.d.ts.map