/**
 * Shared ABIs for recipe SauceScript templates.
 *
 * These are the subset of methods actually used by megaswap/alphaswap on-chain.
 * Full ABIs live in engine/out/ — these are kept minimal for bundle size.
 */
export const ISauceRouterABI = [
    {
        name: "swap",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            {
                name: "params",
                type: "tuple",
                components: [
                    { name: "poolType", type: "uint8" },
                    { name: "pool", type: "address" },
                    {
                        name: "poolKey",
                        type: "tuple",
                        components: [
                            { name: "currency0", type: "address" },
                            { name: "currency1", type: "address" },
                            { name: "fee", type: "uint24" },
                            { name: "tickSpacing", type: "int24" },
                            { name: "hooks", type: "address" },
                        ],
                    },
                    { name: "tokenIn", type: "address" },
                    { name: "tokenOut", type: "address" },
                    { name: "amountSpecified", type: "int256" },
                    { name: "sqrtPriceLimitX96", type: "uint160" },
                    { name: "payer", type: "address" },
                    { name: "recipient", type: "address" },
                ],
            },
        ],
        outputs: [
            { name: "amount0", type: "int256" },
            { name: "amount1", type: "int256" },
        ],
    },
];
export const IERC20ABI = [
    {
        name: "transfer",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
    },
    {
        name: "approve",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
    },
    {
        name: "transferFrom",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
    },
    {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
    },
];
export const IUniswapV3PoolABI = [
    {
        name: "slot0",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [
            { name: "sqrtPriceX96", type: "uint160" },
            { name: "tick", type: "int24" },
            { name: "observationIndex", type: "uint16" },
            { name: "observationCardinality", type: "uint16" },
            { name: "observationCardinalityNext", type: "uint16" },
            { name: "feeProtocol", type: "uint8" },
            { name: "unlocked", type: "bool" },
        ],
    },
    {
        name: "liquidity",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint128" }],
    },
];
//# sourceMappingURL=abis.js.map