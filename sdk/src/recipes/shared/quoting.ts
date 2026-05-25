/**
 * Swap quoting via SauceRouter.quote() simulation.
 *
 * Uses viem's simulateContract to call the quote function,
 * which internally performs a swap simulation and returns the result.
 */

import type { PublicClient, Hex } from "viem";
import type { PoolInfo, QuoteResult } from "./types.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;

/** Minimal ABI for SauceRouter.quote() */
const sauceRouterQuoteAbi = [
  {
    name: "quote",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "poolType", type: "uint8" },
          { name: "pool", type: "address" },
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "stateView", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountSpecified", type: "int256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceAfter", type: "uint160" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

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
      abi: sauceRouterQuoteAbi,
      functionName: "quote",
      args: [quoteParams],
    });

    const r = result as unknown as { amountIn: bigint; amountOut: bigint; sqrtPriceAfter: bigint; gasEstimate: bigint };
    return {
      amountIn: r.amountIn,
      amountOut: r.amountOut,
      sqrtPriceAfter: r.sqrtPriceAfter,
      gasEstimate: r.gasEstimate,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message?.slice(0, 120) : String(e);
    console.warn(`  quote failed for pool ${pool.address} (fee=${pool.fee}): ${msg}`);
    return {
      amountIn: 0n,
      amountOut: 0n,
      sqrtPriceAfter: pool.sqrtPriceX96,
      gasEstimate: 0n,
    };
  }
}
