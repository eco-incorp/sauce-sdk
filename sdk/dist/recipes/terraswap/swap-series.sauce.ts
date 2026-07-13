import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";

// Single-series swap script — reusable across series 1, 2, and 3.
//
// priceLimitedPools (V3/V4): [poolType, poolAddress, fee, tickSpacing, hooks, splitAmount]
//   → Series 1: use full remaining balance + globalPriceLimit (splitAmount=0 ignored)
//   → Series 2+: use pre-computed split from depth weighting
// noLimitPools (V2/Solidly): [poolType, poolAddress, fee, tickSpacing, hooks, splitAmount]
//   → always use pre-computed depth-proportional splits
// multiHopRoutes: [intermediateToken,
//   hop1PoolType, hop1Pool, hop1Fee, hop1TickSpacing, hop1Hooks,
//   hop2PoolType, hop2Pool, hop2Fee, hop2TickSpacing, hop2Hooks, splitAmount]
// globalPriceLimit: sqrtPriceLimitX96 (0 = no limit, used for final sweep)
// isFirstSeries: 1 = V3 pools read balance (natural fill), 0 = V3 pools use splits

function main(
  tokenIn: Address, tokenOut: Address, amountIn: Uint256, caller: Address,
  priceLimitedPools: Tuple, noLimitPools: Tuple, multiHopRoutes: Tuple,
  globalPriceLimit: Uint256, isFirstSeries: Uint256
): Uint256 {
  const router = ISauceRouter.at(address.self);
  const token = IERC20.at(tokenIn);

  token.transferFrom(caller, address.self, amountIn);

  const token0: Address = tokenIn < tokenOut ? tokenIn : tokenOut;
  const token1: Address = tokenIn < tokenOut ? tokenOut : tokenIn;

  // ── V3/V4 pools ──
  // Series 1: sequential, full remaining balance + price limit (natural fill)
  // Series 2+: pre-computed depth-weighted splits
  for (let i = 0; i < priceLimitedPools.length; i = i + 1) {
    const dp: Tuple = priceLimitedPools[i];

    if (isFirstSeries === 1) {
      // Read current balance — price limit naturally caps fill (balanceOf auto-decodes).
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
    } else {
      const splitAmt: Uint256 = dp[5];
      if (splitAmt > 0) {
        router.swap({
          poolType: dp[0],
          pool: dp[1],
          poolKey: { currency0: token0, currency1: token1, fee: dp[2], tickSpacing: dp[3], hooks: dp[4] },
          tokenIn: tokenIn,
          tokenOut: tokenOut,
          amountSpecified: splitAmt,
          sqrtPriceLimitX96: globalPriceLimit,
          payer: address.self,
          recipient: address.self,
        });
      }
    }
  }

  // ── V2/Solidly pools — always use pre-computed splits ──
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

  // ── Multi-hop routes — always use pre-computed splits ──
  for (let j = 0; j < multiHopRoutes.length; j = j + 1) {
    const route: Tuple = multiHopRoutes[j];
    const splitAmt: Uint256 = route[11];

    if (splitAmt > 0) {
      const inter: Address = route[0];
      const inter0: Address = tokenIn < inter ? tokenIn : inter;
      const inter1: Address = tokenIn < inter ? inter : tokenIn;

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

  // Return leftover input tokens to caller
  const leftover: Uint256 = token.balanceOf(address.self);
  if (leftover > 0) {
    token.transfer(caller, leftover);
  }

  // Return all output tokens to caller
  const outToken = IERC20.at(tokenOut);
  const outBal: Uint256 = outToken.balanceOf(address.self);
  outToken.transfer(caller, outBal);
  return outBal;
}
