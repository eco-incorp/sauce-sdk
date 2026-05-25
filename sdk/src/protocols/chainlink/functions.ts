export const getLatestPrice = `
import { AggregatorV3ABI as IAggregatorV3 } from "./abis";

function main(feedAddress: Address): Uint256 {
  const feed = IAggregatorV3.at(feedAddress);
  return feed.latestRoundData();
}
`;
