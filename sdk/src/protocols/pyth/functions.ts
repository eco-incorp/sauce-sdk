export const getPrice = `
import { PythOracleABI as IPythOracle } from "./abis";

function main(oracleAddress: Address, priceId: Bytes32): Uint256 {
  const oracle = IPythOracle.at(oracleAddress);
  return oracle.getPrice(priceId);
}
`;
