// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IMetricProviderMin {
    function getBidAndAskPrice() external view returns (uint128 bid, uint128 ask);
}

interface IMetricOmmSwapCallbackMin {
    function metricOmmSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice Local METRIC (metric.xyz) per-pair POOL fixture for EcoSwap's Metric path (QL segKind 17).
/// It mirrors the REAL pool SURFACES the recipe touches (probed live on Base 2026-07-04; the real pool
/// is UNVERIFIED — bytecode-probed, live-tx-decoded and fork-executed):
///
///   getImmutables() — the recipe reads word [1] = priceProvider, [2] = token0, [3] = token1 (word [0]
///     = the protocol config contract). The REAL Base pool returns 14 words; this fixture returns the
///     SAME 14-word shape (tail zero-padded) so positional decodes are wire-identical.
///
///   The QUOTE — the real pool's own quote fn is a revert-carrying simulation the ROUTER catches and
///     decodes (the Uniswap Quoter pattern; recipe-invisible — the recipe only calls Router.quoteSwap,
///     a clean view). This fixture exposes `quote(...)` as a PLAIN view the router forwards: the
///     recipe-visible wire behavior (a staticcall returning two int256, or a revert on garbage
///     anchors) is identical. Conventions reproduced EXACTLY as probed on the real pool:
///       · signed deltas: IN delta POSITIVE == the amount actually CONSUMED (an oversized ask
///         PARTIAL-FILLS at the bin/inventory capacity); OUT delta NEGATIVE;
///       · DIRECTIONAL price limit: xToY fills while the bin price sits ABOVE the limit (0 ⇒
///         unbounded; a wrong-side uint128.max ⇒ (0,0) at bin 0); yToX fills while the bin price sits
///         BELOW the limit (uint128.max ⇒ unbounded; a wrong-side 0 ⇒ (0,0)) — the resolved
///         reverse-direction convention;
///       · garbage anchors revert ("Mnfl" — bid == 0 or bid > ask), zero amount reverts ("M10");
///       · an EMPTY pool quotes (0,0) gracefully (the inventory guard).
///
///   The SWAP — pool pays the OUT to `recipient` FIRST, then re-enters
///     `metricOmmSwapCallback(int256,int256,bytes)` on msg.sender (the ROUTER implements it), then
///     balance-checks the pulled input — the exact call order debug-traced on the real Base pool. The
///     swap reads the PROVIDER ITSELF (staleness reverts propagate — quote takes the anchor as args,
///     the swap does not: also the real split). Emits the REAL Swap event signature:
///     Swap(address,address,bool,int128,int128,int16,uint104).
///
/// THE CURVE (fixture-deterministic; the real bin math is unverified bytecode — the prod-mirror covers
/// it): an oracle-ANCHORED bin walk. Selling X (xToY) fills descending bins priced
///   p_k = bid · (SCALE − k·stepPpm) / SCALE      (X64; k = 0, 1, …)
/// each with capacity `binCapIn0` of X; buying X (yToX) fills ascending bins priced
///   p_k = ask · (SCALE + k·stepPpm) / SCALE
/// each with capacity `binCapIn1` of Y. out_k = take·p_k/2^64 (xToY) or take·2^64/p_k (yToX), floored;
/// the walk stops at the OUT-token inventory (partial fill — the consumed input is what the deltas
/// report) or the price limit; the fee (1e6-scaled) nets off the TOTAL gross out. STATELESS across
/// swaps modulo inventory: every quote re-anchors at the CURRENT provider post (bin 0), so a maker
/// re-post (the drift cell) moves the whole curve — the oracle-anchored re-centering the real OMM
/// class exhibits. Bit-replayable off-chain in bigints (the test's getDy model).
contract MetricPool {
    uint256 private constant SCALE = 1e6;
    uint256 private constant X64 = 1 << 64;
    uint256 private constant MAX_BINS = 4096;

    address private immutable _factory; // word [0] of getImmutables (the real pool's config contract)
    address private immutable _provider;
    address private immutable _token0;
    address private immutable _token1;
    uint256 private immutable _feePpm; // 1e6-scaled, netted off the total gross out
    uint256 private immutable _binCapIn0; // per-bin capacity of token0 IN (xToY)
    uint256 private immutable _binCapIn1; // per-bin capacity of token1 IN (yToX)
    uint256 private immutable _stepPpm; // per-bin price degradation (1e6-scaled)

    uint104 private _positionInBin; // nominal fill counter (the Swap event field)

    event Swap(
        address sender,
        address recipient,
        bool exactInput,
        int128 amount0Delta,
        int128 amount1Delta,
        int16 newTick,
        uint104 newPositionInBin
    );

    constructor(
        address provider_,
        address token0_,
        address token1_,
        uint256 feePpm_,
        uint256 binCapIn0_,
        uint256 binCapIn1_,
        uint256 stepPpm_
    ) {
        require(binCapIn0_ > 0 && binCapIn1_ > 0 && stepPpm_ > 0 && stepPpm_ < SCALE, "M-cfg");
        _factory = address(0);
        _provider = provider_;
        _token0 = token0_;
        _token1 = token1_;
        _feePpm = feePpm_;
        _binCapIn0 = binCapIn0_;
        _binCapIn1 = binCapIn1_;
        _stepPpm = stepPpm_;
    }

    /// @notice The REAL pool's 14-word immutables shape — the recipe decodes [1]/[2]/[3].
    function getImmutables()
        external
        view
        returns (
            address factory,
            address priceProvider,
            address token0,
            address token1,
            uint256 p4,
            uint256 p5,
            uint256 p6,
            uint256 p7,
            uint256 p8,
            uint256 p9,
            int256 p10,
            int256 p11,
            uint256 p12,
            uint256 p13
        )
    {
        return (_factory, _provider, _token0, _token1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }

    // ── the bin walk (shared by quote + swap; view — inventory read via balanceOf) ──
    function _walk(bool xToY, uint256 amountIn, uint128 priceLimit, uint128 bid, uint128 ask)
        internal
        view
        returns (uint256 inConsumed, uint256 outNet)
    {
        require(bid > 0 && ask >= bid, "Mnfl");
        address outToken = xToY ? _token1 : _token0;
        uint256 avail = IERC20Min(outToken).balanceOf(address(this));
        uint256 binCap = xToY ? _binCapIn0 : _binCapIn1;
        uint256 remaining = amountIn;
        uint256 gross = 0;
        for (uint256 k = 0; k < MAX_BINS && remaining > 0; k++) {
            uint256 pk;
            if (xToY) {
                uint256 down = k * _stepPpm;
                if (down >= SCALE) break; // price walked to zero
                pk = (uint256(bid) * (SCALE - down)) / SCALE;
                if (pk == 0) break;
                // DIRECTIONAL limit: the price FALLS through bins; stop once at/below the limit.
                // limit 0 ⇒ unbounded; a wrong-side max ⇒ break at k == 0 ⇒ (0,0) — as probed.
                if (priceLimit != 0 && pk <= priceLimit) break;
            } else {
                pk = (uint256(ask) * (SCALE + k * _stepPpm)) / SCALE;
                // DIRECTIONAL limit: the price RISES; stop once at/above the limit.
                // limit max ⇒ unbounded (pk < max within uint128); a wrong-side 0 ⇒ break at k == 0.
                if (pk >= priceLimit) break;
            }
            uint256 take = remaining < binCap ? remaining : binCap;
            uint256 o = xToY ? (take * pk) / X64 : (take * X64) / pk;
            if (o == 0) break;
            if (gross + o > avail) break; // OUT inventory exhausted — partial fill (whole bins only)
            gross += o;
            remaining -= take;
        }
        inConsumed = amountIn - remaining;
        outNet = (gross * (SCALE - _feePpm)) / SCALE;
    }

    /// @notice The pool-side quote the ROUTER forwards (recipe-invisible — the recipe calls
    /// Router.quoteSwap). Reverts "Mnfl" on garbage anchors, "M10" on a non-positive amount; (0,0)
    /// gracefully on a wrong-side limit / an empty pool — all as probed on the real stack.
    function quote(bool xToY, int128 amountSpecified, uint128 priceLimit, uint128 bid, uint128 ask)
        external
        view
        returns (int256 amount0Delta, int256 amount1Delta)
    {
        require(amountSpecified > 0, "M10");
        (uint256 inC, uint256 outNet) = _walk(xToY, uint256(uint128(amountSpecified)), priceLimit, bid, ask);
        if (outNet == 0) return (0, 0); // graceful — mirrors the real (0,0) classes
        if (xToY) return (int256(inC), -int256(outNet));
        return (-int256(outNet), int256(inC));
    }

    /// @notice The pool-side swap (the ROUTER calls it; `data` is opaque router context). Reads the
    /// PROVIDER itself (staleness reverts propagate), pays the out FIRST, then re-enters
    /// metricOmmSwapCallback on msg.sender (the router) and balance-checks the pull — the traced
    /// real call order.
    function swap(address recipient, bool xToY, int128 amountSpecified, uint128 priceLimit, bytes calldata data)
        external
        returns (int256 amount0Delta, int256 amount1Delta)
    {
        require(amountSpecified > 0, "M10");
        (uint128 bid, uint128 ask) = IMetricProviderMin(_provider).getBidAndAskPrice();
        (uint256 inC, uint256 outNet) = _walk(xToY, uint256(uint128(amountSpecified)), priceLimit, bid, ask);
        address inToken = xToY ? _token0 : _token1;
        address outToken = xToY ? _token1 : _token0;
        if (xToY) {
            amount0Delta = int256(inC);
            amount1Delta = -int256(outNet);
        } else {
            amount0Delta = -int256(outNet);
            amount1Delta = int256(inC);
        }
        if (outNet > 0) {
            require(IERC20Min(outToken).transfer(recipient, outNet), "M-pay");
        }
        uint256 balBefore = IERC20Min(inToken).balanceOf(address(this));
        IMetricOmmSwapCallbackMin(msg.sender).metricOmmSwapCallback(amount0Delta, amount1Delta, data);
        require(IERC20Min(inToken).balanceOf(address(this)) >= balBefore + inC, "M-pull");
        _positionInBin += 1;
        emit Swap(msg.sender, recipient, true, int128(amount0Delta), int128(amount1Delta), int16(0), _positionInBin);
    }
}
