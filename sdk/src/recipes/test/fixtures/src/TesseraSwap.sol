// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Local Tessera V (Wintermute TesseraSwap wrapper + private engine — a treasury-funded proactive
/// market maker) fixture for EcoSwap's callback-free Tessera path (QL segKind 15). It mirrors the REAL
/// verified wrapper (0x55555522005BcAE1c2424D474BfD5ed477749E3e, Base blockscout; SAME address BSC) SURFACE
/// so the local-EVM test exercises the exact interface the recipe hits on-chain:
///   tesseraSwapViewAmounts(address tokenIn, address tokenOut, int256 amountSpecified)
///       view -> (uint256 amountIn, uint256 amountOut)
///   tesseraSwapWithAllowances(address tokenIn, address tokenOut, int256 amountSpecified,
///       uint256 amountCheck, address recipient, bytes swapData)
///   globalPrioFeeThresholddd1337() view -> uint256   (the engine's priority-fee knob, fork-observed)
/// amountSpecified is SIGNED (positive = exact tokenIn — the propAMM taker convention); the quote returns a
/// TUPLE (amountIn, amountOut).
///
/// REVERT-CLASS QUOTE (probed on the real Base wrapper 2026-07-04, reproduced here): an unsupported pair
/// REVERTS "T33", a zero amount REVERTS "T10", while an OVERSIZED ask returns (amountIn, 0)
/// GRACEFULLY — so the recipe's ladder/exec quote is PROBE-THEN-DECODE. (The REAL wrapper additionally
/// accepts a NEGATIVE amount as exact-OUT — probed live; the recipe only ever quotes exact-in, so this
/// fixture rejects negatives with "T10" for simplicity.)
///
/// PRIORITY-FEE SEMANTICS (fork-measured on the real engine, reproduced here): when tx.gasprice EXCEEDS
/// `globalPrioFeeThresholddd1337` the engine widens the spread by a small factor (`prioWidenPpm`) on BOTH
/// the view and the swap — the quote shifts, the swap NEVER reverts, and quote+exec read the SAME
/// tx.gasprice so a same-tx quote-as-amountCheck pair is coherent at ANY gas price. The local prio-fee cell
/// pins exactly this.
///
/// The pricing engine internally uses the Obric closed form (K, base) with the fee netted off the output —
/// deterministic, replayable off-chain by the test's getDy model — but that state is PRIVATE (the real
/// wrapper exposes no curve getters), so this fixture does not expose it either. `setState` lets a test
/// MOVE the state between prepare and cook (the adverse-drift cell). Tessera PULLS tokenIn via transferFrom
/// (approve-first) and pays tokenOut from its TREASURY — this fixture is its own treasury (it HOLDS both
/// tokens). NOTE: the real engine's ~18.5M gas-AVAILABILITY gate is NOT reproduced here (it would only make
/// local cells fragile); the prod-mirror pins it against the genuine bytecode.
contract TesseraSwap {
    uint256 private constant FEE_SCALE = 1e6;

    // Private curve state — NOT exposed via getters (mirrors the real wrapper/engine).
    address private _tokenX;
    address private _tokenY;
    uint256 private _K;
    uint256 private _base;
    uint256 private _feePpm; // 1e6-scaled (0.03% = 300)
    uint256 private _prioThreshold; // wei — the real engine's globalPrioFeeThresholddd1337 (2 gwei)
    uint256 private _prioWidenPpm; // extra spread applied when tx.gasprice > _prioThreshold (1e6-scaled)

    event TesseraTrade(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, address recipient);

    constructor(
        address tokenX_,
        address tokenY_,
        uint256 K_,
        uint256 base_,
        uint256 feePpm_,
        uint256 prioThreshold_,
        uint256 prioWidenPpm_
    ) {
        _tokenX = tokenX_;
        _tokenY = tokenY_;
        _K = K_;
        _base = base_;
        _feePpm = feePpm_;
        _prioThreshold = prioThreshold_;
        _prioWidenPpm = prioWidenPpm_;
    }

    /// @notice Update the private curve state (models the maker posting new params — the drift cell).
    function setState(uint256 K_, uint256 base_) external {
        _K = K_;
        _base = base_;
    }

    /// @notice The engine's priority-fee threshold knob (the REAL storage-name-observed getter).
    function globalPrioFeeThresholddd1337() external view returns (uint256) {
        return _prioThreshold;
    }

    // ── pricing (Obric closed form; PRIVATE) ─────────────────────────────

    function _grossOut(bool sellX, uint256 dx) internal view returns (uint256) {
        if (dx == 0 || _base == 0 || _K == 0) return 0;
        if (sellX) {
            uint256 denom = _base + dx;
            return _K / _base - _K / denom;
        }
        uint256 kOverBase = _K / _base;
        uint256 denom2 = kOverBase + dx;
        uint256 sub = _K / denom2;
        return _base > sub ? _base - sub : 0;
    }

    function _netOut(address tokenIn, uint256 amountIn) internal view returns (uint256) {
        bool sellX;
        if (tokenIn == _tokenX) sellX = true;
        else if (tokenIn == _tokenY) sellX = false;
        else revert("T33");
        uint256 gross = _grossOut(sellX, amountIn);
        if (gross == 0) return 0;
        uint256 fee = (gross * _feePpm) / FEE_SCALE;
        uint256 net = gross > fee ? gross - fee : 0;
        // The priority-fee spread widening (fork-observed on the real engine): ABOVE the threshold the
        // quote is slightly worse; both the view and the swap read the SAME tx.gasprice, so a same-tx
        // quote-as-amountCheck pair never trips.
        if (net > 0 && _prioWidenPpm > 0 && tx.gasprice > _prioThreshold) {
            uint256 widen = (net * _prioWidenPpm) / FEE_SCALE;
            net = net > widen ? net - widen : 0;
        }
        return net;
    }

    /// @notice REAL wrapper quote surface — signed amountSpecified, returns (amountIn, amountOut).
    /// REVERT-class: unsupported pair "T33" (in _netOut), zero amount "T10"; oversized returns
    /// (amountIn, 0) gracefully (the closed form flattens — matches the real wrapper's probes). Negative
    /// (exact-out — real-wrapper-supported, recipe-unused) is rejected "T10" here for simplicity.
    function tesseraSwapViewAmounts(address tokenIn, address tokenOut, int256 amountSpecified)
        public
        view
        returns (uint256 amountIn, uint256 amountOut)
    {
        require(
            (tokenIn == _tokenX && tokenOut == _tokenY) || (tokenIn == _tokenY && tokenOut == _tokenX),
            "T33"
        );
        require(amountSpecified > 0, "T10");
        amountIn = uint256(amountSpecified);
        amountOut = _netOut(tokenIn, amountIn);
    }

    /// @notice REAL wrapper exec surface — signed amountSpecified (positive = exact-in), amountCheck is the
    /// minimum acceptable out ("ACF" on the real engine), swapData is an opaque engine arg (empty on the
    /// taker path). Pulls tokenIn from msg.sender via allowance, pays tokenOut from the treasury (this
    /// contract). NEVER gated on gas price (the widening only shifts the quote — fork-proven).
    function tesseraSwapWithAllowances(
        address tokenIn,
        address tokenOut,
        int256 amountSpecified,
        uint256 amountCheck,
        address recipient,
        bytes calldata swapData
    ) external {
        swapData; // opaque engine arg — unused by the taker path (mirrors the real empty-bytes call)
        require(recipient != address(0), "Tessera: !recipient");
        require(
            (tokenIn == _tokenX && tokenOut == _tokenY) || (tokenIn == _tokenY && tokenOut == _tokenX),
            "T33"
        );
        require(amountSpecified > 0, "T10");
        uint256 amountIn = uint256(amountSpecified);
        uint256 amountOut = _netOut(tokenIn, amountIn);
        require(amountOut >= amountCheck, "ACF");
        IERC20Min(tokenOut).transfer(recipient, amountOut);
        require(IERC20Min(tokenIn).transferFrom(msg.sender, address(this), amountIn), "Tessera: pull");
        emit TesseraTrade(tokenIn, tokenOut, amountIn, amountOut, recipient);
    }
}
