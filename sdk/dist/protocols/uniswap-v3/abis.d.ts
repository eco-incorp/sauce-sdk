export declare const UniswapV3SwapRouterABI: readonly [{
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
            readonly name: "deadline";
            readonly type: "uint256";
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
    readonly name: "exactInput";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "path";
            readonly type: "bytes";
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
            readonly name: "amountOutMinimum";
            readonly type: "uint256";
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
            readonly name: "deadline";
            readonly type: "uint256";
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
}, {
    readonly name: "exactOutput";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "path";
            readonly type: "bytes";
        }, {
            readonly name: "recipient";
            readonly type: "address";
        }, {
            readonly name: "deadline";
            readonly type: "uint256";
        }, {
            readonly name: "amountOut";
            readonly type: "uint256";
        }, {
            readonly name: "amountInMaximum";
            readonly type: "uint256";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "amountIn";
        readonly type: "uint256";
    }];
}];
export declare const UniswapV3NonfungiblePositionManagerABI: readonly [{
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
}, {
    readonly name: "increaseLiquidity";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "tokenId";
            readonly type: "uint256";
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
            readonly name: "deadline";
            readonly type: "uint256";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "liquidity";
        readonly type: "uint128";
    }, {
        readonly name: "amount0";
        readonly type: "uint256";
    }, {
        readonly name: "amount1";
        readonly type: "uint256";
    }];
}, {
    readonly name: "decreaseLiquidity";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "tokenId";
            readonly type: "uint256";
        }, {
            readonly name: "liquidity";
            readonly type: "uint128";
        }, {
            readonly name: "amount0Min";
            readonly type: "uint256";
        }, {
            readonly name: "amount1Min";
            readonly type: "uint256";
        }, {
            readonly name: "deadline";
            readonly type: "uint256";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "amount0";
        readonly type: "uint256";
    }, {
        readonly name: "amount1";
        readonly type: "uint256";
    }];
}, {
    readonly name: "collect";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "tokenId";
            readonly type: "uint256";
        }, {
            readonly name: "recipient";
            readonly type: "address";
        }, {
            readonly name: "amount0Max";
            readonly type: "uint128";
        }, {
            readonly name: "amount1Max";
            readonly type: "uint128";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "amount0";
        readonly type: "uint256";
    }, {
        readonly name: "amount1";
        readonly type: "uint256";
    }];
}];
export declare const UniswapV3FactoryABI: readonly [{
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
}, {
    readonly name: "createPool";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
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
export declare const UniswapV3QuoterV2ABI: readonly [{
    readonly name: "quoteExactInputSingle";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
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
            readonly name: "amountIn";
            readonly type: "uint256";
        }, {
            readonly name: "fee";
            readonly type: "uint32";
        }, {
            readonly name: "sqrtPriceLimitX96";
            readonly type: "uint160";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "amountOut";
        readonly type: "uint256";
    }, {
        readonly name: "sqrtPriceX96After";
        readonly type: "uint160";
    }, {
        readonly name: "initializedTicksCrossed";
        readonly type: "uint32";
    }, {
        readonly name: "gasEstimate";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map