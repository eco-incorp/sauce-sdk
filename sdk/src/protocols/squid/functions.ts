export const bridge = `
import { SquidRouterABI as ISquidRouter } from "./abis";

function main(routerAddress: Address, token: Address, amount: Uint256, bridgedTokenSymbol: Bytes, destinationChain: Bytes, destinationAddress: Bytes): Uint256 {
  const router = ISquidRouter.at(routerAddress);
  return router.callBridge(token, amount, bridgedTokenSymbol, destinationChain, destinationAddress, 0x00);
}
`;
