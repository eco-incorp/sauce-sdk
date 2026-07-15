export declare const EverclearSpokeABI: readonly [{
    readonly name: "newIntent";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "destinations";
        readonly type: "uint32[]";
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "inputAsset";
        readonly type: "address";
    }, {
        readonly name: "outputAsset";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "maxFee";
        readonly type: "uint32";
    }, {
        readonly name: "ttl";
        readonly type: "uint64";
    }, {
        readonly name: "data";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "intentId";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map