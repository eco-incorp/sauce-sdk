import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";
import { IUniswapV3Pool } from "./artifacts/IUniswapV3Pool.json";

// priceLimitedPools (V3/V4): [poolType, poolAddress, fee, tickSpacing, hooks, 0 (unused), preSqrtPrice]
//   → execute with full remaining balance + globalPriceLimit (price limit caps fill naturally)
// noLimitPools (V2/Solidly): [poolType, poolAddress, fee, tickSpacing, hooks, splitAmount, preSqrtPrice]
//   → execute with pre-computed depth-proportional splits
// multiHopRoutes: [intermediateToken,
//   hop1PoolType, hop1Pool, hop1Fee, hop1TickSpacing, hop1Hooks,
//   hop2PoolType, hop2Pool, hop2Fee, hop2TickSpacing, hop2Hooks,
//   splitAmount, hop1PreSqrtPrice]

function main(
  tokenIn: Address, tokenOut: Address, amountIn: Uint256, caller: Address,
  priceLimitedPools: Tuple, noLimitPools: Tuple, multiHopRoutes: Tuple,
  globalPriceLimit: Uint256
): Uint256 {
  const router = ISauceRouter.at(address.self);
  const token = IERC20.at(tokenIn);

  token.transferFrom(caller, address.self, amountIn);

  // Sort tokens for PoolKey
  const token0: Address = tokenIn < tokenOut ? tokenIn : tokenOut;
  const token1: Address = tokenIn < tokenOut ? tokenOut : tokenIn;

  // ══════════════════════════════════════════════════════════════
  // Series 1a: V3/V4 pools — sequential, full remaining balance + price limit
  //
  // Each pool reads the current tokenIn balance and swaps with globalPriceLimit.
  // The price limit naturally caps how much each pool fills.
  // Deeper pools (sorted first by off-chain delta) absorb more volume.
  // Positive slippage is absorbed — no pre-split staleness issues.
  // ══════════════════════════════════════════════════════════════

  for (let i = 0; i < priceLimitedPools.length; i = i + 1) {
    const dp: Tuple = priceLimitedPools[i];

    // Read current tokenIn balance — this IS the swap amount (balanceOf auto-decodes).
    const currentBal: Uint256 = token.balanceOf(address.self);

    if (currentBal > 0) {
      router.swap({
        poolType: dp[0],
        pool: dp[1],
        poolKey: { currency0: token0, currency1: token1, fee: dp[2], tickSpacing: dp[3], hooks: dp[4] },
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        amountSpecified: currentBal,
        sqrtPriceLimitX96: globalPriceLimit,
        payer: address.self,
        recipient: address.self,
      });
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Series 1b: V2/Solidly pools — pre-computed depth-proportional splits
  //
  // These pools don't support price limits, so we use off-chain measured
  // depth to pre-compute proportional splits of the remaining budget.
  // ══════════════════════════════════════════════════════════════

  for (let i = 0; i < noLimitPools.length; i = i + 1) {
    const dp: Tuple = noLimitPools[i];
    const splitAmt: Uint256 = dp[5];

    if (splitAmt > 0) {
      router.swap({
        poolType: dp[0],
        pool: dp[1],
        poolKey: { currency0: token0, currency1: token1, fee: dp[2], tickSpacing: dp[3], hooks: dp[4] },
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        amountSpecified: splitAmt,
        sqrtPriceLimitX96: 0,
        payer: address.self,
        recipient: address.self,
      });
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Series 1c: Multi-hop routes — pre-computed splits, no price limit
  // ══════════════════════════════════════════════════════════════

  for (let j = 0; j < multiHopRoutes.length; j = j + 1) {
    const route: Tuple = multiHopRoutes[j];
    const splitAmt: Uint256 = route[11];

    if (splitAmt > 0) {
      const inter: Address = route[0];
      const inter0: Address = tokenIn < inter ? tokenIn : inter;
      const inter1: Address = tokenIn < inter ? inter : tokenIn;

      // Hop 1: tokenIn → intermediate
      router.swap({
        poolType: route[1],
        pool: route[2],
        poolKey: { currency0: inter0, currency1: inter1, fee: route[3], tickSpacing: route[4], hooks: route[5] },
        tokenIn: tokenIn,
        tokenOut: inter,
        amountSpecified: splitAmt,
        sqrtPriceLimitX96: 0,
        payer: address.self,
        recipient: address.self,
      });

      const interBal: Uint256 = IERC20.at(inter).balanceOf(address.self);
      if (interBal > 0) {
        IERC20.at(inter).approve(address.self, interBal);

        const out0: Address = inter < tokenOut ? inter : tokenOut;
        const out1: Address = inter < tokenOut ? tokenOut : inter;

        // Hop 2: intermediate → tokenOut
        router.swap({
          poolType: route[6],
          pool: route[7],
          poolKey: { currency0: out0, currency1: out1, fee: route[8], tickSpacing: route[9], hooks: route[10] },
          tokenIn: inter,
          tokenOut: tokenOut,
          amountSpecified: interBal,
          sqrtPriceLimitX96: 0,
          payer: address.self,
          recipient: address.self,
        });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Series 2: Sweep leftovers using series-1 slippage as depth signal.
  //
  // For V3 pools: read slot0 for post-swap price. The delta from pre-swap
  // price measures how much the pool moved — smaller delta = deeper pool.
  // Weight = SCALE / delta (inverse-delta). No liquidity() calls needed.
  //
  // V2 pools don't have slot0 — skip them in series 2.
  // Multi-hop routes use hop1 pool's slot0 delta for weighting.
  // ══════════════════════════════════════════════════════════════

  const remaining: Uint256 = token.balanceOf(address.self);

  if (remaining > 0) {
    const SCALE: Uint256 = 10 ** 18;

    // Pass 1: sum inverse-delta weights across V3 pools + multi-hop routes
    let totalWeight: Uint256 = 0;

    for (let i = 0; i < priceLimitedPools.length; i = i + 1) {
      const dp: Tuple = priceLimitedPools[i];
      // slot0 is multi-return — index inline.
      const postPrice: Uint256 = IUniswapV3Pool.at(dp[1]).slot0()[0];
      const prePrice: Uint256 = dp[6];
      const delta: Uint256 = prePrice > postPrice ? prePrice - postPrice : postPrice - prePrice;
      if (delta > 0) {
        totalWeight = totalWeight + SCALE / delta;
      }
    }

    for (let j = 0; j < multiHopRoutes.length; j = j + 1) {
      const route: Tuple = multiHopRoutes[j];
      const postPrice: Uint256 = IUniswapV3Pool.at(route[2]).slot0()[0];
      const prePrice: Uint256 = route[12];
      const delta: Uint256 = prePrice > postPrice ? prePrice - postPrice : postPrice - prePrice;
      if (delta > 0) {
        totalWeight = totalWeight + SCALE / delta;
      }
    }

    // Pass 2: allocate remaining proportionally to inverse-delta weights
    if (totalWeight > 0) {
      let allocated: Uint256 = 0;
      const totalEntries: Uint256 = priceLimitedPools.length + multiHopRoutes.length;

      for (let i = 0; i < priceLimitedPools.length; i = i + 1) {
        const dp: Tuple = priceLimitedPools[i];
        const postPrice: Uint256 = IUniswapV3Pool.at(dp[1]).slot0()[0];
        const prePrice: Uint256 = dp[6];
        const delta: Uint256 = prePrice > postPrice ? prePrice - postPrice : postPrice - prePrice;
        const weight: Uint256 = delta > 0 ? SCALE / delta : 0;
        const amt: Uint256 = Math.mulDiv(remaining, weight, totalWeight);
        allocated = allocated + amt;

        if (amt > 0) {
          router.swap({
            poolType: dp[0],
            pool: dp[1],
            poolKey: { currency0: token0, currency1: token1, fee: dp[2], tickSpacing: dp[3], hooks: dp[4] },
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountSpecified: amt,
            sqrtPriceLimitX96: 0,
            payer: address.self,
            recipient: address.self,
          });
        }
      }

      for (let j = 0; j < multiHopRoutes.length; j = j + 1) {
        const route: Tuple = multiHopRoutes[j];
        const inter: Address = route[0];
        const hop1Pool: Address = route[2];
        const hop2Pool: Address = route[7];

        const postPrice: Uint256 = IUniswapV3Pool.at(hop1Pool).slot0()[0];
        const prePrice: Uint256 = route[12];
        const delta: Uint256 = prePrice > postPrice ? prePrice - postPrice : postPrice - prePrice;
        const weight: Uint256 = delta > 0 ? SCALE / delta : 0;

        const isLast: Uint256 = (priceLimitedPools.length + j + 1 === totalEntries) ? 1 : 0;
        const amt: Uint256 = isLast === 1 ? remaining - allocated : Math.mulDiv(remaining, weight, totalWeight);
        allocated = allocated + amt;

        if (amt > 0) {
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
            payer: address.self,
            recipient: address.self,
          });

          const interBal: Uint256 = IERC20.at(inter).balanceOf(address.self);
          if (interBal > 0) {
            IERC20.at(inter).approve(address.self, interBal);

            const out0: Address = inter < tokenOut ? inter : tokenOut;
            const out1: Address = inter < tokenOut ? tokenOut : inter;

            router.swap({
              poolType: route[6],
              pool: hop2Pool,
              poolKey: { currency0: out0, currency1: out1, fee: route[8], tickSpacing: route[9], hooks: route[10] },
              tokenIn: inter,
              tokenOut: tokenOut,
              amountSpecified: interBal,
              sqrtPriceLimitX96: 0,
              payer: address.self,
              recipient: address.self,
            });
          }
        }
      }
    }
  }

  // Transfer all output tokens to caller
  const outToken = IERC20.at(tokenOut);
  const outBal: Uint256 = outToken.balanceOf(address.self);
  outToken.transfer(caller, outBal);
  return outBal;
}
