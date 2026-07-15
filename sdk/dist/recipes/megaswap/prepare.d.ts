/**
 * MegaSwap off-chain preparation.
 *
 * 1. Discover pools for the token pair across protocols and fee tiers
 * 2. Quote each pool with max slippage price limit
 * 3. Calculate adaptive slippage: stepSize = minDelta / 2
 * 4. Filter shallow pools (delta > 10x minDelta)
 * 5. Return prepared pool data for codegen
 */
import type { PublicClient, Hex } from "viem";
import type { MegaSwapConfig, MegaSwapResult } from "../shared/types.js";
/**
 * Prepare a MegaSwap: discover pools, quote, calculate slippage parameters.
 */
export declare function prepareMegaSwap(config: MegaSwapConfig, client: PublicClient, sauceRouterAddress: Hex): Promise<MegaSwapResult>;
//# sourceMappingURL=prepare.d.ts.map