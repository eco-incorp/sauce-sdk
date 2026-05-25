export const depositETH = `
import { PolygonRootChainManagerABI as IRootChainManager } from "./abis";

function main(rootChainManagerAddress: Address, recipient: Address): Uint256 {
  const manager = IRootChainManager.at(rootChainManagerAddress);
  return manager.depositEtherFor(recipient);
}
`;

export const depositERC20 = `
import { PolygonRootChainManagerABI as IRootChainManager } from "./abis";

function main(rootChainManagerAddress: Address, recipient: Address, rootToken: Address, depositData: Bytes): Uint256 {
  const manager = IRootChainManager.at(rootChainManagerAddress);
  return manager.depositFor(recipient, rootToken, depositData);
}
`;
