export declare const CrocSwapDexABI: readonly [{
    readonly name: "swap";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly name: "quote";
        readonly type: "address";
    }, {
        readonly name: "poolIdx";
        readonly type: "uint256";
    }, {
        readonly name: "isBuy";
        readonly type: "bool";
    }, {
        readonly name: "inBaseQty";
        readonly type: "bool";
    }, {
        readonly name: "qty";
        readonly type: "uint128";
    }, {
        readonly name: "tip";
        readonly type: "uint16";
    }, {
        readonly name: "limitPrice";
        readonly type: "uint128";
    }, {
        readonly name: "minOut";
        readonly type: "uint128";
    }, {
        readonly name: "reserveFlags";
        readonly type: "uint8";
    }];
    readonly outputs: readonly [{
        readonly name: "baseFlow";
        readonly type: "uint128";
    }, {
        readonly name: "quoteFlow";
        readonly type: "uint128";
    }];
}, {
    readonly name: "userCmd";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "callpath";
        readonly type: "uint16";
    }, {
        readonly name: "cmd";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "result";
        readonly type: "bytes";
    }];
}];
//# sourceMappingURL=abis.d.ts.map