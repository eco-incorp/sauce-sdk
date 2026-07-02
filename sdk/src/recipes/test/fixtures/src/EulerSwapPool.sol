// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Faithful EulerSwap (Euler vault-backed AMM, v1+v2) 2-asset pool for local EVM tests of EcoSwap's
/// callback-free EulerSwap path.
///
/// Reproduces the canonical euler-xyz/euler-swap `CurveLib.f` + `QuoteLib.computeQuote` /
/// `findCurvePoint` (exact-in) BIT-FOR-BIT with the off-chain bigint replay in
/// `sdk/src/recipes/shared/eulerswap-math.ts` — the SAME 1e18 curve params (priceX/priceY,
/// concentrationX/concentrationY, fee), the SAME saturatingMulDivUp (ceil) rounding, the SAME
/// in-region f() branch. So `computeQuote(tokenIn, tokenOut, amount, true)` returns EXACTLY the
/// off-chain `computeQuote(pool, dx)` to the wei — the wei-exact-in-dy gate. (The
/// `EulerSwapPeriphery.quoteExactInput` delegates to this view, so it is also the production exec lever.)
///
/// EcoSwap executes an EulerSwap pool CALLBACK-FREE (it is the asymmetric Euler curve, NOT xy=k, so the
/// engine's _swapV2 path would mis-price it): it reads `computeQuote`, TRANSFERS the input to the pool,
/// then calls `swap(amount0Out, amount1Out, to, "")`. EulerSwap's real swap is Uniswap-V2-shaped: with
/// EMPTY `data` it does NO flash callback — it optimistically pays out, SWEEPS `balanceOf(this)` for the
/// pre-transferred input, and VERIFIES the curve invariant. This fixture implements exactly that surface
/// (the empty-data sweep + the curve verify + the vault-cap output limit) and updates the reserves.
///
/// THE VAULT-CAP. Real EulerSwap depth is gated by the Euler vault available cash/borrow:
/// `QuoteLib.calcLimits` returns (inLimit, outLimit) and `computeQuote` reverts SwapLimitExceeded past
/// them. This fixture models the OUTPUT cap (the available cash the vault can pay out) as
/// `outReserveCap` — computeQuote returns 0 (and swap reverts) if the awarded out would exceed it. The
/// recipe reads computeQuote at execution (so it sees the live cap) and the solver's guarded terminal
/// refund returns any un-spent input — the vault-cap guard.
///
/// 2-asset only (asset0/asset1), which is all a single tokenIn→tokenOut swap reads. Reserves are RAW token
/// units (uint112-bounded in the real contract; we keep uint256 for the fixture). The curve params are in
/// the canonical (asset0=x, asset1=y) orientation.
///
/// GETTER SURFACE — this fixture exposes BOTH real euler-xyz/euler-swap read surfaces (v1 + v2), so the
/// SAME fixture proves the recipe's dual-version discovery (like Uni V2/V3/V4 side by side):
///   · common: getAssets, getReserves, computeQuote, getLimits, swap, curve() (the version discriminator).
///   · v1 (curve()=="EulerSwap v1"): getParams() — the STATIC 12-field immutable struct with a SINGLE
///     non-directional fee. This is the surface every currently-deployed pool exposes.
///   · v2 (curve()=="EulerSwap v2"): getDynamicParams() — the directional-fee bundle.
/// There is NO individual asset0()/reserve0()/priceX()/fee() getter on the real pool. The default is v1
/// (curve()=="EulerSwap v1"); a fixture can be flipped to v2 by deploying with isV1=false so both discovery
/// branches are exercisable. The curve math + exec surface are IDENTICAL across versions.
contract EulerSwapPool {
    uint256 private constant ONE = 1e18;

    /// @dev bytes32("EulerSwap v1") / bytes32("EulerSwap v2") — the curve() version constant.
    bytes32 private constant CURVE_V1 = bytes32(bytes("EulerSwap v1"));
    bytes32 private constant CURVE_V2 = bytes32(bytes("EulerSwap v2"));

    /// @dev v1 IEulerSwap.Params (the getParams() return) — the STATIC immutable curve struct, in the real
    /// v1 field order (vault0, vault1, eulerAccount, equilibriumReserve0/1, priceX, priceY, concentrationX,
    /// concentrationY, fee (SINGLE), protocolFee, protocolFeeRecipient). uint112/uint256 in the real
    /// contract; the fixture never overflows.
    struct Params {
        address vault0;
        address vault1;
        address eulerAccount;
        uint112 equilibriumReserve0;
        uint112 equilibriumReserve1;
        uint256 priceX;
        uint256 priceY;
        uint256 concentrationX;
        uint256 concentrationY;
        uint256 fee;
        uint256 protocolFee;
        address protocolFeeRecipient;
    }

    /// @dev true ⇒ curve()=="EulerSwap v1" + getDynamicParams() reverts (the deployed-pool shape); false ⇒
    /// curve()=="EulerSwap v2".
    bool private isV1;

    /// @dev Mirrors IEulerSwap.DynamicParams (the getDynamicParams() return). uint112/uint80/uint64 in the
    /// real contract; we widen to uint256 storage (the getter down-casts) since the fixture never overflows.
    struct DynamicParams {
        uint112 equilibriumReserve0;
        uint112 equilibriumReserve1;
        uint112 minReserve0;
        uint112 minReserve1;
        uint80 priceX;
        uint80 priceY;
        uint64 concentrationX;
        uint64 concentrationY;
        uint64 fee0;
        uint64 fee1;
        uint40 expiration;
        uint8 swapHookedOperations;
        address swapHook;
    }

    address private asset0; // token0 (x side)
    address private asset1; // token1 (y side)
    uint256 private reserve0; // live x reserve (RAW units)
    uint256 private reserve1; // live y reserve (RAW units)

    // Static curve params (1e18 fixed point).
    uint256 private equilibriumReserve0; // x0
    uint256 private equilibriumReserve1; // y0
    uint256 private priceX; // px
    uint256 private priceY; // py
    uint256 private concentrationX; // cx
    uint256 private concentrationY; // cy
    uint256 private fee; // 1e18-scaled swap fee (same fee both directions in this fixture)

    // Vault-cap model: the most this pool can pay out per side (the available-cash limit). 0 ⇒ uncapped.
    uint256 private outCap0; // max amount0Out the "vault" can service
    uint256 private outCap1; // max amount1Out

    event Swap(address indexed sender, uint256 amount0Out, uint256 amount1Out, address indexed to);

    // ── real IEulerSwap read surface ──────────────────────────────────────
    /// @notice curve() → the version discriminator ("EulerSwap v1" / "EulerSwap v2"). Discovery reads this
    /// to pick getParams() (v1) vs getDynamicParams() (v2).
    function curve() external view returns (bytes32) {
        return isV1 ? CURVE_V1 : CURVE_V2;
    }

    /// @notice getAssets() → (asset0, asset1). The real pool has NO asset0()/asset1() getter.
    function getAssets() external view returns (address, address) {
        return (asset0, asset1);
    }

    /// @notice getReserves() → (reserve0, reserve1, status). status=1 (unlocked). No reserve0()/reserve1().
    function getReserves() external view returns (uint112, uint112, uint32) {
        return (uint112(reserve0), uint112(reserve1), 1);
    }

    /// @notice getParams() → the v1 STATIC 12-field struct (a SINGLE non-directional fee). The v1 surface;
    /// REVERTS when this fixture is deployed as v2 (mirroring the real v2 impl, which lacks getParams()).
    function getParams() external view returns (Params memory) {
        require(isV1, "V2_HAS_NO_GETPARAMS");
        return Params({
            vault0: address(0),
            vault1: address(0),
            eulerAccount: address(0),
            equilibriumReserve0: uint112(equilibriumReserve0),
            equilibriumReserve1: uint112(equilibriumReserve1),
            priceX: priceX,
            priceY: priceY,
            concentrationX: concentrationX,
            concentrationY: concentrationY,
            fee: fee,
            protocolFee: 0,
            protocolFeeRecipient: address(0)
        });
    }

    /// @notice getDynamicParams() → the v2 curve-param struct (DIRECTIONAL fee0/fee1). REVERTS when this
    /// fixture is deployed as v1 (mirroring the real v1 impl, which reverts getDynamicParams()).
    function getDynamicParams() external view returns (DynamicParams memory) {
        require(!isV1, "V1_HAS_NO_GETDYNAMICPARAMS");
        return DynamicParams({
            equilibriumReserve0: uint112(equilibriumReserve0),
            equilibriumReserve1: uint112(equilibriumReserve1),
            minReserve0: 0,
            minReserve1: 0,
            priceX: uint80(priceX),
            priceY: uint80(priceY),
            concentrationX: uint64(concentrationX),
            concentrationY: uint64(concentrationY),
            fee0: uint64(fee),
            fee1: uint64(fee),
            expiration: 0,
            swapHookedOperations: 0,
            swapHook: address(0)
        });
    }

    /// @notice Curve params bundle — avoids the 13-arg constructor "stack too deep".
    /// p = [reserve0, reserve1, x0, y0, px, py, cx, cy, fee, outCap0, outCap1].
    /// `_isV1` selects the exposed surface: true ⇒ curve()=="EulerSwap v1" + getParams() (getDynamicParams
    /// reverts); false ⇒ curve()=="EulerSwap v2" + getDynamicParams() (getParams reverts).
    constructor(address a0, address a1, uint256[11] memory p, bool _isV1) {
        asset0 = a0;
        asset1 = a1;
        reserve0 = p[0];
        reserve1 = p[1];
        equilibriumReserve0 = p[2];
        equilibriumReserve1 = p[3];
        priceX = p[4];
        priceY = p[5];
        concentrationX = p[6];
        concentrationY = p[7];
        fee = p[8];
        outCap0 = p[9];
        outCap1 = p[10];
        isV1 = _isV1;
    }

    // ── curve math (mirrors eulerswap-math.ts / CurveLib.f) ────────────────

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        if (b == 0) return 0;
        return (a + b - 1) / b;
    }

    function _mulDivCeil(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        if (d == 0) return 0;
        return (x * y + d - 1) / d;
    }

    /// @notice CurveLib.f(x, px, py, x0, y0, c) — the y-reserve on the curve at IN-side reserve x (x<=x0).
    /// Mirrors the canonical euler-swap-jslib `f` (the GENERAL form; c==1e18 falls out automatically).
    function _f(uint256 x, uint256 px, uint256 py, uint256 x0, uint256 y0, uint256 c)
        internal
        pure
        returns (uint256)
    {
        if (x >= x0) return y0;
        uint256 v = px * (x0 - x) * (c * x + (ONE - c) * x0);
        uint256 denom = x * ONE;
        v = (v + (denom - 1)) / denom;
        return y0 + (v + (py - 1)) / py;
    }

    /// @notice Integer square root (babylonian) — matches the off-chain isqrt floor.
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = x;
        uint256 y = (z + 1) / 2;
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
        return z;
    }

    /// @notice sqrtCeil — matches the jslib `sqrtCeil` (round UP).
    function _sqrtCeil(uint256 x) internal pure returns (uint256) {
        if (x < 2) return x;
        uint256 r = _sqrt(x);
        return r * r < x ? r + 1 : r;
    }

    /// @notice Bit length of x.
    function _bitLength(uint256 x) internal pure returns (uint256) {
        uint256 bits = 0;
        while (x > 0) {
            x >>= 1;
            bits++;
        }
        return bits;
    }

    /// @notice computeScale — 2^(bits-128) when x exceeds 128 bits, else 1 (jslib overflow guard).
    function _computeScale(uint256 x) internal pure returns (uint256) {
        uint256 bits = _bitLength(x);
        if (bits > 128) return uint256(1) << (bits - 128);
        return 1;
    }

    /// @notice fInverse(y, px, py, x0, y0, cx) — IN-side reserve x past equilibrium (whitepaper eqs 23-27).
    /// Mirrors the canonical euler-swap-jslib `fInverse` bit-for-bit (dimensionally scaled by 1e18 + the
    /// computeScale absB² overflow guard), so it matches the off-chain replay exactly.
    function _fInverse(uint256 y, uint256 px, uint256 py, uint256 x0, uint256 y0, uint256 cx)
        internal
        pure
        returns (uint256)
    {
        uint256 term1 = _mulDivCeil(py * ONE, y - y0, px);
        int256 B = (int256(term1) - int256((2 * cx - ONE) * x0)) / int256(ONE);
        uint256 C = _mulDivCeil(ONE - cx, x0 * x0, ONE);
        uint256 fourAC = _mulDivCeil(4 * cx, C, ONE);
        uint256 absB = uint256(B >= 0 ? B : -B);

        uint256 sqrt;
        if (absB < 10 ** 36) {
            sqrt = _sqrtCeil(absB * absB + fourAC);
        } else {
            uint256 scale = _computeScale(absB);
            uint256 squaredB = _mulDivCeil(absB / scale, absB, scale);
            sqrt = _sqrtCeil(squaredB + fourAC / (scale * scale)) * scale;
        }

        uint256 x;
        if (B <= 0) {
            x = _mulDivCeil(absB + sqrt, ONE, 2 * cx) + 1;
        } else {
            x = _ceilDiv(2 * C, absB + sqrt) + 1;
        }
        if (x >= x0) return x0;
        return x;
    }

    /// @notice findCurvePoint(exactIn=true) — exact out for `dxNet` (post-fee) tokenIn.
    function _findCurvePointIn(
        bool inIsAsset0,
        uint256 dxNet
    ) internal view returns (uint256) {
        // Orient reserves + params by the input side.
        uint256 rIn = inIsAsset0 ? reserve0 : reserve1;
        uint256 rOut = inIsAsset0 ? reserve1 : reserve0;
        uint256 eqIn = inIsAsset0 ? equilibriumReserve0 : equilibriumReserve1;
        uint256 eqOut = inIsAsset0 ? equilibriumReserve1 : equilibriumReserve0;
        uint256 pIn = inIsAsset0 ? priceX : priceY;
        uint256 pOut = inIsAsset0 ? priceY : priceX;
        uint256 cIn = inIsAsset0 ? concentrationX : concentrationY;
        uint256 cOut = inIsAsset0 ? concentrationY : concentrationX;

        uint256 xNew = rIn + dxNet;
        uint256 yNew;
        if (xNew <= eqIn) {
            yNew = _f(xNew, pIn, pOut, eqIn, eqOut, cIn);
        } else {
            yNew = _fInverse(xNew, pOut, pIn, eqOut, eqIn, cOut);
        }
        return rOut > yNew ? rOut - yNew : 0;
    }

    /// @notice computeQuote(tokenIn, tokenOut, amount, exactIn) — the EXACT actual tokens-out for `amount`
    /// tokenIn (exactIn), INCLUDING the fee + the vault output cap. Pure-ish view; identical to what
    /// `swap` enforces. Mirrors QuoteLib.computeQuote(exactIn=true). The periphery quoteExactInput
    /// delegates to this. Returns 0 (instead of reverting) when the vault cap binds — so the recipe's
    /// pre-swap quote sees the cap and the awarded input is left for the terminal refund.
    function computeQuote(address tokenIn, address tokenOut, uint256 amount, bool exactIn)
        public
        view
        returns (uint256)
    {
        require(exactIn, "EXACT_IN_ONLY");
        require(tokenIn != tokenOut, "SAME_TOKEN");
        require(
            (tokenIn == asset0 && tokenOut == asset1) || (tokenIn == asset1 && tokenOut == asset0),
            "BAD_TOKENS"
        );
        if (amount == 0) return 0;
        bool inIsAsset0 = tokenIn == asset0;

        uint256 net = amount - (amount * fee) / ONE;
        if (net == 0) return 0;
        uint256 out = _findCurvePointIn(inIsAsset0, net);

        // Vault output cap (the available-cash limit calcLimits enforces). The out side is asset1 when
        // tokenIn is asset0, else asset0.
        uint256 cap = inIsAsset0 ? outCap1 : outCap0;
        if (cap > 0 && out > cap) return 0;
        return out;
    }

    /// @notice getLimits(tokenIn, tokenOut) — (inLimit, outLimit). The fixture exposes the OUTPUT cap as
    /// outLimit (the vault available cash); inLimit is unbounded (uint256 max) here. Mirrors the periphery
    /// getLimits used to bound the prepare sampler.
    function getLimits(address tokenIn, address tokenOut) external view returns (uint256 inLimit, uint256 outLimit) {
        require(
            (tokenIn == asset0 && tokenOut == asset1) || (tokenIn == asset1 && tokenOut == asset0),
            "BAD_TOKENS"
        );
        bool inIsAsset0 = tokenIn == asset0;
        outLimit = inIsAsset0 ? outCap1 : outCap0;
        if (outLimit == 0) outLimit = type(uint256).max;
        inLimit = type(uint256).max;
    }

    /// @notice Callback-free V2-shaped swap — the surface EcoSwap calls. With EMPTY `data` it does NO
    /// flash callback: it optimistically transfers the output, SWEEPS the pre-transferred input
    /// (balanceOf(this) - reserve), VERIFIES the curve (the swept input must produce >= the requested
    /// out at the live computeQuote), and updates the reserves.
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {
        require(amount0Out > 0 || amount1Out > 0, "ZERO_OUT");
        require(amount0Out == 0 || amount1Out == 0, "ONE_SIDE_ONLY");
        require(data.length == 0, "NO_CALLBACK_SUPPORTED"); // this fixture only exercises the empty-data path

        // Optimistic output transfer (V2-style).
        if (amount0Out > 0) {
            require(amount0Out <= reserve0, "INSUFFICIENT_RESERVE");
            IERC20Min(asset0).transfer(to, amount0Out);
        } else {
            require(amount1Out <= reserve1, "INSUFFICIENT_RESERVE");
            IERC20Min(asset1).transfer(to, amount1Out);
        }

        // Sweep the pre-transferred input (the side that did NOT pay out).
        uint256 bal0 = IERC20Min(asset0).balanceOf(address(this));
        uint256 bal1 = IERC20Min(asset1).balanceOf(address(this));
        uint256 in0 = bal0 > reserve0 ? bal0 - reserve0 : 0;
        uint256 in1 = bal1 > reserve1 ? bal1 - reserve1 : 0;

        // Exactly one side is the input; the input side is whichever did NOT pay out.
        if (amount1Out > 0) {
            // tokenIn == asset0 (in0 swept), out is asset1.
            require(in0 > 0 && in1 == 0, "BAD_INPUT");
            require(computeQuote(asset0, asset1, in0, true) >= amount1Out, "CURVE_VIOLATION");
            reserve0 = reserve0 + in0;
            reserve1 = reserve1 - amount1Out;
        } else {
            // tokenIn == asset1 (in1 swept), out is asset0.
            require(in1 > 0 && in0 == 0, "BAD_INPUT");
            require(computeQuote(asset1, asset0, in1, true) >= amount0Out, "CURVE_VIOLATION");
            reserve1 = reserve1 + in1;
            reserve0 = reserve0 - amount0Out;
        }
        emit Swap(msg.sender, amount0Out, amount1Out, to);
    }
}
