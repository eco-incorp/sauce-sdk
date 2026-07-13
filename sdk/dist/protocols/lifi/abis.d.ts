export declare const LiFiDiamondABI: readonly [{
    readonly name: "startBridgeTokensViaBridge";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_bridgeData";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "transactionId";
            readonly type: "uint256";
        }, {
            readonly name: "bridge";
            readonly type: "string";
        }, {
            readonly name: "integrator";
            readonly type: "string";
        }, {
            readonly name: "referrer";
            readonly type: "address";
        }, {
            readonly name: "sendingAssetId";
            readonly type: "address";
        }, {
            readonly name: "receiver";
            readonly type: "address";
        }, {
            readonly name: "minAmount";
            readonly type: "uint256";
        }, {
            readonly name: "destinationChainId";
            readonly type: "uint256";
        }, {
            readonly name: "hasSourceSwaps";
            readonly type: "bool";
        }, {
            readonly name: "hasDestinationCall";
            readonly type: "bool";
        }];
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "extractBridgeData";
    readonly type: "function";
    readonly stateMutability: "pure";
    readonly inputs: readonly [{
        readonly name: "data";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "bridgeData";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "transactionId";
            readonly type: "uint256";
        }, {
            readonly name: "bridge";
            readonly type: "string";
        }, {
            readonly name: "integrator";
            readonly type: "string";
        }, {
            readonly name: "referrer";
            readonly type: "address";
        }, {
            readonly name: "sendingAssetId";
            readonly type: "address";
        }, {
            readonly name: "receiver";
            readonly type: "address";
        }, {
            readonly name: "minAmount";
            readonly type: "uint256";
        }, {
            readonly name: "destinationChainId";
            readonly type: "uint256";
        }, {
            readonly name: "hasSourceSwaps";
            readonly type: "bool";
        }, {
            readonly name: "hasDestinationCall";
            readonly type: "bool";
        }];
    }];
}];
//# sourceMappingURL=abis.d.ts.map