export declare const PythOracleABI: readonly [{
    readonly name: "updatePriceFeeds";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "updateData";
        readonly type: "bytes[]";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "getPrice";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "id";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "price";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "price";
            readonly type: "uint64";
        }, {
            readonly name: "conf";
            readonly type: "uint64";
        }, {
            readonly name: "expo";
            readonly type: "uint32";
        }, {
            readonly name: "publishTime";
            readonly type: "uint256";
        }];
    }];
}, {
    readonly name: "getUpdateFee";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "updateData";
        readonly type: "bytes[]";
    }];
    readonly outputs: readonly [{
        readonly name: "feeAmount";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map