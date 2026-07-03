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

    // ── DODOMath — verbatim (contractV2 lib/DODOMath.sol) ─────────
    function _generalIntegrate(uint256 V0, uint256 V1, uint256 V2, uint256 ii, uint256 k)
        internal
        pure
        returns (uint256)
    {
        require(V0 > 0, "TARGET_IS_ZERO");
        uint256 fairAmount = ii * (V1 - V2); // RAW i*delta — one final /ONE2
        if (k == 0) {
            return fairAmount / ONE;
        }
        uint256 V0V0V1V2 = ((V0 * V0) / V1) * ONE / V2; // divFloor
        uint256 penalty = _mul(k, V0V0V1V2);
        return ((ONE - k + penalty) * fairAmount) / (ONE * ONE);
    }

    /// @dev _SolveQuadraticFunctionForTrade(V0, V1, delta, i, k) — returns the RECEIVE amount
    /// V1 - V2 (0 when V2 > V1), with the contractV2 k==0 / k==ONE special cases and the
    /// unconditional divCeil on V2. Checked 0.8 arithmetic == the 0.6.9 SafeMath semantics.
    function _solveQuadraticForTrade(uint256 V0, uint256 V1, uint256 delta, uint256 ii, uint256 k)
        internal
        pure
        returns (uint256)
    {
        require(V0 > 0, "TARGET_IS_ZERO");
        if (delta == 0) {
            return 0;
        }

        if (k == 0) {
            return _mul(ii, delta) > V1 ? V1 : _mul(ii, delta);
        }

        if (k == ONE) {
            // V2 = V1/(1 + i*delta*V1/V0/V0) → V1 - V2 = V1*temp/(temp+ONE); the contract detects
            // the raw uint256 wrap of idelta*V1 and falls back to the staged divide.
            uint256 temp;
            uint256 idelta = ii * delta;
            if (idelta == 0) {
                temp = 0;
            } else {
                uint256 prod;
                unchecked {
                    prod = idelta * V1;
                }
                if (prod / idelta == V1) {
                    temp = prod / (V0 * V0);
                } else {
                    temp = (((delta * V1) / V0) * ii) / V0;
                }
            }
            return (V1 * temp) / (temp + ONE);
        }

        // b = kV0^2/V1 - i*delta - (1-k)V1 — |b| accumulated RAW, ONE divide after the sub.
        uint256 part2 = ((k * V0) / V1) * V0 + ii * delta;
        uint256 bAbs = (ONE - k) * V1;
        bool bSig;
        if (bAbs >= part2) {
            bAbs = bAbs - part2;
            bSig = false;
        } else {
            bAbs = part2 - bAbs;
            bSig = true;
        }
        bAbs = bAbs / ONE;

        uint256 squareRoot = _mul((ONE - k) * 4, _mul(k, V0) * V0); // 4(1-k)kV0^2
        squareRoot = _sqrt(bAbs * bAbs + squareRoot);

        uint256 denominator = (ONE - k) * 2;
        uint256 numerator;
        if (bSig) {
            numerator = squareRoot - bAbs;
            require(numerator != 0, "DODOMath: should not be zero");
        } else {
            numerator = bAbs + squareRoot;
        }

        uint256 V2 = _divCeil(numerator, denominator);
        if (V2 > V1) {
            return 0;
        }
        return V1 - V2;
    }

    // ── PMMPricing R-state dispatch — verbatim ────────────────────
    function _sellBaseGross(uint256 payBase) internal view returns (uint256) {
        RState r = _R();
        if (r == RState.ONE) {
            return _solveQuadraticForTrade(Q0, Q0, payBase, i, K);
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
                + _solveQuadraticForTrade(Q0, Q0, payBase - backToOnePayBase, i, K);
        }
        // BELOW_ONE
        return _solveQuadraticForTrade(Q0, Q, payBase, i, K);
    }

    function _sellQuoteGross(uint256 payQuote) internal view returns (uint256) {
        RState r = _R();
        uint256 oneOverI = _recip(i);
        if (r == RState.ONE) {
            return _solveQuadraticForTrade(B0, B0, payQuote, oneOverI, K);
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
                + _solveQuadraticForTrade(B0, B0, payQuote - backToOnePayQuote, oneOverI, K);
        }
        // ABOVE_ONE
        return _solveQuadraticForTrade(B0, B, payQuote, oneOverI, K);
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
