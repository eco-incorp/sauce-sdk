import type { Address } from '@solana/kit';
import type { AccountBytesMap, AccountLoader, PoolConfig, SwapUser, VenueAccount, VenueSwap } from '../types.js';
declare const SLUG = "meteora-dbc";
export declare const METEORA_DBC_PROGRAM_ID: Address<"dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN">;
/** Constant PDA ['pool_authority'] — owner-authority of both vaults (verified against the official SDK's hardcoded constant). */
export declare const METEORA_DBC_POOL_AUTHORITY: Address<"FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">;
/** Constant PDA ['__event_authority'] (Anchor `#[event_cpi]`). */
export declare const METEORA_DBC_EVENT_AUTHORITY: Address<"8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF">;
/** sha256('global:swap')[0..8]. */
export declare const METEORA_DBC_SWAP_DISCRIMINATOR: number[];
declare const CURVE_POINT_SIZE = 32;
export declare const METEORA_DBC_FEE_DENOMINATOR = 1000000000n;
export declare const METEORA_DBC_MAX_FEE_NUMERATOR = 990000000n;
declare const OFF_VOL_ACCUMULATOR = 40;
declare const OFF_SQRT_PRICE = 280;
declare const OFF_ACTIVATION_POINT = 296;
declare const OFF_CLIFF_FEE_NUMERATOR = 104;
declare const OFF_PERIOD_FREQUENCY = 112;
declare const OFF_REDUCTION_FACTOR = 120;
declare const OFF_NUMBER_OF_PERIOD = 128;
declare const OFF_DYN_INITIALIZED = 136;
declare const OFF_DYN_VARIABLE_FEE_CONTROL = 148;
declare const OFF_DYN_BIN_STEP = 152;
declare const OFF_COLLECT_FEE_MODE = 232;
declare const OFF_MIGRATION_SQRT_PRICE = 280;
declare const OFF_SQRT_START_PRICE = 392;
declare const OFF_CURVE = 408;
export interface MeteoraDbcCurvePoint {
    sqrtPrice: bigint;
    liquidity: bigint;
}
export interface MeteoraDbcPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    /**
     * Trade direction: 'quoteToBase' (default — buying the launched token with
     * the quote mint, e.g. wSOL) | 'baseToQuote' (selling). Matches pumpswap's
     * naming for the same base/quote bonding-curve role split.
     */
    direction: 'quoteToBase' | 'baseToQuote';
    config: Address;
    baseMint: Address;
    quoteMint: Address;
    baseVault: Address;
    quoteVault: Address;
    tokenBaseProgram: Address;
    tokenQuoteProgram: Address;
    /**
     * Index into config.curve[] of the ACTIVE segment at fetch time — the band
     * containing the pool's live sqrt_price. Baked at fetch time (immutable
     * for the life of this config); the ladder's live sqrt_price read decides
     * how much of THIS segment's capacity a trade actually uses.
     */
    segIdx: number;
    /** Number of non-zero curve points read at fetch time (>= segIdx + 1). */
    curveLength: number;
}
interface DecodedPool {
    config: Address;
    baseMint: Address;
    baseVault: Address;
    quoteVault: Address;
    sqrtPrice: bigint;
    baseReserve: bigint;
    quoteReserve: bigint;
    activationPoint: bigint;
    volatilityAccumulator: bigint;
    isMigrated: number;
}
interface DecodedConfig {
    quoteMint: Address;
    cliffFeeNumerator: bigint;
    periodFrequency: bigint;
    reductionFactor: bigint;
    numberOfPeriod: bigint;
    baseFeeMode: number;
    dynInitialized: number;
    variableFeeControl: bigint;
    binStep: bigint;
    collectFeeMode: number;
    activationType: number;
    tokenType: number;
    quoteTokenFlag: number;
    migrationQuoteThreshold: bigint;
    migrationSqrtPrice: bigint;
    sqrtStartPrice: bigint;
    curve: MeteoraDbcCurvePoint[];
}
declare function decodePool(pool: string, data: Uint8Array): DecodedPool;
declare function decodeConfig(configAddr: string, data: Uint8Array): DecodedConfig;
/** Smallest k with sqrtPrice <= curve[k].sqrtPrice — the segment the live price currently sits in. -1 when price is at/past the last point (curve complete). */
declare function activeSegment(curve: readonly MeteoraDbcCurvePoint[], sqrtPrice: bigint): number;
export declare const meteoraDbc: {
    slug: string;
    kind: "sqrt-price";
    programId: Address<"dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN">;
    /**
     * Off-chain gate + segment selection (named errors on every out-of-scope
     * variant — see the file header "GATED OUT" list).
     */
    fetchPoolConfig(load: AccountLoader, pool: Address): Promise<MeteoraDbcPoolConfig>;
    quoteAccounts(cfg: PoolConfig): VenueAccount[];
    /** v1 (amount-baked) quote fragment — the closed-form single-segment CP math (see ladder.ts for the parametric/live-read version this mirrors). */
    emitQuote(cfg: PoolConfig, i: number, amountIn: bigint): string;
    buildSwap(cfg: PoolConfig, user: SwapUser, amountIn: bigint): VenueSwap;
    referenceQuote(cfg: PoolConfig, state: AccountBytesMap, amountIn: bigint, now: bigint): bigint;
};
/** total_fee_numerator = min(base(period-decayed) + variable(volatility), cap). */
export declare function dbcFeeNumerator(cliffFeeNumerator: bigint, periodFrequency: bigint, activationPoint: bigint, numberOfPeriod: bigint, reductionFactor: bigint, dynInitialized: number, binStep: bigint, variableFeeControl: bigint, volatilityAccumulator: bigint, now: bigint): bigint;
export interface DbcSingleSegmentResult {
    output: bigint;
    saturated: boolean;
    feeNumerator: bigint;
}
/** The single-active-segment closed-form quote both directions share (see the file header). Amount-parametric, used by both emitQuote (amountIn baked) and the ladder (amountIn a live merge value). */
export declare function quoteSingleSegment(cfg: MeteoraDbcPoolConfig, p: DecodedPool, c: DecodedConfig, amountIn: bigint, now: bigint): DbcSingleSegmentResult;
/** Closed-form capacity (max productive amountIn) for the active segment, in the given direction — exported for the ladder's referenceCapacities and for tests. */
export declare function dbcCapacity(cfg: MeteoraDbcPoolConfig, p: DecodedPool, c: DecodedConfig, now: bigint): bigint;
/** Internal decode, re-exported for the ladder module (same package, no public API surface change). */
export { decodePool as __decodeMeteoraDbcPool, decodeConfig as __decodeMeteoraDbcConfig, activeSegment as __meteoraDbcActiveSegment };
export { OFF_SQRT_PRICE as METEORA_DBC_OFF_SQRT_PRICE, OFF_ACTIVATION_POINT as METEORA_DBC_OFF_ACTIVATION_POINT, OFF_VOL_ACCUMULATOR as METEORA_DBC_OFF_VOL_ACCUMULATOR, OFF_CLIFF_FEE_NUMERATOR as METEORA_DBC_OFF_CLIFF_FEE_NUMERATOR, OFF_PERIOD_FREQUENCY as METEORA_DBC_OFF_PERIOD_FREQUENCY, OFF_REDUCTION_FACTOR as METEORA_DBC_OFF_REDUCTION_FACTOR, OFF_NUMBER_OF_PERIOD as METEORA_DBC_OFF_NUMBER_OF_PERIOD, OFF_DYN_INITIALIZED as METEORA_DBC_OFF_DYN_INITIALIZED, OFF_DYN_VARIABLE_FEE_CONTROL as METEORA_DBC_OFF_DYN_VARIABLE_FEE_CONTROL, OFF_DYN_BIN_STEP as METEORA_DBC_OFF_DYN_BIN_STEP, OFF_COLLECT_FEE_MODE as METEORA_DBC_OFF_COLLECT_FEE_MODE, OFF_MIGRATION_SQRT_PRICE as METEORA_DBC_OFF_MIGRATION_SQRT_PRICE, OFF_SQRT_START_PRICE as METEORA_DBC_OFF_SQRT_START_PRICE, OFF_CURVE as METEORA_DBC_OFF_CURVE, CURVE_POINT_SIZE as METEORA_DBC_CURVE_POINT_SIZE, };
//# sourceMappingURL=index.d.ts.map