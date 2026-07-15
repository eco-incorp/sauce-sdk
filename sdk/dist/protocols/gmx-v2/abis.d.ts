export declare const ExchangeRouterABI: readonly [{
    readonly name: "createOrder";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "params";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "addresses";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "receiver";
                readonly type: "address";
            }, {
                readonly name: "cancellationReceiver";
                readonly type: "address";
            }, {
                readonly name: "callbackContract";
                readonly type: "address";
            }, {
                readonly name: "uiFeeReceiver";
                readonly type: "address";
            }, {
                readonly name: "market";
                readonly type: "address";
            }, {
                readonly name: "initialCollateralToken";
                readonly type: "address";
            }, {
                readonly name: "swapPath";
                readonly type: "address[]";
            }];
        }, {
            readonly name: "numbers";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "sizeDeltaUsd";
                readonly type: "uint256";
            }, {
                readonly name: "initialCollateralDeltaAmount";
                readonly type: "uint256";
            }, {
                readonly name: "triggerPrice";
                readonly type: "uint256";
            }, {
                readonly name: "acceptablePrice";
                readonly type: "uint256";
            }, {
                readonly name: "executionFee";
                readonly type: "uint256";
            }, {
                readonly name: "callbackGasLimit";
                readonly type: "uint256";
            }, {
                readonly name: "minOutputAmount";
                readonly type: "uint256";
            }];
        }, {
            readonly name: "orderType";
            readonly type: "uint8";
        }, {
            readonly name: "decreasePositionSwapType";
            readonly type: "uint8";
        }, {
            readonly name: "isLong";
            readonly type: "bool";
        }, {
            readonly name: "shouldUnwrapNativeToken";
            readonly type: "bool";
        }, {
            readonly name: "autoCancel";
            readonly type: "bool";
        }, {
            readonly name: "referralCode";
            readonly type: "uint256";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "cancelOrder";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "key";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "sendTokens";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map