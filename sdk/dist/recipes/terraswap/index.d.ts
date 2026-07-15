/**
 * TerraSwap recipe — cross-chain parallel swap orchestrator.
 *
 * Executes an iterative series of swaps across multiple chains with a single
 * global price limit. Each series refines execution quality:
 *
 *   Series 1: pre-computed splits + global price limit → parallel TXs
 *   Series 2: depth-weighted re-split from series 1 + new price limit → parallel TXs
 *   Series 3: final sweep with no price limit (if leftovers remain) → parallel TXs
 */
import { type Hex } from "viem";
import type { TerraSwapConfig } from "../shared/types.js";
export interface ChainSeriesResult {
    chainName: string;
    txHash: Hex;
    gasUsed: bigint;
    leftover: bigint;
    received: bigint;
}
export interface TerraSwapOutput {
    series: {
        seriesNumber: number;
        priceLimit: bigint;
        chainResults: ChainSeriesResult[];
    }[];
    totalReceived: bigint;
    totalGas: bigint;
}
export declare function terraSwap(config: TerraSwapConfig, privateKey: Hex): Promise<TerraSwapOutput>;
//# sourceMappingURL=index.d.ts.map