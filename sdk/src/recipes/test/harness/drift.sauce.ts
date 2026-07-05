import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";

// Price-mover for the prod-mirror DRIFT tests. Pulls `amountIn` from the caller
// and does exactly ONE swap on the given pool (zeroForOne), then forwards the
// output back. Used to move a pool's LIVE price AFTER prepare() has snapshotted
// state but BEFORE the real recipe executes — so the recipe's Phase B runtime
// re-anchoring (live-price read) is exercised against genuine drift.
//
// It routes through the SAME engine paths the recipe uses, so all callbacks are
// handled: V3 via flat swapV3 (positive amountSpecified = exact input); V2 + V4
// via the unified swap(SwapParams) (negative amountSpecified = exact input).
//
//   pool = [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0,
//           stateView, poolId]   (same 10-field tuple as ecoswap.sauce.ts pools[i])
//   infVault = the chain's PancakeSwap Infinity Vault (used ONLY for pType 9 —
//              swapInfinityCL(vault, key, …); 0 for every other family).
function main(
  tokenIn: Address, tokenOut: Address, amountIn: Uint256, caller: Address,
  zeroForOne: Uint256, priceLimit: Uint256, pool: Tuple, infVault: Address
): Uint256 {
  const router = ISauceRouter.at(address.self);
  const token = IERC20.at(tokenIn);

  token.transferFrom(caller, address.self, amountIn);

  const pType: Uint256 = pool[0];
  const isV2: Uint256 = pool[6];

  if (isV2 === 1) {
    const c0: Address = zeroForOne === 1 ? tokenIn : tokenOut;
    const c1: Address = zeroForOne === 1 ? tokenOut : tokenIn;
    router.swap({
      poolType: 0,
      pool: pool[1],
      poolKey: { currency0: c0, currency1: c1, fee: 0, tickSpacing: 0, hooks: 0 },
      tokenIn: tokenIn,
      tokenOut: tokenOut,
      amountSpecified: Math.neg(amountIn),
      sqrtPriceLimitX96: 0,
      payer: address.self,
      recipient: address.self,
    });
  } else {
    if (pType === 9) {
      // PancakeSwap Infinity CL — the flat entrypoint (Vault lock serviced by the engine's
      // lockAcquired). Hookless key reconstructed from the tuple (parameters = ts<<16).
      const ik0: Address = zeroForOne === 1 ? tokenIn : tokenOut;
      const ik1: Address = zeroForOne === 1 ? tokenOut : tokenIn;
      router.swapInfinityCL(
        infVault,
        { currency0: ik0, currency1: ik1, hooks: pool[4], poolManager: pool[1], fee: pool[2], parameters: pool[3] * 65536 },
        zeroForOne, Math.neg(amountIn), 0, address.self, address.self
      );
    } else if (pType === 2) {
      const k0: Address = zeroForOne === 1 ? tokenIn : tokenOut;
      const k1: Address = zeroForOne === 1 ? tokenOut : tokenIn;
      router.swap({
        poolType: 2,
        pool: pool[1],
        poolKey: { currency0: k0, currency1: k1, fee: pool[2], tickSpacing: pool[3], hooks: pool[4] },
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        amountSpecified: Math.neg(amountIn),
        sqrtPriceLimitX96: 0,
        payer: address.self,
        recipient: address.self,
      });
    } else {
      router.swapV3(pool[1], tokenIn, tokenOut, amountIn, priceLimit, address.self, address.self);
    }
  }

  const outToken = IERC20.at(tokenOut);
  const outBal: Uint256 = outToken.balanceOf(address.self);
  outToken.transfer(caller, outBal);
  return outBal;
}
