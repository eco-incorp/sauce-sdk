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
/// @dev    Two funding modes, distinguished by the payer encoded in the callback data:
///         - `mint`      → payer = msg.sender; callback pulls via `transferFrom(payer, pool)`,
///                         so the payer MUST approve this helper for both tokens beforehand.
///         - `batchMint` → payer = address(this); callback pays from the helper's OWN balance
///                         via `transfer`, so the helper MUST be funded with both tokens first.
///           batchMint collapses N position mints into ONE transaction (used to reproduce a
///           real pool's tick profile — hundreds of positions — without one tx per boundary).
contract V3LiquidityHelper {
    /// @notice Mint a single liquidity position. Encodes `msg.sender` as the payer.
    function mint(address pool, address recipient, int24 tickLower, int24 tickUpper, uint128 amount)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        return IUniswapV3PoolMinimal(pool).mint(recipient, tickLower, tickUpper, amount, abi.encode(msg.sender));
    }

    /// @notice Mint MANY positions in one tx, paid from this helper's own token balance.
    ///         The helper must hold enough token0/token1 to cover all owed amounts. Arrays
    ///         are parallel: position i = (tickLowers[i], tickUppers[i], amounts[i]).
    function batchMint(
        address pool,
        address recipient,
        int24[] calldata tickLowers,
        int24[] calldata tickUppers,
        uint128[] calldata amounts
    ) external {
        bytes memory selfPay = abi.encode(address(this));
        for (uint256 i = 0; i < amounts.length; i++) {
            if (amounts[i] == 0) continue;
            IUniswapV3PoolMinimal(pool).mint(recipient, tickLowers[i], tickUppers[i], amounts[i], selfPay);
        }
    }

    /// @notice Uniswap V3 mint callback. Called by the pool (msg.sender) during `mint`.
    ///         Pays owed token amounts into the pool: from the helper's own balance when the
    ///         encoded payer is this contract (batchMint), else pulled from the payer.
    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external {
        _payMint(amount0Owed, amount1Owed, data);
    }

    /// @notice PancakeSwap V3 mint callback — same shape as Uniswap's, different selector.
    ///         Pancake V3 pools call THIS during `mint`, so the helper services both forks
    ///         identically (the only fork difference at the boundary is the callback name).
    function pancakeV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external {
        _payMint(amount0Owed, amount1Owed, data);
    }

    /// @dev Shared mint-callback payment: self-pay (batchMint) vs pull-from-payer (mint).
    function _payMint(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) internal {
        address payer = abi.decode(data, (address));
        address pool = msg.sender; // the pool that invoked the callback
        address t0 = IUniswapV3PoolMinimal(pool).token0();
        address t1 = IUniswapV3PoolMinimal(pool).token1();
        if (payer == address(this)) {
            if (amount0Owed > 0) IERC20Minimal(t0).transfer(pool, amount0Owed);
            if (amount1Owed > 0) IERC20Minimal(t1).transfer(pool, amount1Owed);
        } else {
            if (amount0Owed > 0) IERC20Minimal(t0).transferFrom(payer, pool, amount0Owed);
            if (amount1Owed > 0) IERC20Minimal(t1).transferFrom(payer, pool, amount1Owed);
        }
    }
}
