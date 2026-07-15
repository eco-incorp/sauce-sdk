export declare const CauldronABI: readonly [{
    readonly name: "addCollateral";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "skim";
        readonly type: "bool";
    }, {
        readonly name: "share";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "removeCollateral";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "share";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "borrow";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "part";
        readonly type: "uint256";
    }, {
        readonly name: "share";
        readonly type: "uint256";
    }];
}, {
    readonly name: "repay";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "skim";
        readonly type: "bool";
    }, {
        readonly name: "part";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "amount";
        readonly type: "uint256";
    }];
}, {
    readonly name: "userCollateralShare";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "user";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "userBorrowPart";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "user";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}];
export declare const DegenBoxABI: readonly [{
    readonly name: "deposit";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "from";
        readonly type: "address";
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "share";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "amountOut";
        readonly type: "uint256";
    }, {
        readonly name: "shareOut";
        readonly type: "uint256";
    }];
}, {
    readonly name: "withdraw";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "from";
        readonly type: "address";
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "share";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "amountOut";
        readonly type: "uint256";
    }, {
        readonly name: "shareOut";
        readonly type: "uint256";
    }];
}, {
    readonly name: "balanceOf";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "user";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map