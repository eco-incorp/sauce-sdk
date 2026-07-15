/**
 * EulerSwap (Euler vault-backed AMM, v1+v2) — VERBATIM bigint replay + off-chain segment sampler.
 *
 * THE SINGLE SOURCE for EulerSwap swap math. Imported by BOTH:
 *   - the production `prepare.ts` (buildEulerSwapSegments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (eulerSwapSegments),
 * so the split is exact-on-grid vs the oracle by construction (one replay), and the per-pool
 * executed output == computeQuote(awarded share) to the wei (one atomic pool.swap with EMPTY data).
 *
 * THE EULER CURVE IS OFF-CHAIN ONLY (for the SPLIT). The on-chain solver does NOT recompute the
 * asymmetric concentrated-liquidity curve (f / fInverse) or its closed-form sqrt — it samples the
 * curve OFF-CHAIN into (capacity, effOut, marginalOI) SEGMENTS via this exact replay, consumes them
 * as STATIC segments through the existing static-segment cursor (the same machinery the merge uses
 * for Curve / LB / DODO / Solidly / Wombat segments), and EXECUTES each EulerSwap pool CALLBACK-FREE:
 * an on-chain `pool.computeQuote(tokenIn, tokenOut, awardedShare, true)` staticcall yields the EXACT
 * amountOut (the periphery `quoteExactInput` delegates to this view, and the view IS the swap math),
 * the awarded input is transferred to the pool, and `pool.swap(amount0Out, amount1Out, to, "")` lands
 * the swap. EulerSwap's `swap` is Uniswap-V2-shaped: with EMPTY `data` it does NO flash callback —
 * it optimistically transfers the output, sweeps `balanceOf(this)` for the pre-transferred input, and
 * VERIFIES the curve invariant. So it is callback-free (the proven Solidly/Wombat pattern) and needs
 * NO engine SwapPoolType (it is NOT xy=k — it is the asymmetric Euler curve — so _swapV2 would
 * mis-price it). The only re-entry on the empty-data path is internal to Euler (the `callThroughEVC`
 * self-wrap pool→EVC→pool, and the vault deposit/withdraw pool→EVault) — it never re-enters the
 * cooking contract, so the V3/V4-callback barrier does not apply.
 *
 * SOURCE MIRRORED — the canonical euler-xyz/euler-swap `CurveLib.f` + `QuoteLib.computeQuote` /
 * `findCurvePoint` (whitepaper eqs 23-27). Reproduced bit-for-bit (all curve params are 1e18 fixed
 * point: priceX/priceY, concentrationX/concentrationY; reserves and equilibrium reserves are RAW token
 * units; fee is 1e18-scaled):
 *   QuoteLib.computeQuote(exactIn=true):
 *     amount      = amount - amount·fee/1e18                          # net the fee off the INPUT
 *     output      = findCurvePoint(reserves, amount, exactIn=true, asset0IsInput)
 *   findCurvePoint(exactIn, asset0IsInput=true):                      # tokenIn == asset0 (reserve0)
 *     xNew = reserve0 + amount
 *     yNew = xNew <= x0 ? f(xNew, px, py, x0, y0, cx)                 # in-region (still left of equilibrium)
 *                       : fInverse(xNew, py, px, y0, x0, cy)          # out-region (right of equilibrium)
 *     output = reserve1 > yNew ? reserve1 - yNew : 0
 *   CurveLib.f(x, px, py, x0, y0, c):                                 # y on the curve at reserve x (x <= x0)
 *     c == 1e18 : output = y0 + ceil((x0 - x)·px / py)                # the linear (full-range) limit
 *     else      : a = px·(x0 - x); b = c·x + (1e18 - c)·x0; d = 1e18·x·py
 *                 output = y0 + ceilDiv(a·b, d)                       # saturatingMulDivUp (rounds UP)
 *
 * Symmetric for asset1IsInput (px/py and cx/cy swapped, reserves mirrored) — exactly the contract's
 * branch. We sample EXACT-IN (positive amount), which uses only the f() in-region branch when the
 * pool stays left of equilibrium (the deep-liquidity regime EcoSwap discovers), and fInverse past it.
 * fInverse is the closed-form whitepaper sqrt (NO Newton, expressible with isqrt/mulDiv) — but for the
 * SPLIT sampler we only need computeQuote(dx), so we replay the contract's `findCurvePoint` directly.
 *
 * The replay is CLOSED-FORM (one ceil-div per f, or one isqrt per fInverse) — NO unbounded loop. It
 * runs purely on the read pool state (reserve0/reserve1, the curve params, fee); buildEulerSwapSegments
 * makes NO extra RPC.
 *
 * VAULT-CAP BOUND. EulerSwap depth is gated by the Euler vault available cash / borrow cap, NOT only by
 * the curve: `EulerSwapPeriphery.getLimits(pool, tokenIn, tokenOut)` returns (inLimit, outLimit). prepare
 * BOUNDS each pool's sampled amountIn by `min(amountIn, inLimit)` so no segment promises depth the vault
 * cannot service. Between prepare and cook the cap can shrink (another swap drew the vault down); the
 * on-chain `computeQuote` view re-reads the LIVE limits and REVERTS (`SwapLimitExceeded`; `Expired` on
 * a de-activated pool) if the awarded share now exceeds them — and a revert inside the cook aborts the
 * WHOLE cook (atomic all-or-nothing), NOT a graceful per-pool skip. The ONLY graceful path is a literal
 * quote of 0 (computeQuote returns 0 ⇒ the solver leaves that share un-spent for the terminal refund).
 * So the prepare-time `min(amountIn, inLimit)` bound is the real protection; a cap that shrinks below
 * the award between prepare and cook costs the transaction (a revert), never the funds.
 *
 * WEI-EXACT BOUND. The SPLIT (per-pool awarded input) is EXACT-ON-GRID vs the oracle (both replay the
 * SAME buildEulerSwapSegments grid — one source — so the awarded share matches the oracle bit-for-bit).
 * The realized dy is EXACT-IN-DY: the per-pool out for the awarded slice is re-evaluated wei-exact by ONE
 * atomic on-chain computeQuote(Σ share) at execution, because the pool's `computeQuote` view IS the math
 * its `swap` enforces (swap optimistically pays out and then verifies the SAME curve the quote walked).
 * So awarded-input == oracle (exact-on-grid) and received-dy == computeQuote(awarded) (exact-in-dy) — the
 * same standard as Curve / DODO / Solidly / Wombat. Marginal equalization across pools is a DIAGNOSTIC
 * (a grid bound), not the wei gate.
 *
 * Sources:
 *   https://github.com/euler-xyz/euler-swap/blob/master/src/libraries/CurveLib.sol  (f / fInverse / verify)
 *   https://github.com/euler-xyz/euler-swap/blob/master/src/libraries/QuoteLib.sol  (computeQuote / findCurvePoint / calcLimits)
 *   https://github.com/euler-xyz/euler-swap/blob/master/src/EulerSwapPeriphery.sol  (quoteExactInput / getLimits)
 */
import { type MergeSegment } from "./segment-merge.js";
/** 2^192 — the unified out/in sqrt fixed-point scale (matches the other *-math modules' Q192). */
export declare const Q192: bigint;
/** EulerSwap curve fixed-point ONE — 1e18 (prices, concentrations, fee). */
export declare const EULER_ONE: bigint;
/**
 * Round an EulerSwap fee (1e18-scaled, e.g. 1e15 = 0.1%) to a ppm fee (the price-ordering coordinate /
 * diagnostic) — ROUND-HALF-UP. THE SINGLE SOURCE: discovery (`discoverEulerSwapPoolsTyped`), the prod-mirror
 * `offPool` descriptor, and the known-answer test descriptors ALL build `feePpm` through this one helper, so
 * the ordering coordinate matches bit-for-bit (a truncating vs round-half-up mismatch could order-differ a
 * higher-fee pool between the oracle-under-test and the production descriptor — see the review finding).
 */
export declare function eulerFeeToPpm(feeWad: bigint): number;
/** Integer square root (Babylonian) — bit-identical to the other *-math modules' `isqrt`. */
export declare function isqrt(x: bigint): bigint;
/**
 * One discovered EulerSwap pool, oriented for a tokenIn → tokenOut swap.
 *
 * EulerSwap pools are single-LP vault-backed AMMs with an ASYMMETRIC concentrated-liquidity curve. A
 * 2-token swap reads the LIVE reserves (reserve0/reserve1, uint112) + the static curve params
 * (equilibrium reserves x0/y0, prices px/py, concentrations cx/cy, all 1e18) + the directional fee
 * (1e18) + the vault `inLimit` (the input cap from getLimits). The on-chain execution is CALLBACK-FREE
 * (computeQuote staticcall + transfer + pool.swap(...,"")), so the fields here are OFF-CHAIN ONLY — they
 * feed buildEulerSwapSegments (the price/capacity replay).
 *
 * `inIsToken0` orients the curve (tokenIn is asset0 ⇒ x is the in-side) AND the swap's output slot
 * (tokenIn==token0 ⇒ out is amount1Out). `reserveIn`/`reserveOut` are the LIVE reserves oriented by
 * tokenIn. The curve params are stored in the pool's CANONICAL (asset0/asset1) orientation; `inIsToken0`
 * selects which f/fInverse branch and which (px,py)/(cx,cy) pairing the replay uses.
 */
export interface EulerSwapPool {
    /** Pool address — the computeQuote/getLimits/swap target. */
    address: `0x${string}`;
    /** true => tokenIn is the pool's token0/asset0 (output is amount1Out); false => output is amount0Out. */
    inIsToken0: boolean;
    /** LIVE tokenIn-side reserve (== reserve0 when inIsToken0, else reserve1). */
    reserveIn: bigint;
    /** LIVE tokenOut-side reserve. */
    reserveOut: bigint;
    /** Equilibrium reserve on the tokenIn side (x0 when inIsToken0, else y0). */
    equilIn: bigint;
    /** Equilibrium reserve on the tokenOut side. */
    equilOut: bigint;
    /** Price of the IN asset (px when inIsToken0, else py), 1e18. */
    priceIn: bigint;
    /** Price of the OUT asset (py when inIsToken0, else px), 1e18. */
    priceOut: bigint;
    /** Concentration of the IN asset (cx when inIsToken0, else cy), 1e18. The f() c argument. */
    concIn: bigint;
    /** Concentration of the OUT asset (cy when inIsToken0, else cx), 1e18. The fInverse cy argument. */
    concOut: bigint;
    /** Directional swap fee (1e18-scaled; e.g. 1e15 = 0.1%). The fee charged when tokenIn is the input. */
    feeWad: bigint;
    /** Vault input cap (from getLimits — supplyVault.maxDeposit + borrow debt). Bounds the sampler. 0 ⇒ uncapped. */
    inLimit: bigint;
    /**
     * Vault OUTPUT cap (from getLimits — the available-cash the pool can pay out). On-chain computeQuote
     * REVERTS (SwapLimitExceeded)/returns 0 once the quoted out exceeds it, so the QL ladder self-truncates
     * there; the oracle mirrors that with this bound (see buildEulerSwapQLLadder). 0/undefined ⇒ uncapped.
     */
    outLimit?: bigint;
    /** Rounded ppm fee (the price-ordering coordinate / diagnostic). */
    feePpm: number;
    /** Discovery source label. */
    source: string;
}
/**
 * computeQuote(pool, dx) — the EXACT actual tokens-out for `dx` tokenIn (native units), INCLUDING the
 * swap fee. Mirrors QuoteLib.computeQuote(exactIn=true) bit-for-bit:
 *   amount = dx - dx·fee/1e18                       # net the fee off the input (DSMath floor)
 *   out    = findCurvePoint(reserves, amount, exactIn=true, asset0IsInput)
 * The realized swap output equals this to the wei (EulerSwap.swap optimistically pays out then verifies
 * the SAME curve the quote walked). The exact-IN path only (positive amount); the exact-out branch
 * (inflating the input by 1/(1-fee)) is unused here.
 */
export declare function computeQuote(pool: EulerSwapPool, dx: bigint): bigint;
/**
 * One sampled EulerSwap segment in unified out/in price space — identical shape to a Curve / LB / DODO /
 * Solidly / Wombat / route segment (a flat [capacity, marginalOI] slice). `capacity` is the Δinput
 * (tokenIn) for this slice, `effOut` the Δoutput, and `marginalOI` the unified out/in sqrt =
 * isqrt(effOut·2^192/capacity) — the price-ordering coordinate. Segments are emitted in DESCENDING
 * `marginalOI` order (the natural order of a convex curve: the first marginal slice is the best-priced).
 *
 * fee-adjust: marginalOI is computed from the POST-FEE dy (computeQuote already nets the fee), so it is
 * ALREADY the fee-adjusted execution price — it enters the merge's descending-price sort directly (no
 * extra sqrtOneMinusFee multiply), exactly like Curve / LB / DODO / Solidly / Wombat segments.
 */
export interface EulerSwapSegment extends MergeSegment {
    /** Δinput (tokenIn) to traverse this slice. */
    capacity: bigint;
    /** Δoutput (tokenOut) over this slice. */
    effOut: bigint;
    /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
    marginalOI: bigint;
}
/** Default sample count per EulerSwap pool (M). Tunable; M≈24 tightens the grid bound. */
export declare const EULERSWAP_SAMPLES: number;
/**
 * Sample an EulerSwap pool into M descending-marginal segments over [0, min(amountIn, inLimit)].
 *
 * BOUND BY THE VAULT CAP: the sampled range is capped at the pool's vault `inLimit` (from getLimits) so
 * no segment promises depth the Euler vault cannot service. If `inLimit` is 0 it is treated as uncapped
 * (the test path / a pool whose limit was not read).
 *
 * Geometric-ish cumulative inputs (∝ s^2 — denser near 0 where the curve is flattest near equilibrium,
 * then bends), each replayed through computeQuote on the READ state (NO extra RPC — pure closed-form
 * bigint). Each increment becomes a (capacity=Δin, effOut=Δout, marginalOI) segment. The samples are
 * monotone in input so the marginals are naturally descending (a convex out(in)); a non-descending
 * slice (rounding noise near saturation, or a non-convex region past the pool's effective depth) is
 * FOLDED into the last segment (isotonic backward-merge — capacity + effOut conserved, blended marginal
 * recomputed) so the merge stays monotone price-ordered without discarding liquidity. See
 * shared/segment-merge.ts.
 *
 * Exact-on-grid: the split equalizes marginals on THIS sampled grid; the per-pool out for the awarded Σ
 * share is re-evaluated wei-exact by one atomic on-chain computeQuote(Σ share) at execution. Mirrors
 * `buildWombatSegments` / `buildSolidlyStableSegments` (same squared-index geometric grid + isotonic
 * backward-merge).
 */
export declare function buildEulerSwapSegments(pool: EulerSwapPool, amountIn: bigint, samples?: number): EulerSwapSegment[];
/**
 * Build one EulerSwap pool's QUOTE-LADDER — the SHARED curve-agnostic `buildQLLadder` recurrence
 * (curve-math.ts) driven by the closed-form `computeQuote` bigint replay, so the oracle stays wei-exact
 * with the on-chain solver BY CONSTRUCTION: the fixture / real pool `computeQuote(tokenIn,tokenOut,xNext,
 * true)` view mirrors this replay bit-for-bit (see EulerSwapPool.sol + ecoswap.math.ts), so the ladder
 * reproduces the solver's live `computeQuote` at every geometric step. The quote is post-fee (computeQuote
 * nets the fee) so marginalOI IS the execution price; adjNear == adjFar == marginalOI (no prepared segments —
 * prepare ships only the descriptor).
 *
 * VAULT-CAP SELF-TRUNCATION. On-chain, `computeQuote` REVERTS (SwapLimitExceeded/Expired) — or, for the
 * fixture, returns 0 — once xNext exceeds the LIVE vault inLimit or the quoted out exceeds the outLimit; the
 * solver's probe-then-decode catches that (q=0 ⇒ stop), so the ladder self-truncates at the live cap with NO
 * separate getLimits call. This mirrors that off-chain: a `dx` past `inLimit`, or an `out` past `outLimit`,
 * returns 0 ⇒ `buildQLLadder` stops at the SAME point the on-chain ladder does ⇒ oracle == solver even when
 * the trade crosses the cap. 0/undefined limits ⇒ uncapped (the deep-pool / test path).
 */
export declare function buildEulerSwapQLLadder(pool: EulerSwapPool, amountIn: bigint): EulerSwapSegment[];
//# sourceMappingURL=eulerswap-math.d.ts.map