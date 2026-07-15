export declare const StakedUSDeABI: readonly [{
    readonly name: "deposit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }, {
        readonly name: "receiver";
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
        readonly name: "assets";
        readonly type: "uint256";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "owner";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "shares";
        readonly type: "uint256";
    }];
}, {
    readonly name: "redeem";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "shares";
        readonly type: "uint256";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "owner";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
}, {
    readonly name: "cooldownAssets";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "shares";
        readonly type: "uint256";
    }];
}, {
    readonly name: "cooldownShares";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "shares";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "assets";
        readonly type: "uint256";
    }];
}, {
    readonly name: "unstake";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "receiver";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}];
export declare const USDeABI: readonly [{
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
}];
//# sourceMappingURL=abis.d.ts.map