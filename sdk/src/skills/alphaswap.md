# AlphaSwap

Sauce recipe for liquidity-weighted token swaps. Discovers pools off-chain, then reads on-chain liquidity at execution time to split the swap proportionally across direct pools and multi-hop routes.

## Category
recipe | Chain: Base

## Architecture
- **Off-chain (prepare)**: Discover pools via factory multicalls (Uniswap V3, PancakeSwap V3). No quoting -- fast, no simulation needed.
- **On-chain (SauceScript)**: Read liquidity from each pool, compute proportional allocation with MUL_DIV, execute swaps via SauceRouter.

## Key Operations
- **prepareAlphaSwap**: Off-chain pool discovery (returns directPools + multiHopRoutes)
- **alphaSwap**: Full pipeline: discover pools, compile SauceScript, return bytecodes for cook()

## SDK Usage
```typescript
import { alphaSwap, prepareAlphaSwap } from "@eco-incorp/sauce-sdk/recipes";
```

## How It Works

### Pool Discovery (Off-chain)
1. Query Uniswap V3 and PancakeSwap V3 factories for direct pools (tokenIn -> tokenOut) across all fee tiers (100, 500, 3000, 10000)
2. For multi-hop: try base tokens (WETH, USDC, DAI, USDbC) as intermediaries, discover pools for both legs
3. Filter out pools with liquidity below 10^13 (negligible)
4. Cross-filter: exclude multi-hop routes with effective liquidity < 0.1% of the deepest route
5. Keep top 2 multi-hop routes to avoid bytecode bloat

### Liquidity-Weighted Splitting (On-chain)
1. **Pass 1**: Read `liquidity()` from every pool. For multi-hop, effective liquidity = min(hop1Liq, hop2Liq). Sum to get totalLiq.
2. **Pass 2**: Re-read liquidity (may have changed), allocate `MUL_DIV(amountIn, poolLiq, totalLiq)` to each pool. Last route gets remainder (`amountIn - allocated`) to handle rounding.
3. Execute swaps via `router.swap()` with sorted PoolKey (currency0 < currency1).
4. For multi-hop: swap hop1 (tokenIn -> intermediate), read intermediate balance, approve, swap hop2 (intermediate -> tokenOut).
5. Transfer all output tokens to caller.

### Pool Tuple Format
Each direct pool is encoded as: `[poolType, poolAddress, fee, tickSpacing, hooks]`
Each multi-hop route: `[intermediateToken, hop1PoolType, hop1Pool, hop1Fee, hop1TickSpacing, hop1Hooks, hop2PoolType, hop2Pool, hop2Fee, hop2TickSpacing, hop2Hooks]`

## API

### `alphaSwap(config, rpcUrl, sauceRouterAddress, caller)`
Full pipeline. Returns `{ bytecodes, prepared, source }`.
- `config`: `{ tokenIn: Hex, tokenOut: Hex, amountIn: bigint }`
- `rpcUrl`: RPC endpoint for pool discovery
- `sauceRouterAddress`: Deployed SauceRouter address
- `caller`: Address calling cook() (for transferFrom)
- Returns: `bytecodes` (Hex[] for cook()), `prepared` (discovered pools), `source` (SauceScript for debugging)

### `prepareAlphaSwap(config, client)`
Off-chain only. Returns `{ directPools: PoolInfo[], multiHopRoutes: DiscoveredMultiHopRoute[] }`.

## Notes
- All runtime decisions (liquidity measurement, amount splitting) happen **on-chain** in the SauceScript -- not off-chain
- Uses MUL_DIV for precise proportional splitting without overflow
- Multi-hop effective liquidity = min(hop1, hop2) -- bottleneck determines route capacity
- The SauceScript uses `ABI_DECODE(pool.liquidity(), 1, 32)` to decode liquidity reads on-chain
- Pool types match Solidity enum: UniV2=0, UniV3=1, UniV4=2
- Only supports Base chain currently (WETH, USDC, DAI, USDbC as routing tokens)
- transferFrom at entry requires prior approval of tokenIn to the SauceRouter/executor
