// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Local LIQUIDCORE ROUTER fixture — the DISCOVERY surface the recipe touches (probed live
/// on HyperEVM 2026-07-04): `getPoolForPair(tokenA, tokenB)` is UNORDERED (both argument orders
/// return the pair's SINGLE pool; zero when none) and `getPools()` enumerates every registered pool
/// (the REAL router's list carries a zero entry — reproduced by `registerZeroEntry` so consumers
/// prove they filter it). The recipe's HOT path never calls the router (quotes + swaps target the
/// POOL directly — router.estimateSwap forwards to the same pool, probed IDENTICAL), so the fixture
/// only implements discovery.
contract LiquidCoreRouter {
    error LCUnknownPair(); // the real router's 0x9c754bc5 unknown-pair class (estimateSwap only)

    address[] private _pools;
    mapping(bytes32 => address) private _poolForPair;

    function _pairKey(address a, address b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function registerPool(address pool, address tokenA, address tokenB) external {
        _pools.push(pool);
        _poolForPair[_pairKey(tokenA, tokenB)] = pool;
    }

    /// @notice The REAL router's list carries a zero entry — tests add one to pin the filter.
    function registerZeroEntry() external {
        _pools.push(address(0));
    }

    function getPools() external view returns (address[] memory pools) {
        return _pools;
    }

    /// @notice UNORDERED pair→pool getter (probed: both orders return the same pool; zero ⇒ none).
    function getPoolForPair(address tokenA, address tokenB) external view returns (address pool) {
        return _poolForPair[_pairKey(tokenA, tokenB)];
    }
}
