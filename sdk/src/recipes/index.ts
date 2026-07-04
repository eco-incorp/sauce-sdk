// Recipe library: off-chain prepare + compile to Sauce bytecode for one cook().
// The canonical, fork-tested recipe tree (the dev-tools harness/CLI runs against
// these). Each recipe exports an orchestrator (prepare → compile → bytecodes) and
// its prepare step; `shared/` holds pool discovery, quoting, constants, and types.

export { alphaSwap } from "./alphaswap/index.js";
export type { AlphaSwapOutput } from "./alphaswap/index.js";
export { prepareAlphaSwap } from "./alphaswap/prepare.js";

export { megaSwap } from "./megaswap/index.js";
export type { MegaSwapOutput } from "./megaswap/index.js";
export { prepareMegaSwap } from "./megaswap/prepare.js";

export { gigaSwap } from "./gigaswap/index.js";
export type { GigaSwapOutput } from "./gigaswap/index.js";
export { prepareGigaSwap } from "./gigaswap/prepare.js";

export { ecoSwap, quoteEcoSwap, OZ_ERC20_SLOTS } from "./ecoswap/index.js";
export type { EcoSwapOutput, QuoteEcoSwapResult, Erc20Slots } from "./ecoswap/index.js";
export { prepareEcoSwap } from "./ecoswap/prepare.js";
export type { EcoSwapPrepareOpts } from "./ecoswap/prepare.js";

export { terraSwap } from "./terraswap/index.js";
export type { TerraSwapOutput, ChainSeriesResult } from "./terraswap/index.js";
export { prepareTerraSwap, prepareNextSeries } from "./terraswap/prepare.js";

export { solswap, solswapQuote } from "./solswap/index.js";
export type { SolswapConfig, SolswapPool, SolswapOutput } from "./solswap/index.js";

export { discoverPools } from "./shared/pool-discovery.js";
export { quotePool } from "./shared/quoting.js";
export * from "./shared/constants.js";
export * from "./shared/types.js";
