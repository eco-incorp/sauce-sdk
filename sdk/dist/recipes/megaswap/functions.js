export const megaSwap = `
import { ISauceRouterABI as ISauceRouter } from "../shared/abis";
import { IERC20ABI as IERC20 } from "../shared/abis";
import { IUniswapV3PoolABI as IUniswapV3Pool } from "../shared/abis";

// pools: Tuple of Tuples — each pool is [poolType, poolAddress, fee, tickSpacing, hooks]
// Adaptive price-stepping loop: gradually lowers sqrtPriceLimitX96 so deep pools
// swap more and shallow/high-fee pools contribute less.

function main(
  tokenIn: Address, tokenOut: Address, amountIn: Uint256, caller: Address,
  pools: Tuple, stepSize: Uint256
): Uint256 {
  const router: any = ISauceRouter.at(THIS_ADDRESS());
  const token: any = IERC20.at(tokenIn);

  token.transferFrom(caller, THIS_ADDRESS(), amountIn);

  // Sort tokens for PoolKey (currency0 < currency1)
  const token0: Address = tokenIn < tokenOut ? tokenIn : tokenOut;
  const token1: Address = tokenIn < tokenOut ? tokenOut : tokenIn;

  // Phase 1: Read prices from all pools, find highest (best rate)
  let priceLimit: Uint256 = 0;
  for (let i: Uint256 = 0; i < pools.length; i = i + 1) {
    const dp: Tuple = pools[i];
    const slot0Data: Tuple = ABI_DECODE(IUniswapV3Pool.at(dp[1]).slot0(), 1, 32);
    const price: Uint256 = slot0Data[0];
    if (price > priceLimit) {
      priceLimit = price;
    }
  }

  // Phase 2: Adaptive price-stepping loop
  let minStep: Uint256 = stepSize / 100;
  if (minStep == 0) {
    minStep = 1;
  }

  let remaining: Uint256 = amountIn;

  while (remaining > 0) {
    const step: Uint256 = MUL_DIV(stepSize, remaining, amountIn) + minStep;
    priceLimit = priceLimit - step;

    for (let i: Uint256 = 0; i < pools.length; i = i + 1) {
      const pool: Tuple = pools[i];

      const slot0Data: Tuple = ABI_DECODE(IUniswapV3Pool.at(pool[1]).slot0(), 1, 32);
      const currentPrice: Uint256 = slot0Data[0];

      const halfFee: Uint256 = pool[2] / 2;
      const adjustedLimit: Uint256 = MUL_DIV(priceLimit, 1000000 + halfFee, 1000000);

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

        const balData: Tuple = ABI_DECODE(token.balanceOf(THIS_ADDRESS()), 1, 32);
        remaining = balData[0];
      }
    }

    const endBal: Tuple = ABI_DECODE(token.balanceOf(THIS_ADDRESS()), 1, 32);
    remaining = endBal[0];
  }

  const outToken: any = IERC20.at(tokenOut);
  const outBal: Tuple = ABI_DECODE(outToken.balanceOf(THIS_ADDRESS()), 1, 32);
  outToken.transfer(caller, outBal[0]);
  return outBal[0];
}
`;
//# sourceMappingURL=functions.js.map