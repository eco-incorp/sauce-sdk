// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// NOTE: the poolByPair registry this adapter is registered on is the SHARED AlgebraFactory from
// AlgebraPool.sol — Integral keeps the same one-base-pool-per-pair poolByPair surface, so the
// factory fixture is reused unchanged (no import needed here; the test deploys it separately).

interface IERC20MinI {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice The engine re-entry an Algebra-based pool fires mid-swap to pull input (sauce#186).
///         Integral pools use the SAME `algebraSwapCallback` selector as Algebra v1.
interface IAlgebraSwapCallbackI {
    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice The inner REAL Uniswap V3 pool this adapter drives (see AlgebraPool.sol — the adapter
///         holds NO swap math of its own, so the executed output is wei-exact V3 math).
interface IUniswapV3PoolMinI {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function liquidity() external view returns (uint128);
    function tickSpacing() external view returns (int24);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function ticks(int24 tick)
        external
        view
        returns (
            uint128 liquidityGross,
            int128 liquidityNet,
            uint256 feeGrowthOutside0X128,
            uint256 feeGrowthOutside1X128,
            int56 tickCumulativeOutside,
            uint160 secondsPerLiquidityOutsideX128,
            uint32 secondsOutside,
            bool initialized
        );
}

/// @notice An Algebra INTEGRAL (THENA V3,3 / SwapX / nest / Kittenswap) pool ADAPTER for local
///         EVM tests — the Integral-layout sibling of AlgebraPool.sol (READ that header first;
///         the swap/callback plumbing is identical and is not re-explained here).
///
/// WHAT DIFFERS FROM AlgebraPool (the Algebra-v1/Camelot-shaped adapter) — the whole point of
/// this fixture is that Integral returns SHORTER tuples for the SAME selectors:
///
///   - `globalState()` is SIX words: (uint160 price, int24 tick, uint16 lastFee,
///     uint8 pluginConfig, uint16 communityFee, bool unlocked). The single dynamic fee
///     (`lastFee`) sits at word 2; word 3 is `pluginConfig` — a plugin-hook BITMASK, NOT a fee.
///     A consumer that typed-decodes the 8-word Camelot shape REVERTS on this returndata (which
///     is exactly what the off-chain shape-tolerant fallback + the lens's algSingleFee=1 word-2
///     read must survive), and a consumer that misreads word 3 as a directional fee picks up the
///     POISON pluginConfig value instead of the real fee — corrupting pricing in a way the
///     prod-mirror's wei-exact and feePpm asserts catch.
///
///   - `ticks()` is SIX words: (uint256 liquidityTotal, int128 liquidityDelta, int24 prevTick,
///     int24 nextTick, uint256 outerFeeGrowth0Token, uint256 outerFeeGrowth1Token).
///     `liquidityDelta` (== Uniswap V3's liquidityNet) is STILL index 1 — the slot the solver
///     and lens read — but there is NO trailing `initialized` bool (Integral threads initialized
///     ticks into the prev/next linked list instead). prevTick/nextTick are proxied as 0 (the
///     recipe never reads them; carrying real list pointers would require re-implementing
///     Integral's TickManagement for zero test signal).
///
/// Like AlgebraPool, this adapter deliberately exposes NO slot0() — a real Integral pool has
/// none, so any solver/lens fallback to slot0() reverts the cook instead of silently passing.
contract AlgebraIntegralPool {
    address public inner; // the genuine Uniswap V3 pool whose swap math we delegate to
    address public token0;
    address public token1;
    uint16 public lastFee; // the single Integral dynamic fee (globalState word 2)
    uint8 public pluginConfig; // POISON non-fee word 3 (a plugin bitmask on a real pool)

    // Transient: the original caller of swap() (the engine), re-entered via algebraSwapCallback.
    address private _activeCaller;

    function initialize(address innerPool, uint16 dynLastFee, uint8 pluginConfigPoison) external {
        require(inner == address(0), "INITIALIZED");
        inner = innerPool;
        token0 = IUniswapV3PoolMinI(innerPool).token0();
        token1 = IUniswapV3PoolMinI(innerPool).token1();
        lastFee = dynLastFee;
        pluginConfig = pluginConfigPoison;
    }

    // ── Algebra INTEGRAL read surface (what the lens reads) ──────────────────

    /// @notice Integral's 6-word globalState. price/tick proxied from the inner V3 pool's
    ///         slot0(); the single dynamic fee (lastFee) at word 2; the POISON pluginConfig
    ///         at word 3 (any decode that treats word 3 as a fee reads garbage — by design).
    function globalState()
        external
        view
        returns (
            uint160 price,
            int24 tick,
            uint16 fee,
            uint8 plugin,
            uint16 communityFee,
            bool unlocked
        )
    {
        (uint160 sp, int24 tk,,,,,) = IUniswapV3PoolMinI(inner).slot0();
        return (sp, tk, lastFee, pluginConfig, 0, true);
    }

    function liquidity() external view returns (uint128) {
        return IUniswapV3PoolMinI(inner).liquidity();
    }

    /// @notice Integral tickSpacing is PER-POOL (a settable pool property, not a factory
    ///         constant) — proxied from the inner pool, which was created at the captured value.
    function tickSpacing() external view returns (int24) {
        return IUniswapV3PoolMinI(inner).tickSpacing();
    }

    /// @notice Integral's 6-word ticks(): liquidityDelta (== liquidityNet) STILL at index 1,
    ///         NO trailing initialized bool. prevTick/nextTick proxied as 0 (never read).
    function ticks(int24 tick)
        external
        view
        returns (
            uint256 liquidityTotal,
            int128 liquidityDelta,
            int24 prevTick,
            int24 nextTick,
            uint256 outerFeeGrowth0Token,
            uint256 outerFeeGrowth1Token
        )
    {
        (uint128 gross, int128 net,,,,,,) = IUniswapV3PoolMinI(inner).ticks(tick);
        return (uint256(gross), net, 0, 0, 0, 0);
    }

    // ── Algebra swap surface (identical plumbing to AlgebraPool.sol) ─────────

    /// @notice Selector-identical to Uniswap V3's swap(). Drives the inner pool and re-enters the
    ///         engine via algebraSwapCallback to pull input — the Algebra-specific path.
    function swap(
        address recipient,
        bool zeroToOne,
        int256 amountRequired,
        uint160 limitSqrtPrice,
        bytes calldata /* data */
    ) external returns (int256 amount0, int256 amount1) {
        _activeCaller = msg.sender;

        (amount0, amount1) = IUniswapV3PoolMinI(inner).swap(
            address(this), zeroToOne, amountRequired, limitSqrtPrice, ""
        );

        _activeCaller = address(0);

        if (amount0 < 0) {
            IERC20MinI(token0).transfer(recipient, uint256(-amount0));
        }
        if (amount1 < 0) {
            IERC20MinI(token1).transfer(recipient, uint256(-amount1));
        }
    }

    /// @notice The inner Uniswap V3 pool calls THIS during its swap to collect the owed input;
    ///         we re-enter the ORIGINAL caller (the engine) via algebraSwapCallback and forward
    ///         the collected input to the inner pool. Same plumbing as AlgebraPool.sol.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == inner, "ONLY_INNER");
        address caller = _activeCaller;
        require(caller != address(0), "NO_ACTIVE_SWAP");

        IAlgebraSwapCallbackI(caller).algebraSwapCallback(amount0Delta, amount1Delta, "");

        if (amount0Delta > 0) {
            IERC20MinI(token0).transfer(inner, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IERC20MinI(token1).transfer(inner, uint256(amount1Delta));
        }
    }
}
