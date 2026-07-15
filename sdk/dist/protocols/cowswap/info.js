import { deployments } from "./addresses.js";
export const protocolInfo = {
    name: "CoW Swap",
    slug: "cowswap",
    description: "MEV-protected DEX aggregator using batch auctions and Coincidence of Wants (CoW) to find optimal prices while protecting users from frontrunning.",
    website: "https://cow.fi",
    github: "https://github.com/cowprotocol",
    npm: "@cowprotocol/cow-sdk",
    category: "aggregator",
    chains: deployments,
    audited: true,
};
//# sourceMappingURL=info.js.map