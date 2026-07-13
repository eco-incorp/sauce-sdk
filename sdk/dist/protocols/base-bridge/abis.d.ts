export declare const BaseL1StandardBridgeABI: readonly [{
    readonly name: "depositETH";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_minGasLimit";
        readonly type: "uint32";
    }, {
        readonly name: "_extraData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "depositERC20";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_l1Token";
        readonly type: "address";
    }, {
        readonly name: "_l2Token";
        readonly type: "address";
    }, {
        readonly name: "_amount";
        readonly type: "uint256";
    }, {
        readonly name: "_minGasLimit";
        readonly type: "uint32";
    }, {
        readonly name: "_extraData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "depositETHTo";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_to";
        readonly type: "address";
    }, {
        readonly name: "_minGasLimit";
        readonly type: "uint32";
    }, {
        readonly name: "_extraData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "depositERC20To";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_l1Token";
        readonly type: "address";
    }, {
        readonly name: "_l2Token";
        readonly type: "address";
    }, {
        readonly name: "_to";
        readonly type: "address";
    }, {
        readonly name: "_amount";
        readonly type: "uint256";
    }, {
        readonly name: "_minGasLimit";
        readonly type: "uint32";
    }, {
        readonly name: "_extraData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map