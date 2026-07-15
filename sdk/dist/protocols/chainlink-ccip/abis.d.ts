export declare const CCIPRouterABI: readonly [{
    readonly name: "ccipSend";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "destinationChainSelector";
        readonly type: "uint64";
    }, {
        readonly name: "message";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "receiver";
            readonly type: "bytes";
        }, {
            readonly name: "data";
            readonly type: "bytes";
        }, {
            readonly name: "tokenAmounts";
            readonly type: "tuple[]";
            readonly components: readonly [{
                readonly name: "token";
                readonly type: "address";
            }, {
                readonly name: "amount";
                readonly type: "uint256";
            }];
        }, {
            readonly name: "feeToken";
            readonly type: "address";
        }, {
            readonly name: "extraArgs";
            readonly type: "bytes";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "messageId";
        readonly type: "uint256";
    }];
}, {
    readonly name: "getFee";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "destinationChainSelector";
        readonly type: "uint64";
    }, {
        readonly name: "message";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "receiver";
            readonly type: "bytes";
        }, {
            readonly name: "data";
            readonly type: "bytes";
        }, {
            readonly name: "tokenAmounts";
            readonly type: "tuple[]";
            readonly components: readonly [{
                readonly name: "token";
                readonly type: "address";
            }, {
                readonly name: "amount";
                readonly type: "uint256";
            }];
        }, {
            readonly name: "feeToken";
            readonly type: "address";
        }, {
            readonly name: "extraArgs";
            readonly type: "bytes";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "fee";
        readonly type: "uint256";
    }];
}, {
    readonly name: "isChainSupported";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "chainSelector";
        readonly type: "uint64";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
}];
//# sourceMappingURL=abis.d.ts.map