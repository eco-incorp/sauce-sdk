// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Result carrier revert — the REAL FluidDexT1 estimate hook. When swapIn's `to_` is ADDRESS_DEAD
/// the pool reverts with this BEFORE touching the Liquidity layer, so the periphery resolver can decode the
/// amountOut off a low-level call. Mirrors fluid-contracts-public IFluidDexT1.FluidDexSwapResult.
error FluidDexSwapResult(uint256 amountOut);

/// @notice Local Fluid DEX (Instadapp fluid-contracts-public FluidDexT1 — a Liquidity-Layer-backed
/// re-centering AMM) fixture for EcoSwap's callback-free Fluid path. It mirrors the REAL VERIFIED
/// FluidDexT1 SURFACE (FluidDexT1 0x6d83f60eEac0e50A1250760151E81Db2a278e03a;
/// fluid-contracts-public poolT1/coreModule/core/main.sol) so the local-EVM test exercises the interface
/// the recipe hits on-chain. The real pool has NO standalone token0()/token1() getters — token0/token1
/// are immutables exposed only inside constantsView()'s struct — so this fixture exposes them the same way
/// (the resolver's getDexTokens reads them via constantsView), NOT as public getters:
///   constantsView() view -> ConstantViews (token0/token1 inside)
///   swapIn(bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_, address to_)
///       payable -> uint256 amountOut_
///     — pulls tokenIn via safeTransferFrom(msg.sender, this, amountIn) (APPROVE-FIRST — the real pool
///       pulls to the LIQUIDITY layer; the fixture holds both tokens itself so it can pay out), sends
///       amountOut to `to_`. When to_ == ADDRESS_DEAD reverts FluidDexSwapResult(amountOut_) BEFORE any
///       transfer — the protocol's own estimate hook (the periphery resolver catches it).
///
/// PRICING off the LIQUIDITY-LAYER STATE (canonical on-chain), NOT xy=k. The out is
///   grossOut = amountIn · exchangeRateOut / exchangeRateIn · centerPrice / 1e18   (re-centering AMM),
/// then a swap fee off the output, then CAPPED by the utilization/borrow limit `outCap` on the OUT side
/// (past the cap the quote is 0 — the tradeable-range edge, like EulerSwap's inLimit). `setLayer` MOVES the
/// exchange prices / center price / cap (models the layer accruing every block + a cap shrinking) so a test
/// can move state between prepare and cook. The exchange rates + center price are the canonical layer state
/// the recipe reads LIVE via the resolver estimate.
contract FluidDexPool {
    uint256 private constant FEE_SCALE = 1e6;
    uint256 private constant RATE_SCALE = 1e18;
    address internal constant ADDRESS_DEAD = 0x000000000000000000000000000000000000dEaD;

    // token0/token1 are immutable constants on the REAL pool, exposed ONLY inside constantsView()'s
    // struct — NOT as standalone token0()/token1() getters. Kept internal here so the fixture cannot
    // auto-generate the getters the real contract lacks; read via constantsView() (mirrors getDexTokens).
    address internal _token0;
    address internal _token1;

    // Liquidity-Layer-style state (settable — models the layer accruing + re-centering).
    uint256 private _exchangeRate0; // supply/borrow exchange price for token0 (1e18)
    uint256 private _exchangeRate1; // supply/borrow exchange price for token1 (1e18)
    uint256 private _centerPrice; // re-centering center price (1e18, token1 per token0)
    uint256 private _feePpm; // swap fee, 1e6-scaled (0.01% = 100)
    uint256 private _outCap0; // max token0-out for a 1→0 swap (utilization/borrow cap); 0 ⇒ unbounded
    uint256 private _outCap1; // max token1-out for a 0→1 swap; 0 ⇒ unbounded
    // Utilization slippage depth (larger ⇒ deeper/flatter): the out is reduced by amountIn²/_depth, so a
    // bigger swap pays more (utilization rises with size). 0 ⇒ no slippage (a pure flat layer price).
    uint256 private _depth;

    event FluidSwap(bool swap0to1, uint256 amountIn, uint256 amountOut, address to);

    /// @notice Minimal mirror of FluidDexT1's ConstantViews struct — the ONLY place token0/token1 are
    /// exposed on the real pool (no standalone getters). The periphery resolver's getDexTokens reads these.
    struct ConstantViews {
        uint256 dexId;
        address token0;
        address token1;
    }

    /// @notice REAL FluidDexT1 surface — returns the immutable constants, incl. token0/token1.
    function constantsView() external view returns (ConstantViews memory c_) {
        c_.dexId = 1;
        c_.token0 = _token0;
        c_.token1 = _token1;
    }

    constructor(
        address token0_,
        address token1_,
        uint256 exchangeRate0_,
        uint256 exchangeRate1_,
        uint256 centerPrice_,
        uint256 feePpm_,
        uint256 depth_
    ) {
        _token0 = token0_;
        _token1 = token1_;
        _exchangeRate0 = exchangeRate0_;
        _exchangeRate1 = exchangeRate1_;
        _centerPrice = centerPrice_;
        _feePpm = feePpm_;
        _depth = depth_;
    }

    /// @notice Move the Liquidity-Layer state (accrue exchange prices / re-center) — the drift hook.
    function setLayer(uint256 exchangeRate0_, uint256 exchangeRate1_, uint256 centerPrice_) external {
        _exchangeRate0 = exchangeRate0_;
        _exchangeRate1 = exchangeRate1_;
        _centerPrice = centerPrice_;
    }

    /// @notice Set the per-side utilization/borrow out-caps (models a cap shrinking before cook). 0 ⇒ none.
    function setCaps(uint256 outCap0_, uint256 outCap1_) external {
        _outCap0 = outCap0_;
        _outCap1 = outCap1_;
    }

    // ── Fluid DEX layer math (canonical on-chain state; re-centering) ─────

    function _grossOut(bool swap0to1, uint256 amountIn) internal view returns (uint256) {
        if (amountIn == 0) return 0;
        uint256 par;
        if (swap0to1) {
            // token0 → token1: value in token1 units at the layer rates + center price.
            uint256 g = (amountIn * _exchangeRate0) / _exchangeRate1;
            par = (g * _centerPrice) / RATE_SCALE;
        } else {
            // token1 → token0: inverse center price.
            uint256 g2 = (amountIn * _exchangeRate1) / _exchangeRate0;
            par = (g2 * RATE_SCALE) / _centerPrice;
        }
        // Utilization slippage: the out is reduced by amountIn²/_depth (convex in size), so a deeper pool
        // (larger _depth) is flatter and the split equalizes marginals across pools of different depth.
        if (_depth != 0) {
            uint256 slip = (amountIn * amountIn) / _depth;
            par = par > slip ? par - slip : 0;
        }
        return par;
    }

    function _netOut(bool swap0to1, uint256 amountIn) internal view returns (uint256) {
        uint256 gross = _grossOut(swap0to1, amountIn);
        if (gross == 0) return 0;
        uint256 fee = (gross * _feePpm) / FEE_SCALE;
        uint256 net = gross > fee ? gross - fee : 0;
        // Utilization/borrow cap on the OUT side — past the cap the swap is not fillable (quote 0).
        uint256 cap = swap0to1 ? _outCap1 : _outCap0;
        if (cap != 0 && net > cap) return 0;
        return net;
    }

    /// @notice REAL FluidDexT1 swap surface — exact-in. Pulls input approve-first, sends output to `to_`.
    /// When to_ == ADDRESS_DEAD reverts FluidDexSwapResult(amountOut_) as the estimate hook.
    function swapIn(bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_, address to_)
        external
        payable
        returns (uint256 amountOut_)
    {
        amountOut_ = _netOut(swap0to1_, amountIn_);
        if (to_ == ADDRESS_DEAD) revert FluidDexSwapResult(amountOut_);
        require(amountOut_ >= amountOutMin_, "Fluid: amountOut_LT_min");
        require(amountOut_ > 0, "Fluid: zero_out");
        address tokenIn = swap0to1_ ? _token0 : _token1;
        address tokenOut = swap0to1_ ? _token1 : _token0;
        require(IERC20Min(tokenIn).transferFrom(msg.sender, address(this), amountIn_), "Fluid: pull");
        IERC20Min(tokenOut).transfer(to_, amountOut_);
        emit FluidSwap(swap0to1_, amountIn_, amountOut_, to_);
    }
}

interface IFluidDexT1 {
    function swapIn(bool swap0to1, uint256 amountIn, uint256 amountOutMin, address to)
        external
        payable
        returns (uint256 amountOut);

    function constantsView() external view returns (FluidDexPool.ConstantViews memory);
}

/// @notice Local FluidDexReservesResolver fixture — mirrors the REAL periphery DexReservesResolver
/// (fluid-contracts-public periphery/resolvers/dex/main.sol). estimateSwapIn CALLS the pool's swapIn with
/// to_ == ADDRESS_DEAD and DECODES the FluidDexSwapResult revert into a plain uint256 — exactly the real
/// resolver's revert-decode. The recipe quotes through THIS (the pool's own estimate is a bare revert the
/// interpreter can't try/catch).
contract FluidDexResolver {
    address internal constant ADDRESS_DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice REAL periphery surface — orient the pair by reading the pool's constantsView() (the pool has
    /// no standalone token0()/token1() getters). Mirrors DexReservesResolver.getDexTokens.
    function getDexTokens(address dex_) external view returns (address token0_, address token1_) {
        FluidDexPool.ConstantViews memory c_ = IFluidDexT1(dex_).constantsView();
        token0_ = c_.token0;
        token1_ = c_.token1;
    }

    function estimateSwapIn(address dex_, bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_)
        external
        payable
        returns (uint256 amountOut_)
    {
        try IFluidDexT1(dex_).swapIn{ value: msg.value }(swap0to1_, amountIn_, amountOutMin_, ADDRESS_DEAD) {
            // Never reaches here — swapIn always reverts on ADDRESS_DEAD.
            return 0;
        } catch (bytes memory lowLevelData_) {
            // Decode FluidDexSwapResult(uint256) — selector (4 bytes) + the uint256 amountOut.
            bytes4 sel = FluidDexSwapResult.selector;
            require(lowLevelData_.length >= 36, "Fluid: bad_estimate");
            bytes4 gotSel;
            assembly {
                gotSel := mload(add(lowLevelData_, 0x20))
                amountOut_ := mload(add(lowLevelData_, 0x24))
            }
            require(gotSel == sel, "Fluid: bad_selector");
        }
    }
}
