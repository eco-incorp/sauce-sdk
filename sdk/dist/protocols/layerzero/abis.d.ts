export declare const LayerZeroEndpointV2ABI: readonly [{
    readonly name: "send";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "dstEid";
            readonly type: "uint32";
        }, {
            readonly name: "receiver";
            readonly type: "uint256";
        }, {
            readonly name: "message";
            readonly type: "bytes";
        }, {
            readonly name: "options";
            readonly type: "bytes";
        }, {
            readonly name: "payInLzToken";
            readonly type: "bool";
        }];
    }, {
        readonly name: "_refundAddress";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "receipt";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "guid";
            readonly type: "uint256";
        }, {
            readonly name: "nonce";
            readonly type: "uint64";
        }, {
            readonly name: "fee";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "nativeFee";
                readonly type: "uint256";
            }, {
                readonly name: "lzTokenFee";
                readonly type: "uint256";
            }];
        }];
    }];
}, {
    readonly name: "quote";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "_params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "dstEid";
            readonly type: "uint32";
        }, {
            readonly name: "receiver";
            readonly type: "uint256";
        }, {
            readonly name: "message";
            readonly type: "bytes";
        }, {
            readonly name: "options";
            readonly type: "bytes";
        }, {
            readonly name: "payInLzToken";
            readonly type: "bool";
        }];
    }, {
        readonly name: "_sender";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "fee";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "nativeFee";
            readonly type: "uint256";
        }, {
            readonly name: "lzTokenFee";
            readonly type: "uint256";
        }];
    }];
}];
//# sourceMappingURL=abis.d.ts.map