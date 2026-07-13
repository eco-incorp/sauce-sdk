export declare const MaverickV2RouterABI: readonly [{
    readonly name: "exactInputSingle";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "recipient";
        readonly type: "address";
    }, {
        readonly name: "pool";
        readonly type: "address";
    }, {
        readonly name: "tokenAIn";
        readonly type: "bool";
    }, {
        readonly name: "amountIn";
        readonly type: "uint256";
    }, {
        readonly name: "amountOutMinimum";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "amountOut";
        readonly type: "uint256";
    }];
}, {
    readonly name: "exactOutputSingle";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "recipient";
        readonly type: "address";
    }, {
        readonly name: "pool";
        readonly type: "address";
    }, {
        readonly name: "tokenAIn";
        readonly type: "bool";
    }, {
        readonly name: "amountOut";
        readonly type: "uint256";
    }, {
        readonly name: "amountInMaximum";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "amountIn";
        readonly type: "uint256";
    }];
}];
export declare const MaverickV2FactoryABI: readonly [{
    readonly name: "lookup";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "tokenA";
        readonly type: "address";
    }, {
        readonly name: "tokenB";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "pools";
        readonly type: "address[]";
    }];
}];
//# sourceMappingURL=abis.d.ts.map