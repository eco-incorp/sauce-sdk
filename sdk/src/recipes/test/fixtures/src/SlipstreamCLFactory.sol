// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Minimal Velodrome/Aerodrome-Slipstream-style CLFactory REGISTRY for local EVM tests.
///
/// A Slipstream CL pool is UniswapV3-compatible for pricing AND execution (standard slot0/ticks/
/// liquidity/tickSpacing/fee surface; swap() re-enters via uniswapV3SwapCallback), so the faithful
/// fixture reuses a REAL Uniswap v3-core pool (created via the standard V3 factory + funded via the
/// V3LiquidityHelper the other tests use). The ONLY thing that differs from Uniswap V3 is DISCOVERY:
/// the Slipstream CLFactory keys pools by TICK SPACING — getPool(tokenA, tokenB, int24 tickSpacing)
/// — NOT getPool(a, b, uint24 fee). This shim exposes exactly that surface, mapping a
/// (tokenA, tokenB, tickSpacing) key onto an already-deployed V3 pool address; `setPool` records
/// both token orderings. It carries NO fee dimension by design — the per-pool fee is read from the
/// pool's OWN fee() getter (Slipstream decouples fee from tickSpacing), exactly as production does.
contract SlipstreamCLFactory {
    // getPool[tokenA][tokenB][tickSpacing] => pool
    mapping(address => mapping(address => mapping(int24 => address))) public getPool;

    function setPool(address tokenA, address tokenB, int24 tickSpacing, address pool) external {
        getPool[tokenA][tokenB][tickSpacing] = pool;
        getPool[tokenB][tokenA][tickSpacing] = pool;
    }
}
