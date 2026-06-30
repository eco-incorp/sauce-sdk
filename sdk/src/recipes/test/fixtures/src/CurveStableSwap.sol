// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Faithful Curve StableSwap plain-pool for local EVM tests of the engine `_swapCurve` path.
///
/// Reproduces the canonical Curve `StableSwap` plain-pool integer math BIT-FOR-BIT with the
/// off-chain bigint replay in `sdk/src/recipes/shared/curve-math.ts` — the SAME get_D / get_y /
/// get_dy (A_PRECISION = 100, `Ann = A·A_PRECISION·N`, 1e10-scaled fee, rates[]/1e18 scaling, the
/// `-1` round-in-pool-favor, integer fee truncation). So `exchange(i,j,dx,0)` returns EXACTLY the
/// off-chain `getDy(pool, dx)` to the wei — the wei-exact-in-dy gate.
///
/// The engine `_swapCurve` resolves i/j on-chain by iterating `coins(k)` against tokenIn/tokenOut
/// and calls `exchange(i, j, abs(amountSpecified), 0)`; this fixture implements exactly that surface.
/// It is callback-free: `exchange` `transferFrom`s `dx` of coin i from `msg.sender` (the router) and
/// `transfer`s `dy` of coin j out to `msg.sender`. The pool is pre-funded with both coins' balances.
contract CurveStableSwap {
    uint256 private constant PRECISION = 1e18;
    uint256 private constant FEE_DENOMINATOR = 1e10;
    uint256 private constant A_PRECISION = 100;

    address[] private _coins;
    uint256[] public balances; // native-order coin balances (the StableSwap `balances`)
    uint256[] private _rates; // rates[k] = 1e18 * 10**(18 - decimals[k])
    uint256 public A; // amplification (raw — get_D multiplies by A_PRECISION)
    uint256 public fee; // 1e10-scaled swap fee

    constructor(
        address[] memory coins_,
        uint256[] memory balances_,
        uint256[] memory rates_,
        uint256 a_,
        uint256 fee_
    ) {
        require(coins_.length == balances_.length && coins_.length == rates_.length, "len");
        _coins = coins_;
        balances = balances_;
        _rates = rates_;
        A = a_;
        fee = fee_;
    }

    /// @notice Coin at index k. Reverts past N so `_swapCurve`'s try/catch stops the scan.
    function coins(uint256 k) external view returns (address) {
        return _coins[k];
    }

    function nCoins() external view returns (uint256) {
        return _coins.length;
    }

    // ── StableSwap math (mirrors curve-math.ts) ──────────────────

    function _xp() internal view returns (uint256[] memory xp) {
        uint256 n = balances.length;
        xp = new uint256[](n);
        for (uint256 k = 0; k < n; k++) {
            xp[k] = (balances[k] * _rates[k]) / PRECISION;
        }
    }

    function getD(uint256[] memory xp, uint256 amp) public pure returns (uint256) {
        uint256 n = xp.length;
        uint256 S = 0;
        for (uint256 k = 0; k < n; k++) S += xp[k];
        if (S == 0) return 0;

        uint256 Ann = amp * n;
        uint256 D = S;
        for (uint256 it = 0; it < 255; it++) {
            uint256 D_P = D;
            for (uint256 k = 0; k < n; k++) {
                D_P = (D_P * D) / (xp[k] * n);
            }
            uint256 Dprev = D;
            D = (((Ann * S) / A_PRECISION + D_P * n) * D)
                / (((Ann - A_PRECISION) * D) / A_PRECISION + (n + 1) * D_P);
            if (D > Dprev) {
                if (D - Dprev <= 1) break;
            } else {
                if (Dprev - D <= 1) break;
            }
        }
        return D;
    }

    function getY(int128 i, int128 j, uint256 x, uint256[] memory xp, uint256 amp)
        public
        pure
        returns (uint256)
    {
        uint256 n = xp.length;
        uint256 D = getD(xp, amp);
        uint256 Ann = amp * n;

        uint256 c = D;
        uint256 S_ = 0;
        for (uint256 k = 0; k < n; k++) {
            if (int128(int256(k)) == j) continue;
            uint256 _x = int128(int256(k)) == i ? x : xp[k];
            S_ += _x;
            c = (c * D) / (_x * n);
        }
        c = (c * D * A_PRECISION) / (Ann * n);
        uint256 b = S_ + (D * A_PRECISION) / Ann;

        uint256 y = D;
        for (uint256 it = 0; it < 255; it++) {
            uint256 yPrev = y;
            y = (y * y + c) / (2 * y + b - D);
            if (y > yPrev) {
                if (y - yPrev <= 1) break;
            } else {
                if (yPrev - y <= 1) break;
            }
        }
        return y;
    }

    /// @notice Exact tokens-out for `dx` of coin i → coin j, INCLUDING the swap fee. Pure view —
    /// identical to the off-chain getDy and to what `exchange` lands.
    function get_dy(int128 i, int128 j, uint256 dx) public view returns (uint256) {
        uint256[] memory xp = _xp();
        uint256 amp = A * A_PRECISION;
        uint256 ui = uint256(int256(i));
        uint256 uj = uint256(int256(j));
        uint256 x = xp[ui] + (dx * _rates[ui]) / PRECISION;
        uint256 y = getY(i, j, x, xp, amp);
        if (xp[uj] <= y + 1) return 0;
        uint256 dy = xp[uj] - y - 1; // round down in the pool's favor
        uint256 _fee = (fee * dy) / FEE_DENOMINATOR;
        dy = dy - _fee;
        return (dy * PRECISION) / _rates[uj];
    }

    /// @notice Callback-free exchange — the surface the engine `_swapCurve` calls.
    /// Pulls `dx` coin i from msg.sender, transfers `dy` coin j out. Updates `balances`.
    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256) {
        uint256 ui = uint256(int256(i));
        uint256 uj = uint256(int256(j));
        uint256 dy = get_dy(i, j, dx);
        require(dy >= min_dy, "min_dy");

        IERC20Min(_coins[ui]).transferFrom(msg.sender, address(this), dx);
        balances[ui] += dx;
        balances[uj] -= dy;
        IERC20Min(_coins[uj]).transfer(msg.sender, dy);
        return dy;
    }
}
