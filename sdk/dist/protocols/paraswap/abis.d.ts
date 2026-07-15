export declare const AugustusV5ABI: readonly [{
    readonly name: "simpleSwap";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "data";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "fromToken";
            readonly type: "address";
        }, {
            readonly name: "toToken";
            readonly type: "address";
        }, {
            readonly name: "fromAmount";
            readonly type: "uint256";
        }, {
            readonly name: "toAmount";
            readonly type: "uint256";
        }, {
            readonly name: "expectedAmount";
            readonly type: "uint256";
        }, {
            readonly name: "callees";
            readonly type: "address[]";
        }, {
            readonly name: "exchangeData";
            readonly type: "bytes";
        }, {
            readonly name: "startIndexes";
            readonly type: "uint256[]";
        }, {
            readonly name: "values";
            readonly type: "uint256[]";
        }, {
            readonly name: "beneficiary";
            readonly type: "address";
        }, {
            readonly name: "partner";
            readonly type: "address";
        }, {
            readonly name: "feePercent";
            readonly type: "uint256";
        }, {
            readonly name: "permit";
            readonly type: "bytes";
        }, {
            readonly name: "deadline";
            readonly type: "uint256";
        }, {
            readonly name: "uuid";
            readonly type: "uint256";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "receivedAmount";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map