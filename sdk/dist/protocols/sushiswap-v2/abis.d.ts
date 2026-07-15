export declare const SushiSwapV2RouterABI: readonly [{
    readonly name: "swapExactTokensForTokens";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "amountIn";
        readonly type: "uint256";
    }, {
        readonly name: "amountOutMin";
        readonly type: "uint256";
    }, {
        readonly name: "path";
        readonly type: "address[]";
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "amounts";
        readonly type: "uint256[]";
    }];
}, {
    readonly name: "swapTokensForExactTokens";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "amountOut";
        readonly type: "uint256";
    }, {
        readonly name: "amountInMax";
        readonly type: "uint256";
    }, {
        readonly name: "path";
        readonly type: "address[]";
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "amounts";
        readonly type: "uint256[]";
    }];
}, {
    readonly name: "addLiquidity";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "tokenA";
        readonly type: "address";
    }, {
        readonly name: "tokenB";
        readonly type: "address";
    }, {
        readonly name: "amountADesired";
        readonly type: "uint256";
    }, {
        readonly name: "amountBDesired";
        readonly type: "uint256";
    }, {
        readonly name: "amountAMin";
        readonly type: "uint256";
    }, {
        readonly name: "amountBMin";
        readonly type: "uint256";
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "amountA";
        readonly type: "uint256";
    }, {
        readonly name: "amountB";
        readonly type: "uint256";
    }, {
        readonly name: "liquidity";
        readonly type: "uint256";
    }];
}, {
    readonly name: "removeLiquidity";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "tokenA";
        readonly type: "address";
    }, {
        readonly name: "tokenB";
        readonly type: "address";
    }, {
        readonly name: "liquidity";
        readonly type: "uint256";
    }, {
        readonly name: "amountAMin";
        readonly type: "uint256";
    }, {
        readonly name: "amountBMin";
        readonly type: "uint256";
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "amountA";
        readonly type: "uint256";
    }, {
        readonly name: "amountB";
        readonly type: "uint256";
    }];
}, {
    readonly name: "getAmountsOut";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "amountIn";
        readonly type: "uint256";
    }, {
        readonly name: "path";
        readonly type: "address[]";
    }];
    readonly outputs: readonly [{
        readonly name: "amounts";
        readonly type: "uint256[]";
    }];
}];
export declare const SushiSwapV2FactoryABI: readonly [{
    readonly name: "getPair";
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
        readonly name: "pair";
        readonly type: "address";
    }];
}, {
    readonly name: "createPair";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "tokenA";
        readonly type: "address";
    }, {
        readonly name: "tokenB";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "pair";
        readonly type: "address";
    }];
}];
//# sourceMappingURL=abis.d.ts.map