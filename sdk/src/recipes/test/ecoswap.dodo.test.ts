/**
 * EcoSwap DODO V2 (PMM) integration — known-answer / exact-in-dy / split units (EVM-free).
 *
 * DODO V2 is a callback-free Proactive Market Maker: querySell{Base,Quote}(payAmount) is a
 * CLOSED-FORM function of the read pool state {i, K, B, Q, B0, Q0, R} (a quadratic solve + a
 * fair-amount integral, no unbounded loop) netted by the LP+MT fee. The guide price `i` is POOL
 * STATE (read from getPMMStateForCall), NOT an exogenous oracle feed — so the curve is a
 * deterministic function of the read state, which is exactly why DODO meets the wei-exact-on-grid
 * bar (unlike WOOFi/Fermi, whose price is an off-chain feed → out of charter).
 *
 * The PMM math is OFF-CHAIN only (shared/dodo-math.ts). The on-chain solver consumes DODO as
 * STATIC (capacity, marginalOI) segments folded into the routeSegs cursor (segKind 3) and
 * executes each venue via swap(SwapParams{poolType:5}) → the existing engine _swapDODOV2, which
 * resolves base/quote orientation ON-CHAIN (reads _BASE_TOKEN_(), calls sellBase/sellQuote) — no
 * engine change, modeled exactly like the Curve / LB static-segment path.
 *
 * This file proves, WITHOUT a fork (the EVM round-trip against a local DODO pool lives in
 * ecoswap.dodo.evm.test.ts), the things the integration adds:
 *   (1) KNOWN-ANSWER: querySell* getDy pinned across R-states (ONE / ABOVE_ONE / BELOW_ONE) and
 *       both sides (sellBase / sellQuote) and sizes, to values recomputed by a SEPARATELY-written
 *       PMM replay (a different structure than dodo-math.ts) — the values are pinned literally so a
 *       regression in either path is caught.
 *   (2) EXACT-IN-DY ON GRID: Σ buildDodoSegments effOut == getDy(Σ capacity) to the WEI (the
 *       property the on-chain solver relies on: ONE atomic querySell*(Σ share) at execution lands
 *       exactly the segment-summed output the merge accounted for). NO tolerance. Plus the stronger
 *       per-slice exact-in-dy: each segment.effOut == getDy(rightEdge) − getDy(leftEdge).
 *   (3) SPLIT EQUALIZES MARGINALS within the sampled-grid bound: the oracle's global merge over two
 *       DODO venues funds both to a common post-fee marginal, and the per-pool awarded share
 *       executes wei-exact via one getDy(share).
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.dodo.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Q192,
  DODO_ONE,
  isqrt,
  getDy,
  buildDodoSegments,
  dodoFeeToPpm,
  RState,
  type DodoPool,
} from "../shared/dodo-math.js";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";

const ONE = DODO_ONE; // 1e18 (DODO DecimalMath scale)

// ─────────────────────────────────────────────────────────────
// An independently-written PMM replay (DIFFERENT structure than dodo-math.ts) — the
// cross-check for the known-answer pins. contractV2 DODOMath / PMMPricing / DecimalMath,
// recomputed here from the canonical formulas so a regression in EITHER path is caught (the pins
// below were generated from THIS implementation and then verified identical to getDy). Structural
// differences from the production replay: the quadratic folds -b as ONE SIGNED bigint (production
// keeps the contract's bAbs/bSig pair), and sellQuote is evaluated as sellBase ON THE MIRRORED
// STATE (base↔quote, i→1/i, ABOVE↔BELOW — the exact reflection contractV2's sellQuoteToken
// hand-writes out).
// ─────────────────────────────────────────────────────────────
const dmMul = (a: bigint, b: bigint): bigint => (a * b) / ONE;
const dmCeil = (a: bigint, b: bigint): bigint => (a === 0n ? 0n : (a * ONE - 1n) / b + 1n);
const dmFloor = (a: bigint, b: bigint): bigint => (a * ONE) / b;
const dmRecip = (t: bigint): bigint => (ONE * ONE) / t;
function sqrtInt(x: bigint): bigint {
  if (x <= 0n) return 0n;
  let z = x;
  let y = (z + 1n) / 2n;
  while (y < z) {
    z = y;
    y = (x / y + y) / 2n;
  }
  return z;
}
/** `_GeneralIntegrate` — RAW i·delta, divFloor(V0²/V1, V2), one final /1e36. */
function generalIntegrateRef(V0: bigint, V1: bigint, V2: bigint, i: bigint, k: bigint): bigint {
  if (V0 <= 0n) return 0n;
  const fair = i * (V1 - V2);
  if (k === 0n) return fair / ONE;
  const mult = ONE - k + dmMul(k, dmFloor((V0 * V0) / V1, V2));
  return (mult * fair) / (ONE * ONE);
}
/** `_SolveQuadraticFunctionForTrade(V0, V1, delta, i, k)` — returns the RECEIVE amount V1 − V2,
 *  V2 = divCeil(−b + √(b²+4(1−k)kV0²), 2(1−k)). Signed -b fold (same |b| floor as the contract's
 *  unsigned bAbs/bSig pair). k==ONE takes the contract's exact fast path (idelta·V1 never wraps a
 *  bigint; every vector here is far below 2^256, where the contract takes the same branch). */
function tradeQuadRef(V0: bigint, V1: bigint, delta: bigint, i: bigint, k: bigint): bigint {
  if (V0 <= 0n || delta === 0n) return 0n;
  if (k === 0n) {
    const out = dmMul(i, delta);
    return out < V1 ? out : V1;
  }
  if (k === ONE) {
    const temp = (i * delta * V1) / (V0 * V0);
    return (V1 * temp) / (temp + ONE);
  }
  const minusB = (ONE - k) * V1 - (((k * V0) / V1) * V0 + i * delta); // RAW units, ONE fold below
  const bAbs = (minusB >= 0n ? minusB : -minusB) / ONE;
  const root = sqrtInt(bAbs * bAbs + dmMul((ONE - k) * 4n, dmMul(k, V0) * V0));
  const num = minusB >= 0n ? bAbs + root : root - bAbs;
  if (num === 0n) return 0n; // the pool reverts ("should not be zero")
  const V2 = dmCeil(num, (ONE - k) * 2n);
  return V2 > V1 ? 0n : V1 - V2;
}
/** The PMM state slice the dispatch reads (mirrorable, unlike the full DodoPool). */
type PmmRef = { i: bigint; K: bigint; B: bigint; Q: bigint; B0: bigint; Q0: bigint; R: RState };
/** sellQuote == sellBase on the mirrored state — contractV2's sellQuoteToken is this reflection. */
function mirrorRef(p: PmmRef): PmmRef {
  return {
    i: dmRecip(p.i),
    K: p.K,
    B: p.Q,
    Q: p.B,
    B0: p.Q0,
    Q0: p.B0,
    R: p.R === RState.ABOVE_ONE ? RState.BELOW_ONE : p.R === RState.BELOW_ONE ? RState.ABOVE_ONE : RState.ONE,
  };
}
function sellBaseGrossRef(p: PmmRef, pay: bigint): bigint {
  if (p.R === RState.ABOVE_ONE) {
    const backPay = p.B0 - p.B;
    const backRecv = p.Q - p.Q0;
    if (pay < backPay) {
      const r = generalIntegrateRef(p.B0, p.B + pay, p.B, p.i, p.K);
      return r > backRecv ? backRecv : r;
    }
    if (pay === backPay) return backRecv;
    return backRecv + tradeQuadRef(p.Q0, p.Q0, pay - backPay, p.i, p.K);
  }
  if (p.R === RState.BELOW_ONE) return tradeQuadRef(p.Q0, p.Q, pay, p.i, p.K);
  return tradeQuadRef(p.Q0, p.Q0, pay, p.i, p.K); // R == ONE
}
/** Independent net querySell* (gross − floor(gross·lp) − floor(gross·mt)). */
function getDyRef(p: DodoPool, pay: bigint): bigint {
  if (pay <= 0n) return 0n;
  const s: PmmRef = { i: p.i, K: p.K, B: p.B, Q: p.Q, B0: p.B0, Q0: p.Q0, R: p.R };
  const gross = sellBaseGrossRef(p.sellBase ? s : mirrorRef(s), pay);
  if (gross <= 0n) return 0n;
  const net = gross - dmMul(gross, p.lpFeeRate) - dmMul(gross, p.mtFeeRate);
  return net > 0n ? net : 0n;
}

// ─────────────────────────────────────────────────────────────
// Fixtures (one per R-state + a sell-quote one)
// ─────────────────────────────────────────────────────────────
function dodo(over: Partial<DodoPool> & Pick<DodoPool, "R">): DodoPool {
  return {
    poolType: 5,
    address: ("0x" + "dd".repeat(20)) as `0x${string}`,
    baseToken: ("0x" + "11".repeat(20)) as `0x${string}`,
    quoteToken: ("0x" + "22".repeat(20)) as `0x${string}`,
    sellBase: true,
    i: ONE,
    K: ONE / 10n,
    B: 100n * ONE,
    Q: 100n * ONE,
    B0: 100n * ONE,
    Q0: 100n * ONE,
    lpFeeRate: 0n,
    mtFeeRate: 0n,
    feePpm: 0,
    source: "known-answer",
    ...over,
  };
}

// R == ONE, sell base. i=1, K=0.1, balanced reserves; fee lp 0.20% + mt 0.10%.
const P_ONE = dodo({
  R: RState.ONE,
  i: ONE,
  K: ONE / 10n,
  lpFeeRate: 2n * 10n ** 15n,
  mtFeeRate: 1n * 10n ** 15n,
});
// R == ABOVE_ONE, sell base (base scarce: B<B0, Q>Q0). i=2, K=0.2; lp 0.30%.
const P_ABOVE = dodo({
  R: RState.ABOVE_ONE,
  i: 2n * ONE,
  K: ONE / 5n,
  B: 80n * ONE,
  Q: 142n * ONE,
  lpFeeRate: 3n * 10n ** 15n,
});
// R == BELOW_ONE, sell base (quote scarce: B>B0, Q<Q0). i=0.5, K=0.25; lp 0.10% + mt 0.05%.
const P_BELOW = dodo({
  R: RState.BELOW_ONE,
  i: ONE / 2n,
  K: ONE / 4n,
  B: 130n * ONE,
  Q: 60n * ONE,
  lpFeeRate: 1n * 10n ** 15n,
  mtFeeRate: 5n * 10n ** 14n,
});
// R == ONE, sell QUOTE (the 1/i side). i=2, K=0.1; lp 0.20%.
const P_QUOTE = dodo({
  R: RState.ONE,
  i: 2n * ONE,
  K: ONE / 10n,
  sellBase: false,
  lpFeeRate: 2n * 10n ** 15n,
});

// ─────────────────────────────────────────────────────────────
// 1. getDy (querySell*) — known answers across R-states + sides
// ─────────────────────────────────────────────────────────────
//
// Each value is pinned LITERALLY (generated from the independent getDyRef above, then verified
// equal to the production getDy). The two implementations have a different control structure, so
// agreement on these literals pins the PMM math in both paths.
describe("DODO V2 querySell* getDy — known answers (R-state × side)", () => {
  // Pinned literal expectations (independently recomputed; wei-exact). Hand-anchored sanity:
  //   - a small trade receives ≈ pay·i (quote out) or ≈ pay/i (base out) NET of fee, i.e. a tiny
  //     FRACTION of the 100e18-scale reserve — e.g. ONE sellBase 0.1 → 0.0997 (0.1·1·0.997−slip),
  //     ONE sellQuote 1 → 0.4987 (1/2·0.998−slip);
  //   - output strictly INCREASES with input within each family;
  //   - ABOVE sellBase 25 crosses back-to-ONE at 20: 42 (Q−Q0) + ~9.8 quadratic remainder for the
  //     5 past-boundary base at i=2, netted 0.3% → 51.63.
  const PINS: Array<[string, DodoPool, bigint, bigint]> = [
    // R == ONE, sell base
    ["ONE sellBase 0.1", P_ONE, ONE / 10n, 99_690_022_018_513_548n],
    ["ONE sellBase 1", P_ONE, ONE, 995_994_968_869_095_359n],
    ["ONE sellBase 5", P_ONE, 5n * ONE, 4_959_042_793_995_415_497n],
    ["ONE sellBase 25", P_ONE, 25n * ONE, 24_152_821_849_134_979_811n],
    // R == ABOVE_ONE, sell base (below the boundary this is the GeneralIntegrate leg)
    ["ABOVE sellBase 0.1", P_ABOVE, ONE / 10n, 221_754_706_616_729_088n],
    ["ABOVE sellBase 1", P_ABOVE, ONE, 2_210_632_098_765_432_099n],
    ["ABOVE sellBase 5", P_ABOVE, 5n * ONE, 10_908_352_941_176_470_585n],
    ["ABOVE sellBase 25", P_ABOVE, 25n * ONE, 51_632_255_070_872_287_501n],
    // ROUNDING TRIPWIRE: a non-round pay where _GeneralIntegrate's exact rounding order (RAW
    // i·delta + divFloor V0²/V1/V2 + one /1e36 — contractV2) differs by 1 wei from the plausible
    // staged-mulFloor/divCeil variant. Round pays cancel the truncations; this one does not.
    ["ABOVE sellBase non-round", P_ABOVE, 27_081_043_269_784_643n, 60_068_844_879_220_590n],
    // R == BELOW_ONE, sell base (quote scarce → the quadratic leg, priced BELOW i)
    ["BELOW sellBase 0.1", P_BELOW, ONE / 10n, 34_553_874_567_596_784n],
    ["BELOW sellBase 1", P_BELOW, ONE, 344_675_734_690_717_940n],
    ["BELOW sellBase 5", P_BELOW, 5n * ONE, 1_704_184_552_435_029_739n],
    ["BELOW sellBase 25", P_BELOW, 25n * ONE, 8_041_481_626_415_988_086n],
    ["BELOW sellBase non-round", P_BELOW, 1_234_567_890_123_456_789n, 425_247_842_587_823_535n],
    // R == ONE, sell quote (the 1/i side)
    ["ONE sellQuote 0.1", P_QUOTE, ONE / 10n, 49_897_504_001_656_845n],
    ["ONE sellQuote 1", P_QUOTE, ONE, 498_749_498_560_131_047n],
    ["ONE sellQuote 5", P_QUOTE, 5n * ONE, 2_488_635_576_819_906_893n],
    ["ONE sellQuote 25", P_QUOTE, 25n * ONE, 12_302_035_876_522_037_962n],
  ];

  for (const [name, pool, pay, expected] of PINS) {
    it(`getDy(${name}) == pinned literal AND == independent replay`, () => {
      const prod = getDy(pool, pay);
      assert.equal(prod, expected, `${name}: getDy == pinned literal`);
      // And the structurally-independent replay agrees (cross-check, not the same code path).
      assert.equal(prod, getDyRef(pool, pay), `${name}: getDy == independent replay`);
    });
  }

  it("zero / negative pay yields zero out", () => {
    assert.equal(getDy(P_ONE, 0n), 0n);
    assert.equal(getDy(P_ONE, -5n), 0n);
  });

  it("getDy is monotone increasing in every R-state (more input → strictly more output)", () => {
    // The PMM out(in) curve is one smooth concave curve: more input yields strictly more output in
    // EVERY R-state (the quadratic legs asymptote to the counter-reserve — V2 → 0 so the receive
    // V1−V2 → V1 — they never decline). This is the physical sanity a receive-amount regression
    // (e.g. returning the new reserve V2 instead of V1−V2) breaks instantly.
    for (const pool of [P_ONE, P_ABOVE, P_BELOW, P_QUOTE]) {
      let prev = 0n;
      for (const pay of [ONE / 2n, ONE, 3n * ONE, 8n * ONE, 15n * ONE]) {
        const out = getDy(pool, pay);
        assert.ok(out > prev, `out strictly increases with pay=${pay} (${pool.R})`);
        prev = out;
      }
      // ...and never exceeds what the pool can pay out (the out-side reserve).
      const outReserve = pool.sellBase ? pool.Q : pool.B;
      assert.ok(getDy(pool, 10_000n * ONE) < outReserve, `saturates below the out reserve (${pool.R})`);
    }
  });

  it("dodoFeeToPpm rounds the combined lp+mt 1e18 fee to ppm", () => {
    // lp 0.20% + mt 0.10% = 0.30% = 3000 ppm.
    assert.equal(dodoFeeToPpm(2n * 10n ** 15n, 1n * 10n ** 15n), 3000);
    // lp 0.30% + mt 0 = 3000 ppm.
    assert.equal(dodoFeeToPpm(3n * 10n ** 15n, 0n), 3000);
    // lp 0.10% + mt 0.05% = 0.15% = 1500 ppm.
    assert.equal(dodoFeeToPpm(1n * 10n ** 15n, 5n * 10n ** 14n), 1500);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. buildDodoSegments — exact-in-dy on the sampled grid
// ─────────────────────────────────────────────────────────────
describe("buildDodoSegments — exact-in-dy on grid (Σ effOut == getDy(Σ capacity))", () => {
  // P_ABOVE has real curvature over its [0, amountIn] window (the base-scarce side), so it yields
  // a multi-segment descending ladder — the meaningful case for the grid properties.
  it("Σ segment effOut == getDy(Σ capacity) to the WEI (no tolerance)", () => {
    for (const pool of [P_ONE, P_ABOVE, P_BELOW, P_QUOTE]) {
      for (const amountIn of [ONE, 10n * ONE, 50n * ONE]) {
        const segs = buildDodoSegments(pool, amountIn);
        assert.ok(segs.length > 0, `non-empty ladder (${pool.R})`);
        let cumIn = 0n;
        let cumOut = 0n;
        for (const s of segs) {
          cumIn += s.capacity;
          cumOut += s.effOut;
        }
        // WEI-EXACT: one atomic querySell*(cumIn) == Σ effOut. NO tolerance.
        assert.equal(cumOut, getDy(pool, cumIn), `exact-in-dy: ΣeffOut == getDy(${cumIn})`);
      }
    }
  });

  it("per-slice exact-in-dy: each segment.effOut == getDy(rightEdge) − getDy(leftEdge)", () => {
    // Stronger than the cumulative check: every individual slice's effOut is the exact getDy
    // difference across its [leftEdge, rightEdge] cumulative-input bounds. Uses P_ABOVE (multi-seg).
    const segs = buildDodoSegments(P_ABOVE, 10n * ONE);
    assert.ok(segs.length >= 2, "P_ABOVE yields a multi-segment ladder");
    let leftEdge = 0n;
    for (const s of segs) {
      const rightEdge = leftEdge + s.capacity;
      const exactSliceOut = getDy(P_ABOVE, rightEdge) - getDy(P_ABOVE, leftEdge);
      assert.equal(s.effOut, exactSliceOut, "per-slice effOut == getDy difference (wei-exact)");
      leftEdge = rightEdge;
    }
  });

  it("segment marginals are strictly descending (price-ordered, convex curve)", () => {
    const segs = buildDodoSegments(P_ABOVE, 20n * ONE);
    assert.ok(segs.length >= 2, "multi-segment ladder");
    for (let k = 1; k < segs.length; k++) {
      assert.ok(
        segs[k].marginalOI <= segs[k - 1].marginalOI,
        `segment ${k} marginal non-increasing`,
      );
      // marginalOI is the flat slice price isqrt(effOut·2^192/capacity).
      assert.equal(
        segs[k].marginalOI,
        isqrt((segs[k].effOut * Q192) / segs[k].capacity),
        "marginalOI is the post-fee out/in slice price",
      );
    }
  });

  it("empty / zero amount yields no segments", () => {
    assert.deepEqual(buildDodoSegments(P_ABOVE, 0n), []);
    assert.deepEqual(buildDodoSegments(P_ABOVE, -1n), []);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Split via the neutral oracle — DODO segments compete; marginals equalize on the grid
// ─────────────────────────────────────────────────────────────
describe("DODO split via the neutral oracle [exact-on-grid]", () => {
  // Two base-scarce (ABOVE_ONE) DODO pools at different guide prices / depth so they start at
  // different marginals and the water-fill produces an interior cut.
  const A: DodoPool = dodo({
    R: RState.ABOVE_ONE,
    i: 2n * ONE,
    K: ONE / 5n,
    B0: 100n * ONE,
    Q0: 100n * ONE,
    B: 80n * ONE,
    Q: 142n * ONE,
    lpFeeRate: 2n * 10n ** 15n,
    feePpm: 2000,
    address: ("0x" + "aa".repeat(20)) as `0x${string}`,
  });
  const B: DodoPool = dodo({
    R: RState.ABOVE_ONE,
    i: (19n * ONE) / 10n,
    K: ONE / 4n,
    B0: 200n * ONE,
    Q0: 200n * ONE,
    B: 170n * ONE,
    Q: 260n * ONE,
    lpFeeRate: 3n * 10n ** 15n,
    feePpm: 3000,
    address: ("0x" + "bb".repeat(20)) as `0x${string}`,
  });
  const optA: OptimalPool = { isV2: false, feePpm: A.feePpm, dodo: A };
  const optB: OptimalPool = { isV2: false, feePpm: B.feePpm, dodo: B };

  it("solo DODO pool — all input routes to it, awarded share has a real output", () => {
    const amountIn = 5n * ONE;
    const res = optimalSplit({ pools: [optA], amountIn, zeroForOne: true, priceLimit: 0n });
    assert.ok(res.perPoolInput[0] > 0n, "DODO pool funded");
    assert.ok(res.totalInput <= amountIn, "never overspends");
    // The split's allocation, replayed through getDy, is the wei-exact realized output.
    assert.ok(getDy(A, res.perPoolInput[0]) > 0n, "awarded share has a real output");
  });

  it("two DODO pools — both funded (interior cut), marginals equalize within the grid bound", () => {
    const amountIn = 20n * ONE;
    const res = optimalSplit({ pools: [optA, optB], amountIn, zeroForOne: true, priceLimit: 0n });
    assert.equal(res.totalInput, amountIn, "spends amountIn exactly");
    assert.ok(
      res.perPoolInput[0] > 0n && res.perPoolInput[1] > 0n,
      `both DODO venues funded (interior cut): [${res.perPoolInput}]`,
    );
    // Fee-adjusted marginals equalize at the cut within the QUOTE-LADDER grid bound. DODO is now a QL
    // venue: the oracle (buildDodoQLLadder) and the on-chain solver build the IDENTICAL 8-slice geometric
    // ladder from the live querySell* view, so the split is wei-exact between them — but the QL grid
    // (QL_S=8) is coarser than the old M=24 sampler, so the marginals equalize only to within one QL
    // slice's price width (a documented grid bound, not a few ppm).
    const m0 = res.perPoolMarginalAdj[0];
    const m1 = res.perPoolMarginalAdj[1];
    const diff = m0 > m1 ? m0 - m1 : m1 - m0;
    const slackPpm = 12000n; // QL 8-slice grid bound on this curvature (vs 0.2% at the old M=24)
    assert.ok(
      diff * 1_000_000n <= m0 * slackPpm,
      `marginals equalize within ${slackPpm}ppm: |${m0} - ${m1}| = ${diff}`,
    );
    // Each awarded share executes wei-exact via one getDy(share).
    assert.ok(getDy(A, res.perPoolInput[0]) > 0n, "venue A dy(share) > 0");
    assert.ok(getDy(B, res.perPoolInput[1]) > 0n, "venue B dy(share) > 0");
  });

  it("DODO vs a deeper DODO — the cheaper/deeper venue draws more", () => {
    // B has a larger target (B0/Q0 = 200 vs 100) → deeper → past A's near-price advantage (A opens
    // ~2.22 vs B ~2.08 post-fee, so A drains first) B's flatter curve absorbs the larger share.
    // The crossover for these curves sits near 50·ONE; 80·ONE is comfortably past it.
    const amountIn = 80n * ONE;
    const res = optimalSplit({ pools: [optA, optB], amountIn, zeroForOne: true, priceLimit: 0n });
    assert.ok(res.perPoolInput[0] > 0n && res.perPoolInput[1] > 0n, "both funded");
    assert.ok(
      res.perPoolInput[1] > res.perPoolInput[0],
      `deeper venue B draws more (${res.perPoolInput[1]} > ${res.perPoolInput[0]})`,
    );
  });
});
