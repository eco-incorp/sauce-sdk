export declare const UniswapV4PoolManagerABI: readonly [{
    readonly name: "initialize";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "key";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "currency0";
            readonly type: "address";
        }, {
            readonly name: "currency1";
            readonly type: "address";
        }, {
            readonly name: "fee";
            readonly type: "uint32";
        }, {
            readonly name: "tickSpacing";
            readonly type: "uint32";
        }, {
            readonly name: "hooks";
            readonly type: "address";
        }];
    }, {
        readonly name: "sqrtPriceX96";
        readonly type: "uint160";
    }];
    readonly outputs: readonly [{
        readonly name: "tick";
        readonly type: "uint32";
    }];
}, {
    readonly name: "swap";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "key";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "currency0";
            readonly type: "address";
        }, {
            readonly name: "currency1";
            readonly type: "address";
        }, {
            readonly name: "fee";
            readonly type: "uint32";
        }, {
            readonly name: "tickSpacing";
            readonly type: "uint32";
        }, {
            readonly name: "hooks";
            readonly type: "address";
        }];
    }, {
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "zeroForOne";
            readonly type: "bool";
        }, {
            readonly name: "amountSpecified";
            readonly type: "uint256";
        }, {
            readonly name: "sqrtPriceLimitX96";
            readonly type: "uint160";
        }];
    }, {
        readonly name: "hookData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "delta";
        readonly type: "uint256";
    }];
}, {
    readonly name: "modifyLiquidity";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "key";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "currency0";
            readonly type: "address";
        }, {
            readonly name: "currency1";
            readonly type: "address";
        }, {
            readonly name: "fee";
            readonly type: "uint32";
        }, {
            readonly name: "tickSpacing";
            readonly type: "uint32";
        }, {
            readonly name: "hooks";
            readonly type: "address";
        }];
    }, {
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "tickLower";
            readonly type: "uint32";
        }, {
            readonly name: "tickUpper";
            readonly type: "uint32";
        }, {
            readonly name: "liquidityDelta";
            readonly type: "uint256";
        }, {
            readonly name: "salt";
            readonly type: "uint256";
        }];
    }, {
        readonly name: "hookData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "delta";
        readonly type: "uint256";
    }, {
        readonly name: "feeDelta";
        readonly type: "uint256";
    }];
}];
export declare const UniswapV4UniversalRouterABI: readonly [{
    readonly name: "execute";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "commands";
        readonly type: "bytes";
    }, {
        readonly name: "inputs";
        readonly type: "bytes[]";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
export declare const UniswapV4PositionManagerABI: readonly [{
    readonly name: "modifyLiquidities";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "unlockData";
        readonly type: "bytes";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map