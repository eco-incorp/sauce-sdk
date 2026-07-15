export declare const BoosterABI: readonly [{
    readonly name: "deposit";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_pid";
        readonly type: "uint256";
    }, {
        readonly name: "_amount";
        readonly type: "uint256";
    }, {
        readonly name: "_stake";
        readonly type: "bool";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
}, {
    readonly name: "withdraw";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_pid";
        readonly type: "uint256";
    }, {
        readonly name: "_amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
}, {
    readonly name: "poolLength";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "poolInfo";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "lptoken";
        readonly type: "address";
    }, {
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "gauge";
        readonly type: "address";
    }, {
        readonly name: "crvRewards";
        readonly type: "address";
    }, {
        readonly name: "stash";
        readonly type: "address";
    }, {
        readonly name: "shutdown";
        readonly type: "bool";
    }];
}];
export declare const BaseRewardPoolABI: readonly [{
    readonly name: "getReward";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_account";
        readonly type: "address";
    }, {
        readonly name: "_claimExtras";
        readonly type: "bool";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
}, {
    readonly name: "earned";
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
    readonly name: "withdrawAndUnwrap";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "claim";
        readonly type: "bool";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
}];
//# sourceMappingURL=abis.d.ts.map