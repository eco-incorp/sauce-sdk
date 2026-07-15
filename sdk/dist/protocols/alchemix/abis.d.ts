export declare const AlchemistABI: readonly [{
    readonly name: "deposit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "yieldToken";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "recipient";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "shares";
        readonly type: "uint256";
    }];
}, {
    readonly name: "withdraw";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "yieldToken";
        readonly type: "address";
    }, {
        readonly name: "shares";
        readonly type: "uint256";
    }, {
        readonly name: "recipient";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "amountWithdrawn";
        readonly type: "uint256";
    }];
}, {
    readonly name: "mint";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "recipient";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "burn";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "recipient";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "liquidate";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "yieldToken";
        readonly type: "address";
    }, {
        readonly name: "shares";
        readonly type: "uint256";
    }, {
        readonly name: "minimumAmountOut";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "accounts";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "owner";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "debt";
        readonly type: "uint256";
    }, {
        readonly name: "depositedTokens";
        readonly type: "address[]";
    }];
}];
//# sourceMappingURL=abis.d.ts.map