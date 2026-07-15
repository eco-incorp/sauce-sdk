export const LiquidityPoolABI = [
    {
        name: "deposit",
        type: "function",
        stateMutability: "payable",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
];
export const WeETHABI = [
    {
        name: "wrap",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [{ name: "_eETHAmount", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        name: "unwrap",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [{ name: "_weETHAmount", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        name: "getEETHByWeETH",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "_weETHAmount", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        name: "getWeETHByEETH",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "_eETHAmount", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
    },
];
export const EETHABI = [
    {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
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
];
//# sourceMappingURL=abis.js.map