export declare const FlashAggregatorABI: readonly [{
    readonly name: "flashLoan";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "tokens";
        readonly type: "address[]";
    }, {
        readonly name: "amounts";
        readonly type: "uint256[]";
    }, {
        readonly name: "route";
        readonly type: "uint256";
    }, {
        readonly name: "data";
        readonly type: "bytes";
    }, {
        readonly name: "extraData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "getRoutes";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "routes";
        readonly type: "uint16[]";
    }];
}];
//# sourceMappingURL=abis.d.ts.map