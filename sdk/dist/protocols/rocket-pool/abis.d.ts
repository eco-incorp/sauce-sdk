export declare const RocketDepositPoolABI: readonly [{
    readonly name: "deposit";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [];
    readonly outputs: readonly [];
}];
export declare const RETHABI: readonly [{
    readonly name: "getExchangeRate";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "getRethValue";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "_ethAmount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "getEthValue";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "_rethAmount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "burn";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_rethAmount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
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
}];
//# sourceMappingURL=abis.d.ts.map