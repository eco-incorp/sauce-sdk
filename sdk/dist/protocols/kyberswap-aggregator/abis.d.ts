export declare const KyberSwapMetaAggregationRouterABI: readonly [{
    readonly name: "swap";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "execution";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "callTarget";
            readonly type: "address";
        }, {
            readonly name: "approveTarget";
            readonly type: "address";
        }, {
            readonly name: "targetData";
            readonly type: "bytes";
        }, {
            readonly name: "desc";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "srcToken";
                readonly type: "address";
            }, {
                readonly name: "dstToken";
                readonly type: "address";
            }, {
                readonly name: "srcReceivers";
                readonly type: "address[]";
            }, {
                readonly name: "srcAmounts";
                readonly type: "uint256[]";
            }, {
                readonly name: "feeReceivers";
                readonly type: "address[]";
            }, {
                readonly name: "feeAmounts";
                readonly type: "uint256[]";
            }, {
                readonly name: "dstReceiver";
                readonly type: "address";
            }, {
                readonly name: "amount";
                readonly type: "uint256";
            }, {
                readonly name: "minReturnAmount";
                readonly type: "uint256";
            }, {
                readonly name: "flags";
                readonly type: "uint256";
            }, {
                readonly name: "permit";
                readonly type: "bytes";
            }];
        }, {
            readonly name: "clientData";
            readonly type: "bytes";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "returnAmount";
        readonly type: "uint256";
    }, {
        readonly name: "gasUsed";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map