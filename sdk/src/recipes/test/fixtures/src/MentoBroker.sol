// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Local Mento V2 (Celo mento-protocol/mento-core) BiPoolManager fixture — the ENUMERABLE exchange
/// provider. Mirrors the REAL VERIFIED IExchangeProvider surface (mento-core
/// contracts/interfaces/IExchangeProvider.sol; BiPoolManager 0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901):
///   struct Exchange { bytes32 exchangeId; address[] assets; }   // assets length 2 for a BiPool exchange
///   getExchanges() view -> Exchange[]
/// The recipe's discovery calls Broker.getExchangeProviders() -> provider.getExchanges() to map
/// (tokenIn,tokenOut) -> (exchangeProvider, exchangeId). This fixture registers a single exchange for a
/// pair; the exchangeId is a deterministic hash of the assets (a plausible stand-in for the real keccak).
contract MentoBiPoolManager {
    struct Exchange {
        bytes32 exchangeId;
        address[] assets;
    }

    Exchange[] internal _exchanges;

    /// @notice Register a BiPool exchange for (asset0, asset1). exchangeId is a deterministic hash of the
    /// assets — the recipe treats it as an opaque bytes32, so any collision-free value works.
    function registerExchange(address asset0, address asset1) external returns (bytes32 exchangeId) {
        exchangeId = keccak256(abi.encodePacked(asset0, asset1));
        address[] memory assets = new address[](2);
        assets[0] = asset0;
        assets[1] = asset1;
        _exchanges.push(Exchange({ exchangeId: exchangeId, assets: assets }));
    }

    /// @notice REAL IExchangeProvider surface — the registered exchanges (nested dynamic address[] assets).
    function getExchanges() external view returns (Exchange[] memory) {
        return _exchanges;
    }
}

/// @notice Local Mento V2 Broker fixture — the swap entry point. Mirrors the REAL VERIFIED IBroker /
/// Broker.sol surface (mento-core contracts/swap/Broker.sol + contracts/interfaces/IBroker.sol; Broker
/// 0x777A8255cA72412f0d706dc03C9D1987306B4CaD):
///   getExchangeProviders() view -> address[]
///   getAmountOut(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut,
///                uint256 amountIn) view -> uint256 amountOut
///   swapIn(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut,
///          uint256 amountIn, uint256 amountOutMin) -> uint256 amountOut
///     — pulls tokenIn from msg.sender via safeTransferFrom into the Broker (the real Broker's transferIn
///       pulls a collateral asset into the RESERVE; for a stable-asset input it burns — either way the
///       caller must APPROVE THE BROKER first), sends amountOut to msg.sender (transferOut → mint stable /
///       reserve collateral transfer). amountOutMin is enforced (slippage guard).
///
/// PRICING off SETTABLE bucket state (canonical on-chain: BiPoolManager prices off oracle rates + a spread
/// over interval-updated pricing buckets), NOT a hardcoded xy=k here. The out is a re-centered oracle rate
///   grossOut = amountIn · rateOut / rateIn · centerPrice / 1e18
/// minus a size-dependent bucket-utilization slippage (dx²/depth), minus the swap spread, then CAPPED by a
/// per-side trading limit `outCap` (past the limit the quote is 0 — the tradeable-range edge, like the real
/// TradingLimits). `setBuckets` MOVES the oracle rates / center price (models a bucket refresh on
/// referenceRateResetFrequency); `setBreaker` trips a circuit breaker (swapIn reverts, getAmountOut does
/// not — matching the real BreakerBox nuance) so a test can move state / break between prepare and cook.
/// This fixture exposes ONLY the verified real surface — no invented getters.
contract MentoBroker {
    uint256 private constant SPREAD_SCALE = 1e6;
    uint256 private constant RATE_SCALE = 1e18;

    address[] internal _exchangeProviders;

    // Per-exchange bucket state, keyed by (provider, exchangeId). Settable — models the buckets
    // refreshing + re-centering.
    struct Bucket {
        address asset0;
        address asset1;
        uint256 rate0; // oracle rate for asset0 (1e18)
        uint256 rate1; // oracle rate for asset1 (1e18)
        uint256 centerPrice; // re-centering center price (1e18, asset1 per asset0)
        uint256 spreadPpm; // swap spread, 1e6-scaled (0.01% = 100)
        uint256 depth; // bucket-utilization slippage depth (larger ⇒ deeper/flatter); 0 ⇒ none
        uint256 outCap0; // trading limit: max asset0-out for a 1→0 swap; 0 ⇒ unbounded
        uint256 outCap1; // trading limit: max asset1-out for a 0→1 swap; 0 ⇒ unbounded
        bool set;
    }

    mapping(address => mapping(bytes32 => Bucket)) internal _buckets;
    bool internal _breakerTripped;

    event Swap(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);

    /// @notice Register an exchange provider (the BiPoolManager) — the real Broker holds a list.
    function addExchangeProvider(address provider) external {
        _exchangeProviders.push(provider);
    }

    /// @notice REAL IBroker surface — the registered exchange providers.
    function getExchangeProviders() external view returns (address[] memory) {
        return _exchangeProviders;
    }

    /// @notice Configure the bucket state for an exchange (models the oracle rates / center price / spread /
    /// trading limits the BiPoolManager holds). exchangeId + provider identify the exchange.
    function configureExchange(
        address provider,
        bytes32 exchangeId,
        address asset0,
        address asset1,
        uint256 rate0,
        uint256 rate1,
        uint256 centerPrice,
        uint256 spreadPpm,
        uint256 depth
    ) external {
        Bucket storage b = _buckets[provider][exchangeId];
        b.asset0 = asset0;
        b.asset1 = asset1;
        b.rate0 = rate0;
        b.rate1 = rate1;
        b.centerPrice = centerPrice;
        b.spreadPpm = spreadPpm;
        b.depth = depth;
        b.set = true;
    }

    /// @notice Move the bucket oracle rates / center price (models a bucket refresh on
    /// referenceRateResetFrequency) — the drift hook.
    function setBuckets(address provider, bytes32 exchangeId, uint256 rate0, uint256 rate1, uint256 centerPrice) external {
        Bucket storage b = _buckets[provider][exchangeId];
        b.rate0 = rate0;
        b.rate1 = rate1;
        b.centerPrice = centerPrice;
    }

    /// @notice Set the per-side trading-limit out-caps (models a limit shrinking before cook). 0 ⇒ none.
    function setCaps(address provider, bytes32 exchangeId, uint256 outCap0, uint256 outCap1) external {
        Bucket storage b = _buckets[provider][exchangeId];
        b.outCap0 = outCap0;
        b.outCap1 = outCap1;
    }

    /// @notice Trip / clear a BreakerBox circuit breaker. When tripped, swapIn reverts (getAmountOut still
    /// returns a value — the real BreakerBox nuance: getAmountOut does not check breakers).
    function setBreaker(bool tripped) external {
        _breakerTripped = tripped;
    }

    // ── BiPool bucket math (canonical on-chain state; re-centering + spread) ─────

    function _grossOut(Bucket storage b, bool zeroForOne, uint256 amountIn) internal view returns (uint256) {
        if (amountIn == 0) return 0;
        uint256 par;
        if (zeroForOne) {
            // asset0 → asset1: value in asset1 units at the oracle rates + center price.
            uint256 g = (amountIn * b.rate0) / b.rate1;
            par = (g * b.centerPrice) / RATE_SCALE;
        } else {
            // asset1 → asset0: inverse center price.
            uint256 g2 = (amountIn * b.rate1) / b.rate0;
            par = (g2 * RATE_SCALE) / b.centerPrice;
        }
        // Bucket-utilization slippage: the out is reduced by amountIn²/depth (convex in size), so a deeper
        // bucket (larger depth) is flatter and the split equalizes marginals across venues of different depth.
        if (b.depth != 0) {
            uint256 slip = (amountIn * amountIn) / b.depth;
            par = par > slip ? par - slip : 0;
        }
        return par;
    }

    function _netOut(address provider, bytes32 exchangeId, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (uint256)
    {
        Bucket storage b = _buckets[provider][exchangeId];
        require(b.set, "Mento: exchange_unset");
        bool zeroForOne;
        if (tokenIn == b.asset0 && tokenOut == b.asset1) zeroForOne = true;
        else if (tokenIn == b.asset1 && tokenOut == b.asset0) zeroForOne = false;
        else revert("Mento: bad_tokens");
        uint256 gross = _grossOut(b, zeroForOne, amountIn);
        if (gross == 0) return 0;
        uint256 spread = (gross * b.spreadPpm) / SPREAD_SCALE;
        uint256 net = gross > spread ? gross - spread : 0;
        // Trading-limit cap on the OUT side — past the limit the swap is not fillable (quote 0).
        uint256 cap = zeroForOne ? b.outCap1 : b.outCap0;
        if (cap != 0 && net > cap) return 0;
        return net;
    }

    /// @notice REAL IBroker surface — the exact-in quote at the CURRENT bucket state. A plain VIEW (does not
    /// check the breaker — matching the real getAmountOut, which does NOT enforce TradingLimits/BreakerBox).
    function getAmountOut(
        address exchangeProvider,
        bytes32 exchangeId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view returns (uint256 amountOut) {
        amountOut = _netOut(exchangeProvider, exchangeId, tokenIn, tokenOut, amountIn);
    }

    /// @notice REAL IBroker surface — exact-in swap. Pulls tokenIn from msg.sender approve-first (the real
    /// Broker pulls a collateral asset into the reserve / burns a stable), sends amountOut to msg.sender.
    /// Enforces amountOutMin (slippage) + reverts on a tripped breaker (TradingLimits/BreakerBox).
    function swapIn(
        address exchangeProvider,
        bytes32 exchangeId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) external returns (uint256 amountOut) {
        require(!_breakerTripped, "Mento: breaker_tripped");
        amountOut = _netOut(exchangeProvider, exchangeId, tokenIn, tokenOut, amountIn);
        require(amountOut >= amountOutMin, "Mento: amountOut_LT_min");
        require(amountOut > 0, "Mento: zero_out");
        require(IERC20Min(tokenIn).transferFrom(msg.sender, address(this), amountIn), "Mento: pull");
        IERC20Min(tokenOut).transfer(msg.sender, amountOut);
        emit Swap(exchangeProvider, exchangeId, tokenIn, tokenOut, amountIn, amountOut);
    }
}
