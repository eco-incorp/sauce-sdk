export declare const ScrollL1MessengerABI: readonly [{
    readonly name: "sendMessage";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "value";
        readonly type: "uint256";
    }, {
        readonly name: "message";
        readonly type: "bytes";
    }, {
        readonly name: "gasLimit";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
export declare const ScrollL1GatewayRouterABI: readonly [{
    readonly name: "depositETH";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_amount";
        readonly type: "uint256";
    }, {
        readonly name: "_gasLimit";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "depositERC20";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_token";
        readonly type: "address";
    }, {
        readonly name: "_amount";
        readonly type: "uint256";
    }, {
        readonly name: "_gasLimit";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map