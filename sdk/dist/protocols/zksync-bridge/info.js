import { deployments } from "./addresses.js";
export const protocolInfo = {
    name: "zkSync Native Bridge",
    slug: "zksync-bridge",
    description: "Official zkSync Era bridge via DiamondProxy. Deposits ETH and ERC-20 tokens from Ethereum to zkSync with ZK proof-based finality.",
    website: "https://bridge.zksync.io",
    github: "https://github.com/matter-labs/era-contracts",
    category: "bridge",
    chains: deployments,
    audited: true,
};
//# sourceMappingURL=info.js.map