export declare const ZeroLendPoolABI: readonly [{
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
}];
//# sourceMappingURL=abis.d.ts.map