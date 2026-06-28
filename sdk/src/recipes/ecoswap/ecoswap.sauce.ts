import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";
import { IUniswapV3PoolFull } from "./IUniswapV3PoolFull.json";
import { IStateViewFull } from "./IStateViewFull.json";
import { IUniswapV2Pair } from "./IUniswapV2Pair.json";

// EcoSwap on-chain solver — SINGLE-PASS (live-cut) variant.
//
// One sweep over the pre-sorted bracket ladder does in one pass what a two-pass
// water-fill splits across Phase A (find the cut) + Phase B (re-integrate each pool). Per-pool
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
// ADAPTIVE DYNAMIC STREAMING WALK (WS4 + WS2 #104): ALWAYS ON. Whenever the prepared
// bracket sweep under-fills (cum < amountIn), each pool with a frontier seed continues
// a streaming walk past its prepared window, bounded by EXTRA_TICKS and the price limit,
// to close the gap. V3/V4 stream live TICKS (ticks()/getTickLiquidity staticcalls,
// ported from the lens forward loop) from pools[i][10..13]. V2 streams CONSTANT-L
// geometric out/in slices (a V2 pool is a single √k curve over the ENTIRE price range
// — no ticks, no staticcalls) from pools[i][10]=1 (V2 walk flag) + pools[i][11]=deepest
// prepared far (out/in) at the LIVE √k cached by the sweep — the cheap analogue of the
// tick walk that makes V2 fully drift-adaptive (its ~16 prepared slices exist for
// cross-pool marginal granularity, NOT a fixed depth cap). The seed's first far-edge
// equals the last prepared bracket's far-edge, so the walk is path-additive (no gap, no
// double-count). It only does work when needed (cum < amountIn) — a window that already
// covers amountIn never enters the walk. (routes are static — no walk.)
//
// Inputs (precomputed off-chain in prepare.ts):
//   pools[i]    = [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0, stateView, poolId,
//                  adaptiveStartShifted, adaptiveNearReal, adaptiveStartL, adaptiveStepRatio,
//                  topNearReal, bracketCount]
//                 [10..13] are the adaptive frontier seeds. V3/V4: [10]=next un-walked
//                 boundary (shifted), [11]=near REAL sqrt, [12]=active L, [13]=tick step
//                 ratio. V2 (WS2 #104): [10]=1 (walk flag), [11]=deepest prepared far
//                 (out/in); L is read LIVE (√k), the step is the fixed V2 geometric ratio.
//   routes[r]   = [inter, h1Type,h1Pool,h1Fee,h1TS,h1Hooks, h2Type,h2Pool,h2Fee,h2TS,h2Hooks]
//   brackets[b] = [kind, refIdx, sqrtNear, sqrtFar, liquidity, capacity, sqrtAdjNear, sqrtAdjFar]
//                 kind: 0=V3 direct, 1=V2 direct, 2=route ; sorted DESC by sqrtAdjNear.
//
// On-chain a direct bracket uses kind/refIdx/sqrtNear/sqrtFar/liquidity + the live
// price; capacity[5] is used only for route segments (no live price). All sqrt
// values are unified out/in Q96.

// ── Pure helpers (copied verbatim from ecoswap.lens.sauce.ts) ─────────────────

// int24 STATICCALL arg (signed tick) from a shifted tick.
//
// SIGN-EXTEND to a full 32-byte word: a value derived from an `intN` contract
// output (slot0/getSlot0 `tick`) inherits that type's narrow byte-width, so when
// re-encoded as an `int24` argument the engine emits only the low 3 bytes,
// ZERO-extended. V3 pools (lax 0.7 decode) tolerate it; the V4 StateView (strict
// 0.8 decode) reverts bare 0x on a non-sign-extended NEGATIVE tick (real Base pools
// sit near -201700). OR-ing the high bits both sign-extends and widens to 32 bytes.
function tickArg(shifted: Uint256, OFFSET: Uint256): Uint256 {
  const HIGH: Uint256 = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000;
  if (shifted >= OFFSET) {
    const up: Uint256 = shifted - OFFSET;
    if (up >= 8388608) {
      return up | HIGH;
    }
    return up;
  }
  return Math.neg(OFFSET - shifted) | HIGH;
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
  let lArr: Tuple = new Array(pools.length); // V2 synthetic L cache (sweep reads at :Lb)
  let rinp: Tuple = new Array(routes.length);

  let cum: Uint256 = 0;
  let found: Uint256 = 0;

  const EXTRA_TICKS: Uint256 = 64; // walk budget (pre-fill + forward); <= 255 (engine for-bound cap)
  // V2 constant-L streaming step: far = near - near*V2_STEP_BPS/10000 (out/in space).
  // MUST equal prepare's buildV2Brackets step (V2_SQRT_STEP_BPS=25) bit-for-bit so the
  // V2 forward walk is path-additive with the prepared V2 window. A V2 pool is a SINGLE
  // constant-L curve (L=sqrt(reserveIn*reserveOut) over the whole price range), so
  // streaming past its prepared window is FREE — no tick reads, just more geometric
  // slices at the same live L (the cheap analogue of the V3/V4 tick walk).
  const V2_STEP_BPS: Uint256 = 25;
  const V2_STEP_DEN: Uint256 = 10000;

  // ── WS2 PRE-FILL: against-swap drift gap fill (BEFORE the sweep) ──────────────
  // When the LIVE price has drifted UP past a pool's TOP prepared bracket (the region
  // (topNearOI, liveCur] — the BEST-priced, never integrated by the sweep which caps
  // at the top bracket's near via hi=min(cur,near)), water-fill that gap FIRST: it is
  // the cheapest region so it must precede the sweep. Per V3/V4 pool with a prepared
  // window (bracketCount>0 && topNearReal>0), first-touch reads live price+tick+L, and
  // if cur>topNearOI walks live ticks DOWN to topNearReal (same swap direction as the
  // forward walk → identical stepReal / int128 branches). Caches the live reads so the
  // sweep's first-touch (gated on curArr[pidx]===0) skips the re-read. No-bracket pools
  // (bracketCount===0) are skipped here — the forward walk handles them from the spot
  // seed (§1.6). At zero drift (cur<=topNearOI, the deterministic local case) every pool
  // no-ops, so the no-drift path is byte-identical.
  for (let pf = 0; pf < pools.length; pf = pf + 1) {
    if (found === 0) {
      const pd: Tuple = pools[pf];
      const pfIsV2: Uint256 = pd[6];
      const pfType: Uint256 = pd[0];
      const topNearReal: Uint256 = pd[14];
      const bracketCount: Uint256 = pd[15];
      if (pfIsV2 === 0) {
        if (bracketCount > 0) {
          if (topNearReal > 0) {
            // First-touch live PRICE read (V3/V4): just slot0[0]. The live tick + active
            // L (2 more staticcalls) are read LAZILY inside the drift gate below — at
            // zero drift (the common case) the gate is false, so the pre-fill adds NO
            // extra staticcalls vs the sweep's single price read.
            let srReal: Uint256 = 0;
            if (pfType === 2) {
              srReal = IStateViewFull.at(pd[8]).getSlot0(pd[9])[0];
            } else {
              srReal = IUniswapV3PoolFull.at(pd[1]).slot0()[0];
            }
            const pfCur: Uint256 = zeroForOne === 1 ? srReal : Q192 / srReal;
            // Cache only the out/in price for the sweep (skips its re-read). Self-
            // contained otherwise — no extra cross-scope arrays (v12 slot pressure).
            curArr[pf] = pfCur;

            const topNearOI: Uint256 = toOutIn(topNearReal, zeroForOne);
            // Only fill when live drifted UP past the window top (against-swap drift).
            if (pfCur > topNearOI) {
              const pfFeePpm: Uint256 = pd[5];
              const pfTs: Uint256 = pd[3];
              const pfStep: Uint256 = pd[13];
              // Live tick + active L (the gap walk's start boundary + entry liquidity) —
              // read here, only under drift.
              let liveTick: Uint256 = 0;
              let liveL: Uint256 = 0;
              if (pfType === 2) {
                liveTick = IStateViewFull.at(pd[8]).getSlot0(pd[9])[1];
                liveL = IStateViewFull.at(pd[8]).getLiquidity(pd[9]);
              } else {
                liveTick = IUniswapV3PoolFull.at(pd[1]).slot0()[1];
                liveL = IUniswapV3PoolFull.at(pd[1]).liquidity();
              }
              // Start boundary from the LIVE tick (lens convention, OFFSET-shifted so the
              // floor-division is unsigned): zeroForOne crosses the live bucket's lower
              // edge first (pBase); oneForZero starts one ts up (pBase+pfTs).
              const pBase: Uint256 = ((liveTick + OFFSET) / pfTs) * pfTs;
              let pShift: Uint256 = pBase;
              if (zeroForOne === 0) { pShift = pBase + pfTs; }
              let pNear: Uint256 = srReal; // lens convention: near = raw live real sqrt
              let pL: Uint256 = liveL;
              let pDone: Uint256 = 0;
              for (let px = 0; px < EXTRA_TICKS; px = px + 1) {
                if (pDone === 0) {
                  const pFarReal: Uint256 = stepReal(pNear, pfStep, zeroForOne);
                  const pNearOI: Uint256 = toOutIn(pNear, zeroForOne);
                  const pFarOI: Uint256 = toOutIn(pFarReal, zeroForOne);
                  // STOP at the window top: clamp the last partial step's far edge to
                  // topNearOI so the gap region is exactly (topNearOI, liveCur].
                  let stopHere: Uint256 = 0;
                  let fillFarOI: Uint256 = pFarOI;
                  if (pFarOI <= topNearOI) { fillFarOI = topNearOI; stopHere = 1; }
                  if (pL > 0) { if (pNearOI > fillFarOI) { if (fillFarOI > 0) {
                    const pEffIn: Uint256 = Math.mulDiv(pL, Q96, fillFarOI) - Math.mulDiv(pL, Q96, pNearOI);
                    if (pEffIn > 0) {
                      const pGross: Uint256 = Math.mulDiv(pEffIn, FEE_DENOM, FEE_DENOM - pfFeePpm);
                      let pTake: Uint256 = pGross;
                      if (cum + pGross >= amountIn) { pTake = amountIn - cum; pDone = 1; found = 1; }
                      inp[pf] = inp[pf] + pTake;
                      cum = cum + pTake;
                    }
                  } } }
                  if (stopHere === 1) {
                    pDone = 1;
                  } else {
                    // Cross the boundary tick (price moving DOWN = swap direction): SAME
                    // int128 branches as the forward walk.
                    const pArg: Uint256 = tickArg(pShift, OFFSET);
                    let pNet: Uint256 = 0;
                    if (pfType === 2) { pNet = IStateViewFull.at(pd[8]).getTickLiquidity(pd[9], pArg)[1]; }
                    else { pNet = IUniswapV3PoolFull.at(pd[1]).ticks(pArg)[1]; }
                    const pNeg: Uint256 = pNet >= HALF128 ? 1 : 0;
                    if (zeroForOne === 1) {
                      if (pNeg === 1) { pL = pL + (MOD128 - pNet); } else { pL = pL >= pNet ? pL - pNet : 0; }
                      pShift = pShift - pfTs;
                    } else {
                      if (pNeg === 1) { const pMag: Uint256 = MOD128 - pNet; pL = pL >= pMag ? pL - pMag : 0; } else { pL = pL + pNet; }
                      pShift = pShift + pfTs;
                    }
                    pNear = pFarReal;
                  }
                  if (cum >= amountIn) { pDone = 1; }
                }
              }
            }
          }
        }
      }
    }
  }

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

  // ── ADAPTIVE STREAMING WALK (WS4 + WS2 #104): continue past the prepared window ──
  // ALWAYS ON, gated only by need + data: if the prepared brackets under-filled
  // (cum < amountIn) and a pool carries a frontier seed (aStartShift > 0 — always
  // stamped for V3/V4 AND V2 now), resume that pool's walk LIVE from exactly where the
  // prepared window stopped, consuming each step's gross into inp[ap]/cum until amountIn
  // is met, the price limit binds, or EXTRA_TICKS steps are read. V3/V4 mirror the lens
  // forward TICK walk (ticks()/getTickLiquidity, ±liquidityNet at each boundary). V2
  // streams CONSTANT-L geometric out/in slices (a V2 pool is a single √k curve over the
  // ENTIRE range — no ticks, no staticcalls — so under favorable/with-swap drift the
  // solver just emits more slices at the SAME live L, the analogue of the tick walk).
  // A window that already covers amountIn never enters this block (cum < amountIn false).
  if (cum < amountIn) {
    for (let ap = 0; ap < pools.length; ap = ap + 1) {
      if (cum < amountIn) {
        const ad: Tuple = pools[ap];
        const aStartShift: Uint256 = ad[10];
        const aType: Uint256 = ad[0];
        const aIsV2: Uint256 = ad[6];
        if (aIsV2 === 1) {
          // ── V2 constant-L streaming (WS2 #104) ──
          // Resume from the deepest prepared V2 bracket's far edge (out/in, stamped in
          // ad[11]) and keep emitting geometric slices (far = near - near*V2_STEP_BPS/
          // V2_STEP_DEN — IDENTICAL to prepare's buildV2Brackets step, so path-additive)
          // at the LIVE constant L (cached by the sweep's V2 first-touch in lArr[ap]).
          // No tick reads. Bounded by EXTRA_TICKS, amountIn and a >0 floor on far. This
          // is what lets V2 adapt under with-swap drift: prepare's ~16 slices exist for
          // cross-pool marginal-price equalization granularity, NOT as a fixed depth cap.
          if (aStartShift > 0) {
            const v2FeePpm: Uint256 = ad[5];
            let v2L: Uint256 = lArr[ap]; // live √k, cached by the sweep's V2 first-touch
            // Defensive: if this V2 pool was never touched by the sweep (cum hit amountIn
            // before its first bracket), lArr[ap] is 0 — re-read live reserves so the
            // constant-L stream has the right L. (Common path: the sweep already cached it.)
            if (v2L === 0) {
              const vr0: Uint256 = IUniswapV2Pair.at(ad[1]).getReserves()[0];
              const vr1: Uint256 = IUniswapV2Pair.at(ad[1]).getReserves()[1];
              const vIn0: Uint256 = ad[7];
              const vResIn: Uint256 = vIn0 === 1 ? vr0 : vr1;
              const vResOut: Uint256 = vIn0 === 1 ? vr1 : vr0;
              v2L = Math.sqrt(vResIn * vResOut);
            }
            let v2Near: Uint256 = ad[11]; // out/in frontier = deepest prepared far
            let v2Done: Uint256 = 0;
            for (let vx = 0; vx < EXTRA_TICKS; vx = vx + 1) {
              if (v2Done === 0) {
                const v2Far: Uint256 = v2Near - Math.mulDiv(v2Near, V2_STEP_BPS, V2_STEP_DEN);
                if (v2L > 0) { if (v2Near > v2Far) { if (v2Far > 0) {
                  const v2EffIn: Uint256 = Math.mulDiv(v2L, Q96, v2Far) - Math.mulDiv(v2L, Q96, v2Near);
                  if (v2EffIn > 0) {
                    const v2Gross: Uint256 = Math.mulDiv(v2EffIn, FEE_DENOM, FEE_DENOM - v2FeePpm);
                    let v2Take: Uint256 = v2Gross;
                    if (cum + v2Gross >= amountIn) { v2Take = amountIn - cum; v2Done = 1; }
                    inp[ap] = inp[ap] + v2Take;
                    cum = cum + v2Take;
                  }
                } } }
                if (v2Far <= 0) { v2Done = 1; }
                v2Near = v2Far;
                if (cum >= amountIn) { v2Done = 1; }
              }
            }
          }
        } else {
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
