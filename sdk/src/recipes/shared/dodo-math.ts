/**
 * DODO V2 PMM (Proactive Market Maker) — VERBATIM bigint replay + off-chain segment sampler.
 *
 * THE SINGLE SOURCE for DODO V2 math. Imported by BOTH:
 *   - the production `prepare.ts` (buildDodoSegments / buildDodoBrackets), and
 *   - the neutral oracle `ecoswap.optimal.ts` (dodoSegments),
 * so the split is exact-on-grid vs the oracle by construction (one replay), and the per-pool
 * executed output == querySell*(awarded share) to the wei (one atomic engine swap → _swapDODOV2).
 *
 * THE PMM MATH IS OFF-CHAIN ONLY. The on-chain solver does NOT recompute the PMM integral. The
 * guide price `i` is POOL STATE (read live from `getPMMStateForCall()`), NOT an exogenous oracle
 * feed — so the curve is a deterministic function of the read state (unlike WOOFi/Fermi, whose
 * price is an off-chain feed and which are therefore out of the wei-exact charter). prepare samples
 * DODO into (capacity, effOut, marginalOI) SEGMENTS via this exact closed-form replay; the on-chain
 * solver consumes them as STATIC segments through the existing static-segment cursor (the same
 * machinery the merge already uses for route / Curve / LB segments), and EXECUTES each DODO pool via
 * swap(SwapParams{poolType:5 (DODOV2), pool, tokenIn, tokenOut, amountSpecified:neg}) → the live
 * `_swapDODOV2` path, which resolves base/quote orientation ON-CHAIN (it reads the pool's
 * `_BASE_TOKEN_()` and calls `sellBase`/`sellQuote`). No engine change.
 *
 * CLOSED-FORM, NO UNBOUNDED LOOP. The PMM output is a closed-form integral (a quadratic solve and a
 * fair-amount integral), NOT a Newton iteration — so the replay is a fixed sequence of bigint ops
 * (the only loop is `isqrt`, Babylonian, bounded). This is the property the feasibility doc flags as
 * the reason DODO is tractable on the wei-exact bar.
 *
 * SOURCE MIRRORED — DODO V2 `PMMPricing` + `DODOMath` + `DecimalMath` (the canonical
 * DODOEX/contractV2 + DODOEX/dodo-smart-contract libraries; the same math the DVM/DSP/DPP pools run):
 *   - `DODOMath._GeneralIntegrate(V0, V1, V2, i, k)` — the R!=ONE fair-amount integral.
 *   - `DODOMath._SolveQuadraticFunctionForTrade(Q0, Q1, ideltaB, deltaBSig, k)` — the ONE / R-flip
 *     quadratic solve (the 5-arg signed form; the contractV2 4-arg `(V0,V1,delta,i,K)` wrapper
 *     feeds it `ideltaB = mulFloor(i, delta)` with `deltaBSig=false`).
 *   - `PMMPricing.sellBaseToken` / `sellQuoteToken` — the R-state dispatch (ONE / ABOVE_ONE /
 *     BELOW_ONE) and the boundary-crossing two-part integration (integrate back to R==ONE, then
 *     `_ROneSell*` the remainder).
 *   - `DecimalMath`: ONE = 1e18; mulFloor(a,b)=a*b/1e18 (== `DecimalMath.mul`); divFloor(a,b)=
 *     a*1e18/b; divCeil(a,b)=ceil(a*1e18/b); reciprocalFloor(t)=1e36/t. `_GeneralIntegrate` uses
 *     mulFloor for `fairAmount`/`penalty`, divCeil for `V0V0V1V2`; the quadratic uses divFloor
 *     (deltaBSig) / divCeil (!deltaBSig) for the final divide. Reproduced bit-for-bit so the
 *     off-chain `effOut` equals the engine `_swapDODOV2` realized output to the wei.
 *   - Fees: `receiveAmount` is netted by the LP fee then the MT fee, both `mulFloor(receiveAmount,
 *     rate)` with the rate 1e18-scaled (`_LP_FEE_RATE_` + the MT fee-rate model). The combined fee
 *     is read once at quote time and treated as fixed over the trade (the same snapshot assumption
 *     the recipe makes for V3 tiers / LB base fee).
 *
 * The replay runs purely on the read pool state (i/K/B/Q/B0/Q0/R + the two fee rates);
 * buildDodoSegments makes NO extra RPC.
 *
 * Sources:
 *   https://github.com/DODOEX/contractV2/blob/main/contracts/lib/PMMPricing.sol
 *   https://github.com/DODOEX/dodo-smart-contract/blob/master/contracts/lib/DODOMath.sol
 *   https://github.com/DODOEX/contractV2/blob/main/contracts/lib/DecimalMath.sol
 */

/** 2^192 — the unified out/in sqrt fixed-point scale (matches ecoswap.math / curve-math / lb-math Q192). */
export const Q192 = 1n << 192n;

/** DODO DecimalMath ONE — 1e18 fixed point. */
export const DODO_ONE = 10n ** 18n;

/** Integer square root (Babylonian) — bit-identical to curve-math / lb-math / ecoswap.math `isqrt`. */
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

// ── DecimalMath (1e18) — verbatim DODO rounding ──────────────────────────────

/** mulFloor(a,b) = a*b/1e18 (== DODO `DecimalMath.mul`). */
function mulFloor(a: bigint, b: bigint): bigint {
  return (a * b) / DODO_ONE;
}
/** Plain integer ceil-divide ceil(a/b). */
function divCeilRaw(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}
/** divFloor(a,b) = a*1e18/b. */
function divFloor(a: bigint, b: bigint): bigint {
  return (a * DODO_ONE) / b;
}
/** divCeil(a,b) = ceil(a*1e18/b). */
function divCeil(a: bigint, b: bigint): bigint {
  return divCeilRaw(a * DODO_ONE, b);
}
/** reciprocalFloor(t) = 1e36/t — DODO's `1/i` for the quote-side curve. */
function reciprocalFloor(t: bigint): bigint {
  return (DODO_ONE * DODO_ONE) / t;
}

// ── DODOMath — verbatim ──────────────────────────────────────────────────────

/**
 * `_GeneralIntegrate(V0, V1, V2, i, k)` — DODOMath verbatim.
 *
 *   fairAmount = mulFloor(i, V1 - V2)
 *   V0V0V1V2   = divCeil(V0*V0/V1, V2)
 *   penalty    = mulFloor(k, V0V0V1V2)
 *   return mulFloor(fairAmount, ONE - k + penalty)
 *
 * The integral of the PMM marginal price over [V2, V1] with reference reserve V0 and slippage k.
 */
export function generalIntegrate(V0: bigint, V1: bigint, V2: bigint, i: bigint, k: bigint): bigint {
  const fairAmount = mulFloor(i, V1 - V2);
  const V0V0V1V2 = divCeil((V0 * V0) / V1, V2);
  const penalty = mulFloor(k, V0V0V1V2);
  return mulFloor(fairAmount, DODO_ONE - k + penalty);
}

/**
 * `_SolveQuadraticFunctionForTrade(Q0, Q1, ideltaB, deltaBSig, k)` — DODOMath verbatim (the 5-arg
 * signed form). Solves the PMM quadratic for the new reserve, returning the receive amount.
 *
 *   kQ02Q1 = mulFloor(k, Q0)*Q0/Q1
 *   b      = mulFloor(ONE - k, Q1)
 *   if deltaBSig: b += ideltaB   else: kQ02Q1 += ideltaB
 *   minusbSig: if b >= kQ02Q1 { b -= kQ02Q1; +true } else { b = kQ02Q1 - b; false }
 *   squareRoot = sqrt( b*b + mulFloor( (ONE-k)*4, mulFloor(k, Q0)*Q0 ) )
 *   denominator = (ONE - k)*2
 *   numerator = minusbSig ? b + squareRoot : squareRoot - b
 *   return deltaBSig ? divFloor(numerator, denominator) : divCeil(numerator, denominator)
 *
 * Note `.sqrt()` here is the plain integer sqrt of a 1e18-scaled square (DODO's `b*b` and the
 * penalty term are already in (1e18)^2 units, so the integer sqrt lands back in 1e18 units).
 */
export function solveQuadraticForTrade(
  Q0: bigint,
  Q1: bigint,
  ideltaB: bigint,
  deltaBSig: boolean,
  k: bigint,
): bigint {
  let kQ02Q1 = (mulFloor(k, Q0) * Q0) / Q1;
  let b = mulFloor(DODO_ONE - k, Q1);
  let minusbSig: boolean;
  if (deltaBSig) {
    b = b + ideltaB;
  } else {
    kQ02Q1 = kQ02Q1 + ideltaB;
  }
  if (b >= kQ02Q1) {
    b = b - kQ02Q1;
    minusbSig = true;
  } else {
    b = kQ02Q1 - b;
    minusbSig = false;
  }

  const penalty = mulFloor((DODO_ONE - k) * 4n, mulFloor(k, Q0) * Q0);
  const squareRoot = isqrt(b * b + penalty);

  const denominator = (DODO_ONE - k) * 2n;
  const numerator = minusbSig ? b + squareRoot : squareRoot - b;
  if (denominator === 0n) return 0n;
  return deltaBSig
    ? (numerator * DODO_ONE) / denominator // divFloor
    : divCeilRaw(numerator * DODO_ONE, denominator); // divCeil
}

// ── PMMPricing R-state dispatch ──────────────────────────────────────────────

/** R-state — `PMMPricing.RState` (0 = ONE, 1 = ABOVE_ONE, 2 = BELOW_ONE). */
export const enum RState {
  ONE = 0,
  ABOVE_ONE = 1,
  BELOW_ONE = 2,
}

/**
 * `_ROneSellBaseToken(state, payBaseAmount)` — sell base when R == ONE.
 * `_SolveQuadraticFunctionForTrade(Q0, Q0, ideltaB = mulFloor(i, payBase), deltaBSig=false, K)`.
 */
function rOneSellBase(i: bigint, K: bigint, Q0: bigint, payBase: bigint): bigint {
  return solveQuadraticForTrade(Q0, Q0, mulFloor(i, payBase), false, K);
}

/**
 * `_RAboveSellBaseToken(state, payBaseAmount)` — sell base when R > 1 (base scarce side).
 * `_GeneralIntegrate(B0, B + payBase, B, i, K)`.
 */
function rAboveSellBase(
  i: bigint,
  K: bigint,
  B0: bigint,
  B: bigint,
  payBase: bigint,
): bigint {
  return generalIntegrate(B0, B + payBase, B, i, K);
}

/**
 * `_RBelowSellBaseToken(state, payBaseAmount)` — sell base when R < 1 (quote scarce side).
 * `_SolveQuadraticFunctionForTrade(Q0, Q, ideltaB = mulFloor(i, payBase), deltaBSig=false, K)`.
 */
function rBelowSellBase(
  i: bigint,
  K: bigint,
  Q0: bigint,
  Q: bigint,
  payBase: bigint,
): bigint {
  return solveQuadraticForTrade(Q0, Q, mulFloor(i, payBase), false, K);
}

/** `_ROneSellQuoteToken` — sell quote when R == ONE. Uses 1/i. */
function rOneSellQuote(i: bigint, K: bigint, B0: bigint, payQuote: bigint): bigint {
  const oneOverI = reciprocalFloor(i);
  return solveQuadraticForTrade(B0, B0, mulFloor(oneOverI, payQuote), false, K);
}

/** `_RAboveSellQuoteToken` — sell quote when R > 1. Uses 1/i. */
function rAboveSellQuote(
  i: bigint,
  K: bigint,
  B0: bigint,
  B: bigint,
  payQuote: bigint,
): bigint {
  const oneOverI = reciprocalFloor(i);
  return solveQuadraticForTrade(B0, B, mulFloor(oneOverI, payQuote), false, K);
}

/** `_RBelowSellQuoteToken` — sell quote when R < 1. Uses 1/i, GeneralIntegrate. */
function rBelowSellQuote(
  i: bigint,
  K: bigint,
  Q0: bigint,
  Q: bigint,
  payQuote: bigint,
): bigint {
  const oneOverI = reciprocalFloor(i);
  return generalIntegrate(Q0, Q + payQuote, Q, oneOverI, K);
}

/**
 * `PMMPricing.sellBaseToken(state, payBaseAmount)` — the gross receiveQuote (pre-fee), with the
 * R-state dispatch and the ABOVE_ONE boundary-crossing two-part integration. Returns the gross
 * quote out (the LP/MT fees are applied by querySellBase, NOT here).
 */
function sellBaseToken(s: DodoPmmState, payBase: bigint): bigint {
  if (s.R === RState.ONE) {
    return rOneSellBase(s.i, s.K, s.Q0, payBase);
  }
  if (s.R === RState.ABOVE_ONE) {
    const backToOnePayBase = s.B0 - s.B;
    const backToOneReceiveQuote = s.Q - s.Q0;
    if (payBase < backToOnePayBase) {
      let recv = rAboveSellBase(s.i, s.K, s.B0, s.B, payBase);
      if (recv > backToOneReceiveQuote) recv = backToOneReceiveQuote;
      return recv;
    } else if (payBase === backToOnePayBase) {
      return backToOneReceiveQuote;
    }
    return backToOneReceiveQuote + rOneSellBase(s.i, s.K, s.Q0, payBase - backToOnePayBase);
  }
  // BELOW_ONE
  return rBelowSellBase(s.i, s.K, s.Q0, s.Q, payBase);
}

/**
 * `PMMPricing.sellQuoteToken(state, payQuoteAmount)` — the gross receiveBase (pre-fee), with the
 * R-state dispatch and the BELOW_ONE boundary-crossing two-part integration. Returns the gross
 * base out (the LP/MT fees are applied by querySellQuote, NOT here).
 */
function sellQuoteToken(s: DodoPmmState, payQuote: bigint): bigint {
  if (s.R === RState.ONE) {
    return rOneSellQuote(s.i, s.K, s.B0, payQuote);
  }
  if (s.R === RState.BELOW_ONE) {
    const backToOnePayQuote = s.Q0 - s.Q;
    const backToOneReceiveBase = s.B - s.B0;
    if (payQuote < backToOnePayQuote) {
      let recv = rBelowSellQuote(s.i, s.K, s.Q0, s.Q, payQuote);
      if (recv > backToOneReceiveBase) recv = backToOneReceiveBase;
      return recv;
    } else if (payQuote === backToOnePayQuote) {
      return backToOneReceiveBase;
    }
    return backToOneReceiveBase + rOneSellQuote(s.i, s.K, s.B0, payQuote - backToOnePayQuote);
  }
  // ABOVE_ONE
  return rAboveSellQuote(s.i, s.K, s.B0, s.B, payQuote);
}

/** The raw PMM state a DODO V2 pool reports from `getPMMStateForCall()`. */
export interface DodoPmmState {
  /** Guide price i (1e18-scaled): quote-per-base mid-price. POOL STATE (not an external feed). */
  i: bigint;
  /** Slippage coefficient K (1e18-scaled; 0 = constant price, 1e18 = constant-product-like). */
  K: bigint;
  /** Current base reserve B (base-token units). */
  B: bigint;
  /** Current quote reserve Q (quote-token units). */
  Q: bigint;
  /** Target base reserve B0. */
  B0: bigint;
  /** Target quote reserve Q0. */
  Q0: bigint;
  /** R-state (ONE / ABOVE_ONE / BELOW_ONE). */
  R: RState;
}

/**
 * One discovered DODO V2 pool, oriented for a tokenIn → tokenOut swap.
 *
 * The engine `_swapDODOV2` resolves base/quote orientation ON-CHAIN (it reads the pool's
 * `_BASE_TOKEN_()` and calls sellBase or sellQuote), so the on-chain SwapParams carry ONLY
 * {pool, tokenIn, tokenOut, amountSpecified, payer, recipient}. The fields here are OFF-CHAIN
 * ONLY — they feed buildDodoSegments (the price/capacity replay). `sellBase` tags which side of
 * the PMM this swap traverses (tokenIn == the pool's base token): selling base → quote, else
 * selling quote → base. `feeRate` is the COMBINED LP+MT fee (1e18-scaled), applied to the gross
 * receive amount as the pool does (two sequential mulFloor deductions collapse to one because
 * floor(floor(x·(1-lp))·(1-mt)) is reproduced exactly by netting in the same order — see getDy).
 */
export interface DodoPool {
  /** Always SwapPoolType.DODOV2 (=5) — execution dispatches via swap(SwapParams{poolType:5}). */
  poolType: number;
  /** Pool address — the swap(SwapParams{poolType:5, pool}) target / sellBase/sellQuote contract. */
  address: `0x${string}`;
  /** The pool's base token (DODO `_BASE_TOKEN_()`). Orientation reference. */
  baseToken: `0x${string}`;
  /** The pool's quote token. */
  quoteToken: `0x${string}`;
  /** true => tokenIn == baseToken (sell base → quote); false => tokenIn == quoteToken (sell quote → base). */
  sellBase: boolean;
  /** Guide price i (1e18-scaled) — POOL STATE from getPMMStateForCall. */
  i: bigint;
  /** Slippage coefficient K (1e18-scaled). */
  K: bigint;
  /** Current base reserve B. */
  B: bigint;
  /** Current quote reserve Q. */
  Q: bigint;
  /** Target base reserve B0. */
  B0: bigint;
  /** Target quote reserve Q0. */
  Q0: bigint;
  /** R-state (ONE / ABOVE_ONE / BELOW_ONE). */
  R: RState;
  /** LP fee rate (1e18-scaled; pool `_LP_FEE_RATE_`). */
  lpFeeRate: bigint;
  /** MT (maintainer) fee rate (1e18-scaled; the pool's MT fee-rate model for the caller). */
  mtFeeRate: bigint;
  /** Rounded ppm fee (the price-ordering coordinate / diagnostics; lpFeeRate+mtFeeRate → ppm). */
  feePpm: number;
  /** Discovery source label. */
  source: string;
}

/** Pack a DodoPool's PMM state into the raw {i,K,B,Q,B0,Q0,R} the dispatch reads. */
function pmmState(pool: DodoPool): DodoPmmState {
  return { i: pool.i, K: pool.K, B: pool.B, Q: pool.Q, B0: pool.B0, Q0: pool.Q0, R: pool.R };
}

/**
 * `querySellBase` / `querySellQuote` net of fees — the exact tokens-out for `payAmount` tokenIn,
 * INCLUDING the LP and MT fees. Mirrors DVMTrader.querySell* bit-for-bit:
 *
 *   receiveAmount = PMMPricing.sell{Base,Quote}Token(state, payAmount)   # gross
 *   lpFee = mulFloor(receiveAmount, lpFeeRate)
 *   mtFee = mulFloor(receiveAmount, mtFeeRate)
 *   return receiveAmount - lpFee - mtFee
 *
 * (DVMTrader subtracts the lp fee and the mt fee, each `mulFloor(receiveAmount, rate)`, from the
 * SAME gross `receiveAmount` — so the net is `gross - floor(gross·lp) - floor(gross·mt)`, NOT a
 * sequential compounding. Reproduced in that exact order so the off-chain out equals the engine
 * `_swapDODOV2` realized output to the wei.)
 */
export function getDy(pool: DodoPool, payAmount: bigint): bigint {
  if (payAmount <= 0n) return 0n;
  const s = pmmState(pool);
  const gross = pool.sellBase ? sellBaseToken(s, payAmount) : sellQuoteToken(s, payAmount);
  if (gross <= 0n) return 0n;
  const lpFee = mulFloor(gross, pool.lpFeeRate);
  const mtFee = mulFloor(gross, pool.mtFeeRate);
  const net = gross - lpFee - mtFee;
  return net > 0n ? net : 0n;
}

/**
 * One sampled DODO segment in unified out/in price space — identical shape to a Curve / LB / route
 * segment (a flat [capacity, marginalOI] slice). `capacity` is the Δinput (tokenIn) for this slice,
 * `effOut` the Δoutput, and `marginalOI` the unified out/in sqrt = isqrt(effOut * 2^192 / capacity)
 * — the price-ordering coordinate. Segments are emitted in DESCENDING `marginalOI` order (the
 * natural order of a convex PMM curve: the first marginal slice is the best-priced).
 *
 * fee-adjust: marginalOI is computed from the POST-FEE dy (getDy already nets the LP+MT fee), so it
 * is ALREADY the fee-adjusted execution price — it enters the merge's descending-price sort directly
 * (no extra sqrtOneMinusFee multiply, the fee is baked into dy), exactly like Curve / LB segments.
 */
export interface DodoSegment {
  /** Δinput (tokenIn) to traverse this slice. */
  capacity: bigint;
  /** Δoutput (tokenOut) over this slice. */
  effOut: bigint;
  /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
  marginalOI: bigint;
}

/** Default sample count per DODO pool (M). Tunable; M≈24 tightens the grid bound. */
export const DODO_SAMPLES = Number(process.env.ECO_DODO_SAMPLES ?? 24);

/**
 * Sample a DODO V2 pool into M descending-marginal segments over [0, amountIn].
 *
 * Geometric-ish cumulative inputs (denser near 0 where the PMM curve is steepest), each replayed
 * through getDy (querySell*) on the READ state (NO extra RPC — pure bigint, closed-form). Each
 * increment becomes a (capacity=Δin, effOut=Δout, marginalOI) segment. The samples are monotone in
 * input so the marginals are naturally descending (a convex out(in)); a non-decreasing marginal
 * (rounding noise near saturation, or past the pool's effective depth) is dropped so the merge stays
 * strictly price-ordered.
 *
 * Exact-on-grid: the split equalizes marginals on THIS sampled grid; the per-pool dy for the awarded
 * Σ share is re-evaluated wei-exact by one atomic querySell*(Σ share) at execution (the engine
 * `_swapDODOV2`). M≈24 (default) keeps the grid bound `O(curvature·maxSlice)` negligible. Mirrors
 * `buildCurveSegments` (same squared-index geometric grid + strictly-descending guard).
 */
export function buildDodoSegments(
  pool: DodoPool,
  amountIn: bigint,
  samples: number = DODO_SAMPLES,
): DodoSegment[] {
  if (amountIn <= 0n) return [];
  const M = BigInt(samples);
  const segs: DodoSegment[] = [];
  let prevIn = 0n;
  let prevOut = 0n;
  for (let s = 1; s <= samples; s++) {
    // cumulative input ∝ s^2 (fine slices near 0, coarse near amountIn).
    const ss = BigInt(s);
    const input = (amountIn * ss * ss) / (M * M);
    if (input <= prevIn) continue;
    const out = getDy(pool, input);
    if (out <= 0n) continue;
    const dIn = input - prevIn;
    const dOut = out - prevOut;
    if (dIn > 0n && dOut > 0n) {
      const marginalOI = isqrt((dOut * Q192) / dIn);
      // Strictly-descending guard — drop a slice whose marginal did not improve on the prior
      // (rounding noise near saturation) so the merge stays monotone price-ordered.
      if (
        marginalOI > 0n &&
        (segs.length === 0 || marginalOI <= segs[segs.length - 1].marginalOI)
      ) {
        segs.push({ capacity: dIn, effOut: dOut, marginalOI });
      }
    }
    prevIn = input;
    prevOut = out;
  }
  return segs;
}

/** Round a DODO combined 1e18-scaled fee (lp+mt) to ppm (the price-ordering coordinate / diagnostics). */
export function dodoFeeToPpm(lpFeeRate: bigint, mtFeeRate: bigint): number {
  const fee = lpFeeRate + mtFeeRate; // 1e18-scaled
  return Number((fee * 1_000_000n + DODO_ONE / 2n) / DODO_ONE);
}
