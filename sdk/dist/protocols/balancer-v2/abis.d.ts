export declare const BalancerV2VaultABI: readonly [{
    readonly name: "swap";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "singleSwap";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "poolId";
            readonly type: "uint256";
        }, {
            readonly name: "kind";
            readonly type: "uint8";
        }, {
            readonly name: "assetIn";
            readonly type: "address";
        }, {
            readonly name: "assetOut";
            readonly type: "address";
        }, {
            readonly name: "amount";
            readonly type: "uint256";
        }, {
            readonly name: "userData";
            readonly type: "bytes";
        }];
    }, {
        readonly name: "funds";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "sender";
            readonly type: "address";
        }, {
            readonly name: "fromInternalBalance";
            readonly type: "bool";
        }, {
            readonly name: "recipient";
            readonly type: "address";
        }, {
            readonly name: "toInternalBalance";
            readonly type: "bool";
        }];
    }, {
        readonly name: "limit";
        readonly type: "uint256";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "amountCalculated";
        readonly type: "uint256";
    }];
}, {
    readonly name: "batchSwap";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "kind";
        readonly type: "uint8";
    }, {
        readonly name: "swaps";
        readonly type: "tuple[]";
        readonly components: readonly [{
            readonly name: "poolId";
            readonly type: "uint256";
        }, {
            readonly name: "assetInIndex";
            readonly type: "uint256";
        }, {
            readonly name: "assetOutIndex";
            readonly type: "uint256";
        }, {
            readonly name: "amount";
            readonly type: "uint256";
        }, {
            readonly name: "userData";
            readonly type: "bytes";
        }];
    }, {
        readonly name: "assets";
        readonly type: "address[]";
    }, {
        readonly name: "funds";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "sender";
            readonly type: "address";
        }, {
            readonly name: "fromInternalBalance";
            readonly type: "bool";
        }, {
            readonly name: "recipient";
            readonly type: "address";
        }, {
            readonly name: "toInternalBalance";
            readonly type: "bool";
        }];
    }, {
        readonly name: "limits";
        readonly type: "uint256[]";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "assetDeltas";
        readonly type: "uint256[]";
    }];
}, {
    readonly name: "joinPool";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "poolId";
        readonly type: "uint256";
    }, {
        readonly name: "sender";
        readonly type: "address";
    }, {
        readonly name: "recipient";
        readonly type: "address";
    }, {
        readonly name: "request";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "assets";
            readonly type: "address[]";
        }, {
            readonly name: "maxAmountsIn";
            readonly type: "uint256[]";
        }, {
            readonly name: "userData";
            readonly type: "bytes";
        }, {
            readonly name: "fromInternalBalance";
            readonly type: "bool";
        }];
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "exitPool";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "poolId";
        readonly type: "uint256";
    }, {
        readonly name: "sender";
        readonly type: "address";
    }, {
        readonly name: "recipient";
        readonly type: "address";
    }, {
        readonly name: "request";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "assets";
            readonly type: "address[]";
        }, {
            readonly name: "minAmountsOut";
            readonly type: "uint256[]";
        }, {
            readonly name: "userData";
            readonly type: "bytes";
        }, {
            readonly name: "toInternalBalance";
            readonly type: "bool";
        }];
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "flashLoan";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "recipient";
        readonly type: "address";
    }, {
        readonly name: "tokens";
        readonly type: "address[]";
    }, {
        readonly name: "amounts";
        readonly type: "uint256[]";
    }, {
        readonly name: "userData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "getPoolTokens";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "poolId";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "tokens";
        readonly type: "address[]";
    }, {
        readonly name: "balances";
        readonly type: "uint256[]";
    }, {
        readonly name: "lastChangeBlock";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map