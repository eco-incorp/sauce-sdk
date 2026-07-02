/**
 * Trader Joe Liquidity Book (LB) — exact per-bin segment enumerator + getSwapOut replay.
 *
 * THE SINGLE SOURCE for LB segment math. Imported by BOTH:
 *   - the production `prepare.ts` (buildLbSegments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (lbSegments),
 * so the split is EXACT vs the oracle by construction (one enumerator), and the per-pool
 * executed output == getSwapOut(Σ share) to the wei (one atomic `pool.swap(swapForY, to)`).
 *
 * WHY LB IS THE CLEANEST STATIC-SEGMENT FIT (cleaner than Curve):
 * LB is a DISCRETE-BIN AMM. Each active bin is a CONSTANT-SUM segment at a FIXED price:
 *
 *   price(id) = (1 + binStep/1e4) ^ (id − 2^23)        [Y-per-X, the bin's flat price]
 *
 * Crossing into the next bin steps the price by exactly `binStep` bps. So a bin is ONE flat
 * segment with NO sampling error — its full out-reserve trades at the single bin price. There
 * is no curvature within a bin (unlike Curve's `get_dy`), so LB segments are EXACT, not
 * exact-on-grid: the split equalizes marginals on segments that are themselves the true curve.
 *
 * Enumeration: walk bins OUTWARD from the active bin in the swap direction, one bin per step.
 *   - swapForY (tokenIn = tokenX, want tokenY): consume bins with id <= activeId, DECREASING id
 *     (price of Y-per-X DROPS as id drops — wait, see below). Each such bin holds reserveY (the
 *     out token); capacity_in = reserveY / price (X needed to drain it at the bin price).
 *   - swapForX (tokenIn = tokenY, want tokenX): consume bins with id >= activeId, INCREASING id.
 *     Each holds reserveX (the out token); capacity_in = reserveX * price (Y needed to drain it).
 *
 * The recipe orients everything to OUT-per-IN sqrt space (the unified merge coordinate), so the
 * direction bookkeeping collapses to: out-per-in price of the bin = (out reserve drained) per
 * (in consumed). marginalOI = isqrt(price_out_per_in_postfee * 2^192) — the descending-price key.
 *
 * FEE: LB charges a per-bin fee = totalFee · amountIn, where on a STATIC snapshot the base fee
 * is `baseFactor · binStep` scaled by 1e10 over a 1e18 denom (the variable/volatility fee is a
 * transient-state surcharge that resets between blocks — modeled as 0 here, the same fixed-fee
 * snapshot assumption the recipe makes for V3 tiers). The out per unit in is netted by (1−fee),
 * so marginalOI already carries the fee (no extra fee-adjust multiply in the merge).
 *
 * EXECUTION (engine `_swapTraderJoeLB`): callback-free — the engine transfers `amountIn` to the
 * pair and calls `pool.swap(swapForY, recipient)`; the pair walks its OWN bins internally and
 * sends the out token to the recipient. The engine resolves `swapForY` on-chain from
 * `getTokenX()`, so the recipe passes NO bin/price data to the engine — bins are off-chain
 * ONLY (the segment data), exactly like Curve's off-chain `get_dy`.
 *
 * SOURCE MIRRORED — Trader Joe LB v2.1/v2.2 (`LBPair`): the 128.128 fixed-point bin price from
 * `PriceHelper.getPriceFromId` (`getBase(binStep)^getExponent(id)` via `Uint128x128Math.pow`),
 * the constant-sum bin (`getAmountOutOfBin`), and the fee = `getFeeAmount(amountIn, totalFee)`
 * with `totalFee = baseFee = baseFactor·binStep·1e10`. CryptoSwap-style variable fee is omitted
 * (transient). This is a faithful integer port; the realized swap output is the pair's own
 * computation (engine `pool.swap`), so the snapshot fee only affects the price-ordering
 * coordinate both sides share.
 */

/** 2^192 — the unified out/in sqrt fixed-point scale (matches ecoswap.math / curve-math Q192). */
export const Q192 = 1n << 192n;

/** 2^128 — LB's price fixed-point scale (128.128). */
export const SCALE_128 = 1n << 128n;

/** LB real-id offset: id 2^23 is price 1.0 (the "anchor" bin). */
export const LB_REAL_ID_SHIFT = 1n << 23n;

/** LB fee denominator — totalFee is 1e18-scaled (PRECISION). */
export const LB_FEE_PRECISION = 10n ** 18n;

/** LB basis-point denominator for the bin-step factor (binStep is in bps of 1e4). */
export const LB_BASIS_POINT_MAX = 10_000n;

/** Ceiling division ⌈a/b⌉ for a,b > 0 (LB's `Math512Bits`/`Uint256x256Math` round-up). */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (a <= 0n) return 0n;
  return (a + b - 1n) / b;
}

/**
 * LB per-bin GROSS input to FULLY drain `outReserve` at a fixed bin price, EXACTLY as the LB v2.2
 * `LBPair.getSwapOut`/`swap` (`Bin.getAmounts` + `FeeHelper.getFeeAmount`) computes it — the two
 * ROUND-UP divisions that make the off-chain replay bit-for-bit with the real contract:
 *
 *   amountInToBin = ⌈outReserve · 2^128 / price⌉          (swapForY: X to drain the bin's Y)
 *                 = ⌈outReserve · price / 2^128⌉          (swapForX: Y to drain the bin's X)   (rounded up)
 *   feeAmount     = ⌈amountInToBin · fee / (PRECISION − fee)⌉        (FeeHelper.getFeeAmount — fee ADDED on top)
 *   grossIn       = amountInToBin + feeAmount
 *
 * The fee in LB is charged ON TOP of the amount that reaches the bin (getFeeAmount, not getFeeAmountFrom),
 * and both the price division and the fee division round UP — so a swapper pays `grossIn` to receive the
 * full `outReserve`. The earlier floor-based approximation undershot `grossIn` by ~1–2 wei/bin, so spending
 * it left the last wei of a bin undrained (verified against the real Arbitrum LBPair: the ceil form matches
 * `getSwapOut` to the WEI across the whole window; the floor form was ~2 wei/bin short). Returns 0 for a
 * non-positive/degenerate bin.
 */
export function lbGrossToDrain(outReserve: bigint, price128: bigint, swapForY: boolean, fee: bigint): bigint {
  if (outReserve <= 0n || price128 <= 0n) return 0n;
  const amountInToBin = swapForY
    ? ceilDiv(outReserve * SCALE_128, price128) // X to drain reserveY
    : ceilDiv(outReserve * price128, SCALE_128); // Y to drain reserveX
  if (amountInToBin <= 0n) return 0n;
  const feeAmount = ceilDiv(amountInToBin * fee, LB_FEE_PRECISION - fee);
  return amountInToBin + feeAmount;
}

/** Integer square root (Babylonian) — bit-identical to curve-math / ecoswap.math `isqrt`. */
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
 * Bin price in 128.128 fixed point (Y-per-X), from the LB id and binStep.
 *
 * price = (1 + binStep/1e4) ^ (id − 2^23), evaluated in 128.128 fixed point. Mirrors
 * `PriceHelper.getPriceFromId` → `Uint128x128Math.pow(base128, exponent)` where
 *   base128 = 2^128 + (2^128 · binStep)/1e4   (= 1 + binStep/1e4 in 128.128)
 *   exponent = id − 2^23                       (signed)
 * `pow` is exponentiation-by-squaring in 128.128, with the reciprocal taken for negative
 * exponents. Reproduced here in plain bigint (no transient state); accurate to LB's own pow.
 */
export function getPriceFromId(id: number, binStep: number): bigint {
  const base = SCALE_128 + (SCALE_128 * BigInt(binStep)) / LB_BASIS_POINT_MAX;
  const exp = BigInt(id) - LB_REAL_ID_SHIFT;
  return pow128(base, exp);
}

/** 128.128 multiplication: (a · b) >> 128, rounding down. */
function mul128(a: bigint, b: bigint): bigint {
  return (a * b) >> 128n;
}

/**
 * 128.128 exponentiation by squaring — `Uint128x128Math.pow(x, y)`.
 *
 * For y >= 0: result = x^y by repeated squaring. For y < 0: result = 1/(x^|y|) in 128.128
 * (computed as 2^256 / (x^|y|), the canonical reciprocal). Bounded by |y| < 2^20 (LB ids span
 * roughly ±(2^23) but realistic prices keep |exponent| well inside 2^20 — bin walks never
 * traverse anywhere near that many bins).
 */
export function pow128(x: bigint, y: bigint): bigint {
  const neg = y < 0n;
  let n = neg ? -y : y;
  let result = SCALE_128; // 1.0 in 128.128
  let base = x;
  while (n > 0n) {
    if (n & 1n) result = mul128(result, base);
    n >>= 1n;
    if (n > 0n) base = mul128(base, base);
  }
  if (neg) {
    if (result === 0n) return 0n;
    // reciprocal in 128.128: (2^128 · 2^128) / result
    return (SCALE_128 * SCALE_128) / result;
  }
  return result;
}

/**
 * Per-bin fee (totalFee) in 1e18 PRECISION, from the static base fee.
 *
 *   totalFee = baseFactor · binStep · 1e10
 *
 * (`baseFactor` is the LB v2.1 `getBaseFee`/static-fee parameter, default 5000 → 0.5·binStep%).
 * The variable (volatility) fee is omitted — it is a transient surcharge that resets between
 * blocks, so on a per-block snapshot the base fee is the fixed fee both sides agree on.
 */
export function baseFee(binStep: number, baseFactor: number): bigint {
  return BigInt(baseFactor) * BigInt(binStep) * 10n ** 10n;
}

/**
 * One discovered LB pair, oriented for a tokenIn → tokenOut swap.
 *
 * The engine `_swapTraderJoeLB` resolves `swapForY` on-chain (tokenIn == getTokenX()) and is
 * callback-free, so the on-chain SwapParams carry ONLY {pool, tokenIn, tokenOut, amountSpecified,
 * payer, recipient}. The fields here are OFF-CHAIN ONLY — they feed buildLbSegments (the price/
 * capacity enumeration). `bins` are the live initialized bins around the active id (id ASC),
 * each with its reserveX/reserveY; `swapForY` tags the swap direction (tokenIn == tokenX).
 */
export interface LbPool {
  /** Always SwapPoolType.TraderJoeLB (=6) — execution dispatches via swap(SwapParams{poolType:6}). */
  poolType: number;
  /** Pair address (the swap(swapForY, to) target). */
  address: `0x${string}`;
  /** Bin step in bps (1e4 = 100%). The per-bin price ratio. */
  binStep: number;
  /** Static base-fee factor (LB v2.1 `getStaticFeeParameters().baseFactor`). */
  baseFactor: number;
  /** The pair's CURRENT active bin id. */
  activeId: number;
  /** true => tokenIn is the pair's tokenX (swapForY); false => tokenIn is tokenY (swapForX). */
  swapForY: boolean;
  /** Initialized bins, id ASCENDING. Each: { id, reserveX, reserveY } in native pair token units. */
  bins: { id: number; reserveX: bigint; reserveY: bigint }[];
  /** Discovery source label. */
  source: string;
}

/**
 * One enumerated LB segment in unified out/in price space — a FLAT constant-sum slice (one bin).
 * Identical shape to a Curve / route segment: `capacity` is the Δinput (tokenIn) to fully drain
 * the bin's out reserve, `effOut` the bin's out reserve (post-fee), and `marginalOI` the unified
 * out/in sqrt = isqrt(effOut · 2^192 / capacity) (== the bin's post-fee out-per-in price, since
 * a bin is FLAT). Segments are emitted in DESCENDING `marginalOI` order (active bin first — the
 * best-priced bin in the swap direction).
 */
export interface LbSegment {
  /** Δinput (tokenIn) to fully drain this bin's out reserve at the bin price. */
  capacity: bigint;
  /** Δoutput (tokenOut) from draining this bin — the bin's out reserve, net of fee. */
  effOut: bigint;
  /** Unified out/in marginal price for this bin = isqrt(effOut · 2^192 / capacity). */
  marginalOI: bigint;
}

/**
 * Enumerate an LB pair into EXACT per-bin segments, walking OUTWARD from the active bin in the
 * swap direction (no sampling — one flat segment per bin).
 *
 * swapForY (in=X, out=Y): bins with id <= activeId in DECREASING id. price(id) is Y-per-X; the
 *   bin holds reserveY (out). At the bin price, capacity_in (X) = reserveY / price; the gross
 *   input grossed by the fee is capacity_in / (1−fee). out-per-in_postfee = reserveY·(1−fee)/in.
 * swapForX (in=Y, out=X): bins with id >= activeId in INCREASING id. The bin holds reserveX
 *   (out). capacity_in (Y) = reserveX · price; out-per-in_postfee = reserveX·(1−fee)/in.
 *
 * The active bin contributes its REMAINING out reserve (LB consumes the active bin partially
 * first); since reserves are read live, the active bin's reserve IS the remaining capacity, so
 * it is treated like any other bin (one flat segment).
 *
 * Each bin's price strictly decreases (swapForY) / increases-in-X-per-Y i.e. the out-per-in
 * marginal strictly DROPS as we walk outward, so segments are naturally descending in
 * marginalOI — the merge stays price-ordered. A bin with zero out reserve is skipped (no fill).
 * `amountIn` bounds the walk: stop once the cumulative bin capacity covers amountIn.
 */
export function buildLbSegments(pool: LbPool, amountIn: bigint): LbSegment[] {
  if (amountIn <= 0n) return [];
  const fee = baseFee(pool.binStep, pool.baseFactor); // 1e18-scaled
  const segs: LbSegment[] = [];

  // Index the bins by id for the directional outward walk.
  const byId = new Map<number, { reserveX: bigint; reserveY: bigint }>();
  for (const b of pool.bins) byId.set(b.id, { reserveX: b.reserveX, reserveY: b.reserveY });

  // Walk ids outward from the active bin in the swap direction.
  const ids = pool.bins.map((b) => b.id).sort((a, b) => a - b);
  const walk: number[] = pool.swapForY
    ? ids.filter((id) => id <= pool.activeId).sort((a, b) => b - a) // DEC: highest price first
    : ids.filter((id) => id >= pool.activeId).sort((a, b) => a - b); // INC

  let cum = 0n;
  let prevMarg = 0n;
  for (const id of walk) {
    if (cum >= amountIn) break;
    const bin = byId.get(id)!;
    const price128 = getPriceFromId(id, pool.binStep); // Y-per-X, 128.128

    // out reserve (in the OUT token) and the GROSS input (in the IN token) to fully drain it at the
    // bin price — computed with LB's exact ROUND-UP price + fee divisions (lbGrossToDrain), so the
    // segment `capacity` is bit-for-bit the real LBPair's gross-to-drain (see lbGrossToDrain's doc).
    const outReserve = pool.swapForY ? bin.reserveY : bin.reserveX;
    if (outReserve <= 0n || price128 <= 0n) continue;
    const grossIn = lbGrossToDrain(outReserve, price128, pool.swapForY, fee);
    if (grossIn <= 0n) continue;

    // out-per-in MARGINAL (post-fee): effOut / grossIn, in out/in sqrt space.
    const marginalOI = isqrt((outReserve * Q192) / grossIn);
    if (marginalOI <= 0n) continue;

    // Strictly-descending guard (rounding noise) — keep the merge monotone price-ordered.
    if (segs.length === 0 || marginalOI <= prevMarg) {
      segs.push({ capacity: grossIn, effOut: outReserve, marginalOI });
      prevMarg = marginalOI;
      cum += grossIn;
    }
  }
  return segs;
}

/**
 * Faithful LB `getSwapOut(amountIn, swapForY)` replay — the known-answer reference for the
 * per-bin segment math. Walks bins outward from the active id, draining each bin at its fixed
 * price with the base fee applied to the per-bin input, exactly as the LB pair does (base fee
 * only; variable fee omitted). Returns the total tokenOut for `amountIn`.
 *
 * This is the EXACT amount the engine's `pool.swap(swapForY, to)` would produce on a base-fee
 * snapshot, so `Σ buildLbSegments(...).effOut` (over the consumed segments) == getSwapOut to the
 * wei — the known-answer test asserts this equivalence.
 */
export function getSwapOut(pool: LbPool, amountIn: bigint): bigint {
  if (amountIn <= 0n) return 0n;
  const fee = baseFee(pool.binStep, pool.baseFactor);
  const byId = new Map<number, { reserveX: bigint; reserveY: bigint }>();
  for (const b of pool.bins) byId.set(b.id, { reserveX: b.reserveX, reserveY: b.reserveY });
  const ids = pool.bins.map((b) => b.id).sort((a, b) => a - b);
  const walk: number[] = pool.swapForY
    ? ids.filter((id) => id <= pool.activeId).sort((a, b) => b - a)
    : ids.filter((id) => id >= pool.activeId).sort((a, b) => a - b);

  let remaining = amountIn;
  let out = 0n;
  for (const id of walk) {
    if (remaining <= 0n) break;
    const bin = byId.get(id)!;
    const price128 = getPriceFromId(id, pool.binStep);
    if (price128 <= 0n) continue;

    const outReserve = pool.swapForY ? bin.reserveY : bin.reserveX;
    if (outReserve <= 0n) continue;

    // GROSS input to fully drain this bin — LB's exact round-up (lbGrossToDrain), bit-for-bit with
    // the real LBPair. (The old floor form was ~1–2 wei/bin short, so it over-reported the output.)
    const maxGrossIn = lbGrossToDrain(outReserve, price128, pool.swapForY, fee);
    if (maxGrossIn <= 0n) continue;

    if (remaining >= maxGrossIn) {
      // Fully drain this bin.
      out += outReserve;
      remaining -= maxGrossIn;
    } else {
      // Partial fill (LB v2.2, verified against the real pair): the fee is taken FROM the remaining
      // input with a round-UP (`FeeHelper.getFeeAmountFrom`), and the swap-out floors the price mul:
      //   fee = ⌈remaining · fee / PRECISION⌉ ; netIn = remaining − fee ; out = ⌊netIn · price / 2^128⌋.
      const feeAmt = ceilDiv(remaining * fee, LB_FEE_PRECISION);
      const netIn = remaining - feeAmt;
      const binOut = pool.swapForY
        ? (netIn * price128) / SCALE_128
        : (netIn * SCALE_128) / price128;
      out += binOut > outReserve ? outReserve : binOut;
      remaining = 0n;
    }
  }
  return out;
}

/** Round an LB 1e18-scaled fee to ppm (the price-ordering coordinate / diagnostics). */
export function lbFeeToPpm(binStep: number, baseFactor: number): number {
  const fee = baseFee(binStep, baseFactor); // 1e18-scaled
  return Number((fee * 1_000_000n + LB_FEE_PRECISION / 2n) / LB_FEE_PRECISION);
}
