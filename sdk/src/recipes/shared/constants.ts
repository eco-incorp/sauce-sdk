/**
 * Base chain addresses and swap constants for recipe infrastructure.
 */

import type { Hex } from "viem";

// -- Tokens (Base chain) --

export const WETH = "0x4200000000000000000000000000000000000006" as Hex;
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Hex;
export const DAI = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" as Hex;
export const USDbC = "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA" as Hex;

/** Base tokens used for multi-hop routing */
export const BASE_TOKENS = [WETH, USDC, DAI, USDbC] as const;

// -- Factories --

export const UNISWAP_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as Hex;
export const PANCAKESWAP_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865" as Hex;

// -- V4 --

export const UNISWAP_V4_POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b" as Hex;
export const UNISWAP_V4_STATE_VIEW = "0xA3c0c9b65baD0189c5c041BF29d8f6DCF1c8e3e1" as Hex;

// -- Infrastructure --

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Hex;

// -- Fee tiers (V3) --

export const FEE_TIERS = [100, 500, 3000, 10000] as const;

// -- Pool types --
// Must match Solidity: enum SwapPoolType { UniV2=0, UniV3=1, UniV4=2 }
// UniV3 covers both Uniswap V3 and PancakeSwap V3 (same interface)

export enum SwapPoolType {
  UniV2 = 0,
  UniV3 = 1,
  UniV4 = 2,
}

// -- Uniswap V3 price boundaries --

/** Minimum sqrt price ratio (from UniswapV3 TickMath) */
export const MIN_SQRT_RATIO = 4295128739n;
/** Maximum sqrt price ratio (from UniswapV3 TickMath) */
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
