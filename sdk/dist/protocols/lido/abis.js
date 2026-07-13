export const LidoABI = [
    {
        name: "submit",
        type: "function",
        stateMutability: "payable",
        inputs: [{ name: "_referral", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
    },
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
export const WstETHABI = [
    {
        name: "wrap",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [{ name: "_stETHAmount", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        name: "unwrap",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [{ name: "_wstETHAmount", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        name: "getStETHByWstETH",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "_wstETHAmount", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        name: "getWstETHByStETH",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "_stETHAmount", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }],
    },
];
//# sourceMappingURL=abis.js.map