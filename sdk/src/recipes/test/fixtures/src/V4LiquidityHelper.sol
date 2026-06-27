// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

type Currency is address;

struct PoolKey {
    Currency currency0;
    Currency currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPoolManager {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function sync(Currency currency) external;
    function settle() external payable returns (uint256);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Test-only Uniswap V4 liquidity helper.
///
/// Drives the REAL (etched) PoolManager through its own `initialize` /
/// `unlock`+`modifyLiquidity` flow and settles owed ERC20 amounts — no v4
/// periphery dependency. The helper must hold enough of both tokens to pay the
/// pool on settle (mint/transfer them to this contract before `addLiquidity`).
contract V4LiquidityHelper {
    IPoolManager public immutable manager;

    constructor(IPoolManager _manager) {
        manager = _manager;
    }

    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external returns (int24 tick) {
        return manager.initialize(key, sqrtPriceX96);
    }

    /// @notice Add `liquidity` across [tickLower, tickUpper] to `key`'s pool.
    function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint128 liquidity) external {
        int24[] memory los = new int24[](1);
        int24[] memory his = new int24[](1);
        uint128[] memory ls = new uint128[](1);
        los[0] = tickLower;
        his[0] = tickUpper;
        ls[0] = liquidity;
        manager.unlock(abi.encode(key, los, his, ls));
    }

    /// @notice Add MANY positions in a SINGLE unlock (one tx) — used to reproduce a
    ///         real pool's tick profile without one unlock tx per boundary. The
    ///         helper must hold enough of both tokens to settle the total owed.
    function batchAddLiquidity(
        PoolKey calldata key,
        int24[] calldata tickLowers,
        int24[] calldata tickUppers,
        uint128[] calldata liquidities
    ) external {
        manager.unlock(abi.encode(key, tickLowers, tickUppers, liquidities));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "only manager");
        (PoolKey memory key, int24[] memory los, int24[] memory his, uint128[] memory ls) =
            abi.decode(data, (PoolKey, int24[], int24[], uint128[]));

        // Adding liquidity yields negative deltas (we owe the pool). Sum what we owe
        // across all positions, then settle each currency ONCE at the end.
        uint256 owed0;
        uint256 owed1;
        for (uint256 i = 0; i < ls.length; i++) {
            if (ls[i] == 0) continue;
            (int256 callerDelta,) = manager.modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: los[i],
                    tickUpper: his[i],
                    liquidityDelta: int256(uint256(ls[i])),
                    salt: bytes32(0)
                }),
                ""
            );
            // BalanceDelta packs amount0 in the upper 128 bits, amount1 in the lower.
            int128 amt0 = int128(callerDelta >> 128);
            int128 amt1 = int128(callerDelta);
            if (amt0 < 0) owed0 += uint256(uint128(-amt0));
            if (amt1 < 0) owed1 += uint256(uint128(-amt1));
        }
        if (owed0 > 0) _settle(key.currency0, owed0);
        if (owed1 > 0) _settle(key.currency1, owed1);
        return "";
    }

    function _settle(Currency currency, uint256 amount) internal {
        manager.sync(currency);
        IERC20(Currency.unwrap(currency)).transfer(address(manager), amount);
        manager.settle();
    }
}
