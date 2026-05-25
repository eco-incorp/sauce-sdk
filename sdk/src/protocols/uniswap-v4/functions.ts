export const swap = `
import { UniswapV4UniversalRouterABI as IUniversalRouter } from "./abis";

function main(routerAddress: Address, commands: Bytes, inputs: Bytes): Uint256 {
  const router = IUniversalRouter.at(routerAddress);
  return router.execute(commands, inputs, 99999999999);
}
`;

export const addLiquidity = `
import { UniswapV4PositionManagerABI as IPositionManager } from "./abis";

function main(positionManagerAddress: Address, unlockData: Bytes): Uint256 {
  const pm = IPositionManager.at(positionManagerAddress);
  return pm.modifyLiquidities(unlockData, 99999999999);
}
`;

export const removeLiquidity = `
import { UniswapV4PositionManagerABI as IPositionManager } from "./abis";

function main(positionManagerAddress: Address, unlockData: Bytes): Uint256 {
  const pm = IPositionManager.at(positionManagerAddress);
  return pm.modifyLiquidities(unlockData, 99999999999);
}
`;
