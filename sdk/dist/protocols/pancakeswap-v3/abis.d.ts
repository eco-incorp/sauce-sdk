export declare const PancakeSwapV3SmartRouterABI: readonly [{
    readonly name: "exactInputSingle";
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
            readonly name: "amountIn";
            readonly type: "uint256";
        }, {
            readonly name: "amountOutMinimum";
            readonly type: "uint256";
        }, {
            readonly name: "sqrtPriceLimitX96";
            readonly type: "uint160";
        }];
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
            readonly name: "amountOut";
            readonly type: "uint256";
        }, {
            readonly name: "amountInMaximum";
            readonly type: "uint256";
        }, {
            readonly name: "sqrtPriceLimitX96";
            readonly type: "uint160";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "amountIn";
        readonly type: "uint256";
    }];
}];
export declare const PancakeSwapV3FactoryABI: readonly [{
    readonly name: "getPool";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "tokenA";
        readonly type: "address";
    }, {
        readonly name: "tokenB";
        readonly type: "address";
    }, {
        readonly name: "fee";
        readonly type: "uint32";
    }];
    readonly outputs: readonly [{
        readonly name: "pool";
        readonly type: "address";
    }];
}];
export declare const PancakeSwapV3NFPMABI: readonly [{
    readonly name: "mint";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "token0";
            readonly type: "address";
        }, {
            readonly name: "token1";
            readonly type: "address";
        }, {
            readonly name: "fee";
            readonly type: "uint32";
        }, {
            readonly name: "tickLower";
            readonly type: "uint32";
        }, {
            readonly name: "tickUpper";
            readonly type: "uint32";
        }, {
            readonly name: "amount0Desired";
            readonly type: "uint256";
        }, {
            readonly name: "amount1Desired";
            readonly type: "uint256";
        }, {
            readonly name: "amount0Min";
            readonly type: "uint256";
        }, {
            readonly name: "amount1Min";
            readonly type: "uint256";
        }, {
            readonly name: "recipient";
            readonly type: "address";
        }, {
            readonly name: "deadline";
            readonly type: "uint256";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "tokenId";
        readonly type: "uint256";
    }, {
        readonly name: "liquidity";
        readonly type: "uint128";
    }, {
        readonly name: "amount0";
        readonly type: "uint256";
    }, {
        readonly name: "amount1";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map