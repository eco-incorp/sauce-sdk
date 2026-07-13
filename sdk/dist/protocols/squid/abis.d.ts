export declare const SquidRouterABI: readonly [{
    readonly name: "bridgeCall";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "calls";
        readonly type: "tuple[]";
        readonly components: readonly [{
            readonly name: "callType";
            readonly type: "uint8";
        }, {
            readonly name: "target";
            readonly type: "address";
        }, {
            readonly name: "value";
            readonly type: "uint256";
        }, {
            readonly name: "callData";
            readonly type: "bytes";
        }, {
            readonly name: "payload";
            readonly type: "bytes";
        }];
    }, {
        readonly name: "bridgedTokenSymbol";
        readonly type: "string";
    }, {
        readonly name: "destinationChain";
        readonly type: "string";
    }, {
        readonly name: "destinationAddress";
        readonly type: "string";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "callBridge";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "bridgedTokenSymbol";
        readonly type: "string";
    }, {
        readonly name: "destinationChain";
        readonly type: "string";
    }, {
        readonly name: "destinationAddress";
        readonly type: "string";
    }, {
        readonly name: "payload";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map