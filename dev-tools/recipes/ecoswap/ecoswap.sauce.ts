import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";
import { IUniswapV3Pool } from "./artifacts/IUniswapV3Pool.json";
import { IUniswapV2Pair } from "./IUniswapV2Pair.json";

// EcoSwap on-chain solver.
//
// Inputs (all pool data precomputed off-chain in prepare.ts):
//   pools[i]    = [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0]
//   routes[r]   = [inter, h1Type,h1Pool,h1Fee,h1TS,h1Hooks, h2Type,h2Pool,h2Fee,h2TS,h2Hooks]
//   brackets[b] = [kind, refIdx, sqrtNear, sqrtFar, liquidity, capacity, sqrtAdjNear, sqrtAdjFar]
//                 kind: 0=V3 direct, 1=V2 direct, 2=route ; sorted DESC by sqrtAdjNear.
//
// Algorithm:
//   Phase A — walk the pre-sorted bracket ladder, summing precomputed capacity
//     until amountIn is reached, to find the common fee-adjusted marginal-price
//     cut `cutSqrtAdj` (the water-fill level where every pool's post-fee marginal
//     price is equal).
//   Phase B — for each direct pool, re-read its LIVE price, integrate the exact
//     input needed to walk from the live price down to the cut (using its
//     brackets' liquidity), and do ONE swap. Routes allocate whole segments above
//     the cut (static capacities) and swap hop1 -> hop2.
//
// All sqrt values are unified "out/in" Q96; the single bracket formula is
//   effIn = L * 2^96 * (1/sqrtFar - 1/sqrtNear);  grossIn = effIn / (1 - fee).

function main(
  tokenIn: Address, tokenOut: Address, amountIn: Uint256, caller: Address,
  zeroForOne: Uint256, priceLimit: Uint256,
  pools: Tuple, routes: Tuple, brackets: Tuple
): Uint256 {
  const router = ISauceRouter.at(address.self);
  const token = IERC20.at(tokenIn);

  token.transferFrom(caller, address.self, amountIn);

  const Q96: Uint256 = 2 ** 96;
  const Q192: Uint256 = 2 ** 192;
  const FEE_DENOM: Uint256 = 1000000;

  // ── Phase A: find the common marginal-price cut ──────────────
  let cum: Uint256 = 0;
  let cutSqrtAdj: Uint256 = 0;
  let found: Uint256 = 0;

  for (let i = 0; i < brackets.length; i = i + 1) {
    if (found === 0) {
      const b: Tuple = brackets[i];
      const cap: Uint256 = b[5];

      if (cum + cap >= amountIn) {
        const need: Uint256 = amountIn - cum;

        if (b[0] === 2) {
          // Route segment: linear interpolation in fee-adjusted sqrt space.
          const an: Uint256 = b[6];
          const af: Uint256 = b[7];
          if (an > af) {
            cutSqrtAdj = an - Math.mulDiv(an - af, need, cap);
          } else {
            cutSqrtAdj = an;
          }
        } else {
          // Direct bracket: solve the spot price where partial input === need,
          // then fee-adjust. need_eff = need * (1 - fee).
          const dp: Tuple = pools[b[1]];
          const feePpm: Uint256 = dp[5];
          const L: Uint256 = b[4];
          const needEff: Uint256 = Math.mulDiv(need, FEE_DENOM - feePpm, FEE_DENOM);
          const termNear: Uint256 = Math.mulDiv(L, Q96, b[2]);
          const termS: Uint256 = termNear + needEff;
          const cutSpot: Uint256 = Math.mulDiv(L, Q96, termS);
          const sf: Uint256 = Math.sqrt((FEE_DENOM - feePpm) * FEE_DENOM);
          cutSqrtAdj = Math.mulDiv(cutSpot, sf, FEE_DENOM);
        }
        found = 1;
      }
      cum = cum + cap;
    }
  }
  // found === 0 → amountIn exceeds all liquidity → cutSqrtAdj stays 0 (fill all).

  let budget: Uint256 = amountIn;

  // ── Phase B (direct pools): integrate live price -> cut, one swap ──
  for (let p = 0; p < pools.length; p = p + 1) {
    if (budget > 0) {
      const dp: Tuple = pools[p];
      const feePpm: Uint256 = dp[5];
      const isV2: Uint256 = dp[6];

      // Live current out/in sqrt price + (for V2) live liquidity.
      let curSqrt: Uint256 = 0;
      let liveL: Uint256 = 0;
      if (isV2 === 1) {
        // Multi-return contract calls must be indexed INLINE (a stored tuple isn't
        // re-indexable), so getReserves is called per field.
        const r0: Uint256 = IUniswapV2Pair.at(dp[1]).getReserves()[0];
        const r1: Uint256 = IUniswapV2Pair.at(dp[1]).getReserves()[1];
        const inIsToken0: Uint256 = dp[7];
        const reserveIn: Uint256 = inIsToken0 === 1 ? r0 : r1;
        const reserveOut: Uint256 = inIsToken0 === 1 ? r1 : r0;
        liveL = Math.sqrt(reserveIn * reserveOut);
        curSqrt = Math.sqrt(Math.mulDiv(reserveOut, Q192, reserveIn));
      } else {
        const sqrtReal: Uint256 = IUniswapV3Pool.at(dp[1]).slot0()[0];
        curSqrt = zeroForOne === 1 ? sqrtReal : Q192 / sqrtReal;
      }

      // Per-pool target spot price where its marginal === cut: target = cut / sqrt(1-fee).
      const sf: Uint256 = Math.sqrt((FEE_DENOM - feePpm) * FEE_DENOM);
      const targetSpot: Uint256 = sf > 0 ? Math.mulDiv(cutSqrtAdj, FEE_DENOM, sf) : 0;

      // Integrate this pool's brackets from live price down to target.
      let poolInput: Uint256 = 0;
      for (let bi = 0; bi < brackets.length; bi = bi + 1) {
        const b: Tuple = brackets[bi];
        if (b[0] !== 2 && b[1] === p) {
          const near: Uint256 = b[2];
          const far: Uint256 = b[3];
          const Lb: Uint256 = isV2 === 1 ? liveL : b[4];
          const hi: Uint256 = curSqrt < near ? curSqrt : near;
          const lo: Uint256 = targetSpot > far ? targetSpot : far;
          if (hi > lo && Lb > 0 && lo > 0) {
            const effIn: Uint256 = Math.mulDiv(Lb, Q96, lo) - Math.mulDiv(Lb, Q96, hi);
            if (effIn > 0) {
              poolInput = poolInput + Math.mulDiv(effIn, FEE_DENOM, FEE_DENOM - feePpm);
            }
          }
        }
      }

      if (poolInput > budget) {
        poolInput = budget;
      }

      if (poolInput > 0) {
        // Flat legacy swapV3 (the struct swap() self-call mis-encodes its nested
        // PoolKey). Positive amountSpecified = exact input. Router holds the tokens
        // (payer = self), output accrues to self and is forwarded at the end.
        router.swapV3(dp[1], tokenIn, tokenOut, poolInput, priceLimit, address.self, address.self);
        budget = budget - poolInput;
      }
    }
  }

  // ── Phase B (routes): whole segments above the cut, hop1 -> hop2 ──
  for (let r = 0; r < routes.length; r = r + 1) {
    if (budget > 0) {
      const route: Tuple = routes[r];

      let routeInput: Uint256 = 0;
      for (let bi = 0; bi < brackets.length; bi = bi + 1) {
        const b: Tuple = brackets[bi];
        if (b[0] === 2 && b[1] === r) {
          if (b[7] >= cutSqrtAdj) {
            routeInput = routeInput + b[5];
          }
        }
      }

      if (routeInput > budget) {
        routeInput = budget;
      }

      if (routeInput > 0) {
        // Flat swapV3 per hop (positive = exact input; payer = self holds the
        // tokens so the callback uses transfer, no approval needed). Assumes V3
        // hop pools. limit 0 → router picks the extreme bound for the direction.
        const inter: Address = route[0];
        router.swapV3(route[2], tokenIn, inter, routeInput, 0, address.self, address.self);

        const interBal: Uint256 = IERC20.at(inter).balanceOf(address.self);
        if (interBal > 0) {
          router.swapV3(route[7], inter, tokenOut, interBal, 0, address.self, address.self);
        }
        budget = budget - routeInput;
      }
    }
  }

  // Refund any unspent tokenIn (drift / liquidity ran out).
  const leftover: Uint256 = token.balanceOf(address.self);
  if (leftover > 0) {
    token.transfer(caller, leftover);
  }

  // Send all tokenOut to caller.
  const outToken = IERC20.at(tokenOut);
  const outBal: Uint256 = outToken.balanceOf(address.self);
  outToken.transfer(caller, outBal);
  return outBal;
}
