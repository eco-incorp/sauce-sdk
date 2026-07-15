import type { Address } from '@solana/kit';
/** Solana cluster definition (parallel to the EVM `Chain` registry in chains/). */
export interface SolanaCluster {
    cluster: 'mainnet-beta' | 'devnet' | 'localnet';
    /** Synthetic chain id reported by the engine's CHAIN_ID opcode on this cluster. */
    engineChainId: bigint;
    rpcUrl?: string;
    /** No engine deployment exists yet — callers supply the program id, matching the repo convention. */
    engineProgramId?: Address;
}
export declare const SOLANA_CLUSTERS: Record<SolanaCluster['cluster'], SolanaCluster>;
//# sourceMappingURL=clusters.d.ts.map