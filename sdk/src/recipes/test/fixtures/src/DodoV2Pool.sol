// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Faithful DODO V2 PMM pool for local EVM tests of the engine `_swapDODOV2` path.
///
/// Reproduces the canonical DODO V2 `PMMPricing` + `DODOMath` + `DecimalMath` integer math
/// BIT-FOR-BIT with the off-chain bigint replay in `sdk/src/recipes/shared/dodo-math.ts` — the
/// SAME _GeneralIntegrate / _SolveQuadraticFunctionForTrade / R-state dispatch / 1e18 DecimalMath
/// rounding / LP+MT fee netting. So `sellBase`/`sellQuote` send EXACTLY the off-chain
/// `getDy(pool, amountIn)` to the wei — the wei-exact-in-dy gate.
///
/// The engine `_swapDODOV2` is TRANSFER-FIRST: it transfers `amountIn` of tokenIn to this pool,
/// then calls `sellBase(to)` (when tokenIn == _BASE_TOKEN_) or `sellQuote(to)`. This fixture
/// implements exactly that surface: `sellBase` reads the freshly-received base (current balance −
/// tracked B), runs the PMM math on the PRE-swap state, transfers the quote out to `to`, and
/// advances {B, Q, R}. Pre-funded with the quote/base side it pays out.
///
/// R is recomputed from reserves vs targets (B/B0, Q/Q0) the way DODO does, so a sequence of
/// swaps walks the real curve. The single-swap EVM test snapshots the pool fresh each run, so the
/// on-chain output matches the off-chain getDy on the SAME initial state to the wei.
contract DodoV2Pool {
    uint256 private constant ONE = 1e18;

    address public immutable _BASE_TOKEN_;
    address public immutable _QUOTE_TOKEN_;

    uint256 public i; // guide price (1e18) — POOL STATE
    uint256 public K; // slippage (1e18)
    uint256 public B; // base reserve
    uint256 public Q; // quote reserve
    uint256 public B0; // base target
    uint256 public Q0; // quote target
    uint256 public lpFeeRate; // 1e18-scaled
    uint256 public mtFeeRate; // 1e18-scaled

    enum RState {
        ONE,
        ABOVE_ONE,
        BELOW_ONE
    }

    constructor(
        address base_,
        address quote_,
        uint256 i_,
        uint256 k_,
        uint256 b_,
        uint256 q_,
        uint256 b0_,
        uint256 q0_,
        uint256 lpFeeRate_,
        uint256 mtFeeRate_
    ) {
        _BASE_TOKEN_ = base_;
        _QUOTE_TOKEN_ = quote_;
        i = i_;
        K = k_;
        B = b_;
        Q = q_;
        B0 = b0_;
        Q0 = q0_;
        lpFeeRate = lpFeeRate_;
        mtFeeRate = mtFeeRate_;
    }

    /// @notice The current R-state from reserves vs targets (mirrors DODO's _R derivation).
    function _R() internal view returns (RState) {
        if (B == B0 && Q == Q0) return RState.ONE;
        if (B < B0) return RState.ABOVE_ONE; // base scarce
        return RState.BELOW_ONE; // quote scarce (B > B0)
    }

    function getPMMStateForCall()
        external
        view
        returns (uint256 i_, uint256 K_, uint256 B_, uint256 Q_, uint256 B0_, uint256 Q0_, uint256 R_)
    {
        return (i, K, B, Q, B0, Q0, uint256(_R()));
    }

    // ── DecimalMath (1e18) — verbatim ─────────────────────────────
    function _mul(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * b) / ONE;
    }

    function _divCeilRaw(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _divCeil(uint256 a, uint256 b) internal pure returns (uint256) {
        return _divCeilRaw(a * ONE, b);
    }

    function _recip(uint256 t) internal pure returns (uint256) {
        return (ONE * ONE) / t;
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

    // ── DODOMath — verbatim ───────────────────────────────────────
    function _generalIntegrate(uint256 V0, uint256 V1, uint256 V2, uint256 ii, uint256 k)
        internal
        pure
        returns (uint256)
    {
        uint256 fairAmount = _mul(ii, V1 - V2);
        uint256 V0V0V1V2 = _divCeil((V0 * V0) / V1, V2);
        uint256 penalty = _mul(k, V0V0V1V2);
        return _mul(fairAmount, ONE - k + penalty);
    }

    function _solveQuadraticForTrade(uint256 Q0_, uint256 Q1, uint256 ideltaB, bool deltaBSig, uint256 k)
        internal
        pure
        returns (uint256)
    {
        uint256 kQ02Q1 = (_mul(k, Q0_) * Q0_) / Q1;
        uint256 b = _mul(ONE - k, Q1);
        bool minusbSig;
        if (deltaBSig) {
            b += ideltaB;
        } else {
            kQ02Q1 += ideltaB;
        }
        if (b >= kQ02Q1) {
            b -= kQ02Q1;
            minusbSig = true;
        } else {
            b = kQ02Q1 - b;
            minusbSig = false;
        }
        uint256 penalty = _mul((ONE - k) * 4, _mul(k, Q0_) * Q0_);
        uint256 squareRoot = _sqrt(b * b + penalty);
        uint256 denominator = (ONE - k) * 2;
        if (denominator == 0) return 0;
        uint256 numerator = minusbSig ? b + squareRoot : squareRoot - b;
        return deltaBSig ? (numerator * ONE) / denominator : _divCeilRaw(numerator * ONE, denominator);
    }

    // ── PMMPricing R-state dispatch — verbatim ────────────────────
    function _sellBaseGross(uint256 payBase) internal view returns (uint256) {
        RState r = _R();
        if (r == RState.ONE) {
            return _solveQuadraticForTrade(Q0, Q0, _mul(i, payBase), false, K);
        }
        if (r == RState.ABOVE_ONE) {
            uint256 backToOnePayBase = B0 - B;
            uint256 backToOneReceiveQuote = Q - Q0;
            if (payBase < backToOnePayBase) {
                uint256 recv = _generalIntegrate(B0, B + payBase, B, i, K);
                return recv > backToOneReceiveQuote ? backToOneReceiveQuote : recv;
            } else if (payBase == backToOnePayBase) {
                return backToOneReceiveQuote;
            }
            return backToOneReceiveQuote
                + _solveQuadraticForTrade(Q0, Q0, _mul(i, payBase - backToOnePayBase), false, K);
        }
        // BELOW_ONE
        return _solveQuadraticForTrade(Q0, Q, _mul(i, payBase), false, K);
    }

    function _sellQuoteGross(uint256 payQuote) internal view returns (uint256) {
        RState r = _R();
        uint256 oneOverI = _recip(i);
        if (r == RState.ONE) {
            return _solveQuadraticForTrade(B0, B0, _mul(oneOverI, payQuote), false, K);
        }
        if (r == RState.BELOW_ONE) {
            uint256 backToOnePayQuote = Q0 - Q;
            uint256 backToOneReceiveBase = B - B0;
            if (payQuote < backToOnePayQuote) {
                uint256 recv = _generalIntegrate(Q0, Q + payQuote, Q, oneOverI, K);
                return recv > backToOneReceiveBase ? backToOneReceiveBase : recv;
            } else if (payQuote == backToOnePayQuote) {
                return backToOneReceiveBase;
            }
            return backToOneReceiveBase
                + _solveQuadraticForTrade(B0, B0, _mul(oneOverI, payQuote - backToOnePayQuote), false, K);
        }
        // ABOVE_ONE
        return _solveQuadraticForTrade(B0, B, _mul(oneOverI, payQuote), false, K);
    }

    function _netFee(uint256 gross) internal view returns (uint256) {
        uint256 lpFee = _mul(gross, lpFeeRate);
        uint256 mtFee = _mul(gross, mtFeeRate);
        uint256 net = gross - lpFee - mtFee;
        return net;
    }

    /// @notice Off-chain getDy analogue (pure view on current state) — the engine-independent
    /// ground truth. querySellBase net of LP+MT fee.
    function querySellBase(uint256 payBase) public view returns (uint256) {
        if (payBase == 0) return 0;
        uint256 gross = _sellBaseGross(payBase);
        if (gross == 0) return 0;
        return _netFee(gross);
    }

    function querySellQuote(uint256 payQuote) public view returns (uint256) {
        if (payQuote == 0) return 0;
        uint256 gross = _sellQuoteGross(payQuote);
        if (gross == 0) return 0;
        return _netFee(gross);
    }

    // ── The engine `_swapDODOV2` surface (transfer-first) ─────────
    function sellBase(address to) external returns (uint256 receiveQuoteAmount) {
        uint256 payBase = IERC20Min(_BASE_TOKEN_).balanceOf(address(this)) - B;
        receiveQuoteAmount = querySellBase(payBase);
        // advance state along the curve
        B += payBase;
        Q -= receiveQuoteAmount;
        IERC20Min(_QUOTE_TOKEN_).transfer(to, receiveQuoteAmount);
    }

    function sellQuote(address to) external returns (uint256 receiveBaseAmount) {
        uint256 payQuote = IERC20Min(_QUOTE_TOKEN_).balanceOf(address(this)) - Q;
        receiveBaseAmount = querySellQuote(payQuote);
        B -= receiveBaseAmount;
        Q += payQuote;
        IERC20Min(_BASE_TOKEN_).transfer(to, receiveBaseAmount);
    }
}
