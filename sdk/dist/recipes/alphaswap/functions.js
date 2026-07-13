export const alphaSwap = `
import { ISauceRouterABI as ISauceRouter } from "../shared/abis";
import { IERC20ABI as IERC20 } from "../shared/abis";
import { IUniswapV3PoolABI as IUniswapV3Pool } from "../shared/abis";

// directPools: Tuple of Tuples — each is [poolType, poolAddress, fee, tickSpacing, hooks]
// multiHopRoutes: Tuple of Tuples — each is [intermediateToken,
//   hop1PoolType, hop1Pool, hop1Fee, hop1TickSpacing, hop1Hooks,
//   hop2PoolType, hop2Pool, hop2Fee, hop2TickSpacing, hop2Hooks]

function main(
  tokenIn: Address, tokenOut: Address, amountIn: Uint256, caller: Address,
  directPools: Tuple, multiHopRoutes: Tuple
): Uint256 {
  const router: any = ISauceRouter.at(THIS_ADDRESS());
  const token: any = IERC20.at(tokenIn);

  token.transferFrom(caller, THIS_ADDRESS(), amountIn);

  // Sort tokens for PoolKey
  const token0: Address = tokenIn < tokenOut ? tokenIn : tokenOut;
  const token1: Address = tokenIn < tokenOut ? tokenOut : tokenIn;

  // Pass 1: Read liquidity and compute totalLiq
  let totalLiq: Uint256 = 0;

  for (let i: Uint256 = 0; i < directPools.length; i = i + 1) {
    const dp: Tuple = directPools[i];
    const liqData: Tuple = ABI_DECODE(IUniswapV3Pool.at(dp[1]).liquidity(), 1, 32);
    totalLiq = totalLiq + liqData[0];
  }

  for (let j: Uint256 = 0; j < multiHopRoutes.length; j = j + 1) {
    const route: Tuple = multiHopRoutes[j];
    const h1Data: Tuple = ABI_DECODE(IUniswapV3Pool.at(route[2]).liquidity(), 1, 32);
    const h2Data: Tuple = ABI_DECODE(IUniswapV3Pool.at(route[7]).liquidity(), 1, 32);
    const h1Liq: Uint256 = h1Data[0];
    const h2Liq: Uint256 = h2Data[0];
    totalLiq = totalLiq + (h1Liq < h2Liq ? h1Liq : h2Liq);
  }

  // Pass 2: Re-read liquidity, allocate proportionally, swap
  let allocated: Uint256 = 0;
  const totalEntries: Uint256 = directPools.length + multiHopRoutes.length;

  for (let i: Uint256 = 0; i < directPools.length; i = i + 1) {
    const dp: Tuple = directPools[i];
    const poolAddr: Address = dp[1];
    const liqData: Tuple = ABI_DECODE(IUniswapV3Pool.at(poolAddr).liquidity(), 1, 32);
    const amt: Uint256 = MUL_DIV(amountIn, liqData[0], totalLiq);
    allocated = allocated + amt;

    if (amt > 0) {
      router.swap({
        poolType: dp[0],
        pool: poolAddr,
        poolKey: { currency0: token0, currency1: token1, fee: dp[2], tickSpacing: dp[3], hooks: dp[4] },
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        amountSpecified: amt,
        sqrtPriceLimitX96: 0,
        payer: THIS_ADDRESS(),
        recipient: THIS_ADDRESS(),
      });
    }
  }

  for (let j: Uint256 = 0; j < multiHopRoutes.length; j = j + 1) {
    const route: Tuple = multiHopRoutes[j];
    const inter: Address = route[0];
    const hop1Pool: Address = route[2];
    const hop2Pool: Address = route[7];

    const h1Data: Tuple = ABI_DECODE(IUniswapV3Pool.at(hop1Pool).liquidity(), 1, 32);
    const h2Data: Tuple = ABI_DECODE(IUniswapV3Pool.at(hop2Pool).liquidity(), 1, 32);
    const h1Liq: Uint256 = h1Data[0];
    const h2Liq: Uint256 = h2Data[0];
    const effLiq: Uint256 = h1Liq < h2Liq ? h1Liq : h2Liq;

    const isLast: Uint256 = (directPools.length + j + 1 == totalEntries) ? 1 : 0;
    const amt: Uint256 = isLast == 1 ? amountIn - allocated : MUL_DIV(amountIn, effLiq, totalLiq);
    allocated = allocated + amt;

    if (amt > 0) {
      // Sort tokens for hop1 PoolKey
      const inter0: Address = tokenIn < inter ? tokenIn : inter;
      const inter1: Address = tokenIn < inter ? inter : tokenIn;

      router.swap({
        poolType: route[1],
        pool: hop1Pool,
        poolKey: { currency0: inter0, currency1: inter1, fee: route[3], tickSpacing: route[4], hooks: route[5] },
        tokenIn: tokenIn,
        tokenOut: inter,
        amountSpecified: amt,
        sqrtPriceLimitX96: 0,
        payer: THIS_ADDRESS(),
        recipient: THIS_ADDRESS(),
      });

      const interBal: Tuple = ABI_DECODE(IERC20.at(inter).balanceOf(THIS_ADDRESS()), 1, 32);
      if (interBal[0] > 0) {
        IERC20.at(inter).approve(THIS_ADDRESS(), interBal[0]);

        const out0: Address = inter < tokenOut ? inter : tokenOut;
        const out1: Address = inter < tokenOut ? tokenOut : inter;

        router.swap({
          poolType: route[6],
          pool: hop2Pool,
          poolKey: { currency0: out0, currency1: out1, fee: route[8], tickSpacing: route[9], hooks: route[10] },
          tokenIn: inter,
          tokenOut: tokenOut,
          amountSpecified: interBal[0],
          sqrtPriceLimitX96: 0,
          payer: THIS_ADDRESS(),
          recipient: THIS_ADDRESS(),
        });
      }
    }
  }

  const outToken: any = IERC20.at(tokenOut);
  const outBal: Tuple = ABI_DECODE(outToken.balanceOf(THIS_ADDRESS()), 1, 32);
  outToken.transfer(caller, outBal[0]);
  return outBal[0];
}
`;
//# sourceMappingURL=functions.js.map