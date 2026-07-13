export declare const WormholeCoreBridgeABI: readonly [{
    readonly name: "publishMessage";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "nonce";
        readonly type: "uint32";
    }, {
        readonly name: "payload";
        readonly type: "bytes";
    }, {
        readonly name: "consistencyLevel";
        readonly type: "uint8";
    }];
    readonly outputs: readonly [{
        readonly name: "sequence";
        readonly type: "uint64";
    }];
}, {
    readonly name: "messageFee";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}];
export declare const WormholeTokenBridgeABI: readonly [{
    readonly name: "transferTokens";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "recipientChain";
        readonly type: "uint16";
    }, {
        readonly name: "recipient";
        readonly type: "uint256";
    }, {
        readonly name: "arbiterFee";
        readonly type: "uint256";
    }, {
        readonly name: "nonce";
        readonly type: "uint32";
    }];
    readonly outputs: readonly [{
        readonly name: "sequence";
        readonly type: "uint64";
    }];
}, {
    readonly name: "completeTransfer";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "encodedVm";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "wrappedAsset";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "tokenChainId";
        readonly type: "uint16";
    }, {
        readonly name: "tokenAddress";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
}];
//# sourceMappingURL=abis.d.ts.map