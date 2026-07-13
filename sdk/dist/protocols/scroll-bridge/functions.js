export const depositETH = `
import { ScrollL1GatewayRouterABI as IL1GatewayRouter } from "./abis";

function main(gatewayRouterAddress: Address, amount: Uint256, gasLimit: Uint256): Uint256 {
  const router = IL1GatewayRouter.at(gatewayRouterAddress);
  return router.depositETH(amount, gasLimit);
}
`;
export const depositERC20 = `
import { ScrollL1GatewayRouterABI as IL1GatewayRouter } from "./abis";

function main(gatewayRouterAddress: Address, token: Address, amount: Uint256, gasLimit: Uint256): Uint256 {
  const router = IL1GatewayRouter.at(gatewayRouterAddress);
  return router.depositERC20(token, amount, gasLimit);
}
`;
//# sourceMappingURL=functions.js.map