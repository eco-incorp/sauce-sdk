/**
 * EcoSwap Trader Joe LB (Liquidity Book) integration — known-answer / split units (EVM-free).
 *
 * LB is a DISCRETE-BIN constant-sum AMM: each active bin trades its full reserve at a FIXED
 * price (price(id) = (1+binStep/1e4)^(id−2^23)); crossing into the next bin steps the price by
 * binStep. So an LB pair decomposes into ONE EXACT flat segment per bin (no sampling, no grid
 * error) — the cleanest possible static-segment fit, modeled like the Curve STATIC-segment path
 * (folded into the routeSegs 6-col cursor, segKind 2, executed via swap(SwapParams{poolType:6})
 * → _swapTraderJoeLB). Unlike Curve (exact-on-grid), LB is EXACT vs the neutral oracle because a
 * bin has no intra-bin curvature: the segment IS the curve.
 *
 * This file proves, WITHOUT a fork (a local LB pair runtime is infeasible — Trader Joe ships no
 * easily-deployable factory/pair source in this repo), the things the integration adds:
 *   (1) buildLbSegments — the per-bin flat-segment math matches the LB getSwapOut replay to the
 *       wei (the segment effOut totals == getSwapOut(amountIn)), and each segment's marginalOI is
 *       the bin's post-fee out/in price;
 *   (2) once those segments enter the merge, an LB pair splits via the neutral oracle exactly
 *       (an LB-vs-LB and an LB-vs-V3 mix), the cheaper-priced venue drawing strictly more.
 *
 * The on-chain EVM round-trip against a REAL LB pair (engine _swapTraderJoeLB) is gated as a
 * fork/skip with a TODO (no deployable LB fixture here).
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.lb.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Q192,
  isqrt,
  getPriceFromId,
  getSwapOut,
  buildLbSegments,
  baseFee,
  lbFeeToPpm,
  LB_FEE_PRECISION,
  SCALE_128,
  type LbPool,
} from "../shared/lb-math.js";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { SwapPoolType } from "../shared/constants.js";

const E18 = 10n ** 18n;
const ANCHOR = 1 << 23; // id of price 1.0

// ─────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────

/**
 * A synthetic LB pair around an active id, with `count` initialized bins (id ASC) each holding
 * the SAME nominal reserve in BOTH tokens (so capacity is uniform per bin and the only price
 * variation is the bin step). swapForY (in=X, out=Y): bins consumed at id <= activeId DEC.
 */
function buildLb(opts: {
  binStep: number;
  baseFactor?: number;
  activeId?: number;
  count?: number;
  reserveX?: bigint;
  reserveY?: bigint;
  swapForY?: boolean;
}): LbPool {
  const activeId = opts.activeId ?? ANCHOR;
  const count = opts.count ?? 16;
  const reserveX = opts.reserveX ?? 100n * E18;
  const reserveY = opts.reserveY ?? 100n * E18;
  const swapForY = opts.swapForY ?? true;
  const bins: { id: number; reserveX: bigint; reserveY: bigint }[] = [];
  // Bins span both sides of active so either direction is covered.
  for (let id = activeId - count; id <= activeId + count; id++) {
    bins.push({ id, reserveX, reserveY });
  }
  return {
    poolType: SwapPoolType.TraderJoeLB,
    address: "0xdddd000000000000000000000000000000000006",
    binStep: opts.binStep,
    baseFactor: opts.baseFactor ?? 5000,
    activeId,
    swapForY,
    bins,
    source: "TestLB",
  };
}

/** Wrap an LbPool as an OptimalPool (the oracle dispatches on `lb`). */
function lbOpt(lb: LbPool): OptimalPool {
  return { isV2: false, feePpm: lbFeeToPpm(lb.binStep, lb.baseFactor), lb } as OptimalPool;
}

/** A V3 OptimalPool at a given spot tick + fee, constant L (no initialized ticks). */
function v3Opt(feePpm: number, tickSpacing: number, L: bigint, spotTick: number): OptimalPool {
  return {
    isV2: false,
    feePpm,
    tickSpacing,
    sqrtPriceX96: getSqrtRatioAtTick(spotTick),
    tick: spotTick,
    liquidity: L,
    net: new Map<number, bigint>(),
  };
}

// ─────────────────────────────────────────────────────────────
// 1. Bin price + fee — known answers
// ─────────────────────────────────────────────────────────────

describe("LB bin price / fee (getPriceFromId, baseFee)", () => {
  it("the anchor id (2^23) is price 1.0 in 128.128", () => {
    assert.equal(getPriceFromId(ANCHOR, 25), SCALE_128);
  });

  it("price strictly increases with id, by ~(1+binStep/1e4) per step", () => {
    const binStep = 25; // 0.25%
    const p0 = getPriceFromId(ANCHOR, binStep);
    const p1 = getPriceFromId(ANCHOR + 1, binStep);
    assert.ok(p1 > p0, "id+1 is a higher price");
    // ratio ≈ 1 + 25/1e4 = 1.0025 in 128.128 (floor rounding ⇒ within a few ulp of base).
    const base = SCALE_128 + (SCALE_128 * BigInt(binStep)) / 10_000n;
    const ratio = (p1 * SCALE_128) / p0;
    const diff = ratio > base ? ratio - base : base - ratio;
    assert.ok(diff < 1n << 80n, `step ratio ≈ base (diff ${diff})`);
  });

  it("price is reciprocal-symmetric: price(anchor−n) ≈ 1/price(anchor+n)", () => {
    const binStep = 10;
    const n = 7;
    const up = getPriceFromId(ANCHOR + n, binStep);
    const down = getPriceFromId(ANCHOR - n, binStep);
    // up · down ≈ (2^128)^2 (reciprocals in 128.128). Allow pow rounding.
    const prod = (up * down) >> 128n;
    const diff = prod > SCALE_128 ? prod - SCALE_128 : SCALE_128 - prod;
    assert.ok(diff < SCALE_128 / 1_000_000n, `up·down ≈ 1.0 (diff ${diff})`);
  });

  it("baseFee = baseFactor·binStep·1e10 and rounds to the expected ppm", () => {
    // baseFactor 5000, binStep 10 → 5000·10·1e10 = 5e14 (1e18-scaled) = 0.05% = 500 ppm.
    assert.equal(baseFee(10, 5000), 5n * 10n ** 14n);
    assert.equal(lbFeeToPpm(10, 5000), 500);
    // binStep 25 → baseFee 0.125% = 1250 ppm.
    assert.equal(lbFeeToPpm(25, 5000), 1250);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. buildLbSegments — per-bin flat segment math == getSwapOut
// ─────────────────────────────────────────────────────────────

describe("buildLbSegments — exact per-bin flat segments == getSwapOut", () => {
  it("one segment per consumed bin, descending marginalOI (price-ordered)", () => {
    // Small per-bin reserves so a moderate amountIn spans several bins.
    const lb = buildLb({ binStep: 25, count: 12, reserveX: E18, reserveY: E18, swapForY: true });
    // amountIn enough to consume several bins (each bin ≈ 1e18 of capacity).
    const segs = buildLbSegments(lb, 5n * E18);
    assert.ok(segs.length >= 2, "consumes >= 2 bins");
    for (let i = 1; i < segs.length; i++) {
      assert.ok(
        segs[i].marginalOI <= segs[i - 1].marginalOI,
        `segment ${i} marginal is non-increasing (price-ordered)`,
      );
    }
    // Each segment's marginalOI == isqrt(effOut·2^192/capacity) — the post-fee out/in price.
    for (const s of segs) {
      assert.equal(s.marginalOI, isqrt((s.effOut * Q192) / s.capacity), "marginalOI is the flat slice price");
    }
  });

  it("Σ segment effOut over a FULL drain == getSwapOut(Σ capacity) to the wei (swapForY)", () => {
    const lb = buildLb({ binStep: 20, count: 10, swapForY: true });
    const segs = buildLbSegments(lb, 10_000n * E18); // big enough to drain every consumable bin
    const totalIn = segs.reduce((s, x) => s + x.capacity, 0n);
    const totalOut = segs.reduce((s, x) => s + x.effOut, 0n);
    // getSwapOut on EXACTLY the gross the segments summed must return the SAME out (each bin
    // fully drained ⇒ the segment effOut IS the bin's out reserve, the wei-exact LB output).
    assert.equal(getSwapOut(lb, totalIn), totalOut, "segment effOut total == getSwapOut (exact)");
  });

  it("Σ segment effOut == getSwapOut in the OTHER direction (swapForX)", () => {
    const lb = buildLb({ binStep: 15, count: 10, swapForY: false });
    const segs = buildLbSegments(lb, 10_000n * E18);
    const totalIn = segs.reduce((s, x) => s + x.capacity, 0n);
    const totalOut = segs.reduce((s, x) => s + x.effOut, 0n);
    assert.equal(getSwapOut(lb, totalIn), totalOut, "swapForX segment effOut total == getSwapOut");
  });

  it("a PARTIAL fill (less than one bin) — getSwapOut nets the base fee on the input", () => {
    const lb = buildLb({ binStep: 10, count: 8, swapForY: true });
    const amountIn = E18 / 2n; // small — well within the active bin's capacity
    const out = getSwapOut(lb, amountIn);
    assert.ok(out > 0n, "produces output");
    // out == netIn · price(active) / 2^128, netIn = amountIn·(1−fee).
    const fee = baseFee(lb.binStep, lb.baseFactor);
    const netIn = (amountIn * (LB_FEE_PRECISION - fee)) / LB_FEE_PRECISION;
    const expected = (netIn * getPriceFromId(lb.activeId, lb.binStep)) / SCALE_128;
    assert.equal(out, expected, "partial fill out == netIn·price (fee netted)");
  });

  it("empty / zero amount yields no segments", () => {
    const lb = buildLb({ binStep: 25, count: 4 });
    assert.deepEqual(buildLbSegments(lb, 0n), []);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Split via the neutral oracle — LB segments compete EXACTLY
// ─────────────────────────────────────────────────────────────

describe("LB split via the neutral oracle [exact]", () => {
  it("solo LB pair — all input routes to it, total spent ≤ amountIn", () => {
    const lb = buildLb({ binStep: 20, count: 16, swapForY: true });
    const amountIn = 30n * E18;
    const res = optimalSplit({ pools: [lbOpt(lb)], amountIn, zeroForOne: true, priceLimit: 0n });
    assert.ok(res.perPoolInput[0] > 0n, "LB pool funded");
    assert.ok(res.totalInput <= amountIn, "never overspends");
    // The split's allocation, replayed through getSwapOut, is the wei-exact realized output.
    assert.ok(getSwapOut(lb, res.perPoolInput[0]) > 0n, "awarded share has a real output");
  });

  it("two LB pairs at different bin steps — the tighter (cheaper) step draws more", () => {
    // Same per-bin reserves + same active spot (price 1.0); the ONLY difference is binStep → fee
    // + price decay. The 5bps-step pair has the higher fee-adjusted marginal, so it fills first;
    // small per-bin reserves force its near bins to run out and the wider pair to take a slice.
    const tight = buildLb({ binStep: 5, count: 24, reserveX: E18, reserveY: E18, swapForY: true });
    const wide = buildLb({ binStep: 50, count: 24, reserveX: E18, reserveY: E18, swapForY: true });
    const amountIn = 20n * E18;
    const res = optimalSplit({ pools: [lbOpt(tight), lbOpt(wide)], amountIn, zeroForOne: true, priceLimit: 0n });
    assert.ok(res.perPoolInput[0] > 0n && res.perPoolInput[1] > 0n, "both funded (interior cut)");
    assert.ok(
      res.perPoolInput[0] > res.perPoolInput[1],
      `tighter-step LB draws more (${res.perPoolInput[0]} > ${res.perPoolInput[1]})`,
    );
  });

  it("LB vs V3 mix — both funded, the split actually splits", () => {
    // An LB pair at price ≈1.0 (modest per-bin depth) against a deep V3 pool at spot tick 0
    // (price 1.0). The LB's cheap near bins fill first; once they decay below the V3 marginal
    // the V3 pool takes the rest — an interior cut across the two venue families.
    const lb = buildLb({ binStep: 10, count: 32, reserveX: E18, reserveY: E18, swapForY: true });
    const v3 = v3Opt(3000, 60, 5_000n * E18, 0);
    const amountIn = 40n * E18;
    const res = optimalSplit({ pools: [lbOpt(lb), v3], amountIn, zeroForOne: true, priceLimit: 0n });
    assert.ok(res.totalInput > 0n, "fills");
    assert.ok(res.perPoolInput[0] > 0n, "LB funded");
    assert.ok(res.perPoolInput[1] > 0n, "V3 funded");
  });
});

// ─────────────────────────────────────────────────────────────
// 4. EVM round-trip against a REAL LB pair — fork-gated TODO
// ─────────────────────────────────────────────────────────────

describe("LB EVM round-trip (engine _swapTraderJoeLB)", () => {
  // TODO(lb-evm): a local LB-pair fixture is infeasible here (Trader Joe ships no deployable
  // factory/pair source in this repo). Cover the on-chain leg as a FORK test against a real LB
  // pair on Arbitrum/Avalanche (BASE_RPC_URL-style), asserting: the engine _swapTraderJoeLB
  // (poolType=6 SwapParams) transfers `amountIn` and pool.swap(swapForY, recipient) forwards the
  // out to the recipient, and the realized out == getSwapOut(awarded share) to the wei (LB bins
  // are constant-sum at fixed prices, so the on-chain output is EXACT for the share). Until a
  // fixture/fork is wired, this is a documented skip.
  it.skip("real LB pair: received == getSwapOut(share) wei-exact [TODO(lb-evm)]", () => {});
});
