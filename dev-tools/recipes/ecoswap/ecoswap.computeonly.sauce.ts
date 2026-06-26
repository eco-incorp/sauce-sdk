import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";
import { IUniswapV3Pool } from "./artifacts/IUniswapV3Pool.json";
import { IStateView } from "./artifacts/IStateView.json";
import { IUniswapV2Pair } from "./IUniswapV2Pair.json";

// EcoSwap solver — TWO-PASS, COMPUTE-ONLY decomposition variant (GAS DECOMP only).
//
// This is `ecoswap.sauce.ts` (the real two-pass Phase A + Phase B solver) with the
// EXECUTION stripped out: no transferFrom, no router.swap*/swapV3, no final
// token.transfer. It keeps the FULL water-fill ARITHMETIC verbatim — Phase A's
// pre-sorted bracket sweep that finds the common fee-adjusted marginal cut, and
// Phase B's per-pool LIVE-price reads (slot0 / getReserves / StateView) +
// integrate-to-cut. Instead of swapping, each pool's computed `poolInput` and each
// route's `routeInput` is folded into a running sum so the arithmetic is NOT
// dead-code-eliminated, and that sum is returned.
//
// Purpose: solver-arithmetic gas ≈ this variant's cook gas; swap gas ≈ full − this.
// NOT a real recipe — DO NOT ship. Same 9-param main signature + args as the full
// solvers so the same compiler args drive it.
//
// Inputs (precomputed off-chain in prepare.ts):
//   pools[i]    = [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0, stateView, poolId]
//   routes[r]   = [inter, h1Type,h1Pool,h1Fee,h1TS,h1Hooks, h2Type,h2Pool,h2Fee,h2TS,h2Hooks]
//   brackets[b] = [kind, refIdx, sqrtNear, sqrtFar, liquidity, capacity, sqrtAdjNear, sqrtAdjFar]

function main(
  tokenIn: Address, tokenOut: Address, amountIn: Uint256, caller: Address,
  zeroForOne: Uint256, priceLimit: Uint256,
  pools: Tuple, routes: Tuple, brackets: Tuple
): Uint256 {
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
          const an: Uint256 = b[6];
          const af: Uint256 = b[7];
          if (an > af) {
            cutSqrtAdj = an - Math.mulDiv(an - af, need, cap);
          } else {
            cutSqrtAdj = an;
          }
        } else {
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

  let budget: Uint256 = amountIn;
  // Running accumulator of the computed split (replaces the swaps). Returned so the
  // whole water-fill arithmetic stays live (not dead-code-eliminated).
  let totalAssigned: Uint256 = 0;

  // ── Phase B (direct pools): integrate live price -> cut ──
  for (let p = 0; p < pools.length; p = p + 1) {
    if (budget > 0) {
      const dp: Tuple = pools[p];
      const feePpm: Uint256 = dp[5];
      const isV2: Uint256 = dp[6];
      const pType: Uint256 = dp[0];

      let curSqrt: Uint256 = 0;
      let liveL: Uint256 = 0;
      if (isV2 === 1) {
        const r0: Uint256 = IUniswapV2Pair.at(dp[1]).getReserves()[0];
        const r1: Uint256 = IUniswapV2Pair.at(dp[1]).getReserves()[1];
        const inIsToken0: Uint256 = dp[7];
        const reserveIn: Uint256 = inIsToken0 === 1 ? r0 : r1;
        const reserveOut: Uint256 = inIsToken0 === 1 ? r1 : r0;
        liveL = Math.sqrt(reserveIn * reserveOut);
        curSqrt = Math.sqrt(Math.mulDiv(reserveOut, Q192, reserveIn));
      } else {
        if (pType === 2) {
          const sqrtRealV4: Uint256 = IStateView.at(dp[8]).getSlot0(dp[9])[0];
          curSqrt = zeroForOne === 1 ? sqrtRealV4 : Q192 / sqrtRealV4;
        } else {
          const sqrtReal: Uint256 = IUniswapV3Pool.at(dp[1]).slot0()[0];
          curSqrt = zeroForOne === 1 ? sqrtReal : Q192 / sqrtReal;
        }
      }

      const sf: Uint256 = Math.sqrt((FEE_DENOM - feePpm) * FEE_DENOM);
      const targetSpot: Uint256 = sf > 0 ? Math.mulDiv(cutSqrtAdj, FEE_DENOM, sf) : 0;

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
        // (real solver swaps here) — compute-only: fold into the running sum.
        totalAssigned = totalAssigned + poolInput;
        budget = budget - poolInput;
      }
    }
  }

  // ── Phase B (routes): whole segments above the cut ──
  for (let r = 0; r < routes.length; r = r + 1) {
    if (budget > 0) {
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
        // (real solver swaps hop1 -> hop2 here) — compute-only: fold into the sum.
        totalAssigned = totalAssigned + routeInput;
        budget = budget - routeInput;
      }
    }
  }

  // Return a cheap summary of the computed split so the arithmetic is live.
  return totalAssigned;
}
