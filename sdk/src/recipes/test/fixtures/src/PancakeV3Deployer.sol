// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title Local deployer + factory shim for GENUINE PancakeSwap V3 pools.
/// @notice PancakeSwap V3 ships its `PancakeV3Pool` as prebuilt artifact bytecode but
///         NOT its concrete `PancakeV3PoolDeployer` source, and the real factory needs
///         that deployer. The pool's constructor takes no args — it reads its immutables
///         from `IPancakeV3PoolDeployer(msg.sender).parameters()`. So this contract stands
///         in for the deployer: it sets `parameters` transiently, `CREATE`s the pool from
///         the (externally-supplied) Pancake pool creation code, then clears them — exactly
///         mirroring `PancakeV3PoolDeployer.deploy`. The resulting pool is byte-identical to
///         a mainnet Pancake pool, so it calls `pancakeV3SwapCallback` / `pancakeV3MintCallback`
///         (the whole point: it exercises the engine's Pancake callback path, not Uniswap's).
/// @dev    Doubles as a minimal V3 `getPool(tokenA, tokenB, fee)` registry so the recipe's
///         V3Standard discovery resolves the locally-created pool exactly like a real factory.
contract PancakeV3Deployer {
    /// Layout MUST match IPancakeV3PoolDeployer.parameters() so the pool ctor decodes it:
    /// (address factory, address token0, address token1, uint24 fee, int24 tickSpacing).
    struct Parameters {
        address factory;
        address token0;
        address token1;
        uint24 fee;
        int24 tickSpacing;
    }

    Parameters public parameters;

    // getPool[token0][token1][fee] — populated for BOTH token orderings (factory-symmetric).
    mapping(address => mapping(address => mapping(uint24 => address))) private _pools;

    /// @notice Create a genuine PancakeV3Pool for (tokenA, tokenB, fee) at `tickSpacing`,
    ///         using the supplied Pancake pool creation bytecode. Returns the pool address.
    function createPool(
        bytes memory creationCode,
        address tokenA,
        address tokenB,
        uint24 fee,
        int24 tickSpacing
    ) external returns (address pool) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(_pools[token0][token1][fee] == address(0), "pool exists");

        // Set transiently; the pool reads these via parameters() during construction.
        parameters = Parameters({factory: address(this), token0: token0, token1: token1, fee: fee, tickSpacing: tickSpacing});
        assembly {
            pool := create(0, add(creationCode, 0x20), mload(creationCode))
        }
        require(pool != address(0), "pancake pool create failed");
        delete parameters;

        _pools[token0][token1][fee] = pool;
        _pools[token1][token0][fee] = pool;
    }

    /// @notice Uniswap/Pancake-factory-compatible lookup used by recipe discovery.
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return _pools[tokenA][tokenB][fee];
    }
}
