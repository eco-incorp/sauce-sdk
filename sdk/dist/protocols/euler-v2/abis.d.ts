export declare const EVaultABI: readonly [{
    readonly name: "deposit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "amount";
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
        readonly name: "amount";
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
    readonly name: "borrow";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "amount";
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
    readonly name: "repay";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "amount";
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
        readonly name: "amount";
        readonly type: "uint256";
    }];
}];
export declare const EVCABI: readonly [{
    readonly name: "enableCollateral";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }, {
        readonly name: "vault";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "enableController";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }, {
        readonly name: "vault";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map