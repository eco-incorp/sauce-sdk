export declare const MorphoABI: readonly [{
    readonly name: "supply";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "marketParams";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "loanToken";
            readonly type: "address";
        }, {
            readonly name: "collateralToken";
            readonly type: "address";
        }, {
            readonly name: "oracle";
            readonly type: "address";
        }, {
            readonly name: "irm";
            readonly type: "address";
        }, {
            readonly name: "lltv";
            readonly type: "uint256";
        }];
    }, {
        readonly name: "assets";
        readonly type: "uint256";
    }, {
        readonly name: "shares";
        readonly type: "uint256";
    }, {
        readonly name: "onBehalf";
        readonly type: "address";
    }, {
        readonly name: "data";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "assetsSupplied";
        readonly type: "uint256";
    }, {
        readonly name: "sharesSupplied";
        readonly type: "uint256";
    }];
}, {
    readonly name: "withdraw";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "marketParams";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "loanToken";
            readonly type: "address";
        }, {
            readonly name: "collateralToken";
            readonly type: "address";
        }, {
            readonly name: "oracle";
            readonly type: "address";
        }, {
            readonly name: "irm";
            readonly type: "address";
        }, {
            readonly name: "lltv";
            readonly type: "uint256";
        }];
    }, {
        readonly name: "assets";
        readonly type: "uint256";
    }, {
        readonly name: "shares";
        readonly type: "uint256";
    }, {
        readonly name: "onBehalf";
        readonly type: "address";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "assetsWithdrawn";
        readonly type: "uint256";
    }, {
        readonly name: "sharesWithdrawn";
        readonly type: "uint256";
    }];
}, {
    readonly name: "borrow";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "marketParams";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "loanToken";
            readonly type: "address";
        }, {
            readonly name: "collateralToken";
            readonly type: "address";
        }, {
            readonly name: "oracle";
            readonly type: "address";
        }, {
            readonly name: "irm";
            readonly type: "address";
        }, {
            readonly name: "lltv";
            readonly type: "uint256";
        }];
    }, {
        readonly name: "assets";
        readonly type: "uint256";
    }, {
        readonly name: "shares";
        readonly type: "uint256";
    }, {
        readonly name: "onBehalf";
        readonly type: "address";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "assetsBorrowed";
        readonly type: "uint256";
    }, {
        readonly name: "sharesBorrowed";
        readonly type: "uint256";
    }];
}, {
    readonly name: "repay";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "marketParams";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "loanToken";
            readonly type: "address";
        }, {
            readonly name: "collateralToken";
            readonly type: "address";
        }, {
            readonly name: "oracle";
            readonly type: "address";
        }, {
            readonly name: "irm";
            readonly type: "address";
        }, {
            readonly name: "lltv";
            readonly type: "uint256";
        }];
    }, {
        readonly name: "assets";
        readonly type: "uint256";
    }, {
        readonly name: "shares";
        readonly type: "uint256";
    }, {
        readonly name: "onBehalf";
        readonly type: "address";
    }, {
        readonly name: "data";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "assetsRepaid";
        readonly type: "uint256";
    }, {
        readonly name: "sharesRepaid";
        readonly type: "uint256";
    }];
}, {
    readonly name: "supplyCollateral";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "marketParams";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "loanToken";
            readonly type: "address";
        }, {
            readonly name: "collateralToken";
            readonly type: "address";
        }, {
            readonly name: "oracle";
            readonly type: "address";
        }, {
            readonly name: "irm";
            readonly type: "address";
        }, {
            readonly name: "lltv";
            readonly type: "uint256";
        }];
    }, {
        readonly name: "assets";
        readonly type: "uint256";
    }, {
        readonly name: "onBehalf";
        readonly type: "address";
    }, {
        readonly name: "data";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "withdrawCollateral";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "marketParams";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "loanToken";
            readonly type: "address";
        }, {
            readonly name: "collateralToken";
            readonly type: "address";
        }, {
            readonly name: "oracle";
            readonly type: "address";
        }, {
            readonly name: "irm";
            readonly type: "address";
        }, {
            readonly name: "lltv";
            readonly type: "uint256";
        }];
    }, {
        readonly name: "assets";
        readonly type: "uint256";
    }, {
        readonly name: "onBehalf";
        readonly type: "address";
    }, {
        readonly name: "receiver";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map