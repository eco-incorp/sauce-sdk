export declare const DlnSourceABI: readonly [{
    readonly name: "createOrder";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_orderCreation";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "giveTokenAddress";
            readonly type: "address";
        }, {
            readonly name: "giveAmount";
            readonly type: "uint256";
        }, {
            readonly name: "takeTokenAddress";
            readonly type: "bytes";
        }, {
            readonly name: "takeAmount";
            readonly type: "uint256";
        }, {
            readonly name: "takeChainId";
            readonly type: "uint256";
        }, {
            readonly name: "receiverDst";
            readonly type: "bytes";
        }, {
            readonly name: "givePatchAuthoritySrc";
            readonly type: "address";
        }, {
            readonly name: "orderAuthorityAddressDst";
            readonly type: "bytes";
        }, {
            readonly name: "allowedTakerDst";
            readonly type: "bytes";
        }, {
            readonly name: "externalCall";
            readonly type: "bytes";
        }, {
            readonly name: "allowedCancelBeneficiarySrc";
            readonly type: "bytes";
        }];
    }, {
        readonly name: "_affiliateFee";
        readonly type: "bytes";
    }, {
        readonly name: "_referralCode";
        readonly type: "uint32";
    }, {
        readonly name: "_permitEnvelope";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "orderId";
        readonly type: "uint256";
    }];
}];
export declare const DlnDestinationABI: readonly [{
    readonly name: "fulfillOrder";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_order";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "makerOrderNonce";
            readonly type: "uint64";
        }, {
            readonly name: "makerSrc";
            readonly type: "bytes";
        }, {
            readonly name: "giveChainId";
            readonly type: "uint256";
        }, {
            readonly name: "giveTokenAddress";
            readonly type: "bytes";
        }, {
            readonly name: "giveAmount";
            readonly type: "uint256";
        }, {
            readonly name: "takeChainId";
            readonly type: "uint256";
        }, {
            readonly name: "receiverDst";
            readonly type: "bytes";
        }, {
            readonly name: "takeTokenAddress";
            readonly type: "address";
        }, {
            readonly name: "takeAmount";
            readonly type: "uint256";
        }, {
            readonly name: "givePatchAuthoritySrc";
            readonly type: "bytes";
        }, {
            readonly name: "orderAuthorityAddressDst";
            readonly type: "address";
        }, {
            readonly name: "allowedTakerDst";
            readonly type: "bytes";
        }, {
            readonly name: "allowedCancelBeneficiarySrc";
            readonly type: "bytes";
        }, {
            readonly name: "externalCall";
            readonly type: "bytes";
        }];
    }, {
        readonly name: "_fulFillAmount";
        readonly type: "uint256";
    }, {
        readonly name: "_orderId";
        readonly type: "uint256";
    }, {
        readonly name: "_permitEnvelope";
        readonly type: "bytes";
    }, {
        readonly name: "_unlockAuthority";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map