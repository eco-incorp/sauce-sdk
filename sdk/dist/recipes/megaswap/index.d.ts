/**
 * MegaSwap recipe entry point.
 *
 * Orchestrates off-chain preparation (pool discovery, quoting, slippage calculation)
 * and on-chain execution (SauceScript compilation + cook()).
 */
import { type Hex } from "viem";
import type { MegaSwapConfig, MegaSwapResult } from "../shared/types.js";
export interface MegaSwapOutput {
    /** Compiled bytecodes ready for cook() */
    bytecodes: Hex[];
    /** Prepared pool data */
    prepared: MegaSwapResult;
    /** Generated SauceScript source (for debugging) */
    source: string;
}
/**
 * Prepare and compile a MegaSwap.
 *
 * @param config - Swap configuration (tokenIn, tokenOut, amountIn)
 * @param rpcUrl - RPC URL for the chain
 * @param sauceRouterAddress - Deployed SauceRouter address
 * @param caller - Address that will call cook() (for transferFrom)
 */
export declare function megaSwap(config: MegaSwapConfig, rpcUrl: string, sauceRouterAddress: Hex, caller: Hex): Promise<MegaSwapOutput>;
//# sourceMappingURL=index.d.ts.map