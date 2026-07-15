export declare const ExchangeProxyABI: readonly [{
    readonly name: "transformERC20";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "inputToken";
        readonly type: "address";
    }, {
        readonly name: "outputToken";
        readonly type: "address";
    }, {
        readonly name: "inputTokenAmount";
        readonly type: "uint256";
    }, {
        readonly name: "minOutputTokenAmount";
        readonly type: "uint256";
    }, {
        readonly name: "transformations";
        readonly type: "tuple[]";
        readonly components: readonly [{
            readonly name: "deploymentNonce";
            readonly type: "uint32";
        }, {
            readonly name: "data";
            readonly type: "bytes";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "outputTokenAmount";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map