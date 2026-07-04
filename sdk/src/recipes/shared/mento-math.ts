/**
 * Mento V2 (Celo stablecoin exchange — mento-protocol/mento-core Broker + BiPoolManager) — off-chain
 * segment builder over a LIVE on-chain quote ladder.
 *
 * THE SINGLE SOURCE for how a Mento venue is turned into split segments. Imported by BOTH:
 *   - the production `prepare.ts` (buildMentoSegments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (mentoSegments),
 * so the split is exact-on-grid vs the oracle by construction (one shared ladder → one segmentation).
 *
 * REAL ON-CHAIN SURFACE (VERIFIED against mento-core + Celoscan — no fabricated getters). Mento V2 is a
 * BiPool exchange: an on-chain Broker singleton routes swaps to a registered exchange provider
 * (BiPoolManager) that prices each exchange off oracle rates + a spread over two interval-updated pricing
 * buckets. The verified surface is:
 *   Broker (BrokerProxy 0x777A8255cA72412f0d706dc03C9D1987306B4CaD):
 *     getAmountOut(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut,
 *                  uint256 amountIn) view -> (uint256 amountOut)
 *       — a PLAIN deterministic VIEW at the CURRENT bucket state (oracle + spread). Usable as BOTH the
 *         off-chain sampling quote AND the on-chain per-slice amountOutMin source (no revert-decode
 *         resolver needed — simpler than Fluid).
 *     swapIn(address exchangeProvider, bytes32 exchangeId, address tokenIn, address tokenOut,
 *            uint256 amountIn, uint256 amountOutMin) nonReentrant -> (uint256 amountOut)
 *       — pulls tokenIn from msg.sender (transferIn → for a collateral asset safeTransferFrom(msg.sender,
 *         reserve, amount); for a stable asset burns from msg.sender), APPROVE-FIRST (the allowance spender
 *         is the BROKER), sends amountOut to msg.sender (transferOut → mint stable / reserve collateral
 *         transfer). amountOutMin is enforced (slippage guard).
 *     getExchangeProviders() view -> address[]   (discovery step 1 — the registered providers)
 *   IExchangeProvider (BiPoolManager 0x22d9db95E6Ae61c104A7B6F6C78D7993B94ec901):
 *     getExchanges() view -> Exchange[] where struct Exchange { bytes32 exchangeId; address[] assets; }
 *       (assets length 2 for a BiPool exchange; assets[0]/assets[1] are the two exchange assets)
 *       — discovery step 2. An exchange matches (tokenIn,tokenOut) when {tokenIn,tokenOut} ==
 *         {assets[0],assets[1]} (unordered).
 * The mapping (tokenIn,tokenOut) -> (exchangeProvider, exchangeId) is resolved OFF-CHAIN in discovery
 * (nested-dynamic ABI decode of Exchange[]); the on-chain solver then needs only the FLAT
 * getAmountOut/swapIn calls with the discovered (exchangeProvider, exchangeId) threaded as args.
 *
 * WHY A SAMPLED LADDER (not a closed-form replay). BiPoolManager._getAmountOut prices off oracle rates +
 * spread over pricing buckets (bucket0/bucket1) that refresh only every config.referenceRateResetFrequency
 * (gated by config.minimumReports oracle updates). Between refreshes the buckets are constant and the AMM
 * behaves like a constant-product pool over the current bucket amounts plus a spread — but the bucket state
 * is not a simple pair→pool getter, so prepare SAMPLES getAmountOut over [0, amountIn] and builds
 * descending-marginal segments from that ladder (NO further RPC, so the oracle shares them).
 *
 * ON-CHAIN EXECUTION is CALLBACK-FREE (Mento's swapIn re-enters only the Reserve / stable-asset mint-burn,
 * never the cooking contract — like V2/Curve/DODO/Fluid/Fermi): the solver re-reads the out for the awarded
 * share LIVE via `broker.getAmountOut(exchangeProvider, exchangeId, tokenIn, tokenOut, +share)`, APPROVES
 * the BROKER for the input (Mento PULLS via transferFrom into the reserve — approve-first, like
 * Fermi/Wombat/Curve/Fluid, NOT transfer-first like WOOFi), then calls
 * `broker.swapIn(exchangeProvider, exchangeId, tokenIn, tokenOut, +share, amountOutMin)` with amountOutMin
 * == the live quote.
 *
 * WEI-EXACTNESS CLASS — SNAPSHOTTED-QUOTE (interval-updated buckets; same family as Fluid/WOOFi). The split
 * is priced off the LIVE getAmountOut ladder sampled at prepare time (a SNAPSHOT of the current bucket
 * state), so:
 *   - the SPLIT is EXACT-ON-GRID-AT-SNAPSHOT — the oracle segments the SAME sampled ladder, so solver ==
 *     oracle bit-for-bit on that grid;
 *   - per-pool EXECUTION re-reads the out via the LIVE getAmountOut view and passes it as `amountOutMin`,
 *     so the realized out equals the live quote for the awarded share and a bad fill is bounded by
 *     amountOutMin (per pool) + the whole-trade amountOutMin + the solver's guarded terminal refund.
 * IMPORTANT nuance: getAmountOut is `view` and does NOT persist a bucket update. A real swapIn CAN trigger a
 * bucket refresh (state-changing) when the reset frequency + oracle-report gates are met, after which
 * subsequent quotes shift — so consecutive slices in ONE tx do NOT see independent depth the way separate
 * blocks would if a reset boundary is crossed, and a stale reference rate near a reset boundary can move the
 * realized price vs. an earlier off-chain quote. This residual is EXOGENOUS (like the Fluid layer accruing /
 * the WOOFi oracle moving) and bounded by the conservative amountOutMin. swapIn is also subject to per-
 * exchange TradingLimits + the BreakerBox circuit breakers, which getAmountOut does NOT check: the live
 * quote can succeed while the swapIn a moment later REVERTS (a limit-exceeding slice or a tripped breaker)
 * — and that revert aborts the WHOLE cook (atomic all-or-nothing); the terminal refund never runs, it is
 * NOT a per-venue skip. Sizing slices under the limits at prepare time is the only mitigation.
 *
 * Sources (VERIFIED):
 *   https://github.com/mento-protocol/mento-core/blob/main/contracts/swap/Broker.sol            (swapIn / getAmountOut / getExchangeProviders / transferIn / transferOut)
 *   https://github.com/mento-protocol/mento-core/blob/main/contracts/interfaces/IBroker.sol      (getAmountOut 5-arg, swapIn 6-arg)
 *   https://github.com/mento-protocol/mento-core/blob/main/contracts/interfaces/IExchangeProvider.sol  (struct Exchange { bytes32 exchangeId; address[] assets; }, getExchanges())
 *   https://github.com/mento-protocol/mento-core/blob/main/contracts/swap/BiPoolManager.sol       (getExchanges body, _getAmountOut → updateBucketsIfNecessary, referenceRateResetFrequency/minimumReports)
 *   Celoscan Broker (verified proxy): https://celoscan.io/address/0x777a8255ca72412f0d706dc03c9d1987306b4cad
 *   Celoscan BiPoolManager (verified proxy): https://celoscan.io/address/0x22d9db95e6ae61c104a7b6f6c78d7993b94ec901
 */

import { pushMonotoneSegment, type MergeSegment } from "./segment-merge.js";
import { buildQLLadder } from "./curve-math.js";

/** 2^192 — the unified out/in sqrt fixed-point scale (matches the other *-math modules' Q192). */
export const Q192 = 1n << 192n;

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
 * One discovered Mento V2 venue (a Broker + a resolved BiPool exchange for the direct tokenIn→tokenOut
 * leg), oriented for the swap. The BiPoolManager prices off oracle rates + a spread over interval-updated
 * buckets — not a simple pair→pool getter — so this descriptor carries a LIVE QUOTE LADDER sampled at
 * discovery: cumulative (cumIn, cumOut) points from `broker.getAmountOut(exchangeProvider, exchangeId,
 * tokenIn, tokenOut, +cumIn)`, ascending in cumIn. `buildMentoSegments` differences the ladder into
 * descending-marginal segments with NO further RPC (so the oracle shares them). All fields are OFF-CHAIN
 * ONLY (the split); the on-chain execution re-reads the exact out LIVE via the same Broker view.
 */
export interface MentoPool {
  /** Broker (BrokerProxy) address — the getAmountOut / swapIn / approve target. */
  broker: `0x${string}`;
  /** The resolved exchange provider (e.g. the BiPoolManager) for this exchange — a getAmountOut/swapIn arg. */
  exchangeProvider: `0x${string}`;
  /** The resolved exchange id (bytes32) for this (tokenIn,tokenOut) pair — a getAmountOut/swapIn arg. */
  exchangeId: `0x${string}`;
  /** The venue's tokenIn (the from-token the swap call needs) == the EcoSwap tokenIn. */
  tokenIn: `0x${string}`;
  /** The venue's tokenOut (the to-token the swap call needs) == the EcoSwap tokenOut. */
  tokenOut: `0x${string}`;
  /** LIVE quote ladder: ascending cumulative input samples (native tokenIn decimals). */
  cumIn: bigint[];
  /** LIVE quote ladder: the `getAmountOut(provider, id, tokenIn, tokenOut, +cumIn[i])` for each cumIn[i]. */
  cumOut: bigint[];
  /**
   * Effective per-venue fee/spread in ppm, DERIVED from the sampled ladder for price-ordering / diagnostics
   * only (the exchange folds the spread into the quote — there is no fee getter on the Broker path). 0 when
   * unknown.
   */
  feePpm: number;
  /**
   * OPTIONAL closed-form bucket model — the FIXTURE / test-oracle quote source. Present ONLY when the venue's
   * getAmountOut is a deterministic closed form (the MentoBroker.sol fixture; see `mentoQuoteClosed`). When
   * set, `buildMentoQLLadder` prices the QL ladder via this exact bigint replay so the neutral oracle stays
   * wei-exact with the on-chain solver's live `broker.getAmountOut` at every ladder point BY CONSTRUCTION —
   * the SAME relationship every other QL venue's closed-form replay has (WOOFi `query`, Curve `get_dy`, …).
   * REAL Mento buckets are NOT a simple closed form (they price off oracle rates + spread over interval-
   * refreshed pricing buckets exposed only via getAmountOut), so a discovered real venue leaves this UNSET and
   * uses the sampled `cumIn`/`cumOut` ladder (interpolation) instead; the real prod-mirror asserts the on-chain
   * ladder against the live Broker view directly, not against this model.
   */
  closed?: MentoClosedModel;
  /** Discovery source label. */
  source: string;
}

/**
 * Closed-form Mento bucket model (the MentoBroker.sol fixture's `_netOut`, VERBATIM). A re-centered oracle
 * rate minus a size-dependent bucket-utilization slippage (dx²/depth) minus the swap spread, capped by a
 * per-direction trading-limit out-cap (past the cap the quote is 0 — the tradeable-range edge). All scales
 * match the fixture: rates/centerPrice 1e18, spreadPpm 1e6-scaled, depth in tokenIn² units (0 ⇒ no slippage),
 * outCap in tokenOut units (0 ⇒ unbounded). This is a deliberate stand-in for real Mento's bucket pricing —
 * used ONLY as the test-fixture / neutral-oracle model, not as a real-Mento replay.
 */
export interface MentoClosedModel {
  /** tokenIn == the exchange's asset0 (asset0 → asset1). */
  zeroForOne: boolean;
  /** Oracle rate for asset0 (1e18). */
  rate0: bigint;
  /** Oracle rate for asset1 (1e18). */
  rate1: bigint;
  /** Re-centering center price (1e18, asset1 per asset0). */
  centerPrice: bigint;
  /** Swap spread, 1e6-scaled (0.01% = 100). */
  spreadPpm: bigint;
  /** Bucket-utilization slippage depth (larger ⇒ flatter); 0 ⇒ none. */
  depth: bigint;
  /** Trading-limit out-cap in the swap direction (0 ⇒ unbounded). */
  outCap: bigint;
}

/** Mento fee scale — feePpm is 1e6-scaled (0.01% = 100). */
export const MENTO_FEE_SCALE = 10n ** 6n;

/**
 * Default sample count per Mento venue (M) — the number of `getAmountOut` eth_calls the discovery sampler
 * issues per venue. Tunable; M≈24 tightens the grid bound at the cost of M RPCs. Also the segment count cap.
 */
export const MENTO_SAMPLES = Number(process.env.ECO_MENTO_SAMPLES ?? 24);

/**
 * Geometric-ish cumulative sample inputs over [0, amountIn] (∝ s^2 — denser near 0 where the curve is
 * flattest). These are the ladder points prepare's discovery sampler feeds to `getAmountOut`; sharing this
 * grid keeps the oracle and prepare on the SAME cumIn points. Strictly ascending, ≤ amountIn.
 */
export function mentoSampleInputs(amountIn: bigint, samples: number = MENTO_SAMPLES): bigint[] {
  if (amountIn <= 0n) return [];
  const M = BigInt(samples);
  const inputs: bigint[] = [];
  let prev = 0n;
  for (let s = 1; s <= samples; s++) {
    const ss = BigInt(s);
    const input = (amountIn * ss * ss) / (M * M);
    if (input > prev) {
      inputs.push(input);
      prev = input;
    }
  }
  return inputs;
}

/**
 * getAmountOut(pool, dx) — the sampled out for cumulative input `dx` by LINEAR INTERPOLATION on the venue's
 * live quote ladder (the ladder is the only Mento bucket state we have off-chain — BiPoolManager exposes no
 * simple pair→pool getter). Exact at a ladder point; interpolated between points. Returns 0 for dx<=0 or an
 * empty ladder. This is a diagnostic / segment-partition helper, NOT a wei-exact swap-math replay — the
 * realized out is the LIVE `broker.getAmountOut` at execution.
 */
export function getAmountOut(pool: MentoPool, dx: bigint): bigint {
  if (dx <= 0n) return 0n;
  const n = pool.cumIn.length;
  if (n === 0) return 0n;
  if (dx <= pool.cumIn[0]) {
    // Linear from origin to the first ladder point.
    return (pool.cumOut[0] * dx) / pool.cumIn[0];
  }
  for (let i = 1; i < n; i++) {
    if (dx <= pool.cumIn[i]) {
      const inLo = pool.cumIn[i - 1];
      const inHi = pool.cumIn[i];
      const outLo = pool.cumOut[i - 1];
      const outHi = pool.cumOut[i];
      const span = inHi - inLo;
      if (span <= 0n) return outHi;
      return outLo + ((outHi - outLo) * (dx - inLo)) / span;
    }
  }
  // Beyond the sampled range — clamp to the last (marginal flattens / the trading limit binds; the split
  // never awards past amountIn).
  return pool.cumOut[n - 1];
}

/**
 * mentoQuoteClosed(model, dx) — the closed-form Broker `getAmountOut` for cumulative input `dx`, a
 * VERBATIM bigint replay of the MentoBroker.sol fixture's `_netOut` (re-centered oracle rate − dx²/depth
 * utilization slippage − spread, capped by the per-direction out-cap). Bit-for-bit with the on-chain view,
 * so a QL ladder driven by it (buildMentoQLLadder) is wei-exact with the solver's live `broker.getAmountOut`.
 * Returns 0 on a non-positive input, a zeroed gross, or a cap breach (the fixture returns 0 past the cap).
 */
export function mentoQuoteClosed(m: MentoClosedModel, dx: bigint): bigint {
  if (dx <= 0n) return 0n;
  const RATE = 10n ** 18n; // RATE_SCALE (fixture)
  const SPREAD = 10n ** 6n; // SPREAD_SCALE (fixture)
  let par: bigint;
  if (m.zeroForOne) {
    const g = (dx * m.rate0) / m.rate1;
    par = (g * m.centerPrice) / RATE;
  } else {
    const g2 = (dx * m.rate1) / m.rate0;
    par = (g2 * RATE) / m.centerPrice;
  }
  if (m.depth !== 0n) {
    const slip = (dx * dx) / m.depth;
    par = par > slip ? par - slip : 0n;
  }
  if (par === 0n) return 0n;
  const spread = (par * m.spreadPpm) / SPREAD;
  const net = par > spread ? par - spread : 0n;
  if (m.outCap !== 0n && net > m.outCap) return 0n;
  return net;
}

/**
 * One sampled Mento segment in unified out/in price space — identical shape to a Curve / DODO / WOOFi /
 * Fermi / Fluid segment (a flat [capacity, marginalOI] slice). `capacity` is the Δinput (tokenIn) for this
 * slice, `effOut` the Δoutput, and `marginalOI` the unified out/in sqrt = isqrt(effOut·2^192/capacity) — the
 * price-ordering coordinate. Segments are emitted DESCENDING in `marginalOI` (a bucket-priced AMM's price
 * worsens with size, so the first slice is best-priced).
 *
 * fee-adjust: marginalOI is computed from the ladder dy, which is the Broker's POST-SPREAD quote (the
 * exchange folds the spread into getAmountOut), so it is ALREADY the fee-adjusted execution price — it
 * enters the merge's descending-price sort directly, exactly like Curve / DODO / WOOFi / Fermi / Fluid
 * segments.
 */
export interface MentoSegment extends MergeSegment {
  /** Δinput (tokenIn) to traverse this slice. */
  capacity: bigint;
  /** Δoutput (tokenOut) over this slice. */
  effOut: bigint;
  /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
  marginalOI: bigint;
}

/**
 * Build Mento segments by DIFFERENCING the venue's pre-sampled live quote ladder (cumIn, cumOut) into
 * descending-marginal (capacity=Δin, effOut=Δout, marginalOI) slices. NO RPC (the ladder was sampled at
 * discovery) — a pure function over the descriptor, so prepare and the oracle produce identical segments
 * from the same ladder. `amountIn` caps the range (the ladder is already sampled over [0, amountIn]). A
 * non-descending slice (rounding noise, or the near-flat/slightly-rising ConstantSum tail at scale) is
 * FOLDED into the last segment (isotonic backward-merge — capacity + effOut conserved, blended marginal
 * recomputed) so the merge stays monotone price-ordered without discarding liquidity. Mirrors
 * `buildFermiSegments` / `buildWooFiSegments` (same isotonic backward-merge). See shared/segment-merge.ts.
 */
export function buildMentoSegments(
  pool: MentoPool,
  amountIn: bigint,
  _samples: number = MENTO_SAMPLES,
): MentoSegment[] {
  if (amountIn <= 0n) return [];
  const n = pool.cumIn.length;
  if (n === 0) return [];
  const segs: MentoSegment[] = [];
  let prevIn = 0n;
  let prevOut = 0n;
  for (let i = 0; i < n; i++) {
    const input = pool.cumIn[i] < amountIn ? pool.cumIn[i] : amountIn;
    if (input <= prevIn) continue;
    const out = getAmountOut(pool, input);
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
    if (pool.cumIn[i] >= amountIn) break;
  }
  return segs;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE-LADDER (QL) — the LIVE-WALK Mento venue. The on-chain solver builds this SAME
// ladder in setup from the LIVE `broker.getAmountOut(provider, exchangeId, tokenIn, tokenOut,
// xNext)` view (PROBE-THEN-DECODE — getAmountOut can revert on a misconfigured exchange), so
// prepare ships ONLY the descriptor and the oracle mirrors it BIT-FOR-BIT here. The ladder step is
// the standard geometric one (cum advances to xNext — Mento absorbs the whole attempt, no partial-
// fill semantics like LB). The constants MUST equal ecoswap.sauce.ts's QL_* literals.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build one Mento venue's QUOTE-LADDER — the shared `buildQLLadder` recurrence (curve-math.ts) driven by
 * the venue's getAmountOut model. When the venue carries a closed-form model (the fixture / test oracle) it
 * uses `mentoQuoteClosed` (a bit-exact replay of the Broker view ⇒ oracle == solver wei-exact by
 * construction); otherwise it falls back to the sampled-ladder interpolation `getAmountOut` (for a real
 * venue whose ladder was pre-sampled at these points). getAmountOut is post-spread (the Broker folds the
 * spread into the quote) so marginalOI IS the execution price. Emits the same {capacity, effOut, marginalOI}
 * slices the static-segment cursor consumes.
 */
export function buildMentoQLLadder(pool: MentoPool, amountIn: bigint): MentoSegment[] {
  const quote = pool.closed
    ? (dx: bigint) => mentoQuoteClosed(pool.closed!, dx)
    : (dx: bigint) => getAmountOut(pool, dx);
  return buildQLLadder(quote, amountIn);
}
