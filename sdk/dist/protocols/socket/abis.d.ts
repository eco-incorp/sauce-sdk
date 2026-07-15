export declare const SocketGatewayABI: readonly [{
    readonly name: "bridge";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "routeId";
        readonly type: "uint32";
    }, {
        readonly name: "bridgeData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "executeRoute";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "routeId";
        readonly type: "uint32";
    }, {
        readonly name: "data";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "result";
        readonly type: "bytes";
    }];
}];
//# sourceMappingURL=abis.d.ts.map