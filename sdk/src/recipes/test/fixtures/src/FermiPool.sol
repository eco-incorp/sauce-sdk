// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Local Fermi / propAMM (gattaca-com/propamm FermiSwapper — an OBRIC-style proactive AMM) fixture
/// for EcoSwap's callback-free Fermi path. It mirrors the REAL verified FermiSwapper
/// (0xb1076fe3ab5e28005c7c323bac5ac06a680d452e) SURFACE so the local-EVM test exercises the interface the
/// recipe hits on-chain:
///   quoteAmounts(address tokenIn, address tokenOut, int256 amountSpecified) view -> (uint256 amountIn, uint256 amountOut)
///   fermiSwapWithAllowances(address tokenIn, address tokenOut, int256 amountSpecified, uint256 amountCheck, address recipient) -> (uint256, uint256)
///   isActive(address, address) view -> bool
/// amountSpecified is SIGNED (positive = exact tokenIn, negative = exact tokenOut per the propAMM taker); the
/// quote returns a TUPLE (amountIn, amountOut).
///
/// The pricing engine internally uses the Obric closed form (K = v0²·multX/multY, base = v0 + reserveX −
/// targetX) with the fee netted off the output, but that curve state is PRIVATE — the real FermiSwapper
/// exposes no tokenX/tokenY/K/base/feePpm getters, so this fixture does not either. `setState` lets a test
/// MOVE the state between prepare and cook. propAMM PULLS via transferFrom (approve-first). The pool HOLDS
/// both tokens so it can pay out.
contract FermiPool {
    uint256 private constant FEE_SCALE = 1e6;

    // Private curve state — NOT exposed via getters (mirrors the real FermiSwapper).
    address private _tokenX;
    address private _tokenY;
    uint256 private _K;
    uint256 private _base;
    uint256 private _feePpm; // 1e6-scaled (0.03% = 300)

    event FermiSwap(address tokenIn, address tokenOut, int256 amountSpecified, uint256 amountIn, uint256 amountOut, address to);

    constructor(address tokenX_, address tokenY_, uint256 K_, uint256 base_, uint256 feePpm_) {
        _tokenX = tokenX_;
        _tokenY = tokenY_;
        _K = K_;
        _base = base_;
        _feePpm = feePpm_;
    }

    /// @notice Update the private curve state (models the maker posting new concentration/target params).
    function setState(uint256 K_, uint256 base_) external {
        _K = K_;
        _base = base_;
    }

    /// @notice Whether the pair is live (either orientation) — the real FermiSwapper aliveness check.
    function isActive(address a, address b) external view returns (bool) {
        bool paired = (a == _tokenX && b == _tokenY) || (a == _tokenY && b == _tokenX);
        return paired && _K != 0 && _base != 0;
    }

    // ── propAMM math (Obric closed form; PRIVATE) ─────────────────────────

    function _grossOut(bool sellX, uint256 dx) internal view returns (uint256) {
        if (dx == 0 || _base == 0 || _K == 0) return 0;
        if (sellX) {
            // X → Y: K/base − K/(base + dx).
            uint256 denom = _base + dx;
            return _K / _base - _K / denom;
        }
        // Y → X: base − K/(K/base + dy).
        uint256 kOverBase = _K / _base;
        uint256 denom2 = kOverBase + dx;
        uint256 sub = _K / denom2;
        return _base > sub ? _base - sub : 0;
    }

    function _netOut(address tokenIn, uint256 amountIn) internal view returns (uint256) {
        bool sellX;
        if (tokenIn == _tokenX) sellX = true;
        else if (tokenIn == _tokenY) sellX = false;
        else revert("BAD_TOKEN");
        uint256 gross = _grossOut(sellX, amountIn);
        if (gross == 0) return 0;
        uint256 fee = (gross * _feePpm) / FEE_SCALE;
        return gross > fee ? gross - fee : 0;
    }

    /// @notice REAL FermiSwapper quote surface — signed amountSpecified, returns (amountIn, amountOut). Only
    /// the exact-in leg (positive amountSpecified) is exercised by EcoSwap; the exact-out leg is provided for
    /// surface fidelity (a coarse inverse is out of scope for the fixture).
    function quoteAmounts(address tokenIn, address tokenOut, int256 amountSpecified)
        public
        view
        returns (uint256 amountIn, uint256 amountOut)
    {
        require(
            (tokenIn == _tokenX && tokenOut == _tokenY) || (tokenIn == _tokenY && tokenOut == _tokenX),
            "BAD_TOKENS"
        );
        require(amountSpecified > 0, "EXACT_IN_ONLY");
        amountIn = uint256(amountSpecified);
        amountOut = _netOut(tokenIn, amountIn);
    }

    /// @notice REAL FermiSwapper exec surface — signed amountSpecified (positive = exact-in), amountCheck is
    /// the minimum acceptable out for the exact-in leg. propAMM PULLS via transferFrom (approve-first).
    function fermiSwapWithAllowances(
        address tokenIn,
        address tokenOut,
        int256 amountSpecified,
        uint256 amountCheck,
        address recipient
    ) external returns (uint256 amountIn, uint256 amountOut) {
        require(recipient != address(0), "Fermi: !recipient");
        require(
            (tokenIn == _tokenX && tokenOut == _tokenY) || (tokenIn == _tokenY && tokenOut == _tokenX),
            "BAD_TOKENS"
        );
        require(amountSpecified > 0, "EXACT_IN_ONLY");
        amountIn = uint256(amountSpecified);
        amountOut = _netOut(tokenIn, amountIn);
        require(amountOut >= amountCheck, "Fermi: amountOut_LT_amountCheck");
        require(IERC20Min(tokenIn).transferFrom(msg.sender, address(this), amountIn), "Fermi: pull");
        IERC20Min(tokenOut).transfer(recipient, amountOut);
        emit FermiSwap(tokenIn, tokenOut, amountSpecified, amountIn, amountOut, recipient);
    }
}
