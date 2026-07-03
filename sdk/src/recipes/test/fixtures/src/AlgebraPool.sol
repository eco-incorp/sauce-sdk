// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice The engine re-entry an Algebra-based pool fires mid-swap to pull input. DIFFERENT
///         selector than uniswapV3SwapCallback / pancakeV3SwapCallback — the whole point of
///         this fixture is to exercise the engine's `algebraSwapCallback` handler (sauce#186).
interface IAlgebraSwapCallback {
    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice The inner REAL Uniswap V3 pool this adapter drives. The adapter holds NO swap math of
///         its own — it delegates to a genuine v3-core pool so the executed output is wei-exact V3
///         math, the same math the EcoSwap oracle/lens replay off-chain.
interface IUniswapV3PoolMin {
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

/// @notice An Algebra-fork (Camelot V3 / QuickSwap V3 / Ramses V2) pool ADAPTER for local EVM tests.
///
/// Algebra pools are V3-shaped concentrated-liquidity pools: their `swap()` is selector-identical to
/// Uniswap V3 — swap(address recipient, bool zeroToOne, int256 amountRequired, uint160 limitSqrtPrice,
/// bytes data) — so the engine's `_swapV3` drives an Algebra pool UNCHANGED. The ONLY behavioral
/// difference is the mid-swap re-entry: an Algebra pool calls `algebraSwapCallback` (NOT
/// `uniswapV3SwapCallback`) to pull the input. The engine now services that selector (sauce#186), so
/// this fixture proves the round-trip end to end.
///
/// To stay WEI-EXACT against the EcoSwap V3 oracle (which replays Uniswap-V3 swap math), this adapter
/// does NOT reimplement the swap curve — it wraps a GENUINE v3-core pool (`inner`), forwards every
/// read the lens needs to it, and on `swap()`:
///   1. drives `inner.swap(address(this), …)` with the SAME params the engine passed,
///   2. services the inner pool's `uniswapV3SwapCallback` by re-entering the ORIGINAL caller (the
///      engine) via `algebraSwapCallback` — so the engine pulls the input into THIS adapter, which
///      then forwards it to the inner pool (matching a real Algebra pool's input-pull semantics),
///   3. forwards the inner pool's output to the swap `recipient`, and returns the inner deltas.
///
/// The adapter EXPOSES the Algebra read surface the lens uses: `globalState()` (price/tick + the
/// DYNAMIC fee, in place of slot0()), `liquidity()`, `tickSpacing()`, `ticks(int24)`. The dynamic
/// fee is configured at init (feeZto/feeOtz) and, for wei-exactness, equals the inner pool's fee
/// tier — so the lens reads the SAME fee the inner pool actually charges.
contract AlgebraPool {
    address public inner; // the genuine Uniswap V3 pool whose swap math we delegate to
    address public token0;
    address public token1;
    uint16 public feeZto; // dynamic fee for zeroToOne (== inner fee tier, for wei-exact pricing)
    uint16 public feeOtz; // dynamic fee for oneToZero

    // Transient: the original caller of swap() (the engine), re-entered via algebraSwapCallback.
    address private _activeCaller;

    function initialize(address innerPool, uint16 dynFeeZto, uint16 dynFeeOtz) external {
        require(inner == address(0), "INITIALIZED");
        inner = innerPool;
        token0 = IUniswapV3PoolMin(innerPool).token0();
        token1 = IUniswapV3PoolMin(innerPool).token1();
        feeZto = dynFeeZto;
        feeOtz = dynFeeOtz;
    }

    // ── Algebra read surface (what the lens reads) ───────────────────────────

    /// @notice Algebra's slot0() analogue. The lens reads price=[0], tick=[1], fee=[2]/[3] by
    ///         direction. Proxies price/tick from the inner Uniswap V3 pool's slot0() and reports
    ///         the configured dynamic fee per direction.
    function globalState()
        external
        view
        returns (
            uint160 price,
            int24 tick,
            uint16 fZto,
            uint16 fOtz,
            uint16 timepointIndex,
            uint8 communityFeeToken0,
            uint8 communityFeeToken1,
            bool unlocked
        )
    {
        (uint160 sp, int24 tk,,,,,) = IUniswapV3PoolMin(inner).slot0();
        return (sp, tk, feeZto, feeOtz, 0, 0, 0, true);
    }

    /// @notice A real Algebra pool has NO slot0() — it exposes globalState() (read above) for the
    ///         spot price/tick. This adapter DELIBERATELY does NOT expose a slot0() proxy: the EcoSwap
    ///         solver + lens MUST read globalState() for an Algebra pool (isAlgebra), and calling
    ///         slot0() on a real Algebra pool would revert the whole cook. Omitting it here UN-MASKS
    ///         that path — if the solver/lens mistakenly fell back to slot0(), the cook would revert.

    function liquidity() external view returns (uint128) {
        return IUniswapV3PoolMin(inner).liquidity();
    }

    function tickSpacing() external view returns (int24) {
        return IUniswapV3PoolMin(inner).tickSpacing();
    }

    /// @notice Algebra ticks() layout: (liquidityTotal, liquidityDelta, …). The lens reads [1]
    ///         (liquidityDelta == the inner pool's liquidityNet — same int128 layout/selector).
    function ticks(int24 tick)
        external
        view
        returns (
            uint128 liquidityTotal,
            int128 liquidityDelta,
            uint256 outerFeeGrowth0Token,
            uint256 outerFeeGrowth1Token,
            int56 outerTickCumulative,
            uint160 outerSecondsPerLiquidity,
            uint32 outerSecondsSpent,
            bool initialized
        )
    {
        (uint128 gross, int128 net,,,,,, bool init) = IUniswapV3PoolMin(inner).ticks(tick);
        return (gross, net, 0, 0, 0, 0, 0, init);
    }

    // ── Algebra swap surface (what the engine drives) ────────────────────────

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

        // Drive the genuine V3 pool with this adapter as the recipient so its output lands here
        // first; we forward it to `recipient` after. The inner pool re-enters us via
        // uniswapV3SwapCallback to collect input.
        (amount0, amount1) = IUniswapV3PoolMin(inner).swap(
            address(this), zeroToOne, amountRequired, limitSqrtPrice, ""
        );

        _activeCaller = address(0);

        // Forward the output token to the swap recipient (the engine), mirroring a real pool that
        // transfers the negative-delta side to its caller.
        if (amount0 < 0) {
            IERC20Min(token0).transfer(recipient, uint256(-amount0));
        }
        if (amount1 < 0) {
            IERC20Min(token1).transfer(recipient, uint256(-amount1));
        }
    }

    /// @notice The inner Uniswap V3 pool calls THIS during its swap to collect the owed input.
    ///         We pull that input from the ORIGINAL caller (the engine) by re-entering it via
    ///         algebraSwapCallback (the engine's transient context then transferFroms the payer
    ///         into THIS adapter), then forward the collected input to the inner pool.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == inner, "ONLY_INNER");
        address caller = _activeCaller;
        require(caller != address(0), "NO_ACTIVE_SWAP");

        // Re-enter the engine with the SAME deltas (positive = we owe input). The engine services
        // algebraSwapCallback (sauce#186) and transferFroms the payer's input into THIS adapter.
        IAlgebraSwapCallback(caller).algebraSwapCallback(amount0Delta, amount1Delta, "");

        // Forward the just-collected input to the inner pool (the side we owe).
        if (amount0Delta > 0) {
            IERC20Min(token0).transfer(inner, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IERC20Min(token1).transfer(inner, uint256(amount1Delta));
        }
    }
}

/// @notice Minimal Algebra factory: poolByPair(tokenA, tokenB) → the registered pool (one pool per
///         pair, no fee tiers — Algebra's dynamic fee lives on the pool, not the factory). Discovery
///         (`discoverAlgebraPools`) and the lens both resolve the pool via poolByPair.
contract AlgebraFactory {
    mapping(bytes32 => address) private _pools;

    function _key(address a, address b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function setPool(address tokenA, address tokenB, address pool) external {
        _pools[_key(tokenA, tokenB)] = pool;
    }

    function poolByPair(address tokenA, address tokenB) external view returns (address pool) {
        return _pools[_key(tokenA, tokenB)];
    }
}
