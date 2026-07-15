export declare const StargatePoolABI: readonly [{
    readonly name: "send";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_sendParam";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "dstEid";
            readonly type: "uint32";
        }, {
            readonly name: "to";
            readonly type: "uint256";
        }, {
            readonly name: "amountLD";
            readonly type: "uint256";
        }, {
            readonly name: "minAmountLD";
            readonly type: "uint256";
        }, {
            readonly name: "extraOptions";
            readonly type: "bytes";
        }, {
            readonly name: "composeMsg";
            readonly type: "bytes";
        }, {
            readonly name: "oftCmd";
            readonly type: "bytes";
        }];
    }, {
        readonly name: "_fee";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "nativeFee";
            readonly type: "uint256";
        }, {
            readonly name: "lzTokenFee";
            readonly type: "uint256";
        }];
    }, {
        readonly name: "_refundAddress";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "msgReceipt";
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
    }, {
        readonly name: "oftReceipt";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "amountSentLD";
            readonly type: "uint256";
        }, {
            readonly name: "amountReceivedLD";
            readonly type: "uint256";
        }];
    }];
}, {
    readonly name: "quoteOFT";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "_sendParam";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "dstEid";
            readonly type: "uint32";
        }, {
            readonly name: "to";
            readonly type: "uint256";
        }, {
            readonly name: "amountLD";
            readonly type: "uint256";
        }, {
            readonly name: "minAmountLD";
            readonly type: "uint256";
        }, {
            readonly name: "extraOptions";
            readonly type: "bytes";
        }, {
            readonly name: "composeMsg";
            readonly type: "bytes";
        }, {
            readonly name: "oftCmd";
            readonly type: "bytes";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "oftLimit";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "minAmountLD";
            readonly type: "uint256";
        }, {
            readonly name: "maxAmountLD";
            readonly type: "uint256";
        }];
    }];
}];
//# sourceMappingURL=abis.d.ts.map