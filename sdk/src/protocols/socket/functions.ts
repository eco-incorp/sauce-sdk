export const bridge = `
import { SocketGatewayABI as ISocketGateway } from "./abis";

function main(gatewayAddress: Address, routeId: Uint256, bridgeData: Bytes): Uint256 {
  const gateway = ISocketGateway.at(gatewayAddress);
  return gateway.bridge(routeId, bridgeData);
}
`;
