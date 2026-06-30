// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Faithful Solidly STABLE (sAMM) pair for local EVM tests of EcoSwap's callback-free path.
///
/// Reproduces the canonical Velodrome / Aerodrome / Thena / Ramses `stable == true` Pair integer
/// math BIT-FOR-BIT with the off-chain bigint replay in `sdk/src/recipes/shared/solidly-stable-math.ts`
/// — the SAME reserve normalisation (x = reserve·1e18/dec), the x3y+y3x invariant `_k`, the bounded
/// `_get_y` Newton (≤255 iterations, ±1 convergence) and the input-side fee (amountIn -= amountIn·feePpm/1e6).
/// So `getAmountOut(amountIn, tokenIn)` returns EXACTLY the off-chain `getAmountOutStable(pool, dx)` to
/// the wei — the wei-exact-in-dy gate.
///
/// EcoSwap executes a stable pool CALLBACK-FREE (it is x3y+y3x, NOT xy=k, so the engine's _swapV2 path
/// would mis-price it): it reads `getAmountOut`, transfers the input to this pool, then calls
/// `swap(amount0Out, amount1Out, to, "")`. This fixture implements exactly that surface, enforcing the
/// stable K-invariant (k after the swap, on the post-balance reserves net of the input fee, must not
/// shrink). Pre-funded with both reserves via `sync`.
///
/// Storage: token0/token1, _reserve0/_reserve1, _dec0/_dec1 (10**decimals), feePpm.
contract SolidlyStablePool {
    uint256 private constant ONE = 1e18;
    uint256 private constant FEE_DENOM = 1e6;

    address public token0;
    address public token1;
    uint256 private _reserve0;
    uint256 private _reserve1;
    uint256 public immutable decimals0; // 10**decimals(token0)
    uint256 public immutable decimals1; // 10**decimals(token1)
    uint256 public feePpm; // stable swap fee in ppm (e.g. 100 = 0.01%)

    bool public constant stable = true;

    event Swap(address indexed sender, uint256 amount0Out, uint256 amount1Out, address indexed to);
    event Sync(uint256 reserve0, uint256 reserve1);

    constructor(address t0, address t1, uint256 dec0, uint256 dec1, uint256 feePpm_) {
        token0 = t0;
        token1 = t1;
        decimals0 = dec0;
        decimals1 = dec1;
        feePpm = feePpm_;
    }

    function getReserves() external view returns (uint256, uint256, uint256) {
        return (_reserve0, _reserve1, 0);
    }

    /// @notice Snap reserves to current balances (call after funding the pool).
    function sync() external {
        _reserve0 = IERC20Min(token0).balanceOf(address(this));
        _reserve1 = IERC20Min(token1).balanceOf(address(this));
        emit Sync(_reserve0, _reserve1);
    }

    // ── sAMM math (mirrors solidly-stable-math.ts) ────────────────

    /// @notice k(x,y) = (x·y/1e18)·(x·x/1e18 + y·y/1e18)/1e18 — the x3y+y3x invariant (1e18-scaled).
    function _k(uint256 x, uint256 y) internal pure returns (uint256) {
        uint256 _a = (x * y) / ONE;
        uint256 _b = (x * x) / ONE + (y * y) / ONE;
        return (_a * _b) / ONE;
    }

    /// @notice get_y(x0, xy, y) — bounded Newton (≤255 iterations, ±1 convergence).
    function _getY(uint256 x0, uint256 xy, uint256 y) internal pure returns (uint256) {
        for (uint256 it = 0; it < 255; it++) {
            uint256 yPrev = y;
            uint256 f = (x0 * ((((y * y) / ONE) * y) / ONE)) / ONE + ((((x0 * x0) / ONE) * x0) / ONE) * y / ONE;
            uint256 d = (3 * x0 * ((y * y) / ONE)) / ONE + (((x0 * x0) / ONE) * x0) / ONE;
            if (d == 0) break;
            if (f < xy) {
                uint256 dy = ((xy - f) * ONE) / d;
                y = y + dy;
            } else {
                uint256 dy = ((f - xy) * ONE) / d;
                y = y - dy;
            }
            if (y > yPrev) {
                if (y - yPrev <= 1) break;
            } else {
                if (yPrev - y <= 1) break;
            }
        }
        return y;
    }

    /// @notice Exact tokens-out for `amountIn` of `tokenIn`, INCLUDING the swap fee. Pure view —
    /// identical to the off-chain getAmountOutStable and to what `swap` enforces.
    function getAmountOut(uint256 amountIn, address tokenIn) public view returns (uint256) {
        if (amountIn == 0) return 0;
        uint256 amtIn = amountIn - (amountIn * feePpm) / FEE_DENOM; // net the input-side fee
        if (amtIn == 0) return 0;

        bool inIs0 = tokenIn == token0;
        uint256 resIn = inIs0 ? _reserve0 : _reserve1;
        uint256 resOut = inIs0 ? _reserve1 : _reserve0;
        uint256 decIn = inIs0 ? decimals0 : decimals1;
        uint256 decOut = inIs0 ? decimals1 : decimals0;

        uint256 x0n = (resIn * ONE) / decIn; // reserveA, normalised
        uint256 y0n = (resOut * ONE) / decOut; // reserveB, normalised
        if (x0n == 0 || y0n == 0) return 0;

        uint256 xy = _k(x0n, y0n);
        uint256 amtInN = (amtIn * ONE) / decIn;
        uint256 yNew = _getY(amtInN + x0n, xy, y0n);
        if (yNew >= y0n) return 0;
        uint256 dyN = y0n - yNew;
        return (dyN * decOut) / ONE; // denormalise to tokenOut decimals
    }

    /// @notice Callback-free swap — the surface EcoSwap calls. The caller must have already
    ///         transferred the input tokens to this pool. Enforces the stable K-invariant.
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        require(amount0Out > 0 || amount1Out > 0, "INSUFFICIENT_OUTPUT_AMOUNT");
        uint256 r0 = _reserve0;
        uint256 r1 = _reserve1;
        require(amount0Out < r0 && amount1Out < r1, "INSUFFICIENT_LIQUIDITY");

        if (amount0Out > 0) IERC20Min(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20Min(token1).transfer(to, amount1Out);

        uint256 bal0 = IERC20Min(token0).balanceOf(address(this));
        uint256 bal1 = IERC20Min(token1).balanceOf(address(this));

        {
            uint256 amount0In = bal0 > r0 - amount0Out ? bal0 - (r0 - amount0Out) : 0;
            uint256 amount1In = bal1 > r1 - amount1Out ? bal1 - (r1 - amount1Out) : 0;
            require(amount0In > 0 || amount1In > 0, "INSUFFICIENT_INPUT_AMOUNT");
            // K-invariant on the NORMALISED balances net of the input-side fee — must not shrink k.
            uint256 b0 = bal0 - (amount0In * feePpm) / FEE_DENOM;
            uint256 b1 = bal1 - (amount1In * feePpm) / FEE_DENOM;
            uint256 b0n = (b0 * ONE) / decimals0;
            uint256 b1n = (b1 * ONE) / decimals1;
            uint256 r0n = (r0 * ONE) / decimals0;
            uint256 r1n = (r1 * ONE) / decimals1;
            require(_k(b0n, b1n) >= _k(r0n, r1n), "K");
        }

        _reserve0 = bal0;
        _reserve1 = bal1;
        emit Swap(msg.sender, amount0Out, amount1Out, to);
    }
}
