export declare const VaultABI: readonly [{
    readonly name: "swap";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_tokenIn";
        readonly type: "address";
    }, {
        readonly name: "_tokenOut";
        readonly type: "address";
    }, {
        readonly name: "_receiver";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "increasePosition";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_account";
        readonly type: "address";
    }, {
        readonly name: "_collateralToken";
        readonly type: "address";
    }, {
        readonly name: "_indexToken";
        readonly type: "address";
    }, {
        readonly name: "_sizeDelta";
        readonly type: "uint256";
    }, {
        readonly name: "_isLong";
        readonly type: "bool";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "decreasePosition";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_account";
        readonly type: "address";
    }, {
        readonly name: "_collateralToken";
        readonly type: "address";
    }, {
        readonly name: "_indexToken";
        readonly type: "address";
    }, {
        readonly name: "_collateralDelta";
        readonly type: "uint256";
    }, {
        readonly name: "_sizeDelta";
        readonly type: "uint256";
    }, {
        readonly name: "_isLong";
        readonly type: "bool";
    }, {
        readonly name: "_receiver";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}];
export declare const PositionRouterABI: readonly [{
    readonly name: "createIncreasePosition";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_path";
        readonly type: "address[]";
    }, {
        readonly name: "_indexToken";
        readonly type: "address";
    }, {
        readonly name: "_amountIn";
        readonly type: "uint256";
    }, {
        readonly name: "_minOut";
        readonly type: "uint256";
    }, {
        readonly name: "_sizeDelta";
        readonly type: "uint256";
    }, {
        readonly name: "_isLong";
        readonly type: "bool";
    }, {
        readonly name: "_acceptablePrice";
        readonly type: "uint256";
    }, {
        readonly name: "_executionFee";
        readonly type: "uint256";
    }, {
        readonly name: "_referralCode";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "createDecreasePosition";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_path";
        readonly type: "address[]";
    }, {
        readonly name: "_indexToken";
        readonly type: "address";
    }, {
        readonly name: "_collateralDelta";
        readonly type: "uint256";
    }, {
        readonly name: "_sizeDelta";
        readonly type: "uint256";
    }, {
        readonly name: "_isLong";
        readonly type: "bool";
    }, {
        readonly name: "_receiver";
        readonly type: "address";
    }, {
        readonly name: "_acceptablePrice";
        readonly type: "uint256";
    }, {
        readonly name: "_minOut";
        readonly type: "uint256";
    }, {
        readonly name: "_executionFee";
        readonly type: "uint256";
    }, {
        readonly name: "_withdrawETH";
        readonly type: "bool";
    }];
    readonly outputs: readonly [];
}];
export declare const RouterABI: readonly [{
    readonly name: "approvePlugin";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_plugin";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "swap";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_path";
        readonly type: "address[]";
    }, {
        readonly name: "_amountIn";
        readonly type: "uint256";
    }, {
        readonly name: "_minOut";
        readonly type: "uint256";
    }, {
        readonly name: "_receiver";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map