import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";
import { IUniswapV3PoolFull } from "./IUniswapV3PoolFull.json";
import { IStateViewFull } from "./IStateViewFull.json";
import { IUniswapV2Pair } from "./IUniswapV2Pair.json";

// EcoSwap on-chain solver — SINGLE-PASS (live-cut) variant.
//
// One sweep over the pre-sorted bracket ladder does what the two-pass solver
// split across Phase A (find the cut) + Phase B (re-integrate each pool). Per-pool
// input accumulators and the live price / V2-liquidity caches live in real mutable
// arrays sized to the (bounded) pool/route counts — new Array(pools.length) /
// new Array(routes.length) — indexed directly by the runtime pool/route index.
// new Array(n) zero-inits every slot, so the price cache's sentinel 0 = "unseen"
// comes for free, and n is bounded by MAX_DIRECT_POOLS=12 / MAX_ROUTES=2, well
// under the engine's 255-slot NEW_ARRAY cap.
//
// Why no explicit cut: brackets are sorted DESC by fee-adjusted marginal price, so
// the sweep processes the best price first. Each bracket's gross input is computed
// LIVE (hi = min(curSqrt, near) → drift is absorbed here, so NO cap=0 reverse-
// bracket hack is needed: a reverse bracket only contributes when curSqrt has
// actually drifted above spot). We add each bracket's full gross to its pool's
// accumulator until cum reaches amountIn; the crossing bracket's pool gets the
// remaining need. The cut is implicit — every engaged pool ends at ~the same
// marginal price, and the exact-input swaps realise the geometry. Total assigned
// (cum) == amountIn exactly when liquidity allows.
//
// COMPUTE-THEN-PULL: the sweep is read-only (slot0 / getReserves staticcalls only),
// so we first compute exactly how much tokenIn the swaps will consume (cum), then
// transferFrom the caller EXACTLY that — no upfront over-pull, no refund round-trip.
// The only leftover possible is the limit-price edge (a binding priceLimit makes a
// V3 swap consume less than its assigned input); one guarded terminal refund returns it.
//
// ADAPTIVE DYNAMIC TICK READS (WS4): if a pool's prepared brackets are exhausted
// while cum < amountIn, the solver continues a streaming live-tick walk for that
// pool (ticks()/getTickLiquidity staticcalls, ported from the lens forward loop),
// bounded by EXTRA_TICKS and gated on cum < amountIn + the price limit. DATA-GATED:
// off → frontier seeds (pools[i][10..13]) are 0 → aStartShift>0 is false → the loop
// never fires → behavior byte-identical to non-adaptive. V3/V4 only (V2 has a single
// wide bracket; routes are static). The seed's first far-edge equals the last prepared
// bracket's far-edge, so the walk is path-additive (no gap, no double-count).
//
// Inputs (precomputed off-chain in prepare.ts):
//   pools[i]    = [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0, stateView, poolId,
//                  adaptiveStartShifted, adaptiveNearReal, adaptiveStartL, adaptiveStepRatio]
//                 [10..13] are the adaptive frontier seeds (0 unless prepared adaptive).
//   routes[r]   = [inter, h1Type,h1Pool,h1Fee,h1TS,h1Hooks, h2Type,h2Pool,h2Fee,h2TS,h2Hooks]
//   brackets[b] = [kind, refIdx, sqrtNear, sqrtFar, liquidity, capacity, sqrtAdjNear, sqrtAdjFar]
//                 kind: 0=V3 direct, 1=V2 direct, 2=route ; sorted DESC by sqrtAdjNear.
//
// On-chain a direct bracket uses kind/refIdx/sqrtNear/sqrtFar/liquidity + the live
// price; capacity[5] is used only for route segments (no live price). All sqrt
// values are unified out/in Q96.

// ── Pure helpers (copied verbatim from ecoswap.lens.sauce.ts) ─────────────────

// int24 STATICCALL arg (signed tick) from a shifted tick.
function tickArg(shifted: Uint256, OFFSET: Uint256): Uint256 {
  if (shifted >= OFFSET) {
    return shifted - OFFSET;
  }
  return Math.neg(OFFSET - shifted);
}

// Convert a real pool sqrt (token1/token0) into unified out/in sqrt.
function toOutIn(sqrtReal: Uint256, zeroForOne: Uint256): Uint256 {
  if (zeroForOne === 1) {
    return sqrtReal;
  }
  const Q192: Uint256 = 2 ** 192;
  return Q192 / sqrtReal;
}

// Next REAL sqrt one tickSpacing step in the swap direction.
//   zeroForOne (price down): sqrt' = mulDiv(sqrt, 2^96, stepRatio)
//   oneForZero (price up):   sqrt' = mulDiv(sqrt, stepRatio, 2^96)
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
  const router = ISauceRouter.at(address.self);
  const token = IERC20.at(tokenIn);

  const Q96: Uint256 = 2 ** 96;
  const Q192: Uint256 = 2 ** 192;
  const FEE_DENOM: Uint256 = 1000000;
  const OFFSET: Uint256 = 888000; // tick shift (matches lens / prepare seeds)
  const HALF128: Uint256 = 2 ** 127; // int128 sign bit
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
        // Route segment — static capacity (no live price), accumulate per route.
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

        // Cached live state for this pool index (0 = not yet read).
        let cur: Uint256 = curArr[pidx];
        let Lliv: Uint256 = lArr[pidx];

        // first touch → read live price (+ V2 live L), cache it
        if (cur === 0) {
          let cl: Uint256 = 0;
          let ll: Uint256 = 0;
          if (isV2 === 1) {
            // Two SEPARATE getReserves() staticcalls (one indexed [0], one [1]):
            // a stored multi-return reverts on re-index in this VM, so we read twice.
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

        // integrate this bracket from hi = min(cur, near) down to far, LIVE
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
  // If the prepared brackets under-filled (cum < amountIn) and a pool carries a
  // frontier seed (aStartShift > 0 → prepared adaptively), resume that pool's tick
  // walk LIVE from exactly where buildV3Brackets stopped, consuming each step's
  // gross into inp[ap]/cum until amountIn is met, the price limit binds, or
  // EXTRA_TICKS steps are read. Mirrors the lens forward loop bit-for-bit. Default
  // (seeds 0) → this whole block is skipped → byte-identical to non-adaptive.
  const EXTRA_TICKS: Uint256 = 64; // one window past the frontier; <= 255 (engine for-bound cap)
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
                // Limit-price guard (REAL-sqrt space): stop this pool if the next
                // step would cross the binding priceLimit, so inp[ap] never exceeds
                // what the swap can realize (the terminal refund still catches it).
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
                // Cross the boundary tick: update L by liquidityNet (live read).
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

  // ── COMPUTE-THEN-PULL: pull EXACTLY what the swaps will consume (cum ≤ amountIn) ──
  if (cum > 0) {
    token.transferFrom(caller, address.self, cum);
  }

  // ── Execution: one swap per direct pool (amount read from the accumulator) ──
  for (let p = 0; p < pools.length; p = p + 1) {
    const amt: Uint256 = inp[p];
    if (amt > 0) {
      const dp: Tuple = pools[p];
      const isV2: Uint256 = dp[6];
      const pType: Uint256 = dp[0];
      if (isV2 === 1) {
        // Constant-product: unified swap(SwapParams), poolType=UniV2=0, neg amount.
        const cc0: Address = zeroForOne === 1 ? tokenIn : tokenOut;
        const cc1: Address = zeroForOne === 1 ? tokenOut : tokenIn;
        router.swap({
          poolType: 0,
          pool: dp[1],
          poolKey: { currency0: cc0, currency1: cc1, fee: 0, tickSpacing: 0, hooks: 0 },
          tokenIn: tokenIn,
          tokenOut: tokenOut,
          amountSpecified: Math.neg(amt),
          sqrtPriceLimitX96: 0,
          payer: address.self,
          recipient: address.self,
        });
      } else {
        if (pType === 2) {
          // V4 singleton: unified swap(SwapParams), poolType=UniV4=2, neg amount.
          const k0: Address = zeroForOne === 1 ? tokenIn : tokenOut;
          const k1: Address = zeroForOne === 1 ? tokenOut : tokenIn;
          router.swap({
            poolType: 2,
            pool: dp[1],
            poolKey: { currency0: k0, currency1: k1, fee: dp[2], tickSpacing: dp[3], hooks: dp[4] },
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountSpecified: Math.neg(amt),
            sqrtPriceLimitX96: 0,
            payer: address.self,
            recipient: address.self,
          });
        } else {
          // V3 direct: flat swapV3, positive = exact input.
          router.swapV3(dp[1], tokenIn, tokenOut, amt, priceLimit, address.self, address.self);
        }
      }
    }
  }

  // ── Execution: routes (≤2), hop1 -> hop2 via flat swapV3 ──
  for (let r = 0; r < routes.length; r = r + 1) {
    const ramt: Uint256 = rinp[r];
    if (ramt > 0) {
      const route: Tuple = routes[r];
      const inter: Address = route[0];
      router.swapV3(route[2], tokenIn, inter, ramt, 0, address.self, address.self);
      const interBal: Uint256 = IERC20.at(inter).balanceOf(address.self);
      if (interBal > 0) {
        router.swapV3(route[7], inter, tokenOut, interBal, 0, address.self, address.self);
      }
    }
  }

  // Guarded terminal refund: the only leftover possible is the limit-price edge
  // (a binding priceLimit makes a V3 swap consume less than its assigned input).
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
