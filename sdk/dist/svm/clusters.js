import { ENGINE_CHAIN_IDS } from './engine.js';
export const SOLANA_CLUSTERS = {
    'mainnet-beta': {
        cluster: 'mainnet-beta',
        engineChainId: ENGINE_CHAIN_IDS.mainnet,
        rpcUrl: 'https://api.mainnet-beta.solana.com',
    },
    devnet: {
        cluster: 'devnet',
        engineChainId: ENGINE_CHAIN_IDS.devnet,
        rpcUrl: 'https://api.devnet.solana.com',
    },
    localnet: {
        cluster: 'localnet',
        engineChainId: ENGINE_CHAIN_IDS.devnet,
    },
};
//# sourceMappingURL=clusters.js.map