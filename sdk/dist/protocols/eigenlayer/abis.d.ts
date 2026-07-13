export declare const StrategyManagerABI: readonly [{
    readonly name: "depositIntoStrategy";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "strategy";
        readonly type: "address";
    }, {
        readonly name: "token";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "shares";
        readonly type: "uint256";
    }];
}, {
    readonly name: "stakerStrategyShares";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "staker";
        readonly type: "address";
    }, {
        readonly name: "strategy";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}];
export declare const DelegationManagerABI: readonly [{
    readonly name: "delegateTo";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "operator";
        readonly type: "address";
    }, {
        readonly name: "approverSignatureAndExpiry";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "signature";
            readonly type: "bytes";
        }, {
            readonly name: "expiry";
            readonly type: "uint256";
        }];
    }, {
        readonly name: "approverSalt";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "undelegate";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "staker";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "withdrawalRoots";
        readonly type: "uint256[]";
    }];
}, {
    readonly name: "isDelegated";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "staker";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "bool";
    }];
}];
export declare const StrategyABI: readonly [{
    readonly name: "sharesToUnderlyingView";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "amountShares";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "underlyingToSharesView";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "amountUnderlying";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map