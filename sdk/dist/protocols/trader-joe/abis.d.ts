export declare const LBRouterABI: readonly [{
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
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "pairBinSteps";
            readonly type: "uint256[]";
        }, {
            readonly name: "versions";
            readonly type: "uint8[]";
        }, {
            readonly name: "tokenPath";
            readonly type: "address[]";
        }];
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "amountOut";
        readonly type: "uint256";
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
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "pairBinSteps";
            readonly type: "uint256[]";
        }, {
            readonly name: "versions";
            readonly type: "uint8[]";
        }, {
            readonly name: "tokenPath";
            readonly type: "address[]";
        }];
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "amountIn";
        readonly type: "uint256";
    }];
}, {
    readonly name: "addLiquidity";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "liquidityParameters";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "tokenX";
            readonly type: "address";
        }, {
            readonly name: "tokenY";
            readonly type: "address";
        }, {
            readonly name: "binStep";
            readonly type: "uint256";
        }, {
            readonly name: "amountX";
            readonly type: "uint256";
        }, {
            readonly name: "amountY";
            readonly type: "uint256";
        }, {
            readonly name: "amountXMin";
            readonly type: "uint256";
        }, {
            readonly name: "amountYMin";
            readonly type: "uint256";
        }, {
            readonly name: "activeIdDesired";
            readonly type: "uint256";
        }, {
            readonly name: "idSlippage";
            readonly type: "uint256";
        }, {
            readonly name: "deltaIds";
            readonly type: "uint256[]";
        }, {
            readonly name: "distributionX";
            readonly type: "uint256[]";
        }, {
            readonly name: "distributionY";
            readonly type: "uint256[]";
        }, {
            readonly name: "to";
            readonly type: "address";
        }, {
            readonly name: "refundTo";
            readonly type: "address";
        }, {
            readonly name: "deadline";
            readonly type: "uint256";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "amountXAdded";
        readonly type: "uint256";
    }, {
        readonly name: "amountYAdded";
        readonly type: "uint256";
    }, {
        readonly name: "amountXLeft";
        readonly type: "uint256";
    }, {
        readonly name: "amountYLeft";
        readonly type: "uint256";
    }, {
        readonly name: "depositIds";
        readonly type: "uint256[]";
    }, {
        readonly name: "liquidityMinted";
        readonly type: "uint256[]";
    }];
}];
export declare const LBFactoryABI: readonly [{
    readonly name: "getLBPairInformation";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "tokenA";
        readonly type: "address";
    }, {
        readonly name: "tokenB";
        readonly type: "address";
    }, {
        readonly name: "binStep";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "lbPairInformation";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "binStep";
            readonly type: "uint16";
        }, {
            readonly name: "LBPair";
            readonly type: "address";
        }, {
            readonly name: "createdByOwner";
            readonly type: "bool";
        }, {
            readonly name: "ignoredForRouting";
            readonly type: "bool";
        }];
    }];
}];
//# sourceMappingURL=abis.d.ts.map