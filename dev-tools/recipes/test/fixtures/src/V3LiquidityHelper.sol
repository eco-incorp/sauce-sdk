// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IUniswapV3PoolMinimal {
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external returns (uint256 amount0, uint256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Test-only helper that mints real Uniswap V3 liquidity directly against a pool's
///         `mint()` and services its `uniswapV3MintCallback`. No v3-periphery required.
/// @dev    The `payer` (the address that initiated `mint`) MUST approve this helper for both
///         pool tokens beforehand — the callback pulls owed amounts via `transferFrom(payer, pool)`.
contract V3LiquidityHelper {
    /// @notice Mint a liquidity position. Encodes `msg.sender` as the payer in the callback data.
    function mint(address pool, address recipient, int24 tickLower, int24 tickUpper, uint128 amount)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        return IUniswapV3PoolMinimal(pool).mint(recipient, tickLower, tickUpper, amount, abi.encode(msg.sender));
    }

    /// @notice Uniswap V3 mint callback. Called by the pool (msg.sender) during `mint`.
    ///         Pulls owed token amounts from the encoded payer into the pool.
    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external {
        address payer = abi.decode(data, (address));
        address pool = msg.sender; // the pool that invoked the callback
        if (amount0Owed > 0) {
            IERC20Minimal(IUniswapV3PoolMinimal(pool).token0()).transferFrom(payer, pool, amount0Owed);
        }
        if (amount1Owed > 0) {
            IERC20Minimal(IUniswapV3PoolMinimal(pool).token1()).transferFrom(payer, pool, amount1Owed);
        }
    }
}
