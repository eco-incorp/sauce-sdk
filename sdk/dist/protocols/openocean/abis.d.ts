export declare const OpenOceanExchangeV2ABI: readonly [{
    readonly name: "swap";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "caller";
        readonly type: "address";
    }, {
        readonly name: "desc";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "srcToken";
            readonly type: "address";
        }, {
            readonly name: "dstToken";
            readonly type: "address";
        }, {
            readonly name: "srcReceiver";
            readonly type: "address";
        }, {
            readonly name: "dstReceiver";
            readonly type: "address";
        }, {
            readonly name: "amount";
            readonly type: "uint256";
        }, {
            readonly name: "minReturnAmount";
            readonly type: "uint256";
        }, {
            readonly name: "guaranteedAmount";
            readonly type: "uint256";
        }, {
            readonly name: "flags";
            readonly type: "uint256";
        }, {
            readonly name: "referrer";
            readonly type: "address";
        }, {
            readonly name: "permit";
            readonly type: "bytes";
        }];
    }, {
        readonly name: "calls";
        readonly type: "bytes";
    }];
    readonly outputs: readonly [{
        readonly name: "returnAmount";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map