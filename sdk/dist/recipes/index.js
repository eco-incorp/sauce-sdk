// Recipe library: off-chain prepare + compile to Sauce bytecode for one cook().
// The canonical, fork-tested recipe tree (the dev-tools harness/CLI runs against
// these). Each recipe exports an orchestrator (prepare → compile → bytecodes) and
// its prepare step; `shared/` holds pool discovery, quoting, constants, and types.
export { alphaSwap } from "./alphaswap/index.js";
export { prepareAlphaSwap } from "./alphaswap/prepare.js";
export { megaSwap } from "./megaswap/index.js";
export { prepareMegaSwap } from "./megaswap/prepare.js";
export { gigaSwap } from "./gigaswap/index.js";
export { prepareGigaSwap } from "./gigaswap/prepare.js";
export { ecoSwap, quoteEcoSwap, OZ_ERC20_SLOTS } from "./ecoswap/index.js";
export { prepareEcoSwap } from "./ecoswap/prepare.js";
export { ecoSwapSvm, quoteEcoSwapSvm, stageEcoSwapSvm, executeEcoSwapSvm, routeEcoSwapSvm, quoteRouteEcoSwapSvm, stageRouteEcoSwapSvm, executeRouteEcoSwapSvm, buildRouteInterAtaPrepend, generateEcoSwapSvmRoute, ecoSwapSvmRouteShapeKey, routeReference, planRouteLadders, estimateRouteCu, DEFAULT_INTER_REF, MAX_LEG_SLOTS, MAX_ROUTE_SLOTS, prepareAltForUniverse, selectEcoSwapSvmAltAddresses, ecoSwapSvmPacketBudget, encodeEcoSwapSvmTrade, generateEcoSwapSvm, ecoSwapSvmShapeKey, buildLadder, solveReference, solveOptimal, efficiencyLoss, bigintSqrt, QL_S, ECO_SVM_MAX_SLOTS, ECO_SVM_MIN_REL_BPS, } from "./ecoswap/svm/index.js";
export { terraSwap } from "./terraswap/index.js";
export { prepareTerraSwap, prepareNextSeries } from "./terraswap/prepare.js";
export { solswap, solswapQuote, solswapBest } from "./solswap/index.js";
export { discoverPools } from "./shared/pool-discovery.js";
export { quotePool } from "./shared/quoting.js";
export * from "./shared/constants.js";
export * from "./shared/types.js";
//# sourceMappingURL=index.js.map