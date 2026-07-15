export declare const PoolABI: readonly [{
    readonly name: "supply";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "asset";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "onBehalfOf";
        readonly type: "address";
    }, {
        readonly name: "referralCode";
        readonly type: "uint16";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "withdraw";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "asset";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "to";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "borrow";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "asset";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "interestRateMode";
        readonly type: "uint256";
    }, {
        readonly name: "referralCode";
        readonly type: "uint16";
    }, {
        readonly name: "onBehalfOf";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "repay";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "asset";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "interestRateMode";
        readonly type: "uint256";
    }, {
        readonly name: "onBehalfOf";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "flashLoanSimple";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "receiverAddress";
        readonly type: "address";
    }, {
        readonly name: "asset";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "params";
        readonly type: "bytes";
    }, {
        readonly name: "referralCode";
        readonly type: "uint16";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "liquidationCall";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "collateralAsset";
        readonly type: "address";
    }, {
        readonly name: "debtAsset";
        readonly type: "address";
    }, {
        readonly name: "user";
        readonly type: "address";
    }, {
        readonly name: "debtToCover";
        readonly type: "uint256";
    }, {
        readonly name: "receiveAToken";
        readonly type: "bool";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "getUserAccountData";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "user";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "totalCollateralBase";
        readonly type: "uint256";
    }, {
        readonly name: "totalDebtBase";
        readonly type: "uint256";
    }, {
        readonly name: "availableBorrowsBase";
        readonly type: "uint256";
    }, {
        readonly name: "currentLiquidationThreshold";
        readonly type: "uint256";
    }, {
        readonly name: "ltv";
        readonly type: "uint256";
    }, {
        readonly name: "healthFactor";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map