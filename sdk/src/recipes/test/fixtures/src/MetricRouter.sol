// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20MinR {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IMetricPoolMin {
    function quote(bool xToY, int128 amountSpecified, uint128 priceLimit, uint128 bid, uint128 ask)
        external
        view
        returns (int256 amount0Delta, int256 amount1Delta);
    function swap(address recipient, bool xToY, int128 amountSpecified, uint128 priceLimit, bytes calldata data)
        external
        returns (int256 amount0Delta, int256 amount1Delta);
    // The Solidity decoder tolerates the pool's longer (14-word) return — only the head is declared.
    function getImmutables()
        external
        view
        returns (address factory, address priceProvider, address token0, address token1);
}

/// @notice Local METRIC (metric.xyz) ROUTER fixture for EcoSwap's Metric path (QL segKind 17). It
/// mirrors the REAL router SURFACE the recipe hits, signature-exact (selector-resolved + live-tx
/// decoded + fork-executed on Base 2026-07-04; the real router is UNVERIFIED bytecode):
///
///   quoteSwap(address pool, bool xToY, int128 amountSpecified, uint128 priceLimit, uint128 bid,
///       uint128 ask) view returns (int256 amount0Delta, int256 amount1Delta)          [0x89aad153]
///     — forwards to the pool's quote (the REAL router catches the pool's revert-carrying simulation
///       and decodes it; this fixture's pool quote is a plain view — the recipe-visible wire behavior,
///       a clean staticcall or a revert on garbage anchors, is identical).
///
///   swapExactInput(address pool, address recipient, bool xToY, uint128 amountIn, uint128 priceLimit,
///       uint256 minAmountOut, uint256 deadline)                                       [0x4a878c1c]
///     — PERMISSIONLESS approve-first (the payer approves THIS router); deadline is a unix-timestamp
///       bound; minAmountOut enforced as InsufficientOutput(actual, min) (the real error shape,
///       fork-proven at quote+1). The pool pays the recipient FIRST, then re-enters
///       metricOmmSwapCallback HERE — the ROUTER implements the callback itself [0xc3251075], pulling
///       the CONSUMED input (partial fills pull less than amountIn) from the payer via transferFrom.
///       The payer rides the opaque `data` the router hands the pool (the real router's context
///       mechanism is equivalent transient state; the recipe never touches `data`).
contract MetricRouter {
    error InsufficientOutput(uint256 actual, uint256 minAmountOut);
    error Expired();
    error NotPool();

    // The pool the router is mid-swap with (the callback authenticator; cleared after the swap).
    address private _expectedPool;

    function quoteSwap(address pool, bool xToY, int128 amountSpecified, uint128 priceLimit, uint128 bid, uint128 ask)
        external
        view
        returns (int256 amount0Delta, int256 amount1Delta)
    {
        return IMetricPoolMin(pool).quote(xToY, amountSpecified, priceLimit, bid, ask);
    }

    function swapExactInput(
        address pool,
        address recipient,
        bool xToY,
        uint128 amountIn,
        uint128 priceLimit,
        uint256 minAmountOut,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        require(amountIn <= uint128(type(int128).max), "M-i128");
        _expectedPool = pool;
        (int256 a0, int256 a1) =
            IMetricPoolMin(pool).swap(recipient, xToY, int128(amountIn), priceLimit, abi.encode(msg.sender));
        _expectedPool = address(0);
        int256 outDelta = xToY ? a1 : a0;
        amountOut = outDelta < 0 ? uint256(-outDelta) : 0;
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);
    }

    /// @notice The pool's mid-swap re-entry — the ROUTER services it (the engine never sees it).
    /// Pulls the POSITIVE (consumed-input) delta's token from the payer into the pool.
    function metricOmmSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != _expectedPool || msg.sender == address(0)) revert NotPool();
        address payer = abi.decode(data, (address));
        (,, address token0, address token1) = IMetricPoolMin(msg.sender).getImmutables();
        if (amount0Delta > 0) {
            require(IERC20MinR(token0).transferFrom(payer, msg.sender, uint256(amount0Delta)), "M-pull0");
        } else if (amount1Delta > 0) {
            require(IERC20MinR(token1).transferFrom(payer, msg.sender, uint256(amount1Delta)), "M-pull1");
        }
    }
}
