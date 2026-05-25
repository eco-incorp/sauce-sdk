/**
 * Shared TypeScript types for swap recipes.
 */

import type { Hex } from "viem";
import type { SwapPoolType, ChainPoolConfig } from "./constants";

// ── Pool discovery ───────────────────────────────────────────

export interface PoolInfo {
  address: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  fee: number;
  poolType: SwapPoolType;
  /** Whether this pool supports sqrtPriceLimitX96 (V3/V4 = true, V2 = false) */
  priceLimited: boolean;
  /** sqrtPriceX96 for V3/Algebra pools, synthetic sqrt(k) for V2 pools */
  sqrtPriceX96: bigint;
  /** Concentrated liquidity for V3, reserve-derived for V2 */
  liquidity: bigint;
  /** Human-readable source label (e.g. "Uniswap V3", "Aerodrome V2") */
  source: string;
}

// ── Quoting ──────────────────────────────────────────────────

export interface QuoteResult {
  amountIn: bigint;
  amountOut: bigint;
  sqrtPriceAfter: bigint;
  gasEstimate: bigint;
}

// ── MegaSwap ─────────────────────────────────────────────────

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

// ── AlphaSwap ────────────────────────────────────────────────

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
 * Off-chain preparation result — just discovered pools, no quotes.
 * All runtime decisions (liquidity reading, splitting) happen on-chain.
 */
export interface AlphaSwapPrepared {
  directPools: PoolInfo[];
  multiHopRoutes: DiscoveredMultiHopRoute[];
}

// ── GigaSwap ────────────────────────────────────────────────

export interface GigaSwapConfig {
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint;
}

export interface GigaSwapDirectPool {
  pool: PoolInfo;
  splitAmount: bigint;
}

export interface GigaSwapMultiHopRoute {
  route: DiscoveredMultiHopRoute;
  splitAmount: bigint;
}

/**
 * Off-chain preparation result — two pool categories:
 *
 * Price-limited pools (V3/V4): get full remaining balance + globalPriceLimit.
 *   The price limit naturally caps fill — deeper pools absorb more.
 *   No pre-computed split needed.
 *
 * No-limit pools (V2/Solidly): get pre-computed depth-proportional splits.
 *   Depth measured via full-amount quote simulation.
 *
 * Series 1: V3 pools sequential (full balance + limit), then V2 pools (splits)
 * Series 2: Sweep leftovers with inverse-delta depth weighting
 */
export interface GigaSwapPrepared {
  /** V3/V4 pools — no splitAmount needed, price limit does the work */
  priceLimitedPools: GigaSwapDirectPool[];
  /** V2 pools — depth-proportional pre-computed splits */
  noLimitPools: GigaSwapDirectPool[];
  /** Multi-hop routes (always use splits, mixed pool types) */
  multiHopRoutes: GigaSwapMultiHopRoute[];
  globalPriceLimit: bigint;
  zeroForOne: boolean;
}

// ── TerraSwap (cross-chain) ─────────────────────────────────

export interface TerraSwapChainConfig {
  name: string;
  rpcUrl: string;
  sauceRouterAddress: Hex;
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint;
  /** Chain-specific pool discovery config. Falls back to Base chain if omitted. */
  poolConfig?: ChainPoolConfig;
}

export interface TerraSwapConfig {
  chains: TerraSwapChainConfig[];
}

export interface TerraSwapChainPrepared {
  config: TerraSwapChainConfig;
  /** V3/V4 pools — full balance + price limit */
  priceLimitedPools: GigaSwapDirectPool[];
  /** V2 pools — depth-proportional splits */
  noLimitPools: GigaSwapDirectPool[];
  multiHopRoutes: GigaSwapMultiHopRoute[];
  zeroForOne: boolean;
}

/**
 * Cross-chain preparation result — per-chain splits and a single
 * global price limit that applies across all chains.
 *
 * Series 1: execute splits with globalPriceLimit on all chains in parallel
 * Series 2: depth-weighted re-split from series 1 + new price limit
 * Series 3: final sweep with no limit (if leftovers remain)
 */
export interface TerraSwapPrepared {
  chains: TerraSwapChainPrepared[];
  globalPriceLimit: bigint;
}
