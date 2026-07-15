export declare const SiloABI: readonly [{
    readonly name: "deposit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "asset";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "collateralOnly";
        readonly type: "bool";
    }];
    readonly outputs: readonly [{
        readonly name: "collateralAmount";
        readonly type: "uint256";
    }, {
        readonly name: "collateralShare";
        readonly type: "uint256";
    }];
}, {
    readonly name: "withdraw";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "asset";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "collateralOnly";
        readonly type: "bool";
    }];
    readonly outputs: readonly [{
        readonly name: "withdrawnAmount";
        readonly type: "uint256";
    }];
}, {
    readonly name: "borrow";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "asset";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "debtAmount";
        readonly type: "uint256";
    }, {
        readonly name: "debtShare";
        readonly type: "uint256";
    }];
}, {
    readonly name: "repay";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "asset";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "repaidAmount";
        readonly type: "uint256";
    }, {
        readonly name: "repaidShare";
        readonly type: "uint256";
    }];
}];
export declare const SiloRepositoryABI: readonly [{
    readonly name: "getSilo";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "asset";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "silo";
        readonly type: "address";
    }];
}];
//# sourceMappingURL=abis.d.ts.map