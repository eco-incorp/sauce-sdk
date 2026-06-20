import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";
import { IUniswapV3Pool } from "./artifacts/IUniswapV3Pool.json";

// pools: Tuple of Tuples — each pool is [poolType, poolAddress, fee, tickSpacing, hooks]
// Adaptive price-stepping loop: gradually lowers sqrtPriceLimitX96 so deep pools
// swap more and shallow/high-fee pools contribute less.

function main(
  tokenIn: Address, tokenOut: Address, amountIn: Uint256, caller: Address,
  pools: Tuple, stepSize: Uint256
): Uint256 {
  const router = ISauceRouter.at(address.self);
  const token = IERC20.at(tokenIn);

  token.transferFrom(caller, address.self, amountIn);

  // Sort tokens for PoolKey (currency0 < currency1)
  const token0: Address = tokenIn < tokenOut ? tokenIn : tokenOut;
  const token1: Address = tokenIn < tokenOut ? tokenOut : tokenIn;

  // ── Phase 1: Read prices from all pools, find highest (best rate) ──
  let priceLimit: Uint256 = 0;
  for (let i = 0; i < pools.length; i = i + 1) {
    const dp: Tuple = pools[i];
    // Multi-return calls (slot0) must be indexed INLINE — a stored tuple isn't re-indexable.
    const price: Uint256 = IUniswapV3Pool.at(dp[1]).slot0()[0];
    if (price > priceLimit) {
      priceLimit = price;
    }
  }

  // ── Phase 2: Adaptive price-stepping loop ──
  // minStep = stepSize / 100 — prevents stalling when remaining is small
  let minStep: Uint256 = stepSize / 100;
  if (minStep === 0) {
    minStep = 1;
  }

  let remaining: Uint256 = amountIn;

  while (remaining > 0) {
    // Proportional step: shrinks as remaining shrinks
    const step: Uint256 = Math.mulDiv(stepSize, remaining, amountIn) + minStep;
    priceLimit = priceLimit - step;

    for (let i = 0; i < pools.length; i = i + 1) {
      const pool: Tuple = pools[i];

      // Re-read current price (may have moved from prior swaps); index slot0 inline.
      const currentPrice: Uint256 = IUniswapV3Pool.at(pool[1]).slot0()[0];

      // Fee-adjusted limit: high-fee pools need BETTER price to qualify
      // adjustedLimit = priceLimit * (1_000_000 + fee/2) / 1_000_000
      const halfFee: Uint256 = pool[2] / 2;
      const adjustedLimit: Uint256 = Math.mulDiv(priceLimit, 1000000 + halfFee, 1000000);

      // Only swap if pool price is above the fee-adjusted limit and tokens remain
      if (remaining > 0 && currentPrice >= adjustedLimit) {
        router.swap({
          poolType: pool[0],
          pool: pool[1],
          poolKey: {
            currency0: token0,
            currency1: token1,
            fee: pool[2],
            tickSpacing: pool[3],
            hooks: pool[4],
          },
          tokenIn: tokenIn,
          tokenOut: tokenOut,
          amountSpecified: remaining,
          sqrtPriceLimitX96: adjustedLimit,
          payer: address.self,
          recipient: address.self,
        });

        // Update remaining from actual balance (balanceOf auto-decodes to a scalar)
        remaining = token.balanceOf(address.self);
      }
    }

    // Re-read remaining after full pool sweep
    remaining = token.balanceOf(address.self);
  }

  // Transfer all output tokens to caller
  const outToken = IERC20.at(tokenOut);
  const outBal: Uint256 = outToken.balanceOf(address.self);
  outToken.transfer(caller, outBal);
  return outBal;
}
