export declare const GelatoAutomateABI: readonly [{
    readonly name: "createTask";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "execAddress";
        readonly type: "address";
    }, {
        readonly name: "execDataOrSelector";
        readonly type: "bytes";
    }, {
        readonly name: "moduleData";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "modules";
            readonly type: "uint8[]";
        }, {
            readonly name: "args";
            readonly type: "bytes[]";
        }];
    }, {
        readonly name: "feeToken";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "taskId";
        readonly type: "uint256";
    }];
}, {
    readonly name: "cancelTask";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "taskId";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map