/**
 * AlphaSwap recipe entry point.
 *
 * Off-chain:  discover pools via factory multicalls (fast, no quoting)
 * On-chain:   read liquidity, split by depth, execute swaps (SauceScript)
 */
import { type Hex } from "viem";
import type { AlphaSwapConfig, AlphaSwapPrepared } from "../shared/types.js";
export interface AlphaSwapOutput {
    /** Compiled bytecodes ready for cook() */
    bytecodes: Hex[];
    /** Discovered pool data (no quotes — decisions are on-chain) */
    prepared: AlphaSwapPrepared;
    /** Generated SauceScript source (for debugging) */
    source: string;
}
/**
 * Prepare and compile an AlphaSwap.
 *
 * @param config - Swap configuration (tokenIn, tokenOut, amountIn)
 * @param rpcUrl - RPC URL for pool discovery
 * @param sauceRouterAddress - Deployed SauceRouter address (unused; kept for API compat)
 * @param caller - Address that will call cook() (for transferFrom)
 */
export declare function alphaSwap(config: AlphaSwapConfig, rpcUrl: string, sauceRouterAddress: Hex, caller: Hex): Promise<AlphaSwapOutput>;
//# sourceMappingURL=index.d.ts.map