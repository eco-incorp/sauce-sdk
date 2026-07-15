export declare const LineaL1MessageServiceABI: readonly [{
    readonly name: "sendMessage";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_to";
        readonly type: "address";
    }, {
        readonly name: "_fee";
        readonly type: "uint256";
    }, {
        readonly name: "_calldata";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "claimMessage";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_from";
        readonly type: "address";
    }, {
        readonly name: "_to";
        readonly type: "address";
    }, {
        readonly name: "_fee";
        readonly type: "uint256";
    }, {
        readonly name: "_value";
        readonly type: "uint256";
    }, {
        readonly name: "_feeRecipient";
        readonly type: "address";
    }, {
        readonly name: "_calldata";
        readonly type: "bytes";
    }, {
        readonly name: "_nonce";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map