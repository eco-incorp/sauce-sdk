export declare const CoreProxyABI: readonly [{
    readonly name: "deposit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "accountId";
        readonly type: "uint128";
    }, {
        readonly name: "collateralType";
        readonly type: "address";
    }, {
        readonly name: "tokenAmount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "withdraw";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "accountId";
        readonly type: "uint128";
    }, {
        readonly name: "collateralType";
        readonly type: "address";
    }, {
        readonly name: "tokenAmount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "delegateCollateral";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "accountId";
        readonly type: "uint128";
    }, {
        readonly name: "poolId";
        readonly type: "uint128";
    }, {
        readonly name: "collateralType";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "leverage";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
export declare const PerpsMarketProxyABI: readonly [{
    readonly name: "commitOrder";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "commitment";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "marketId";
            readonly type: "uint128";
        }, {
            readonly name: "accountId";
            readonly type: "uint128";
        }, {
            readonly name: "sizeDelta";
            readonly type: "uint128";
        }, {
            readonly name: "settlementStrategyId";
            readonly type: "uint128";
        }, {
            readonly name: "acceptablePrice";
            readonly type: "uint256";
        }, {
            readonly name: "trackingCode";
            readonly type: "uint256";
        }, {
            readonly name: "referrer";
            readonly type: "address";
        }];
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "modifyCollateral";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "accountId";
        readonly type: "uint128";
    }, {
        readonly name: "synthMarketId";
        readonly type: "uint128";
    }, {
        readonly name: "amountDelta";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map