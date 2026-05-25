import type { ChainDeployment } from "../../core/types.js";

export const deployments: ChainDeployment[] = [
  {
    chainId: 1,
    chainName: "Ethereum",
    addresses: {
      router: "0x888888888889758F76e7103c6CbF23ABbF58F946",
    },
  },
  {
    chainId: 42161,
    chainName: "Arbitrum",
    addresses: {
      router: "0x888888888889758F76e7103c6CbF23ABbF58F946",
    },
  },
];
