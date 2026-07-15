export declare const ClearingHouseABI: readonly [{
    readonly name: "openPosition";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "baseToken";
        readonly type: "address";
    }, {
        readonly name: "isBaseToQuote";
        readonly type: "bool";
    }, {
        readonly name: "isExactInput";
        readonly type: "bool";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "oppositeAmountBound";
        readonly type: "uint256";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }, {
        readonly name: "sqrtPriceLimitX96";
        readonly type: "uint256";
    }, {
        readonly name: "referralCode";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "base";
        readonly type: "uint256";
    }, {
        readonly name: "quote";
        readonly type: "uint256";
    }];
}, {
    readonly name: "closePosition";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "baseToken";
        readonly type: "address";
    }, {
        readonly name: "sqrtPriceLimitX96";
        readonly type: "uint256";
    }, {
        readonly name: "oppositeAmountBound";
        readonly type: "uint256";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }, {
        readonly name: "referralCode";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "base";
        readonly type: "uint256";
    }, {
        readonly name: "quote";
        readonly type: "uint256";
    }];
}, {
    readonly name: "getAccountValue";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "trader";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}];
export declare const VaultABI: readonly [{
    readonly name: "deposit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "withdraw";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "getFreeCollateral";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "trader";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map