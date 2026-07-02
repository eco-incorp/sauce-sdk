// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @notice Local Balancer V3 (balancer/balancer-v3-monorepo — Vault singleton + per-chain Router) fixture
/// for EcoSwap's callback-free Balancer V3 path. It mirrors the REAL VERIFIED SURFACE the recipe hits
/// on-chain — the per-chain Router's query + swap and the canonical Permit2 pull — so the local-EVM test
/// exercises exactly the interface the on-chain solver calls:
///
///   Router.querySwapSingleTokenExactIn(pool, tokenIn, tokenOut, exactAmountIn, sender, userData) -> uint256
///     — the LIVE quote (rate-provider + fee inclusive). On the real Router it unlock()s the Vault in QUERY
///       mode and rolls back; here it is a pure view of the pool's stable-math out (side-effect-free either
///       way, so callable via staticcall for both the off-chain sampling ladder AND the on-chain minAmountOut).
///   Router.swapSingleTokenExactIn(pool, tokenIn, tokenOut, exactAmountIn, minAmountOut, deadline, wethIsEth,
///                                 userData) payable -> uint256
///     — the exec leg. It PULLS the input via Permit2.transferFrom(sender, VAULT, amountIn, tokenIn) (the ONE
///       operational difference from V2 — the input is pulled through Permit2, so the caller must
///       ERC20.approve(PERMIT2) then Permit2.approve(tokenIn, ROUTER, amount, expiration) first), then pays
///       amountOut to the sender. The caller (our cooking contract) is NEVER re-entered — the real V3
///       reentrancy is fully contained inside the Router+Vault, so this is callback-free.
///   Router.getPermit2() view -> address
///   Vault.getPoolTokens(pool) view -> address[]   (discovery orients the pair; V3 has no BPT in the list)
///   Vault.isPoolRegistered(pool) view -> bool
///   Permit2.approve(token, spender, amount, expiration)  +  transferFrom(from, to, amount, token)
///
/// PRICING is the amplified StableSwap out (the SAME invariant as V2 — see balancer-v3-math.ts). To keep the
/// fixture small + deterministic while still giving a strictly-convex descending marginal (so the split
/// engages + equalizes across pools of different depth), the out is a near-1:1 constant-product-style form:
///   grossOut = amountIn·balOut/(balIn + amountIn)·centerPrice/1e18 , minus a swap fee off the output,
/// then CAPPED by an out-side liquidity limit (past the cap the quote is 0 — the un-queryable/limit edge).
/// `setState` MOVES centerPrice/fee (models the rate providers accruing + the surge fee moving between
/// prepare and cook). This is NOT the exact StableMath — the math KAT lives in ecoswap.math.test.ts (which
/// proves V3 shares V2 StableMath bit-for-bit); the fixture only needs a faithful convex query surface so the
/// exec gate (received == the LIVE query) + the split are exercised end to end.
contract BalancerV3Pool {
    uint256 private constant FEE_SCALE = 1e6;
    uint256 private constant RATE_SCALE = 1e18;

    address public token0;
    address public token1;
    uint256 private _bal0; // token0 pool balance (the convex-curve reserve)
    uint256 private _bal1; // token1 pool balance
    uint256 private _centerPrice; // token1-per-token0 center price (1e18)
    uint256 private _feePpm; // swap fee, 1e6-scaled (0.005% = 50)
    uint256 private _outCap0; // max token0-out for a 1→0 swap; 0 ⇒ unbounded
    uint256 private _outCap1; // max token1-out for a 0→1 swap; 0 ⇒ unbounded

    constructor(
        address token0_,
        address token1_,
        uint256 bal0_,
        uint256 bal1_,
        uint256 centerPrice_,
        uint256 feePpm_
    ) {
        token0 = token0_;
        token1 = token1_;
        _bal0 = bal0_;
        _bal1 = bal1_;
        _centerPrice = centerPrice_;
        _feePpm = feePpm_;
    }

    /// @notice Move the pricing state (re-center / move the fee) — the drift hook.
    function setState(uint256 centerPrice_, uint256 feePpm_) external {
        _centerPrice = centerPrice_;
        _feePpm = feePpm_;
    }

    /// @notice Set the per-side out-caps (models a liquidity limit before cook). 0 ⇒ none.
    function setCaps(uint256 outCap0_, uint256 outCap1_) external {
        _outCap0 = outCap0_;
        _outCap1 = outCap1_;
    }

    function getTokens() external view returns (address[] memory t_) {
        t_ = new address[](2);
        t_[0] = token0;
        t_[1] = token1;
    }

    /// @notice The stable-ish out for `amountIn` of `tokenIn` (near-1:1 convex form + fee + cap). Pure view.
    function quoteOut(address tokenIn, uint256 amountIn) public view returns (uint256) {
        if (amountIn == 0) return 0;
        bool zeroForOne = tokenIn == token0;
        uint256 balIn = zeroForOne ? _bal0 : _bal1;
        uint256 balOut = zeroForOne ? _bal1 : _bal0;
        // Constant-product-style convex out on the reserves (a monotone, strictly-convex proxy for the
        // amplified StableSwap curve — sufficient for the split/exec test; the exact StableMath is KAT'd
        // in ecoswap.math.test.ts).
        uint256 gross = (amountIn * balOut) / (balIn + amountIn);
        // Center price (token1-per-token0): scale the out into the OUT token's units.
        if (zeroForOne) {
            gross = (gross * _centerPrice) / RATE_SCALE;
        } else {
            gross = (gross * RATE_SCALE) / _centerPrice;
        }
        uint256 fee = (gross * _feePpm) / FEE_SCALE;
        uint256 net = gross > fee ? gross - fee : 0;
        uint256 cap = zeroForOne ? _outCap1 : _outCap0;
        if (cap != 0 && net > cap) return 0;
        return net;
    }
}

interface IBalancerV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getTokens() external view returns (address[] memory);
    function quoteOut(address tokenIn, uint256 amountIn) external view returns (uint256);
}

interface IPermit2Min {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

/// @notice Local Permit2 fixture — mirrors the canonical Uniswap Permit2 `approve` + `transferFrom` surface
/// the Balancer V3 Router consumes. approve(token, spender, amount, expiration) records the allowance;
/// transferFrom(from, to, amount, token) (called by the Router) pulls via the underlying ERC20 after checking
/// BOTH the token's ERC20 allowance to THIS Permit2 (set by the caller's ERC20.approve(PERMIT2)) AND the
/// Permit2 allowance to the spender.
contract Permit2 {
    // owner => token => spender => amount
    mapping(address => mapping(address => mapping(address => uint256))) public allowances;

    function approve(address token, address spender, uint160 amount, uint48 /*expiration*/ ) external {
        allowances[msg.sender][token][spender] = amount;
    }

    /// @notice The Router-facing pull. `msg.sender` is the SPENDER (the Router); it moves `amount` of `token`
    /// from `from` to `to`, consuming the Permit2 allowance from→token→spender.
    function transferFrom(address from, address to, uint160 amount, address token) external {
        uint256 allowed = allowances[from][token][msg.sender];
        require(allowed >= amount, "Permit2: allowance");
        if (allowed != type(uint256).max) {
            allowances[from][token][msg.sender] = allowed - amount;
        }
        require(IERC20Min(token).transferFrom(from, to, amount), "Permit2: pull");
    }
}

/// @notice Local Balancer V3 Router fixture — the per-chain single-swap Router. Holds the Vault (which holds
/// the pool token reserves — the fixture makes the Router itself the "Vault" for simplicity, so it holds the
/// output reserves the swap pays out from) + the Permit2 the swap pulls through.
contract BalancerV3Router {
    address public immutable vault; // the "Vault" holding reserves — this Router itself in the fixture
    address private immutable _permit2;

    event V3Swap(address pool, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);

    constructor(address permit2_) {
        vault = address(this);
        _permit2 = permit2_;
    }

    function getPermit2() external view returns (address) {
        return _permit2;
    }

    // ── Vault surface (discovery) ──
    function getPoolTokens(address pool) external view returns (address[] memory) {
        return IBalancerV3Pool(pool).getTokens();
    }

    function isPoolRegistered(address /*pool*/ ) external pure returns (bool) {
        return true;
    }

    // ── Query (off-chain sampling + on-chain minAmountOut) ──
    /// @notice The LIVE exact-in quote — a pure view of the pool's stable-math out. On the real Router this
    /// unlock()s the Vault in QUERY mode and rolls back; here it is side-effect-free directly (callable via
    /// staticcall either way). sender/userData are accepted (real signature) but unused by the fixture math.
    function querySwapSingleTokenExactIn(
        address pool,
        address tokenIn,
        address tokenOut,
        uint256 exactAmountIn,
        address, /*sender*/
        bytes calldata /*userData*/
    ) external view returns (uint256 amountOut) {
        require(tokenOut != address(0), "V3: bad_out");
        amountOut = IBalancerV3Pool(pool).quoteOut(tokenIn, exactAmountIn);
    }

    // ── Swap (exec — Permit2 pull, no callback into the caller) ──
    function swapSingleTokenExactIn(
        address pool,
        address tokenIn,
        address tokenOut,
        uint256 exactAmountIn,
        uint256 minAmountOut,
        uint256 deadline,
        bool, /*wethIsEth*/
        bytes calldata /*userData*/
    ) external payable returns (uint256 amountOut) {
        require(block.timestamp <= deadline, "V3: deadline");
        amountOut = IBalancerV3Pool(pool).quoteOut(tokenIn, exactAmountIn);
        require(amountOut >= minAmountOut, "V3: amountOut_LT_min");
        require(amountOut > 0, "V3: zero_out");
        // PULL the input via Permit2 into the Vault (== this Router in the fixture). The caller ERC20-approved
        // Permit2 and Permit2-approved this Router first — exactly the on-chain flow.
        IPermit2Min(_permit2).transferFrom(msg.sender, vault, uint160(exactAmountIn), tokenIn);
        // Pay the output from the Vault's reserve to the sender. The caller is NEVER re-entered.
        IERC20Min(tokenOut).transfer(msg.sender, amountOut);
        emit V3Swap(pool, tokenIn, tokenOut, exactAmountIn, amountOut);
    }
}
