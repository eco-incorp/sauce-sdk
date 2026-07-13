export declare const LiquidityPoolABI: readonly [{
    readonly name: "addLiquidity";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "tranche";
        readonly type: "address";
    }, {
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "amountIn";
        readonly type: "uint256";
    }, {
        readonly name: "minLpAmount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "removeLiquidity";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "tranche";
        readonly type: "address";
    }, {
        readonly name: "tokenOut";
        readonly type: "address";
    }, {
        readonly name: "lpAmount";
        readonly type: "uint256";
    }, {
        readonly name: "minOut";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "swap";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "tokenIn";
        readonly type: "address";
    }, {
        readonly name: "tokenOut";
        readonly type: "address";
    }, {
        readonly name: "minOut";
        readonly type: "uint256";
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "extradata";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map