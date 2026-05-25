/**
 * Shared TypeScript types for swap recipes.
 */

import type { Hex } from "viem";
import type { SwapPoolType } from "./constants.js";

// -- Pool discovery --

export interface PoolInfo {
  address: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  fee: number;
  poolType: SwapPoolType;
  sqrtPriceX96: bigint;
  liquidity: bigint;
}

// -- Quoting --

export interface QuoteResult {
  amountIn: bigint;
  amountOut: bigint;
  sqrtPriceAfter: bigint;
  gasEstimate: bigint;
}

// -- MegaSwap --

export interface MegaSwapConfig {
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint;
}

export interface PreparedPool {
  pool: PoolInfo;
  quote: QuoteResult;
  delta: bigint;
  feeAdjustedLimit: bigint;
}

export interface MegaSwapResult {
  pools: PreparedPool[];
  stepSize: bigint;
  initialPriceLimit: bigint;
  zeroForOne: boolean;
  expectedOutput: bigint;
}

// -- AlphaSwap --

export interface AlphaSwapConfig {
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint;
}

/** A multi-hop route discovered off-chain (best pool per leg). */
export interface DiscoveredMultiHopRoute {
  intermediateToken: Hex;
  hop1Pool: PoolInfo;
  hop2Pool: PoolInfo;
}

/**
 * Off-chain preparation result -- just discovered pools, no quotes.
 * All runtime decisions (liquidity reading, splitting) happen on-chain.
 */
export interface AlphaSwapPrepared {
  directPools: PoolInfo[];
  multiHopRoutes: DiscoveredMultiHopRoute[];
}
