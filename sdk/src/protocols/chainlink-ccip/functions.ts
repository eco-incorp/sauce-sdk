export const sendMessage = `
import { CCIPRouterABI as ICCIPRouter } from "./abis";

function main(routerAddress: Address, destinationChainSelector: Uint256, receiver: Bytes, data: Bytes): Uint256 {
  const router = ICCIPRouter.at(routerAddress);
  return router.ccipSend(destinationChainSelector, {receiver: receiver, data: data, tokenAmounts: [], feeToken: 0x0000000000000000000000000000000000000000, extraArgs: 0x00});
}
`;
