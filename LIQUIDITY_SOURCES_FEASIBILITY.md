# EcoSwap Liquidity-Source Feasibility

Scope: can each candidate liquidity source be added to EcoSwap held to the **same wei-exact standard** —
(1) discovery, (2) a live marginal out/in price curve the unified water-fill can walk, (3) a neutral
solver-independent wei-exact oracle (the `ecoswap.optimal.ts` `v3Segments`/`v2Segments` analogue),
(4) tests — and does it execute callback-free (replicable in SauceScript) or need a Router swap path.

EcoSwap's core machinery this report repeatedly reuses:
- **Discovery**: `sdk/src/recipes/shared/pool-discovery.ts` + factory configs `shared/constants.ts`.
- **Unified curve**: every pool re-expressed in out/in sqrt-price space; a constant-product V2 pool ==
  a V3 range with `L = isqrt(reserveIn·reserveOut)` (`shared/types.ts`).
- **Solver walk**: price-ordered k-way merge over price-monotone segments (`ecoswap/ecoswap.sauce.ts`).
- **Neutral oracle**: `sdk/src/recipes/test/ecoswap.optimal.ts` (`v2Segments`/`v3Segments`), mirrored by
  `ecoswap.solver-reference.ts`; known-answer math in `ecoswap.math.ts`/`ecoswap.math.test.ts`.
- **Route segments**: `prepare.ts` `localQuote`/`buildRouteBracketsLocal` already sample a cumulative-input
  curve into `(capacity, marginal)` segments — the template for any sampled (non-constant-L) source.

---

## 1. Feasibility matrix

| Source | Verdict | Callback model | Engine support | Sauce-expressible | Wei-exact oracle | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| **Uniswap V3 family** (Uni/Pancake V3, Aerodrome/Velodrome CL, Sushi V3, Ramses/Chronos CL) | tractable-now | callback (router) | dispatched + verified | yes (in `ecoswap.sauce.ts`) | yes (`v3Segments`) | S |
| **Uniswap V2 family @ 0.30%** (Uni/Pancake/BaseSwap V2, Solidly volatile @ 30bps) | tractable-now | callback-free | dispatched + verified | yes (in `ecoswap.sauce.ts`) | yes (`v2Segments`) | S |
| **Uniswap V4** | tractable-now | callback (router) | dispatched + verified | yes | yes | S |
| **Algebra forks** (Camelot/QuickSwap V3, Ramses V2) — *discover+price* | tractable-now | callback (`algebraSwapCallback`) | price only (`globalState()` read) | n/a (price path reuses V3 read) | yes (V3 oracle + dynamic-fee source) | M |
| **Algebra forks** — *execution* | needs-engine-change | callback (`algebraSwapCallback`, NOT serviced) | NOT dispatched (revert on callback) | no | n/a (cannot land a swap) | L |
| **V2-class @ non-0.30% fee** (Solidly volatile, some Sushi tiers) | tractable-now | callback-free | `_swapV2` hardcodes 0.30% — bypass in SauceScript | yes | yes (per-pool fee threaded) | M |
| **KyberSwap Classic (DMM)** | tractable-now | callback-free | `_swapV2` unusable (virtual reserves + per-pool fee); do in SauceScript | yes (V2 on virtual reserves) | yes (constant-L on vReserves) | S–M |
| **Curve StableSwap + StableSwap-NG (plain)** | tractable-now | callback-free | dispatched (`_swapCurve`, int128) | execute via engine; do NOT recompute on-chain | exact-in-`dy`, split exact-on-grid (bounded, tunable) | M |
| **Solidly stable pools** (`x³y+y³x=k`) | needs-work | callback-free | mis-mapped to xy=k `_swapV2` | yes (Newton, bounded) | yes (sampled segments) | L |
| **KyberSwap Elastic** | needs-engine-change | callback (`swapCallback`, non-Uniswap sig) | NOT dispatched | borderline (new step kernel, reinvestL accretes) | feasible but hard (faithful `SwapMath` port) | L–XL |
| **EulerSwap** | needs-engine-change | callback (`eulerSwapCall`, flash) | NOT dispatched | yes (closed-form `f`/`fInverse`, no Newton) | yes but new native-price segment family + vault cap | L–XL |
| **Curve CryptoSwap** (tricrypto/twocrypto) | needs-engine-change | callback-free | `_swapCurve` int128 ABI mismatch (uint256 indices) | yes (Newton, bounded) | sampled segments (like StableSwap) | M–L |
| **Fermi / propAMM** | not-expressible (as wei-exact) | callback-free | NOT dispatched | math yes, **state off-chain** | impossible (exogenous time-varying state) | N/A (best-effort quote-source: L) |
| **Balancer V2 weighted** | needs-engine-change | callback-free (Vault) | dispatched (`_swapBalancerV2`); discovery is a stub `[]` | fractional `pow` — out of intrinsic set | approximate only (fractional-power rounding) | XL |
| **DODO V2 (PMM)** | needs-work | callback-free | dispatched (`_swapDODOV2`); not wired in discovery | yes (closed-form-ish, no unbounded loop) | yes (sampled/PMM segments) | L |
| **Trader Joe LB** | needs-work | callback-free | dispatched (`_swapTraderJoeLB`); not wired | yes (discrete bins) | yes (one flat segment per bin — clean fit) | M–L |
| **Maverick V2** | needs-engine-wiring | callback (`maverickV2SwapCallback`) | dispatched (`_swapMaverickV2`); not wired, placeholder price | no clean monotone integration | weak | XL |
| **WOOFi** | not-expressible (as wei-exact) | callback-free | dispatched (`_swapWOOFi`); not wired, placeholder price | math yes, oracle-priced sPMM | impossible (exogenous oracle price) | XL / None |

Notes on the "engine support" column: the private `../sauce` Router already has dispatch *branches* for
all 9 `SwapPoolType` values (`UniV2=0, UniV3=1, UniV4=2, Curve=3, BalancerV2=4, DODOV2=5, TraderJoeLB=6,
MaverickV2=7, WOOFi=8`). For Curve/DODO/LB/Maverick/WOOFi the missing piece is **not** the branch — it is
the discovery→param plumbing in this repo: gigaswap/ecoswap build a V2/V3/V4-shaped `SwapParams` tuple
that has no slot for Curve `(i,j)`, DODO orientation, LB bin params, etc., and discovery emits **placeholder
prices** (`sqrtPriceX96=1n` for Maverick/WOOFi; synthetic V2-style sqrt for Curve/DODO/LB) that cannot seed
a unified walk. Kyber Elastic and EulerSwap have **no** Router branch at all and need a genuine engine PR.

---

## 2. Prioritized implementation order

Ordered by coverage-per-unit-effort. Items 1–3 are the high-ROI tractable-now wins; 4–6 are M-effort
add-ons that reuse the same machinery; everything after needs an engine PR or is out of charter.

### Tier A — do first (no engine change, reuse existing segment machinery)

**1. V2/V3/V4 family coverage hardening (S).** *Already supported and verified by the EcoSwap EVM tests.*
The cheapest coverage gain is purely configuration: ensure every UniV3-clone factory (Aerodrome/Velodrome
CL, Sushi V3, Ramses/Chronos CL) and every 0.30% UniV2-clone is in `shared/constants.ts` with correct
per-factory `feeTiers`. **Integration**: no code — discovery already reads `slot0()`+`ticks()` for V3-shape
and `getReserves()` for V2-shape; the solver, oracle (`v3Segments`/`v2Segments`), and engine path are
unchanged. The only correctness trap is **fee**: V2-clones at ≠30bps and Algebra dynamic-fee pools are
*not* covered by this item (see 2 and 4). Tests: extend `ecoswap.compile.test.ts` coverage; add a
prod-mirror snapshot for one new CL clone if depth warrants.

**2. V2-class per-pool fee threading (M).** Both discovery (`readV2PoolState` hardcodes `fee:3000`) and the
engine `_swapV2` (`*997/1000`) assume 0.30%, breaking wei-exactness for any V2-class pool at a different
fee. **Integration**: read each pool's real fee at discovery; thread `feePpm` into the V2 `PoolInfo` and
into the `v2Segments` oracle (it already grosses by `FEE_DENOM/(FEE_DENOM−feePpm)` — just stop hardcoding).
Because `_swapV2` can't honor a non-30bps fee, execute these pools via the **callback-free SauceScript path**
(`transfer(pair, in)` + `pair.swap(...)`) instead of the router — EcoSwap already contemplates this for
callback-free sources, so no engine change. Tests: a `v2Segments` known-answer case at a 5bps fee; one
EVM mix.

**3. KyberSwap Classic / DMM (S–M).** Amplified constant-product on **virtual** reserves — structurally
identical to item 2. `getAmountOut = amountInWithFee·vReserveOut/(vReserveIn+amountInWithFee)` with
`amountInWithFee = in·(1e18−feeInPrecision)/1e18`; unify as `L = isqrt(vReserveIn·vReserveOut)`.
**Integration**: add `FactoryType.KyberClassic` querying `getPools(a,b)` → per-pool `getTradeInfo()`
`(r0,r1,vr0,vr1,feeInPrecision)`; emit a V2-shaped bracket seeded from **virtual** reserves + the per-pool
fee (rounded 1e18→ppm, same rounding in the oracle so it stays wei-exact-by-construction); reuse the V2
constant-L geometric stream verbatim; clamp the walk at the amplification price bounds `[P_min,P_max]`
(a small mirror of the V3 price-limit guard). Callback-free → SauceScript `transfer + pool.swap(a0,a1,to,"")`,
no engine change. Oracle: a thin `v2Segments` variant carrying `vReserveIn/vReserveOut/feePpm`. Tests:
one EVM mix + a `kyberClassicDy` known-answer block.

### Tier B — M-effort add-ons (reuse the sampled-segment / route machinery)

**4. Algebra dynamic-fee forks — DISCOVER + PRICE only (M).** Camelot/QuickSwap V3, Ramses V2 are V3-shaped,
so their state reads map onto a `poolType=UniV3` row, but they read `globalState()` (not `slot0()`) and carry
a **dynamic fee**. **Integration (price)**: a state-reader variant in the lens for `globalState()` + a fee
source; the V3 oracle is otherwise reused unchanged. The fee is read once at quote time and treated as fixed
over the trade (same snapshot assumption the recipe already makes for V3 tiers), so a PRICE/split computed
against an Algebra pool stays wei-exact against that snapshot. This half is done and pinned by
`ecoswap.algebra.test.ts` (decode + oracle vectors). **EXECUTION is a separate, engine-blocked item** — see
§3 "Algebra forks — execution". Because the lens emits Algebra as a `poolType=UniV3` row that prepare would
otherwise cook via `swapV3` (→ revert on the unserviced `algebraSwapCallback`), the discovery + lens layers
**gate Algebra out of the executable set**: `discoverPools` drops Algebra pools, and `runLens` defaults
`includeAlgebra=false` (Algebra factories are not fed to the lens program). Flip the gate once the engine PR
below lands.

**5. Curve StableSwap + StableSwap-NG, plain pools (M).** `_swapCurve` is live (int128 indices). **Do NOT
recompute the curve on-chain** (two nested Newton loops are fragile under the compiler/v12 budget). Execute
via `swap(SwapParams{poolType:3, amountSpecified:share})`; the solver only needs Curve's marginal curve as
**data**. **Integration**: rework `discoverCurvePools` to emit `{poolType:Curve, i, j, A, D, balances[],
rates[], fee}` (NOT a V2-style synthetic sqrt — the current code misprices a stable pool); add
`buildCurveSegments(pool, amountIn)` mirroring `buildRouteBracketsLocal` — sample a verbatim bigint replay
of `get_D`/`get_y`/`get_dy` at M geometric cumulative inputs (no extra RPC), emit `(Δinput, effOut,
marginalOI)` in descending-marginal order; these enter the same segment array the merge consumes (the k-way
merge is type-agnostic once segments are in out/in space). Oracle: add `curveSegments()` to
`ecoswap.optimal.ts` driven by the same bigint replay. **Caveat — the one place Curve is strictly weaker
than V2/V3**: the per-pool `dy` for the awarded share is wei-exact (one atomic `exchange(i,j,Σslice,0)`),
but the *split allocation* equalizes marginals on the sampled grid, so the global cut can be off by up to
one slice — bounded `O(curvature·maxSlice)`, negligible near peg, tightened by `M≈16–32`. This must be
documented as exact-in-dy / exact-on-grid, not closed-form-exact. Tests: a prod-mirror etching a real
StableSwap runtime+state, asserting Curve leg `dy == get_dy(share)` to the wei and marginals equalize within
the grid bound; a `curveDy` known-answer block.

**6. DODO V2 PMM (L) and Trader Joe LB (M–L).** Both callback-free with live `_swap*` branches, both fit
the sampled-segment approach. **LB is the cleaner fit**: each bin is a constant-sum segment at a fixed price
→ a `lbSegments()` oracle is trivially exact (one flat segment per bin), no sampling error. **Integration**
(both): extend the `SwapParams` plumbing to carry the source-specific fields (DODO base/quote orientation;
LB bin step), emit sampled/per-bin segments into the merge, add the oracle analogue, one EVM test each. DODO
is L (PMM `R`/`k` state + orientation); LB is M–L (clean oracle, but native `swap` wiring + engine-path
confirm). Sequence DODO/LB after Curve since they reuse the exact same `buildCurveSegments`-style sampler
and `SwapParams` extension work.

---

## 3. Blocked / needs-engine-change

Each item here needs work in the **private `../sauce` engine repo** (a new dispatch branch and/or a new
`SwapPoolType` enum value added in lockstep with `shared/constants.ts`), or has a structural property that
defeats the wei-exact charter.

**Algebra forks — execution needs an engine `algebraSwapCallback` handler.**
- *Discover + price is tractable now* (§2.4, done). Only EXECUTION is blocked.
- Engine: Algebra's pool `swap(address recipient, bool zeroToOne, int256 amountRequired, uint160
  limitSqrtPrice, bytes data)` is **selector-identical to Uniswap V3**, so `_swapV3`'s
  `IUniswapV3Pool(pool).swap(...)` dispatches fine to an Algebra pool. The blocker is the **callback**: mid-swap
  the pool re-enters the caller via `algebraSwapCallback(int256,int256,bytes)` to pull input — a *different
  selector* than the `uniswapV3SwapCallback`/`pancakeV3SwapCallback` the Router implements. The Router has **no
  `algebraSwapCallback` handler and no `fallback()`** (only `receive() external payable {}`), so the re-entry
  reverts and the whole `cook()` reverts. (Evidence: pinned `sauce` engine `engine/src/Router.sol` — callbacks
  at `uniswapV3SwapCallback` L328 / `pancakeV3SwapCallback` L338 / `unlockCallback` L487 / `maverickV2SwapCallback`
  L1168 only; `receive()` L71, no fallback; `_swapV3` L271 uses the Uniswap `swap` ABI.)
- Fix: a one-line engine addition — `function algebraSwapCallback(int256 a0, int256 a1, bytes calldata)
  external { _handleV3Callback(a0, a1); }` (the transient-context auth + pull logic is already factored into
  `_handleV3Callback`, identical to the Uniswap/Pancake callbacks). No new `SwapPoolType`, no curve work — Algebra
  reuses the V3 dispatch and walk verbatim. This is the SAME shape as the Kyber Elastic callback gap, but far
  smaller (Kyber also needs a from-scratch reinvestment curve + a non-Uniswap swap ABI; Algebra needs only the
  callback selector).
- This-repo gate until then: `discoverPools` excludes Algebra; `runLens` defaults `includeAlgebra=false` — so the
  recipe never routes a slice into an Algebra pool it cannot land. Flip both once the engine handler ships.

**KyberSwap Elastic — needs engine PR + a from-scratch wei-exact curve.**
- Engine: no `swapCallback(int256 deltaQty0, int256 deltaQty1, bytes)` handler (Router only has
  `uniswapV3SwapCallback`/`pancakeV3SwapCallback`); and `_swapV3` calls the Uniswap `swap` ABI, not
  Kyber's `swap(recipient, int256 swapQty, bool isToken0, uint160 limitSqrtP, bytes)`. Needs a new
  `_swapKyberElastic` + a `swapCallback` external reusing the transient-context pull logic.
- Curve: a **reinvestment curve** — fees convert to liquidity *within each swap step*, so `reinvestL`
  accretes and the price update uses `L+deltaL`. The constant-L bracket model is **not exact**; both the
  solver and the neutral oracle need a faithful integer port of `SwapMath.computeSwapStep` reproducing
  Kyber's exact rounding (the Nov-2023 exploit was a double-rounding bug here — so bit-exactness is the real
  risk). Discovery also needs Kyber-specific state reads (`getPoolState`/`getLiquidityState`/Kyber `ticks()`,
  fee tiers in units of 100000). The existing `constants.ts` "KyberSwap Elastic = V3Standard/UniV3" entries
  are a **non-functional stub** — they silently find zero pools.
- Recommendation: **defer** unless a chain shows live routable Elastic depth (post-exploit TVL is near-dead).

**EulerSwap — needs engine PR (signed-flash callback) + a new native-price segment family.**
- Engine: no `SwapPoolType.EulerSwap`, no `_swapEulerSwap`. `swap(amount0Out, amount1Out, to, data)` is
  exact-output flash-callback (`eulerSwapCall`) — cannot be serviced from SauceScript. Cleanest engine path
  is the **callback-free prefund variant**: pre-transfer the computed exact input, then `swap(...,"")` with
  empty data (the pool's post-callback `doDeposits` sweeps the balance and `verify` passes) — still an
  engine addition because the engine must compute the input via `fInverse`.
- Curve: closed-form `f`/`fInverse`/`df_dx` (no Newton), fully Sauce-expressible (the only fiddly bit is
  `fInverse`'s overflow-scaling `shift`, which mirrors EcoSwap's existing `isqrt`/`mulDiv`). But the curve
  is **asymmetric** and its marginal `m(x) = (px/py)·[c+(1e18−c)(x0/x)²]/1e18` is **not** `(out/in sqrt)²`-
  shaped — it does NOT embed into the V2≡V3 unification. It needs its own `eulerSwapSegments()` family
  (price-bucketed slices, invert `m(x)=p_target` closed-form), wired into oracle + solver-reference + the
  on-chain solver, cross-checked wei-exact across two unrelated price parameterizations.
- Extra structural blocker: depth is gated by **live Euler vault cash/borrow capacity**, not held reserves
  — an external ceiling that can *shrink* between prepare and cook (`verify` could fail), needing a guarded
  terminal-refund treatment. Discovery has no pair-keyed factory getter (must enumerate factory instances
  via events/registry).

**Curve CryptoSwap (tricrypto/twocrypto) — engine ABI mismatch.** `exchange(uint256 i, uint256 j, …)` vs
the engine's `ICurvePool.exchange(int128, int128, …)`. Needs a new `_swapCryptoCurve` (uint256 indices) +
a new `SwapPoolType`, plus the harder crypto invariant (`newton_y` + price-scale `tweak_price`) in the
oracle. Math is bounded-Newton and Sauce-expressible; the sampled-segment oracle is the same shape as
StableSwap.

**Balancer V2 weighted — discovery missing + fractional-power math.** `_swapBalancerV2` is dispatched but
discovery is a literal `[]` stub, and the weighted-math `aOut = bOut·(1−(bIn/(bIn+aIn(1−fee)))^(wIn/wOut))`
needs a **fractional power** on fixed-point, which is outside the compiler's intrinsic set (`Math.mulDiv`/
`Math.neg` only) and admits only an **approximate** oracle (fractional-power rounding error). XL; defer.

**Maverick V2 — callback + directional bins, no clean monotone integration.** `maverickV2SwapCallback`
(needs router path; currently emits placeholder `sqrtPriceX96=1n`). Directional bin AMM with no clean
constant-L decomposition. XL.

**Fermi / propAMM and WOOFi — out of charter (oracle-priced, exogenous state).** Both price off an external
oracle/MM feed that is **not in canonical chain state** and **changes independent of trades**. There is no
drift-invariant analogue to V3 `liquidityNet`, so no static on-chain curve to walk and no neutral
solver-independent oracle is definable — any prepared segment is stale on a sub-second horizon. The curve
*math* is closed-form and Sauce-expressible (Fermi: Obric `K=v0²·multX/multY`; WOOFi: sPMM), and execution
is callback-free, but the **state is the disqualifier**, not the math. Both could be integrated as
**best-effort off-chain quote sources** (Fermi via Titan `titan_getPammStateOverrides` state-override
quoting; WOOFi via `query`) competing in the merge as static quote segments with `amountOutMin` slippage
protection — but that **abandons the wei-exact-vs-neutral-oracle guarantee** and is explicitly *not* held
to the project's standard. Classify as out of scope for the wei-exact charter (effort L if pursued as a
best-effort quote source; N/A as a wei-exact source).

---

## 4. Open questions for the user

1. **Engine PR appetite.** Tier A/B are this-repo-only. Kyber Elastic, EulerSwap, CryptoSwap each need a
   `../sauce` engine branch + a new `SwapPoolType`. Are engine changes in scope for this effort, and who
   owns/reviews them?
2. **Wei-exact bar for sampled curves.** Curve (and DODO/CryptoSwap) are wei-exact in per-pool `dy` but
   **exact-on-grid** for the split allocation (bounded `O(curvature·maxSlice)`). Is "exact-in-dy /
   exact-on-grid, tight tunable bound" acceptable under the charter, or must every source be closed-form
   exact (which would exclude Curve)?
3. **Best-effort quote sources.** Should Fermi/WOOFi be integrated at all as non-wei-exact off-chain quote
   sources for better fill quality, or stay strictly out (preserving the proof standard)?
4. **Target chains + depth priority.** Which chains/pairs actually have routable depth in the candidate
   sources? This decides whether Kyber Classic, DODO, LB, or Curve is worth doing first (the matrix ranks by
   effort, not by live TVL — e.g. Elastic is near-dead, Curve depth is chain-specific).
5. **Per-pool slippage.** `_swapCurve` passes `min_dy=0` (no pool-level floor; relies on the recipe terminal
   guard). Acceptable, or do we want per-leg floors threaded through the new `SwapParams` fields?
6. **SauceScript vs router for callback-free non-V2 sources.** Kyber Classic / V2-non-30bps can run via the
   in-SauceScript `transfer + pool.swap` path (no engine change). Is that preferred over extending the
   engine, given it keeps the engine surface small but duplicates settlement logic in bytecode?
