export declare const CurveRouterNGABI: readonly [{
    readonly name: "exchange";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "_route";
        readonly type: "address[11]";
    }, {
        readonly name: "_swap_params";
        readonly type: "uint256[5][5]";
    }, {
        readonly name: "_amount";
        readonly type: "uint256";
    }, {
        readonly name: "_expected";
        readonly type: "uint256";
    }, {
        readonly name: "_pools";
        readonly type: "address[5]";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "get_dy";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "_route";
        readonly type: "address[11]";
    }, {
        readonly name: "_swap_params";
        readonly type: "uint256[5][5]";
    }, {
        readonly name: "_amount";
        readonly type: "uint256";
    }, {
        readonly name: "_pools";
        readonly type: "address[5]";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}];
export declare const CurveStableSwapABI: readonly [{
    readonly name: "exchange";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "i";
        readonly type: "uint128";
    }, {
        readonly name: "j";
        readonly type: "uint128";
    }, {
        readonly name: "dx";
        readonly type: "uint256";
    }, {
        readonly name: "min_dy";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "exchange_underlying";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "i";
        readonly type: "uint128";
    }, {
        readonly name: "j";
        readonly type: "uint128";
    }, {
        readonly name: "dx";
        readonly type: "uint256";
    }, {
        readonly name: "min_dy";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "add_liquidity";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "amounts";
        readonly type: "uint256[]";
    }, {
        readonly name: "min_mint_amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "remove_liquidity";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_amount";
        readonly type: "uint256";
    }, {
        readonly name: "min_amounts";
        readonly type: "uint256[]";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256[]";
    }];
}, {
    readonly name: "remove_liquidity_one_coin";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "_token_amount";
        readonly type: "uint256";
    }, {
        readonly name: "i";
        readonly type: "uint128";
    }, {
        readonly name: "min_amount";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "get_dy";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "i";
        readonly type: "uint128";
    }, {
        readonly name: "j";
        readonly type: "uint128";
    }, {
        readonly name: "dx";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}, {
    readonly name: "get_virtual_price";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "uint256";
    }];
}];
export declare const CurveAddressProviderABI: readonly [{
    readonly name: "get_registry";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
}, {
    readonly name: "get_address";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly name: "_id";
        readonly type: "uint256";
    }];
    readonly outputs: readonly [{
        readonly name: "";
        readonly type: "address";
    }];
}];
//# sourceMappingURL=abis.d.ts.map