import { deployments } from "./addresses.js";
export const protocolInfo = {
    name: "Linea Native Bridge",
    slug: "linea-bridge",
    description: "Official Linea zkEVM bridge via L1MessageService. Deposits ETH and ERC-20 tokens from Ethereum to Linea with ZK proof-based finality.",
    website: "https://bridge.linea.build",
    github: "https://github.com/Consensys/linea-contracts",
    category: "bridge",
    chains: deployments,
    audited: true,
};
//# sourceMappingURL=info.js.map