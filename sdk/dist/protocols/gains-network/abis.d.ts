export declare const DiamondABI: readonly [{
    readonly name: "openTrade";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "t";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "trader";
            readonly type: "address";
        }, {
            readonly name: "pairIndex";
            readonly type: "uint256";
        }, {
            readonly name: "index";
            readonly type: "uint256";
        }, {
            readonly name: "initialPosToken";
            readonly type: "uint256";
        }, {
            readonly name: "positionSizeDai";
            readonly type: "uint256";
        }, {
            readonly name: "openPrice";
            readonly type: "uint256";
        }, {
            readonly name: "buy";
            readonly type: "bool";
        }, {
            readonly name: "leverage";
            readonly type: "uint256";
        }, {
            readonly name: "tp";
            readonly type: "uint256";
        }, {
            readonly name: "sl";
            readonly type: "uint256";
        }];
    }, {
        readonly name: "orderType";
        readonly type: "uint8";
    }, {
        readonly name: "slippageP";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "closeTradeMarket";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "pairIndex";
        readonly type: "uint256";
    }, {
        readonly name: "index";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "updateSl";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "pairIndex";
        readonly type: "uint256";
    }, {
        readonly name: "index";
        readonly type: "uint256";
    }, {
        readonly name: "newSl";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "updateTp";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "pairIndex";
        readonly type: "uint256";
    }, {
        readonly name: "index";
        readonly type: "uint256";
    }, {
        readonly name: "newTp";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map