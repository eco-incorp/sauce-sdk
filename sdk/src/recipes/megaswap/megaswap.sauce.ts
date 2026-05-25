import { ISauceRouter } from "./engine/out/ISauceRouter.sol/ISauceRouter.json";
import { IERC20 } from "./engine/out/IERC20.sol/IERC20.json";
import { IUniswapV3Pool } from "./engine/out/IUniswapV3Pool.sol/IUniswapV3Pool.json";

// pools: Tuple of Tuples — each pool is [poolType, poolAddress, fee, tickSpacing, hooks]
// Adaptive price-stepping loop: gradually lowers sqrtPriceLimitX96 so deep pools
// swap more and shallow/high-fee pools contribute less.

function main(
  tokenIn: Address, tokenOut: Address, amountIn: Uint256, caller: Address,
  pools: Tuple, stepSize: Uint256
): Uint256 {
  const router = ISauceRouter.at(THIS_ADDRESS());
  const token = IERC20.at(tokenIn);

  token.transferFrom(caller, THIS_ADDRESS(), amountIn);

  // Sort tokens for PoolKey (currency0 < currency1)
  const token0: Address = tokenIn < tokenOut ? tokenIn : tokenOut;
  const token1: Address = tokenIn < tokenOut ? tokenOut : tokenIn;

  // ── Phase 1: Read prices from all pools, find highest (best rate) ──
  let priceLimit: Uint256 = 0;
  for (let i = 0; i < pools.length; i = i + 1) {
    const dp: Tuple = pools[i];
    const slot0Data: Tuple = ABI_DECODE(IUniswapV3Pool.at(dp[1]).slot0(), 1, 32);
    const price: Uint256 = slot0Data[0];
    if (price > priceLimit) {
      priceLimit = price;
    }
  }

  // ── Phase 2: Adaptive price-stepping loop ──
  // minStep = stepSize / 100 — prevents stalling when remaining is small
  let minStep: Uint256 = stepSize / 100;
  if (minStep == 0) {
    minStep = 1;
  }

  let remaining: Uint256 = amountIn;

  while (remaining > 0) {
    // Proportional step: shrinks as remaining shrinks
    const step: Uint256 = MUL_DIV(stepSize, remaining, amountIn) + minStep;
    priceLimit = priceLimit - step;

    for (let i = 0; i < pools.length; i = i + 1) {
      const pool: Tuple = pools[i];

      // Re-read current price (may have moved from prior swaps)
      const slot0Data: Tuple = ABI_DECODE(IUniswapV3Pool.at(pool[1]).slot0(), 1, 32);
      const currentPrice: Uint256 = slot0Data[0];

      // Fee-adjusted limit: high-fee pools need BETTER price to qualify
      // adjustedLimit = priceLimit * (1_000_000 + fee/2) / 1_000_000
      const halfFee: Uint256 = pool[2] / 2;
      const adjustedLimit: Uint256 = MUL_DIV(priceLimit, 1000000 + halfFee, 1000000);

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
          payer: THIS_ADDRESS(),
          recipient: THIS_ADDRESS(),
        });

        // Update remaining from actual balance
        const balData: Tuple = ABI_DECODE(token.balanceOf(THIS_ADDRESS()), 1, 32);
        remaining = balData[0];
      }
    }

    // Re-read remaining after full pool sweep
    const endBal: Tuple = ABI_DECODE(token.balanceOf(THIS_ADDRESS()), 1, 32);
    remaining = endBal[0];
  }

  // Transfer all output tokens to caller
  const outToken = IERC20.at(tokenOut);
  const outBal: Tuple = ABI_DECODE(outToken.balanceOf(THIS_ADDRESS()), 1, 32);
  outToken.transfer(caller, outBal[0]);
  return outBal[0];
}
