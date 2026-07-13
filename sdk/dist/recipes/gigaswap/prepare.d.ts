/**
 * GigaSwap off-chain preparation.
 *
 * Discovers ALL liquidity sources (V3 + V2), measures depth via quoting,
 * and separates pools into two execution categories:
 *
 * Price-limited pools (V3/V4): No pre-split needed. On-chain, each gets
 *   the full remaining balance + globalPriceLimit. The limit naturally
 *   caps fill — deeper pools absorb more. Positive slippage absorbed.
 *
 * No-limit pools (V2/Solidly): Pre-computed depth-proportional splits
 *   based on full-amount quote simulation.
 *
 * Global price limit derived from V3 pool with lowest delta (tightest).
 *
 * On-chain:
 *   Series 1: V3 pools sequential (full balance + limit), then V2 (splits)
 *   Series 2: Sweep leftovers with inverse-delta depth weighting
 */
import type { PublicClient, Hex } from "viem";
import { type ChainPoolConfig } from "../shared/constants.js";
import type { GigaSwapConfig, GigaSwapPrepared } from "../shared/types.js";
/**
 * Discover pools, measure depth via quoting, separate by price-limit support,
 * compute optimal splits for no-limit pools, and derive global price limit.
 */
export declare function prepareGigaSwap(config: GigaSwapConfig, client: PublicClient, sauceRouterAddress: Hex, poolConfig?: ChainPoolConfig): Promise<GigaSwapPrepared>;
//# sourceMappingURL=prepare.d.ts.map