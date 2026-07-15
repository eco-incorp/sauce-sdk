export declare const OrderBookABI: readonly [{
    readonly name: "placePositionOrder";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "subAccountId";
        readonly type: "uint256";
    }, {
        readonly name: "collateralAmount";
        readonly type: "uint256";
    }, {
        readonly name: "size";
        readonly type: "uint256";
    }, {
        readonly name: "price";
        readonly type: "uint256";
    }, {
        readonly name: "profitTokenId";
        readonly type: "uint8";
    }, {
        readonly name: "flags";
        readonly type: "uint8";
    }, {
        readonly name: "deadline";
        readonly type: "uint32";
    }, {
        readonly name: "referralCode";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "cancelOrder";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "orderId";
        readonly type: "uint64";
    }];
    readonly outputs: readonly [];
}];
export declare const LiquidityPoolABI: readonly [{
    readonly name: "addLiquidity";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "tokenId";
        readonly type: "uint8";
    }, {
        readonly name: "tokenAmount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "removeLiquidity";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "tokenId";
        readonly type: "uint8";
    }, {
        readonly name: "mlpAmount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map