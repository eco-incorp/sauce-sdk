# MegaSwap

Sauce recipe for adaptive price-stepping token swaps. Discovers and quotes pools off-chain, then uses an on-chain stepping loop that gradually lowers the price limit, allowing deep pools to swap more while shallow or high-fee pools contribute less.

## Category
recipe | Chain: Base

## Architecture
- **Off-chain (prepare)**: Discover pools, quote each for full amountIn, calculate adaptive stepSize from price deltas, filter shallow pools.
- **On-chain (SauceScript)**: Iterative price-stepping loop with fee-adjusted limits per pool.

## Key Operations
- **prepareMegaSwap**: Off-chain pool discovery + quoting + slippage calculation
- **megaSwap**: Full pipeline: discover, quote, compile SauceScript, return bytecodes for cook()

## SDK Usage
```typescript
import { megaSwap, prepareMegaSwap } from "@eco-incorp/sauce-sdk/recipes";
```

## How It Works

### Off-chain Preparation
1. Discover pools via factory multicalls (Uniswap V3, PancakeSwap V3) across all fee tiers
2. Quote each pool: simulate swapping the full amountIn with max slippage (MIN_SQRT_RATIO+1 or MAX_SQRT_RATIO-1)
3. Calculate price delta for each pool: `|sqrtPriceAfter - sqrtPriceBefore|`
4. Find the deepest pool (smallest delta = least price impact)
5. Set `stepSize = minDelta / 2` -- controls how aggressively the price limit drops
6. Filter shallow pools: exclude any pool with `delta > 10x minDelta`
7. Calculate fee-adjusted price limits per pool

### Adaptive Price-Stepping (On-chain)
1. **Phase 1**: Read `slot0()` from all pools. Find the highest sqrtPriceX96 (best current rate). Set initial `priceLimit` to this value.
2. **Phase 2**: While `remaining > 0`:
   a. Calculate proportional step: `MUL_DIV(stepSize, remaining, amountIn) + minStep` (shrinks as remaining shrinks; minStep = stepSize/100 prevents stalling)
   b. Lower `priceLimit` by the step
   c. For each pool: calculate fee-adjusted limit = `MUL_DIV(priceLimit, 1000000 + fee/2, 1000000)` (high-fee pools need BETTER prices to qualify)
   d. If pool's current price >= adjustedLimit and remaining > 0: swap all remaining with sqrtPriceLimitX96 = adjustedLimit
   e. Re-read tokenIn balance to update remaining
3. Transfer all output tokens to caller.

### Why Price-Stepping Works
- Deep pools (low fee, high liquidity) have prices above the limit for more iterations, so they absorb more volume
- Shallow pools or high-fee pools drop below the limit sooner, receiving less volume
- The fee adjustment `(1 + fee/2000000)` penalizes high-fee pools, requiring them to have even better prices
- Step size shrinks proportionally with remaining amount, giving finer-grained control near the end

### Pool Tuple Format
Each pool: `[poolType, poolAddress, fee, tickSpacing, hooks]`

## API

### `megaSwap(config, rpcUrl, sauceRouterAddress, caller)`
Full pipeline. Returns `{ bytecodes, prepared, source }`.
- `config`: `{ tokenIn: Hex, tokenOut: Hex, amountIn: bigint }`
- `rpcUrl`: RPC endpoint for pool discovery + quoting
- `sauceRouterAddress`: Deployed SauceRouter address (used for quote simulation)
- `caller`: Address calling cook() (for transferFrom)
- Returns: `bytecodes` (Hex[] for cook()), `prepared` (quoted pool data + stepSize), `source` (SauceScript for debugging)

### `prepareMegaSwap(config, client, sauceRouterAddress)`
Off-chain only. Returns `{ pools: PreparedPool[], stepSize: bigint, initialPriceLimit: bigint, zeroForOne: boolean, expectedOutput: bigint }`.

## Comparison with AlphaSwap
| Feature | AlphaSwap | MegaSwap |
|---------|-----------|----------|
| Off-chain work | Pool discovery only | Discovery + quoting + slippage calc |
| Splitting logic | Proportional to liquidity | Adaptive price-stepping |
| Fee awareness | No | Yes (fee-adjusted limits) |
| Best for | Simple splits, fast execution | Large swaps needing optimal execution |
| Gas cost | Lower (two passes) | Higher (iterative loop) |

## Notes
- Uses `slot0()` to read current sqrtPriceX96 on-chain (not just liquidity like AlphaSwap)
- The stepping loop naturally terminates when all pools drop below the limit or remaining = 0
- minStep (stepSize/100, minimum 1) prevents the loop from stalling when remaining is small
- Pool types match Solidity enum: UniV2=0, UniV3=1, UniV4=2
- Only supports Base chain currently (same pool discovery as AlphaSwap)
- Requires off-chain quoting via SauceRouter simulation -- needs a working sauceRouterAddress
- transferFrom at entry requires prior approval of tokenIn to the SauceRouter/executor
