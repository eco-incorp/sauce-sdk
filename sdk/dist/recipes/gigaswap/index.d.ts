/**
 * GigaSwap recipe entry point.
 *
 * Off-chain:  quote-based depth measurement → proportional split → global price limit
 * On-chain:   series 1 (splits + price limit) → series 2 (leftover sweep)
 */
import { type Hex } from "viem";
import type { GigaSwapConfig, GigaSwapPrepared } from "../shared/types.js";
export interface GigaSwapOutput {
    /** Compiled bytecodes ready for cook() */
    bytecodes: Hex[];
    /** Prepared pool data with splits and price limit */
    prepared: GigaSwapPrepared;
    /** Generated SauceScript source (for debugging) */
    source: string;
}
/**
 * Prepare and compile a GigaSwap.
 *
 * @param config - Swap configuration (tokenIn, tokenOut, amountIn)
 * @param rpcUrl - RPC URL for the chain
 * @param sauceRouterAddress - Deployed SauceRouter address
 * @param caller - Address that will call cook() (for transferFrom)
 */
export declare function gigaSwap(config: GigaSwapConfig, rpcUrl: string, sauceRouterAddress: Hex, caller: Hex): Promise<GigaSwapOutput>;
//# sourceMappingURL=index.d.ts.map