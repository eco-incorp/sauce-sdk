// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Faithful constant-product (Uniswap-V2-style) pair for local EVM tests.
///
/// The harness ETCHES this contract's runtime bytecode at a chosen address (it has
/// no constructor logic — all state is set via `initialize`/`sync`), then drives it
/// through the engine's real `_swapV2` path (for the canonical 0.3% fee) OR EcoSwap's
/// callback-free path (for any other fee). It implements EXACTLY what each touches —
/// `token0`/`token1`/`getReserves`/`swap` — and enforces a per-pool `feePpm`
/// K-invariant: balances net of the fee must not shrink k. With feePpm = 3000 this is
/// the canonical 997/1000 invariant the engine's hardcoded V2 fee matches.
///
/// Storage layout (deliberately simple + unpacked):
///   slot 0: token0  slot 1: token1  slot 2: reserve0  slot 3: reserve1  slot 4: feePpm
contract V2Pair {
    address public token0; // slot 0
    address public token1; // slot 1
    uint256 private _reserve0; // slot 2
    uint256 private _reserve1; // slot 3
    uint256 public feePpm; // slot 4 — constant-product fee in ppm (0 ⇒ canonical 3000)

    event Swap(address indexed sender, uint256 amount0Out, uint256 amount1Out, address indexed to);
    event Sync(uint112 reserve0, uint112 reserve1);

    /// @notice Set the token pair (canonical 0.3% fee). Callable once on the etched address.
    function initialize(address t0, address t1) external {
        require(token0 == address(0) && token1 == address(0), "INITIALIZED");
        token0 = t0;
        token1 = t1;
    }

    /// @notice Set the token pair AND a per-pool fee (ppm). Lets a test stand up a
    ///         V2-class pair at a non-0.30% fee (e.g. 500 = 0.05%), exercising EcoSwap's
    ///         callback-free V2 execution path that honors the discovered per-pool fee.
    function initializeWithFee(address t0, address t1, uint256 fee) external {
        require(token0 == address(0) && token1 == address(0), "INITIALIZED");
        token0 = t0;
        token1 = t1;
        feePpm = fee;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (uint112(_reserve0), uint112(_reserve1), 0);
    }

    /// @notice Snap reserves to current balances (call after funding the pair).
    function sync() external {
        _reserve0 = IERC20Min(token0).balanceOf(address(this));
        _reserve1 = IERC20Min(token1).balanceOf(address(this));
        emit Sync(uint112(_reserve0), uint112(_reserve1));
    }

    /// @notice Canonical UniswapV2 swap. The caller must have already transferred
    ///         the input tokens to this pair (the engine does this before calling).
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        require(amount0Out > 0 || amount1Out > 0, "INSUFFICIENT_OUTPUT_AMOUNT");
        uint256 r0 = _reserve0;
        uint256 r1 = _reserve1;
        require(amount0Out < r0 && amount1Out < r1, "INSUFFICIENT_LIQUIDITY");

        if (amount0Out > 0) IERC20Min(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20Min(token1).transfer(to, amount1Out);

        uint256 bal0 = IERC20Min(token0).balanceOf(address(this));
        uint256 bal1 = IERC20Min(token1).balanceOf(address(this));

        // Scoped so the fee-adjusted intermediates are freed before the SSTOREs
        // (keeps the stack shallow enough to compile without viaIR).
        {
            uint256 amount0In = bal0 > r0 - amount0Out ? bal0 - (r0 - amount0Out) : 0;
            uint256 amount1In = bal1 > r1 - amount1Out ? bal1 - (r1 - amount1Out) : 0;
            require(amount0In > 0 || amount1In > 0, "INSUFFICIENT_INPUT_AMOUNT");
            // Per-pool fee K-invariant (ppm): balances net of the fee must not shrink k.
            // feePpm = 0 ⇒ the canonical 0.30% (3000ppm) the engine's _swapV2 matches.
            uint256 fee = feePpm == 0 ? 3000 : feePpm;
            uint256 bal0Adj = bal0 * 1_000_000 - amount0In * fee;
            uint256 bal1Adj = bal1 * 1_000_000 - amount1In * fee;
            require(bal0Adj * bal1Adj >= r0 * r1 * 1_000_000 * 1_000_000, "K");
        }

        _reserve0 = bal0;
        _reserve1 = bal1;
        emit Swap(msg.sender, amount0Out, amount1Out, to);
    }
}
