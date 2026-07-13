export declare const SyncSwapRouterABI: readonly [{
    readonly name: "swap";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "paths";
        readonly type: "tuple[]";
        readonly components: readonly [{
            readonly name: "steps";
            readonly type: "tuple[]";
            readonly components: readonly [{
                readonly name: "pool";
                readonly type: "address";
            }, {
                readonly name: "data";
                readonly type: "bytes";
            }, {
                readonly name: "callback";
                readonly type: "address";
            }, {
                readonly name: "callbackData";
                readonly type: "bytes";
            }];
        }, {
            readonly name: "tokenIn";
            readonly type: "address";
        }, {
            readonly name: "amountIn";
            readonly type: "uint256";
        }];
    }, {
        readonly name: "amountOutMin";
        readonly type: "uint256";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "amountOut";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "token";
            readonly type: "address";
        }, {
            readonly name: "amount";
            readonly type: "uint256";
        }];
    }];
}];
//# sourceMappingURL=abis.d.ts.map