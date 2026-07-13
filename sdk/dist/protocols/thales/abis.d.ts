export declare const ThalesAMMABI: readonly [{
    readonly name: "buyFromAMM";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "market";
        readonly type: "address";
    }, {
        readonly name: "position";
        readonly type: "uint8";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "expectedPayout";
        readonly type: "uint256";
    }, {
        readonly name: "additionalSlippage";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "exerciseMaturedMarket";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "market";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}];
export declare const SpeedMarketsAMMABI: readonly [{
    readonly name: "createNewMarket";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "asset";
        readonly type: "uint256";
    }, {
        readonly name: "strikeTime";
        readonly type: "uint64";
    }, {
        readonly name: "direction";
        readonly type: "uint8";
    }, {
        readonly name: "collateral";
        readonly type: "address";
    }, {
        readonly name: "buyinAmount";
        readonly type: "uint256";
    }, {
        readonly name: "referrer";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map