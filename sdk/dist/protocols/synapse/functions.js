export const bridge = `
import { SynapseBridgeABI as ISynapseBridge } from "./abis";

function main(bridgeAddress: Address, recipient: Address, chainId: Uint256, token: Address, amount: Uint256): Uint256 {
  const bridge = ISynapseBridge.at(bridgeAddress);
  return bridge.deposit(recipient, chainId, token, amount);
}
`;
//# sourceMappingURL=functions.js.map