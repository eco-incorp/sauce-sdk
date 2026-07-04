// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Faithful WOOFi (WooPPV2 synthetic proactive market maker, sPMM v2) 2-token pool for local EVM
/// tests of EcoSwap's callback-free WOOFi path.
///
/// Reproduces the canonical woonetwork/WooPoolV2 `WooPPV2._calcQuoteAmountSellBase` /
/// `_calcBaseAmountSellQuote` sPMM quote + the `_tryQuerySellBase`/`_tryQuerySellQuote` fee BIT-FOR-BIT
/// with the off-chain bigint replay in `sdk/src/recipes/shared/woofi-math.ts` — the SAME oracle-price
/// math (price scaled by priceDec=1e8, spread/coeff/gamma WAD, feeRate 1e5-scaled) and the SAME plain
/// integer divides. So `query(fromToken, toToken, fromAmount)` returns EXACTLY the off-chain
/// `query(pool, dx)` to the wei at the CURRENT oracle state — the wei-exact-in-dy gate.
///
/// WOOFi is a BASE/QUOTE PMM: `quoteToken` is the numeraire; `baseToken` is priced by the (here BUILT-IN,
/// settable) WooracleV2 feed. This fixture supports the two DIRECT legs — sell base (base→quote) and sell
/// quote (quote→base). The oracle state (price/spread/coeff) is SETTABLE via `setState`, so a test can
/// MOVE the price between prepare and cook and assert the exec re-reads the LIVE oracle (exact-in-dy)
/// while the split was priced at the snapshot.
///
/// EcoSwap executes a WOOFi pool CALLBACK-FREE (it is oracle-priced, NOT xy=k): it reads `query`, TRANSFERS
/// the input to this pool (WooPPV2 is TRANSFER-FIRST — swap computes the sold amount from
/// balanceOf(fromToken) − reserve), then calls `swap(fromToken, toToken, amount, minToAmount, to,
/// rebateTo)`. This fixture implements exactly that surface. The pool HOLDS both tokens so it can pay out.
contract WooFiPool {
    uint256 private constant WAD = 1e18;
    uint256 private constant FEE_SCALE = 1e5;

    address public baseToken;
    address public quoteToken;
    uint256 public immutable priceDec; // 10**oracle.decimals(base) (canonically 1e8)
    uint256 public immutable quoteDec; // 10**decimals(quote)
    uint256 public immutable baseDec; // 10**decimals(base)
    uint256 public feeRate; // 1e5-scaled (0.025% = 25)

    // Built-in WooracleV2 state for the base token (the sPMM inputs).
    uint256 public price; // scaled by priceDec
    uint256 public spread; // WAD
    uint256 public coeff; // WAD
    bool public woFeasible;

    // The pool's internal reserve accounting (WooPPV2 tracks reserve separately from balanceOf so a
    // transfer-first swap can measure the sold amount as balanceOf − reserve).
    uint256 public baseReserve;
    uint256 public quoteReserve;

    event WooSwap(address fromToken, address toToken, uint256 fromAmount, uint256 toAmount, address to);

    constructor(
        address base_,
        address quote_,
        uint256 priceDec_,
        uint256 quoteDec_,
        uint256 baseDec_,
        uint256 price_,
        uint256 spread_,
        uint256 coeff_,
        uint256 feeRate_
    ) {
        baseToken = base_;
        quoteToken = quote_;
        priceDec = priceDec_;
        quoteDec = quoteDec_;
        baseDec = baseDec_;
        price = price_;
        spread = spread_;
        coeff = coeff_;
        feeRate = feeRate_;
        woFeasible = true;
    }

    /// @notice Update the WooracleV2 state for the base token (models a keeper posting a new price).
    function setState(uint256 price_, uint256 spread_, uint256 coeff_, bool feasible_) external {
        price = price_;
        spread = spread_;
        coeff = coeff_;
        woFeasible = feasible_;
    }

    /// @notice Snap the internal reserves to the current balances (called after the deployer funds the
    /// pool, so the first swap's balanceOf − reserve measures only the newly-transferred input).
    function sync() external {
        baseReserve = IERC20Min(baseToken).balanceOf(address(this));
        quoteReserve = IERC20Min(quoteToken).balanceOf(address(this));
    }

    // ── Production-discovery read surface (discoverWooFiPoolsTyped) ────────
    // The real WooPPV2 exposes a separate WooracleV2 feed; this fixture's oracle is BUILT-IN, so it
    // reports ITSELF as the oracle and answers the WooracleV2 reads (state/decimals) directly.

    /// @notice WooPPV2.wooracle() — the oracle address (this fixture: self).
    function wooracle() external view returns (address) {
        return address(this);
    }

    /// @notice WooracleV2.state(base) — the sPMM inputs for the base token. Reverts for any other
    /// token, so a non-base/quote pair query fails discovery's try (the pair is skipped) exactly
    /// like an unsupported token on the real oracle.
    function state(address base) external view returns (uint128, uint64, uint64, bool) {
        require(base == baseToken, "WooOracle: !base");
        return (uint128(price), uint64(spread), uint64(coeff), woFeasible);
    }

    /// @notice WooracleV2.decimals(base) — the oracle price decimals (priceDec = 10**decimals).
    function decimals(address base) external view returns (uint8 d) {
        require(base == baseToken, "WooOracle: !base");
        uint256 p = priceDec;
        while (p > 1) {
            p /= 10;
            d++;
        }
    }

    /// @notice WooPPV2.tokenInfos(token) — reserve + feeRate + caps. The fixture is UNCAPPED
    /// (maxGamma = maxNotionalSwap = 0 ⇒ discovery's unknown/uncapped sentinel).
    function tokenInfos(address token)
        external
        view
        returns (uint192 reserve, uint16 feeRate_, uint128 maxGamma, uint128 maxNotionalSwap)
    {
        require(token == baseToken || token == quoteToken, "WooPPV2: !token");
        reserve = uint192(token == baseToken ? baseReserve : quoteReserve);
        return (reserve, uint16(feeRate), 0, 0);
    }

    // ── sPMM math (mirrors woofi-math.ts / WooPPV2._calc*) ─────────────────

    /// @notice _calcQuoteAmountSellBase then the sell-base fee off the OUTPUT.
    function _sellBaseQuote(uint256 baseAmount) internal view returns (uint256) {
        if (baseAmount == 0 || price == 0) return 0;
        uint256 gamma = (baseAmount * price * coeff) / priceDec / baseDec;
        if (gamma + spread >= WAD) return 0;
        uint256 factor = WAD - gamma - spread;
        uint256 quoteAmount = (((baseAmount * price * quoteDec) / priceDec) * factor) / WAD / baseDec;
        uint256 fee = (quoteAmount * feeRate) / FEE_SCALE;
        return quoteAmount > fee ? quoteAmount - fee : 0;
    }

    /// @notice sell-quote fee off the INPUT then _calcBaseAmountSellQuote.
    function _sellQuoteBase(uint256 quoteAmount) internal view returns (uint256) {
        if (quoteAmount == 0 || price == 0) return 0;
        uint256 swapFee = (quoteAmount * feeRate) / FEE_SCALE;
        if (quoteAmount <= swapFee) return 0;
        uint256 q = quoteAmount - swapFee;
        uint256 gamma = (q * coeff) / quoteDec;
        if (gamma + spread >= WAD) return 0;
        uint256 factor = WAD - gamma - spread;
        return (((q * baseDec * priceDec) / price) * factor) / WAD / quoteDec;
    }

    /// @notice Exact toAmount for `fromAmount` of `fromToken` at the CURRENT oracle state — identical to
    /// the off-chain query and to what `swap` enforces.
    function query(address fromToken, address toToken, uint256 fromAmount) public view returns (uint256) {
        require(woFeasible, "WooPPV2: !ORACLE_FEASIBLE");
        if (fromToken == baseToken && toToken == quoteToken) {
            return _sellBaseQuote(fromAmount);
        }
        if (fromToken == quoteToken && toToken == baseToken) {
            return _sellQuoteBase(fromAmount);
        }
        revert("BAD_TOKENS");
    }

    /// @notice GRACEFUL quote — the WooRouter/off-chain quote surface (mirrors the real deployed WooPPV2
    /// tryQuery, which returns the single toAmount). Identical sPMM math to `query`, but NEVER reverts:
    /// returns 0 on an infeasible oracle or an unsupported token pair (instead of query's revert).
    /// `toAmount` is bit-identical to `query` for any feasible amount — the same `_calc*` math — so
    /// EcoSwap's QUOTE-LADDER builds its price ladder off tryQuery with a plain staticcall (0 ⇒ stop),
    /// while the swap exec still reads the reverting `query` for the minToAmount.
    function tryQuery(address fromToken, address toToken, uint256 fromAmount)
        public
        view
        returns (uint256 toAmount)
    {
        if (!woFeasible || price == 0) return 0;
        if (fromToken == baseToken && toToken == quoteToken) {
            return _sellBaseQuote(fromAmount);
        }
        if (fromToken == quoteToken && toToken == baseToken) {
            return _sellQuoteBase(fromAmount);
        }
        return 0;
    }

    /// @notice Callback-free swap — the surface EcoSwap calls. WooPPV2 is TRANSFER-FIRST: the caller has
    /// already transferred `fromAmount` in, so this measures the received amount as balanceOf − reserve,
    /// quotes the exact out at the LIVE oracle, checks the minimum, pays out, and updates reserves.
    function swap(
        address fromToken,
        address toToken,
        uint256 fromAmount,
        uint256 minToAmount,
        address to,
        address /*rebateTo*/
    ) external returns (uint256 realToAmount) {
        require(to != address(0), "WooPPV2: !to");
        if (fromToken == baseToken && toToken == quoteToken) {
            require(IERC20Min(baseToken).balanceOf(address(this)) - baseReserve >= fromAmount, "WooPPV2: !BASE");
            realToAmount = _sellBaseQuote(fromAmount);
            require(realToAmount >= minToAmount, "WooPPV2: quoteAmount_LT_minQuoteAmount");
            baseReserve += fromAmount;
            quoteReserve -= realToAmount;
            IERC20Min(quoteToken).transfer(to, realToAmount);
        } else if (fromToken == quoteToken && toToken == baseToken) {
            require(IERC20Min(quoteToken).balanceOf(address(this)) - quoteReserve >= fromAmount, "WooPPV2: !QUOTE");
            realToAmount = _sellQuoteBase(fromAmount);
            require(realToAmount >= minToAmount, "WooPPV2: baseAmount_LT_minBaseAmount");
            quoteReserve += fromAmount;
            baseReserve -= realToAmount;
            IERC20Min(baseToken).transfer(to, realToAmount);
        } else {
            revert("BAD_TOKENS");
        }
        emit WooSwap(fromToken, toToken, fromAmount, realToAmount, to);
    }
}
