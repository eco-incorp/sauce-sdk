// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Faithful Wombat (single-sided stableswap) 2-asset pool for local EVM tests of EcoSwap's
/// callback-free Wombat path.
///
/// Reproduces the canonical wombat-exchange/v1-core `CoreV2._swapQuoteFunc` / `_solveQuad` coverage-
/// ratio quote + `Pool._quoteFrom` haircut BIT-FOR-BIT with the off-chain bigint replay in
/// `sdk/src/recipes/shared/wombat-math.ts` — the SAME WAD math (cash/liability stored in WAD; amp and
/// haircut WAD; the closed-form quadratic with an integer sqrt), the SAME native↔WAD scaling
/// (fromAmount·1e18/decIn for the quote, out·decOut/1e18 back). So
/// `quotePotentialSwap(fromToken, toToken, fromAmount)` returns EXACTLY the off-chain
/// `quotePotentialSwap(pool, dx)` to the wei — the wei-exact-in-dy gate.
///
/// EcoSwap executes a Wombat pool CALLBACK-FREE (it is single-sided stableswap, NOT xy=k, so the
/// engine's _swapV2 path would mis-price it): it reads `quotePotentialSwap`, APPROVES this pool to
/// pull the input, then calls `swap(fromToken, toToken, amount, minToAmount, to, deadline)`. Wombat
/// PULLS the input via transferFrom (unlike the transfer-first V2/Solidly path). This fixture
/// implements exactly that surface and updates the asset cash on each side.
///
/// 2-asset only (token0/token1), which is all a single fromToken→toToken swap reads. cash/liability
/// are WAD; the pool HOLDS each token's reserve == cash·dec/1e18 so it can pay out.
contract WombatPool {
    int256 private constant WAD_I = 1e18;
    uint256 private constant WAD = 1e18;

    address public token0;
    address public token1;
    uint256 public cash0; // WAD
    uint256 public liability0; // WAD
    uint256 public cash1; // WAD
    uint256 public liability1; // WAD
    uint256 public immutable dec0; // 10**decimals(token0)
    uint256 public immutable dec1; // 10**decimals(token1)
    uint256 public ampFactor; // WAD
    uint256 public haircutRate; // WAD

    event Swap(address indexed sender, address fromToken, address toToken, uint256 fromAmount, uint256 toAmount, address indexed to);

    constructor(
        address t0,
        address t1,
        uint256 d0,
        uint256 d1,
        uint256 cash0_,
        uint256 liability0_,
        uint256 cash1_,
        uint256 liability1_,
        uint256 ampFactor_,
        uint256 haircutRate_
    ) {
        token0 = t0;
        token1 = t1;
        dec0 = d0;
        dec1 = d1;
        cash0 = cash0_;
        liability0 = liability0_;
        cash1 = cash1_;
        liability1 = liability1_;
        ampFactor = ampFactor_;
        haircutRate = haircutRate_;
    }

    // ── coverage-ratio math (mirrors wombat-math.ts / CoreV2) ─────────────

    // Round-to-nearest, matching canonical SignedSafeMath (adds the half-term before the
    // truncate-toward-zero divide) — NOT floor. Mirrors wombat-math.ts wmul/wdiv bit-for-bit.
    function _wmul(int256 a, int256 b) internal pure returns (int256) {
        return ((a * b) + (WAD_I / 2)) / WAD_I;
    }

    function _wdiv(int256 a, int256 b) internal pure returns (int256) {
        return ((a * WAD_I) + (b / 2)) / b;
    }

    /// @notice Integer square root (babylonian) — matches the off-chain isqrt floor.
    function _sqrt(int256 x) internal pure returns (int256) {
        if (x <= 0) return 0;
        uint256 ux = uint256(x);
        uint256 z = ux;
        uint256 y = (z + 1) / 2;
        while (y < z) {
            z = y;
            y = (ux / y + y) / 2;
        }
        return int256(z);
    }

    /// @notice _solveQuad(b, c) = (sqrt(b·b + 4·c·WAD) - b) / 2.
    function _solveQuad(int256 b, int256 c) internal pure returns (int256) {
        int256 disc = b * b + c * 4 * WAD_I;
        return (_sqrt(disc) - b) / 2;
    }

    /// @notice CoreV2._swapQuoteFunc — the ideal (pre-haircut) WAD output.
    function _swapQuoteFunc(int256 Ax, int256 Ay, int256 Lx, int256 Ly, int256 Dx, int256 A)
        internal
        pure
        returns (uint256)
    {
        if (Lx == 0 || Ly == 0) return 0;
        if (Ax <= 0 || Ay <= 0) return 0;
        int256 D = Ax + Ay - _wmul(A, (Lx * Lx) / Ax + (Ly * Ly) / Ay);
        int256 rx_ = _wdiv(Ax + Dx, Lx);
        if (rx_ <= 0) return 0;
        int256 b = (Lx * (rx_ - _wdiv(A, rx_))) / Ly - _wdiv(D, Ly);
        int256 ry_ = _solveQuad(b, A);
        int256 Dy = _wmul(Ly, ry_) - Ay;
        return Dy < 0 ? uint256(-Dy) : uint256(Dy);
    }

    function _assetsFor(address fromToken)
        internal
        view
        returns (int256 Ax, int256 Ay, int256 Lx, int256 Ly, uint256 decIn, uint256 decOut)
    {
        if (fromToken == token0) {
            return (int256(cash0), int256(cash1), int256(liability0), int256(liability1), dec0, dec1);
        }
        return (int256(cash1), int256(cash0), int256(liability1), int256(liability0), dec1, dec0);
    }

    /// @notice Exact actual tokens-out for `fromAmount` of `fromToken`, INCLUDING the haircut.
    /// Pure view — identical to the off-chain quotePotentialSwap and to what `swap` enforces.
    function quotePotentialSwap(address fromToken, address toToken, int256 fromAmount)
        public
        view
        returns (uint256 potentialOutcome, uint256 haircut)
    {
        require(fromToken != toToken, "SAME_TOKEN");
        require(
            (fromToken == token0 && toToken == token1) || (fromToken == token1 && toToken == token0),
            "BAD_TOKENS"
        );
        if (fromAmount <= 0) return (0, 0);
        (int256 Ax, int256 Ay, int256 Lx, int256 Ly, uint256 decIn, uint256 decOut) = _assetsFor(fromToken);

        int256 fromWad = (fromAmount * WAD_I) / int256(decIn); // toWad
        uint256 idealWad = _swapQuoteFunc(Ax, Ay, Lx, Ly, fromWad, int256(ampFactor));
        if (idealWad == 0) return (0, 0);
        uint256 haircutWad = ((idealWad * haircutRate) + (WAD / 2)) / WAD; // wmul (round-to-nearest, canonical DSMath)
        uint256 actualWad = idealWad - haircutWad;
        potentialOutcome = (actualWad * decOut) / WAD; // fromWad
        haircut = (haircutWad * decOut) / WAD;
    }

    /// @notice Callback-free swap — the surface EcoSwap calls. Wombat PULLS the input via
    /// transferFrom (the caller must have APPROVED this pool), quotes the exact out, checks the
    /// minimum, pays out, and updates both assets' cash.
    function swap(
        address fromToken,
        address toToken,
        uint256 fromAmount,
        uint256 minimumToAmount,
        address to,
        uint256 deadline
    ) external returns (uint256 actualToAmount, uint256 haircut) {
        require(block.timestamp <= deadline, "EXPIRED");
        require(fromAmount > 0, "ZERO_AMOUNT");
        (actualToAmount, haircut) = quotePotentialSwap(fromToken, toToken, int256(fromAmount));
        require(actualToAmount >= minimumToAmount, "AMOUNT_TOO_LOW");

        // Pull the input (Wombat pulls; the caller approved this pool).
        IERC20Min(fromToken).transferFrom(msg.sender, address(this), fromAmount);
        // Pay out.
        IERC20Min(toToken).transfer(to, actualToAmount);

        // Update cash on both assets (WAD). The from-asset gains the full input; the to-asset loses
        // the actual out plus the haircut (the haircut stays as fee-cash in the to-asset, like Wombat).
        if (fromToken == token0) {
            cash0 += (fromAmount * WAD) / dec0;
            cash1 -= ((actualToAmount + haircut) * WAD) / dec1;
        } else {
            cash1 += (fromAmount * WAD) / dec1;
            cash0 -= ((actualToAmount + haircut) * WAD) / dec0;
        }
        emit Swap(msg.sender, fromToken, toToken, fromAmount, actualToAmount, to);
    }
}
