export declare const LockupLinearABI: readonly [{
    readonly name: "createWithDurations";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "sender";
            readonly type: "address";
        }, {
            readonly name: "recipient";
            readonly type: "address";
        }, {
            readonly name: "totalAmount";
            readonly type: "uint128";
        }, {
            readonly name: "asset";
            readonly type: "address";
        }, {
            readonly name: "cancelable";
            readonly type: "bool";
        }, {
            readonly name: "transferable";
            readonly type: "bool";
        }, {
            readonly name: "durations";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "cliff";
                readonly type: "uint64";
            }, {
                readonly name: "total";
                readonly type: "uint64";
            }];
        }, {
            readonly name: "broker";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "account";
                readonly type: "address";
            }, {
                readonly name: "fee";
                readonly type: "uint256";
            }];
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "streamId";
        readonly type: "uint256";
    }];
}, {
    readonly name: "withdraw";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "streamId";
        readonly type: "uint256";
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint128";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "cancel";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "streamId";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map