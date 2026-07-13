import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";
import { IUniswapV3PoolFull } from "./IUniswapV3PoolFull.json";
import { IStateViewFull } from "./IStateViewFull.json";
import { IUniswapV2Pair } from "./IUniswapV2Pair.json";

// EcoSwap solver — SINGLE-PASS (array), COMPUTE-ONLY decomposition variant (GAS DECOMP).
//
// This is `ecoswap.sauce.ts` (the array-mutation single-pass live-cut solver) with
// the EXECUTION stripped out: no transferFrom, no router.swap*/swapV3,
// no final token.transfer. It keeps the FULL water-fill ARITHMETIC verbatim — the
// per-pool/route mutable accumulator arrays (new Array(n) → NEW_ARRAY; inp[pidx]=…
// → SET_INDEX; reads → INDEX), the LIVE-price reads (slot0/getReserves/StateView)
// cached in curArr[]/lArr[], the single sorted-bracket sweep, AND the adaptive
// streaming tick walk. Instead of swapping, a final read loop sums inp[]/rinp[]
// (INDEX reads) into a running total that is returned, so neither the array writes
// nor the dynamic-data ops are dead-code-eliminated.
//
// Purpose: solver-arithmetic gas ≈ this variant's cook gas; swap gas ≈ full − this
// (the full solver being ecoswap.sauce.ts) across {v1, v12} — isolating how much of
// the cook gas is water-fill arithmetic vs the per-pool swaps.
// NOT a real recipe — DO NOT ship. Same 9-param main signature + args.

function tickArg(shifted: Uint256, OFFSET: Uint256): Uint256 {
  if (shifted >= OFFSET) {
    return shifted - OFFSET;
  }
  return Math.neg(OFFSET - shifted);
}

function toOutIn(sqrtReal: Uint256, zeroForOne: Uint256): Uint256 {
  if (zeroForOne === 1) {
    return sqrtReal;
  }
  const Q192: Uint256 = 2 ** 192;
  return Q192 / sqrtReal;
}

function stepReal(sqrtReal: Uint256, stepRatio: Uint256, zeroForOne: Uint256): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  if (zeroForOne === 1) {
    return Math.mulDiv(sqrtReal, Q96, stepRatio);
  }
  return Math.mulDiv(sqrtReal, stepRatio, Q96);
}

function main(
  tokenIn: Address, tokenOut: Address, amountIn: Uint256, caller: Address,
  zeroForOne: Uint256, priceLimit: Uint256,
  pools: Tuple, routes: Tuple, brackets: Tuple
): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  const Q192: Uint256 = 2 ** 192;
  const FEE_DENOM: Uint256 = 1000000;
  const OFFSET: Uint256 = 888000;
  const HALF128: Uint256 = 2 ** 127;
  const MOD128: Uint256 = 2 ** 128;

  // Per-pool input accumulators, live out/in-sqrt cache (0 = unseen) and V2 live-L
  // cache, sized to the pool count; per-route input accumulators sized to routes.
  let inp: Tuple = new Array(pools.length);
  let curArr: Tuple = new Array(pools.length);
  let lArr: Tuple = new Array(pools.length);
  let rinp: Tuple = new Array(routes.length);

  let cum: Uint256 = 0;
  let found: Uint256 = 0;

  // ── SINGLE SWEEP: accumulate live gross input per pool/route to the cut ──
  for (let bi = 0; bi < brackets.length; bi = bi + 1) {
    if (found === 0) {
      const b: Tuple = brackets[bi];
      const kind: Uint256 = b[0];

      if (kind === 2) {
        const rdx: Uint256 = b[1];
        const cap: Uint256 = b[5];
        let take: Uint256 = cap;
        if (cum + cap >= amountIn) {
          take = amountIn - cum;
          found = 1;
        }
        rinp[rdx] = rinp[rdx] + take;
        cum = cum + take;
      } else {
        const pidx: Uint256 = b[1];
        const near: Uint256 = b[2];
        const far: Uint256 = b[3];
        const Lstat: Uint256 = b[4];
        const dp: Tuple = pools[pidx];
        const feePpm: Uint256 = dp[5];
        const isV2: Uint256 = dp[6];
        const pType: Uint256 = dp[0];

        let cur: Uint256 = curArr[pidx];
        let Lliv: Uint256 = lArr[pidx];

        if (cur === 0) {
          let cl: Uint256 = 0;
          let ll: Uint256 = 0;
          if (isV2 === 1) {
            const r0: Uint256 = IUniswapV2Pair.at(dp[1]).getReserves()[0];
            const r1: Uint256 = IUniswapV2Pair.at(dp[1]).getReserves()[1];
            const inIsToken0: Uint256 = dp[7];
            const reserveIn: Uint256 = inIsToken0 === 1 ? r0 : r1;
            const reserveOut: Uint256 = inIsToken0 === 1 ? r1 : r0;
            ll = Math.sqrt(reserveIn * reserveOut);
            cl = Math.sqrt(Math.mulDiv(reserveOut, Q192, reserveIn));
          } else {
            if (pType === 2) {
              const sr4: Uint256 = IStateViewFull.at(dp[8]).getSlot0(dp[9])[0];
              cl = zeroForOne === 1 ? sr4 : Q192 / sr4;
            } else {
              const sr: Uint256 = IUniswapV3PoolFull.at(dp[1]).slot0()[0];
              cl = zeroForOne === 1 ? sr : Q192 / sr;
            }
          }
          cur = cl;
          Lliv = ll;
          curArr[pidx] = cl;
          lArr[pidx] = ll;
        }

        const Lb: Uint256 = isV2 === 1 ? Lliv : Lstat;
        const hi: Uint256 = cur < near ? cur : near;
        if (hi > far) {
          if (Lb > 0) {
            if (far > 0) {
              const effIn: Uint256 = Math.mulDiv(Lb, Q96, far) - Math.mulDiv(Lb, Q96, hi);
              if (effIn > 0) {
                const capGross: Uint256 = Math.mulDiv(effIn, FEE_DENOM, FEE_DENOM - feePpm);
                let take: Uint256 = capGross;
                if (cum + capGross >= amountIn) {
                  take = amountIn - cum;
                  found = 1;
                }
                inp[pidx] = inp[pidx] + take;
                cum = cum + take;
              }
            }
          }
        }
      }
    }
  }

  // ── ADAPTIVE STREAMING TICK WALK (WS4): continue past the prepared window ──
  const EXTRA_TICKS: Uint256 = 64;
  if (cum < amountIn) {
    for (let ap = 0; ap < pools.length; ap = ap + 1) {
      if (cum < amountIn) {
        const ad: Tuple = pools[ap];
        const aStartShift: Uint256 = ad[10];
        const aType: Uint256 = ad[0];
        const aIsV2: Uint256 = ad[6];
        if (aIsV2 === 0) {
          if (aStartShift > 0) {
            const aFeePpm: Uint256 = ad[5];
            const aTs: Uint256 = ad[3];
            const aStep: Uint256 = ad[13];
            const aStateView: Address = ad[8];
            const aPoolId: Uint256 = ad[9];
            const aAddr: Address = ad[1];
            let aShift: Uint256 = aStartShift;
            let aNearReal: Uint256 = ad[11];
            let aL: Uint256 = ad[12];
            let aDone: Uint256 = 0;
            for (let kx = 0; kx < EXTRA_TICKS; kx = kx + 1) {
              if (aDone === 0) {
                const aFarReal: Uint256 = stepReal(aNearReal, aStep, zeroForOne);
                const aNearOI: Uint256 = toOutIn(aNearReal, zeroForOne);
                const aFarOI: Uint256 = toOutIn(aFarReal, zeroForOne);
                let aLimited: Uint256 = 0;
                if (zeroForOne === 1) { if (aFarReal <= priceLimit) { aLimited = 1; } }
                else { if (aFarReal >= priceLimit) { aLimited = 1; } }
                if (aL > 0) { if (aNearOI > aFarOI) { if (aFarOI > 0) {
                  const aEffIn: Uint256 = Math.mulDiv(aL, Q96, aFarOI) - Math.mulDiv(aL, Q96, aNearOI);
                  if (aEffIn > 0) {
                    const aGross: Uint256 = Math.mulDiv(aEffIn, FEE_DENOM, FEE_DENOM - aFeePpm);
                    let aTake: Uint256 = aGross;
                    if (cum + aGross >= amountIn) { aTake = amountIn - cum; aDone = 1; }
                    inp[ap] = inp[ap] + aTake;
                    cum = cum + aTake;
                  }
                } } }
                const aArg: Uint256 = tickArg(aShift, OFFSET);
                let aNet: Uint256 = 0;
                if (aType === 2) { aNet = IStateViewFull.at(aStateView).getTickLiquidity(aPoolId, aArg)[1]; }
                else { aNet = IUniswapV3PoolFull.at(aAddr).ticks(aArg)[1]; }
                const aNeg: Uint256 = aNet >= HALF128 ? 1 : 0;
                if (zeroForOne === 1) {
                  if (aNeg === 1) { aL = aL + (MOD128 - aNet); } else { aL = aL >= aNet ? aL - aNet : 0; }
                  aShift = aShift - aTs;
                } else {
                  if (aNeg === 1) { const aMag: Uint256 = MOD128 - aNet; aL = aL >= aMag ? aL - aMag : 0; } else { aL = aL + aNet; }
                  aShift = aShift + aTs;
                }
                aNearReal = aFarReal;
                if (cum >= amountIn) { aDone = 1; }
                if (aLimited === 1) { aDone = 1; }
              }
            }
          }
        }
      }
    }
  }

  // ── COMPUTE-ONLY: replace the swap loops with INDEX read-backs of the array ──
  // The real solver swaps one-per-pool reading inp[p] and one-per-route reading
  // rinp[r] — both INDEX reads. Here we fold those same reads into a running sum
  // so the array writes above + these dynamic-data reads stay live (not DCE'd).
  let totalAssigned: Uint256 = 0;
  for (let p = 0; p < pools.length; p = p + 1) {
    totalAssigned = totalAssigned + inp[p];
  }
  for (let r = 0; r < routes.length; r = r + 1) {
    totalAssigned = totalAssigned + rinp[r];
  }

  // Return a cheap summary of the computed split (== cum when liquidity allows).
  return totalAssigned;
}
