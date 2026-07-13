export declare const HopL1BridgeABI: readonly [{
    readonly name: "sendToL2";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "chainId";
        readonly type: "uint256";
    }, {
        readonly name: "recipient";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "amountOutMin";
        readonly type: "uint256";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }, {
        readonly name: "relayer";
        readonly type: "address";
    }, {
        readonly name: "relayerFee";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
export declare const HopL2AmmWrapperABI: readonly [{
    readonly name: "swapAndSend";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "chainId";
        readonly type: "uint256";
    }, {
        readonly name: "recipient";
        readonly type: "address";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "bonderFee";
        readonly type: "uint256";
    }, {
        readonly name: "amountOutMin";
        readonly type: "uint256";
    }, {
        readonly name: "deadline";
        readonly type: "uint256";
    }, {
        readonly name: "destinationAmountOutMin";
        readonly type: "uint256";
    }, {
        readonly name: "destinationDeadline";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map