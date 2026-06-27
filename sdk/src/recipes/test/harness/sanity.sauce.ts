import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";

// Minimal Phase-1 sanity swap: ONE direct V3 swap through the router's flat
// swapV3 (positive amountSpecified = exact input). The recipe contract holds
// the input (payer = self) so the V3 callback uses transfer, and forwards all
// output back to the caller. Mirrors the core of ecoswap.sauce.ts but with no
// brackets/water-fill — just proves a locally-deployed V3 pool swaps.
function main(
  tokenIn: Address, tokenOut: Address, pool: Address,
  amountIn: Uint256, caller: Address, priceLimit: Uint256
): Uint256 {
  const router = ISauceRouter.at(address.self);
  const token = IERC20.at(tokenIn);

  token.transferFrom(caller, address.self, amountIn);

  router.swapV3(pool, tokenIn, tokenOut, amountIn, priceLimit, address.self, address.self);

  const outToken = IERC20.at(tokenOut);
  const outBal: Uint256 = outToken.balanceOf(address.self);
  outToken.transfer(caller, outBal);
  return outBal;
}
