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
import { type MergeSegment } from "./segment-merge.js";
/** 2^192 — the unified out/in sqrt fixed-point scale (matches ecoswap.math / curve-math Q192). */
export declare const Q192: bigint;
/** 2^128 — LB's price fixed-point scale (128.128). */
export declare const SCALE_128: bigint;
/** LB real-id offset: id 2^23 is price 1.0 (the "anchor" bin). */
export declare const LB_REAL_ID_SHIFT: bigint;
/** LB fee denominator — totalFee is 1e18-scaled (PRECISION). */
export declare const LB_FEE_PRECISION: bigint;
/** LB basis-point denominator for the bin-step factor (binStep is in bps of 1e4). */
export declare const LB_BASIS_POINT_MAX = 10000n;
/** Ceiling division ⌈a/b⌉ for a,b > 0 (LB's `Math512Bits`/`Uint256x256Math` round-up). */
export declare function ceilDiv(a: bigint, b: bigint): bigint;
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
export declare function lbGrossToDrain(outReserve: bigint, price128: bigint, swapForY: boolean, fee: bigint): bigint;
/** Integer square root (Babylonian) — bit-identical to curve-math / ecoswap.math `isqrt`. */
export declare function isqrt(x: bigint): bigint;
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
export declare function getPriceFromId(id: number, binStep: number): bigint;
/**
 * 128.128 exponentiation by squaring — `Uint128x128Math.pow(x, y)`.
 *
 * For y >= 0: result = x^y by repeated squaring. For y < 0: result = 1/(x^|y|) in 128.128
 * (computed as 2^256 / (x^|y|), the canonical reciprocal). Bounded by |y| < 2^20 (LB ids span
 * roughly ±(2^23) but realistic prices keep |exponent| well inside 2^20 — bin walks never
 * traverse anywhere near that many bins).
 */
export declare function pow128(x: bigint, y: bigint): bigint;
/**
 * Per-bin fee (totalFee) in 1e18 PRECISION, from the static base fee.
 *
 *   totalFee = baseFactor · binStep · 1e10
 *
 * (`baseFactor` is the LB v2.1 `getBaseFee`/static-fee parameter, default 5000 → 0.5·binStep%).
 * The variable (volatility) fee is omitted — it is a transient surcharge that resets between
 * blocks, so on a per-block snapshot the base fee is the fixed fee both sides agree on.
 */
export declare function baseFee(binStep: number, baseFactor: number): bigint;
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
    bins: {
        id: number;
        reserveX: bigint;
        reserveY: bigint;
    }[];
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
export interface LbSegment extends MergeSegment {
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
export declare function buildLbSegments(pool: LbPool, amountIn: bigint): LbSegment[];
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
export declare function getSwapOutWithLeft(pool: LbPool, amountIn: bigint): {
    amountOut: bigint;
    amountInLeft: bigint;
};
/**
 * Faithful LB `getSwapOut(amountIn, swapForY)` replay — the known-answer reference for the
 * per-bin segment math. Returns the total tokenOut for `amountIn` (== the `.amountOut` of
 * `getSwapOutWithLeft`). The engine's `pool.swap(swapForY, to)` produces this on a base-fee
 * snapshot, so `Σ buildLbSegments(...).effOut` (over the consumed segments) == getSwapOut to the wei.
 */
export declare function getSwapOut(pool: LbPool, amountIn: bigint): bigint;
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
export declare function buildLbQLLadder(pool: LbPool, amountIn: bigint): MergeSegment[];
/** Round an LB 1e18-scaled fee to ppm (the price-ordering coordinate / diagnostics). */
export declare function lbFeeToPpm(binStep: number, baseFactor: number): number;
//# sourceMappingURL=lb-math.d.ts.map