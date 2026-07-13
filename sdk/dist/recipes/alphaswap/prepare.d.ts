/**
 * AlphaSwap off-chain preparation.
 *
 * Only discovers pools — all runtime decisions (liquidity measurement,
 * amount splitting) happen on-chain in the generated SauceScript.
 *
 * Off-chain:  pool discovery via factory multicalls
 * On-chain:   read liquidity, split by depth, execute swaps
 */
import type { PublicClient } from "viem";
import type { AlphaSwapConfig, AlphaSwapPrepared } from "../shared/types.js";
/**
 * Discover pools for an AlphaSwap. No quoting — all intelligence is on-chain.
 */
export declare function prepareAlphaSwap(config: AlphaSwapConfig, client: PublicClient): Promise<AlphaSwapPrepared>;
//# sourceMappingURL=prepare.d.ts.map