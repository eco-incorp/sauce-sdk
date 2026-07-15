export declare const EndpointABI: readonly [{
    readonly name: "depositCollateral";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "subaccountName";
        readonly type: "uint256";
    }, {
        readonly name: "productId";
        readonly type: "uint32";
    }, {
        readonly name: "amount";
        readonly type: "uint128";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "submitSlowModeTransaction";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "transaction";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}];
export declare const ClearinghouseABI: readonly [{
    readonly name: "withdrawCollateral";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "subaccountName";
        readonly type: "uint256";
    }, {
        readonly name: "productId";
        readonly type: "uint32";
    }, {
        readonly name: "amount";
        readonly type: "uint128";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map