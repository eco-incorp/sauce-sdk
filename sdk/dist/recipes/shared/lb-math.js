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
 * FEE: LB charges a per-bin fee = totalFee · amountIn. Only the BASE fee (`baseFactor · binStep`
 * scaled by 1e10 over a 1e18 denom) is modeled — the VARIABLE volatility fee is NOT, and it does
 * NOT reset per block: the volatility accumulator DECAYS over the pair's filterPeriod/decayPeriod
 * SECONDS and GROWS with every bin crossed during a swap (including the bins our own fill crosses),
 * so after recent activity the real total fee can far exceed the base fee and the realized out
 * undershoots this snapshot. The out per unit in is netted by (1−baseFee), so marginalOI carries
 * the base fee (no extra fee-adjust multiply in the merge).
 *
 * EXECUTION (engine `_swapTraderJoeLB`): callback-free — the engine transfers `amountIn` to the
 * pair and calls `pool.swap(swapForY, recipient)`; the pair walks its OWN bins internally and
 * sends the out token to the recipient. The engine resolves `swapForY` on-chain from
 * `getTokenX()`, so the recipe passes NO bin/price data to the engine — bins are off-chain
 * ONLY (the segment data), exactly like Curve's off-chain `get_dy`. Because the exec is
 * transfer-first with NO on-chain re-quote and the awarded share equals the EXACT snapshot bin
 * capacity, any live bin shrink below the award between prepare and cook makes the pair revert
 * `LBPair__OutOfLiquidity` — aborting the WHOLE cook (no graceful per-venue skip or partial fill).
 *
 * SOURCE MIRRORED — Trader Joe LB v2.1/v2.2 (`LBPair`): the 128.128 fixed-point bin price from
 * `PriceHelper.getPriceFromId` (`getBase(binStep)^getExponent(id)` via `Uint128x128Math.pow`),
 * the constant-sum bin (`getAmountOutOfBin`), and the fee = `getFeeAmount(amountIn, totalFee)`
 * with `totalFee = baseFee = baseFactor·binStep·1e10`. The variable volatility fee is omitted
 * (see FEE above — a live time-decaying, per-bin-crossed surcharge the snapshot cannot see).
 * This is a faithful integer port of the BASE-fee curve; the realized swap output is the pair's
 * own computation (engine `pool.swap`), which charges base + variable — so a live variable fee
 * shrinks the realized out below the snapshot-priced segments.
 */
import { pushMonotoneSegment } from "./segment-merge.js";
import { QL_S, QL_RN, QL_RD, QL_SEED_DIV, qlSliceHead } from "./curve-math.js";
/** 2^192 — the unified out/in sqrt fixed-point scale (matches ecoswap.math / curve-math Q192). */
export const Q192 = 1n << 192n;
/** 2^128 — LB's price fixed-point scale (128.128). */
export const SCALE_128 = 1n << 128n;
/** LB real-id offset: id 2^23 is price 1.0 (the "anchor" bin). */
export const LB_REAL_ID_SHIFT = 1n << 23n;
/** LB fee denominator — totalFee is 1e18-scaled (PRECISION). */
export const LB_FEE_PRECISION = 10n ** 18n;
/** LB basis-point denominator for the bin-step factor (binStep is in bps of 1e4). */
export const LB_BASIS_POINT_MAX = 10000n;
/** Ceiling division ⌈a/b⌉ for a,b > 0 (LB's `Math512Bits`/`Uint256x256Math` round-up). */
export function ceilDiv(a, b) {
    if (a <= 0n)
        return 0n;
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
export function lbGrossToDrain(outReserve, price128, swapForY, fee) {
    if (outReserve <= 0n || price128 <= 0n)
        return 0n;
    const amountInToBin = swapForY
        ? ceilDiv(outReserve * SCALE_128, price128) // X to drain reserveY
        : ceilDiv(outReserve * price128, SCALE_128); // Y to drain reserveX
    if (amountInToBin <= 0n)
        return 0n;
    const feeAmount = ceilDiv(amountInToBin * fee, LB_FEE_PRECISION - fee);
    return amountInToBin + feeAmount;
}
/** Integer square root (Babylonian) — bit-identical to curve-math / ecoswap.math `isqrt`. */
export function isqrt(x) {
    if (x <= 0n)
        return 0n;
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
export function getPriceFromId(id, binStep) {
    const base = SCALE_128 + (SCALE_128 * BigInt(binStep)) / LB_BASIS_POINT_MAX;
    const exp = BigInt(id) - LB_REAL_ID_SHIFT;
    return pow128(base, exp);
}
/** 128.128 multiplication: (a · b) >> 128, rounding down. */
function mul128(a, b) {
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
export function pow128(x, y) {
    const neg = y < 0n;
    let n = neg ? -y : y;
    let result = SCALE_128; // 1.0 in 128.128
    let base = x;
    while (n > 0n) {
        if (n & 1n)
            result = mul128(result, base);
        n >>= 1n;
        if (n > 0n)
            base = mul128(base, base);
    }
    if (neg) {
        if (result === 0n)
            return 0n;
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
export function baseFee(binStep, baseFactor) {
    return BigInt(baseFactor) * BigInt(binStep) * 10n ** 10n;
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
export function buildLbSegments(pool, amountIn) {
    if (amountIn <= 0n)
        return [];
    const fee = baseFee(pool.binStep, pool.baseFactor); // 1e18-scaled
    const segs = [];
    // Index the bins by id for the directional outward walk.
    const byId = new Map();
    for (const b of pool.bins)
        byId.set(b.id, { reserveX: b.reserveX, reserveY: b.reserveY });
    // Walk ids outward from the active bin in the swap direction.
    const ids = pool.bins.map((b) => b.id).sort((a, b) => a - b);
    const walk = pool.swapForY
        ? ids.filter((id) => id <= pool.activeId).sort((a, b) => b - a) // DEC: highest price first
        : ids.filter((id) => id >= pool.activeId).sort((a, b) => a - b); // INC
    let cum = 0n;
    for (const id of walk) {
        if (cum >= amountIn)
            break;
        const bin = byId.get(id);
        const price128 = getPriceFromId(id, pool.binStep); // Y-per-X, 128.128
        // out reserve (in the OUT token) and the GROSS input (in the IN token) to fully drain it at the
        // bin price — computed with LB's exact ROUND-UP price + fee divisions (lbGrossToDrain), so the
        // segment `capacity` is bit-for-bit the real LBPair's gross-to-drain (see lbGrossToDrain's doc).
        const outReserve = pool.swapForY ? bin.reserveY : bin.reserveX;
        if (outReserve <= 0n || price128 <= 0n)
            continue;
        const grossIn = lbGrossToDrain(outReserve, price128, pool.swapForY, fee);
        if (grossIn <= 0n)
            continue;
        // out-per-in MARGINAL (post-fee): effOut / grossIn, in out/in sqrt space.
        const marginalOI = isqrt((outReserve * Q192) / grossIn);
        if (marginalOI <= 0n)
            continue;
        // Isotonic backward-merge (liquidity-preserving) — an LB bin whose marginal is NOT <= the last
        // segment's (a discrete deeper bin priced better than the current band) is FOLDED into the last
        // segment, not dropped, so the past-cliff bin liquidity survives into the split. `cum` tracks the
        // total gross input over ALL kept bins (appended or merged) so the outward walk still stops once
        // it covers amountIn. See shared/segment-merge.ts.
        pushMonotoneSegment(segs, grossIn, outReserve, marginalOI);
        cum += grossIn;
    }
    return segs;
}
/**
 * Faithful LB `getSwapOut(amountIn, swapForY)` replay returning BOTH the total tokenOut AND the
 * UNFILLABLE remainder (`amountInLeft`) — the exact shape of the real LB v2.1/v2.2 pair view
 * `getSwapOut(uint128 amountIn, bool swapForY) → (uint128 amountInLeft, uint128 amountOut, uint128 fee)`.
 *
 * Walks bins outward from the active id, draining each bin at its fixed price with the base fee applied
 * to the per-bin input (base fee only; variable fee omitted). When the bins run out before `amountIn` is
 * consumed, the leftover `remaining` is the pool's UNFILLABLE input at this snapshot — the LIVE fillable
 * capacity is `amountIn − amountInLeft`. The QL ladder (buildLbQLLadder) uses that live-capacity bound so
 * the awarded LB input never exceeds what the transfer-first engine swap can absorb (the DoS fix).
 */
export function getSwapOutWithLeft(pool, amountIn) {
    if (amountIn <= 0n)
        return { amountOut: 0n, amountInLeft: 0n };
    const fee = baseFee(pool.binStep, pool.baseFactor);
    const byId = new Map();
    for (const b of pool.bins)
        byId.set(b.id, { reserveX: b.reserveX, reserveY: b.reserveY });
    const ids = pool.bins.map((b) => b.id).sort((a, b) => a - b);
    const walk = pool.swapForY
        ? ids.filter((id) => id <= pool.activeId).sort((a, b) => b - a)
        : ids.filter((id) => id >= pool.activeId).sort((a, b) => a - b);
    let remaining = amountIn;
    let out = 0n;
    for (const id of walk) {
        if (remaining <= 0n)
            break;
        const bin = byId.get(id);
        const price128 = getPriceFromId(id, pool.binStep);
        if (price128 <= 0n)
            continue;
        const outReserve = pool.swapForY ? bin.reserveY : bin.reserveX;
        if (outReserve <= 0n)
            continue;
        // GROSS input to fully drain this bin — LB's exact round-up (lbGrossToDrain), bit-for-bit with
        // the real LBPair. (The old floor form was ~1–2 wei/bin short, so it over-reported the output.)
        const maxGrossIn = lbGrossToDrain(outReserve, price128, pool.swapForY, fee);
        if (maxGrossIn <= 0n)
            continue;
        if (remaining >= maxGrossIn) {
            // Fully drain this bin.
            out += outReserve;
            remaining -= maxGrossIn;
        }
        else {
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
    // `remaining` is the UNFILLABLE input: the bin book ran out before absorbing the whole amountIn.
    return { amountOut: out, amountInLeft: remaining };
}
/**
 * Faithful LB `getSwapOut(amountIn, swapForY)` replay — the known-answer reference for the
 * per-bin segment math. Returns the total tokenOut for `amountIn` (== the `.amountOut` of
 * `getSwapOutWithLeft`). The engine's `pool.swap(swapForY, to)` produces this on a base-fee
 * snapshot, so `Σ buildLbSegments(...).effOut` (over the consumed segments) == getSwapOut to the wei.
 */
export function getSwapOut(pool, amountIn) {
    return getSwapOutWithLeft(pool, amountIn).amountOut;
}
// ─────────────────────────────────────────────────────────────────────────────
// QUOTE-LADDER (QL) — the LIVE-WALK LB venue. The on-chain solver builds this SAME
// ladder in setup from the pair's LIVE `getSwapOut(xNext, swapForY)` (a GRACEFUL view —
// it returns `amountInLeft`, the UNFILLABLE remainder, instead of reverting), so prepare
// ships ONLY the descriptor and the oracle mirrors it BIT-FOR-BIT here. LB is the one QL
// family whose ladder step is NOT the plain xNext-cum capacity: the pool absorbs only
// `effAbsorbed = xNext − amountInLeft` of the gross attempt, so the slice CAPACITY is
// `effAbsorbed − cum` and `cum` advances to `effAbsorbed` — bounding the awarded LB input to
// the LIVE fillable bin capacity (so the transfer-first engine exec never over-asks; the
// OutOfLiquidity-DoS is gone). The constants MUST equal ecoswap.sauce.ts's QL_* literals.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build one LB pair's QUOTE-LADDER via the shared geometric recurrence, INCLUDING the amountInLeft
 * cap semantics. For k in 0..QL_S-1: geometric GROSS cumulative attempt `xNext = cum*QL_RN/QL_RD +
 * seed` (clamped at amountIn); quote `(amountOut, amountInLeft) = getSwapOutWithLeft(xNext)`;
 * `effAbsorbed = xNext − amountInLeft` is the input the pool actually absorbs, so the slice capacity
 * is `effAbsorbed − cum` (STOP when it is 0 — the pool saturated: no more live bin capacity), the
 * slice out is `amountOut − prevOut`, and `cum` advances to `effAbsorbed` (NOT xNext). marginalOI is
 * the post-(base-)fee bin price (getSwapOut nets the base fee), so it enters the descending-price merge
 * directly with no extra fee-adjust. Bit-for-bit with the on-chain qlv LB branch in ecoswap.sauce.ts.
 */
export function buildLbQLLadder(pool, amountIn) {
    if (amountIn <= 0n)
        return [];
    let seed = amountIn / QL_SEED_DIV;
    if (seed <= 0n)
        seed = 1n;
    const segs = [];
    let cum = 0n; // cumulative ABSORBED input (effAbsorbed) — NOT the gross xNext
    let prevOut = 0n;
    let prevHead = 0n;
    for (let k = 0; k < QL_S; k++) {
        let xNext = (cum * QL_RN) / QL_RD + seed;
        if (xNext > amountIn)
            xNext = amountIn;
        const grossCap = xNext - cum;
        if (grossCap === 0n)
            break;
        const { amountOut, amountInLeft } = getSwapOutWithLeft(pool, xNext);
        const effAbsorbed = xNext > amountInLeft ? xNext - amountInLeft : 0n;
        const sliceCap = effAbsorbed > cum ? effAbsorbed - cum : 0n;
        if (sliceCap === 0n)
            break; // pool saturated — no more live fillable bin capacity
        const effOut = amountOut - prevOut;
        if (effOut <= 0n)
            break;
        const marginalOI = qlSliceHead(effOut, sliceCap);
        // Non-convex guard: a non-descending head ends the ladder here (mirrors the on-chain guard).
        if (segs.length > 0 && marginalOI >= prevHead)
            break;
        segs.push({ capacity: sliceCap, effOut, marginalOI });
        prevHead = marginalOI;
        cum = effAbsorbed;
        prevOut = amountOut;
        if (effAbsorbed >= amountIn)
            break;
    }
    return segs;
}
/** Round an LB 1e18-scaled fee to ppm (the price-ordering coordinate / diagnostics). */
export function lbFeeToPpm(binStep, baseFactor) {
    const fee = baseFee(binStep, baseFactor); // 1e18-scaled
    return Number((fee * 1000000n + LB_FEE_PRECISION / 2n) / LB_FEE_PRECISION);
}
//# sourceMappingURL=lb-math.js.map