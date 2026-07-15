export declare const AcrossSpokePoolABI: readonly [{
    readonly name: "depositV3";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "depositor";
        readonly type: "address";
    }, {
        readonly name: "recipient";
        readonly type: "address";
    }, {
        readonly name: "inputToken";
        readonly type: "address";
    }, {
        readonly name: "outputToken";
        readonly type: "address";
    }, {
        readonly name: "inputAmount";
        readonly type: "uint256";
    }, {
        readonly name: "outputAmount";
        readonly type: "uint256";
    }, {
        readonly name: "destinationChainId";
        readonly type: "uint256";
    }, {
        readonly name: "exclusiveRelayer";
        readonly type: "address";
    }, {
        readonly name: "quoteTimestamp";
        readonly type: "uint32";
    }, {
        readonly name: "fillDeadline";
        readonly type: "uint32";
    }, {
        readonly name: "exclusivityDeadline";
        readonly type: "uint32";
    }, {
        readonly name: "message";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "deposit";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "recipient";
        readonly type: "address";
    }, {
        readonly name: "originToken";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "destinationChainId";
        readonly type: "uint256";
    }, {
        readonly name: "relayerFeePct";
        readonly type: "uint64";
    }, {
        readonly name: "quoteTimestamp";
        readonly type: "uint32";
    }, {
        readonly name: "message";
        readonly type: "bytes";
    }, {
        readonly name: "maxCount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
export declare const AcrossHubPoolABI: readonly [{
    readonly name: "liquidityUtilizationCurrent";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "l1Token";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "pooledTokens";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "l1Token";
        readonly type: "address";
    }];
    readonly outputs: readonly [{
        readonly name: "lpToken";
        readonly type: "address";
    }, {
        readonly name: "isEnabled";
        readonly type: "bool";
    }, {
        readonly name: "lastLpFeeUpdate";
        readonly type: "uint32";
    }, {
        readonly name: "utilizedReserves";
        readonly type: "uint256";
    }, {
        readonly name: "liquidReserves";
        readonly type: "uint256";
    }, {
        readonly name: "undistributedLpFees";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map