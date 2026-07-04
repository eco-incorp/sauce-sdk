// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Local ElfomoFi (a vault-funded PMM priced by an on-chain pricing module + oracle feed) fixture
/// for EcoSwap's callback-free Elfomo path (QL segKind 16). It mirrors the REAL verified wrapper
/// (0xf0f0F0F0FB0d738452EfD03A28e8be14C76d5f73, Base blockscout; SAME address BSC) SURFACE so the local-EVM
/// test exercises the exact interface the recipe hits on-chain:
///   getAmountOut(address fromToken, address toToken, uint256 fromAmount) view -> (uint256 toAmount)
///   getSupportedPairs() view -> TokenPair[]           (pair enumeration — the discovery surface)
///   swap(address fromToken, address toToken, int256 specifiedAmount, uint256 limitAmount,
///        address receiver, uint256 partnerId)
///
/// GRACEFUL QUOTE (probed on the real Base wrapper 2026-07-04, reproduced here): getAmountOut returns 0 —
/// NEVER reverts — for an unsupported pair, a zero amount, or a STALE oracle feed (the real pricing module
/// hard-zeroes once its feed timestamp is ~5–30 s old; `setOracleTimestamp`/`staleAfter` reproduce that
/// cutoff so a test can pin the graceful-0 self-drop). An oversized ask quotes a real collapsing-marginal
/// value (the closed form flattens).
///
/// The pricing module internally uses the Obric closed form (K, base) with the fee netted off the output —
/// deterministic, replayable off-chain by the test's getDy model — but that state is PRIVATE (the real
/// pricing impl is unverified), so this fixture does not expose it either. `setState` lets a test MOVE the
/// state between prepare and cook (the adverse-drift cell). Elfomo PULLS fromToken via transferFrom
/// (approve-first) and pays toToken from its VAULT — this fixture is its own vault (it HOLDS both tokens).
contract ElfomoFi {
    uint256 private constant FEE_SCALE = 1e6;

    struct TokenPair {
        address tokenA;
        address tokenB;
    }

    // Private pricing state — NOT exposed via getters (mirrors the real unverified pricing impl).
    address private _tokenX;
    address private _tokenY;
    uint256 private _K;
    uint256 private _base;
    uint256 private _feePpm; // 1e6-scaled
    uint256 private _oracleTimestamp; // the feed's last-update time (0 ⇒ never stale)
    uint256 private _staleAfter; // seconds after _oracleTimestamp the quote hard-zeroes (0 ⇒ never)

    event ElfomoTrade(uint256 indexed quoteId, uint256 indexed partnerId, address executor, address receiver, address fromToken, address toToken, uint256 fromAmount, uint256 toAmount);

    error InsufficientAmount(uint256 limitAmount, uint256 actualAmount);
    error ExecutionFailed();

    constructor(address tokenX_, address tokenY_, uint256 K_, uint256 base_, uint256 feePpm_) {
        _tokenX = tokenX_;
        _tokenY = tokenY_;
        _K = K_;
        _base = base_;
        _feePpm = feePpm_;
    }

    /// @notice Update the private pricing state (models an oracle move — the drift cell).
    function setState(uint256 K_, uint256 base_) external {
        _K = K_;
        _base = base_;
    }

    /// @notice Model the feed's staleness cutoff (the real pricing hard-zeroes a stale quote).
    function setOracleTimestamp(uint256 ts, uint256 staleAfter_) external {
        _oracleTimestamp = ts;
        _staleAfter = staleAfter_;
    }

    /// @notice REAL wrapper pair enumeration — the discovery surface (a listed pair quotes BOTH ways).
    function getSupportedPairs() external view returns (TokenPair[] memory pairs) {
        pairs = new TokenPair[](1);
        pairs[0] = TokenPair({tokenA: _tokenX, tokenB: _tokenY});
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

    function _quote(address fromToken, address toToken, uint256 fromAmount) internal view returns (uint256) {
        // GRACEFUL: every failure path returns 0 (mirrors the real pricing module — probed live).
        bool sellX;
        if (fromToken == _tokenX && toToken == _tokenY) sellX = true;
        else if (fromToken == _tokenY && toToken == _tokenX) sellX = false;
        else return 0; // unsupported pair ⇒ 0 (never reverts)
        if (_staleAfter > 0 && block.timestamp > _oracleTimestamp + _staleAfter) return 0; // stale feed ⇒ 0
        uint256 gross = _grossOut(sellX, fromAmount);
        if (gross == 0) return 0;
        uint256 fee = (gross * _feePpm) / FEE_SCALE;
        return gross > fee ? gross - fee : 0;
    }

    /// @notice REAL wrapper quote surface — GRACEFUL single-return (0 ⇒ not fillable, never a revert).
    function getAmountOut(address fromToken, address toToken, uint256 fromAmount)
        external
        view
        returns (uint256 toAmount)
    {
        return _quote(fromToken, toToken, fromAmount);
    }

    /// @notice REAL wrapper exec surface — positive specifiedAmount = exact input; limitAmount is the
    /// minimum acceptable out; partnerId 0 = no partner. Pulls fromToken from msg.sender via allowance,
    /// pays toToken from the vault (this contract). Mirrors the real require order (toAmount > 0 ⇒
    /// ExecutionFailed; toAmount >= limitAmount ⇒ InsufficientAmount).
    function swap(
        address fromToken,
        address toToken,
        int256 specifiedAmount,
        uint256 limitAmount,
        address receiver,
        uint256 partnerId
    ) external {
        require(specifiedAmount >= 0, "Elfomo: exact-out unsupported in fixture");
        uint256 fromAmount = uint256(specifiedAmount);
        uint256 toAmount = _quote(fromToken, toToken, fromAmount);
        if (toAmount == 0) revert ExecutionFailed();
        if (toAmount < limitAmount) revert InsufficientAmount(limitAmount, toAmount);
        IERC20Min(toToken).transfer(receiver, toAmount);
        require(IERC20Min(fromToken).transferFrom(msg.sender, address(this), fromAmount), "Elfomo: pull");
        emit ElfomoTrade(0, partnerId, msg.sender, receiver, fromToken, toToken, fromAmount, toAmount);
    }
}
