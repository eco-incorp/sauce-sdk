// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Faithful Curve CryptoSwap (twocrypto-ng / tricrypto-ng volatile-asset) 2-coin pool for local
/// EVM tests of EcoSwap's callback-free CryptoSwap path.
///
/// Reproduces the canonical curvefi tricrypto-ng `newton_D`/`newton_y` A-gamma invariant + twocrypto-ng
/// `Twocrypto.get_dy` precisions[]/price_scale scaling + `_fee` dynamic fee BIT-FOR-BIT with the off-chain
/// bigint replay in `sdk/src/recipes/shared/cryptoswap-math.ts` — the SAME 1e18 fixed-point math, the SAME
/// bounded-255 Newton loops + convergence tests, the SAME `dy = xp[j] - y - 1` rounding + `dy -= fee*dy/1e10`
/// dynamic fee. So `get_dy(i, j, dx)` returns EXACTLY the off-chain `getDyCrypto(pool, dx)` to the wei —
/// the wei-exact-in-dy gate.
///
/// CryptoSwap pools use UINT256 coin indices (exchange(uint256 i, uint256 j, dx, min_dy)), so the engine
/// `_swapCurve` (exchange(int128,int128,...)) does NOT match them. EcoSwap executes a CryptoSwap pool
/// CALLBACK-FREE: it reads get_dy(i, j, Σ) for min_dy, APPROVES this pool to pull the input, then calls
/// exchange(i, j, Σ, min_dy). Curve exchange PULLS the input via transferFrom (like Wombat). This fixture
/// implements exactly that surface + updates the coin balances (and D) on each exchange.
///
/// 2-coin only (coin0/coin1), which is all a single tokenIn→tokenOut swap reads. `A` is stored as ANN
/// (already A_MULTIPLIER·N^N-scaled, as the crypto pool `A()` reports it). price_scale scales coin1 into
/// coin0 (the numeraire). The pool HOLDS each coin's balance so it can pay out.
contract CryptoSwapPool {
    uint256 private constant PRECISION = 1e18;
    uint256 private constant FEE_DENOM = 1e10;
    uint256 private constant A_MULTIPLIER = 10000;
    uint256 private constant N = 2;

    address[2] public coinList;
    uint256 public A; // ANN (A_MULTIPLIER·N^N-scaled)
    uint256 public gamma;
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

    // ── math (mirrors cryptoswap-math.ts / tricrypto-ng, N=2) ─────────────

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    function _isqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = x;
        uint256 y = (z + 1) / 2;
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
        return y > z ? z : y;
    }

    /// @notice xp[0] = bal[0]*precisions[0]; xp[1] = bal[1]*precisions[1]*price_scale/1e18 (1e18 space).
    function _xp() internal view returns (uint256[2] memory xp) {
        xp[0] = bal[0] * precisions[0];
        xp[1] = (bal[1] * precisions[1] * price_scale) / PRECISION;
    }

    /// @notice newton_D specialized to N=2 — bit-for-bit with cryptoswap-math.ts newtonD.
    function _newtonD(uint256[2] memory x) internal view returns (uint256) {
        uint256 S = x[0] + x[1];
        if (S == 0) return 0;
        uint256 Dn = N * _isqrt(x[0] * x[1]);
        for (uint256 it = 0; it < 255; it++) {
            uint256 Dprev = Dn;
            uint256 K0 = (((PRECISION * N * N * x[0]) / Dn) * x[1]) / Dn;
            uint256 g1k0 = _absDiff(gamma + PRECISION, K0) + 1;
            uint256 mul1 = ((((((PRECISION * Dn) / gamma) * g1k0) / gamma) * g1k0) * A_MULTIPLIER) / A;
            uint256 mul2 = (2 * PRECISION * N * K0) / g1k0;
            uint256 negFprime = S + (S * mul2) / PRECISION + (mul1 * N) / K0 - (mul2 * Dn) / PRECISION;
            uint256 Dplus = (Dn * (negFprime + S)) / negFprime;
            uint256 Dminus = (Dn * Dn) / negFprime;
            if (PRECISION > K0) {
                Dminus += (((Dn * (mul1 / negFprime)) / PRECISION) * (PRECISION - K0)) / K0;
            } else {
                Dminus -= (((Dn * (mul1 / negFprime)) / PRECISION) * (K0 - PRECISION)) / K0;
            }
            Dn = Dplus > Dminus ? Dplus - Dminus : (Dminus - Dplus) / 2;
            uint256 diff = _absDiff(Dn, Dprev);
            uint256 bound = Dn > 1e16 ? Dn : 1e16;
            if (diff * 1e14 < bound) break;
        }
        return Dn;
    }

    /// @notice newton_y specialized to N=2 — bit-for-bit with cryptoswap-math.ts newtonY.
    function _newtonY(uint256[2] memory x, uint256 Dn, uint256 i) internal view returns (uint256) {
        uint256 xj = x[1 - i];
        uint256 K0i = (PRECISION * N * xj) / Dn;
        uint256 Si = xj;
        uint256 y = (Dn * Dn) / (xj * N * N);
        uint256 convLim = xj / 1e14 > Dn / 1e14 ? xj / 1e14 : Dn / 1e14;
        if (convLim < 100) convLim = 100;
        for (uint256 it = 0; it < 255; it++) {
            uint256 yPrev = y;
            uint256 K0 = (K0i * y * N) / Dn;
            uint256 S = Si + y;
            uint256 g1k0 = _absDiff(gamma + PRECISION, K0) + 1;
            uint256 mul1 = ((((((PRECISION * Dn) / gamma) * g1k0) / gamma) * g1k0) * A_MULTIPLIER) / A;
            uint256 mul2 = PRECISION + (2 * PRECISION * K0) / g1k0;
            uint256 yfprime = PRECISION * y + S * mul2 + mul1;
            uint256 dyfprime = Dn * mul2;
            if (yfprime < dyfprime) {
                y = yPrev / 2;
                continue;
            }
            yfprime = yfprime - dyfprime;
            uint256 fprime = yfprime / y;
            uint256 yMinus = mul1 / fprime;
            uint256 yPlus = (yfprime + PRECISION * Dn) / fprime + (yMinus * PRECISION) / K0;
            yMinus += (PRECISION * S) / fprime;
            y = yPlus < yMinus ? yPrev / 2 : yPlus - yMinus;
            uint256 diff = _absDiff(y, yPrev);
            uint256 bound = convLim > y / 1e14 ? convLim : y / 1e14;
            if (diff < bound) break;
        }
        return y;
    }

    /// @notice _fee(xp) — the dynamic fee (1e10 units) — bit-for-bit with cryptoswap-math.ts cryptoFee.
    function _fee(uint256[2] memory xp) internal view returns (uint256) {
        uint256 S = xp[0] + xp[1];
        if (S == 0) return mid_fee;
        uint256 f = (((N ** N * PRECISION * xp[0]) / S) * xp[1]) / S;
        f = (fee_gamma * PRECISION) / (fee_gamma + PRECISION - f);
        return (mid_fee * f + out_fee * (PRECISION - f)) / PRECISION;
    }

    /// @notice Exact tokens-out for `dx` of coin i → coin j, INCLUDING the dynamic fee. Pure view —
    /// identical to the off-chain getDyCrypto and to what `exchange` enforces.
    function get_dy(uint256 i, uint256 j, uint256 dx) public view returns (uint256) {
        require(i != j && i < N && j < N, "BAD_COIN");
        if (dx == 0) return 0;
        uint256[2] memory xp = _xp();
        uint256 scaleI = i == 0 ? precisions[0] : (precisions[1] * price_scale) / PRECISION;
        xp[i] = xp[i] + dx * scaleI;
        uint256 y = _newtonY(xp, D, j);
        if (xp[j] <= y + 1) return 0;
        uint256 dy = xp[j] - y - 1;
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
