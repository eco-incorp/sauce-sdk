export declare const PolygonRootChainManagerABI: readonly [{
    readonly name: "depositEtherFor";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "user";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "depositFor";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "user";
        readonly type: "address";
    }, {
        readonly name: "rootToken";
        readonly type: "address";
    }, {
        readonly name: "depositData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "exit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "inputData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map