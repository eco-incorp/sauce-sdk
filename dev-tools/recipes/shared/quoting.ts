/**
 * Swap quoting via SauceRouter.quote() simulation.
 *
 * Uses viem's simulateContract to call the quote function,
 * which internally performs a swap simulation and returns the result.
 */

import type { PublicClient, Hex } from "viem";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { PoolInfo, QuoteResult } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load ISauceRouter ABI from local artifacts
const sauceRouterArtifact = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "artifacts", "ISauceRouter.json"),
    "utf-8",
  ),
);
export const sauceRouterAbi = sauceRouterArtifact.abi;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;

/**
 * Quote a swap on a single pool via SauceRouter.quote().
 *
 * @param pool - Pool to quote
 * @param amountIn - Amount of tokenIn to swap (positive = exact input)
 * @param sqrtPriceLimitX96 - Price limit for the swap (0 = no limit)
 * @param sauceRouterAddress - Deployed SauceRouter address
 * @param client - viem PublicClient
 */
export async function quotePool(
  pool: PoolInfo,
  amountIn: bigint,
  sqrtPriceLimitX96: bigint,
  sauceRouterAddress: Hex,
  client: PublicClient,
): Promise<QuoteResult> {
  // amountSpecified is negative for exact-input swaps in Uniswap V3 convention
  const amountSpecified = -amountIn;

  const quoteParams = {
    poolType: pool.poolType,
    pool: pool.address,
    poolKey: {
      currency0: ZERO_ADDRESS,
      currency1: ZERO_ADDRESS,
      fee: 0,
      tickSpacing: 0,
      hooks: ZERO_ADDRESS,
    },
    stateView: ZERO_ADDRESS,
    tokenIn: pool.tokenIn,
    tokenOut: pool.tokenOut,
    amountSpecified,
    sqrtPriceLimitX96,
  };

  try {
    const { result } = await client.simulateContract({
      address: sauceRouterAddress,
      abi: sauceRouterAbi,
      functionName: "quote",
      args: [quoteParams],
    });

    const r = result as { amountIn: bigint; amountOut: bigint; sqrtPriceAfter: bigint; gasEstimate: bigint };
    return {
      amountIn: r.amountIn,
      amountOut: r.amountOut,
      sqrtPriceAfter: r.sqrtPriceAfter,
      gasEstimate: r.gasEstimate,
    };
  } catch (e: any) {
    // Pool may not support the swap or may have insufficient liquidity
    console.warn(`  quote failed for pool ${pool.address} (fee=${pool.fee}): ${e.message?.slice(0, 120)}`);
    return {
      amountIn: 0n,
      amountOut: 0n,
      sqrtPriceAfter: pool.sqrtPriceX96,
      gasEstimate: 0n,
    };
  }
}
