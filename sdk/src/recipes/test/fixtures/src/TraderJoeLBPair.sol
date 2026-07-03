// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Faithful Trader Joe Liquidity Book (LB) pair for local EVM tests of the engine
/// `_swapTraderJoeLB` path.
///
/// Reproduces the LB v2.1/v2.2 discrete-bin constant-sum swap math BIT-FOR-BIT with the off-chain
/// bigint replay in `sdk/src/recipes/shared/lb-math.ts` (the SAME `getPriceFromId` 128.128 pow,
/// the constant-sum per-bin drain, and the static base fee `baseFactor * binStep * 1e10`). So
/// `swap(swapForY, to)` sends EXACTLY the off-chain `getSwapOut(amountIn)` to the wei — the wei-exact
/// LB gate. The variable/volatility fee is omitted (a transient surcharge that resets between blocks),
/// matching the off-chain snapshot assumption.
///
/// FEE/ROUNDING (verified against the REAL Arbitrum LBPair, byte-for-byte via the prod-mirror etch):
/// the LB per-bin math ROUNDS UP both the price division and the fee, exactly as LB v2.2
/// `Bin.getAmounts` + `FeeHelper.getFeeAmount` do. To fully drain a bin's out reserve:
///   amountInToBin = ceil(outReserve * 2^128 / price)   [swapForY] / ceil(outReserve * price / 2^128) [swapForX]
///   feeAmount     = ceil(amountInToBin * fee / (PRECISION - fee))     (fee ADDED on top)
///   grossToDrain  = amountInToBin + feeAmount
/// A partial fill takes the fee FROM the input with a round-up: fee = ceil(remaining * fee / PRECISION),
/// netIn = remaining - fee, out = floor(netIn * price / 2^128). This ceil form (not the earlier floor
/// approximation, which was ~1-2 wei/bin short) is what makes the fixture AND lb-math.ts wei-exact with
/// the real contract's getSwapOut across a multi-bin walk.
///
/// The engine `_swapTraderJoeLB` is TRANSFER-FIRST: it reads `getTokenX()`, derives
/// `swapForY = (tokenIn == tokenX)`, transfers `amountIn` of tokenIn to this pair, then calls
/// `swap(swapForY, recipient)` and measures the recipient's tokenOut balance delta. This fixture
/// implements exactly that surface: `swap` reads the freshly-received input (current balance of the
/// in-token minus the tracked reserve), walks its OWN bins outward from the active id in the swap
/// direction draining each at its fixed bin price, transfers the out token to `to`, and advances
/// the bin reserves + active id. Pre-funded (per bin) with both token sides it pays out.
///
/// It ALSO implements the discovery surface the recipe's `discoverTraderJoeLBPoolsTyped` reads
/// (`getTokenY`, `getActiveId`, `getBinStep`, `getBin`, `getReserves`, `getStaticFeeParameters`),
/// so a discovery-driven path can stand this fixture up too — the EVM round-trip test seeds
/// segments directly (the discovery registry uses placeholder addresses), exactly like the
/// Curve/DODO tests.
contract TraderJoeLBPair {
    uint256 private constant SCALE_128 = 1 << 128; // LB price fixed-point (128.128)
    uint256 private constant BASIS_POINT_MAX = 10_000; // bin-step bps denominator
    uint256 private constant FEE_PRECISION = 1e18; // totalFee denominator (PRECISION)
    int256 private constant REAL_ID_SHIFT = int256(1 << 23); // id 2^23 == price 1.0

    address public immutable _tokenX;
    address public immutable _tokenY;
    uint16 private immutable _binStep;
    uint16 private immutable _baseFactor;

    uint24 private _activeId;

    // Bin reserves keyed by id. reserveX/reserveY in native token units.
    mapping(uint24 => uint256) private _binX;
    mapping(uint24 => uint256) private _binY;
    // Tracked total reserves (so swap can read the freshly-transferred input by balance delta).
    uint256 private _reserveX;
    uint256 private _reserveY;
    // The seeded-bin id range [_minId, _maxId] — the OUTWARD-walk bound. The real LBPair walks only
    // INITIALIZED bins (a tree bitmap); this fixture bounds its linear id walk to the seeded range so an
    // amountIn that EXCEEDS the pool's fillable capacity returns the UNFILLABLE remainder gracefully in
    // O(seeded bins) instead of decrementing id toward 0 (~2^23 SLOADs ⇒ OutOfGas). _maxId starts below
    // _minId so an empty pool has an empty range.
    uint24 private _minId = type(uint24).max;
    uint24 private _maxId;

    constructor(address tokenX_, address tokenY_, uint16 binStep_, uint16 baseFactor_, uint24 activeId_) {
        _tokenX = tokenX_;
        _tokenY = tokenY_;
        _binStep = binStep_;
        _baseFactor = baseFactor_;
        _activeId = activeId_;
    }

    /// @notice Seed a bin's reserves (test setup mints the constant-sum book). Tracks totals + the seeded id
    /// range (the outward-walk bound — see _minId/_maxId).
    function setBin(uint24 id, uint256 reserveX, uint256 reserveY) external {
        _reserveX = _reserveX - _binX[id] + reserveX;
        _reserveY = _reserveY - _binY[id] + reserveY;
        _binX[id] = reserveX;
        _binY[id] = reserveY;
        if (id < _minId) _minId = id;
        if (id > _maxId) _maxId = id;
    }

    // ── Discovery surface (ITraderJoeLBPair + LB v2.1 reads) ──────
    function getTokenX() external view returns (address) {
        return _tokenX;
    }

    function getTokenY() external view returns (address) {
        return _tokenY;
    }

    function getActiveId() external view returns (uint24) {
        return _activeId;
    }

    function getBinStep() external view returns (uint16) {
        return _binStep;
    }

    function getBin(uint24 id) external view returns (uint128 binReserveX, uint128 binReserveY) {
        return (uint128(_binX[id]), uint128(_binY[id]));
    }

    function getReserves() external view returns (uint128 reserveX, uint128 reserveY) {
        return (uint128(_reserveX), uint128(_reserveY));
    }

    function getStaticFeeParameters()
        external
        view
        returns (
            uint16 baseFactor,
            uint16 filterPeriod,
            uint16 decayPeriod,
            uint16 reductionFactor,
            uint24 variableFeeControl,
            uint16 protocolShare,
            uint24 maxVolatilityAccumulator
        )
    {
        return (_baseFactor, 0, 0, 0, 0, 0, 0);
    }

    // ── LB math — mirrors lb-math.ts bit-for-bit ──────────────────

    /// @dev 128.128 multiplication: (a * b) >> 128, rounding down. Uses full 512-bit intermediate
    /// math (mulmod) so the product of two ~2^128 operands does not overflow uint256 — the
    /// off-chain bigint `mul128` computes on arbitrary precision, so the on-chain path must too to
    /// stay bit-for-bit. prod0 = low 256 bits, prod1 = high 256 bits; result = (prod1 << 128) |
    /// (prod0 >> 128) (the bits straddling the 128-bit shift boundary).
    function _mul128(uint256 a, uint256 b) internal pure returns (uint256) {
        unchecked {
            uint256 prod0 = a * b; // low 256 bits (wraps mod 2^256 — intentional)
            uint256 mm = mulmod(a, b, type(uint256).max);
            uint256 prod1 = mm - prod0 - (mm < prod0 ? 1 : 0); // high 256 bits
            // (a*b) >> 128 = (prod1 << 128) | (prod0 >> 128).
            return (prod1 << 128) | (prod0 >> 128);
        }
    }

    /// @dev 128.128 exponentiation by squaring — `pow128` in lb-math.ts. y >= 0: x^y; y < 0:
    /// reciprocal (2^128 * 2^128) / (x^|y|).
    function _pow128(uint256 x, int256 y) internal pure returns (uint256) {
        bool neg = y < 0;
        uint256 n = uint256(neg ? -y : y);
        uint256 result = SCALE_128; // 1.0 in 128.128
        uint256 base = x;
        while (n > 0) {
            if (n & 1 == 1) result = _mul128(result, base);
            n >>= 1;
            if (n > 0) base = _mul128(base, base);
        }
        if (neg) {
            if (result == 0) return 0;
            // reciprocal in 128.128: floor(2^256 / result), computed without forming 2^256
            // (which overflows uint256). 2^256 = type(uint256).max + 1, so
            //   floor(2^256 / r) = (max / r) + ((max % r) + 1) / r.
            uint256 r = result;
            return (type(uint256).max / r) + ((type(uint256).max % r) + 1) / r;
        }
        return result;
    }

    /// @dev Bin price in 128.128 (Y-per-X) — `getPriceFromId`.
    function _priceFromId(uint24 id) internal view returns (uint256) {
        uint256 b = SCALE_128 + (SCALE_128 * uint256(_binStep)) / BASIS_POINT_MAX;
        int256 exp = int256(uint256(id)) - REAL_ID_SHIFT;
        return _pow128(b, exp);
    }

    /// @dev Static base fee (1e18 PRECISION) — `baseFee` = baseFactor * binStep * 1e10.
    function _baseFee() internal view returns (uint256) {
        return uint256(_baseFactor) * uint256(_binStep) * 1e10;
    }

    /// @dev Ceiling division ⌈a/b⌉ (LB rounds these up). a assumed > 0, b > 0.
    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a + b - 1) / b;
    }

    /// @dev GROSS input to fully drain `outReserve` at `price128` — LB v2.2 round-up math (see the
    /// contract doc). swapForY: in = X to drain the bin's Y (amountInToBin = ceil(Y * 2^128 / price));
    /// swapForX: in = Y to drain the bin's X (amountInToBin = ceil(X * price / 2^128)). feeAmount is
    /// added on top with a round-up. Bit-for-bit with lb-math.ts `lbGrossToDrain`.
    function _grossToDrain(uint256 outReserve, uint256 price128, bool swapForY, uint256 fee)
        internal
        pure
        returns (uint256)
    {
        if (outReserve == 0 || price128 == 0) return 0;
        uint256 amountInToBin =
            swapForY ? _ceilDiv(outReserve * SCALE_128, price128) : _ceilDiv(outReserve * price128, SCALE_128);
        if (amountInToBin == 0) return 0;
        uint256 feeAmount = _ceilDiv(amountInToBin * fee, FEE_PRECISION - fee);
        return amountInToBin + feeAmount;
    }

    /// @notice REAL LB v2.1/v2.2 `getSwapOut(uint128 amountIn, bool swapForY)` surface — the engine-
    /// independent ground truth AND the on-chain QUOTE-LADDER quote source. Walks bins outward from the
    /// active id in the swap direction, draining each at its fixed price with the base fee on the per-bin
    /// input. GRACEFUL: when the bin book runs out before `amountIn` is consumed, the leftover is returned as
    /// `amountInLeft` (the UNFILLABLE remainder) rather than reverting — the recipe's QL branch caps the
    /// awarded input at `amountIn - amountInLeft` (the live fillable capacity). Returns
    /// (amountInLeft, amountOut, fee), matching the real deployed LBPair. Bit-for-bit with lb-math.ts
    /// `getSwapOutWithLeft`.
    function getSwapOut(uint128 amountIn, bool swapForY)
        public
        view
        returns (uint128 amountInLeft, uint128 amountOut, uint128 fee)
    {
        if (amountIn == 0) return (0, 0, 0);
        uint256 feeRate = _baseFee();
        uint256 remaining = amountIn;
        uint256 out;
        uint256 feePaid;

        if (swapForY) {
            // in = X, out = Y. Consume bins id <= active, DECREASING id — bounded to the seeded range.
            uint24 id = _activeId;
            while (remaining > 0) {
                uint256 outReserve = _binY[id];
                uint256 price128 = _priceFromId(id);
                if (outReserve > 0 && price128 > 0) {
                    uint256 maxGrossIn = _grossToDrain(outReserve, price128, true, feeRate);
                    if (maxGrossIn > 0) {
                        if (remaining >= maxGrossIn) {
                            uint256 toBin = _ceilDiv(outReserve * SCALE_128, price128);
                            feePaid += maxGrossIn - toBin;
                            out += outReserve;
                            remaining -= maxGrossIn;
                        } else {
                            uint256 feeAmt = _ceilDiv(remaining * feeRate, FEE_PRECISION);
                            uint256 netIn = remaining - feeAmt;
                            uint256 binOut = (netIn * price128) / SCALE_128;
                            feePaid += feeAmt;
                            out += binOut > outReserve ? outReserve : binOut;
                            remaining = 0;
                        }
                    }
                }
                if (id == 0 || id <= _minId) break; // past the lowest seeded bin ⇒ remaining is UNFILLABLE
                id--;
            }
        } else {
            // in = Y, out = X. Consume bins id >= active, INCREASING id — bounded to the seeded range.
            uint24 id = _activeId;
            while (remaining > 0) {
                uint256 outReserve = _binX[id];
                uint256 price128 = _priceFromId(id);
                if (outReserve > 0 && price128 > 0) {
                    uint256 maxGrossIn = _grossToDrain(outReserve, price128, false, feeRate);
                    if (maxGrossIn > 0) {
                        if (remaining >= maxGrossIn) {
                            uint256 toBin = _ceilDiv(outReserve * price128, SCALE_128);
                            feePaid += maxGrossIn - toBin;
                            out += outReserve;
                            remaining -= maxGrossIn;
                        } else {
                            uint256 feeAmt = _ceilDiv(remaining * feeRate, FEE_PRECISION);
                            uint256 netIn = remaining - feeAmt;
                            uint256 binOut = (netIn * SCALE_128) / price128;
                            feePaid += feeAmt;
                            out += binOut > outReserve ? outReserve : binOut;
                            remaining = 0;
                        }
                    }
                }
                if (id == type(uint24).max || id >= _maxId) break; // past the highest seeded bin ⇒ UNFILLABLE
                id++;
            }
        }
        amountInLeft = uint128(remaining);
        amountOut = uint128(out);
        fee = uint128(feePaid);
    }

    // ── The engine `_swapTraderJoeLB` surface (transfer-first) ────

    /// @notice Drain bins for the freshly-received input and pay the out token to `to`. Returns
    /// the LB-packed amounts (the engine ignores the return and measures the recipient delta).
    function swap(bool swapForY, address to) external returns (bytes32 amountsOut) {
        uint256 amountIn;
        uint256 amountOut;
        uint256 fee = _baseFee();

        if (swapForY) {
            amountIn = IERC20Min(_tokenX).balanceOf(address(this)) - _reserveX;
            uint256 remaining = amountIn;
            uint24 id = _activeId;
            while (remaining > 0) {
                uint256 outReserve = _binY[id];
                uint256 price128 = _priceFromId(id);
                if (outReserve > 0 && price128 > 0) {
                    uint256 maxGrossIn = _grossToDrain(outReserve, price128, true, fee);
                    if (maxGrossIn > 0) {
                        if (remaining >= maxGrossIn) {
                            amountOut += outReserve;
                            remaining -= maxGrossIn;
                            _binY[id] = 0;
                        } else {
                            uint256 netIn = remaining - _ceilDiv(remaining * fee, FEE_PRECISION);
                            uint256 binOut = (netIn * price128) / SCALE_128;
                            if (binOut > outReserve) binOut = outReserve;
                            amountOut += binOut;
                            _binY[id] = outReserve - binOut;
                            remaining = 0;
                            _activeId = id;
                        }
                    }
                }
                if (remaining == 0) break;
                if (id == 0 || id <= _minId) break; // past the lowest seeded bin (unfillable remainder)
                id--;
                _activeId = id;
            }
            _reserveX += amountIn;
            _reserveY -= amountOut;
            IERC20Min(_tokenY).transfer(to, amountOut);
            amountsOut = bytes32(amountOut); // packed: amountYOut in the low 128 bits
        } else {
            amountIn = IERC20Min(_tokenY).balanceOf(address(this)) - _reserveY;
            uint256 remaining = amountIn;
            uint24 id = _activeId;
            while (remaining > 0) {
                uint256 outReserve = _binX[id];
                uint256 price128 = _priceFromId(id);
                if (outReserve > 0 && price128 > 0) {
                    uint256 maxGrossIn = _grossToDrain(outReserve, price128, false, fee);
                    if (maxGrossIn > 0) {
                        if (remaining >= maxGrossIn) {
                            amountOut += outReserve;
                            remaining -= maxGrossIn;
                            _binX[id] = 0;
                        } else {
                            uint256 netIn = remaining - _ceilDiv(remaining * fee, FEE_PRECISION);
                            uint256 binOut = (netIn * SCALE_128) / price128;
                            if (binOut > outReserve) binOut = outReserve;
                            amountOut += binOut;
                            _binX[id] = outReserve - binOut;
                            remaining = 0;
                            _activeId = id;
                        }
                    }
                }
                if (remaining == 0) break;
                if (id == type(uint24).max || id >= _maxId) break; // past the highest seeded bin (unfillable)
                id++;
                _activeId = id;
            }
            _reserveY += amountIn;
            _reserveX -= amountOut;
            IERC20Min(_tokenX).transfer(to, amountOut);
            amountsOut = bytes32(amountOut << 128); // packed: amountXOut in the high 128 bits
        }
    }
}
