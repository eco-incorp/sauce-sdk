export declare const DiamondABI: readonly [{
    readonly name: "trade";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "poolKey";
        readonly type: "uint256";
    }, {
        readonly name: "size";
        readonly type: "uint256";
    }, {
        readonly name: "isBuy";
        readonly type: "bool";
    }, {
        readonly name: "premiumLimit";
        readonly type: "uint256";
    }, {
        readonly name: "referrer";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "totalPremium";
        readonly type: "uint256";
    }];
}, {
    readonly name: "exercise";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "holder";
        readonly type: "address";
    }, {
        readonly name: "longTokenId";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "exerciseValue";
        readonly type: "uint256";
    }];
}, {
    readonly name: "settle";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "holder";
        readonly type: "address";
    }, {
        readonly name: "shortTokenId";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "collateral";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map