// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

type Currency is address;

/// PancakeSwap Infinity 6-field PoolKey (order matters — poolId = keccak256(abi.encode(key))).
/// `parameters` packs the CL tickSpacing at bits [16..39] and the hook-callback bitmap in the
/// low 16 bits.
struct InfinityPoolKey {
    Currency currency0;
    Currency currency1;
    address hooks;
    address poolManager;
    uint24 fee;
    bytes32 parameters;
}

struct CLModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IInfinityVault {
    function lock(bytes calldata data) external returns (bytes memory);
    function sync(Currency currency) external;
    function settle() external payable returns (uint256);
}

interface ICLPoolManagerMin {
    function initialize(InfinityPoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function modifyLiquidity(InfinityPoolKey memory key, CLModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 delta, int256 feeDelta);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Test-only PancakeSwap Infinity CL liquidity helper.
///
/// Drives the REAL (etched) Vault + CLPoolManager through their own `initialize` /
/// `lock`+`lockAcquired`+`modifyLiquidity`+`sync`/`settle` flow — the Infinity mirror of
/// V4LiquidityHelper (V4: unlock/unlockCallback; Infinity: lock/lockAcquired against the
/// SEPARATE Vault accountant). The helper must hold enough of both tokens to pay the Vault on
/// settle (mint/transfer them here before adding liquidity). Requires the CLPoolManager to be
/// a REGISTERED app on the Vault (the etch harness pokes `isAppRegistered[clpm] = true` — the
/// mapping slot is captured from the real BSC layout by harness/infinity-snapshot.ts).
contract InfinityLiquidityHelper {
    IInfinityVault public immutable vault;
    ICLPoolManagerMin public immutable manager;

    constructor(IInfinityVault _vault, ICLPoolManagerMin _manager) {
        vault = _vault;
        manager = _manager;
    }

    /// @notice Initialize a pool (permissionless, lock-free on Infinity).
    function initialize(InfinityPoolKey calldata key, uint160 sqrtPriceX96) external returns (int24 tick) {
        return manager.initialize(key, sqrtPriceX96);
    }

    /// @notice Add `liquidity` across [tickLower, tickUpper] to `key`'s pool.
    function addLiquidity(InfinityPoolKey calldata key, int24 tickLower, int24 tickUpper, uint128 liquidity)
        external
    {
        int24[] memory los = new int24[](1);
        int24[] memory his = new int24[](1);
        uint128[] memory ls = new uint128[](1);
        los[0] = tickLower;
        his[0] = tickUpper;
        ls[0] = liquidity;
        vault.lock(abi.encode(key, los, his, ls));
    }

    /// @notice Add MANY positions in a SINGLE lock (one tx) — used to reproduce a real pool's
    ///         tick profile without one lock tx per boundary.
    function batchAddLiquidity(
        InfinityPoolKey calldata key,
        int24[] calldata tickLowers,
        int24[] calldata tickUppers,
        uint128[] calldata liquidities
    ) external {
        vault.lock(abi.encode(key, tickLowers, tickUppers, liquidities));
    }

    /// @notice The Vault re-enters HERE mid-lock (ILockCallback.lockAcquired). Mint every
    ///         position, then settle the owed amounts per currency ONCE (sync → transfer-in →
    ///         settle — the verified Vault order).
    function lockAcquired(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(vault), "only vault");
        (InfinityPoolKey memory key, int24[] memory los, int24[] memory his, uint128[] memory ls) =
            abi.decode(data, (InfinityPoolKey, int24[], int24[], uint128[]));

        // Adding liquidity yields negative deltas (we owe the Vault). The returned `delta` is
        // the ACCOUNTED user delta (principal + feeDelta — CLPoolManager adds them before
        // accounting); sum what we owe across all positions, then settle each currency once.
        uint256 owed0;
        uint256 owed1;
        for (uint256 i = 0; i < ls.length; i++) {
            if (ls[i] == 0) continue;
            (int256 accountedDelta,) = manager.modifyLiquidity(
                key,
                CLModifyLiquidityParams({
                    tickLower: los[i],
                    tickUpper: his[i],
                    liquidityDelta: int256(uint256(ls[i])),
                    salt: bytes32(0)
                }),
                ""
            );
            // BalanceDelta packs amount0 in the upper 128 bits, amount1 in the lower.
            int128 amt0 = int128(accountedDelta >> 128);
            int128 amt1 = int128(accountedDelta);
            if (amt0 < 0) owed0 += uint256(uint128(-amt0));
            if (amt1 < 0) owed1 += uint256(uint128(-amt1));
        }
        if (owed0 > 0) _settle(key.currency0, owed0);
        if (owed1 > 0) _settle(key.currency1, owed1);
        return "";
    }

    function _settle(Currency currency, uint256 amount) internal {
        vault.sync(currency);
        IERC20(Currency.unwrap(currency)).transfer(address(vault), amount);
        vault.settle();
    }
}

/// @notice Minimal STATIC-FEE Infinity CL hook (beforeSwap-only, bitmap 0x0040): a no-op that
///         satisfies `Hooks.validateHookConfig` (its registration bitmap must equal the key's
///         low-16 parameter bits) and returns the plain selector on beforeSwap — the
///         deterministic-amounts launchpad class (NO returns-delta bits). Used by the
///         discovery-tier tests: a hooked pool must be EXCLUDED at discovery by default
///         (Tier B ships with an empty allowlist) and admitted only via the allowlist.
contract InfinityMockHook {
    uint16 public constant BITMAP = 0x0040; // bit 6 = beforeSwap

    function getHooksRegistrationBitmap() external pure returns (uint16) {
        return BITMAP;
    }

    /// ICLHooks.beforeSwap — returns (selector, BeforeSwapDelta 0, lpFeeOverride 0). The
    /// lpFeeOverride is IGNORED for static-fee pools (CLHooks parses it only for dynamic-fee
    /// keys — the Tier-B determinism claim).
    function beforeSwap(address, InfinityPoolKey calldata, SwapParamsMin calldata, bytes calldata)
        external
        pure
        returns (bytes4, int256, uint24)
    {
        return (InfinityMockHook.beforeSwap.selector, 0, 0);
    }
}

/// SwapParams mirror for the hook signature (bool zeroForOne, int256 amountSpecified,
/// uint160 sqrtPriceLimitX96) — struct name local to this fixture.
struct SwapParamsMin {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}
