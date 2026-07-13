export declare const Permit2ABI: readonly [{
    readonly name: "approve";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "spender";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint160";
    }, {
        readonly name: "expiration";
        readonly type: "uint64";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "transferFrom";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "from";
        readonly type: "address";
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint160";
    }, {
        readonly name: "token";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "lockdown";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "approvals";
        readonly type: "tuple[]";
        readonly components: readonly [{
            readonly name: "token";
            readonly type: "address";
        }, {
            readonly name: "spender";
            readonly type: "address";
        }];
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map