/**
 * Swap quoting via SauceRouter.quote() simulation.
 *
 * Uses viem's simulateContract to call the quote function,
 * which internally performs a swap simulation and returns the result.
 */
import type { PublicClient, Hex } from "viem";
import type { PoolInfo, QuoteResult } from "./types.js";
export declare const sauceRouterAbi: any;
/**
 * Quote a swap on a single pool via SauceRouter.quote().
 *
 * @param pool - Pool to quote
 * @param amountIn - Amount of tokenIn to swap (positive = exact input)
 * @param sqrtPriceLimitX96 - Price limit for the swap (0 = no limit)
 * @param sauceRouterAddress - Deployed SauceRouter address
 * @param client - viem PublicClient
 */
export declare function quotePool(pool: PoolInfo, amountIn: bigint, sqrtPriceLimitX96: bigint, sauceRouterAddress: Hex, client: PublicClient): Promise<QuoteResult>;
//# sourceMappingURL=quoting.d.ts.map