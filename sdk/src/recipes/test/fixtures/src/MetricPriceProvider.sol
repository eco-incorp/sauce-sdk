// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Local METRIC (metric.xyz) PriceProvider fixture for EcoSwap's Metric path (QL segKind 17).
/// It mirrors the REAL provider SURFACE the recipe hits (probed live on Base 2026-07-04; the real
/// contracts are UNVERIFIED — bytecode-probed + selector-resolved):
///   getBidAndAskPrice() view returns (uint128 bid, uint128 ask)
/// The anchor is X64 fixed-point (price = value / 2^64), maker-posted. STALENESS-REVERT class: the
/// REAL provider reverts custom error 0x9a0423af once the maker's off-chain post is older than
/// MAX_TIME_DELTA (10 s on the Base WETH/USDC provider — measured by anvil-fork time warp), plus
/// Chainlink deviation / sequencer-uptime guards. This fixture models the whole guard family as one
/// `setStale(true)` switch (the recipe's probe-then-decode catches ANY revert — the exact selector is
/// irrelevant to the caller). `setBidAndAskPrice` models the maker re-posting (the adverse-drift
/// cell's lever): the pool's quotes re-anchor to the new values instantly, exactly like the real
/// oracle-anchored curve.
contract MetricPriceProvider {
    error PriceStale();

    uint128 private _bid;
    uint128 private _ask;
    bool private _stale;

    constructor(uint128 bid_, uint128 ask_) {
        require(bid_ > 0 && ask_ >= bid_, "Mnfl");
        _bid = bid_;
        _ask = ask_;
    }

    /// @notice Maker re-post (the drift lever).
    function setBidAndAskPrice(uint128 bid_, uint128 ask_) external {
        require(bid_ > 0 && ask_ >= bid_, "Mnfl");
        _bid = bid_;
        _ask = ask_;
    }

    /// @notice Flip the staleness guard (models MAX_TIME_DELTA / Chainlink-deviation / sequencer-grace
    /// reverts — the recipe catches any revert, so one switch covers the family).
    function setStale(bool stale_) external {
        _stale = stale_;
    }

    /// @notice The REAL provider surface — reverts when stale (the 0x9a0423af class).
    function getBidAndAskPrice() external view returns (uint128 bid, uint128 ask) {
        if (_stale) revert PriceStale();
        return (_bid, _ask);
    }
}
