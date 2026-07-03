// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Faithful Balancer V2 StableMath library for local EVM tests of the engine `_swapBalancerV2`
/// path. Reproduces balancer-v2-monorepo `pkg/pool-stable/contracts/StableMath.sol` BIT-FOR-BIT, matching
/// the off-chain bigint replay in `sdk/src/recipes/shared/balancer-stable-math.ts` — the SAME
/// _calculateInvariant / _getTokenBalanceGivenInvariantAndAllOtherBalances / _calcOutGivenIn
/// (_AMP_PRECISION = 1e3, ampTimesTotal = amp·n, the divUp Newton on the out balance, the final `-1`
/// round-in-pool-favor). So the Vault.swap output equals the off-chain getDy to the wei — the
/// wei-exact-in-dy gate.
library BalancerStableMath {
    uint256 internal constant AMP_PRECISION = 1e3;

    function calculateInvariant(uint256 amp, uint256[] memory balances) internal pure returns (uint256) {
        uint256 sum = 0;
        uint256 n = balances.length;
        for (uint256 i = 0; i < n; i++) sum += balances[i];
        if (sum == 0) return 0;

        uint256 invariant = sum;
        uint256 ampTimesTotal = amp * n;
        for (uint256 it = 0; it < 255; it++) {
            uint256 D_P = invariant;
            for (uint256 j = 0; j < n; j++) {
                D_P = (D_P * invariant) / (balances[j] * n);
            }
            uint256 prev = invariant;
            invariant = (((ampTimesTotal * sum) / AMP_PRECISION + D_P * n) * invariant)
                / (((ampTimesTotal - AMP_PRECISION) * invariant) / AMP_PRECISION + (n + 1) * D_P);
            if (invariant > prev) {
                if (invariant - prev <= 1) return invariant;
            } else if (prev - invariant <= 1) {
                return invariant;
            }
        }
        revert("INV");
    }

    function _divUp(uint256 a, uint256 b) private pure returns (uint256) {
        if (a == 0) return 0;
        return 1 + (a - 1) / b;
    }

    function getTokenBalanceGivenInvariant(
        uint256 amp,
        uint256[] memory balances,
        uint256 invariant,
        uint256 tokenIndex
    ) internal pure returns (uint256) {
        uint256 n = balances.length;
        uint256 ampTimesTotal = amp * n;
        uint256 sum = balances[0];
        uint256 P_D = n * balances[0];
        for (uint256 j = 1; j < n; j++) {
            P_D = (P_D * balances[j] * n) / invariant;
            sum += balances[j];
        }
        sum -= balances[tokenIndex];

        uint256 inv2 = invariant * invariant;
        uint256 c = _divUp(inv2, ampTimesTotal * P_D) * AMP_PRECISION * balances[tokenIndex];
        uint256 b = sum + (invariant / ampTimesTotal) * AMP_PRECISION;

        uint256 tokenBalance = _divUp(inv2 + c, invariant + b);
        for (uint256 it = 0; it < 255; it++) {
            uint256 prev = tokenBalance;
            tokenBalance = _divUp(tokenBalance * tokenBalance + c, tokenBalance * 2 + b - invariant);
            if (tokenBalance > prev) {
                if (tokenBalance - prev <= 1) return tokenBalance;
            } else if (prev - tokenBalance <= 1) {
                return tokenBalance;
            }
        }
        revert("BAL");
    }

    /// @notice Upscaled tokens-out for an upscaled amountIn (no fee — netted before upscaling).
    function calcOutGivenIn(
        uint256 amp,
        uint256[] memory balances,
        uint256 i,
        uint256 j,
        uint256 amountIn,
        uint256 invariant
    ) internal pure returns (uint256) {
        balances[i] += amountIn;
        uint256 finalOut = getTokenBalanceGivenInvariant(amp, balances, invariant, j);
        balances[i] -= amountIn;
        if (balances[j] <= finalOut + 1) return 0;
        return balances[j] - finalOut - 1;
    }
}

/// @notice Faithful Balancer V2 ComposableStable pool for local EVM tests of EcoSwap's engine path.
///
/// The pool's registered token list INCLUDES the BPT (this pool's own token) at `bptIndex`; the BPT is
/// EXCLUDED from the StableMath. Balances are UPSCALED by getScalingFactors() (decimals + rate-provider
/// rates, all 1e18-WAD) before the math and the output DOWNSCALED after; the swap fee
/// (getSwapFeePercentage, 1e18-WAD) is taken on the upscaled amountIn first. This mirrors
/// ComposableStablePool._onSwapGivenIn and the off-chain `balancer-stable-math.ts` getDy bit-for-bit.
///
/// The engine `_swapBalancerV2` reads `getPoolId()` then calls Vault.swap(SingleSwap{GIVEN_IN}). This
/// pool exposes the read surface discovery needs (getPoolId / getAmplificationParameter /
/// getScalingFactors / getSwapFeePercentage / getBptIndex); the Vault fixture (deployed at the canonical
/// 0xBA12… address) drives onSwap against this pool's StableMath and moves the tokens.
contract BalancerComposableStable {
    uint256 private constant WAD = 1e18;

    bytes32 public poolId;
    address[] private _tokens; // registered tokens INCLUDING the BPT (== this pool) at bptIndex
    uint256[] private _balances; // registered balances (BPT balance is a large sentinel, ignored)
    uint256[] private _scaling; // per-token scaling factor (WAD), aligned with _tokens
    uint256 public bptIndex;
    uint256 public amp; // A·AMP_PRECISION
    uint256 public swapFee; // 1e18-WAD

    constructor(
        address[] memory tokens_,
        uint256[] memory scaling_,
        uint256 bptIndex_,
        uint256 amp_,
        uint256 swapFee_
    ) {
        require(tokens_.length == scaling_.length, "len");
        _tokens = tokens_;
        _scaling = scaling_;
        _balances = new uint256[](tokens_.length);
        bptIndex = bptIndex_;
        amp = amp_;
        swapFee = swapFee_;
        poolId = bytes32(uint256(uint160(address(this))) << 96); // first 20 bytes == pool address
    }

    function getPoolId() external view returns (bytes32) {
        return poolId;
    }

    function getAmplificationParameter() external view returns (uint256 value, bool isUpdating, uint256 precision) {
        return (amp, false, BalancerStableMath.AMP_PRECISION);
    }

    function getScalingFactors() external view returns (uint256[] memory) {
        return _scaling;
    }

    function getSwapFeePercentage() external view returns (uint256) {
        return swapFee;
    }

    function getBptIndex() external view returns (uint256) {
        return bptIndex;
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    function balances() external view returns (uint256[] memory) {
        return _balances;
    }

    /// @notice Set a registered token's balance (the Vault calls this on registration / after a swap).
    function setBalance(uint256 k, uint256 bal) external {
        _balances[k] = bal;
    }

    /// @notice The non-BPT (StableMath) balances, upscaled, plus the non-BPT indices of in/out.
    function _stableState(address tokenIn, address tokenOut)
        internal
        view
        returns (uint256[] memory up, uint256 iIdx, uint256 jIdx, uint256 scalIn, uint256 scalOut)
    {
        uint256 nNon = _tokens.length - 1;
        up = new uint256[](nNon);
        bool foundI;
        bool foundJ;
        uint256 w;
        for (uint256 k = 0; k < _tokens.length; k++) {
            if (k == bptIndex) continue;
            up[w] = (_balances[k] * _scaling[k]) / WAD;
            if (_tokens[k] == tokenIn) {
                iIdx = w;
                scalIn = _scaling[k];
                foundI = true;
            }
            if (_tokens[k] == tokenOut) {
                jIdx = w;
                scalOut = _scaling[k];
                foundJ = true;
            }
            w++;
        }
        require(foundI && foundJ, "TOKENS");
    }

    /// @notice Exact tokens-out (tokenOut native decimals) for `amountIn` (tokenIn native decimals),
    /// INCLUDING the swap fee — the StableMath the Vault enforces. Pure-ish view (reads balances).
    function onSwapGivenIn(uint256 amountIn, address tokenIn, address tokenOut) public view returns (uint256) {
        if (amountIn == 0) return 0;
        // FixedPoint.mulUp fee, then upscale the net input.
        uint256 fee = amountIn * swapFee == 0 ? 0 : (amountIn * swapFee - 1) / WAD + 1;
        if (fee >= amountIn) return 0;
        uint256 net = amountIn - fee;

        (uint256[] memory up, uint256 iIdx, uint256 jIdx, uint256 scalIn, uint256 scalOut) =
            _stableState(tokenIn, tokenOut);
        uint256 inUp = (net * scalIn) / WAD;
        if (inUp == 0) return 0;

        uint256 inv = BalancerStableMath.calculateInvariant(amp, up);
        uint256 outUp = BalancerStableMath.calcOutGivenIn(amp, up, iIdx, jIdx, inUp, inv);
        if (outUp == 0) return 0;
        return (outUp * WAD) / scalOut; // FixedPoint.divDown downscale
    }
}

/// @notice Minimal Balancer V2 Vault for the engine `_swapBalancerV2` path. Deployed/etched at the
/// canonical 0xBA12222222228d8Ba445958a75a0704d566BF2C8 (the engine hardcodes it). Implements
/// swap(SingleSwap, FundManagement, limit, deadline) and getPoolTokens(poolId) over a registered
/// ComposableStable pool. On swap it pulls assetIn from funds.sender (the router, which force-approved
/// the Vault), drives the pool's onSwapGivenIn StableMath, updates the pool's balances, and transfers
/// assetOut to funds.recipient — exactly the GIVEN_IN single-swap surface the engine builds.
contract BalancerVault {
    enum SwapKind { GIVEN_IN, GIVEN_OUT }

    struct SingleSwap {
        bytes32 poolId;
        SwapKind kind;
        address assetIn;
        address assetOut;
        uint256 amount;
        bytes userData;
    }

    struct FundManagement {
        address sender;
        bool fromInternalBalance;
        address payable recipient;
        bool toInternalBalance;
    }

    /// poolId → pool address. Registered by registerPool (the fixture's analogue of PoolRegistry).
    mapping(bytes32 => address) public poolAddress;

    function registerPool(bytes32 poolId, address pool) external {
        poolAddress[poolId] = pool;
    }

    function getPoolTokens(bytes32 poolId)
        external
        view
        returns (address[] memory tokens, uint256[] memory bals, uint256 lastChangeBlock)
    {
        BalancerComposableStable pool = BalancerComposableStable(poolAddress[poolId]);
        return (pool.tokens(), pool.balances(), 0);
    }

    /// Per-token SCALAR view the on-chain QL solver (segKind 6) reads for the live balances — the v12-safe
    /// path (getPoolTokens nests the balances dyn array in a tuple → garbage on v12). cash == the token's
    /// registered balance; managed == 0 (no asset manager in the fixture). Mirrors the real Vault's
    /// getPoolTokenInfo(bytes32,address) surface.
    function getPoolTokenInfo(bytes32 poolId, address token)
        external
        view
        returns (uint256 cash, uint256 managed, uint256 lastChangeBlock, address assetManager)
    {
        BalancerComposableStable pool = BalancerComposableStable(poolAddress[poolId]);
        address[] memory tks = pool.tokens();
        uint256[] memory bals = pool.balances();
        for (uint256 k = 0; k < tks.length; k++) {
            if (tks[k] == token) return (bals[k], 0, 0, address(0));
        }
        return (0, 0, 0, address(0));
    }

    function swap(
        SingleSwap memory singleSwap,
        FundManagement memory funds,
        uint256 limit,
        uint256 deadline
    ) external payable returns (uint256 amountOut) {
        require(deadline >= block.timestamp, "DEADLINE");
        require(singleSwap.kind == SwapKind.GIVEN_IN, "KIND");
        address poolAddr = poolAddress[singleSwap.poolId];
        require(poolAddr != address(0), "POOL");
        BalancerComposableStable pool = BalancerComposableStable(poolAddr);

        amountOut = pool.onSwapGivenIn(singleSwap.amount, singleSwap.assetIn, singleSwap.assetOut);
        require(amountOut >= limit, "LIMIT");

        // Pull assetIn from the sender (the router/pot — it force-approved the Vault).
        IERC20Min(singleSwap.assetIn).transferFrom(funds.sender, address(this), singleSwap.amount);
        // Pay assetOut to the recipient.
        IERC20Min(singleSwap.assetOut).transfer(funds.recipient, amountOut);

        // Update the pool's registered balances (in += amount, out -= amountOut) so subsequent swaps
        // price on the moved state — mirrors the Vault's accounting.
        address[] memory tks = pool.tokens();
        for (uint256 k = 0; k < tks.length; k++) {
            if (tks[k] == singleSwap.assetIn) pool.setBalance(k, pool.balances()[k] + singleSwap.amount);
            if (tks[k] == singleSwap.assetOut) pool.setBalance(k, pool.balances()[k] - amountOut);
        }
    }
}
