export declare const SeaportABI: readonly [{
    readonly name: "fulfillBasicOrder";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "parameters";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "considerationToken";
            readonly type: "address";
        }, {
            readonly name: "considerationIdentifier";
            readonly type: "uint256";
        }, {
            readonly name: "considerationAmount";
            readonly type: "uint256";
        }, {
            readonly name: "offerer";
            readonly type: "address";
        }, {
            readonly name: "zone";
            readonly type: "address";
        }, {
            readonly name: "offerToken";
            readonly type: "address";
        }, {
            readonly name: "offerIdentifier";
            readonly type: "uint256";
        }, {
            readonly name: "offerAmount";
            readonly type: "uint256";
        }, {
            readonly name: "basicOrderType";
            readonly type: "uint8";
        }, {
            readonly name: "startTime";
            readonly type: "uint256";
        }, {
            readonly name: "endTime";
            readonly type: "uint256";
        }, {
            readonly name: "zoneHash";
            readonly type: "uint256";
        }, {
            readonly name: "salt";
            readonly type: "uint256";
        }, {
            readonly name: "offererConduitKey";
            readonly type: "uint256";
        }, {
            readonly name: "fulfillerConduitKey";
            readonly type: "uint256";
        }, {
            readonly name: "totalOriginalAdditionalRecipients";
            readonly type: "uint256";
        }, {
            readonly name: "signature";
            readonly type: "bytes";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "fulfilled";
        readonly type: "bool";
    }];
}, {
    readonly name: "cancel";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "orders";
        readonly type: "tuple[]";
        readonly components: readonly [{
            readonly name: "offerer";
            readonly type: "address";
        }, {
            readonly name: "zone";
            readonly type: "address";
        }, {
            readonly name: "zoneHash";
            readonly type: "uint256";
        }, {
            readonly name: "salt";
            readonly type: "uint256";
        }, {
            readonly name: "conduitKey";
            readonly type: "uint256";
        }, {
            readonly name: "counter";
            readonly type: "uint256";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "cancelled";
        readonly type: "bool";
    }];
}];
//# sourceMappingURL=abis.d.ts.map