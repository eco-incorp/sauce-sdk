export const depositETH = `
import { ZkSyncDiamondProxyABI as IDiamondProxy } from "./abis";

function main(diamondProxyAddress: Address, recipient: Address, l2GasLimit: Uint256): Uint256 {
  const proxy = IDiamondProxy.at(diamondProxyAddress);
  return proxy.requestL2Transaction(recipient, msg.value, 0x00, l2GasLimit, 800, [], msg.sender);
}
`;
