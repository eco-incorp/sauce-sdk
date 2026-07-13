export declare const ControllerABI: readonly [{
    readonly name: "mintPowerPerpAmount";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_vaultId";
        readonly type: "uint256";
    }, {
        readonly name: "_powerPerpAmount";
        readonly type: "uint256";
    }, {
        readonly name: "_uniTokenId";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }, {
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "burnPowerPerpAmount";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_vaultId";
        readonly type: "uint256";
    }, {
        readonly name: "_powerPerpAmount";
        readonly type: "uint256";
    }, {
        readonly name: "_withdrawAmount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "deposit";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_vaultId";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "withdraw";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_vaultId";
        readonly type: "uint256";
    }, {
        readonly name: "_amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map