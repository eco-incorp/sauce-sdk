/**
 * EcoSwap pure-math unit tests (EVM-free, deterministic bigint).
 *
 * Exercises the integer math that prepare.ts uses to build the bracket ladder,
 * plus the on-chain water-fill solver via the ecoSwapReference oracle. The math
 * helpers under test live in ./ecoswap.math (faithful copies of prepare.ts's
 * non-exported helpers — see that file's header).
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.math.test.ts
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Q96,
  Q192,
  FEE_DENOM,
  OFFSET,
  isqrt,
  sqrtOneMinusFeeScaled,
  feeAdjust,
  bracketCapacity,
  getSqrtRatioAtTick,
  toOutIn,
  V2_STEP_BPS,
  V2_STEP_DEN,
  v2WalkGross,
} from "./ecoswap.math";
import { ecoSwapReference } from "./ecoswap.reference";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
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

/** Synthetic V2 pool (constant-product, engine fee 0.3%). */
function v2Pool(): EcoPool {
  return {
    poolType: SwapPoolType.UniV2,
    address: "0x00000000000000000000000000000000000000a2" as `0x${string}`,
    fee: 3000,
    tickSpacing: 0,
    hooks: "0x0000000000000000000000000000000000000000",
    feePpm: 3000,
    isV2: true,
    inIsToken0: true,
    source: "synthetic-v2",
  };
}

/**
 * Build a V2 pool's window brackets exactly as prepare.ts's buildV2Brackets: geometric
 * out/in steps (far = near - near*V2_STEP_BPS/V2_STEP_DEN) at constant L = √k, fee 0.3%.
 * Returns the brackets AND the deepest far (out/in frontier the WS2 #104 stream resumes from).
 */
function v2Brackets(refIdx: number, L: bigint, spotNear: bigint, feePpm: number, n: number): { brackets: EcoBracket[]; deepestFar: bigint } {
  const out: EcoBracket[] = [];
  let near = spotNear;
  for (let i = 0; i < n; i++) {
    const far = near - (near * V2_STEP_BPS) / V2_STEP_DEN;
    if (far <= 0n || far >= near) break;
    out.push({
      kind: EcoBracketKind.V2,
      refIdx,
      sqrtNear: near,
      sqrtFar: far,
      liquidity: L,
      capacity: bracketCapacity(L, near, far, feePpm),
      sqrtAdjNear: feeAdjust(near, feePpm),
      sqrtAdjFar: feeAdjust(far, feePpm),
    });
    near = far;
  }
  return { brackets: out, deepestFar: out.length ? out[out.length - 1].sqrtFar : 0n };
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

// ── new-model live fixtures (unified walk: spot fields + net + stepRatio) ──

/**
 * A constant-L V3 EcoPool walked from the prepare-time spot (empty net) + its matching neutral
 * OptimalPool, so a vector can assert ecoSwapReference == optimalSplit to the wei. zeroForOne
 * fixed true (unified out/in == real sqrt) for the math-tier vectors.
 */
function buildV3Live(refIdx: number, feePpm: number, ts: number, L: bigint, prepTick: number): { pool: EcoPool; opt: OptimalPool } {
  const spotReal = getSqrtRatioAtTick(prepTick);
  const stepRatio = getSqrtRatioAtTick(ts);
  const base = Math.floor(prepTick / ts) * ts;
  const spotBoundaryShifted = BigInt(base + Number(OFFSET));
  const pool: EcoPool = {
    ...v3Pool(feePpm, ts),
    stepRatio,
    windowTopShifted: 0n, // no cache → staticcall path (the reference reads the empty net map)
    windowBotShifted: 0n,
    extremeShifted: 0n, // empty net ⇒ constant-L curve, no gap gate
    spotTickShifted: spotBoundaryShifted,
    spotNearReal: spotReal,
    spotActiveL: L,
    adaptiveNet: new Map<number, bigint>(),
  };
  const opt: OptimalPool = {
    isV2: false, feePpm, sqrtPriceX96: spotReal, tick: prepTick, tickSpacing: ts, liquidity: L,
    net: new Map<number, bigint>(),
  };
  return { pool, opt };
}

/** A V2 EcoPool seeded with the live out/in spot + √k (new model) + its matching OptimalPool. */
function buildV2Live(reserveIn: bigint, reserveOut: bigint): { pool: EcoPool; opt: OptimalPool } {
  const L = isqrt(reserveIn * reserveOut);
  const spotOI = isqrt((reserveOut * Q192) / reserveIn);
  const pool: EcoPool = {
    ...v2Pool(),
    spotNearReal: spotOI, // V2 frontier seed (out/in spot)
    spotActiveL: L, // √k
  };
  const opt: OptimalPool = { isV2: true, feePpm: 3000, reserveIn, reserveOut };
  return { pool, opt };
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
// 4. Water-fill cut & conservation — single-pass live-cut (via ecoSwapReference)
// ─────────────────────────────────────────────────────────────
describe("water-fill solver — unified live walk [ecoSwapReference == oracle]", () => {
  // Two constant-L V3 pools, different fee tiers, both at spot tick 0. The unified solver walks
  // each pool's live frontier; ecoSwapReference mirrors it and must equal the neutral oracle.
  const L = 10n ** 24n; // deep enough that the merge reaches a clean interior cut for these sizes
  const p0 = buildV3Live(0, 3000, 60, L, 0);
  const p1 = buildV3Live(1, 500, 10, L * 2n, 0);
  const prep: EcoSwapPrepared = {
    pools: [p0.pool, p1.pool], routes: [], brackets: [], zeroForOne: true, priceLimit: 0n, expectedInputCovered: 0n,
  };
  const optPools = [p0.opt, p1.opt];
  const E18 = 10n ** 18n;

  it("conservation: total spent === Σ perPoolInput", () => {
    for (const amountIn of [100n * E18, 2000n * E18, 50000n * E18]) {
      const res = ecoSwapReference(prep, amountIn);
      assert.equal(
        res.totalInput,
        res.perPoolInput.reduce((a, b) => a + b, 0n),
        `Σ perPool === total (amountIn=${amountIn})`,
      );
    }
  });

  it("exact spend within liquidity: total === amountIn AND split == oracle to the wei", () => {
    for (const amountIn of [100n * E18, 2000n * E18, 50000n * E18]) {
      const res = ecoSwapReference(prep, amountIn);
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: 0n });
      assert.equal(res.totalInput, amountIn, `spends amountIn exactly (amountIn=${amountIn})`);
      assert.equal(res.perPoolInput[0], opt.perPoolInput[0], `pool0 == oracle (amountIn=${amountIn})`);
      assert.equal(res.perPoolInput[1], opt.perPoolInput[1], `pool1 == oracle (amountIn=${amountIn})`);
    }
  });

  it("interior cut: the split actually splits (≥ 2 pools funded)", () => {
    const amountIn = 50000n * E18;
    const res = ecoSwapReference(prep, amountIn);
    const funded = res.perPoolInput.filter((x) => x > 0n).length;
    assert.ok(funded >= 2, `expected ≥2 pools funded, got ${funded}`);
  });

  it("single pool: all input routes to it == oracle", () => {
    const single: EcoSwapPrepared = {
      pools: [buildV3Live(0, 3000, 60, L, 0).pool], routes: [], brackets: [],
      zeroForOne: true, priceLimit: 0n, expectedInputCovered: 0n,
    };
    const amountIn = 1000n * E18;
    const res = ecoSwapReference(single, amountIn);
    const opt = optimalSplit({ pools: [buildV3Live(0, 3000, 60, L, 0).opt], amountIn, zeroForOne: true, priceLimit: 0n });
    assert.equal(res.perPoolInput.length, 1);
    assert.equal(res.totalInput, res.perPoolInput[0], "all input to the one pool");
    assert.equal(res.totalInput, amountIn, "single deep pool spends amountIn exactly");
    assert.equal(res.perPoolInput[0], opt.perPoolInput[0], "single pool fill == oracle");
  });

  it("empty routes never throw and yield zeros", () => {
    const res = ecoSwapReference(prep, 100n * E18);
    assert.deepEqual(res.perRouteInput, []);
  });
});

// ─────────────────────────────────────────────────────────────
// 5. Drift — the unified walk re-reads the live spot (no pre-fill mechanism) [ref == oracle]
// ─────────────────────────────────────────────────────────────
describe("drift — walk from the live spot [ecoSwapReference == oracle]", () => {
  // ONE V3 pool (fee 3000, ts 60), constant L (empty net). Prepare-time spot = tick 0; the
  // modeled LIVE price has drifted UP to tick 600 (against the zeroForOne swap). The unified
  // walk re-reads the live spot and walks from tick 600 down — there is no separate "pre-fill"
  // mode; drift is just a different live spot. The neutral oracle (given the same live tick)
  // walks the identical grid, so reference == oracle to the wei.
  const L = 10n ** 24n;
  const FEE = 3000;
  const STEP = getSqrtRatioAtTick(60);
  const spotReal = getSqrtRatioAtTick(0);
  const driftTick = 600;
  const liveReal = getSqrtRatioAtTick(driftTick);
  const E18 = 10n ** 18n;

  function drifted(): EcoSwapPrepared {
    const base = buildV3Live(0, FEE, 60, L, 0);
    const pool: EcoPool = {
      ...base.pool,
      stepRatio: STEP,
      // modeled live (drifted-up) state — the reference adapter forwards these to the walk seed.
      liveCurRealOverride: liveReal,
      liveTickOverride: driftTick,
      liveLOverride: L,
    };
    return { pools: [pool], routes: [], brackets: [], zeroForOne: true, priceLimit: 0n, expectedInputCovered: 0n };
  }
  function optPools(): OptimalPool[] {
    return [{ isV2: false, feePpm: FEE, sqrtPriceX96: liveReal, tick: driftTick, tickSpacing: 60, liquidity: L, net: new Map() }];
  }

  for (const amountIn of [100n * E18, 5000n * E18, 50000n * E18]) {
    it(`drift-UP amountIn=${amountIn} — walk from the live spot == oracle, wei-exact`, () => {
      const res = ecoSwapReference(drifted(), amountIn);
      const opt = optimalSplit({ pools: optPools(), amountIn, zeroForOne: true, priceLimit: 0n });
      assert.equal(res.totalInput, amountIn, "spends amountIn exactly");
      assert.equal(res.perPoolInput[0], opt.perPoolInput[0], "pool fill == oracle to the wei");
    });
  }

  it("no override (modeled live == spot) — also matches the oracle at spot", () => {
    const base = buildV3Live(0, FEE, 60, L, 0);
    const noDrift: EcoSwapPrepared = {
      pools: [{ ...base.pool, stepRatio: STEP }], routes: [], brackets: [],
      zeroForOne: true, priceLimit: 0n, expectedInputCovered: 0n,
    };
    const amountIn = 1000n * E18;
    const res = ecoSwapReference(noDrift, amountIn);
    const opt = optimalSplit({ pools: [base.opt], amountIn, zeroForOne: true, priceLimit: 0n });
    assert.equal(res.totalInput, amountIn, "no-drift spends amountIn exactly");
    assert.equal(res.perPoolInput[0], opt.perPoolInput[0], "no-drift fill == oracle at spot");
  });
});

// ─────────────────────────────────────────────────────────────
// 6. V2 constant-L stream — the live walk streams geometric slices [ref == oracle]
// ─────────────────────────────────────────────────────────────
describe("V2 constant-L stream from the live spot [ecoSwapReference == oracle]", () => {
  // ONE synthetic V2 pool (constant-product √k, engine fee 0.3%). The unified solver streams
  // geometric out/in slices from the LIVE out/in spot at the constant √k (no ticks, no cache).
  // The neutral oracle's v2Segments walks the identical chain, so reference == oracle to the wei.
  const reserveIn = 1_000_000n * 10n ** 18n;
  const reserveOut = 2_000_000n * 10n ** 18n;
  const k = reserveIn * reserveOut;
  const L = isqrt(k); // √k = the constant V2 liquidity
  const spotNear = isqrt((reserveOut * Q192) / reserveIn); // out/in spot sqrt
  const E18 = 10n ** 18n;

  function preparedV2(): EcoSwapPrepared {
    const { pool } = buildV2Live(reserveIn, reserveOut);
    return { pools: [pool], routes: [], brackets: [], zeroForOne: true, priceLimit: 0n, expectedInputCovered: 0n };
  }
  const optPools: OptimalPool[] = [{ isV2: true, feePpm: 3000, reserveIn, reserveOut }];

  for (const amountIn of [100n * E18, 5000n * E18, 50000n * E18]) {
    it(`V2 amountIn=${amountIn} — constant-L stream == oracle, wei-exact`, () => {
      const res = ecoSwapReference(preparedV2(), amountIn);
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: 0n });
      assert.equal(res.totalInput, amountIn, "spends amountIn exactly");
      assert.equal(res.perPoolInput[0], opt.perPoolInput[0], "V2 fill == oracle to the wei");
    });
  }

  it("effIn telescopes to one constant-product integral L·(1/farFinal − 1/spotNear)", () => {
    // The geometric chain (window + stream) at constant L is a single √k curve, so the
    // raw effIn (pre-fee-grossup) telescopes EXACTLY: interior boundary terms cancel and
    // Σ effIn == L·Q96/farFinal − L·Q96/spotNear. We walk the full window+stream span
    // (no amountIn cap) and check the telescoped identity to the wei, independent of the
    // oracle (this is the constant-product integral the V2 stream is integrating).
    const TOTAL_SLICES = 68;
    // Reproduce the exact slice boundaries the walk visits.
    let near = spotNear;
    let sumEffIn = 0n;
    let farFinal = spotNear;
    for (let i = 0; i < TOTAL_SLICES; i++) {
      const far = near - (near * V2_STEP_BPS) / V2_STEP_DEN;
      if (far <= 0n || far >= near) break;
      // effIn for this slice (pre-grossup), same integer math as the oracle.
      sumEffIn += (L * Q96) / far - (L * Q96) / near;
      farFinal = far;
      near = far;
    }
    // Telescoped closed form: every interior L·Q96/boundary cancels.
    const telescoped = (L * Q96) / farFinal - (L * Q96) / spotNear;
    assert.equal(sumEffIn, telescoped, "Σ per-slice effIn telescopes to L·Q96/farFinal − L·Q96/spotNear (exact)");
  });
});

// ─────────────────────────────────────────────────────────────
// 7. INTERIOR L==0 GAP — walk THROUGH a dead tick range (Issue-2 proof)
// ─────────────────────────────────────────────────────────────
//
// A single V3 pool whose active L drops to 0 at an INTERIOR tick range, then RESUMES deeper.
// The unified solver must NOT drop the pool at the gap: it walks THROUGH the dead range
// (contributing 0 while L==0) and resumes when net brings L back, terminating only past the
// deepest initialized tick (extremeShifted). The neutral oracle (ecoswap.optimal.ts) walks the
// same live grid through the same gap, so reference == oracle TO THE WEI is the proof that the
// gap is handled identically. Sized so the cut lands DEEPER than the gap (into the resumed-L
// region) — exercising the gap traversal AND the L resume.
describe("interior L==0 gap — solver walks through and resumes [ecoSwapReference == oracle]", () => {
  const FEE = 500;
  const TS = 10;
  const STEP = getSqrtRatioAtTick(TS);
  const spotReal = getSqrtRatioAtTick(0);
  const L_HI = 5n * 10n ** 24n; // active L from spot down to the gap
  const L_LO = 3n * 10n ** 24n; // resumed L below the gap

  // Gap geometry (zeroForOne, price descending): active L_HI from tick 0; crossing GAP_TOP
  // removes ALL of it (L→0, the interior dead range); crossing GAP_BOT adds L_LO back (resume);
  // crossing EXTREME removes L_LO (the deepest initialized tick). Net keyed by SIGNED tick.
  const GAP_TOP = -1000;
  const GAP_BOT = -3000;
  const EXTREME = -60000;
  const net = new Map<number, bigint>([
    [GAP_TOP, -L_HI], // L_HI → 0 (gap begins)
    [GAP_BOT, L_LO],  // 0 → L_LO (resume)
    [EXTREME, -L_LO], // L_LO → 0 (deepest initialized tick)
  ]);

  function preparedGap(): EcoSwapPrepared {
    const pool: EcoPool = {
      ...v3Pool(FEE, TS),
      stepRatio: STEP,
      // Full cache window [spot, deep] so the gap boundaries are served from the netCache (the
      // in-window cursor path); extremeShifted = the deepest initialized tick (the terminate gate).
      windowTopShifted: OFFSET, // spot boundary (tick 0 + OFFSET)
      windowBotShifted: OFFSET + BigInt(EXTREME), // deepest scanned (well past the gap)
      extremeShifted: OFFSET + BigInt(EXTREME),
      spotTickShifted: OFFSET, // spot boundary (zeroForOne base = 0)
      spotNearReal: spotReal,
      spotActiveL: L_HI,
      adaptiveNet: net,
    };
    return { pools: [pool], routes: [], brackets: [], zeroForOne: true, priceLimit: 0n, expectedInputCovered: 0n };
  }

  function optPools(): OptimalPool[] {
    return [
      { isV2: false, feePpm: FEE, sqrtPriceX96: spotReal, tick: 0, tickSpacing: TS, liquidity: L_HI, net },
    ];
  }

  // The trade is bigger than the L_HI region above the gap (so the walk MUST cross the gap) but
  // within the total liquidity (so it fully fills in the resumed-L region). Capacity above the
  // gap ≈ L_HI·Q96·(1/sqrt(GAP_TOP) − 1/spot); pick amountIn comfortably past it.
  const aboveGapEffIn = (L_HI * Q96) / getSqrtRatioAtTick(GAP_TOP) - (L_HI * Q96) / spotReal;
  const aboveGapGross = (aboveGapEffIn * FEE_DENOM) / BigInt(1_000_000 - FEE);

  it("fills through the interior L==0 gap — reference == oracle to the wei", () => {
    const amountIn = aboveGapGross * 3n; // forces the walk past the gap into the resumed-L region
    const ref = ecoSwapReference(preparedGap(), amountIn);
    const opt = optimalSplit({ pools: optPools(), amountIn, zeroForOne: true, priceLimit: 0n });
    assert.equal(ref.totalInput, amountIn, "spends amountIn exactly (gap + resumed region cover it)");
    assert.equal(ref.totalInput, opt.totalInput, "total == oracle");
    assert.equal(ref.perPoolInput[0], opt.perPoolInput[0], "pool fill == oracle to the wei");
    // The fill EXCEEDS the above-gap capacity → the walk truly crossed the dead range.
    assert.ok(ref.perPoolInput[0] > aboveGapGross, `fill crossed the gap (${ref.perPoolInput[0]} > ${aboveGapGross})`);
  });

  it("smaller trade stopping ABOVE the gap also matches the oracle (gap not yet reached)", () => {
    const amountIn = aboveGapGross / 2n; // cut lands above the gap
    const ref = ecoSwapReference(preparedGap(), amountIn);
    const opt = optimalSplit({ pools: optPools(), amountIn, zeroForOne: true, priceLimit: 0n });
    assert.equal(ref.totalInput, amountIn, "spends amountIn exactly above the gap");
    assert.equal(ref.perPoolInput[0], opt.perPoolInput[0], "pool fill == oracle to the wei");
  });
});

// ─────────────────────────────────────────────────────────────
// 8. PER-POOL NET CURSOR — drift-down skip, drift-up out-of-window, in-window uninitialized
// ─────────────────────────────────────────────────────────────
//
// The unified solver's per-pool NET CURSOR is the one mechanism with no fast-tier coverage
// until these vectors (it was only exercised end-to-end on the EVM lane). ecoSwapReference is
// now CURSOR-MECHANISM-FAITHFUL: it builds the SAME per-pool netCache rows the on-chain pool
// tuple carries (shiftedTick, rawNet, sorted swap-direction, only INITIALIZED ticks), runs the
// SAME SETUP drift-down skip, reads an IN-WINDOW boundary via the cursor (matching tick ⇒
// cached net + advance; in-window non-match ⇒ net 0, NO map read) and an OUT-OF-WINDOW boundary
// via the full adaptiveNet map (the TS analogue of a live staticcall). It asserts inline that
// the cursor-path net == the full-map net for EVERY crossed in-window boundary (throws on
// mismatch), so a cursor off-by-one fails the vector — not just the EVM lane.
//
// These drive each cursor branch directly and assert (1) reference == oracle to the wei, (2)
// the cursor path actually ran (cursorChecks non-empty) and never mismatched, in BOTH swap
// directions. The oracle (ecoswap.optimal.ts) walks the full live net curve from the live spot
// with NO cache, so reference == oracle is the proof the cursor reproduces the live-read net.
describe("per-pool net cursor — drift-down skip / drift-up out-of-window / in-window gap [ref == oracle]", () => {
  const FEE = 500;
  const TS = 10;
  const STEP = getSqrtRatioAtTick(TS);

  /**
   * Build a V3 EcoPool whose live frontier is walked over a scanned window of `nScanned`
   * boundaries from the prepare-time spot tick `prepTick`, carrying a signed-net curve `net`
   * (keyed by SIGNED tick) — and stamp the per-pool netCache rows EXACTLY as prepare.ts's
   * stampPoolCache (only initialized ticks, shifted + raw uint128, sorted swap-direction).
   * Optionally model a LIVE drift to `liveTick` with active L `liveL` (the on-chain SETUP read).
   * Returns the EcoPool + the matching neutral OptimalPool (true live state, full net, no cache).
   */
  function buildCursorPool(
    feePpm: number,
    ts: number,
    prepTick: number,
    nScanned: number,
    startL: bigint,
    net: Map<number, bigint>,
    zeroForOne: boolean,
    drift?: { liveTick: number; liveL: bigint },
  ): { pool: EcoPool; opt: OptimalPool } {
    const OFF = Number(OFFSET);
    const MOD128 = 1n << 128n;
    const prepReal = getSqrtRatioAtTick(prepTick);
    const stepRatio = getSqrtRatioAtTick(ts);
    const base = Math.floor(prepTick / ts) * ts;
    const startBoundary = zeroForOne ? base : base + ts; // shallowest scanned boundary (signed)
    const step = zeroForOne ? -ts : ts;
    const spotBoundaryShifted = BigInt(startBoundary + OFF);
    const windowBotShifted = spotBoundaryShifted + BigInt(step) * BigInt(nScanned > 0 ? nScanned - 1 : 0);
    // netCache rows: only INITIALIZED ticks (net != 0), shifted + RAW uint128, sorted swap-dir.
    const rows: { shiftedTick: bigint; rawNet: bigint }[] = [];
    for (const [tick, signed] of net) {
      if (signed === 0n) continue;
      const raw = signed >= 0n ? signed : signed + MOD128;
      rows.push({ shiftedTick: BigInt(tick + OFF), rawNet: raw });
    }
    rows.sort((a, b) =>
      zeroForOne
        ? a.shiftedTick < b.shiftedTick ? 1 : a.shiftedTick > b.shiftedTick ? -1 : 0
        : a.shiftedTick < b.shiftedTick ? -1 : a.shiftedTick > b.shiftedTick ? 1 : 0,
    );
    const initTicks = [...net.entries()].filter(([, n]) => n !== 0n).map(([t]) => t);
    const extremeShifted = initTicks.length === 0
      ? 0n
      : BigInt((zeroForOne ? Math.min(...initTicks) : Math.max(...initTicks)) + OFF);
    const pool: EcoPool = {
      poolType: SwapPoolType.UniV3,
      address: ("0x" + feePpm.toString(16).padStart(40, "0")) as `0x${string}`,
      fee: feePpm, tickSpacing: ts, hooks: "0x0000000000000000000000000000000000000000",
      feePpm, isV2: false, inIsToken0: zeroForOne,
      stateView: "0x0000000000000000000000000000000000000000",
      poolId: "0x0000000000000000000000000000000000000000000000000000000000000000",
      stepRatio,
      windowTopShifted: nScanned > 0 ? spotBoundaryShifted : 0n,
      windowBotShifted: nScanned > 0 ? windowBotShifted : 0n,
      extremeShifted,
      spotTickShifted: spotBoundaryShifted,
      spotNearReal: prepReal,
      spotActiveL: startL,
      netRows: rows,
      adaptiveNet: net,
      source: "synthetic-cursor",
    };
    if (drift) {
      pool.liveCurRealOverride = getSqrtRatioAtTick(drift.liveTick);
      pool.liveTickOverride = drift.liveTick;
      pool.liveLOverride = drift.liveL;
    }
    const opt: OptimalPool = {
      isV2: false, feePpm,
      sqrtPriceX96: drift ? getSqrtRatioAtTick(drift.liveTick) : prepReal,
      tick: drift ? drift.liveTick : prepTick,
      tickSpacing: ts,
      liquidity: drift ? drift.liveL : startL,
      net,
    };
    return { pool, opt };
  }

  // Direction-appropriate real-sqrt price extreme (the solver's dlim guard is unconditional, so a
  // zero limit would mis-trip for oneForZero — mirror prepare.ts's direction-dependent priceLimit).
  const MIN_SQRT = 4295128740n; // MIN_SQRT_RATIO + 1
  const MAX_SQRT = 1461446703485210103287273052203988822378723970341n; // MAX_SQRT_RATIO - 1
  function run(pool: EcoPool, opt: OptimalPool, amountIn: bigint, zeroForOne: boolean) {
    const priceLimit = zeroForOne ? MIN_SQRT : MAX_SQRT;
    const prep: EcoSwapPrepared = {
      pools: [pool], routes: [], brackets: [], zeroForOne, priceLimit, expectedInputCovered: 0n,
    };
    const ref = ecoSwapReference(prep, amountIn);
    const o = optimalSplit({ pools: [opt], amountIn, zeroForOne, priceLimit });
    return { ref, o };
  }

  const E18 = 10n ** 18n;
  // Modest L so a realistic amountIn walks DEEP through the window (crosses the cached rows). The
  // curve drains L to 0 at the deepest initialized tick, so an OVERSIZED amountIn (> total
  // capacity) walks the whole window and terminates at the extreme — the same place the oracle
  // does — guaranteeing every in-window initialized row is crossed by the cursor. The shared
  // capped fill is wei-exact between reference and oracle.
  const L_HI = 5n * 10n ** 20n;
  const L_MID = 2n * 10n ** 20n;
  const BIG = 10n ** 12n * E18; // far beyond any pool's capacity here ⇒ walk runs to exhaustion

  // ── (a) DRIFT-DOWN: live spot below several cached rows ⇒ the SETUP skip fires ──
  // zeroForOne (price descending): prepare-time spot at tick 0; window covers ticks [0 .. -7990].
  // Initialized rows at -100, -200, -400 sit ABOVE the live spot tick -500, so the SETUP drift-
  // down skip advances the cursor PAST all three before the walk begins (the live spot already
  // moved below them). The deeper rows at -1000 / -3000 are crossed in-window via the cursor. The
  // oracle walks from live tick -500 over the SAME net curve, so the skipped rows are simply never
  // crossed (not double-counted) and reference == oracle to the wei.
  for (const [dir, zeroForOne] of [["zeroForOne", true], ["oneForZero", false]] as const) {
    it(`(a) DRIFT-DOWN ${dir} — SETUP skip advances cursor past above-rows; ref == oracle, skipped not double-counted`, () => {
      // Mirror tick signs across direction so "drift-down in swap space" holds for both: zeroForOne
      // walks toward NEGATIVE ticks, oneForZero toward POSITIVE; sgn flips the curve.
      const sgn = zeroForOne ? 1 : -1;
      const net = new Map<number, bigint>([
        [sgn * -100, L_MID],            // rows ABOVE the live spot (skipped in SETUP) — arbitrary
        [sgn * -200, -L_MID],           // (live override carries the true L at -500 directly)
        [sgn * -400, L_HI],
        [sgn * -1000, -L_MID],          // in-window row crossed via the cursor
        [sgn * -3000, -(L_HI - L_MID)], // deepest initialized tick: drains L to 0
      ]);
      // Active L AT the drifted live spot tick -500 (the on-chain SETUP read) = L_HI. The oracle
      // gets the same live tick + live L, so neither re-applies the skipped above-rows.
      const liveTick = sgn * -500;
      const { pool, opt } = buildCursorPool(FEE, TS, 0, 800, L_HI, net, zeroForOne, { liveTick, liveL: L_HI });
      const { ref, o } = run(pool, opt, BIG, zeroForOne);
      assert.equal(ref.totalInput, o.totalInput, "total == oracle");
      assert.equal(ref.perPoolInput[0], o.perPoolInput[0], "pool fill == oracle to the wei");
      assert.ok(ref.totalInput < BIG, "the curve drains (walk ran to liquidity exhaustion past the extreme)");
      assert.ok(ref.cursorChecks.length > 0, "the in-window cursor path was exercised");
      // The three above-rows were skipped (cursor never crossed them) — not double-counted.
      const skippedTicks = new Set([sgn * -100, sgn * -200, sgn * -400].map((t) => BigInt(t + Number(OFFSET))));
      for (const c of ref.cursorChecks) {
        assert.ok(!skippedTicks.has(c.shifted), `skipped row ${c.shifted} must not be crossed by the cursor`);
        assert.equal(c.cursorNet, c.mapNet, `cursor net == map net at ${c.shifted}`);
      }
      // The two below-spot rows WERE crossed via the cursor (the SETUP skip stopped at them).
      const inWindow = new Set([sgn * -1000, sgn * -3000].map((t) => BigInt(t + Number(OFFSET))));
      const crossed = ref.cursorChecks.filter((c) => inWindow.has(c.shifted));
      assert.equal(crossed.length, 2, "both below-spot initialized rows crossed via the cursor");
    });
  }

  // ── (b) DRIFT-UP: live spot ABOVE windowTop ⇒ out-of-window reads above, then enters cache ──
  // zeroForOne: prepare-time spot at tick 0; window covers [0 .. -7990]. Live spot drifted UP to
  // tick +500 (against the swap). The walk starts at +500 and the first 50 boundaries (+500..+10,
  // ABOVE windowTop = tick 0) are OUT-OF-WINDOW → read via the full adaptiveNet map (the staticcall
  // analogue; all uninitialized here ⇒ net 0, but via the OUT-OF-WINDOW branch, not the cursor),
  // THEN the walk descends into the window [0 .. -7990] and reads via the cursor. (Realistic shape:
  // prepare only ever caches ticks WITHIN the scanned window, so the drift-up region above the
  // window carries no cached rows — the cursor must stay parked at its first in-window row through
  // the whole out-of-window descent, then serve -1000 / -3000.) Oracle walks from +500 over the
  // full net curve, so reference == oracle to the wei AND the cursor still serves the in-window rows.
  for (const [dir, zeroForOne] of [["zeroForOne", true], ["oneForZero", false]] as const) {
    it(`(b) DRIFT-UP ${dir} — out-of-window map reads above windowTop THEN cursor in-window; ref == oracle`, () => {
      const sgn = zeroForOne ? 1 : -1;
      const net = new Map<number, bigint>([
        [sgn * -1000, -L_MID],          // IN window (cursor-read)
        [sgn * -3000, -(L_HI - L_MID)], // deepest initialized tick: drains L to 0 (cursor-read)
      ]);
      // Live spot at +500 (against the swap), active L there = L_HI. The walk descends through the
      // OUT-OF-WINDOW region [+500 .. +10] (above windowTop = tick 0; net 0 via the map), enters
      // the window at tick 0, and serves the in-window rows via the cursor.
      const liveTick = sgn * 500;
      const { pool, opt } = buildCursorPool(FEE, TS, 0, 800, L_HI, net, zeroForOne, { liveTick, liveL: L_HI });
      const { ref, o } = run(pool, opt, BIG, zeroForOne);
      assert.equal(ref.totalInput, o.totalInput, "total == oracle");
      assert.equal(ref.perPoolInput[0], o.perPoolInput[0], "pool fill == oracle to the wei");
      assert.ok(ref.cursorChecks.length > 0, "the in-window cursor path was exercised");
      // The drift-up region above windowTop was crossed OUT-OF-WINDOW (no cursor checks there);
      // every cursor check sits on the IN-WINDOW side of windowTop (the swap-direction "deep"
      // side: zeroForOne walks toward SMALLER shifted ticks ⇒ in-window is <= windowTop; oneForZero
      // toward LARGER ⇒ in-window is >= windowTop), proving the descent entered the cache only
      // after the out-of-window region.
      const windowTopShifted = pool.windowTopShifted!;
      for (const c of ref.cursorChecks) {
        const onInWindowSide = zeroForOne ? c.shifted <= windowTopShifted : c.shifted >= windowTopShifted;
        assert.ok(onInWindowSide, `cursor check ${c.shifted} must be in-window (windowTop side)`);
        assert.equal(c.cursorNet, c.mapNet, `cursor net == map net at ${c.shifted}`);
      }
      // And the in-window initialized rows WERE crossed via the cursor.
      const inWindow = new Set([sgn * -1000, sgn * -3000].map((t) => BigInt(t + Number(OFFSET))));
      const crossed = ref.cursorChecks.filter((c) => inWindow.has(c.shifted));
      assert.equal(crossed.length, 2, "both in-window initialized rows crossed via the cursor");
    });
  }

  // ── (c) IN-WINDOW UNINITIALIZED boundary between two initialized rows (net 0, no advance) ──
  // No drift: live == prepare spot. Two initialized rows at -1000 and -3000, both IN-WINDOW. The
  // ~199 boundaries between them (-1010, -1020, ... -2990) are uninitialized: the cursor must read
  // net 0 (NO map read, NO advance) at each, then consume the -3000 row only when the walk reaches
  // it. If the cursor wrongly advanced on an uninitialized tick it would consume the -3000 row
  // early (wrong tick) → net mismatch (caught inline) AND a wrong split. Oracle walks the same curve.
  for (const [dir, zeroForOne] of [["zeroForOne", true], ["oneForZero", false]] as const) {
    it(`(c) IN-WINDOW UNINITIALIZED gap ${dir} — net 0, cursor does NOT advance; ref == oracle`, () => {
      const sgn = zeroForOne ? 1 : -1;
      const net = new Map<number, bigint>([
        [sgn * -1000, -L_MID],          // first initialized row in window
        [sgn * -3000, -(L_HI - L_MID)], // second initialized row, drains L to 0 — long gap before it
      ]);
      // No drift: start L = L_HI at spot tick 0; the uninitialized ticks between -1000 and -3000
      // keep L constant (L_HI - L_MID), so the cursor must NOT advance over them.
      const { pool, opt } = buildCursorPool(FEE, TS, 0, 800, L_HI, net, zeroForOne);
      const { ref, o } = run(pool, opt, BIG, zeroForOne);
      assert.equal(ref.totalInput, o.totalInput, "total == oracle");
      assert.equal(ref.perPoolInput[0], o.perPoolInput[0], "pool fill == oracle to the wei");
      assert.ok(ref.cursorChecks.length > 0, "the in-window cursor path was exercised");
      // Every cursor net matches the full-map net (the inline assertion already guards this).
      for (const c of ref.cursorChecks) {
        assert.equal(c.cursorNet, c.mapNet, `cursor net == map net at ${c.shifted}`);
      }
      // Exactly the two initialized rows produced a non-zero cursor net; the long gap produced
      // many net-0 cursor reads where the cursor did NOT advance (the in-window-uninitialized path).
      const nonZero = ref.cursorChecks.filter((c) => c.cursorNet !== 0n);
      assert.equal(nonZero.length, 2, "exactly the two initialized rows produced a non-zero cursor net");
      const zeroChecks = ref.cursorChecks.filter((c) => c.cursorNet === 0n);
      assert.ok(zeroChecks.length > 100, "the uninitialized gap produced many net-0 cursor reads (no advance)");
    });
  }
});
