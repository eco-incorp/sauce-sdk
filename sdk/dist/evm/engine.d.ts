import { type Address, type Hex } from 'viem';
/** V12Pot — `cook()` is onlyOwner; the bytecodes are the `ingredients`. */
export declare const v12PotAbi: readonly [{
    readonly name: "cook";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly type: "bytes[]";
        readonly name: "ingredients";
    }];
    readonly outputs: readonly [{
        readonly type: "bytes";
    }];
}, {
    readonly name: "owner";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "router";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "v12Runtime";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}];
/** V12Kitchen — CREATE2 Pot factory. `deployPot` bakes `owner` into the Pot's CREATE2 address. */
export declare const v12KitchenAbi: readonly [{
    readonly name: "deployPot";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
        readonly name: "pot";
    }];
}, {
    readonly name: "predictPot";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [{
        readonly type: "address";
        readonly name: "owner";
    }, {
        readonly type: "bytes32";
        readonly name: "salt";
    }];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "router";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}, {
    readonly name: "v12Runtime";
    readonly type: "function";
    readonly stateMutability: "view";
    readonly inputs: readonly [];
    readonly outputs: readonly [{
        readonly type: "address";
    }];
}];
/** Ready-to-use V12Pot handle: the viem ABI plus calldata encoders for route/batch legs. */
export declare const v12Pot: {
    readonly abi: readonly [{
        readonly name: "cook";
        readonly type: "function";
        readonly stateMutability: "payable";
        readonly inputs: readonly [{
            readonly type: "bytes[]";
            readonly name: "ingredients";
        }];
        readonly outputs: readonly [{
            readonly type: "bytes";
        }];
    }, {
        readonly name: "owner";
        readonly type: "function";
        readonly stateMutability: "view";
        readonly inputs: readonly [];
        readonly outputs: readonly [{
            readonly type: "address";
        }];
    }, {
        readonly name: "router";
        readonly type: "function";
        readonly stateMutability: "view";
        readonly inputs: readonly [];
        readonly outputs: readonly [{
            readonly type: "address";
        }];
    }, {
        readonly name: "v12Runtime";
        readonly type: "function";
        readonly stateMutability: "view";
        readonly inputs: readonly [];
        readonly outputs: readonly [{
            readonly type: "address";
        }];
    }];
    /** Encode `cook(ingredients)` calldata; each ingredient is a compiled sauce bytecode blob. */
    readonly encodeCook: (ingredients: readonly Hex[]) => Hex;
};
/** Ready-to-use V12Kitchen handle: the viem ABI plus calldata encoders. */
export declare const v12Kitchen: {
    readonly abi: readonly [{
        readonly name: "deployPot";
        readonly type: "function";
        readonly stateMutability: "nonpayable";
        readonly inputs: readonly [{
            readonly type: "address";
            readonly name: "owner";
        }, {
            readonly type: "bytes32";
            readonly name: "salt";
        }];
        readonly outputs: readonly [{
            readonly type: "address";
            readonly name: "pot";
        }];
    }, {
        readonly name: "predictPot";
        readonly type: "function";
        readonly stateMutability: "view";
        readonly inputs: readonly [{
            readonly type: "address";
            readonly name: "owner";
        }, {
            readonly type: "bytes32";
            readonly name: "salt";
        }];
        readonly outputs: readonly [{
            readonly type: "address";
        }];
    }, {
        readonly name: "router";
        readonly type: "function";
        readonly stateMutability: "view";
        readonly inputs: readonly [];
        readonly outputs: readonly [{
            readonly type: "address";
        }];
    }, {
        readonly name: "v12Runtime";
        readonly type: "function";
        readonly stateMutability: "view";
        readonly inputs: readonly [];
        readonly outputs: readonly [{
            readonly type: "address";
        }];
    }];
    /** Encode `deployPot(owner, salt)` calldata. `owner` is baked into the Pot's CREATE2 address. */
    readonly encodeDeployPot: (owner: Address, salt: Hex) => Hex;
    /** Encode `predictPot(owner, salt)` calldata (a view call returning the Pot address). */
    readonly encodePredictPot: (owner: Address, salt: Hex) => Hex;
};
//# sourceMappingURL=engine.d.ts.map