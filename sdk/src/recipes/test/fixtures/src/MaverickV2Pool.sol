// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IMaverickV2SwapCallback {
    function maverickV2SwapCallback(uint256 amountToPay, uint256 amountOut, bytes calldata data) external;
}

/// @notice Faithful minimal Maverick V2 (bin-based directional AMM) pool for local EVM tests of the
/// engine `_swapMaverickV2` + `maverickV2SwapCallback` path.
///
/// Reproduces the canonical Maverick V2 `TickMath` (tickSqrtPrice / getTickL / getSqrtPrice) + `SwapMath`
/// (computeSwapExactIn) + the multi-tick swap loop BIT-FOR-BIT with the off-chain bigint replay in
/// `sdk/src/recipes/shared/maverick-math.ts`. So the swap consumes/pays EXACTLY the off-chain
/// `getDy(pool, amountIn)` to the wei, and `calculateSwap` (the on-chain quoter analogue) returns the
/// SAME (amountIn, amountOut) — the wei-exact-in-dy gate.
///
/// The engine `_swapMaverickV2` is CALLBACK-based: it reads this pool's `tokenA()`, sets tokenAIn, and
/// calls `swap(recipient, SwapParams{amount, tokenAIn, exactOutput:false, tickLimit:0}, "")`. This
/// fixture's `swap` walks the tick book computing (amountIn, amountOut) at the PRE-swap state, then
/// re-enters the caller via `maverickV2SwapCallback(amountIn, amountOut, data)` to PULL the input, then
/// transfers the output to `recipient`. Pre-funded with both sides' reserves.
///
/// ENGINE tickLimit=0 CONSTRAINT: the engine hardcodes `tickLimit: 0`. This fixture applies exactly that
/// limit in its walk (a tokenA-in swap stops once currentTick > 0; a tokenB-in swap once currentTick < 0),
/// matching real Maverick. So the pool must be seeded with its active tick <= 0 for tokenA-in swaps (or
/// >= 0 for tokenB-in) or the swap fills nothing — see maverick-math.ts.
contract MaverickV2Pool {
    uint256 private constant ONE = 1e18;
    uint256 private constant ONE_SQUARED = ONE * ONE;
    uint256 private constant ONE_D3 = 1000;
    int256 private constant MAX_TICK = 322378;
    int32 private constant TICK_SEARCH_LIMIT = 200;

    address private immutable _tokenA;
    address private immutable _tokenB;
    uint256 public immutable tickSpacing;
    uint256 public immutable feeAIn; // 1e18-scaled
    uint256 public immutable feeBIn; // 1e18-scaled
    uint8 public immutable protocolFeeRatioD3;

    int32 public activeTick;
    uint256 public poolSqrtPrice; // 1e18

    // Per-tick reserves (reserveA, reserveB). A tick with both zero is uninitialized.
    mapping(int32 => uint128) public reserveAOf;
    mapping(int32 => uint128) public reserveBOf;
    mapping(int32 => bool) public tickInit;

    struct SwapParams {
        uint256 amount;
        bool tokenAIn;
        bool exactOutput;
        int32 tickLimit;
    }

    constructor(
        address tokenA_,
        address tokenB_,
        uint256 tickSpacing_,
        uint256 feeAIn_,
        uint256 feeBIn_,
        uint8 protocolFeeRatioD3_
    ) {
        _tokenA = tokenA_;
        _tokenB = tokenB_;
        tickSpacing = tickSpacing_;
        feeAIn = feeAIn_;
        feeBIn = feeBIn_;
        protocolFeeRatioD3 = protocolFeeRatioD3_;
    }

    function tokenA() external view returns (address) {
        return _tokenA;
    }

    function tokenB() external view returns (address) {
        return _tokenB;
    }

    /// @notice Directional swap fee (1e18) — feeAIn for a tokenA-in swap, feeBIn otherwise.
    function fee(bool tokenAIn) external view returns (uint256) {
        return tokenAIn ? feeAIn : feeBIn;
    }

    /// @notice Seed a tick's reserves + the active tick / pool sqrt price. Test-only setup.
    function setTick(int32 tick, uint128 reserveA, uint128 reserveB) external {
        reserveAOf[tick] = reserveA;
        reserveBOf[tick] = reserveB;
        tickInit[tick] = true;
    }

    function setActive(int32 activeTick_, uint256 poolSqrtPrice_) external {
        activeTick = activeTick_;
        poolSqrtPrice = poolSqrtPrice_;
    }

    // ── State (Maverick State struct shape — the fields discovery reads) ──
    struct State {
        uint128 reserveA;
        uint128 reserveB;
        int64 lastTwaD8;
        int64 lastLogPriceD8;
        uint40 lastTimestamp;
        int32 activeTick;
        bool isLocked;
        uint32 binCounter;
        uint8 protocolFeeRatioD3;
    }

    function getState() external view returns (State memory) {
        return State(0, 0, 0, 0, 0, activeTick, false, 0, protocolFeeRatioD3);
    }

    struct TickState {
        uint128 reserveA;
        uint128 reserveB;
        uint128 totalSupply;
        uint32[4] binIdsByTick;
    }

    function getTick(int32 tick) external view returns (TickState memory) {
        uint32[4] memory ids;
        uint128 rA = reserveAOf[tick];
        uint128 rB = reserveBOf[tick];
        uint128 supply = tickInit[tick] ? uint128(1) : uint128(0);
        return TickState(rA, rB, supply, ids);
    }

    // ── Math helpers (1e18) — verbatim vs maverick-math.ts ────────
    function _abs(int256 x) internal pure returns (int256) {
        return x < 0 ? -x : x;
    }

    function _min(uint256 x, uint256 y) internal pure returns (uint256) {
        return x < y ? x : y;
    }

    function _clip(uint256 x, uint256 y) internal pure returns (uint256) {
        return x < y ? 0 : x - y;
    }

    // Full-precision floor(x·y/d) — 512-bit intermediate (Remco Bruintjes / OZ mulDiv), so the
    // product x·y is computed at 512 bits and never overflows a uint256 before the divide. The
    // canonical Maverick `Math.mulDivFloor` is exactly this; the off-chain bigint replay is naturally
    // full-precision, so this keeps the on-chain math bit-identical for large reserves.
    function _mulDiv(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256 result) {
        if (denominator == 0) denominator = 1;
        uint256 prod0;
        uint256 prod1;
        assembly {
            let mm := mulmod(x, y, not(0))
            prod0 := mul(x, y)
            prod1 := sub(sub(mm, prod0), lt(mm, prod0))
        }
        if (prod1 == 0) {
            return prod0 / denominator;
        }
        require(denominator > prod1, "mulDiv overflow");
        uint256 remainder;
        assembly {
            remainder := mulmod(x, y, denominator)
            prod1 := sub(prod1, gt(remainder, prod0))
            prod0 := sub(prod0, remainder)
        }
        uint256 twos = denominator & (~denominator + 1);
        assembly {
            denominator := div(denominator, twos)
            prod0 := div(prod0, twos)
            twos := add(div(sub(0, twos), twos), 1)
        }
        prod0 |= prod1 * twos;
        uint256 inverse = (3 * denominator) ^ 2;
        inverse *= 2 - denominator * inverse;
        inverse *= 2 - denominator * inverse;
        inverse *= 2 - denominator * inverse;
        inverse *= 2 - denominator * inverse;
        inverse *= 2 - denominator * inverse;
        inverse *= 2 - denominator * inverse;
        result = prod0 * inverse;
    }

    function _mulDown(uint256 x, uint256 y) internal pure returns (uint256) {
        return _mulDiv(x, y, ONE);
    }

    function _divDown(uint256 x, uint256 y) internal pure returns (uint256) {
        return _mulDiv(x, ONE, y);
    }

    function _divUp(uint256 x, uint256 y) internal pure returns (uint256) {
        // ceil(x·1e18/y) — full precision floor via _mulDiv, +1 when the division had a remainder.
        uint256 r = _mulDiv(x, ONE, y);
        return mulmod(x, ONE, y) != 0 ? r + 1 : r;
    }

    function _mulDivDown(uint256 x, uint256 y, uint256 k) internal pure returns (uint256) {
        return _mulDiv(x, y, k);
    }

    function _mulDivCeil(uint256 x, uint256 y, uint256 k) internal pure returns (uint256) {
        uint256 r = _mulDiv(x, y, k);
        // ceil: add 1 when the division had a remainder (mulmod at 256-bit suffices for the k>0 case).
        if (k == 0) k = 1;
        return mulmod(x, y, k) != 0 ? r + 1 : r;
    }

    function _mulFloor(uint256 x, uint256 y) internal pure returns (uint256) {
        return _mulDiv(x, y, ONE);
    }

    function _invFloor(uint256 x) internal pure returns (uint256) {
        return ONE_SQUARED / x;
    }

    function _invCeil(uint256 d) internal pure returns (uint256) {
        return (ONE_SQUARED - 1) / d + 1;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = (z + 1) / 2;
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
    }

    // ── TickMath.tickSqrtPrice — verbatim ─────────────────────────
    function tickSqrtPrice(int32 tick) public view returns (uint256) {
        uint256 absTick = uint256(_abs(int256(tick))) * tickSpacing;
        require(absTick <= uint256(MAX_TICK), "TickMaxExceeded");
        uint256 ratio = (absTick & 0x1) != 0
            ? 0xfffcb933bd6fad9d3af5f0b9f25db4d6
            : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d41fd789c8cb37ffcaa1c) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656ac9229c67059486f389) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e81259b3cddc7a064941) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f67b19e8887e0bd251eb7) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98cd2e57b660be99eb2c4a) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c9838804e327cb417cafcb) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99d51e2cc356c2f617dbe0) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900aecf64236ab31f1f9dcb5) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac4d9194200696907cf2e37) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b88206f8abe8a3b44dd9be) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c578ef4f1d17b2b235d480) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd254ee83bdd3f248e7e785e) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d8f7dd10e744d913d033333) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156ddd32a39e257bc3f50aa9b) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97da6e09a19dc367e3b6da40) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7e5a9780b0cc4e25d61a56) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedbcb3a6ccb7ce618d14225) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f630389b2052b8db590e) >> 128;
        if (tick > 0) ratio = type(uint256).max / ratio;
        return (ratio * ONE) >> 128;
    }

    function _tickBounds(int32 tick) internal view returns (uint256 lower, uint256 upper) {
        lower = tickSqrtPrice(tick);
        upper = tickSqrtPrice(tick + 1);
    }

    // ── TickMath.getTickL — verbatim ──────────────────────────────
    function getTickL(uint256 reserveA, uint256 reserveB, uint256 sqrtLower, uint256 sqrtUpper)
        public
        pure
        returns (uint256)
    {
        uint256 diff = sqrtUpper - sqrtLower;
        if (diff == 0) return 0;
        uint256 precisionBump = 0;
        uint256 rA = reserveA;
        uint256 rB = reserveB;
        if ((rA >> 78) == 0 && (rB >> 78) == 0) {
            precisionBump = 57;
            rA <<= precisionBump;
            rB <<= precisionBump;
        }
        if (rB == 0) return _divDown(rA, diff) >> precisionBump;
        if (rA == 0) return _mulDivDown(_mulDown(rB, sqrtLower), sqrtUpper, diff) >> precisionBump;
        uint256 b = (_divDown(rA, sqrtUpper) + _mulDown(rB, sqrtLower)) >> 1;
        // Full-precision (512-bit) products — the off-chain bigint replay computes b·b and aTimesB·diff
        // at arbitrary precision, so a large-reserve b (which can exceed 2^128) must not overflow here.
        uint256 bSquared = _mulDiv(b, b, ONE);
        uint256 aTimesB = _mulFloor(rB, rA);
        uint256 inner = bSquared + _mulDiv(aTimesB, diff, sqrtUpper);
        uint256 sqrtInner = _sqrt(inner) * 1_000_000_000;
        return _mulDivDown(b + sqrtInner, sqrtUpper, diff) >> precisionBump;
    }

    // ── TickMath.getSqrtPrice — verbatim ──────────────────────────
    function getSqrtPrice(uint256 reserveA, uint256 reserveB, uint256 sqrtLower, uint256 sqrtUpper, uint256 L)
        public
        pure
        returns (uint256)
    {
        if (reserveA == 0) return sqrtLower;
        if (reserveB == 0) return sqrtUpper;
        uint256 num = reserveA + _mulDown(L, sqrtLower);
        uint256 den = reserveB + _divDown(L, sqrtUpper);
        if (den == 0) return sqrtLower;
        uint256 sp = _sqrt(ONE * ((num * ONE) / den));
        if (sp < sqrtLower) return sqrtLower;
        if (sp > sqrtUpper) return sqrtUpper;
        return sp;
    }

    // ── SwapMath.computeSwapExactIn — verbatim ────────────────────
    struct TickResult {
        uint256 deltaOutErc;
        uint256 deltaInErc;
        uint256 excess;
        uint256 endSqrtPrice;
        bool swappedToMaxPrice;
    }

    /// The active tick's per-swap data (reserves + derived L + sqrt-price bounds), passed by memory to
    /// keep _computeSwapExactIn's stack under the depth limit.
    struct TickData {
        uint256 reserveA;
        uint256 reserveB;
        uint256 liquidity;
        uint256 sqrtLower;
        uint256 sqrtUpper;
    }

    /// @notice The end sqrt price + output for a within-tick (non-draining) swap of `binAmountInFinal`.
    /// Extracted from `_computeSwapExactIn` to keep it under the stack limit. Verbatim vs maverick-math.ts.
    function _endPriceAndOut(
        uint256 sqrtPrice,
        uint256 binAmountInFinal,
        uint256 L,
        bool tokenAIn,
        uint256 sqrtLower,
        uint256 sqrtUpper,
        uint256 availableOutput
    ) internal pure returns (uint256 endSqrtPrice, uint256 deltaOutErc) {
        if (tokenAIn) {
            endSqrtPrice = sqrtPrice + _divDown(binAmountInFinal, L);
            if (endSqrtPrice > sqrtUpper) endSqrtPrice = sqrtUpper;
        } else {
            uint256 inv = _divDown(binAmountInFinal, L) + _invFloor(sqrtPrice);
            endSqrtPrice = inv > 0 ? _invFloor(inv) : sqrtLower;
            if (endSqrtPrice < sqrtLower) endSqrtPrice = sqrtLower;
        }
        uint256 inOverL = _divUp(binAmountInFinal, L + 1);
        if (tokenAIn) {
            deltaOutErc = _mulDivDown(binAmountInFinal, _invFloor(sqrtPrice), inOverL + sqrtPrice);
        } else {
            deltaOutErc = _mulDivDown(binAmountInFinal, sqrtPrice, inOverL + _invCeil(sqrtPrice));
        }
        deltaOutErc = _min(deltaOutErc, availableOutput);
    }

    /// @notice The tokenIn (net of fee) needed to drain a tick to its far edge, verbatim vs
    /// maverick-math.ts (tokenA-in: L·(sqrtUpper−sqrtPrice); tokenB-in: L·(1/sqrtLower − 1/sqrtPrice)).
    function _binAmountToDrain(uint256 sqrtPrice, uint256 L, bool tokenAIn, uint256 sqrtLower, uint256 sqrtUpper)
        internal
        pure
        returns (uint256)
    {
        if (tokenAIn) return (L * (sqrtUpper - sqrtPrice)) / ONE;
        return _clip((L * (ONE_SQUARED / sqrtLower)) / ONE, (L * (ONE_SQUARED / sqrtPrice)) / ONE);
    }

    function _computeSwapExactIn(
        uint256 sqrtPrice,
        TickData memory t,
        uint256 amountIn,
        bool tokenAIn,
        uint256 f
    ) internal pure returns (TickResult memory) {
        if (t.liquidity == 0 || amountIn == 0) {
            return TickResult(0, 0, amountIn, sqrtPrice, false);
        }
        uint256 availableOutput = tokenAIn ? t.reserveB : t.reserveA;
        uint256 binAmountIn = _binAmountToDrain(sqrtPrice, t.liquidity, tokenAIn, t.sqrtLower, t.sqrtUpper);
        uint256 deltaInErcDrain = binAmountIn + _mulDivCeil(binAmountIn, f, ONE - f);

        if (amountIn >= deltaInErcDrain) {
            // Draining — the tick is fully consumed; the remainder overflows to the next tick.
            return TickResult(
                availableOutput, deltaInErcDrain, amountIn - deltaInErcDrain, tokenAIn ? t.sqrtUpper : t.sqrtLower, true
            );
        }

        // Not draining — the whole input fits within this tick.
        uint256 binAmountInFinal = _mulDown(amountIn, ONE - f);
        (uint256 endSqrtPrice, uint256 deltaOutErc) = _endPriceAndOut(
            sqrtPrice, binAmountInFinal, t.liquidity, tokenAIn, t.sqrtLower, t.sqrtUpper, availableOutput
        );
        bool maxed = endSqrtPrice == t.sqrtUpper || endSqrtPrice == t.sqrtLower;
        return TickResult(deltaOutErc, amountIn, 0, endSqrtPrice, maxed);
    }

    /// @notice One tick's contribution to the walk: compute the swap within `tick` for `remainingIn`.
    /// Returns a TickResult (deltaOut / excess / endSqrtPrice / swappedToMaxPrice). A tick out of the
    /// current price band, empty, or with zero L yields (0, remainingIn, sqrtPrice, true) so the walk
    /// advances to the next tick. Extracted from the loop to keep `_simulate` under the stack limit.
    function _stepTick(int32 tick, uint256 sqrtPrice, uint256 remainingIn, bool tokenAIn, uint256 f)
        internal
        view
        returns (TickResult memory)
    {
        (uint256 sqrtLower, uint256 sqrtUpper) = _tickBounds(tick);
        if (sqrtPrice < sqrtLower || sqrtPrice > sqrtUpper) {
            return TickResult(0, 0, remainingIn, sqrtPrice, true);
        }
        uint256 rA = reserveAOf[tick];
        uint256 rB = reserveBOf[tick];
        if (rA == 0 && rB == 0) {
            return TickResult(0, 0, remainingIn, sqrtPrice, true);
        }
        uint256 L = getTickL(rA, rB, sqrtLower, sqrtUpper);
        if (L == 0) {
            return TickResult(0, 0, remainingIn, sqrtPrice, true);
        }
        return _computeSwapExactIn(sqrtPrice, TickData(rA, rB, L, sqrtLower, sqrtUpper), remainingIn, tokenAIn, f);
    }

    /// @notice The full multi-tick walk for `amount` tokenIn under `tickLimit` — returns the tokenIn
    /// actually consumed + the tokenOut paid, mirroring maverick-math.ts simulateMaverickExactIn.
    function _simulate(uint256 amount, bool tokenAIn, int32 tickLimit)
        internal
        view
        returns (uint256 consumedIn, uint256 totalOut)
    {
        if (amount == 0) return (0, 0);
        uint256 f = tokenAIn ? feeAIn : feeBIn;
        uint256 remainingIn = amount;
        uint256 currentSqrtPrice = poolSqrtPrice;
        int32 currentTick = activeTick;
        int32 direction = tokenAIn ? int32(1) : int32(-1);

        for (int32 iterations = 0; remainingIn > 0 && iterations < TICK_SEARCH_LIMIT; iterations++) {
            if (tokenAIn && currentTick > tickLimit) break;
            if (!tokenAIn && currentTick < tickLimit) break;
            if (uint256(_abs(int256(currentTick))) * tickSpacing > uint256(MAX_TICK)) break;

            TickResult memory res = _stepTick(currentTick, currentSqrtPrice, remainingIn, tokenAIn, f);
            totalOut += res.deltaOutErc;
            remainingIn = res.excess;
            currentSqrtPrice = res.endSqrtPrice;

            // A within-tick partial fill (not maxed) or exhausted input ends the walk. A tick that was
            // skipped (out-of-band / empty / L==0) returns swappedToMaxPrice=true with excess unchanged,
            // so the walk keeps advancing.
            if (res.deltaInErc > 0 && (!res.swappedToMaxPrice || remainingIn == 0)) break;
            currentTick += direction;
        }
        consumedIn = amount - remainingIn;
    }

    /// @notice The on-chain quoter analogue (MaverickV2Quoter.calculateSwap): PURE VIEW, returns the
    /// (amountIn, amountOut) for `amount` tokenIn without mutating state. Engine-independent ground truth.
    function calculateSwap(uint128 amount, bool tokenAIn, bool, int32 tickLimit)
        external
        view
        returns (uint256 amountIn_, uint256 amountOut_, uint256 gasEstimate)
    {
        (amountIn_, amountOut_) = _simulate(uint256(amount), tokenAIn, tickLimit);
        gasEstimate = 0;
    }

    /// @notice The engine `_swapMaverickV2` surface (callback-based). Compute the (amountIn, amountOut) at
    /// the current state, re-enter the caller to PULL the input, then transfer the output to `recipient`.
    /// exactOutput is ignored (the engine always passes false); state is NOT advanced (the single-swap EVM
    /// test snapshots fresh each run, so the on-chain output matches getDy on the initial state to the wei).
    function swap(address recipient, SwapParams calldata params, bytes calldata data)
        external
        returns (uint256 amountIn, uint256 amountOut)
    {
        (amountIn, amountOut) = _simulate(params.amount, params.tokenAIn, params.tickLimit);
        // Pull the input from the caller (the engine) via the Maverick callback.
        IMaverickV2SwapCallback(msg.sender).maverickV2SwapCallback(amountIn, amountOut, data);
        // Pay the output to the recipient.
        address outToken = params.tokenAIn ? _tokenB : _tokenA;
        if (amountOut > 0) IERC20Min(outToken).transfer(recipient, amountOut);
    }
}
