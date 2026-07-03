/**
 * WOOFi (WooPPV2 synthetic proactive market maker, sPMM v2) — VERBATIM bigint replay + off-chain
 * segment sampler.
 *
 * THE SINGLE SOURCE for WOOFi swap math. Imported by BOTH:
 *   - the production `prepare.ts` (buildWooFiSegments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (wooFiSegments),
 * so the split is exact-on-grid vs the oracle by construction (one replay), and the per-pool
 * executed output == query(awarded share) to the wei (one atomic pool.swap).
 *
 * THE WOOFi MATH IS OFF-CHAIN ONLY (for the SPLIT). The on-chain solver does NOT recompute the sPMM
 * closed form — it samples the curve OFF-CHAIN into (capacity, effOut, marginalOI) SEGMENTS via this
 * exact replay, consumes them as STATIC segments through the existing static-segment cursor (the same
 * machinery the merge uses for route / Curve / DODO / Wombat / Solidly-stable segments), and EXECUTES
 * each WOOFi pool CALLBACK-FREE: an on-chain `pool.query(fromToken, toToken, awardedShare)` staticcall
 * (which reads the LIVE WooracleV2 price/spread/coeff) yields the EXACT toAmount (the pool view == the
 * pool swap math), the awarded input is TRANSFERRED to the pool (WooPPV2 is transfer-first — it computes
 * the sold amount from balanceOf(fromToken) − reserve), and `pool.swap(fromToken, toToken, fromAmount,
 * minToAmount, to, rebateTo)` lands the swap. No engine SwapPoolType is needed (WOOFi is an oracle-priced
 * PMM, NOT xy=k, so the V2/UniV2 _swapV2 path mis-prices it — the engine's _swapWOOFi dispatch exists
 * but is not required, since the swap is callback-free).
 *
 * SOURCE MIRRORED — the canonical woonetwork/WooPoolV2 `WooPPV2.sol` + `IWooracleV2_2`. Reproduced
 * bit-for-bit. WOOFi is a BASE/QUOTE PMM: `quoteToken` is the pool-wide numeraire (usually USDC);
 * every other supported token is a `baseToken` priced by WooracleV2 against the quote. A swap is one
 * of three legs — sell base (base→quote), sell quote (quote→base), or base→base (two chained legs). We
 * support the DIRECT base↔quote legs (a base→base pair is out of scope for a single oracle-priced
 * replay — it is two sPMM legs and would double-count the quote reserve).
 *
 * Oracle State (IWooracleV2_2.state(baseToken)) — `price` (uint128, scaled by `priceDec` =
 * 10**oracle.decimals(base), canonically 1e8), `spread` (uint64, 1e18-WAD), `coeff` (uint64, 1e18-WAD),
 * `woFeasible` (bool). DecimalInfo — priceDec = 1e8, quoteDec = 10**quote.decimals(), baseDec =
 * 10**base.decimals(). feeRate is per-base-token (1e5-scaled, i.e. 0.025% = 25).
 *
 * SELL BASE (base→quote) — `_calcQuoteAmountSellBase` then the `_tryQuerySellBase` fee (off the OUTPUT):
 *   gamma       = (baseAmount·price·coeff) / priceDec / baseDec
 *   quoteAmount = ((baseAmount·price·quoteDec) / priceDec)·(1e18 − gamma − spread) / 1e18 / baseDec
 *   fee         = quoteAmount·feeRate / 1e5
 *   toAmount    = quoteAmount − fee
 *
 * SELL QUOTE (quote→base) — the `_tryQuerySellQuote` fee (off the INPUT) then `_calcBaseAmountSellQuote`:
 *   swapFee     = quoteAmount·feeRate / 1e5
 *   q           = quoteAmount − swapFee
 *   gamma       = (q·coeff) / quoteDec
 *   baseAmount  = ((q·baseDec·priceDec) / price)·(1e18 − gamma − spread) / 1e18 / quoteDec
 *   toAmount    = baseAmount
 * Each mulDiv term is a plain integer divide (truncate-toward-zero), matching the Solidity `/` bit-for-bit.
 *
 * The replay is CLOSED-FORM (a handful of muls/divs) — NO Newton, NO loop. It runs purely on the SNAPSHOT
 * oracle state (price, spread, coeff) + the token decimals + feeRate; buildWooFiSegments makes NO extra RPC.
 *
 * WEI-EXACT BOUND (the oracle-snapshot model — read this). WOOFi prices off its on-chain WooracleV2 feed,
 * which is canonical chain state we read too. So per-pool EXECUTION is WEI-EXACT-IN-DY: the on-chain
 * `query(fromToken, toToken, awarded)` reads the LIVE oracle and returns the EXACT toAmount the `swap`
 * pays (WooPPV2.swap calls the same _calc*), and we pass that as minToAmount. The SPLIT is
 * EXACT-ON-GRID-AT-SNAPSHOT: the oracle `ecoswap.optimal.ts` reads the SAME oracle-price SNAPSHOT (price/
 * spread/coeff) this replay uses, so solver == oracle bit-for-bit at that snapshot. The ONLY residual is
 * EXOGENOUS: the WooracleV2 price can move between prepare and cook (a keeper posts a new price). Then the
 * split is optimal at the SNAPSHOT price, NOT the cook-time price — the SAME class of assumption the recipe
 * already documents for the V3/Algebra fee snapshot and the Balancer/Curve state snapshot. For a WOOFi
 * stablecoin pair (the common base↔quote leg, e.g. USDC↔USDT) the price is pinned near 1e8 and moves by
 * bps-tiny amounts; amountOutMin (on the whole trade) + the solver's guarded terminal refund bound a bad
 * fill. So: EXACT-IN-DY at the live oracle, EXACT-ON-GRID at the snapshot. Marginal equalization across
 * pools is a DIAGNOSTIC (a grid bound), not the wei gate.
 *
 * EXEC-TIME CAPS (modeled, not a residual). WooPPV2's shared `_calc*` view path — reached by BOTH the
 * on-chain query() staticcall and the swap — require()s notionalSwap <= tokenInfos[base].maxNotionalSwap
 * and gamma <= tokenInfos[base].maxGamma. The exec's query() is unguarded, so an award past either cap
 * would revert the whole cook. `buildWooFiSegments` TRUNCATES the sampled ladder at `wooFiInputCap`, so
 * the merge can never award a pool more than its query view can price (mirrors the EulerSwap inLimit bound).
 *
 * Sources:
 *   https://github.com/woonetwork/WooPoolV2/blob/main/contracts/WooPPV2.sol            (_calcQuoteAmountSellBase / _calcBaseAmountSellQuote / _tryQuerySellBase / _tryQuerySellQuote / swap)
 *   https://github.com/woonetwork/WooPoolV2/blob/main/contracts/interfaces/IWooracleV2_2.sol  (State{price,spread,coeff,woFeasible})
 */

import { pushMonotoneSegment, type MergeSegment } from "./segment-merge.js";
import { buildQLLadder } from "./curve-math.js";

/** 2^192 — the unified out/in sqrt fixed-point scale (matches the other *-math modules' Q192). */
export const Q192 = 1n << 192n;

/** WooPPV2 internal WAD — 1e18 (spread/coeff and the (1e18 − gamma − spread) term are all WAD). */
export const WOO_WAD = 10n ** 18n;

/** WooPPV2 fee scale — feeRate is 1e5-scaled (0.025% = 25). */
export const WOO_FEE_SCALE = 10n ** 5n;

/** Integer square root (Babylonian) — bit-identical to the other *-math modules' `isqrt`. */
export function isqrt(x: bigint): bigint {
  if (x <= 0n) return 0n;
  let z = x;
  let y = (z + 1n) / 2n;
  while (y < z) {
    z = y;
    y = (x / y + y) / 2n;
  }
  return z;
}

/**
 * One discovered WOOFi pool (WooPPV2 singleton), oriented for a tokenIn → tokenOut swap.
 *
 * WooPPV2 is a base/quote PMM: `quoteToken` is the pool numeraire; a base token is priced by
 * WooracleV2 against the quote. This descriptor is for ONE direct base↔quote leg — `sellBase` says
 * whether tokenIn is the base (base→quote) or the quote (quote→base). The oracle STATE fields
 * (price/spread/coeff) are a SNAPSHOT read at prepare time; the on-chain execution re-reads them LIVE
 * via `query`, so these feed only the off-chain sampler (the split). All fields are OFF-CHAIN ONLY.
 */
export interface WooFiPool {
  /** Pool address — the WooPPV2 query/swap/transfer target. */
  address: `0x${string}`;
  /** The pool's tokenIn (the from-token the swap call needs) == the EcoSwap tokenIn. */
  tokenIn: `0x${string}`;
  /** The pool's tokenOut (the to-token the swap call needs) == the EcoSwap tokenOut. */
  tokenOut: `0x${string}`;
  /** true ⇒ tokenIn is the pool's BASE token (base→quote, sell base); false ⇒ tokenIn is the quote (sell quote). */
  sellBase: boolean;
  /** SNAPSHOT WooracleV2 price of the BASE token (scaled by priceDec). */
  price: bigint;
  /** SNAPSHOT WooracleV2 spread of the BASE token (WAD). */
  spread: bigint;
  /** SNAPSHOT WooracleV2 coeff (k) of the BASE token (WAD). */
  coeff: bigint;
  /** 10**oracle.decimals(base) — the price scale (canonically 1e8). */
  priceDec: bigint;
  /** 10**quoteToken.decimals(). */
  quoteDec: bigint;
  /** 10**baseToken.decimals(). */
  baseDec: bigint;
  /** Per-base-token feeRate (1e5-scaled; 0.025% = 25). */
  feeRate: bigint;
  /**
   * tokenInfos(base).maxNotionalSwap (uint128) — WooPPV2's per-swap notional cap. `_calc*` (used by
   * BOTH the swap and the query view) require()s notionalSwap <= this; 0n ⇒ unknown/uncapped (no bound).
   */
  maxNotionalSwap?: bigint;
  /**
   * tokenInfos(base).maxGamma (uint128) — WooPPV2's per-swap gamma cap. `_calc*` require()s
   * gamma <= this; 0n ⇒ unknown/uncapped (no bound).
   */
  maxGamma?: bigint;
  /** Rounded ppm fee (the price-ordering coordinate / diagnostic). */
  feePpm: number;
  /** Discovery source label. */
  source: string;
}

/**
 * The largest tokenIn `dx` that keeps BOTH WooPPV2 caps satisfied — the notionalSwap and gamma
 * require()s in the shared `_calc*` view path (so the on-chain `query()` staticcall the exec makes does
 * NOT revert). Returns the given `fallbackMax` when neither cap is known (0n ⇒ uncapped). Mirrors the
 * EulerSwap `inLimit` bound: an EXEC-time hard bound folded into the off-chain sampler so the split
 * never awards a share the pool would revert on.
 *
 * sellBase (dx = baseAmount):
 *   notionalSwap = dx·price·quoteDec / baseDec / priceDec ≤ maxNotionalSwap
 *   gamma        = dx·price·coeff   / priceDec / baseDec  ≤ maxGamma
 * sellQuote (dx = quoteAmount):
 *   notionalSwap = dx ≤ maxNotionalSwap
 *   gamma        = dx·coeff / quoteDec ≤ maxGamma
 * Each solved for dx by inverting the same truncating integer arithmetic (conservative — a floor keeps
 * the recomputed cap ≤ the on-chain require bound).
 */
export function wooFiInputCap(pool: WooFiPool, fallbackMax: bigint): bigint {
  let cap = fallbackMax;
  const notional = pool.maxNotionalSwap ?? 0n;
  const gammaMax = pool.maxGamma ?? 0n;
  if (pool.sellBase) {
    if (notional > 0n && pool.price > 0n) {
      const dx = (notional * pool.baseDec * pool.priceDec) / (pool.price * pool.quoteDec);
      if (dx < cap) cap = dx;
    }
    if (gammaMax > 0n && pool.price > 0n && pool.coeff > 0n) {
      const dx = (gammaMax * pool.priceDec * pool.baseDec) / (pool.price * pool.coeff);
      if (dx < cap) cap = dx;
    }
  } else {
    if (notional > 0n && notional < cap) cap = notional;
    if (gammaMax > 0n && pool.coeff > 0n) {
      const dx = (gammaMax * pool.quoteDec) / pool.coeff;
      if (dx < cap) cap = dx;
    }
  }
  return cap > 0n ? cap : 0n;
}

/**
 * query(pool, dx) — the EXACT toAmount for `dx` tokenIn (native decimals), INCLUDING the swap fee.
 * Mirrors WooPPV2._tryQuerySellBase (base→quote) / _tryQuerySellQuote (quote→base) bit-for-bit at the
 * SNAPSHOT oracle state. The realized swap output equals this to the wei when the oracle has not moved
 * (WooPPV2.swap calls the same _calc*). Returns 0 on a zero/negative amount, an infeasible oracle, or a
 * gamma/spread that drives the (1e18 − gamma − spread) factor non-positive (the pool would revert).
 *
 * EXEC-TIME CAPS (modeled, not a residual). WooPPV2's shared `_calc*` view path — reached by BOTH the
 * swap and the on-chain query()/tryQuery() staticcall — require()s notionalSwap <= maxNotionalSwap and
 * gamma <= maxGamma; the real deployed tryQuery returns 0 past either cap (the QL ladder self-truncates
 * there). This replay models the SAME bound via the single-source `wooFiInputCap` (also used by
 * buildWooFiSegments), so the off-chain `query` returns 0 exactly where the on-chain tryQuery does — the
 * off-chain ladder / neutral oracle stay in lockstep with the solver's live tryQuery even when the geometric
 * grid would cross a cap, not just for a within-cap size. A 0 cap ⇒ uncapped (the local fixture omits caps ⇒
 * no truncation; unchanged). `wooFiInputCap`'s floor inversion can differ from the forward require by ≤1 wei
 * at the exact boundary; no ladder point lands there, and it is the same bound the sampled path already uses.
 */
export function query(pool: WooFiPool, dx: bigint): bigint {
  if (dx <= 0n) return 0n;
  if (pool.price <= 0n) return 0n;
  // Self-truncate at the notionalSwap/maxGamma caps (matches the on-chain tryQuery's 0-return past a cap).
  if (wooFiInputCap(pool, dx) < dx) return 0n;

  if (pool.sellBase) {
    // base → quote: _calcQuoteAmountSellBase, then fee off the OUTPUT.
    const gamma = (dx * pool.price * pool.coeff) / pool.priceDec / pool.baseDec;
    const factor = WOO_WAD - gamma - pool.spread;
    if (factor <= 0n) return 0n;
    let quoteAmount =
      (((dx * pool.price * pool.quoteDec) / pool.priceDec) * factor) / WOO_WAD / pool.baseDec;
    const fee = (quoteAmount * pool.feeRate) / WOO_FEE_SCALE;
    quoteAmount = quoteAmount - fee;
    return quoteAmount > 0n ? quoteAmount : 0n;
  }

  // quote → base: fee off the INPUT, then _calcBaseAmountSellQuote.
  const swapFee = (dx * pool.feeRate) / WOO_FEE_SCALE;
  const q = dx - swapFee;
  if (q <= 0n) return 0n;
  const gamma = (q * pool.coeff) / pool.quoteDec;
  const factor = WOO_WAD - gamma - pool.spread;
  if (factor <= 0n) return 0n;
  const baseAmount =
    (((q * pool.baseDec * pool.priceDec) / pool.price) * factor) / WOO_WAD / pool.quoteDec;
  return baseAmount > 0n ? baseAmount : 0n;
}

/**
 * One sampled WOOFi segment in unified out/in price space — identical shape to a Curve / DODO / Wombat /
 * route segment (a flat [capacity, marginalOI] slice). `capacity` is the Δinput (tokenIn) for this slice,
 * `effOut` the Δoutput, and `marginalOI` the unified out/in sqrt = isqrt(effOut·2^192/capacity) — the
 * price-ordering coordinate. Segments are emitted DESCENDING in `marginalOI` (the sPMM curve steepens with
 * size via gamma, so the first slice is best-priced).
 *
 * fee-adjust: marginalOI is computed from the POST-FEE dy (query already nets the swap fee), so it is
 * ALREADY the fee-adjusted execution price — it enters the merge's descending-price sort directly (no
 * extra sqrtOneMinusFee multiply), exactly like Curve / DODO / Wombat / Solidly segments.
 */
export interface WooFiSegment extends MergeSegment {
  /** Δinput (tokenIn) to traverse this slice. */
  capacity: bigint;
  /** Δoutput (tokenOut) over this slice. */
  effOut: bigint;
  /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
  marginalOI: bigint;
}

/** Default sample count per WOOFi pool (M). Tunable; M≈24 tightens the grid bound. */
export const WOOFI_SAMPLES = Number(process.env.ECO_WOOFI_SAMPLES ?? 24);

/**
 * Sample a WOOFi pool into M descending-marginal segments over [0, amountIn].
 *
 * Geometric-ish cumulative inputs (∝ s^2 — denser near 0 where the curve is flattest, then bends via
 * gamma), each replayed through `query` on the SNAPSHOT oracle state (NO extra RPC — pure closed-form
 * bigint). Each increment becomes a (capacity=Δin, effOut=Δout, marginalOI) segment. The samples are
 * monotone in input so the marginals are naturally descending; a non-descending slice (rounding noise,
 * or past the point where the (1e18−gamma−spread) factor collapses) is FOLDED into the last segment
 * (isotonic backward-merge — capacity + effOut conserved, blended marginal recomputed) so the merge stays
 * monotone price-ordered without discarding liquidity. See shared/segment-merge.ts.
 *
 * Exact-on-grid-at-snapshot: the split equalizes marginals on THIS sampled grid (priced at the snapshot
 * oracle); the per-pool out for the awarded Σ share is re-evaluated wei-exact by one atomic on-chain
 * query(Σ share) at execution against the LIVE oracle. Mirrors `buildWombatSegments` / `buildDodoSegments`
 * (same squared-index geometric grid + isotonic backward-merge).
 *
 * The ladder is TRUNCATED at `wooFiInputCap` — the largest dx WooPPV2's shared `_calc*` view path accepts
 * before its notionalSwap / gamma require()s trip. The on-chain exec makes an UNGUARDED `query(awarded)`
 * staticcall, so an award beyond the cap would revert the whole cook; capping the sampled capacity here
 * bounds the awardable Σ so the merge never hands a pool more than its query view can price. Mirrors the
 * EulerSwap inLimit bound. (0n caps ⇒ unknown/uncapped ⇒ no truncation, the prior behavior.)
 */
/**
 * Build one WOOFi pool's QUOTE-LADDER — the SHARED curve-agnostic `buildQLLadder` recurrence
 * (curve-math.ts) driven by the bigint `query`, so the oracle stays wei-exact with the on-chain solver by
 * construction. The solver builds the IDENTICAL geometric ladder live from the pool's own tryQuery, and
 * tryQuery's amountOut equals query's toAmount for any FEASIBLE amount (both call the same _calc* sPMM
 * math — tryQuery merely skips the reverting reserve check that `query` adds), so `query` is the faithful
 * off-chain model. query is post-fee (it nets the swap fee) so marginalOI IS the execution price. Emits
 * the same {capacity, effOut, marginalOI} slices the static-segment cursor consumes. The driving `query`
 * MODELS WooPPV2's exec-time caps (notionalSwap/maxGamma, via `wooFiInputCap`) and returns 0 past them —
 * the SAME point the on-chain tryQuery self-truncates — so the ladder stops in lockstep with the solver
 * even when the geometric grid would cross a cap (0 caps ⇒ uncapped ⇒ no truncation, the fixture case).
 */
export function buildWooFiQLLadder(pool: WooFiPool, amountIn: bigint): WooFiSegment[] {
  return buildQLLadder((dx) => query(pool, dx), amountIn);
}

export function buildWooFiSegments(
  pool: WooFiPool,
  amountIn: bigint,
  samples: number = WOOFI_SAMPLES,
): WooFiSegment[] {
  if (amountIn <= 0n) return [];
  const capped = wooFiInputCap(pool, amountIn);
  if (capped <= 0n) return [];
  amountIn = capped;
  const M = BigInt(samples);
  const segs: WooFiSegment[] = [];
  let prevIn = 0n;
  let prevOut = 0n;
  for (let s = 1; s <= samples; s++) {
    const ss = BigInt(s);
    const input = (amountIn * ss * ss) / (M * M);
    if (input <= prevIn) continue;
    const out = query(pool, input);
    if (out <= 0n) continue;
    const dIn = input - prevIn;
    const dOut = out - prevOut;
    if (dIn > 0n && dOut > 0n) {
      const marginalOI = isqrt((dOut * Q192) / dIn);
      // Isotonic backward-merge (liquidity-preserving) — a non-descending slice is FOLDED into the
      // last segment, not dropped, so no liquidity is discarded. See shared/segment-merge.ts.
      pushMonotoneSegment(segs, dIn, dOut, marginalOI);
    }
    prevIn = input;
    prevOut = out;
  }
  return segs;
}
