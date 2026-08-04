import type { Address } from '@solana/kit';
import type { AccountLoader, PoolConfig } from '../types.js';
declare const SLUG = "pancakeswap-clmm";
/** PancakeSwap's Solana CLMM program (a Raydium-CLMM-shaped Anchor fork). */
export declare const PANCAKESWAP_CLMM_PROGRAM_ID: Address<"HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq">;
export declare const POOL_ACCOUNT_SIZE = 1544;
export declare const AMM_CONFIG_ACCOUNT_SIZE = 117;
export declare const TICK_ARRAY_ACCOUNT_SIZE = 10240;
export declare const TICK_ARRAY_SIZE = 60;
export declare const OFF_AMM_CONFIG = 9;
export declare const OFF_TOKEN_MINT_0 = 73;
export declare const OFF_TOKEN_MINT_1 = 105;
export declare const OFF_TOKEN_VAULT_0 = 137;
export declare const OFF_TOKEN_VAULT_1 = 169;
export declare const OFF_OBSERVATION_KEY = 201;
export declare const OFF_TICK_SPACING = 235;
export declare const OFF_LIQUIDITY = 237;
export declare const OFF_SQRT_PRICE = 253;
export declare const OFF_TICK_CURRENT = 269;
export declare const OFF_STATUS = 389;
export declare const OFF_FEE_ON = 390;
export declare const OFF_OPEN_TIME = 1080;
export declare const OFF_DYNAMIC_FEE_INFO = 1096;
export declare const DYNAMIC_FEE_INFO_LEN = 80;
/** AmmConfig: trade_fee_rate u32 @47 (hundredths of a bip, denominator 1e6). */
export declare const OFF_CFG_TRADE_FEE_RATE = 47;
export declare const OFF_TA_POOL = 8;
export declare const OFF_TA_START = 40;
export declare const OFF_TA_TICKS = 44;
export declare const TICK_LEN = 168;
export declare const OFF_TICK_LIQ_NET = 4;
export declare const OFF_TICK_LIQ_GROSS = 20;
export declare const OFF_TICK_ORDERS_AMOUNT = 124;
export declare const OFF_TICK_PART_FILLED_ORDERS = 132;
/**
 * Shipped initialized-tick boundaries per direction (same walk-step budget as
 * raydium-clmm — an independent constant, not imported, so a future SDK
 * change to raydium-clmm's own bound can never silently reshape this venue's
 * fragment; kept numerically equal by design).
 */
export declare const PANCAKESWAP_CLMM_MAX_BOUNDARIES = 4;
export interface PancakeswapClmmBoundary {
    arrayIndex: number;
    offset: number;
    tick: number;
    sqrtPrice: bigint;
}
export interface PancakeswapClmmWindow {
    tickArrays: [Address, Address, Address];
    startTicks: [number, number, number];
    boundaries: PancakeswapClmmBoundary[];
    edge: {
        tick: number;
        sqrtPrice: bigint;
    } | null;
    readable: number;
}
export interface PancakeswapClmmPoolConfig extends PoolConfig {
    venue: typeof SLUG;
    direction: '0to1' | '1to0';
    ammConfig: Address;
    tokenMint0: Address;
    tokenMint1: Address;
    tokenVault0: Address;
    tokenVault1: Address;
    observation: Address;
    bitmapExtension: Address;
    tickSpacing: number;
    tradeFeeRate: number;
    liquidity: bigint;
    sqrtPrice: bigint;
    tickCurrentIndex: number;
    windows: {
        '0to1': PancakeswapClmmWindow;
        '1to0': PancakeswapClmmWindow;
    };
}
/**
 * Fetch + gate one PancakeSwap CLMM pool (see the header for the gate list)
 * and freeze both directions' boundary windows. Read-only against the loader.
 */
export declare function fetchPancakeswapClmmConfig(load: AccountLoader, pool: Address): Promise<PancakeswapClmmPoolConfig>;
/** Family facade for the recipe orchestrator (ladder-only — no v1 adapter). */
export declare const pancakeswapClmm: {
    slug: string;
    programId: Address<"HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq">;
    tokenProgram: Address<"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">;
    token2022Program: Address<"TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb">;
    memoProgram: Address<"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr">;
    fetchPoolConfig: typeof fetchPancakeswapClmmConfig;
};
export {};
//# sourceMappingURL=index.d.ts.map