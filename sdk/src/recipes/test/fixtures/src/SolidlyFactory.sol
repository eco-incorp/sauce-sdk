// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Minimal Solidly-family (Aerodrome/Velodrome/Thena) factory REGISTRY for local EVM tests.
///
/// Solidly factories key pools by (tokenA, tokenB, bool stable) — `getPool(a, b, stable)` — NOT the
/// `getPair(a, b)` a Uniswap-V2 factory exposes, and they carry a per-pool swap fee readable via
/// `getFee(pool, stable)`. EcoSwap discovers Solidly VOLATILE (vAMM) pools OFF-CHAIN via
/// getPool(a, b, false) (the on-chain lens can't — feeding a Solidly factory to it would revert, since
/// the lens's V2 path calls getPair). This shim records the pool + its fee so that discovery finds it,
/// registering both token orderings. `getFee` is stable-agnostic (a test stands up one pool per query).
contract SolidlyFactory {
    mapping(bytes32 => address) private _pools;
    mapping(address => uint256) private _fees;

    function _key(address a, address b, bool stable) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b, stable)) : keccak256(abi.encode(b, a, stable));
    }

    /// @notice Register `pool` for the (tokenA, tokenB, stable) triple (both orderings).
    function setPool(address tokenA, address tokenB, bool stable, address pool) external {
        _pools[_key(tokenA, tokenB, stable)] = pool;
    }

    /// @notice Set the per-pool fee (in the SAME units the fork's real getFee returns — bps for
    ///         Velodrome/Aerodrome; discovery normalises bps→ppm).
    function setFee(address pool, uint256 fee) external {
        _fees[pool] = fee;
    }

    function getPool(address tokenA, address tokenB, bool stable) external view returns (address) {
        return _pools[_key(tokenA, tokenB, stable)];
    }

    function getFee(address pool, bool /* stable */) external view returns (uint256) {
        return _fees[pool];
    }
}
