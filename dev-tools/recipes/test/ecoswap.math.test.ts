/**
 * EcoSwap pure-math unit tests (EVM-free, deterministic bigint).
 *
 * Exercises the integer math that prepare.ts uses to build the bracket ladder,
 * plus the on-chain water-fill solver via the ecoSwapReference oracle. The math
 * helpers under test live in ./ecoswap.math (faithful copies of prepare.ts's
 * non-exported helpers — see that file's header).
 *
 * Run: npx tsx --test recipes/test/ecoswap.math.test.ts
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Q96,
  Q192,
  FEE_DENOM,
  isqrt,
  sqrtOneMinusFeeScaled,
  feeAdjust,
  bracketCapacity,
  getSqrtRatioAtTick,
  toOutIn,
} from "./ecoswap.math";
import { ecoSwapReference } from "./ecoswap.reference";
import { EcoBracketKind, type EcoBracket, type EcoPool, type EcoSwapPrepared } from "../shared/types";
import { SwapPoolType } from "../shared/constants";

// ── tolerance helper ─────────────────────────────────────────
/**
 * Assert |actual - expected| <= expected * relTolPpm / 1e6, all in bigint.
 * relTolPpm is parts-per-million of `expected`.
 */
function assertClose(actual: bigint, expected: bigint, relTolPpm: bigint, msg?: string): void {
  const diff = actual > expected ? actual - expected : expected - actual;
  const slack = (expected < 0n ? -expected : expected) * relTolPpm / 1_000_000n;
  assert.ok(
    diff <= slack,
    `${msg ?? "assertClose"}: |${actual} - ${expected}| = ${diff} > slack ${slack} (${relTolPpm}ppm)`,
  );
}

// ── synthetic ladder builders (mirror prepare.ts construction) ──

function v3Pool(feePpm: number, tickSpacing: number): EcoPool {
  return {
    poolType: SwapPoolType.UniV3,
    address: ("0x" + feePpm.toString(16).padStart(40, "0")) as `0x${string}`,
    fee: feePpm,
    tickSpacing,
    hooks: "0x0000000000000000000000000000000000000000",
    feePpm,
    isV2: false,
    inIsToken0: true,
    source: "synthetic-v3",
  };
}

/**
 * Build a V3 pool's brackets walking DOWN from `startTick` (zeroForOne=true, so
 * unified out/in == real sqrt). Mirrors buildV3Brackets's near/far/L per bracket.
 */
function v3Brackets(refIdx: number, feePpm: number, L: bigint, startTick: number, spacing: number, n: number): EcoBracket[] {
  const out: EcoBracket[] = [];
  let b = startTick;
  for (let k = 0; k < n; k++) {
    const near = toOutIn(getSqrtRatioAtTick(b), true);
    const far = toOutIn(getSqrtRatioAtTick(b - spacing), true);
    if (near > far) {
      out.push({
        kind: EcoBracketKind.V3,
        refIdx,
        sqrtNear: near,
        sqrtFar: far,
        liquidity: L,
        capacity: bracketCapacity(L, near, far, feePpm),
        sqrtAdjNear: feeAdjust(near, feePpm),
        sqrtAdjFar: feeAdjust(far, feePpm),
      });
    }
    b -= spacing;
  }
  return out;
}

/** Sort a ladder DESC by sqrtAdjNear, exactly as prepare.ts does (line 510). */
function sortLadder(brackets: EcoBracket[]): EcoBracket[] {
  return [...brackets].sort((a, b) =>
    a.sqrtAdjNear < b.sqrtAdjNear ? 1 : a.sqrtAdjNear > b.sqrtAdjNear ? -1 : 0,
  );
}

function prepared(pools: EcoPool[], brackets: EcoBracket[]): EcoSwapPrepared {
  return { pools, routes: [], brackets: sortLadder(brackets), zeroForOne: true, priceLimit: 0n, expectedInputCovered: 0n };
}

function totalCapacity(brackets: EcoBracket[]): bigint {
  return brackets.reduce((s, b) => s + b.capacity, 0n);
}

// ─────────────────────────────────────────────────────────────
// 1. getSqrtRatioAtTick — Uniswap V3 TickMath known values
// ─────────────────────────────────────────────────────────────
describe("getSqrtRatioAtTick (Uniswap V3 TickMath)", () => {
  it("tick 0 == 2^96 exactly", () => {
    // sqrt(1.0001^0) = 1, scaled by 2^96.
    assert.equal(getSqrtRatioAtTick(0), 79228162514264337593543950336n);
    assert.equal(getSqrtRatioAtTick(0), Q96);
  });

  it("is strictly monotonic around 0", () => {
    assert.ok(getSqrtRatioAtTick(1) > getSqrtRatioAtTick(0));
    assert.ok(getSqrtRatioAtTick(0) > getSqrtRatioAtTick(-1));
  });

  it("reciprocity: ratio(t) * ratio(-t) ≈ 2^192", () => {
    // These are Q96 fixed-point with round-UP at the >>32 step, so the product
    // carries at most a couple ulps of rounding. Empirically (verified) the
    // products for these ticks are within 1 ppm of 2^192 — assert <= 2 ppm.
    for (const t of [60, 200, 6000]) {
      const prod = getSqrtRatioAtTick(t) * getSqrtRatioAtTick(-t);
      assertClose(prod, Q192, 2n, `reciprocity t=${t}`);
    }
  });

  it("price relationship: tick 6932 ≈ price 2.0 (float spot-check only)", () => {
    // FLOAT check, human-readable: (sqrtP / 2^96)^2 ≈ 1.0001^6932 ≈ 2.0.
    const r = Number(getSqrtRatioAtTick(6932)) / 2 ** 96;
    const price = r * r;
    assert.ok(Math.abs(price - 2.0) / 2.0 < 0.001, `price ${price} not within 0.1% of 2.0`);
  });
});

// ─────────────────────────────────────────────────────────────
// 2. sqrtOneMinusFeeScaled / feeAdjust
// ─────────────────────────────────────────────────────────────
describe("sqrtOneMinusFeeScaled / feeAdjust", () => {
  it("fee 0 → 1e6 (sqrt(1) scaled)", () => {
    assert.equal(sqrtOneMinusFeeScaled(0), 1_000_000n);
  });

  it("fee 3000 (0.3%) → 998498 (isqrt floor of sqrt(0.997)*1e6)", () => {
    // sqrtOneMinusFeeScaled(3000) = isqrt((1e6 - 3000) * 1e6) = isqrt(997_000_000_000).
    // sqrt(0.997)*1e6 = 998499.37... ; isqrt FLOORS → 998498 (NOT the float round 998499).
    // Verified against the implementation; pinned exactly here.
    assert.equal(sqrtOneMinusFeeScaled(3000), 998498n);
  });

  it("feeAdjust(x, 0) === x", () => {
    const x = 123456789012345678901234567890n;
    assert.equal(feeAdjust(x, 0), x);
  });

  it("feeAdjust(x, fee) < x for fee > 0", () => {
    const x = 79228162514264337593543950336n; // 2^96
    assert.ok(feeAdjust(x, 3000) < x);
    assert.ok(feeAdjust(x, 500) < x);
    // higher fee → smaller adjusted price
    assert.ok(feeAdjust(x, 3000) < feeAdjust(x, 500));
  });
});

// ─────────────────────────────────────────────────────────────
// 3. bracketCapacity & V2≡V3 unification
// ─────────────────────────────────────────────────────────────
describe("bracketCapacity", () => {
  const near = toOutIn(getSqrtRatioAtTick(0), true);
  const far = toOutIn(getSqrtRatioAtTick(-60), true);
  const L = 10n ** 21n;

  it("returns 0 for degenerate inputs", () => {
    assert.equal(bracketCapacity(0n, near, far, 3000), 0n); // L <= 0
    assert.equal(bracketCapacity(L, near, 0n, 3000), 0n); // sqrtFar <= 0
    assert.equal(bracketCapacity(L, far, near, 3000), 0n); // sqrtNear <= sqrtFar
    assert.equal(bracketCapacity(L, near, near, 3000), 0n); // equal edges
  });

  it("is monotonic: wider bracket (smaller far) → larger capacity", () => {
    const narrowFar = toOutIn(getSqrtRatioAtTick(-60), true);
    const widerFar = toOutIn(getSqrtRatioAtTick(-600), true);
    assert.ok(widerFar < narrowFar, "wider bracket has smaller far edge");
    assert.ok(bracketCapacity(L, near, widerFar, 3000) > bracketCapacity(L, near, narrowFar, 3000));
  });

  it("V2 ≡ V3: bracket effIn matches exact constant-product dx", () => {
    // A constant-product pool (xy=k) IS a single V3 bracket with L = sqrt(k).
    // reserves in tokenIn/tokenOut orientation:
    const reserveIn = 1_000_000n * 10n ** 18n;
    const reserveOut = 2_000_000n * 10n ** 18n;
    const k = reserveIn * reserveOut;
    const Lv2 = isqrt(k);

    // Out/in spot sqrt at the live price: sqrt(reserveOut/reserveIn), in Q96.
    const nearV2 = isqrt((reserveOut * Q192) / reserveIn);
    // Small step down (~0.25% in sqrt → ~0.5% in price).
    const farV2 = nearV2 - (nearV2 * 25n) / 10_000n;
    assert.ok(farV2 > 0n && farV2 < nearV2);

    // Bracket-formula effective input (fee 0 → effIn, no gross-up):
    const effInBracket = (Lv2 * Q96) / farV2 - (Lv2 * Q96) / nearV2;

    // Exact constant-product input dx to move the out/in PRICE from near^2 to far^2.
    // price_outin = reserveOut/reserveIn = k / reserveIn^2 (since reserveOut = k/reserveIn).
    // After adding dx in: newIn = reserveIn + dx, newOut = k/newIn,
    //   new price = newOut/newIn = k / newIn^2  ==  (farV2 / Q96)^2 = farV2^2 / Q192.
    //   ⇒ newIn^2 = k * Q192 / farV2^2  ⇒  newIn = isqrt(k * Q192 / farV2^2).
    const newIn = isqrt((k * Q192) / (farV2 * farV2));
    const dxExact = newIn - reserveIn;

    // Algebra: L*Q96/near = sqrt(k)*Q96 / (sqrt(reserveOut/reserveIn)*Q96)
    //                     = sqrt(k * reserveIn / reserveOut) = reserveIn (exactly),
    // and L*Q96/far = isqrt(k*Q192/far^2) = newIn, so effIn ≡ dx up to isqrt rounding.
    // Verified: exact (0 ppm) for this construction; allow 10 ppm for isqrt slack.
    assertClose(effInBracket, dxExact, 10n, "V2≡V3 unification");
  });
});

// ─────────────────────────────────────────────────────────────
// 4. Water-fill cut & conservation (via ecoSwapReference)
// ─────────────────────────────────────────────────────────────
describe("water-fill solver (ecoSwapReference)", () => {
  // Two V3 pools, different fee tiers, several brackets each.
  const pools = [v3Pool(3000, 60), v3Pool(500, 10)];
  const L = 10n ** 21n;
  const ladder = sortLadder([
    ...v3Brackets(0, 3000, L, 0, 60, 6),
    ...v3Brackets(1, 500, L * 2n, 5, 10, 8),
  ]);
  const prep = prepared(pools, ladder);
  const cap = totalCapacity(ladder);

  it("conservation: total spent ≤ amountIn, ≤ 1 wei short at a clean fill level", () => {
    // At fill levels where the water-fill cut lands ON a bracket boundary, Phase A
    // (capacity sums) and Phase B (per-pool spot reconstruction) reconcile to the
    // wei. Use 50% of capacity. (At mid-bracket cuts the two phases use different
    // integer formulas and can underspend more — characterized in the next test.)
    const amountIn = (cap * 1n) / 2n;
    const res = ecoSwapReference(prep, amountIn);
    assert.equal(res.totalInput, res.perPoolInput.reduce((a, b) => a + b, 0n), "Σ perPool === total");
    assert.ok(res.totalInput <= amountIn, "never overspends");
    const shortfall = amountIn - res.totalInput;
    assert.ok(shortfall <= 1n, `shortfall ${shortfall} should be ≤ 1 wei at a clean level`);
  });

  it("interior cut: the split actually splits (≥ 2 pools funded)", () => {
    const amountIn = (cap * 1n) / 2n;
    const res = ecoSwapReference(prep, amountIn);
    const funded = res.perPoolInput.filter((x) => x > 0n).length;
    assert.ok(funded >= 2, `expected ≥2 pools funded, got ${funded}`);
  });

  it("mid-bracket underspend is bounded and never overspends", () => {
    // Honest characterization: when the cut falls mid-bracket, Phase B's spot
    // reconstruction can leave a gap up to roughly one partial bracket. The
    // invariant that MUST hold everywhere is: never overspend, and Σ == total.
    const total = cap;
    for (let i = 1; i <= 50; i++) {
      const amountIn = (total * BigInt(i)) / 50n;
      const res = ecoSwapReference(prep, amountIn);
      assert.ok(res.totalInput <= amountIn, `overspend at i=${i}: ${res.totalInput} > ${amountIn}`);
      assert.equal(res.totalInput, res.perPoolInput.reduce((a, b) => a + b, 0n));
      // Underspend bounded by the largest single bracket capacity (the partial one).
      const maxBracket = ladder.reduce((m, b) => (b.capacity > m ? b.capacity : m), 0n);
      assert.ok(amountIn - res.totalInput <= maxBracket, `underspend exceeds one bracket at i=${i}`);
    }
  });

  it("over-capacity: fills everything, never exceeds total capacity", () => {
    const amountIn = cap * 2n;
    const res = ecoSwapReference(prep, amountIn);
    // amountIn exceeds all liquidity → cut stays 0 → every pool integrates to far edge.
    assert.equal(res.cutSqrtAdj, 0n, "cut is 0 when amountIn exceeds all capacity");
    assert.ok(res.totalInput <= cap, "cannot spend more than total capacity");
    // Should fill essentially all capacity (within isqrt/reconstruction slack).
    assertClose(res.totalInput, cap, 100n, "over-capacity fill ≈ total capacity");
  });

  it("single pool: all input routes to it", () => {
    const single = prepared([v3Pool(3000, 60)], v3Brackets(0, 3000, L, 0, 60, 6));
    const singleCap = totalCapacity(single.brackets);
    const amountIn = singleCap / 2n;
    const res = ecoSwapReference(single, amountIn);
    assert.equal(res.perPoolInput.length, 1);
    assert.equal(res.totalInput, res.perPoolInput[0], "all input to the one pool");
    assert.ok(res.totalInput > 0n && res.totalInput <= amountIn);
    assertClose(res.totalInput, amountIn, 10n, "single pool spends ≈ amountIn");
  });

  it("empty routes never throw and yield zeros", () => {
    const res = ecoSwapReference(prep, cap / 4n);
    assert.deepEqual(res.perRouteInput, []);
  });
});

// ─────────────────────────────────────────────────────────────
// 5. Water-fill cut & conservation — SINGLE-PASS (live-cut) variant
// ─────────────────────────────────────────────────────────────
describe("water-fill solver — single-pass (live-cut) [ecoSwapReference]", () => {
  // Reuse the module-level synthetic ladder fixtures (two V3 pools, different fee
  // tiers). ecoSwapReference dispatches to singlePassReference at CALL TIME based
  // on ECO_SOLVER, so flipping the env in before()/after() selects the single-pass
  // path for this block only without touching the two-pass blocks above/below.
  const pools = [v3Pool(3000, 60), v3Pool(500, 10)];
  const L = 10n ** 21n;
  const ladder = sortLadder([
    ...v3Brackets(0, 3000, L, 0, 60, 6),
    ...v3Brackets(1, 500, L * 2n, 5, 10, 8),
  ]);
  const prep = prepared(pools, ladder);
  const cap = totalCapacity(ladder);

  let savedSolver: string | undefined;
  before(() => {
    savedSolver = process.env.ECO_SOLVER;
    process.env.ECO_SOLVER = "singlepass";
  });
  after(() => {
    if (savedSolver === undefined) delete process.env.ECO_SOLVER;
    else process.env.ECO_SOLVER = savedSolver;
  });

  it("conservation: total spent === Σ perPoolInput", () => {
    for (const frac of [4n, 2n, 1n]) {
      const amountIn = cap / frac;
      const res = ecoSwapReference(prep, amountIn);
      assert.equal(
        res.totalInput,
        res.perPoolInput.reduce((a, b) => a + b, 0n),
        `Σ perPool === total (amountIn=${amountIn})`,
      );
    }
  });

  it("exact spend below capacity: total === amountIn to the wei", () => {
    // The single-pass crossing bracket takes precisely `amountIn - cum`, so below
    // total capacity it spends amountIn EXACTLY — the key contrast with two-pass,
    // which undershoots via per-pool re-derivation. Verified: `=== amountIn` holds
    // cleanly (diff 0) at 25/50/75% on this ladder, no off-by-N.
    for (const [num, den] of [[1n, 4n], [1n, 2n], [3n, 4n]] as const) {
      const amountIn = (cap * num) / den;
      const res = ecoSwapReference(prep, amountIn);
      assert.equal(res.totalInput, amountIn, `exact spend at ${num}/${den} of capacity`);
    }
  });

  it("interior cut: the split actually splits (≥ 2 pools funded)", () => {
    const amountIn = cap / 2n;
    const res = ecoSwapReference(prep, amountIn);
    const funded = res.perPoolInput.filter((x) => x > 0n).length;
    assert.ok(funded >= 2, `expected ≥2 pools funded, got ${funded}`);
  });

  it("over-capacity: fills ≈ all capacity, never exceeds it", () => {
    const amountIn = cap * 2n;
    const res = ecoSwapReference(prep, amountIn);
    // amountIn exceeds all liquidity → no crossing bracket → every bracket fills to
    // its far edge → total == Σ gross capacity.
    assert.ok(res.totalInput <= cap, "cannot spend more than total capacity");
    assertClose(res.totalInput, cap, 100n, "over-capacity fill ≈ total capacity");
  });
});
