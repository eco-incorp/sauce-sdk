export declare const UniProxyABI: readonly [{
    readonly name: "deposit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "deposit0";
        readonly type: "uint256";
    }, {
        readonly name: "deposit1";
        readonly type: "uint256";
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "pos";
        readonly type: "address";
    }, {
        readonly name: "minIn";
        readonly type: "uint256[4]";
    }];
    readonly outputs: readonly [{
        readonly name: "shares";
        readonly type: "uint256";
    }];
}, {
    readonly name: "getDepositAmount";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "pos";
        readonly type: "address";
    }, {
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "_deposit";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "amountStart";
        readonly type: "uint256";
    }, {
        readonly name: "amountEnd";
        readonly type: "uint256";
    }];
}];
export declare const HypervisorABI: readonly [{
    readonly name: "withdraw";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "shares";
        readonly type: "uint256";
    }, {
        readonly name: "to";
        readonly type: "address";
    }, {
        readonly name: "from";
        readonly type: "address";
    }, {
        readonly name: "minAmounts";
        readonly type: "uint256[4]";
    }];
    readonly outputs: readonly [{
        readonly name: "amount0";
        readonly type: "uint256";
    }, {
        readonly name: "amount1";
        readonly type: "uint256";
    }];
}, {
    readonly name: "balanceOf";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "account";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "totalSupply";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "getTotalAmounts";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "total0";
        readonly type: "uint256";
    }, {
        readonly name: "total1";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map