// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Faithful KyberSwap Classic / DMM pool for local EVM tests.
///
/// Kyber Classic is an AMPLIFIED constant-product AMM: it trades on VIRTUAL reserves
/// (vReserve = reserve + (amp-1)·reserveAtCreation, so vReserve tracks reserve with a
/// constant offset). The curve geometry (price/depth) is set by the virtual reserves,
/// and getAmountOut is the constant-product formula on the VIRTUAL reserves:
///   amountInWithFee = amountIn·(PRECISION - feeInPrecision)/PRECISION
///   amountOut       = amountInWithFee·vReserveOut / (vReserveIn + amountInWithFee)
///
/// The harness ETCHES this runtime at a chosen address (no constructor logic — state is
/// set via initialize/sync), registers it on a KyberClassicFactory's getPools, and drives
/// it through EcoSwap's CALLBACK-FREE path: the caller transfers the input first, then
/// calls swap(a0Out, a1Out, to, "") with EMPTY callbackData (no swapCallback re-entry —
/// matching the real DMM pool, which only calls back when callbackData.length > 0).
///
/// Storage layout (deliberately simple + unpacked):
///   slot 0: token0  slot 1: token1
///   slot 2: reserve0  slot 3: reserve1
///   slot 4: vReserve0 slot 5: vReserve1
///   slot 6: feeInPrecision (1e18-scaled)
contract KyberClassicPool {
    uint256 private constant PRECISION = 1e18;

    address public token0; // slot 0
    address public token1; // slot 1
    uint256 private _reserve0; // slot 2
    uint256 private _reserve1; // slot 3
    uint256 private _vReserve0; // slot 4
    uint256 private _vReserve1; // slot 5
    uint256 public feeInPrecision; // slot 6

    event Swap(address indexed sender, uint256 amount0Out, uint256 amount1Out, address indexed to);
    event Sync(uint256 reserve0, uint256 reserve1, uint256 vReserve0, uint256 vReserve1);

    /// @notice Set the token pair + fee + the AMPLIFICATION-implied virtual-reserve offset.
    ///         `vReserveBoost0/1` are the EXTRA virtual reserve over the real reserve (i.e.
    ///         (amp-1)·reserveAtCreation) — the constant offset Kyber bakes in at creation.
    function initialize(
        address t0,
        address t1,
        uint256 feeInPrec,
        uint256 vBoost0,
        uint256 vBoost1
    ) external {
        require(token0 == address(0) && token1 == address(0), "INITIALIZED");
        token0 = t0;
        token1 = t1;
        feeInPrecision = feeInPrec;
        // Stash the boosts in the vReserve slots; sync() adds them to the real reserves.
        _vReserve0 = vBoost0;
        _vReserve1 = vBoost1;
    }

    function getTradeInfo()
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256)
    {
        return (_reserve0, _reserve1, _vReserve0, _vReserve1, feeInPrecision);
    }

    /// @notice Snap real reserves to balances, then set virtual = real + boost. Must be called
    ///         after funding the pool (the boost was stashed in the vReserve slots at init).
    function sync() external {
        uint256 boost0 = _vReserve0;
        uint256 boost1 = _vReserve1;
        _reserve0 = IERC20Min(token0).balanceOf(address(this));
        _reserve1 = IERC20Min(token1).balanceOf(address(this));
        _vReserve0 = _reserve0 + boost0;
        _vReserve1 = _reserve1 + boost1;
        emit Sync(_reserve0, _reserve1, _vReserve0, _vReserve1);
    }

    /// @notice Callback-free DMM swap. The caller must have already transferred the input.
    ///         With empty callbackData the pool does NOT call back (real DMM behavior). The
    ///         K-invariant is enforced on the VIRTUAL reserves (net of the per-pool fee).
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata callbackData)
        external
    {
        require(amount0Out > 0 || amount1Out > 0, "INSUFFICIENT_OUTPUT_AMOUNT");
        uint256 r0 = _reserve0;
        uint256 r1 = _reserve1;
        require(amount0Out < r0 && amount1Out < r1, "INSUFFICIENT_LIQUIDITY");
        // Real DMM only re-enters on non-empty callbackData; EcoSwap uses empty data.
        require(callbackData.length == 0, "CALLBACK_UNSUPPORTED_IN_TEST");

        if (amount0Out > 0) IERC20Min(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20Min(token1).transfer(to, amount1Out);

        uint256 bal0 = IERC20Min(token0).balanceOf(address(this));
        uint256 bal1 = IERC20Min(token1).balanceOf(address(this));

        {
            uint256 amount0In = bal0 > r0 - amount0Out ? bal0 - (r0 - amount0Out) : 0;
            uint256 amount1In = bal1 > r1 - amount1Out ? bal1 - (r1 - amount1Out) : 0;
            require(amount0In > 0 || amount1In > 0, "INSUFFICIENT_INPUT_AMOUNT");

            // Virtual reserves shift by the SAME deltas as the real reserves (amp is constant,
            // so vReserve = reserve + boost throughout). Enforce the constant-product invariant
            // on the VIRTUAL reserves net of the fee. The fee is applied as a fee-adjusted
            // virtual reserve (subtract amountIn·fee/PRECISION) so the K product stays well
            // within uint256 — vReserve² ~ 1e48, no PRECISION² blow-up.
            uint256 newVReserve0 = _vReserve0 + amount0In - amount0Out;
            uint256 newVReserve1 = _vReserve1 + amount1In - amount1Out;
            uint256 vBal0Adj = newVReserve0 - (amount0In * feeInPrecision) / PRECISION;
            uint256 vBal1Adj = newVReserve1 - (amount1In * feeInPrecision) / PRECISION;
            require(vBal0Adj * vBal1Adj >= _vReserve0 * _vReserve1, "K");

            _vReserve0 = newVReserve0;
            _vReserve1 = newVReserve1;
        }

        _reserve0 = bal0;
        _reserve1 = bal1;
        emit Swap(msg.sender, amount0Out, amount1Out, to);
    }
}

/// @notice Minimal DMM factory: getPools(token0, token1) → the registered pool(s).
contract KyberClassicFactory {
    mapping(bytes32 => address[]) private _pools;

    function _key(address a, address b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function addPool(address tokenA, address tokenB, address pool) external {
        _pools[_key(tokenA, tokenB)].push(pool);
    }

    function getPools(address tokenA, address tokenB) external view returns (address[] memory) {
        return _pools[_key(tokenA, tokenB)];
    }
}
