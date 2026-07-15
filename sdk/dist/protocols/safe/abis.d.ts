export declare const SafeABI: readonly [{
    readonly name: "execTransaction";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "value";
        readonly type: "uint256";
    }, {
        readonly name: "data";
        readonly type: "bytes";
    }, {
        readonly name: "operation";
        readonly type: "uint8";
    }, {
        readonly name: "safeTxGas";
        readonly type: "uint256";
    }, {
        readonly name: "baseGas";
        readonly type: "uint256";
    }, {
        readonly name: "gasPrice";
        readonly type: "uint256";
    }, {
        readonly name: "gasToken";
        readonly type: "address";
    }, {
        readonly name: "refundReceiver";
        readonly type: "address";
    }, {
        readonly name: "signatures";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "success";
        readonly type: "bool";
    }];
}, {
    readonly name: "getOwners";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address[]";
    }];
}, {
    readonly name: "getThreshold";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map