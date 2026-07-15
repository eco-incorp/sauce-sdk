export declare const CelerBridgeABI: readonly [{
    readonly name: "send";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_receiver";
        readonly type: "address";
    }, {
        readonly name: "_token";
        readonly type: "address";
    }, {
        readonly name: "_amount";
        readonly type: "uint256";
    }, {
        readonly name: "_dstChainId";
        readonly type: "uint64";
    }, {
        readonly name: "_nonce";
        readonly type: "uint64";
    }, {
        readonly name: "_maxSlippage";
        readonly type: "uint32";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "sendNative";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_receiver";
        readonly type: "address";
    }, {
        readonly name: "_amount";
        readonly type: "uint256";
    }, {
        readonly name: "_dstChainId";
        readonly type: "uint64";
    }, {
        readonly name: "_nonce";
        readonly type: "uint64";
    }, {
        readonly name: "_maxSlippage";
        readonly type: "uint32";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map