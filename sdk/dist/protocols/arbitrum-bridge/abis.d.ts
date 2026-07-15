export declare const ArbitrumL1GatewayRouterABI: readonly [{
    readonly name: "outboundTransfer";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_token";
        readonly type: "address";
    }, {
        readonly name: "_to";
        readonly type: "address";
    }, {
        readonly name: "_amount";
        readonly type: "uint256";
    }, {
        readonly name: "_maxGas";
        readonly type: "uint256";
    }, {
        readonly name: "_gasPriceBid";
        readonly type: "uint256";
    }, {
        readonly name: "_data";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bytes";
    }];
}, {
    readonly name: "getGateway";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "_token";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
}];
//# sourceMappingURL=abis.d.ts.map