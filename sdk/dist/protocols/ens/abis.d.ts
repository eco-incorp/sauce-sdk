export declare const ENSRegistryABI: readonly [{
    readonly name: "owner";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "node";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
}, {
    readonly name: "resolver";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "node";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
}, {
    readonly name: "setOwner";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "node";
        readonly type: "uint256";
    }, {
        readonly name: "owner";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "setResolver";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "node";
        readonly type: "uint256";
    }, {
        readonly name: "resolver";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}];
export declare const BaseRegistrarABI: readonly [{
    readonly name: "nameExpires";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "id";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "reclaim";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "id";
        readonly type: "uint256";
    }, {
        readonly name: "owner";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map