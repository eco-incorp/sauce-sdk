export declare const AggregatorV3ABI: readonly [{
    readonly name: "latestRoundData";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "roundId";
        readonly type: "uint128";
    }, {
        readonly name: "answer";
        readonly type: "uint256";
    }, {
        readonly name: "startedAt";
        readonly type: "uint256";
    }, {
        readonly name: "updatedAt";
        readonly type: "uint256";
    }, {
        readonly name: "answeredInRound";
        readonly type: "uint128";
    }];
}, {
    readonly name: "decimals";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint8";
    }];
}];
export declare const FeedRegistryABI: readonly [{
    readonly name: "latestRoundData";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly name: "quote";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "roundId";
        readonly type: "uint128";
    }, {
        readonly name: "answer";
        readonly type: "uint256";
    }, {
        readonly name: "startedAt";
        readonly type: "uint256";
    }, {
        readonly name: "updatedAt";
        readonly type: "uint256";
    }, {
        readonly name: "answeredInRound";
        readonly type: "uint128";
    }];
}, {
    readonly name: "getFeed";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "base";
        readonly type: "address";
    }, {
        readonly name: "quote";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "aggregator";
        readonly type: "address";
    }];
}];
//# sourceMappingURL=abis.d.ts.map