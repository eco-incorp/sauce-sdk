export declare const PendleRouterABI: readonly [{
    readonly name: "addLiquiditySingleToken";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "market";
        readonly type: "address";
    }, {
        readonly name: "minLpOut";
        readonly type: "uint256";
    }, {
        readonly name: "guessPtReceivedFromSy";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "guessMin";
            readonly type: "uint256";
        }, {
            readonly name: "guessMax";
            readonly type: "uint256";
        }, {
            readonly name: "guessOffchain";
            readonly type: "uint256";
        }, {
            readonly name: "maxIteration";
            readonly type: "uint256";
        }, {
            readonly name: "eps";
            readonly type: "uint256";
        }];
    }, {
        readonly name: "input";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "tokenIn";
            readonly type: "address";
        }, {
            readonly name: "netTokenIn";
            readonly type: "uint256";
        }, {
            readonly name: "tokenMintSy";
            readonly type: "address";
        }, {
            readonly name: "pendleSwap";
            readonly type: "address";
        }, {
            readonly name: "swapData";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "swapType";
                readonly type: "uint8";
            }, {
                readonly name: "extRouter";
                readonly type: "address";
            }, {
                readonly name: "extCalldata";
                readonly type: "bytes";
            }, {
                readonly name: "needScale";
                readonly type: "bool";
            }];
        }];
    }, {
        readonly name: "limit";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "limitRouter";
            readonly type: "address";
        }, {
            readonly name: "epsSkipMarket";
            readonly type: "uint256";
        }, {
            readonly name: "normalFills";
            readonly type: "tuple[]";
            readonly components: readonly [{
                readonly name: "order";
                readonly type: "tuple";
                readonly components: readonly [{
                    readonly name: "salt";
                    readonly type: "uint256";
                }, {
                    readonly name: "expiry";
                    readonly type: "uint256";
                }, {
                    readonly name: "nonce";
                    readonly type: "uint256";
                }, {
                    readonly name: "orderType";
                    readonly type: "uint8";
                }, {
                    readonly name: "token";
                    readonly type: "address";
                }, {
                    readonly name: "YT";
                    readonly type: "address";
                }, {
                    readonly name: "maker";
                    readonly type: "address";
                }, {
                    readonly name: "receiver";
                    readonly type: "address";
                }, {
                    readonly name: "makingAmount";
                    readonly type: "uint256";
                }, {
                    readonly name: "lnImpliedRate";
                    readonly type: "uint256";
                }, {
                    readonly name: "failSafeRate";
                    readonly type: "uint256";
                }];
            }, {
                readonly name: "signature";
                readonly type: "bytes";
            }, {
                readonly name: "makingAmount";
                readonly type: "uint256";
            }];
        }, {
            readonly name: "flashFills";
            readonly type: "tuple[]";
            readonly components: readonly [{
                readonly name: "order";
                readonly type: "tuple";
                readonly components: readonly [{
                    readonly name: "salt";
                    readonly type: "uint256";
                }, {
                    readonly name: "expiry";
                    readonly type: "uint256";
                }, {
                    readonly name: "nonce";
                    readonly type: "uint256";
                }, {
                    readonly name: "orderType";
                    readonly type: "uint8";
                }, {
                    readonly name: "token";
                    readonly type: "address";
                }, {
                    readonly name: "YT";
                    readonly type: "address";
                }, {
                    readonly name: "maker";
                    readonly type: "address";
                }, {
                    readonly name: "receiver";
                    readonly type: "address";
                }, {
                    readonly name: "makingAmount";
                    readonly type: "uint256";
                }, {
                    readonly name: "lnImpliedRate";
                    readonly type: "uint256";
                }, {
                    readonly name: "failSafeRate";
                    readonly type: "uint256";
                }];
            }, {
                readonly name: "signature";
                readonly type: "bytes";
            }, {
                readonly name: "makingAmount";
                readonly type: "uint256";
            }];
        }, {
            readonly name: "optData";
            readonly type: "bytes";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "netLpOut";
        readonly type: "uint256";
    }, {
        readonly name: "netSyFee";
        readonly type: "uint256";
    }, {
        readonly name: "netSyInterm";
        readonly type: "uint256";
    }];
}, {
    readonly name: "removeLiquiditySingleToken";
    readonly type: "function";
    readonly stateMutability: "nonpayable";
    readonly inputs: readonly [{
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "market";
        readonly type: "address";
    }, {
        readonly name: "netLpToRemove";
        readonly type: "uint256";
    }, {
        readonly name: "output";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "tokenOut";
            readonly type: "address";
        }, {
            readonly name: "minTokenOut";
            readonly type: "uint256";
        }, {
            readonly name: "tokenRedeemSy";
            readonly type: "address";
        }, {
            readonly name: "pendleSwap";
            readonly type: "address";
        }, {
            readonly name: "swapData";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "swapType";
                readonly type: "uint8";
            }, {
                readonly name: "extRouter";
                readonly type: "address";
            }, {
                readonly name: "extCalldata";
                readonly type: "bytes";
            }, {
                readonly name: "needScale";
                readonly type: "bool";
            }];
        }];
    }, {
        readonly name: "limit";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "limitRouter";
            readonly type: "address";
        }, {
            readonly name: "epsSkipMarket";
            readonly type: "uint256";
        }, {
            readonly name: "normalFills";
            readonly type: "tuple[]";
            readonly components: readonly [];
        }, {
            readonly name: "flashFills";
            readonly type: "tuple[]";
            readonly components: readonly [];
        }, {
            readonly name: "optData";
            readonly type: "bytes";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "netTokenOut";
        readonly type: "uint256";
    }, {
        readonly name: "netSyFee";
        readonly type: "uint256";
    }, {
        readonly name: "netSyInterm";
        readonly type: "uint256";
    }];
}, {
    readonly name: "swapExactTokenForPt";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "market";
        readonly type: "address";
    }, {
        readonly name: "minPtOut";
        readonly type: "uint256";
    }, {
        readonly name: "guessPtOut";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "guessMin";
            readonly type: "uint256";
        }, {
            readonly name: "guessMax";
            readonly type: "uint256";
        }, {
            readonly name: "guessOffchain";
            readonly type: "uint256";
        }, {
            readonly name: "maxIteration";
            readonly type: "uint256";
        }, {
            readonly name: "eps";
            readonly type: "uint256";
        }];
    }, {
        readonly name: "input";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "tokenIn";
            readonly type: "address";
        }, {
            readonly name: "netTokenIn";
            readonly type: "uint256";
        }, {
            readonly name: "tokenMintSy";
            readonly type: "address";
        }, {
            readonly name: "pendleSwap";
            readonly type: "address";
        }, {
            readonly name: "swapData";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "swapType";
                readonly type: "uint8";
            }, {
                readonly name: "extRouter";
                readonly type: "address";
            }, {
                readonly name: "extCalldata";
                readonly type: "bytes";
            }, {
                readonly name: "needScale";
                readonly type: "bool";
            }];
        }];
    }, {
        readonly name: "limit";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "limitRouter";
            readonly type: "address";
        }, {
            readonly name: "epsSkipMarket";
            readonly type: "uint256";
        }, {
            readonly name: "normalFills";
            readonly type: "tuple[]";
            readonly components: readonly [];
        }, {
            readonly name: "flashFills";
            readonly type: "tuple[]";
            readonly components: readonly [];
        }, {
            readonly name: "optData";
            readonly type: "bytes";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "netPtOut";
        readonly type: "uint256";
    }, {
        readonly name: "netSyFee";
        readonly type: "uint256";
    }, {
        readonly name: "netSyInterm";
        readonly type: "uint256";
    }];
}, {
    readonly name: "swapExactTokenForYt";
    readonly type: "function";
    readonly stateMutability: "payable";
    readonly inputs: readonly [{
        readonly name: "receiver";
        readonly type: "address";
    }, {
        readonly name: "market";
        readonly type: "address";
    }, {
        readonly name: "minYtOut";
        readonly type: "uint256";
    }, {
        readonly name: "guessYtOut";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "guessMin";
            readonly type: "uint256";
        }, {
            readonly name: "guessMax";
            readonly type: "uint256";
        }, {
            readonly name: "guessOffchain";
            readonly type: "uint256";
        }, {
            readonly name: "maxIteration";
            readonly type: "uint256";
        }, {
            readonly name: "eps";
            readonly type: "uint256";
        }];
    }, {
        readonly name: "input";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "tokenIn";
            readonly type: "address";
        }, {
            readonly name: "netTokenIn";
            readonly type: "uint256";
        }, {
            readonly name: "tokenMintSy";
            readonly type: "address";
        }, {
            readonly name: "pendleSwap";
            readonly type: "address";
        }, {
            readonly name: "swapData";
            readonly type: "tuple";
            readonly components: readonly [{
                readonly name: "swapType";
                readonly type: "uint8";
            }, {
                readonly name: "extRouter";
                readonly type: "address";
            }, {
                readonly name: "extCalldata";
                readonly type: "bytes";
            }, {
                readonly name: "needScale";
                readonly type: "bool";
            }];
        }];
    }, {
        readonly name: "limit";
        readonly type: "tuple";
        readonly components: readonly [{
            readonly name: "limitRouter";
            readonly type: "address";
        }, {
            readonly name: "epsSkipMarket";
            readonly type: "uint256";
        }, {
            readonly name: "normalFills";
            readonly type: "tuple[]";
            readonly components: readonly [];
        }, {
            readonly name: "flashFills";
            readonly type: "tuple[]";
            readonly components: readonly [];
        }, {
            readonly name: "optData";
            readonly type: "bytes";
        }];
    }];
    readonly outputs: readonly [{
        readonly name: "netYtOut";
        readonly type: "uint256";
    }, {
        readonly name: "netSyFee";
        readonly type: "uint256";
    }, {
        readonly name: "netSyInterm";
        readonly type: "uint256";
    }];
}];
//# sourceMappingURL=abis.d.ts.map