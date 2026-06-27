// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Minimal Uniswap-V2-style factory REGISTRY for local EVM tests.
///
/// EcoSwap discovery resolves V2 pools via `getPair(tokenA, tokenB)`. The harness
/// etches the pair bytecode itself (see V2Pair.sol) and just records the address
/// here so discovery finds it. `setPair` registers both token orderings.
contract V2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function setPair(address tokenA, address tokenB, address pair) external {
        getPair[tokenA][tokenB] = pair;
        getPair[tokenB][tokenA] = pair;
    }
}
