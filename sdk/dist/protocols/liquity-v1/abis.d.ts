export declare const BorrowerOperationsABI: readonly [{
    readonly name: "openTrove";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_maxFeePercentage";
        readonly type: "uint256";
    }, {
        readonly name: "_LUSDAmount";
        readonly type: "uint256";
    }, {
        readonly name: "_upperHint";
        readonly type: "address";
    }, {
        readonly name: "_lowerHint";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "closeTrove";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
}, {
    readonly name: "adjustTrove";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_maxFeePercentage";
        readonly type: "uint256";
    }, {
        readonly name: "_collWithdrawal";
        readonly type: "uint256";
    }, {
        readonly name: "_LUSDChange";
        readonly type: "uint256";
    }, {
        readonly name: "_isDebtIncrease";
        readonly type: "bool";
    }, {
        readonly name: "_upperHint";
        readonly type: "address";
    }, {
        readonly name: "_lowerHint";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "repayLUSD";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_LUSDAmount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map