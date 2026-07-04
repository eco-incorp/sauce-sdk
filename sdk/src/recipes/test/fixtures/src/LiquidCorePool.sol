// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20LC {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Local LIQUIDCORE (Liquid Labs, HyperEVM) per-pair POOL fixture for EcoSwap's LiquidCore
/// path (QL segKind 18). It mirrors the REAL pool SURFACES the recipe touches (probed live on
/// HyperEVM 2026-07-04; the real pool is an upgradeable proxy over unverified bytecode —
/// selector-resolved + fork-executed):
///
///   estimateSwap(tokenIn, tokenOut, amountIn) view returns (uint256) — STATICCALL-safe. REVERT
///     classes reproduced: a ZERO amount reverts (custom error LCZeroAmount — the real 0x1f2a2005
///     class), an UNSUPPORTED pair reverts (LCUnsupportedPair — the real 0xc1ab6dc1 class); a
///     DRAINED-output pool returns 0 GRACEFULLY; an OVERSIZED amount returns a CAPPED quote
///     gracefully (the real pool's asymptotic imbalance-fee curve — probed: 1e24 in quoted ~2115
///     against a 2.8k inventory, no revert).
///
///   swap(tokenIn, tokenOut, amountIn, minAmountOut) returns (uint256) — PERMISSIONLESS,
///     approve-first: pulls EXACTLY the FULL amountIn from msg.sender via transferFrom (the real
///     pool pulls 100% of the input even on a capped-output oversize — fork-proven; pull == approve
///     ALWAYS) and pays the quoted out to msg.sender. minAmountOut violation reverts (LCMinOut —
///     the real 0x8199f5f3 class).
///
///   getTokens() view returns (address, address) — TWO addresses, NOT an array (raw-decoded on the
///     real pool).
///
///   THE ORACLE — the pool prices off the HYPEREVM BBO READ PRECOMPILE at its CANONICAL address
///     (constructor-provided so the tests pass the canonical 0x…080e with HLBboPrecompileMock
///     etched there — the exact precompile-mock pattern the real integration needs): a RAW 32-byte
///     spot-index STATICCALL per side, reading (bid, ask). Sell tokenIn at ITS book's BID, buy
///     tokenOut at ITS book's ASK (both books quoted vs the same numeraire, so the cross is
///     bidIn/askOut) — mirroring the real pool's two-book cross (traced: indexes 10107 + 10166).
///
///   THE CURVE (fixture-deterministic; the real curve is unverified bytecode — the prod-mirror
///     covers it): linear cross-price then HYPERBOLIC INVENTORY SATURATION —
///       linear = amountIn · bidIn / askOut
///       gross  = linear · avail / (linear + avail)      (avail = the OUT-token inventory)
///       out    = gross · (SCALE − feePpm) / SCALE
///     Strictly convex (the marginal decays with size), asymptotically capped BELOW the inventory
///     (the graceful-oversize class), 0 when drained — the same quote classes probed on the real
///     pool. Bit-replayable off-chain in bigints (the test's getDy model). Quotes re-read the LIVE
///     BBO every call, so a book re-post (the drift cells' setBbo) re-anchors the whole curve —
///     the oracle-priced re-centering the real venue exhibits.
contract LiquidCorePool {
    uint256 private constant SCALE = 1e6;

    error LCZeroAmount(); // the real 0x1f2a2005 class
    error LCUnsupportedPair(); // the real 0xc1ab6dc1 class
    error LCMinOut(); // the real 0x8199f5f3 class
    error LCBboRead();

    address private immutable _token0;
    address private immutable _token1;
    address private immutable _bbo; // the BBO precompile address (canonical 0x…080e in the tests)
    uint256 private immutable _index0; // token0's spot-pair index on the BBO book
    uint256 private immutable _index1; // token1's spot-pair index
    uint256 private immutable _feePpm; // 1e6-scaled, netted off the gross out

    constructor(address token0_, address token1_, address bbo_, uint256 index0_, uint256 index1_, uint256 feePpm_) {
        _token0 = token0_;
        _token1 = token1_;
        _bbo = bbo_;
        _index0 = index0_;
        _index1 = index1_;
        _feePpm = feePpm_;
    }

    /// @notice The real pool's two-address token getter (NOT an array).
    function getTokens() external view returns (address tokenA, address tokenB) {
        return (_token0, _token1);
    }

    function getReserves() external view returns (uint256 reserve0, uint256 reserve1) {
        return (IERC20LC(_token0).balanceOf(address(this)), IERC20LC(_token1).balanceOf(address(this)));
    }

    // ── the BBO read (raw 32-byte index STATICCALL — the precompile wire shape) ──
    function _bboRead(uint256 index) private view returns (uint256 bid_, uint256 ask_) {
        (bool ok, bytes memory ret) = _bbo.staticcall(abi.encode(index));
        if (!ok || ret.length != 64) revert LCBboRead();
        (bid_, ask_) = abi.decode(ret, (uint256, uint256));
    }

    // ── the quote core (shared by estimateSwap + swap; view — inventory read via balanceOf) ──
    function _quote(address tokenIn, address tokenOut, uint256 amountIn) private view returns (uint256 out) {
        if (amountIn == 0) revert LCZeroAmount();
        bool in0 = tokenIn == _token0 && tokenOut == _token1;
        bool in1 = tokenIn == _token1 && tokenOut == _token0;
        if (!in0 && !in1) revert LCUnsupportedPair();
        (uint256 bidIn, ) = _bboRead(in0 ? _index0 : _index1);
        (, uint256 askOut) = _bboRead(in0 ? _index1 : _index0);
        if (bidIn == 0 || askOut == 0) return 0; // starved book — the graceful drained class
        uint256 linear = (amountIn * bidIn) / askOut;
        uint256 avail = IERC20LC(tokenOut).balanceOf(address(this));
        if (avail == 0 || linear == 0) return 0; // drained pool quotes 0 gracefully (probed)
        uint256 gross = (linear * avail) / (linear + avail); // hyperbolic saturation < avail
        out = (gross * (SCALE - _feePpm)) / SCALE;
    }

    /// @notice The STATICCALL-safe exact-in quote (the QL ladder's probe-then-decode target).
    function estimateSwap(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut) {
        return _quote(tokenIn, tokenOut, amountIn);
    }

    /// @notice The permissionless approve-first swap: pulls the FULL amountIn (pull == approve
    /// always — the fork-proven real behavior), pays the quoted out, enforces minAmountOut.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut) external returns (uint256 amountOut) {
        amountOut = _quote(tokenIn, tokenOut, amountIn);
        if (amountOut < minAmountOut) revert LCMinOut();
        require(IERC20LC(tokenIn).transferFrom(msg.sender, address(this), amountIn), "LC-pull");
        if (amountOut > 0) {
            require(IERC20LC(tokenOut).transfer(msg.sender, amountOut), "LC-pay");
        }
    }
}
