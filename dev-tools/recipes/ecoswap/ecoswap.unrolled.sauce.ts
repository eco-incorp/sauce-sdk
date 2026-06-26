import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";
import { IUniswapV3Pool } from "./artifacts/IUniswapV3Pool.json";
import { IStateView } from "./artifacts/IStateView.json";
import { IUniswapV2Pair } from "./IUniswapV2Pair.json";

// EcoSwap on-chain solver — SINGLE-PASS (live-cut) variant.
//
// One sweep over the pre-sorted bracket ladder does in one pass what a two-pass
// water-fill splits across Phase A (find the cut) + Phase B (re-integrate each pool). The
// trick that makes it fit the array-mutation-free VM: the pool count is bounded
// (MAX_DIRECT_POOLS), so per-pool input accumulators live in fixed scalar
// registers i0..i11 (routes in q0..q1), dispatched by an if-ladder on the runtime
// pool index. Live prices are read once per pool and cached in c0..c11 (sentinel
// 0 = unseen); V2 live L caches in l0..l11.
//
// Why no explicit cut: brackets are sorted DESC by fee-adjusted marginal price, so
// the sweep processes the best price first. Each bracket's gross input is computed
// LIVE (hi = min(curSqrt, near) → drift is absorbed here, so NO cap=0 reverse-
// bracket hack is needed: a reverse bracket only contributes when curSqrt has
// actually drifted above spot). We add each bracket's full gross to its pool's
// register until cum reaches amountIn; the crossing bracket's pool gets the
// remaining need. The cut is implicit — every engaged pool ends at ~the same
// marginal price, and the exact-input swaps realise the geometry. Total assigned
// == amountIn exactly (no stale-cut refund).
//
// Inputs (precomputed off-chain in prepare.ts):
//   pools[i]    = [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0, stateView, poolId]
//   routes[r]   = [inter, h1Type,h1Pool,h1Fee,h1TS,h1Hooks, h2Type,h2Pool,h2Fee,h2TS,h2Hooks]
//   brackets[b] = [kind, refIdx, sqrtNear, sqrtFar, liquidity, capacity, sqrtAdjNear, sqrtAdjFar]
//                 kind: 0=V3 direct, 1=V2 direct, 2=route ; sorted DESC by sqrtAdjNear.
//
// On-chain a direct bracket uses kind/refIdx/sqrtNear/sqrtFar/liquidity + the live
// price; capacity[5] is used only for route segments (no live price). All sqrt
// values are unified out/in Q96.

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

  // Per-pool input registers (≤ MAX_DIRECT_POOLS = 12), live-price cache (0 =
  // unseen), V2 live-L cache; per-route input registers (≤ MAX_ROUTES = 2).
  let i0: Uint256 = 0; let i1: Uint256 = 0; let i2: Uint256 = 0; let i3: Uint256 = 0;
  let i4: Uint256 = 0; let i5: Uint256 = 0; let i6: Uint256 = 0; let i7: Uint256 = 0;
  let i8: Uint256 = 0; let i9: Uint256 = 0; let i10: Uint256 = 0; let i11: Uint256 = 0;
  let c0: Uint256 = 0; let c1: Uint256 = 0; let c2: Uint256 = 0; let c3: Uint256 = 0;
  let c4: Uint256 = 0; let c5: Uint256 = 0; let c6: Uint256 = 0; let c7: Uint256 = 0;
  let c8: Uint256 = 0; let c9: Uint256 = 0; let c10: Uint256 = 0; let c11: Uint256 = 0;
  let l0: Uint256 = 0; let l1: Uint256 = 0; let l2: Uint256 = 0; let l3: Uint256 = 0;
  let l4: Uint256 = 0; let l5: Uint256 = 0; let l6: Uint256 = 0; let l7: Uint256 = 0;
  let l8: Uint256 = 0; let l9: Uint256 = 0; let l10: Uint256 = 0; let l11: Uint256 = 0;
  let q0: Uint256 = 0; let q1: Uint256 = 0;

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
        if (rdx === 0) { q0 = q0 + take; }
        if (rdx === 1) { q1 = q1 + take; }
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

        // read-dispatch cached live state for this pool index
        let cur: Uint256 = 0;
        let Lliv: Uint256 = 0;
        if (pidx === 0) { cur = c0; Lliv = l0; }
        if (pidx === 1) { cur = c1; Lliv = l1; }
        if (pidx === 2) { cur = c2; Lliv = l2; }
        if (pidx === 3) { cur = c3; Lliv = l3; }
        if (pidx === 4) { cur = c4; Lliv = l4; }
        if (pidx === 5) { cur = c5; Lliv = l5; }
        if (pidx === 6) { cur = c6; Lliv = l6; }
        if (pidx === 7) { cur = c7; Lliv = l7; }
        if (pidx === 8) { cur = c8; Lliv = l8; }
        if (pidx === 9) { cur = c9; Lliv = l9; }
        if (pidx === 10) { cur = c10; Lliv = l10; }
        if (pidx === 11) { cur = c11; Lliv = l11; }

        // first touch → read live price (+ V2 live L), cache via write-dispatch
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
              const sr4: Uint256 = IStateView.at(dp[8]).getSlot0(dp[9])[0];
              cl = zeroForOne === 1 ? sr4 : Q192 / sr4;
            } else {
              const sr: Uint256 = IUniswapV3Pool.at(dp[1]).slot0()[0];
              cl = zeroForOne === 1 ? sr : Q192 / sr;
            }
          }
          cur = cl;
          Lliv = ll;
          if (pidx === 0) { c0 = cl; l0 = ll; }
          if (pidx === 1) { c1 = cl; l1 = ll; }
          if (pidx === 2) { c2 = cl; l2 = ll; }
          if (pidx === 3) { c3 = cl; l3 = ll; }
          if (pidx === 4) { c4 = cl; l4 = ll; }
          if (pidx === 5) { c5 = cl; l5 = ll; }
          if (pidx === 6) { c6 = cl; l6 = ll; }
          if (pidx === 7) { c7 = cl; l7 = ll; }
          if (pidx === 8) { c8 = cl; l8 = ll; }
          if (pidx === 9) { c9 = cl; l9 = ll; }
          if (pidx === 10) { c10 = cl; l10 = ll; }
          if (pidx === 11) { c11 = cl; l11 = ll; }
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
                if (pidx === 0) { i0 = i0 + take; }
                if (pidx === 1) { i1 = i1 + take; }
                if (pidx === 2) { i2 = i2 + take; }
                if (pidx === 3) { i3 = i3 + take; }
                if (pidx === 4) { i4 = i4 + take; }
                if (pidx === 5) { i5 = i5 + take; }
                if (pidx === 6) { i6 = i6 + take; }
                if (pidx === 7) { i7 = i7 + take; }
                if (pidx === 8) { i8 = i8 + take; }
                if (pidx === 9) { i9 = i9 + take; }
                if (pidx === 10) { i10 = i10 + take; }
                if (pidx === 11) { i11 = i11 + take; }
                cum = cum + take;
              }
            }
          }
        }
      }
    }
  }

  // ── Execution: one swap per direct pool (amount read-dispatched) ──
  for (let p = 0; p < pools.length; p = p + 1) {
    let amt: Uint256 = 0;
    if (p === 0) { amt = i0; }
    if (p === 1) { amt = i1; }
    if (p === 2) { amt = i2; }
    if (p === 3) { amt = i3; }
    if (p === 4) { amt = i4; }
    if (p === 5) { amt = i5; }
    if (p === 6) { amt = i6; }
    if (p === 7) { amt = i7; }
    if (p === 8) { amt = i8; }
    if (p === 9) { amt = i9; }
    if (p === 10) { amt = i10; }
    if (p === 11) { amt = i11; }

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
    let ramt: Uint256 = 0;
    if (r === 0) { ramt = q0; }
    if (r === 1) { ramt = q1; }
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

  // Refund any unspent tokenIn (liquidity ran out before amountIn was met).
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
