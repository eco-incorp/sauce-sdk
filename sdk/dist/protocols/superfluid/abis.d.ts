export declare const CFAForwarderABI: readonly [{
    readonly name: "createFlow";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "sender";
        readonly type: "address";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "flowrate";
        readonly type: "uint128";
    }, {
        readonly name: "userData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
}, {
    readonly name: "updateFlow";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "sender";
        readonly type: "address";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "flowrate";
        readonly type: "uint128";
    }, {
        readonly name: "userData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
}, {
    readonly name: "deleteFlow";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "sender";
        readonly type: "address";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "userData";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
}];
//# sourceMappingURL=abis.d.ts.map