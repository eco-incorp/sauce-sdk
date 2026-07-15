export declare const ArrakisRouterABI: readonly [{
    readonly name: "addLiquidity";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "amount0Max";
            readonly type: "uint256";
        }, {
            readonly name: "amount1Max";
            readonly type: "uint256";
        }, {
            readonly name: "amount0Min";
            readonly type: "uint256";
        }, {
            readonly name: "amount1Min";
            readonly type: "uint256";
        }, {
            readonly name: "amountSharesMin";
            readonly type: "uint256";
        }, {
            readonly name: "vault";
            readonly type: "address";
        }, {
            readonly name: "receiver";
            readonly type: "address";
        }, {
            readonly name: "gauge";
            readonly type: "address";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "amount0";
        readonly type: "uint256";
    }, {
        readonly name: "amount1";
        readonly type: "uint256";
    }, {
        readonly name: "sharesReceived";
        readonly type: "uint256";
    }];
}, {
    readonly name: "removeLiquidity";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "burnAmount";
            readonly type: "uint256";
        }, {
            readonly name: "amount0Min";
            readonly type: "uint256";
        }, {
            readonly name: "amount1Min";
            readonly type: "uint256";
        }, {
            readonly name: "vault";
            readonly type: "address";
        }, {
            readonly name: "receiver";
            readonly type: "address";
        }, {
            readonly name: "gauge";
            readonly type: "address";
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
export declare const ArrakisVaultABI: readonly [{
    readonly name: "totalSupply";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
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
}, {
    readonly name: "totalUnderlying";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "amount0";
        readonly type: "uint256";
    }, {
        readonly name: "amount1";
        readonly type: "uint256";
    }];
}, {
    readonly name: "token0";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
}, {
    readonly name: "token1";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
}];
//# sourceMappingURL=abis.d.ts.map