export declare const AxelarGatewayABI: readonly [{
    readonly name: "callContract";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "destinationChain";
        readonly type: "string";
    }, {
        readonly name: "contractAddress";
        readonly type: "string";
    }, {
        readonly name: "payload";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "callContractWithToken";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "destinationChain";
        readonly type: "string";
    }, {
        readonly name: "contractAddress";
        readonly type: "string";
    }, {
        readonly name: "payload";
        readonly type: "bytes";
    }, {
        readonly name: "symbol";
        readonly type: "string";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "sendToken";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "destinationChain";
        readonly type: "string";
    }, {
        readonly name: "destinationAddress";
        readonly type: "string";
    }, {
        readonly name: "symbol";
        readonly type: "string";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}, {
    readonly name: "tokenAddresses";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "symbol";
        readonly type: "string";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
}];
export declare const AxelarGasServiceABI: readonly [{
    readonly name: "payNativeGasForContractCall";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "sender";
        readonly type: "address";
    }, {
        readonly name: "destinationChain";
        readonly type: "string";
    }, {
        readonly name: "destinationAddress";
        readonly type: "string";
    }, {
        readonly name: "payload";
        readonly type: "bytes";
    }, {
        readonly name: "refundAddress";
        readonly type: "address";
    }];
    readonly outputs: readonly [];
}];
export declare const AxelarITSABI: readonly [{
    readonly name: "interchainTransfer";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "tokenId";
        readonly type: "uint256";
    }, {
        readonly name: "destinationChain";
        readonly type: "string";
    }, {
        readonly name: "destinationAddress";
        readonly type: "bytes";
    }, {
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly name: "metadata";
        readonly type: "bytes";
    }, {
        readonly name: "gasValue";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [];
}];
//# sourceMappingURL=abis.d.ts.map