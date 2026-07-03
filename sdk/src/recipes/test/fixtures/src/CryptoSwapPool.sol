// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Faithful Curve Twocrypto (fxswap / "boom" twocrypto-ng, pool version v2.1.0d) 2-coin pool
/// for local EVM tests of EcoSwap's callback-free CryptoSwap path.
///
/// Reproduces the DEPLOYED pool family's math BIT-FOR-BIT with the off-chain bigint replay in
/// `sdk/src/recipes/shared/cryptoswap-math.ts` (both mirror the sourcify-verified mainnet pool +
/// its StableswapMath, probe-verified against real chain state): the STABLESWAP `get_y`/`newton_D`
/// invariant with `Ann = A·N` (gamma is stored for ABI parity but IGNORED by the math, exactly like
/// the deployed `StableswapMath.vy`), the view's RAW-product xp scaling (`dx` joins the RAW balance
/// FIRST, then ONE `balances·precisions·price_scale/1e18` floor per coin), the `dy = xp[j] - y - 1`
/// rounding, and the v2.1.0d dynamic fee (`fee_gamma·B/(fee_gamma·B/1e18 + 1e18 - B)` blend)
/// computed on the POST-swap xp (`xp[j] = y`) — so `get_dy(i, j, dx)` returns EXACTLY the off-chain
/// `getDyCrypto(pool, dx)` to the wei — the wei-exact-in-dy gate.
///
/// CryptoSwap pools use UINT256 coin indices (exchange(uint256 i, uint256 j, dx, min_dy)), so the
/// engine `_swapCurve` (exchange(int128,int128,...)) does NOT match them. EcoSwap executes a
/// CryptoSwap pool CALLBACK-FREE: it reads get_dy(i, j, Σ) for min_dy, APPROVES this pool to pull
/// the input, then calls exchange(i, j, Σ, min_dy). Curve exchange PULLS the input via transferFrom
/// (like Wombat). This fixture implements exactly that surface + updates the coin balances (and D)
/// on each exchange.
///
/// 2-coin only (coin0/coin1), which is all a single tokenIn→tokenOut swap reads. `A` is the pool
/// `A()` (the math `_amp`; deployed bounds MIN_A = N·A_MULTIPLIER = 2e4, MAX_A = 1e8). price_scale
/// scales coin1 into coin0 (the numeraire). The pool HOLDS each coin's balance so it can pay out.
contract CryptoSwapPool {
    uint256 private constant PRECISION = 1e18;
    uint256 private constant FEE_DENOM = 1e10;
    uint256 private constant A_MULTIPLIER = 10000;
    uint256 private constant N = 2;

    address[2] public coinList;
    uint256 public A; // the pool A() == the math _amp (Ann = A*N inside the math)
    uint256 public gamma; // stored for ABI parity; UNUSED by the fx/boom StableswapMath
    uint256 public price_scale;
    uint256 public D;
    uint256[2] public bal; // native-unit coin balances
    uint256[2] public precisions; // 10**(18 - decimals[k])
    uint256 public mid_fee;
    uint256 public out_fee;
    uint256 public fee_gamma;

    event TokenExchange(address indexed buyer, uint256 i, uint256 j, uint256 dx, uint256 dy);

    constructor(
        address[2] memory coins_,
        uint256[2] memory precisions_,
        uint256 A_,
        uint256 gamma_,
        uint256 priceScale_,
        uint256[2] memory balances_,
        uint256 midFee_,
        uint256 outFee_,
        uint256 feeGamma_
    ) {
        require(A_ >= N * A_MULTIPLIER, "A<MIN"); // deployed MIN_A (Ann - A_MULTIPLIER must not underflow)
        coinList = coins_;
        precisions = precisions_;
        A = A_;
        gamma = gamma_;
        price_scale = priceScale_;
        bal = balances_;
        mid_fee = midFee_;
        out_fee = outFee_;
        fee_gamma = feeGamma_;
        // Compute D from the scaled balances (the invariant the quotes hold).
        D = _newtonD(_xp());
    }

    function coins(uint256 i) external view returns (address) {
        return coinList[i];
    }

    function balances(uint256 i) external view returns (uint256) {
        return bal[i];
    }

    // ── math (mirrors cryptoswap-math.ts / the deployed StableswapMath + Twocrypto v2.1.0d) ──────

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    /// @notice xp[0] = bal[0]*precisions[0]; xp[1] = bal[1]*precisions[1]*price_scale/1e18 — ONE
    /// raw-product floor per coin (the deployed `_xp`).
    function _xp() internal view returns (uint256[2] memory xp) {
        xp[0] = bal[0] * precisions[0];
        xp[1] = (bal[1] * precisions[1] * price_scale) / PRECISION;
    }

    /// @notice StableswapMath.newton_D (Ann = A*N, gamma ignored) — bit-for-bit with
    /// cryptoswap-math.ts newtonD. `|Δ| <= 1` convergence, bounded 255.
    function _newtonD(uint256[2] memory x) internal view returns (uint256) {
        if (x[0] == 0 || x[1] == 0) return 0;
        uint256 S = x[0] + x[1];
        uint256 Dn = S;
        uint256 Ann = A * N;
        for (uint256 it = 0; it < 255; it++) {
            uint256 D_P = Dn;
            D_P = (D_P * Dn) / x[0];
            D_P = (D_P * Dn) / x[1];
            D_P = D_P / (N * N); // N**N for N=2
            uint256 Dprev = Dn;
            Dn = (((Ann * S) / A_MULTIPLIER + D_P * N) * Dn)
                / (((Ann - A_MULTIPLIER) * Dn) / A_MULTIPLIER + (N + 1) * D_P);
            if (_absDiff(Dn, Dprev) <= 1) return Dn;
        }
        return Dn;
    }

    /// @notice StableswapMath.get_y (Ann = A*N, gamma ignored) — solve coin i's post-swap balance
    /// for the moved xp and held D. Bit-for-bit with cryptoswap-math.ts getY.
    function _getY(uint256[2] memory xp, uint256 Dn, uint256 i) internal view returns (uint256) {
        uint256 xj = xp[1 - i]; // the moved counterpart coin balance
        uint256 Ann = A * N;
        uint256 c = (Dn * Dn) / (xj * N);
        c = (c * Dn * A_MULTIPLIER) / (Ann * N);
        uint256 b = xj + (Dn * A_MULTIPLIER) / Ann;
        uint256 y = Dn;
        for (uint256 it = 0; it < 255; it++) {
            uint256 yPrev = y;
            y = (y * y + c) / (2 * y + b - Dn);
            if (_absDiff(y, yPrev) <= 1) return y;
        }
        return y;
    }

    /// @notice _fee(xp) — the v2.1.0d dynamic fee (1e10 units) — bit-for-bit with
    /// cryptoswap-math.ts cryptoFee (the fee_gamma*B/(fee_gamma*B/1e18 + 1e18 - B) blend).
    function _fee(uint256[2] memory xp) internal view returns (uint256) {
        uint256 S = xp[0] + xp[1];
        if (S == 0) return mid_fee;
        uint256 B = (((PRECISION * N * N * xp[0]) / S) * xp[1]) / S;
        B = (fee_gamma * B) / ((fee_gamma * B) / PRECISION + PRECISION - B);
        return (mid_fee * B + out_fee * (PRECISION - B)) / PRECISION;
    }

    /// @notice Exact tokens-out for `dx` of coin i → coin j, INCLUDING the dynamic fee. Pure view —
    /// identical to the off-chain getDyCrypto and to what `exchange` enforces. Mirrors the deployed
    /// view's ORDER: dx joins the RAW balance, ONE scaling floor per coin, fee on the POST-swap xp.
    function get_dy(uint256 i, uint256 j, uint256 dx) public view returns (uint256) {
        require(i != j && i < N && j < N, "BAD_COIN");
        if (dx == 0) return 0;
        uint256[2] memory raw = [bal[0], bal[1]];
        raw[i] = raw[i] + dx;
        uint256[2] memory xp =
            [raw[0] * precisions[0], (raw[1] * precisions[1] * price_scale) / PRECISION];
        uint256 y = _getY(xp, D, j);
        if (y + 1 >= xp[j]) return 0; // deployed view: assert y < xp[j]
        uint256 dy = xp[j] - y - 1;
        xp[j] = y; // POST-swap xp — the state the dynamic fee is computed on
        if (j > 0) dy = (dy * PRECISION) / price_scale;
        dy = dy / precisions[j];
        uint256 fee = (_fee(xp) * dy) / FEE_DENOM;
        return dy - fee;
    }

    /// @notice Callback-free exchange — the surface EcoSwap calls. Curve PULLS the input via transferFrom
    /// (the caller must have APPROVED this pool), quotes the exact out, checks min_dy, pays out, updates
    /// balances + D.
    function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) external returns (uint256) {
        require(i != j && i < N && j < N, "BAD_COIN");
        require(dx > 0, "ZERO_DX");
        uint256 dy = get_dy(i, j, dx);
        require(dy >= min_dy, "SLIPPAGE");

        IERC20Min(coinList[i]).transferFrom(msg.sender, address(this), dx);
        IERC20Min(coinList[j]).transfer(msg.sender, dy);

        bal[i] += dx;
        bal[j] -= dy;
        D = _newtonD(_xp());
        emit TokenExchange(msg.sender, i, j, dx, dy);
        return dy;
    }
}
