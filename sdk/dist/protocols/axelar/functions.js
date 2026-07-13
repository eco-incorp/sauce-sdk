export const sendToken = `
import { AxelarGatewayABI as IGateway } from "./abis";

function main(gatewayAddress: Address, destinationChain: Bytes, destinationAddress: Bytes, symbol: Bytes, amount: Uint256): Uint256 {
  const gateway = IGateway.at(gatewayAddress);
  return gateway.sendToken(destinationChain, destinationAddress, symbol, amount);
}
`;
//# sourceMappingURL=functions.js.map