export const createTask = `
import { GelatoAutomateABI as IAutomate } from "./abis";

function main(automateAddress: Address, execAddress: Address, execData: Bytes, moduleData: Bytes, feeToken: Address): Uint256 {
  const automate = IAutomate.at(automateAddress);
  return automate.createTask(execAddress, execData, moduleData, feeToken);
}
`;
export const cancelTask = `
import { GelatoAutomateABI as IAutomate } from "./abis";

function main(automateAddress: Address, taskId: Bytes32): Uint256 {
  const automate = IAutomate.at(automateAddress);
  return automate.cancelTask(taskId);
}
`;
//# sourceMappingURL=functions.js.map