export declare const DODOV2ProxyABI: readonly [{
    readonly name: "dodoSwapV2TokenToToken";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "fromToken";
        readonly type: "address";
    }, {
        readonly name: "toToken";
        readonly type: "address";
    }, {
        readonly name: "fromTokenAmount";
        readonly type: "uint256";
    }, {
        readonly name: "minReturnAmount";
        readonly type: "uint256";
    }, {
        readonly name: "dodoPairs";
        readonly type: "address[]";
    }, {
        readonly name: "directions";
        readonly type: "uint256";
    }, {
        readonly name: "isIncentive";
        readonly type: "bool";
    }, {
        readonly name: "deadLine";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "returnAmount";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map