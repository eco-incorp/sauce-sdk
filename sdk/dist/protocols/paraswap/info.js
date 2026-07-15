import { deployments } from "./addresses.js";
export const protocolInfo = {
    name: "ParaSwap",
    slug: "paraswap",
    description: "Multi-chain DEX aggregator optimizing swap rates across decentralized exchanges. Supports limit orders and delta algorithm for MEV protection.",
    website: "https://paraswap.io",
    github: "https://github.com/paraswap",
    npm: "@paraswap/sdk",
    category: "aggregator",
    chains: deployments,
    audited: true,
};
//# sourceMappingURL=info.js.map