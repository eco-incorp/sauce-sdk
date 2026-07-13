export declare const KyberSwapElasticRouterABI: readonly [{
    readonly name: "swapExactInputSingle";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "tokenIn";
            readonly type: "address";
        }, {
            readonly name: "tokenOut";
            readonly type: "address";
        }, {
            readonly name: "fee";
            readonly type: "uint32";
        }, {
            readonly name: "recipient";
            readonly type: "address";
        }, {
            readonly name: "deadline";
            readonly type: "uint256";
        }, {
            readonly name: "amountIn";
            readonly type: "uint256";
        }, {
            readonly name: "minAmountOut";
            readonly type: "uint256";
        }, {
            readonly name: "limitSqrtP";
            readonly type: "uint160";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "amountOut";
        readonly type: "uint256";
    }];
}];
export declare const KyberSwapMetaAggregationRouterABI: readonly [{
    readonly name: "swap";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "execution";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "callTo";
            readonly type: "address";
        }, {
            readonly name: "approveTarget";
            readonly type: "address";
        }, {
            readonly name: "tokenIn";
            readonly type: "address";
        }, {
            readonly name: "tokenOut";
            readonly type: "address";
        }, {
            readonly name: "amountIn";
            readonly type: "uint256";
        }, {
            readonly name: "minAmountOut";
            readonly type: "uint256";
        }, {
            readonly name: "recipient";
            readonly type: "address";
        }, {
            readonly name: "data";
            readonly type: "bytes";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "returnAmount";
        readonly type: "uint256";
    }, {
        readonly name: "gasUsed";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map