// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20SZ {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Local INTEGRAL SIZE (TwapRelayer) fixture for EcoSwap's SIZE path (QL segKind 19). It
/// mirrors the VERIFIED TwapRelayer.sol surface + semantics the recipe touches (probed live on
/// Ethereum + fork-executed 2026-07-04), with a SETTABLE price standing in for the Uniswap-V3 TWAP
/// read (the prod-mirror etches the real oracle graph; here the price is a test lever):
///
///   quoteSell(tokenIn, tokenOut, amountIn) view — TR24 on zero, TR5A on a disabled pair, then
///     fee = amountIn·swapFee/1e18, out = (amountIn − fee)·price/1e18, then the OUT-WINDOW
///     `checkLimits(tokenOut, out)`: TR03 below getTokenLimitMin(tokenOut), TR3A above
///     inventory · maxMultiplier / 1e18 — the [min, cap] window ON THE OUT AMOUNT, exactly the
///     verified source's shape (the family's twist: the LOW end of the quote domain reverts too).
///
///   quoteBuy(tokenIn, tokenOut, amountOut) view — TR23 on zero, TR5A, checkLimits(tokenOut,
///     amountOut), then the CEIL-rounded inversion (calculateAmountIn ceil + the fee gross-up
///     ceil_div — the verified source's rounding), so quoteSell(quoteBuy(minOut)) >= minOut ALWAYS
///     (the window hoist's minIn conversion relies on this).
///
///   sell(SellParams) payable — TR26 (to must not be tokenIn/tokenOut/0), TR58 (msg.value must be 0
///     for a non-wrap sell), OS04-class submitDeadline bound, the SAME quote path + window (the
///     window binds AT EXEC — transferOut re-runs checkLimits in the source; a SUB-MIN sell reverts
///     TR03, fork-proven), TR37 (amountOutMin). transferIn pulls EXACTLY amountIn from msg.sender
///     to the DELAY sink (the real relayer forwards the input to its TwapDelay hedge queue — the
///     relayer's own tokenIn inventory does NOT grow), transferOut pays from RELAYER inventory to
///     `to`. PULL == APPROVE ALWAYS (no partial-fill path exists in the verified source).
///
///   getTokenLimitMin / getTokenLimitMaxMultiplier — settable window config (ETH probe: WETH
///     1.2e18, USDC/USDT 5000e6; multiplier 0.95e18).
///
/// setPair/setLimits/setPrice are fixture-only levers (pair wiring, window edges, TWAP drift cells).
/// The pricing is LINEAR to the cap (the real TWAP class) — the recipe side handles it with the
/// flat-ladder mode (see size-math.ts / curve-math.ts buildQLLadder).
contract SizeRelayer {
    uint256 private constant PRECISION = 1e18;

    struct PairCfg {
        bool enabled;
        uint256 price; // tokenOut per tokenIn, 1e18-scaled (directional key — set both directions)
        uint256 swapFee; // 1e18-scaled (the source's PRECISION fee)
    }

    address public immutable delay; // the TwapDelay sink the pulled input is forwarded to
    mapping(bytes32 => PairCfg) private _pairs; // keyed by the ORDERED (tokenIn, tokenOut)
    mapping(address => uint256) private _limitMin;
    mapping(address => uint256) private _limitMaxMult; // default 0.95e18 via setLimits

    uint256 private _orderId;

    struct SellParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOutMin;
        bool wrapUnwrap;
        address to;
        uint32 submitDeadline;
    }

    constructor(address delay_) {
        delay = delay_;
    }

    // ── fixture levers ──
    function setPair(address tokenIn, address tokenOut, uint256 price, uint256 swapFee_, bool enabled) external {
        _pairs[keccak256(abi.encodePacked(tokenIn, tokenOut))] = PairCfg(enabled, price, swapFee_);
    }

    function setLimits(address token, uint256 min, uint256 maxMult) external {
        _limitMin[token] = min;
        _limitMaxMult[token] = maxMult;
    }

    // ── the verified read surface ──
    function getTokenLimitMin(address token) public view returns (uint256) {
        return _limitMin[token];
    }

    function getTokenLimitMaxMultiplier(address token) public view returns (uint256) {
        return _limitMaxMult[token];
    }

    function _cfg(address tokenIn, address tokenOut) private view returns (PairCfg memory c) {
        c = _pairs[keccak256(abi.encodePacked(tokenIn, tokenOut))];
        require(c.enabled, "TR5A");
    }

    /// The verified source's checkLimits — the [min, cap] window ON THE OUT AMOUNT.
    function _checkLimits(address token, uint256 amount) private view {
        require(amount >= getTokenLimitMin(token), "TR03");
        require(
            amount <= (IERC20SZ(token).balanceOf(address(this)) * getTokenLimitMaxMultiplier(token)) / PRECISION,
            "TR3A"
        );
    }

    function _calcOut(PairCfg memory c, uint256 amountIn) private pure returns (uint256) {
        uint256 fee = (amountIn * c.swapFee) / PRECISION;
        return ((amountIn - fee) * c.price) / PRECISION;
    }

    function quoteSell(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256 amountOut) {
        require(amountIn > 0, "TR24");
        PairCfg memory c = _cfg(tokenIn, tokenOut);
        amountOut = _calcOut(c, amountIn);
        _checkLimits(tokenOut, amountOut);
    }

    function quoteBuy(address tokenIn, address tokenOut, uint256 amountOut) external view returns (uint256 amountIn) {
        require(amountOut > 0, "TR23");
        PairCfg memory c = _cfg(tokenIn, tokenOut);
        _checkLimits(tokenOut, amountOut);
        // CEIL inversion + CEIL fee gross-up — the verified source's rounding, so
        // quoteSell(quoteBuy(x)) >= x always (the minIn conversion depends on it).
        uint256 calculatedAmountIn = (amountOut * PRECISION + c.price - 1) / c.price;
        amountIn = (calculatedAmountIn * PRECISION + (PRECISION - c.swapFee) - 1) / (PRECISION - c.swapFee);
    }

    function sell(SellParams calldata p) external payable returns (uint256 orderId) {
        require(p.to != p.tokenIn && p.to != p.tokenOut && p.to != address(0), "TR26");
        require(msg.value == 0, "TR58"); // the recipe never wraps
        require(uint256(p.submitDeadline) >= block.timestamp, "OS04");
        // The SAME quote path + window as quoteSell (the source re-runs checkLimits in transferOut —
        // a sub-min sell reverts TR03 AT EXEC, fork-proven on the real relayer).
        uint256 amountOut = quoteSell(p.tokenIn, p.tokenOut, p.amountIn);
        require(amountOut >= p.amountOutMin, "TR37");
        // transferIn: EXACTLY amountIn, forwarded to the DELAY sink (the relayer's own tokenIn
        // inventory does not grow — mirrors the real hedge-queue forward).
        require(IERC20SZ(p.tokenIn).transferFrom(msg.sender, delay, p.amountIn), "TH0E");
        // transferOut: from relayer inventory to `to`.
        require(IERC20SZ(p.tokenOut).transfer(p.to, amountOut), "TH05");
        _orderId += 1;
        return _orderId;
    }
}
