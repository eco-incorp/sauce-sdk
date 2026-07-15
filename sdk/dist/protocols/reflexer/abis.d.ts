export declare const SAFEEngineABI: readonly [{
    readonly name: "modifySAFECollateralization";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "collateralType";
        readonly type: "uint256";
    }, {
        readonly name: "safe";
        readonly type: "address";
    }, {
        readonly name: "collateralSource";
        readonly type: "address";
    }, {
        readonly name: "debtDestination";
        readonly type: "address";
    }, {
        readonly name: "deltaCollateral";
        readonly type: "uint256";
    }, {
        readonly name: "deltaDebt";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "safes";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "collateralType";
        readonly type: "uint256";
    }, {
        readonly name: "safe";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "lockedCollateral";
        readonly type: "uint256";
    }, {
        readonly name: "generatedDebt";
        readonly type: "uint256";
    }];
}];
export declare const CoinJoinABI: readonly [{
    readonly name: "join";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }, {
        readonly name: "wad";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "exit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }, {
        readonly name: "wad";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
export declare const ETHJoinABI: readonly [{
    readonly name: "join";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "exit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }, {
        readonly name: "wad";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map