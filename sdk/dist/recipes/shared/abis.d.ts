/**
 * Shared ABIs for recipe SauceScript templates.
 *
 * These are the subset of methods actually used by megaswap/alphaswap on-chain.
 * Full ABIs live in engine/out/ — these are kept minimal for bundle size.
 */
export declare const ISauceRouterABI: readonly [{
    readonly name: "swap";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "poolType";
            readonly type: "uint8";
        }, {
            readonly name: "pool";
            readonly type: "address";
        }, {
            readonly name: "poolKey";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "currency0";
                readonly type: "address";
            }, {
                readonly name: "currency1";
                readonly type: "address";
            }, {
                readonly name: "fee";
                readonly type: "uint24";
            }, {
                readonly name: "tickSpacing";
                readonly type: "int24";
            }, {
                readonly name: "hooks";
                readonly type: "address";
            }];
        }, {
            readonly name: "tokenIn";
            readonly type: "address";
        }, {
            readonly name: "tokenOut";
            readonly type: "address";
        }, {
            readonly name: "amountSpecified";
            readonly type: "int256";
        }, {
            readonly name: "sqrtPriceLimitX96";
            readonly type: "uint160";
        }, {
            readonly name: "payer";
            readonly type: "address";
        }, {
            readonly name: "recipient";
            readonly type: "address";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "amount0";
        readonly type: "int256";
    }, {
        readonly name: "amount1";
        readonly type: "int256";
    }];
}];
export declare const IERC20ABI: readonly [{
    readonly name: "transfer";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
}, {
    readonly name: "approve";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "spender";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
}, {
    readonly name: "transferFrom";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "from";
        readonly type: "address";
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
}, {
    readonly name: "balanceOf";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}];
export declare const IUniswapV3PoolABI: readonly [{
    readonly name: "slot0";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "sqrtPriceX96";
        readonly type: "uint160";
    }, {
        readonly name: "tick";
        readonly type: "int24";
    }, {
        readonly name: "observationIndex";
        readonly type: "uint16";
    }, {
        readonly name: "observationCardinality";
        readonly type: "uint16";
    }, {
        readonly name: "observationCardinalityNext";
        readonly type: "uint16";
    }, {
        readonly name: "feeProtocol";
        readonly type: "uint8";
    }, {
        readonly name: "unlocked";
        readonly type: "bool";
    }];
}, {
    readonly name: "liquidity";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint128";
    }];
}];
//# sourceMappingURL=abis.d.ts.map