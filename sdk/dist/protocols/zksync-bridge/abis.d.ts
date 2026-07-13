export declare const ZkSyncDiamondProxyABI: readonly [{
    readonly name: "requestL2Transaction";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_contractL2";
        readonly type: "address";
    }, {
        readonly name: "_l2Value";
        readonly type: "uint256";
    }, {
        readonly name: "_calldata";
        readonly type: "bytes";
    }, {
        readonly name: "_l2GasLimit";
        readonly type: "uint256";
    }, {
        readonly name: "_l2GasPerPubdataByteLimit";
        readonly type: "uint256";
    }, {
        readonly name: "_factoryDeps";
        readonly type: "bytes[]";
    }, {
        readonly name: "_refundRecipient";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "canonicalTxHash";
        readonly type: "uint256";
    }];
}, {
    readonly name: "l2TransactionBaseCost";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "_gasPrice";
        readonly type: "uint256";
    }, {
        readonly name: "_l2GasLimit";
        readonly type: "uint256";
    }, {
        readonly name: "_l2GasPerPubdataByteLimit";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map