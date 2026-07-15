export declare const HyperlaneMailboxABI: readonly [{
    readonly name: "dispatch";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_destinationDomain";
        readonly type: "uint32";
    }, {
        readonly name: "_recipientAddress";
        readonly type: "uint256";
    }, {
        readonly name: "_messageBody";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "quoteDispatch";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "_destinationDomain";
        readonly type: "uint32";
    }, {
        readonly name: "_recipientAddress";
        readonly type: "uint256";
    }, {
        readonly name: "_messageBody";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "process";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_metadata";
        readonly type: "bytes";
    }, {
        readonly name: "_message";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "delivered";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "_id";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
}];
//# sourceMappingURL=abis.d.ts.map