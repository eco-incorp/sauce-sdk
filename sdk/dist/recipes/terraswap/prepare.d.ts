/**
 * TerraSwap off-chain preparation.
 *
 * Per-chain: discover pools, separate by price-limit support, quote, split.
 * Cross-chain: derive a single global price limit from deepest V3 pool.
 *
 * Price-limited pools (V3/V4): get full remaining balance + globalPriceLimit.
 *   The price limit naturally caps fill — deeper pools absorb more.
 *   No pre-computed split needed.
 *
 * No-limit pools (V2/Solidly): get pre-computed depth-proportional splits.
 *   Depth measured via full-amount quote simulation.
 */
import type { TerraSwapConfig, TerraSwapPrepared, TerraSwapChainPrepared } from "../shared/types.js";
export declare function prepareTerraSwap(config: TerraSwapConfig): Promise<TerraSwapPrepared>;
export declare function prepareNextSeries(previousChains: TerraSwapChainPrepared[], leftovers: Map<string, bigint>): Promise<TerraSwapPrepared>;
//# sourceMappingURL=prepare.d.ts.map