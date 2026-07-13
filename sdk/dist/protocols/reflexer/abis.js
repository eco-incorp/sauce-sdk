export const SAFEEngineABI = [
    {
        name: "modifySAFECollateralization",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "collateralType", type: "uint256" },
            { name: "safe", type: "address" },
            { name: "collateralSource", type: "address" },
            { name: "debtDestination", type: "address" },
            { name: "deltaCollateral", type: "uint256" },
            { name: "deltaDebt", type: "uint256" },
        ],
        outputs: [],
    },
    {
        name: "safes",
        type: "function",
        stateMutability: "view",
        inputs: [
            { name: "collateralType", type: "uint256" },
            { name: "safe", type: "address" },
        ],
        outputs: [
            { name: "lockedCollateral", type: "uint256" },
            { name: "generatedDebt", type: "uint256" },
        ],
    },
];
export const CoinJoinABI = [
    {
        name: "join",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "account", type: "address" },
            { name: "wad", type: "uint256" },
        ],
        outputs: [],
    },
    {
        name: "exit",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "account", type: "address" },
            { name: "wad", type: "uint256" },
        ],
        outputs: [],
    },
];
export const ETHJoinABI = [
    {
        name: "join",
        type: "function",
        stateMutability: "payable",
        inputs: [{ name: "account", type: "address" }],
        outputs: [],
    },
    {
        name: "exit",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "account", type: "address" },
            { name: "wad", type: "uint256" },
        ],
        outputs: [],
    },
];
//# sourceMappingURL=abis.js.map