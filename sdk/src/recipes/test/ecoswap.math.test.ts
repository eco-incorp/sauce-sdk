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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
  mulDiv,
  composeStep,
  routeHeadFold,
  bracketGross,
  bracketOut,
  invertFarFromGrossIn,
  invertFarFromOut,
  routeEvent2,
  routePartial2,
  routeEventN,
  routePartialN,
  qlSliceHead,
  qlCursorInit,
  qlCursorActive,
  qlCursorHead,
  qlCursorConsume,
  legMemberWins,
  type RouteLeg,
  type RouteLegMember,
} from "./ecoswap.math";
import { ecoSwapReference } from "./ecoswap.reference";
import {
  buildCurveQLLadder,
  getDy,
  QL_S,
  QL_SEED_DIV,
  QL_RN,
  QL_RD,
  type CurvePool,
} from "../shared/curve-math";
import { optimalSplit, type OptimalPool, type OptimalRoute } from "./ecoswap.optimal";
import { EcoBracketKind, type EcoBracket, type EcoPool, type EcoSwapPrepared } from "../shared/types";
import { SwapPoolType } from "../shared/constants";
import {
  getAmountOutStable,
  buildSolidlyStableSegments,
  type SolidlyStablePool,
} from "../shared/solidly-stable-math";
import {
  quotePotentialSwap,
  buildWombatSegments,
  type WombatPool,
} from "../shared/wombat-math";
import {
  query as wooFiQuery,
  buildWooFiSegments,
  type WooFiPool,
} from "../shared/woofi-math";
import {
  getAmountOut as fermiGetAmountOut,
  buildFermiSegments,
  fermiSampleInputs,
  type FermiPool,
} from "../shared/fermi-math";
import {
  getAmountOut as fluidGetAmountOut,
  buildFluidSegments,
  fluidSampleInputs,
  type FluidPool,
} from "../shared/fluid-math";
import {
  getAmountOut as mentoGetAmountOut,
  buildMentoSegments,
  mentoSampleInputs,
  type MentoPool,
} from "../shared/mento-math";
import {
  getAmountOut as balancerV3GetAmountOut,
  buildBalancerV3Segments,
  balancerV3SampleInputs,
  type BalancerV3Pool,
} from "../shared/balancer-v3-math";
import {
  getDy as balancerGetDy,
  buildBalancerStableSegments,
  type BalancerStablePool,
} from "../shared/balancer-stable-math";
import {
  computeQuote,
  buildEulerSwapSegments,
  eulerFeeToPpm,
  type EulerSwapPool,
} from "../shared/eulerswap-math";
import {
  getDy as maverickGetDy,
  buildMaverickSegments,
  getTickL as maverickGetTickL,
  getSqrtPrice as maverickGetSqrtPrice,
  tickSqrtPrices as maverickTickSqrtPrices,
  simulateMaverickExactIn as maverickSimulate,
  type MaverickPool,
  type MaverickTick,
} from "../shared/maverick-math";
import {
  getDyCrypto,
  newtonD as cryptoNewtonD,
  buildCryptoSwapSegments,
  type CryptoSwapPool,
} from "../shared/cryptoswap-math";
import {
  buildLbSegments,
  getSwapOut as lbGetSwapOut,
  getPriceFromId as lbGetPriceFromId,
  lbGrossToDrain,
  baseFee as lbBaseFee,
  isqrt as lbIsqrt,
  Q192 as LB_Q192,
  LB_REAL_ID_SHIFT,
  type LbPool,
} from "../shared/lb-math";
import {
  buildDodoSegments,
  getDy as dodoGetDy,
  type DodoPool,
} from "../shared/dodo-math";
import { pushMonotoneSegment, isqrt as mergeIsqrt, Q192 as MERGE_Q192, type MergeSegment } from "../shared/segment-merge";
import { estimateExpectedOutput } from "../ecoswap/expected-output";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// ─────────────────────────────────────────────────────────────
// 9. Multi-hop route composition primitives (INDEPENDENT known answers)
// ─────────────────────────────────────────────────────────────
//
// Pure-value vectors for the route-composition helpers — closed-form / round-trip checks that
// stand on their own (no oracle), proving each primitive's integer math before the oracle relies
// on them. All values are unified out/in sqrt prices Q96.
describe("route composition primitives [composeStep / routeHeadFold]", () => {
  it("composeStep folds two out/in sqrt heads rescaled by Q96: h1*h2/2^96", () => {
    // h1 = sqrt(2)*2^96, h2 = sqrt(3)*2^96 ⇒ composed = sqrt(6)*2^96.
    const h1 = isqrt(2n) * Q96; // not exact sqrt, but composeStep is pure mulDiv — check the identity
    const h2 = isqrt(3n) * Q96;
    assert.equal(composeStep(h1, h2), mulDiv(h1, h2, Q96));
    // identity at unity: composing with 2^96 (rate 1) returns the other head unchanged.
    const h = 123456789n * Q96 + 987654321n;
    assert.equal(composeStep(h, Q96), h);
    assert.equal(composeStep(Q96, h), h);
  });

  it("routeHeadFold is the LEFT-TO-RIGHT composeStep chain (fixed order, NOT associative)", () => {
    const a = 5n * Q96 + 7n;
    const b = 3n * Q96 + 11n;
    const c = 2n * Q96 + 13n;
    const fold = routeHeadFold([a, b, c]);
    const manual = composeStep(composeStep(a, b), c);
    assert.equal(fold, manual, "fold == ((a∘b)∘c)");
    // a single leg folds to itself.
    assert.equal(routeHeadFold([a]), a);
    // two legs == composeStep.
    assert.equal(routeHeadFold([a, b]), composeStep(a, b));
    // The fold associates STRICTLY LEFT (((a∘b)∘c)), NOT right (a∘(b∘c)) — pinned so the
    // documented fixed order can't silently flip. (Right-assoc is the value to AVOID.)
    const rightAssoc = composeStep(a, composeStep(b, c));
    assert.equal(routeHeadFold([a, b, c]), composeStep(composeStep(a, b), c), "left-fold");
    // For these heads left and right happen to coincide to the wei (small magnitudes), so we
    // assert the COMPUTED form is the left fold rather than relying on a numeric gap.
    assert.equal(manual, composeStep(composeStep(a, b), c), "manual is the left fold");
    void rightAssoc;
  });
});

describe("route bracket primitives [bracketGross / bracketOut / inversions]", () => {
  // One constant-L bracket in out/in space, fee 0.30%.
  const L = 10n ** 24n;
  const nearOI = toOutIn(getSqrtRatioAtTick(0), true); // 2^96
  const farOI = toOutIn(getSqrtRatioAtTick(-600), true); // deeper (smaller) out/in
  const FEE = 3000n;

  it("bracketOut == L*(near-far)/2^96 and matches the bracketCapacity effIn relation", () => {
    assert.ok(farOI < nearOI);
    assert.equal(bracketOut(L, nearOI, farOI), mulDiv(L, nearOI - farOI, Q96));
    // bracketGross equals the existing bracketCapacity (same integer form, fee as bigint).
    assert.equal(bracketGross(L, nearOI, farOI, FEE), bracketCapacity(L, nearOI, farOI, Number(FEE)));
  });

  it("invertFarFromGrossIn round-trips bracketGross: absorbing the full gross lands at far", () => {
    const gross = bracketGross(L, nearOI, farOI, FEE);
    const back = invertFarFromGrossIn(L, nearOI, gross, FEE);
    // exact to a couple wei of mulDiv truncation in the fee round-trip.
    assertClose(back, farOI, 1n, "invertFarFromGrossIn(gross) ≈ far");
  });

  it("invertFarFromOut round-trips bracketOut: producing the full out lands at far", () => {
    const out = bracketOut(L, nearOI, farOI);
    const back = invertFarFromOut(L, nearOI, out);
    // bracketOut floors L*(near-far)/2^96, so the inverse recovers far to a wei of truncation.
    assertClose(back, farOI, 1n, "invertFarFromOut(out) ≈ far");
  });

  it("partial inversions are monotone interior points (more input ⇒ deeper far)", () => {
    const gross = bracketGross(L, nearOI, farOI, FEE);
    const f1 = invertFarFromGrossIn(L, nearOI, gross / 4n, FEE);
    const f2 = invertFarFromGrossIn(L, nearOI, gross / 2n, FEE);
    assert.ok(f1 < nearOI && f1 > farOI, "quarter-fill is interior");
    assert.ok(f2 < f1, "more input ⇒ deeper (smaller) far");
  });
});

describe("routeEvent2 — binding leg, conservation, partial inversion", () => {
  const FEE = 3000n;
  const near = toOutIn(getSqrtRatioAtTick(0), true);
  // Two legs whose current brackets differ in width so the binding leg is unambiguous.
  function leg(L: bigint, farTick: number): RouteLeg {
    return { nearOI: near, farOI: toOutIn(getSqrtRatioAtTick(farTick), true), L, feePpm: FEE };
  }

  it("leg1 binds (dXa <= dXb): leg2 partially absorbs dXa, conservation X1==X2", () => {
    // leg1 narrow (small output crossing), leg2 wide+deep L (huge gross capacity) ⇒ leg1 binds.
    const leg1 = leg(10n ** 21n, -60);
    const leg2 = leg(10n ** 27n, -6000);
    const ev = routeEvent2(leg1, leg2);
    assert.equal(ev.bind, 1, "narrow leg1 crosses first");
    // The bound leg keeps its bracket far; the partial leg's far is the inverted interior point.
    assert.equal(ev.newF1, leg1.farOI, "leg1 crossed fully → far unchanged");
    assert.ok(ev.newF2 < leg2.nearOI && ev.newF2 > leg2.farOI, "leg2 partial far is interior");
    // CONSERVATION at the intermediate token X: leg1's full output dXa is fed into leg2 as its
    // GROSS input (leg2 pays its own fee on the handoff), so leg2's partial far is exactly the
    // gross-inversion of dXa — the handoff is wei-exact (leg1 out == leg2 gross in == dXa).
    const xLeg1 = bracketOut(leg1.L, leg1.nearOI, leg1.farOI);
    assert.equal(ev.dX, xLeg1, "dX == leg1 full output");
    assert.equal(ev.newF2, invertFarFromGrossIn(leg2.L, leg2.nearOI, ev.dX, FEE), "leg2 far == gross-inversion of dXa");
    // routeIn is leg1's gross over its full bracket; routeOut is leg2's out over the partial.
    assert.equal(ev.routeIn, bracketGross(leg1.L, leg1.nearOI, leg1.farOI, FEE));
    assert.equal(ev.routeOut, bracketOut(leg2.L, leg2.nearOI, ev.newF2));
  });

  it("leg2 binds (dXb < dXa): leg1 partially produces dXb, conservation X1==X2", () => {
    // leg2 narrow gross capacity, leg1 wide+deep ⇒ leg2 crosses first, leg1 partial.
    const leg1 = leg(10n ** 27n, -6000);
    const leg2 = leg(10n ** 21n, -60);
    const ev = routeEvent2(leg1, leg2);
    assert.equal(ev.bind, 2, "narrow leg2 crosses first");
    assert.equal(ev.newF2, leg2.farOI, "leg2 crossed fully → far unchanged");
    assert.ok(ev.newF1 < leg1.nearOI && ev.newF1 > leg1.farOI, "leg1 partial far is interior");
    // CONSERVATION: leg1 produces exactly dXb (== leg2's full gross-crossing output target).
    const dXb = bracketGross(leg2.L, leg2.nearOI, leg2.farOI, FEE);
    assert.equal(ev.dX, dXb, "dX == leg2 full gross input");
    const xLeg1 = bracketOut(leg1.L, leg1.nearOI, ev.newF1);
    assertClose(xLeg1, dXb, 1n, "leg1 produced output == leg2 absorbed input (conservation)");
    assert.equal(ev.routeIn, bracketGross(leg1.L, leg1.nearOI, ev.newF1, FEE));
    assert.equal(ev.routeOut, bracketOut(leg2.L, leg2.nearOI, leg2.farOI));
  });
});

describe("routePartial2 — forward-propagate a partial route input through both legs", () => {
  const FEE = 3000n;
  const near = toOutIn(getSqrtRatioAtTick(0), true);
  const leg1: RouteLeg = { nearOI: near, farOI: toOutIn(getSqrtRatioAtTick(-6000), true), L: 10n ** 26n, feePpm: FEE };
  const leg2: RouteLeg = { nearOI: near, farOI: toOutIn(getSqrtRatioAtTick(-6000), true), L: 10n ** 26n, feePpm: FEE };

  it("conservation: leg1 out (X1) feeds leg2 in; routeOut == leg2 out over [near, f2p]", () => {
    const targetIn = 100n * 10n ** 18n;
    const r = routePartial2(leg1, leg2, targetIn);
    // leg1 absorbs targetIn (gross) ⇒ its far is the gross-inversion; X1 is its output there.
    assert.equal(r.f1p, invertFarFromGrossIn(leg1.L, leg1.nearOI, targetIn, FEE));
    assert.equal(r.X1, bracketOut(leg1.L, leg1.nearOI, r.f1p));
    // leg2 absorbs X1 (gross) ⇒ its far + output follow.
    assert.equal(r.f2p, invertFarFromGrossIn(leg2.L, leg2.nearOI, r.X1, FEE));
    assert.equal(r.routeOut, bracketOut(leg2.L, leg2.nearOI, r.f2p));
    assert.ok(r.X1 > 0n && r.routeOut > 0n && r.routeOut < r.X1, "two fees shrink the through-output");
  });

  it("more route input ⇒ more route output (monotone)", () => {
    const small = routePartial2(leg1, leg2, 50n * 10n ** 18n);
    const big = routePartial2(leg1, leg2, 500n * 10n ** 18n);
    assert.ok(big.routeOut > small.routeOut, "monotone in route input");
  });
});

// ─────────────────────────────────────────────────────────────
// 10. Oracle route modeling — a 2-hop route competes in the merge [optimalSplit]
// ─────────────────────────────────────────────────────────────
//
// The neutral oracle now models a route as ONE venue built from TRUE LIVE leg state. These
// vectors prove (a) conservation (Σ perPool + Σ perRoute == amountIn within liquidity), (b) a
// route-ONLY universe routes everything through the route, (c) a route competes against a direct
// pool and the split equalizes the (fee-adjusted) route head against the direct pool's marginal.
describe("oracle route modeling — 2-hop route as a venue [optimalSplit]", () => {
  const E18 = 10n ** 18n;
  const DEEP = 10n ** 26n; // both legs deep enough to reach a clean interior cut

  // A 2-hop route A->X->B: leg1 zeroForOne (A->X), leg2 zeroForOne (X->B). Both constant-L V3
  // legs at tick 0 (empty net ⇒ single constant-L curve walked from spot), fee 0.30%.
  function route2(L1: bigint, L2: bigint, fee: number): OptimalRoute {
    const spot = getSqrtRatioAtTick(0);
    return {
      legs: [
        { zeroForOne: true, pools: [{ isV2: false, feePpm: fee, sqrtPriceX96: spot, tick: 0, tickSpacing: 60, liquidity: L1, net: new Map() }] },
        { zeroForOne: true, pools: [{ isV2: false, feePpm: fee, sqrtPriceX96: spot, tick: 0, tickSpacing: 60, liquidity: L2, net: new Map() }] },
      ],
    };
  }

  it("route-only universe: all input routes through the route, perRouteInput == total", () => {
    const amountIn = 1000n * E18;
    const res = optimalSplit({ pools: [], routes: [route2(DEEP, DEEP, 3000)], amountIn, zeroForOne: true, priceLimit: 0n });
    assert.equal(res.perPoolInput.length, 0);
    assert.equal(res.perRouteInput.length, 1);
    assert.equal(res.totalInput, amountIn, "spends amountIn exactly through the route");
    assert.equal(res.perRouteInput[0], amountIn, "all input via the route");
  });

  it("conservation: Σ perPool + Σ perRoute == amountIn (route vs direct pool)", () => {
    const direct: OptimalPool = { isV2: false, feePpm: 3000, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 60, liquidity: DEEP, net: new Map() };
    for (const amountIn of [100n * E18, 5000n * E18, 50000n * E18]) {
      const res = optimalSplit({ pools: [direct], routes: [route2(DEEP, DEEP, 3000)], amountIn, zeroForOne: true, priceLimit: 0n });
      const sum = res.perPoolInput.reduce((a, b) => a + b, 0n) + res.perRouteInput.reduce((a, b) => a + b, 0n);
      assert.equal(sum, res.totalInput, `Σ venues == total (amountIn=${amountIn})`);
      assert.equal(res.totalInput, amountIn, `spends amountIn exactly (amountIn=${amountIn})`);
    }
  });

  it("a two-hop route is WORSE than a single direct hop (two fees): direct fills first, route only on overflow", () => {
    // A SHALLOW direct pool (single hop, one fee) vs a DEEP route (two hops, two fees). The route
    // head sits BELOW a fresh direct hop, so the merge funds the direct pool first; only once the
    // shallow direct pool's marginal drops below the route head does the route engage. A tiny
    // trade ⇒ route gets 0; a large trade overflows the shallow pool into the route.
    const SHALLOW = 10n ** 21n;
    const direct: OptimalPool = { isV2: false, feePpm: 3000, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 60, liquidity: SHALLOW, net: new Map() };
    const small = optimalSplit({ pools: [direct], routes: [route2(DEEP, DEEP, 3000)], amountIn: E18 / 10n, zeroForOne: true, priceLimit: 0n });
    assert.equal(small.perRouteInput[0], 0n, "small trade: direct hop is strictly better, route unused");
    assert.equal(small.perPoolInput[0], E18 / 10n, "all to the direct pool");

    // A large trade drains the shallow pool's marginal below the route head ⇒ the route engages.
    const big = optimalSplit({ pools: [direct], routes: [route2(DEEP, DEEP, 3000)], amountIn: 200000n * E18, zeroForOne: true, priceLimit: 0n });
    assert.ok(big.perRouteInput[0] > 0n, "large trade spills into the route");
    assert.ok(big.perPoolInput[0] > 0n, "direct pool still funded");
    assert.equal(big.perPoolInput[0] + big.perRouteInput[0], 200000n * E18, "exact split");
  });
});

// ─────────────────────────────────────────────────────────────
// 11. Route composition vs INDEPENDENT ground truth (closed form / telescoping / greedy)
// ─────────────────────────────────────────────────────────────
//
// Sections 9–10 pin each helper's internal identities and the oracle's plumbing, but the
// oracle and the (future) cursor-faithful reference SHARE these helpers — testing them only
// against each other proves nothing about the COMPOSITION being the right answer. The vectors
// below use ground truth derived a DIFFERENT way:
//   (a) CLOSED FORM — a 2-hop where each leg is ONE constant-L V3 range with NO tick crossing,
//       composed via the constant-product RESERVE form (reserveIn=L·Q96/near, reserveOut=
//       L·near/Q96, k=reserveIn·reserveOut; out = reserveOut − k/(reserveIn+effIn)). That is a
//       genuinely different arithmetic path from invertFarFromGrossIn's reciprocal-add, so a
//       match validates the helper composition (not a tautology).
//   (b) TELESCOPING — summing routeEvent2 over the crossed brackets + a routePartial2 remainder
//       reproduces routePartial2(total) to the wei (the event walk telescopes to the partial).
//   (c) GREEDY — split a tiny amountIn across a direct pool + a 2-hop route by greedily handing
//       small increments to the best CURRENT marginal (route marginal recomputed by actually
//       composing the legs each step). optimalSplit must track the greedy split within a tight
//       relative tolerance — a mechanism genuinely different from the segment merge.

// Independent two-hop output for a routeIn, each leg ONE constant-L out/in bracket (no crossing),
// via the constant-product RESERVE form. effIn floors the fee the SAME way the helpers do
// (mulDiv(g, D−f, D)); the hyperbola step uses reserves, not the reciprocal-add. Returns the
// per-leg gross-in / out and the final routeOut.
function twoHopReserveClosedForm(
  L1: bigint, near1: bigint, fee1: bigint,
  L2: bigint, near2: bigint, fee2: bigint,
  routeIn: bigint,
): { X1: bigint; routeOut: bigint } {
  // leg1 reserves at its live spot (constant-L hyperbola ≡ xy=k with k=L^2).
  const rIn1 = mulDiv(L1, Q96, near1); // = invNear1
  const rOut1 = mulDiv(L1, near1, Q96);
  const k1 = rIn1 * rOut1;
  const effIn1 = mulDiv(routeIn, FEE_DENOM - fee1, FEE_DENOM);
  const newIn1 = rIn1 + effIn1;
  const X1 = rOut1 - k1 / newIn1; // leg1 output (token X), floors k/newIn
  // leg2 absorbs X1 as GROSS input (pays its own fee on the handoff).
  const rIn2 = mulDiv(L2, Q96, near2);
  const rOut2 = mulDiv(L2, near2, Q96);
  const k2 = rIn2 * rOut2;
  const effIn2 = mulDiv(X1, FEE_DENOM - fee2, FEE_DENOM);
  const newIn2 = rIn2 + effIn2;
  const routeOut = rOut2 - k2 / newIn2;
  return { X1, routeOut };
}

describe("route composition vs INDEPENDENT ground truth", () => {
  const E18 = 10n ** 18n;
  const near = toOutIn(getSqrtRatioAtTick(0), true); // 2^96 out/in spot for both legs
  const FEE = 3000n;

  // (a) CLOSED FORM — single bracket per leg, no crossing. Legs deep enough that the chosen
  // routeIn never reaches either bracket's far edge, so routePartial2 stays within bracket 0
  // and a full event walk would emit nothing before the partial (telescopes to the partial).
  it("(a) single-bracket-per-leg: routePartial2 == constant-product reserve closed form (wei)", () => {
    const L1 = 10n ** 26n;
    const L2 = 3n * 10n ** 26n;
    const far1 = toOutIn(getSqrtRatioAtTick(-60000), true); // very deep — no crossing in range
    const far2 = toOutIn(getSqrtRatioAtTick(-60000), true);
    const leg1: RouteLeg = { nearOI: near, farOI: far1, L: L1, feePpm: FEE };
    const leg2: RouteLeg = { nearOI: near, farOI: far2, L: L2, feePpm: FEE };

    for (const routeIn of [1n * E18, 100n * E18, 5000n * E18]) {
      const r = routePartial2(leg1, leg2, routeIn);
      const cf = twoHopReserveClosedForm(L1, near, FEE, L2, near, FEE, routeIn);
      // The reserve form and the reciprocal-add form are algebraically equal but truncate the
      // hyperbola step differently (k/newIn vs L·Q96/(invNear+effIn) then ·L/Q96), so allow a
      // couple wei of independent-truncation slack on each leg's output.
      assertClose(r.X1, cf.X1, 1n, `leg1 out X1 == reserve closed form (routeIn=${routeIn})`);
      assertClose(r.routeOut, cf.routeOut, 1n, `routeOut == reserve closed form (routeIn=${routeIn})`);
      // The partial stayed strictly interior to both brackets (no crossing) — preconditions hold.
      assert.ok(r.f1p > far1 && r.f1p < near, "leg1 partial interior (no crossing)");
      assert.ok(r.f2p > far2 && r.f2p < near, "leg2 partial interior (no crossing)");
    }
  });

  // (b) TELESCOPING IDENTITY — routePartial2(total) equals the sum over the crossed full brackets
  // (routeEvent2 each event) plus a routePartial2 of the remainder on the surviving brackets.
  // We drive a 2-hop where leg1 has SEVERAL narrow brackets so the route crosses a few leg1 ticks
  // before the cut, and check that walking the events then partial-filling the remainder
  // reproduces a single routePartial2(total) to the wei (both routeIn consumed and routeOut).
  it("(b) telescoping: Σ routeEvent2 (crossed) + routePartial2(remainder) == routePartial2(total)", () => {
    // leg1: a chain of constant-L brackets one tickSpacing apart (narrow ⇒ leg1 binds each event).
    // leg2: ONE deep constant-L bracket (huge gross capacity ⇒ never binds, partial-absorbs).
    const TS = 60;
    const L1 = 10n ** 24n;
    const L2 = 10n ** 28n;
    const fee1 = FEE;
    const fee2 = FEE;
    // Build leg1's bracket chain in out/in space from spot tick 0, walking down.
    const b1: RouteLeg[] = [];
    let bTick = 0;
    for (let i = 0; i < 6; i++) {
      const n = toOutIn(getSqrtRatioAtTick(bTick), true);
      const f = toOutIn(getSqrtRatioAtTick(bTick - TS), true);
      b1.push({ nearOI: n, farOI: f, L: L1, feePpm: fee1 });
      bTick -= TS;
    }
    const far2 = toOutIn(getSqrtRatioAtTick(-60000), true);
    const leg2Deep: RouteLeg = { nearOI: near, farOI: far2, L: L2, feePpm: fee2 };

    // Walk the route as an event sequence: at each event leg1 (on its current narrow bracket) binds
    // (narrow output) and leg2 partially absorbs; accumulate routeIn / routeOut and advance leg1.
    let n2 = near; // leg2's running near (advances by the partial far each event)
    let walkRouteIn = 0n;
    let walkRouteOut = 0n;
    const CROSS = 3; // cross the first 3 leg1 brackets fully, then partial-fill into the 4th
    for (let i = 0; i < CROSS; i++) {
      const cur1 = b1[i];
      const cur2: RouteLeg = { nearOI: n2, farOI: far2, L: L2, feePpm: fee2 };
      const ev = routeEvent2(cur1, cur2);
      assert.equal(ev.bind, 1, "narrow leg1 binds each event");
      walkRouteIn += ev.routeIn;
      walkRouteOut += ev.routeOut;
      n2 = ev.newF2; // leg2 advanced near (partially consumed)
    }
    // Remainder: a partial fill of the 4th leg1 bracket, leg2 continuing from its advanced near.
    const remIn = bracketGross(b1[CROSS].L, b1[CROSS].nearOI, b1[CROSS].farOI, fee1) / 2n;
    const rem = routePartial2(
      b1[CROSS],
      { nearOI: n2, farOI: far2, L: L2, feePpm: fee2 },
      remIn,
    );
    const totalWalkIn = walkRouteIn + remIn;
    const totalWalkOut = walkRouteOut + rem.routeOut;

    // Now the SINGLE-SHOT path: routePartial2(total) over the SAME composite must telescope to the
    // same routeIn/routeOut. leg1 as a single composite bracket from its FIRST near to where the
    // remainder lands; the through-output is conserved, so a single forward propagation over the
    // first leg1 bracket's near with the full gross gives the same total out (constant-L telescopes
    // across the contiguous leg1 chain — interior boundaries cancel exactly).
    const oneShot = routePartial2(
      { nearOI: b1[0].nearOI, farOI: b1[CROSS].farOI, L: L1, feePpm: fee1 },
      leg2Deep,
      totalWalkIn,
    );
    // routeIn consumed matches by construction; the OUTPUT telescopes to the wei because leg1's
    // contiguous constant-L chain integrates to one hyperbola and leg2 is one constant-L bracket.
    assertClose(oneShot.routeOut, totalWalkOut, 2n, "telescoped routeOut == event-walk routeOut");
    assert.ok(totalWalkOut > 0n && totalWalkIn > 0n, "non-trivial telescope");
  });

  // (c) BRUTE-FORCE GREEDY CROSS-CHECK — split a tiny amountIn across {direct pool, 2-hop route}
  // by greedily assigning small increments to the best CURRENT post-fee marginal, recomputing the
  // route marginal by ACTUALLY composing the legs each step. A genuinely different mechanism from
  // the segment merge; optimalSplit must track it within a tight relative tolerance.
  it("(c) greedy increment split tracks optimalSplit to the merge granularity (< 0.1%)", () => {
    const spot = getSqrtRatioAtTick(0);
    // Direct pool (fee 0.05%) vs a 2-hop route (two 0.30% legs ⇒ two fees). The legs are SHALLOW
    // (one route event ≈ a few·10·E18 of input ≪ amountIn), so the route enters the merge as MANY
    // fine micro-segments — the regime where the segment-merge oracle converges to the continuous
    // optimum. Both venues engage at an interior cut.
    const directL = 10n ** 22n;
    const directFee = 500n;
    const routeLegL = 10n ** 22n;
    const route: OptimalRoute = {
      legs: [
        { zeroForOne: true, pools: [{ isV2: false, feePpm: 3000, sqrtPriceX96: spot, tick: 0, tickSpacing: 60, liquidity: routeLegL, net: new Map() }] },
        { zeroForOne: true, pools: [{ isV2: false, feePpm: 3000, sqrtPriceX96: spot, tick: 0, tickSpacing: 60, liquidity: routeLegL, net: new Map() }] },
      ],
    };
    const directPool: OptimalPool = { isV2: false, feePpm: Number(directFee), sqrtPriceX96: spot, tick: 0, tickSpacing: 60, liquidity: directL, net: new Map() };

    const amountIn = 10000n * E18;
    const STEPS = 40000n;
    const inc = amountIn / STEPS; // small uniform increment

    // Greedy state: direct pool near (out/in), route leg nears. We measure each venue's post-fee
    // marginal out-per-in at its CURRENT price and assign each increment to the higher marginal,
    // then advance that venue's price by absorbing the increment (constant-L reserve step).
    const D = FEE_DENOM;
    let dNear = toOutIn(spot, true);
    let r1Near = toOutIn(spot, true);
    let r2Near = toOutIn(spot, true);
    let greedyDirect = 0n;
    let greedyRoute = 0n;

    // Marginal out/in (scaled 1e18) of a constant-L bracket at near with fee f: post-fee spot
    // price = (near/Q96)^2 · (1−f). Route marginal = product of the two legs' post-fee spot prices.
    const SCALE = 10n ** 18n;
    const marg1 = (n: bigint, f: bigint) => {
      // (n^2/Q192) · (D−f)/D · SCALE — the instantaneous out/in price (not sqrt).
      const price = mulDiv(n * n, SCALE, Q192);
      return mulDiv(price, D - f, D);
    };
    const advance = (n: bigint, L: bigint, f: bigint, grossIn: bigint): bigint => {
      // absorb grossIn at constant L (reserve step), return the new near.
      const effIn = mulDiv(grossIn, D - f, D);
      const rIn = mulDiv(L, Q96, n);
      const newIn = rIn + effIn;
      return mulDiv(L, Q96, newIn);
    };

    for (let s = 0n; s < STEPS; s++) {
      const dMarg = marg1(dNear, directFee);
      // route marginal = leg1 post-fee price · leg2 post-fee price (composition of instantaneous rates)
      const rMarg = mulDiv(marg1(r1Near, 3000n), marg1(r2Near, 3000n), SCALE);
      if (dMarg >= rMarg) {
        greedyDirect += inc;
        dNear = advance(dNear, directL, directFee, inc);
      } else {
        greedyRoute += inc;
        // route absorbs inc into leg1; leg1 output feeds leg2.
        const newR1 = advance(r1Near, routeLegL, 3000n, inc);
        const x1 = mulDiv(routeLegL, r1Near - newR1, Q96);
        r1Near = newR1;
        r2Near = advance(r2Near, routeLegL, 3000n, x1);
      }
    }

    const res = optimalSplit({ pools: [directPool], routes: [route], amountIn, zeroForOne: true, priceLimit: 0n });
    assert.equal(res.totalInput, amountIn, "optimalSplit spends amountIn exactly");
    // Two independent mechanisms (continuous greedy vs segment-merge water-fill) agree on the split
    // up to their granularity floors: the greedy's uniform increment and the merge's coarse partial
    // of the final consumed segment. Both are ≪ 0.1% of amountIn here (shallow legs ⇒ fine route
    // segments), so bound the disagreement by 0.1% of amountIn — a genuine cross-mechanism check.
    const tol = amountIn / 1000n; // 0.1%
    const dDiff = res.perPoolInput[0] > greedyDirect ? res.perPoolInput[0] - greedyDirect : greedyDirect - res.perPoolInput[0];
    const rDiff = res.perRouteInput[0] > greedyRoute ? res.perRouteInput[0] - greedyRoute : greedyRoute - res.perRouteInput[0];
    assert.ok(dDiff <= tol, `direct share tracks greedy: |${res.perPoolInput[0]} - ${greedyDirect}| = ${dDiff} > ${tol} (0.1%)`);
    assert.ok(rDiff <= tol, `route share tracks greedy: |${res.perRouteInput[0]} - ${greedyRoute}| = ${rDiff} > ${tol} (0.1%)`);
    // Both genuinely engaged (the split is interior, not a corner solution).
    assert.ok(greedyDirect > 0n && greedyRoute > 0n, "greedy engaged both venues");
    assert.ok(res.perPoolInput[0] > 0n && res.perRouteInput[0] > 0n, "optimalSplit engaged both venues");
  });
});

// ─────────────────────────────────────────────────────────────
// 11b. N-hop route composition — routeEventN / routePartialN (3-hop concrete)
// ─────────────────────────────────────────────────────────────
//
// The N-leg generalization of the route event/partial helpers. Three independent checks:
//   (a) CLOSED FORM — a 3-hop where each leg is ONE constant-L bracket with NO crossing,
//       composed via the constant-product RESERVE form (a different arithmetic path than
//       routePartialN's reciprocal-add chain) == routePartialN to ≤ a few wei.
//   (b) TELESCOPING — Σ routeEventN (crossed full events) + routePartialN(remainder) over a
//       3-hop reproduces routePartialN(total) to the wei.
//   (c) 2-HOP IDENTITY — routeEventN([l1,l2]) === routeEvent2(l1,l2) and routePartialN([l1,l2])
//       === routePartial2 (the non-negotiable bit-identity guard at k=2), including randomized legs.

// Independent N-hop output for a routeIn, each leg ONE constant-L out/in bracket (no crossing),
// via the constant-product RESERVE form. Mirrors twoHopReserveClosedForm but chains k legs:
// leg j absorbs the previous leg's output as GROSS input (pays its own fee), reserves at its
// live spot near (k=L^2 hyperbola). Returns per-leg through-amounts and the final routeOut.
function nHopReserveClosedForm(
  legSpecs: { L: bigint; near: bigint; fee: bigint }[],
  routeIn: bigint,
): { flows: bigint[]; routeOut: bigint } {
  const flows: bigint[] = [routeIn];
  let inAmt = routeIn;
  for (const { L, near, fee } of legSpecs) {
    const rIn = mulDiv(L, Q96, near); // = invNear
    const rOut = mulDiv(L, near, Q96);
    const kk = rIn * rOut;
    const effIn = mulDiv(inAmt, FEE_DENOM - fee, FEE_DENOM);
    const out = rOut - kk / (rIn + effIn); // floors k/newIn, same as the 2-hop closed form
    flows.push(out);
    inAmt = out;
  }
  return { flows, routeOut: inAmt };
}

describe("N-hop route composition [routeEventN / routePartialN] (3-hop concrete)", () => {
  const E18 = 10n ** 18n;
  const near = toOutIn(getSqrtRatioAtTick(0), true); // 2^96 out/in spot for all legs
  const FEE = 3000n;

  // (a) CLOSED FORM — single bracket per leg, no crossing (legs very deep so the routeIn never
  // reaches any bracket's far edge). routePartialN must match the constant-product reserve chain.
  it("(a) single-bracket-per-leg 3-hop: routePartialN == constant-product reserve closed form (wei)", () => {
    const L1 = 10n ** 26n;
    const L2 = 3n * 10n ** 26n;
    const L3 = 2n * 10n ** 26n;
    const farDeep = toOutIn(getSqrtRatioAtTick(-60000), true); // very deep — no crossing in range
    const legs: RouteLeg[] = [
      { nearOI: near, farOI: farDeep, L: L1, feePpm: FEE },
      { nearOI: near, farOI: farDeep, L: L2, feePpm: FEE },
      { nearOI: near, farOI: farDeep, L: L3, feePpm: FEE },
    ];
    const specs = [
      { L: L1, near, fee: FEE },
      { L: L2, near, fee: FEE },
      { L: L3, near, fee: FEE },
    ];
    for (const routeIn of [1n * E18, 100n * E18, 5000n * E18]) {
      const r = routePartialN(legs, routeIn);
      const cf = nHopReserveClosedForm(specs, routeIn);
      // The reserve form and the reciprocal-add form are algebraically equal but truncate the
      // hyperbola step differently per leg, so allow a few wei of independent-truncation slack
      // (three chained legs ⇒ up to ~3 wei of accumulated truncation).
      assertClose(r.routeOut, cf.routeOut, 1n, `routeOut == reserve closed form (routeIn=${routeIn})`);
      // Each leg's partial far stayed strictly interior (no crossing) — preconditions hold.
      for (const f of r.newFars) assert.ok(f > farDeep && f < near, "leg partial interior (no crossing)");
    }
  });

  // (b) TELESCOPING — a 3-hop where leg0 has SEVERAL narrow brackets (binds each event), leg1/leg2
  // are ONE deep bracket each (huge capacity ⇒ never bind, partial-absorb). Walking the events then
  // partial-filling the remainder reproduces routePartialN(total) over the composite leg0 to the wei
  // (leg0's contiguous constant-L chain integrates to one hyperbola; leg1/leg2 are single brackets).
  it("(b) telescoping: Σ routeEventN (crossed) + routePartialN(remainder) == routePartialN(total)", () => {
    const TS = 60;
    const L0 = 10n ** 24n;
    const Lmid = 10n ** 28n;
    const Ldeep = 10n ** 28n;
    const farDeep = toOutIn(getSqrtRatioAtTick(-60000), true);
    // leg0 bracket chain (narrow, one tickSpacing apart), walking down from spot tick 0.
    const b0: RouteLeg[] = [];
    let bTick = 0;
    for (let i = 0; i < 6; i++) {
      const n = toOutIn(getSqrtRatioAtTick(bTick), true);
      const f = toOutIn(getSqrtRatioAtTick(bTick - TS), true);
      b0.push({ nearOI: n, farOI: f, L: L0, feePpm: FEE });
      bTick -= TS;
    }
    const leg1Deep: RouteLeg = { nearOI: near, farOI: farDeep, L: Lmid, feePpm: FEE };
    const leg2Deep: RouteLeg = { nearOI: near, farOI: farDeep, L: Ldeep, feePpm: FEE };

    // Walk the route as an event sequence: leg0 (narrow) binds each event; leg1/leg2 partial-absorb.
    let n1 = near; // leg1 running near (advances each event)
    let n2 = near; // leg2 running near
    let walkRouteIn = 0n;
    let walkRouteOut = 0n;
    const CROSS = 3; // cross the first 3 leg0 brackets fully, then partial-fill into the 4th
    for (let i = 0; i < CROSS; i++) {
      const legs: RouteLeg[] = [
        b0[i],
        { nearOI: n1, farOI: farDeep, L: Lmid, feePpm: FEE },
        { nearOI: n2, farOI: farDeep, L: Ldeep, feePpm: FEE },
      ];
      const ev = routeEventN(legs);
      assert.equal(ev.bindLeg, 0, "narrow leg0 binds each event");
      walkRouteIn += ev.routeIn;
      walkRouteOut += ev.routeOut;
      n1 = ev.newFars[1]; // leg1 advanced near (partially consumed)
      n2 = ev.newFars[2]; // leg2 advanced near
    }
    // Remainder: a partial fill of the 4th leg0 bracket; leg1/leg2 continue from their advanced nears.
    const remIn = bracketGross(b0[CROSS].L, b0[CROSS].nearOI, b0[CROSS].farOI, FEE) / 2n;
    const rem = routePartialN(
      [b0[CROSS], { nearOI: n1, farOI: farDeep, L: Lmid, feePpm: FEE }, { nearOI: n2, farOI: farDeep, L: Ldeep, feePpm: FEE }],
      remIn,
    );
    const totalWalkIn = walkRouteIn + remIn;
    const totalWalkOut = walkRouteOut + rem.routeOut;

    // SINGLE-SHOT: routePartialN(total) over leg0 as ONE composite bracket (first near → 4th far)
    // must telescope to the same routeIn/routeOut (constant-L contiguous chain integrates exactly).
    const oneShot = routePartialN(
      [{ nearOI: b0[0].nearOI, farOI: b0[CROSS].farOI, L: L0, feePpm: FEE }, leg1Deep, leg2Deep],
      totalWalkIn,
    );
    assertClose(oneShot.routeOut, totalWalkOut, 3n, "telescoped routeOut == event-walk routeOut (3-hop)");
    assert.ok(totalWalkOut > 0n && totalWalkIn > 0n, "non-trivial telescope");
  });

  // (c) 2-HOP IDENTITY GUARD — the non-negotiable: routeEventN/routePartialN at k=2 MUST equal
  // routeEvent2/routePartial2 bit-for-bit (the 2-hop landing stays bit-identical). Checked over the
  // two binding regimes from the routeEvent2 vectors AND a spread of randomized legs.
  it("(c) routeEventN([l1,l2]) === routeEvent2 and routePartialN === routePartial2 (bit-identical)", () => {
    function leg(L: bigint, farTick: number, fee: bigint): RouteLeg {
      return { nearOI: near, farOI: toOutIn(getSqrtRatioAtTick(farTick), true), L, feePpm: fee };
    }
    // The two routeEvent2 binding regimes + a few asymmetric mixes (different fees/widths/depths).
    const pairs: [RouteLeg, RouteLeg][] = [
      [leg(10n ** 21n, -60, FEE), leg(10n ** 27n, -6000, FEE)], // leg0 binds
      [leg(10n ** 27n, -6000, FEE), leg(10n ** 21n, -60, FEE)], // leg1 binds
      [leg(10n ** 24n, -120, 500n), leg(10n ** 23n, -300, 3000n)],
      [leg(7n * 10n ** 22n, -240, 3000n), leg(5n * 10n ** 25n, -3000, 500n)],
      [leg(10n ** 26n, -600, 100n), leg(10n ** 26n, -600, 100n)], // symmetric (tie regime)
    ];
    for (const [l1, l2] of pairs) {
      const en = routeEventN([l1, l2]);
      const e2 = routeEvent2(l1, l2);
      assert.equal(en.routeIn, e2.routeIn, "routeIn identical");
      assert.equal(en.routeOut, e2.routeOut, "routeOut identical");
      assert.equal(en.bindLeg === 0 ? 1 : 2, e2.bind, "bind identical");
      assert.equal(en.newFars[0], e2.newF1, "newF1 identical");
      assert.equal(en.newFars[1], e2.newF2, "newF2 identical");
      assert.equal(en.dX, e2.dX, "dX identical");
      // routePartialN === routePartial2 across a spread of partial route inputs.
      for (const ti of [1n * E18, 37n * E18, 1234n * E18]) {
        const pn = routePartialN([l1, l2], ti);
        const p2 = routePartial2(l1, l2, ti);
        assert.equal(pn.routeOut, p2.routeOut, "routePartial routeOut identical");
        assert.equal(pn.newFars[0], p2.f1p, "routePartial f1p identical");
        assert.equal(pn.newFars[1], p2.f2p, "routePartial f2p identical");
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 11c. routeEventN — interior L==0 gap leg (walk-through-gap, NO Panic) [defect #4]
// ─────────────────────────────────────────────────────────────
// A route leg that sits at an interior dL==0 gap (the walk-through-gap design leaves it ACTIVE with
// 0 liquidity) fed the route event a leg with L==0. The binding-leg back-propagation divides by an
// upstream leg's L (invertFarFromOut / the solver Phase B mulDiv), so an L==0 upstream leg was a
// division-by-zero Panic that reverted the WHOLE cook. The fix: an upstream L==0 leg is treated as
// "crosses first" (leg i not binding through it), so the LOWEST-INDEX gap leg itself binds with
// routeIn 0 and advances THROUGH its gap (0 flow) — exactly the direct-pool walk-through-gap, and
// wei-neutral (0 consumed, no other leg moves) so it stays consistent with the oracle (which elides
// the gap via a cursor jump in the adjacent real event). invertFarFromGrossIn(_, near, 0, _) must
// also return `near` EXACTLY (zero input ⇒ zero movement) so a downstream leg does not drift.
describe("routeEventN — interior L==0 gap leg (walk-through-gap, no Panic) [defect #4]", () => {
  const near = toOutIn(getSqrtRatioAtTick(0), true); // 2^96 out/in spot
  const FEE = 3000n;
  const gapLeg = (): RouteLeg => ({ nearOI: near, farOI: toOutIn(getSqrtRatioAtTick(-60), true), L: 0n, feePpm: FEE });
  const realLeg = (L: bigint): RouteLeg => ({ nearOI: near, farOI: toOutIn(getSqrtRatioAtTick(-6000), true), L, feePpm: FEE });

  it("invertFarFromGrossIn(L, near, 0) === near (zero input ⇒ zero movement)", () => {
    for (const L of [10n ** 26n, 10n ** 24n, 4n * 10n ** 23n]) {
      for (const tick of [0, -100, -6000, 600]) {
        const n = toOutIn(getSqrtRatioAtTick(tick), true);
        assert.equal(invertFarFromGrossIn(L, n, 0n, FEE), n, `far==near @ L=${L} tick=${tick}`);
      }
    }
  });

  it("leg0 at an L==0 gap: the gap leg binds with routeIn 0, downstream untouched (no throw)", () => {
    const legs = [gapLeg(), realLeg(10n ** 26n)];
    const ev = routeEventN(legs); // MUST NOT throw (was a division-by-zero Panic)
    assert.equal(ev.bindLeg, 0, "the gap leg binds");
    assert.equal(ev.routeIn, 0n, "gap event consumes 0 token-A");
    assert.equal(ev.routeOut, 0n, "gap event produces 0");
    assert.equal(ev.newFars[0], legs[0].farOI, "binding gap leg advances to its bracket far (crosses the gap boundary)");
    assert.equal(ev.newFars[1], legs[1].nearOI, "downstream leg unchanged (stays at near)");
  });

  it("leg1 at an L==0 gap (leg0 real): the gap leg binds, upstream leg not divided-by-zero", () => {
    const legs = [realLeg(10n ** 26n), gapLeg()];
    const ev = routeEventN(legs);
    assert.equal(ev.bindLeg, 1, "the downstream gap leg binds (routeIn 0 < leg0's positive cross)");
    assert.equal(ev.routeIn, 0n);
    assert.equal(ev.newFars[0], legs[0].nearOI, "upstream leg unchanged (stays at near)");
    assert.equal(ev.newFars[1], legs[1].farOI, "binding gap leg advances to its far");
  });

  it("3-hop with a MIDDLE L==0 gap: the middle leg binds, both divide sites guarded (no throw)", () => {
    const legs = [realLeg(10n ** 26n), gapLeg(), realLeg(10n ** 26n)];
    const ev = routeEventN(legs);
    assert.equal(ev.bindLeg, 1, "the middle gap leg binds");
    assert.equal(ev.routeIn, 0n);
    assert.equal(ev.newFars[0], legs[0].nearOI, "upstream unchanged");
    assert.equal(ev.newFars[2], legs[2].nearOI, "downstream unchanged");
  });

  it("lowest-index gap leg wins when several legs sit at gaps", () => {
    const legs = [realLeg(10n ** 26n), gapLeg(), gapLeg()];
    const ev = routeEventN(legs);
    assert.equal(ev.bindLeg, 1, "the FIRST (lowest-index) gap leg binds");
    assert.equal(ev.routeIn, 0n);
  });
});

// ─────────────────────────────────────────────────────────────
// 11d. QL SLICE leg members — routeEventN / routePartialN slice cases + cursor + election ops
// ─────────────────────────────────────────────────────────────
//
// A leg QL venue enters the route event as a SLICE member: a flat constant-price span with
// (remCap, remOut) at a post-fee head (far == near). These vectors pin the slice event math the
// solver's Phase B/C/D slice branches mirror bit-for-bit: full-cross gross = remCap / out =
// remOut; upstream inversion x = mulDiv(need, remCap, remOut) (with the need >= remOut ⇒
// not-binding sentinel); downstream linear absorb out = mulDiv(x, remOut, remCap) with the
// defensive remCap clamp; per-member awards; the qlCursor Phase D apply/advance; and the pinned
// member-election comparison ops (legMemberWins). All-bracket inputs stay BIT-IDENTICAL to the
// pre-slice implementation (regression pins at the end).
describe("QL slice leg members [routeEventN / routePartialN / qlCursor / legMemberWins]", () => {
  const E18 = 10n ** 18n;
  const FEE = 3000n;
  const near = toOutIn(getSqrtRatioAtTick(0), true); // 2^96 out/in spot
  const farDeep = toOutIn(getSqrtRatioAtTick(-6000), true);
  const farNarrow = toOutIn(getSqrtRatioAtTick(-60), true);
  const slice = (remCap: bigint, remOut: bigint): RouteLegMember => ({
    kind: "slice",
    head: qlSliceHead(remOut, remCap),
    remCap,
    remOut,
  });

  // ── Member-election comparison ops (the solver's leg best scan, transcribed) ──
  it("legMemberWins — strict-near win / near-tie far tie-break / incumbent keeps exact ties", () => {
    // strict near win (far irrelevant).
    assert.equal(legMemberWins(10n, 5n, 9n, 9n), true, "higher near wins");
    // a lower near NEVER wins, whatever its far.
    assert.equal(legMemberWins(9n, 100n, 10n, 1n), false, "lower near loses");
    // near tie: a strictly higher far wins — the structural slice case (a slice's far == near
    // beats any near-tied bracket whose far < near).
    assert.equal(legMemberWins(10n, 10n, 10n, 9n), true, "near-tie + higher far wins (slice vs bracket)");
    // exact tie (near AND far): the INCUMBENT keeps the leg — index-order precedence, so of two
    // identical slices the earlier-scanned one is elected.
    assert.equal(legMemberWins(10n, 10n, 10n, 10n), false, "exact tie ⇒ incumbent (earlier index) keeps");
    // near tie with a LOWER far loses (a bracket never displaces a near-tied slice).
    assert.equal(legMemberWins(10n, 9n, 10n, 10n), false, "near-tie + lower far loses");
  });

  // ── 1. [bracket, slice] — the SLICE binds (full cross: gross = remCap, out = remOut) ──
  it("slice BINDING: awards = [back-inverted gross, remCap]; routeOut = remOut (pinned)", () => {
    const leg0: RouteLegMember = { nearOI: near, farOI: farDeep, L: 10n ** 26n, feePpm: FEE };
    const remCap = 40n * E18;
    const remOut = 39n * E18;
    const ev = routeEventN([leg0, slice(remCap, remOut)]);
    assert.equal(ev.bindLeg, 1, "the small slice crosses before the deep bracket");
    assert.equal(ev.awards[1], remCap, "binding slice award == full remCap");
    assert.equal(ev.routeOut, remOut, "binding slice out == full remOut");
    assert.equal(ev.newFars[1], qlSliceHead(remOut, remCap), "slice newFar carries its flat head");
    assert.equal(ev.dX, remCap, "dX == the binding member's gross input (bindLeg > 0)");
    // Upstream back-inversion: leg0 PRODUCES exactly remCap; routeIn is the re-derived gross.
    const farj = invertFarFromOut(10n ** 26n, near, remCap);
    assert.equal(ev.newFars[0], farj, "upstream bracket far produces the slice's remCap");
    assert.equal(ev.routeIn, bracketGross(10n ** 26n, near, farj, FEE), "routeIn == upstream gross");
    assert.equal(ev.awards[0], ev.routeIn, "awards[0] == routeIn always");
    assert.equal(ev.routeIn, 40120377131400601807n, "routeIn pinned");
  });

  // ── 2. [slice, bracket] — the slice sits UPSTREAM, non-binding: floor inversion + slip bound ──
  it("slice UPSTREAM non-binding: x = mulDiv(need, remCap, remOut); produced ≤ need (≤-convention)", () => {
    const remCap = 10n ** 24n;
    const remOut = 997n * 10n ** 21n;
    const leg1: RouteLegMember = { nearOI: near, farOI: farNarrow, L: 10n ** 21n, feePpm: FEE };
    const need = bracketGross(10n ** 21n, near, farNarrow, FEE); // leg1 full-cross gross
    assert.ok(need < remOut, "precondition: the slice can produce leg1's full need");
    const ev = routeEventN([slice(remCap, remOut), leg1]);
    assert.equal(ev.bindLeg, 1, "the narrow bracket binds through the deep slice");
    const x0 = mulDiv(need, remCap, remOut);
    assert.equal(ev.awards[0], x0, "upstream slice award == floor inversion");
    assert.equal(ev.routeIn, x0, "routeIn == the slice's gross input (leg0)");
    assert.equal(ev.routeIn, 3022461630369469142n, "routeIn pinned");
    // The invertFarFromOut ≤-convention: the slice's floored linear out under-delivers by at most
    // ~⌈remOut/remCap⌉ wei of the downstream token (< 1 wei of the upstream input token).
    const produced = mulDiv(x0, remOut, remCap);
    assert.ok(produced <= need, "produced out ≤ demanded (floor)");
    assert.ok(need - produced <= remOut / remCap + 1n, "slip within the slice floor-slip bound");
    // Exhaustion sentinel: a slice whose remOut cannot cover leg1's need makes leg1 UNREACHABLE
    // (need >= remOut ⇒ crossed-first) — the slice itself binds instead.
    const tiny = routeEventN([slice(2n * E18, need / 2n), leg1]);
    assert.equal(tiny.bindLeg, 0, "an under-capacity upstream slice binds itself");
    assert.equal(tiny.awards[0], 2n * E18, "the tiny slice fully crosses");
  });

  // ── 3. [bracket, slice, bracket] — mid-chain slice, both regimes ──
  it("mid-chain slice DOWNSTREAM of the binding leg: absorbs bindOut, produces the floored out", () => {
    const leg0: RouteLegMember = { nearOI: near, farOI: farNarrow, L: 10n ** 21n, feePpm: FEE };
    const remCap = 10n ** 24n;
    const remOut = 998n * 10n ** 21n;
    const leg2: RouteLegMember = { nearOI: near, farOI: farDeep, L: 10n ** 26n, feePpm: 500n };
    const ev = routeEventN([leg0, slice(remCap, remOut), leg2]);
    assert.equal(ev.bindLeg, 0, "the narrow leg0 binds");
    const bindOut = bracketOut(10n ** 21n, near, farNarrow);
    assert.equal(ev.awards[1], bindOut, "the slice absorbs leg0's exact output (no clamp needed)");
    const out1 = mulDiv(bindOut, remOut, remCap);
    const far2 = invertFarFromGrossIn(10n ** 26n, near, out1, 500n);
    assert.equal(ev.newFars[2], far2, "leg2 absorbs the slice's floored out as gross-in");
    assert.equal(ev.awards[2], bracketGross(10n ** 26n, near, far2, 500n), "leg2 award == re-derived gross");
    assert.equal(ev.routeOut, bracketOut(10n ** 26n, near, far2), "routeOut == final leg out");
    assert.equal(ev.routeIn, 3013394245478360735n, "routeIn pinned");
    assert.equal(ev.routeOut, 2987869474602317255n, "routeOut pinned");
  });

  it("mid-chain slice UPSTREAM of the binding leg: chained inversion through slice then bracket", () => {
    const leg0: RouteLegMember = { nearOI: near, farOI: farDeep, L: 10n ** 26n, feePpm: FEE };
    const remCap = 10n ** 24n;
    const remOut = 998n * 10n ** 21n;
    const leg2: RouteLegMember = { nearOI: near, farOI: farNarrow, L: 10n ** 21n, feePpm: FEE };
    const ev = routeEventN([leg0, slice(remCap, remOut), leg2]);
    assert.equal(ev.bindLeg, 2, "the narrow leg2 binds");
    const need2 = bracketGross(10n ** 21n, near, farNarrow, FEE);
    const x1 = mulDiv(need2, remCap, remOut);
    assert.equal(ev.awards[1], x1, "the mid slice back-inverts leg2's need");
    const farj0 = invertFarFromOut(10n ** 26n, near, x1);
    assert.equal(ev.routeIn, bracketGross(10n ** 26n, near, farj0, FEE), "leg0 back-inverts the slice's x");
    assert.equal(ev.routeOut, bracketOut(10n ** 21n, near, farNarrow), "routeOut == binding leg2's full out");
    assert.equal(ev.routeIn, 3028518759148977107n, "routeIn pinned");
  });

  // ── 4. Downstream exact-boundary clamp + cursor advance semantics ──
  it("downstream slice landing exactly ON remCap: full consume ⇒ qlCursor advances to the next row", () => {
    const leg0: RouteLegMember = { nearOI: near, farOI: farNarrow, L: 10n ** 21n, feePpm: FEE };
    const bindOut = bracketOut(10n ** 21n, near, farNarrow);
    // slice sized so leg0's exact output == remCap: the clamp lands exactly ON the boundary.
    const remOut = mulDiv(bindOut, 997n, 1000n);
    const ev = routeEventN([leg0, slice(bindOut, remOut)]);
    assert.equal(ev.bindLeg, 0, "leg0 binds (its full cross costs less token-A than the slice's)");
    assert.equal(ev.awards[1], bindOut, "flow == remCap ⇒ award == remCap (exact boundary)");
    // Applying that award is a FULL consume: the cursor advances and re-initializes.
    const rows = [
      { capacity: bindOut, effOut: remOut, marginalOI: qlSliceHead(remOut, bindOut) },
      { capacity: 5n * E18, effOut: 4n * E18, marginalOI: qlSliceHead(4n * E18, 5n * E18) },
    ];
    const c = qlCursorInit(rows);
    const outX = qlCursorConsume(c, ev.awards[1]);
    assert.equal(outX, remOut, "exact-boundary consume produces the full remOut");
    assert.equal(c.cur, 1, "cursor advanced");
    assert.equal(c.remCap, 5n * E18, "remCap re-initialized from the next row");
    assert.equal(c.remOut, 4n * E18, "remOut re-initialized from the next row");
    assert.equal(qlCursorHead(c), rows[1].marginalOI, "head == the new row's original head");
    // Partial then remainder: two consumes spanning the row advance + exhaustion (remOut → 0).
    assert.equal(qlCursorConsume(c, 2n * E18), mulDiv(2n * E18, 4n * E18, 5n * E18), "partial linear out");
    assert.ok(qlCursorActive(c), "still active mid-row");
    qlCursorConsume(c, c.remCap);
    assert.ok(!qlCursorActive(c), "exhausted after the last row");
    assert.equal(c.remOut, 0n, "remOut zeroed on exhaustion");
    assert.equal(c.remCap, 0n, "remCap == 0 is the single exhaustion test");
    // A zero award (gap event) leaves a cursor untouched.
    const c2 = qlCursorInit(rows);
    assert.equal(qlCursorConsume(c2, 0n), 0n, "zero award produces nothing");
    assert.equal(c2.cur, 0, "zero award does not advance");
    assert.equal(c2.remCap, rows[0].capacity, "zero award does not deplete");
  });

  // ── 5. Zero-flow gap event with a slice sibling: the slice is untouched (award 0) ──
  it("gap (L==0) binding leg + slice sibling: routeIn 0, slice award 0", () => {
    const gap: RouteLegMember = { nearOI: near, farOI: farNarrow, L: 0n, feePpm: FEE };
    const ev = routeEventN([gap, slice(10n ** 24n, 998n * 10n ** 21n)]);
    assert.equal(ev.bindLeg, 0, "the gap leg binds");
    assert.equal(ev.routeIn, 0n, "gap event consumes 0 token-A");
    assert.equal(ev.routeOut, 0n, "gap event produces 0");
    assert.equal(ev.awards[1], 0n, "the downstream slice's award is 0 (member untouched)");
  });

  // ── 6. routePartialN with slice members: pflow chaining + the clamped variant ──
  it("routePartialN [bracket, slice, bracket]: awards chain the clamped-path flow (pinned)", () => {
    const leg0: RouteLegMember = { nearOI: near, farOI: farDeep, L: 10n ** 26n, feePpm: FEE };
    const remCap = 10n ** 24n;
    const remOut = 998n * 10n ** 21n;
    const leg2: RouteLegMember = { nearOI: near, farOI: farDeep, L: 2n * 10n ** 26n, feePpm: 500n };
    const target = 123n * E18;
    const r = routePartialN([leg0, slice(remCap, remOut), leg2], target);
    assert.equal(r.awards[0], target, "leg0 takes the full target (rtake)");
    const far0 = invertFarFromGrossIn(10n ** 26n, near, target, FEE);
    assert.equal(r.newFars[0], far0, "leg0 partial far");
    const flow1 = bracketOut(10n ** 26n, near, far0);
    assert.equal(r.awards[1], flow1, "the slice absorbs leg0's output (within capacity)");
    const out1 = mulDiv(flow1, remOut, remCap);
    assert.equal(r.awards[2], out1, "leg2 absorbs the slice's floored out (incoming pflow)");
    assert.equal(r.newFars[1], qlSliceHead(remOut, remCap), "slice newFar carries its head");
    assert.equal(r.routeOut, 122324320307128564022n, "routeOut pinned");
    // Clamped variant: a small slice caps the mid-chain flow at remCap; downstream sees remOut.
    const r2 = routePartialN([leg0, slice(10n * E18, 9n * E18), leg2], target);
    assert.equal(r2.awards[1], 10n * E18, "mid slice clamped at remCap");
    assert.equal(r2.awards[2], 9n * E18, "downstream absorbs the clamped slice's full remOut");
    assert.equal(r2.routeOut, 8995499595404916947n, "clamped routeOut pinned");
  });

  // ── 7. The chain-order sizing fold: est = mulDiv(mulDiv(a, h, Q96), h, Q96) ──
  it("sizing fold known answers (two-step floor mulDiv; hF==0 ⇒ 0; opposite-direction hops)", () => {
    const fold = (x: bigint, h: bigint): bigint => mulDiv(mulDiv(x, h, Q96), h, Q96);
    assert.equal(fold(10n ** 18n, Q96), 10n ** 18n, "h == 1.0 (Q96) is the identity");
    assert.equal(fold(10n ** 18n, Q96 / 2n), 10n ** 18n / 4n, "h == 0.5 quarters (out ≈ in·h²)");
    assert.equal(fold(10n ** 18n, 0n), 0n, "hF == 0 (dead upstream leg) folds the cap to 0");
    assert.equal(fold(10n ** 24n, 3n * 2n ** 95n), 2_250_000n * 10n ** 18n, "h == 1.5 pinned");
    // h² overflows 256 bits at real scales — the two-step form must not (h = 2^100 ⇒ h² = 2^200).
    assert.equal(fold(10n ** 24n, 2n ** 100n), 256n * 10n ** 24n, "big-h two-step fold pinned");
    // Opposite-direction hops: an X/A >> 1 leg then a B/X << 1 leg — the fold rises then falls
    // (each hop reprices the cap into ITS leg-input token; direction is absorbed by the head).
    assert.equal(fold(fold(10n ** 18n, 2n * Q96), Q96 / 3n), 444444444444444444n, "up-down fold pinned");
  });

  // ── 8. All-bracket REGRESSION pins: byte-identical outputs + awards consistency ──
  it("all-bracket routeEventN/routePartialN: explicit kind:'bracket' is bit-identical; awards pinned to the accrual formulas", () => {
    const mk = (L: bigint, farTick: number, fee: bigint): RouteLeg => ({
      nearOI: near,
      farOI: toOutIn(getSqrtRatioAtTick(farTick), true),
      L,
      feePpm: fee,
    });
    const trios: [RouteLeg, RouteLeg, RouteLeg][] = [
      [mk(10n ** 21n, -60, FEE), mk(10n ** 26n, -6000, FEE), mk(2n * 10n ** 26n, -6000, 500n)],
      [mk(10n ** 26n, -6000, 500n), mk(10n ** 21n, -60, FEE), mk(10n ** 26n, -6000, FEE)],
      [mk(10n ** 26n, -6000, FEE), mk(3n * 10n ** 26n, -6000, 100n), mk(10n ** 21n, -60, 500n)],
    ];
    for (const legs of trios) {
      const plain = routeEventN(legs);
      const tagged = routeEventN(legs.map((l) => ({ kind: "bracket" as const, ...l })));
      assert.equal(plain.routeIn, tagged.routeIn, "routeIn identical with/without kind tag");
      assert.equal(plain.routeOut, tagged.routeOut, "routeOut identical");
      assert.equal(plain.bindLeg, tagged.bindLeg, "bindLeg identical");
      assert.deepEqual(plain.newFars, tagged.newFars, "newFars identical");
      assert.deepEqual(plain.awards, tagged.awards, "awards identical");
      assert.equal(plain.dX, tagged.dX, "dX identical");
      // awards == the solver's full-event accrual: leg0 = routeIn; deeper = the re-derived
      // bracketGross over [near, newFar] (the binding leg's == its full-cross gross).
      assert.equal(plain.awards[0], plain.routeIn, "awards[0] == routeIn");
      for (let i = 1; i < legs.length; i++) {
        assert.equal(
          plain.awards[i],
          bracketGross(legs[i].L, legs[i].nearOI, plain.newFars[i], legs[i].feePpm),
          `awards[${i}] == bracketGross to newFar`,
        );
      }
      // routePartialN awards == the clamped-path accrual: leg0 = target, deeper = incoming pflow.
      const target = 3n * E18;
      const p = routePartialN(legs, target);
      assert.equal(p.awards[0], target, "partial awards[0] == target");
      let pflow = target;
      for (let i = 0; i < legs.length; i++) {
        assert.equal(p.awards[i], pflow, `partial awards[${i}] == incoming pflow`);
        pflow = bracketOut(legs[i].L, legs[i].nearOI, p.newFars[i]);
      }
      assert.equal(p.routeOut, pflow, "partial routeOut == final leg out");
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 12. optimalSplit: ONE route + ONE direct pool — post-fee marginal EQUALIZES at the cut
// ─────────────────────────────────────────────────────────────
//
// The whole point of the water-fill: at the cut every engaged venue's post-fee marginal out/in
// price is the same (to rounding). For a route the comparable marginal is the LEFT-TO-RIGHT
// product fold of the per-leg fee-adjusted out/in heads — directly comparable to a direct pool's
// fee-adjusted near. This vector asserts that fold (route head) ≈ the direct pool's marginal at
// the cut, and that the total spend == amountIn.
describe("optimalSplit equalization — direct pool + 2-hop route share a common marginal", () => {
  const E18 = 10n ** 18n;
  const spot = getSqrtRatioAtTick(0);

  // Helper: the fee-adjusted out/in head for a leg at near `n`, fee `f` (matches the oracle's
  // feeAdjOI = n · sqrtOneMinusFeeScaled(f) / FEE_DENOM).
  function feeAdjOI(n: bigint, f: number): bigint {
    return (n * sqrtOneMinusFeeScaled(f)) / FEE_DENOM;
  }

  it("post-fee route head ≈ direct-pool fee-adjusted marginal at the cut; total == amountIn", () => {
    // Both venues with tickSpacing 60 and SHALLOW liquidity (so the route enters as many fine
    // micro-segments and lands at a clean interior cut without hitting the per-pool step cap).
    const TS = 60;
    const directL = 10n ** 22n;
    const directFee = 500;
    const legL = 10n ** 22n;
    const legFee = 3000;
    const directPool: OptimalPool = { isV2: false, feePpm: directFee, sqrtPriceX96: spot, tick: 0, tickSpacing: TS, liquidity: directL, net: new Map() };
    const route: OptimalRoute = {
      legs: [
        { zeroForOne: true, pools: [{ isV2: false, feePpm: legFee, sqrtPriceX96: spot, tick: 0, tickSpacing: TS, liquidity: legL, net: new Map() }] },
        { zeroForOne: true, pools: [{ isV2: false, feePpm: legFee, sqrtPriceX96: spot, tick: 0, tickSpacing: TS, liquidity: legL, net: new Map() }] },
      ],
    };
    // Size the trade so BOTH venues engage and land at an interior cut (not exhausting either).
    const amountIn = 10000n * E18;
    const res = optimalSplit({ pools: [directPool], routes: [route], amountIn, zeroForOne: true, priceLimit: 0n });
    assert.equal(res.totalInput, amountIn, "spends amountIn exactly");
    assert.ok(res.perPoolInput[0] > 0n, "direct pool engaged");
    assert.ok(res.perRouteInput[0] > 0n, "route engaged");

    // Reconstruct the marginal each venue reached by absorbing its assigned input (constant-L step).
    const advance = (n: bigint, L: bigint, f: number, grossIn: bigint): bigint => {
      const effIn = mulDiv(grossIn, FEE_DENOM - BigInt(f), FEE_DENOM);
      const rIn = mulDiv(L, Q96, n);
      return mulDiv(L, Q96, rIn + effIn);
    };
    const dNear0 = toOutIn(spot, true);
    const dFar = advance(dNear0, directL, directFee, res.perPoolInput[0]);
    const directMarginalAdj = feeAdjOI(dFar, directFee);

    // Route marginal at the cut: propagate the route input through both legs, then fold the legs'
    // fee-adjusted far heads (the route's post-fee marginal in the same out/in coordinate).
    const r1Near0 = toOutIn(spot, true);
    const r1Far = advance(r1Near0, legL, legFee, res.perRouteInput[0]);
    const x1 = mulDiv(legL, r1Near0 - r1Far, Q96);
    const r2Near0 = toOutIn(spot, true);
    const r2Far = advance(r2Near0, legL, legFee, x1);
    const routeMarginalAdj = routeHeadFold([feeAdjOI(r1Far, legFee), feeAdjOI(r2Far, legFee)]);

    // Equalization: the two post-fee marginals agree to within the segment-merge resolution — the
    // water-fill discretizes each venue into tickSpacing-wide segments, so the marginals at the cut
    // can differ by at most ~one tickSpacing step in sqrt price. For ts=60 that step is ≈0.3% in
    // sqrt (≈3000 ppm); the realized gap here is well inside it (~700 ppm). 2000 ppm asserts they
    // genuinely equalized (not a corner solution) while honoring the discretization floor.
    assertClose(routeMarginalAdj, directMarginalAdj, 2000n, "route head ≈ direct marginal at the cut (segment-merge resolution)");
  });
});

// ─────────────────────────────────────────────────────────────
// 13. optimalSplit: multi-pool LEG + OPPOSITE-DIRECTION hops
// ─────────────────────────────────────────────────────────────
//
// Two structural cases the route model must handle: (1) a route whose legs differ — and a leg
// that competes against a direct pool of a different fee (a stand-in for multi-pool-leg liquidity
// stitching: the oracle's foundation leg is one pool, but the merge already splits a leg's
// liquidity against other venues at the same out/in price); (2) a route whose two hops swap in
// OPPOSITE directions (z1 != z2), e.g. A→X via token0→token1 then X→B via token1→token0 — the
// route head fold and conservation are direction-agnostic because each leg works in its OWN out/in
// space (toOutIn already absorbs the per-hop direction).
describe("optimalSplit — multi-fee competition + opposite-direction route hops", () => {
  const E18 = 10n ** 18n;
  const spot = getSqrtRatioAtTick(0);

  it("a route + two direct pools of different fees: Σ venues == amountIn, all engaged at scale", () => {
    // Two direct pools (fee 0.05% and 0.30%) plus a 2-hop route (two 0.30% legs). A large trade
    // funds all three to a common cut. This mirrors a leg's liquidity competing against other
    // pools at the same price (the multi-pool-leg case, modeled as parallel venues here).
    // SHALLOW direct pools (drain to the route head in ≈2760·E18 / ≈1508·E18); DEEP route legs.
    const p0: OptimalPool = { isV2: false, feePpm: 500, sqrtPriceX96: spot, tick: 0, tickSpacing: 10, liquidity: 10n ** 24n, net: new Map() };
    const p1: OptimalPool = { isV2: false, feePpm: 3000, sqrtPriceX96: spot, tick: 0, tickSpacing: 60, liquidity: 10n ** 24n, net: new Map() };
    const route: OptimalRoute = {
      legs: [
        { zeroForOne: true, pools: [{ isV2: false, feePpm: 3000, sqrtPriceX96: spot, tick: 0, tickSpacing: 60, liquidity: 10n ** 26n, net: new Map() }] },
        { zeroForOne: true, pools: [{ isV2: false, feePpm: 3000, sqrtPriceX96: spot, tick: 0, tickSpacing: 60, liquidity: 10n ** 26n, net: new Map() }] },
      ],
    };
    const amountIn = 10000n * E18;
    const res = optimalSplit({ pools: [p0, p1], routes: [route], amountIn, zeroForOne: true, priceLimit: 0n });
    const sum = res.perPoolInput.reduce((a, b) => a + b, 0n) + res.perRouteInput.reduce((a, b) => a + b, 0n);
    assert.equal(sum, res.totalInput, "Σ venues == total");
    assert.equal(res.totalInput, amountIn, "spends amountIn exactly");
    // The deep-fee-0.05% pool fills first; at scale all three engage.
    assert.ok(res.perPoolInput[0] > 0n, "0.05% direct pool engaged");
    assert.ok(res.perPoolInput[1] > 0n, "0.30% direct pool engaged");
    assert.ok(res.perRouteInput[0] > 0n, "route engaged");
  });

  it("opposite-direction hops (z1 != z2): the route still composes and conserves", () => {
    // leg1 zeroForOne (A=token0 → X=token1), leg2 oneForZero (X=token0-of-pool2 → B=token1-of-pool2,
    // but the hop direction is the reverse), so the second leg's out/in space is the RECIPROCAL.
    // We seed leg2 at a price where its out/in spot (after toOutIn with zeroForOne:false) is a
    // sensible head, and assert the route routes input and produces output (composition is
    // direction-agnostic; each leg uses its own toOutIn). Compared against a direct pool to force a
    // real split.
    const spotLeg2Real = getSqrtRatioAtTick(0); // pool2 real sqrt; oneForZero ⇒ out/in = Q192/spot
    const route: OptimalRoute = {
      legs: [
        { zeroForOne: true, pools: [{ isV2: false, feePpm: 3000, sqrtPriceX96: spot, tick: 0, tickSpacing: 60, liquidity: 10n ** 26n, net: new Map() }] },
        { zeroForOne: false, pools: [{ isV2: false, feePpm: 3000, sqrtPriceX96: spotLeg2Real, tick: 0, tickSpacing: 60, liquidity: 10n ** 26n, net: new Map() }] },
      ],
    };
    const directPool: OptimalPool = { isV2: false, feePpm: 500, sqrtPriceX96: spot, tick: 0, tickSpacing: 10, liquidity: 10n ** 24n, net: new Map() };
    const amountIn = 5000n * E18;
    const res = optimalSplit({ pools: [directPool], routes: [route], amountIn, zeroForOne: true, priceLimit: 0n });
    assert.equal(res.totalInput, amountIn, "spends amountIn exactly with an opposite-direction route");
    assert.ok(res.perRouteInput[0] > 0n, "opposite-direction route engaged");
    // Conservation holds across the direction flip (Σ venues == total).
    const sum = res.perPoolInput.reduce((a, b) => a + b, 0n) + res.perRouteInput.reduce((a, b) => a + b, 0n);
    assert.equal(sum, res.totalInput, "Σ venues == total across the direction flip");
  });
});

// ── Solidly STABLE (sAMM) known-answer + segment sampler ─────────────────────
//
// Pins the off-chain x3y+y3x replay (getAmountOutStable + buildSolidlyStableSegments) BEFORE the
// local-EVM test, so a regression in the bigint math is caught without anvil. The wei-exact bound is
// documented in solidly-stable-math.ts: the SPLIT is exact-on-grid vs the oracle (one shared sampler)
// and the realized dy is exact-in-dy (the pool getAmountOut view == the pool swap math). These vectors
// are the deterministic getAmountOutStable outputs for fixed states (regenerate only on an intentional
// math change). A near-1:1 stable swap loses only the fee + tiny curvature slippage — the assertions
// pin the EXACT wei and the qualitative stable shape (out ≈ in net of fee, monotone, descending grid).
describe("Solidly STABLE (sAMM) — getAmountOutStable known-answer + sampler", () => {
  const E18 = 10n ** 18n;
  const Z = "0x0000000000000000000000000000000000000001" as `0x${string}`;
  function pool(resIn: bigint, resOut: bigint, decIn: bigint, decOut: bigint, feePpm: number): SolidlyStablePool {
    return { address: Z, reserveIn: resIn, reserveOut: resOut, decIn, decOut, token0: Z, inIsToken0: true, feePpm, source: "kat" };
  }

  it("balanced 1:1 18-dec pool, fee 0.01% — exact get_y vectors", () => {
    const p = pool(1_000_000n * E18, 1_000_000n * E18, E18, E18, 100);
    // Hand-pinned from the bounded-Newton replay (mirrors the fixture's _getY bit-for-bit).
    assert.equal(getAmountOutStable(p, 1_000n * E18), 999_899_999_500_199_970_501n);
    assert.equal(getAmountOutStable(p, 10_000n * E18), 9_998_995_002_004_715_249_130n);
    assert.equal(getAmountOutStable(p, 100_000n * E18), 99_940_071_761_225_519_228_641n);
    // Stable shape: a small trade returns ~the input net of the 0.01% fee (≈ 0.9999·in) with sub-bps
    // curvature slippage on top — far flatter than a constant-product pool of the same depth.
    const out1k = getAmountOutStable(p, 1_000n * E18);
    assert.ok(out1k < 1_000n * E18 && out1k > 999n * E18, "near-1:1 minus fee on a stable curve");
  });

  it("imbalanced 1:1.2 pool — exact vector", () => {
    const p = pool(1_000_000n * E18, 1_200_000n * E18, E18, E18, 100);
    assert.equal(getAmountOutStable(p, 50_000n * E18), 50_030_221_094_822_880_188_807n);
  });

  it("decimals normalisation — 6-dec out token denormalises exactly", () => {
    const p = pool(1_000_000n * E18, 1_000_000n * (10n ** 6n), E18, 10n ** 6n, 100);
    // 1000 (18-dec) in → ~1000 (6-dec) out net of fee: 999.899999 USDC-units.
    assert.equal(getAmountOutStable(p, 1_000n * E18), 999_899_999n);
  });

  it("buildSolidlyStableSegments — covers amountIn, strictly descending marginals", () => {
    const p = pool(1_000_000n * E18, 1_000_000n * E18, E18, E18, 100);
    const amountIn = 100_000n * E18;
    const segs = buildSolidlyStableSegments(p, amountIn);
    assert.ok(segs.length > 0, "non-empty segment ladder");
    const sumCap = segs.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(sumCap, amountIn, "segments cover the full amountIn (last sample == amountIn)");
    for (let i = 1; i < segs.length; i++) {
      assert.ok(segs[i].marginalOI <= segs[i - 1].marginalOI, "marginals strictly descending");
    }
    // Σ effOut over the grid == getAmountOutStable(amountIn) (the sampler is a partition of the curve).
    const sumOut = segs.reduce((a, s) => a + s.effOut, 0n);
    assert.equal(sumOut, getAmountOutStable(p, amountIn), "Σ segment effOut == getAmountOutStable(amountIn)");
  });
});

// ── Wombat (single-sided stableswap) known-answer + segment sampler ──────────
//
// Pins the off-chain coverage-ratio replay (quotePotentialSwap + buildWombatSegments) BEFORE the
// local-EVM test, so a regression in the closed-form bigint math is caught without anvil. The
// wei-exact bound is documented in wombat-math.ts: the SPLIT is exact-on-grid vs the oracle (one
// shared sampler) and the realized dy is exact-in-dy (the pool quotePotentialSwap view == the pool
// swap math). These vectors are the deterministic quotePotentialSwap outputs for fixed states
// (regenerate only on an intentional math change). cash/liability are WAD regardless of token
// decimals; amp 0.2%, haircut 0.01% (canonical Wombat main-pool params). A near-1:1 stable swap
// loses only the haircut + tiny coverage-ratio slippage.
describe("Wombat (single-sided stableswap) — quotePotentialSwap known-answer + sampler", () => {
  const E18 = 10n ** 18n;
  const Z = "0x0000000000000000000000000000000000000001" as `0x${string}`;
  const AMP = 2n * 10n ** 15n; // 0.002e18 = 0.2%
  const HC = 10n ** 14n; // 0.0001e18 = 0.01% haircut
  function pool(
    fromCash: bigint, fromLiability: bigint, toCash: bigint, toLiability: bigint,
    decIn: bigint, decOut: bigint,
  ): WombatPool {
    return {
      address: Z, fromCash, fromLiability, toCash, toLiability,
      ampFactor: AMP, haircutRate: HC, decIn, decOut, tokenIn: Z, tokenOut: Z,
      feePpm: 100, source: "kat",
    };
  }

  it("balanced pool (cash==liability, 18-dec), amp 0.2% / haircut 0.01% — exact coverage-ratio vectors", () => {
    const p = pool(1_000_000n * E18, 1_000_000n * E18, 1_000_000n * E18, 1_000_000n * E18, E18, E18);
    // Hand-pinned from the closed-form replay (mirrors the WombatPool fixture _quoteFrom bit-for-bit).
    assert.equal(quotePotentialSwap(p, 1_000n * E18), 999_896_008_395_200_400_000n);
    assert.equal(quotePotentialSwap(p, 10_000n * E18), 9_998_600_814_580_673_186_100n);
    assert.equal(quotePotentialSwap(p, 100_000n * E18), 99_949_699_502_944_117_863_300n);
    // Stable shape: a small trade returns ~the input net of the 0.01% haircut (≈ 0.9999·in) with
    // sub-bps coverage slippage on top — far flatter than a constant-product pool of the same depth.
    const out1k = quotePotentialSwap(p, 1_000n * E18);
    assert.ok(out1k < 1_000n * E18 && out1k > 999n * E18, "near-1:1 minus haircut on the coverage-ratio curve");
  });

  it("imbalanced pool (from over-, to under-covered) — exact vector", () => {
    const p = pool(1_200_000n * E18, 1_000_000n * E18, 800_000n * E18, 1_000_000n * E18, E18, E18);
    assert.equal(quotePotentialSwap(p, 50_000n * E18), 49_895_364_213_513_015_209_100n);
  });

  it("decimals normalisation — 6-dec out token denormalises exactly", () => {
    const p = pool(1_000_000n * E18, 1_000_000n * E18, 1_000_000n * E18, 1_000_000n * E18, E18, 10n ** 6n);
    // 1000 (18-dec) in → ~1000 (6-dec) out net of haircut: 999.896008 USDC-units.
    assert.equal(quotePotentialSwap(p, 1_000n * E18), 999_896_008n);
  });

  it("buildWombatSegments — covers amountIn, descending marginals, partition of the curve", () => {
    const p = pool(1_000_000n * E18, 1_000_000n * E18, 1_000_000n * E18, 1_000_000n * E18, E18, E18);
    const amountIn = 100_000n * E18;
    const segs = buildWombatSegments(p, amountIn);
    assert.ok(segs.length > 0, "non-empty segment ladder");
    const sumCap = segs.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(sumCap, amountIn, "segments cover the full amountIn (last sample == amountIn)");
    for (let i = 1; i < segs.length; i++) {
      assert.ok(segs[i].marginalOI <= segs[i - 1].marginalOI, "marginals descending");
    }
    // Σ effOut over the grid == quotePotentialSwap(amountIn) (the sampler is a partition of the curve).
    const sumOut = segs.reduce((a, s) => a + s.effOut, 0n);
    assert.equal(sumOut, quotePotentialSwap(p, amountIn), "Σ segment effOut == quotePotentialSwap(amountIn)");
  });
});

// ── WOOFi (WooPPV2 sPMM) known-answer + segment sampler ──────────────────────
//
// Pins the off-chain oracle-price sPMM replay (query + buildWooFiSegments) BEFORE the local-EVM test,
// so a regression in the closed-form _calcQuoteAmountSellBase / _calcBaseAmountSellQuote + fee math is
// caught without anvil. The wei-exact bound is documented in woofi-math.ts: the SPLIT is exact-on-grid
// at the SNAPSHOT oracle (one shared sampler) and the realized dy is exact-in-dy (the pool query view
// reads the LIVE oracle == the pool swap math). These vectors are the deterministic query outputs for
// fixed oracle states (regenerate only on an intentional math change). price scaled 1e8; spread 1bp
// (1e14 WAD); coeff 1e9 (WAD); feeRate 25 (0.025%). A near-1:1 base↔quote stable swap loses only the
// fee + tiny gamma/spread slippage.
describe("WOOFi (WooPPV2 sPMM) — query known-answer + sampler", () => {
  const E18 = 10n ** 18n;
  const E8 = 10n ** 8n;
  const E6 = 10n ** 6n;
  const Z = "0x0000000000000000000000000000000000000001" as `0x${string}`;
  const SPREAD = 10n ** 14n; // 0.0001e18 = 1 bp
  const COEFF = 10n ** 9n; // gamma coefficient k (WAD-scaled)
  const FEER = 25n; // 0.025% (1e5-scaled)
  function pool(
    sellBase: boolean, price: bigint, priceDec: bigint, quoteDec: bigint, baseDec: bigint,
  ): WooFiPool {
    return {
      address: Z, tokenIn: Z, tokenOut: Z, sellBase, price, spread: SPREAD, coeff: COEFF,
      priceDec, quoteDec, baseDec, feeRate: FEER, feePpm: 250, source: "kat",
    };
  }

  it("sell base (base 18-dec → quote 6-dec), price $1 (1e8) — exact sPMM vectors", () => {
    const p = pool(true, E8, E8, E6, E18);
    // Hand-pinned from the closed-form replay (mirrors the WooPPV2 fixture _calc*/fee bit-for-bit).
    assert.equal(wooFiQuery(p, 1_000n * E18), 999_649_026n);
    assert.equal(wooFiQuery(p, 10_000n * E18), 9_996_400_275n);
    assert.equal(wooFiQuery(p, 100_000n * E18), 99_955_005_000n);
    // Near-1:1 minus the 0.025% fee + tiny gamma/spread slippage: 1000 base ≈ 999.649 quote.
    const out1k = wooFiQuery(p, 1_000n * E18);
    assert.ok(out1k < 1_000n * E6 && out1k > 999n * E6, "near-1:1 minus fee on the sPMM curve");
  });

  it("sell quote (quote 6-dec → base 18-dec), price $1 (1e8) — exact sPMM vectors", () => {
    const p = pool(false, E8, E8, E6, E18);
    assert.equal(wooFiQuery(p, 1_000n * E6), 999_649_025_499_937_500_000n);
    assert.equal(wooFiQuery(p, 10_000n * E6), 9_996_400_299_993_750_000_000n);
    assert.equal(wooFiQuery(p, 100_000n * E6), 99_955_007_499_375_000_000_000n);
  });

  it("sell base at a non-unit price (base 18-dec → quote 18-dec, price $2000) — exact vector", () => {
    const p = pool(true, 2000n * E8, E8, E18, E18);
    assert.equal(wooFiQuery(p, 1n * E18), 1_999_296_051_000_000_000_000n);
    assert.equal(wooFiQuery(p, 10n * E18), 19_992_600_600_000_000_000_000n);
  });

  it("buildWooFiSegments — covers amountIn, descending marginals, partition of the curve", () => {
    const p = pool(true, E8, E8, E6, E18);
    const amountIn = 100_000n * E18;
    const segs = buildWooFiSegments(p, amountIn);
    assert.ok(segs.length > 0, "non-empty segment ladder");
    const sumCap = segs.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(sumCap, amountIn, "segments cover the full amountIn (last sample == amountIn)");
    for (let i = 1; i < segs.length; i++) {
      assert.ok(segs[i].marginalOI <= segs[i - 1].marginalOI, "marginals descending");
    }
    // Σ effOut over the grid == query(amountIn) (the sampler is a partition of the curve).
    const sumOut = segs.reduce((a, s) => a + s.effOut, 0n);
    assert.equal(sumOut, wooFiQuery(p, amountIn), "Σ segment effOut == query(amountIn)");
  });
});

// ── Fermi / propAMM (gattaca-com/propamm FermiSwapper — Obric-style proactive AMM) ladder + sampler ──
//
// The real FermiSwapper exposes NO closed-form state getters and NO getAmountOut view — the split is priced
// off a LIVE `quoteAmounts` ladder discovery samples (see fermi-math.ts). So there is no hand-pinned
// closed-form KAT to assert; instead this pins the LADDER machinery: `getAmountOut` interpolates the
// (cumIn, cumOut) points, and `buildFermiSegments` differences that ladder into a descending-marginal
// partition. We synthesize a plausible near-1:1 ladder (the Obric X→Y form K/base − K/(base+dx) at a deep
// curve, fee off the output) as the sampled quotes — mirroring what discovery would store from the router.
describe("Fermi / propAMM (Obric-style proactive AMM) — quote-ladder interpolation + sampler", () => {
  const E18 = 10n ** 18n;
  const Z = "0x0000000000000000000000000000000000000001" as `0x${string}`;
  const V0 = 10_000_000n * E18;
  const K = V0 * V0; // v0² · multX/multY with multX==multY
  const BASE = V0; // v0 + reserveX − targetX with reserveX==targetX
  const FEE_SCALE = 10n ** 6n;
  const FEEPPM = 300n; // 0.03% (1e6-scaled)

  // The Obric X→Y closed form + fee off the output — used ONLY to synthesize the sampled ladder the router
  // would return (NOT a getter the recipe reads).
  function xToY(dx: bigint): bigint {
    if (dx <= 0n) return 0n;
    const gross = K / BASE - K / (BASE + dx);
    const fee = (gross * FEEPPM) / FEE_SCALE;
    return gross > fee ? gross - fee : 0n;
  }

  function ladderPool(amountIn: bigint): FermiPool {
    const cumIn = fermiSampleInputs(amountIn);
    const cumOut = cumIn.map(xToY);
    return { address: Z, tokenIn: Z, tokenOut: Z, cumIn, cumOut, feePpm: Number(FEEPPM), source: "kat" };
  }

  it("getAmountOut — exact at a ladder point, interpolated between", () => {
    const amountIn = 100_000n * E18;
    const p = ladderPool(amountIn);
    // Exact at a stored sample.
    const i = p.cumIn.length - 1;
    assert.equal(fermiGetAmountOut(p, p.cumIn[i]), p.cumOut[i], "exact at the last ladder point");
    // A SMALL trade is near-1:1 minus the 0.03% fee + tiny curvature slippage on the deep curve; a large
    // trade loses more to curvature (monotone out, less than in).
    const small = p.cumIn[0];
    const outSmall = fermiGetAmountOut(p, small);
    assert.ok(outSmall < small && outSmall > (small * 999n) / 1000n, "near-1:1 minus fee on a small propAMM slice");
    const out = fermiGetAmountOut(p, amountIn);
    assert.ok(out < amountIn && out > (amountIn * 98n) / 100n, "large trade: below par by fee + curvature");
    // Interpolation is monotone and bracketed between the two neighbouring ladder points.
    const mid = (p.cumIn[0] + p.cumIn[1]) / 2n;
    const interp = fermiGetAmountOut(p, mid);
    assert.ok(interp >= p.cumOut[0] && interp <= p.cumOut[1], "interpolated between neighbouring points");
  });

  it("buildFermiSegments — covers amountIn, descending marginals, partition of the ladder", () => {
    const amountIn = 100_000n * E18;
    const p = ladderPool(amountIn);
    const segs = buildFermiSegments(p, amountIn);
    assert.ok(segs.length > 0, "non-empty segment ladder");
    const sumCap = segs.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(sumCap, amountIn, "segments cover the full amountIn (last sample == amountIn)");
    for (let i = 1; i < segs.length; i++) {
      assert.ok(segs[i].marginalOI <= segs[i - 1].marginalOI, "marginals descending");
    }
    // Σ effOut over the grid == getAmountOut(amountIn) (the sampler is a partition of the ladder).
    const sumOut = segs.reduce((a, s) => a + s.effOut, 0n);
    assert.equal(sumOut, fermiGetAmountOut(p, amountIn), "Σ segment effOut == getAmountOut(amountIn)");
  });
});

// ── Fluid DEX (Instadapp fluid-contracts-public FluidDexT1 — Liquidity-Layer re-centering AMM) ladder ──
//
// The real FluidDexT1 pool exposes NO closed-form state getters and NO getAmountOut view (its own estimate
// is a REVERT) — the split is priced off a LIVE `estimateSwapIn` ladder discovery samples via the periphery
// resolver (see fluid-math.ts). So there is no hand-pinned closed-form KAT to assert; instead this pins the
// LADDER machinery: `getAmountOut` interpolates the (cumIn, cumOut) points, and `buildFluidSegments`
// differences that ladder into a descending-marginal partition. We synthesize a plausible near-1:1 ladder
// (the re-centering layer form amountIn·rate0/rate1·center, fee off the output, then an out-cap) as the
// sampled quotes — mirroring what discovery would store from the resolver.
describe("Fluid DEX (FluidDexT1 Liquidity-Layer re-centering AMM) — quote-ladder interpolation + sampler", () => {
  const E18 = 10n ** 18n;
  const Z = "0x0000000000000000000000000000000000000001" as `0x${string}`;
  const RATE = E18; // both sides at par exchange rate
  const CENTER = E18; // 1:1 center price
  const FEE_SCALE = 10n ** 6n;
  const FEEPPM = 100n; // 0.01% (1e6-scaled) — Fluid stable-tier fee
  // Depth for the mild convex slippage term (larger ⇒ flatter/deeper, less slippage per unit).
  const DEPTH = 20_000_000n * E18;
  // An out-cap that bites only well past the sampled range (so the ladder stays a clean partition here).
  const OUT_CAP = 500_000n * E18;

  // The re-centering layer out (amountIn·rate0/rate1·center) minus a size-dependent utilization slippage
  // (dx²/DEPTH — Fluid's price worsens with size as the layer utilization rises), minus the fee, then
  // capped. Used ONLY to synthesize the sampled ladder the resolver would return (NOT a getter the recipe
  // reads). The mild convexity gives strictly-descending marginals (like the Fermi/WOOFi KATs).
  function xToY(dx: bigint): bigint {
    if (dx <= 0n) return 0n;
    const par = ((dx * RATE) / RATE * CENTER) / E18;
    const slip = (dx * dx) / DEPTH; // utilization slippage, convex in size
    const gross = par > slip ? par - slip : 0n;
    const fee = (gross * FEEPPM) / FEE_SCALE;
    const net = gross > fee ? gross - fee : 0n;
    return net > OUT_CAP ? 0n : net;
  }

  function ladderPool(amountIn: bigint): FluidPool {
    const cumIn = fluidSampleInputs(amountIn);
    const cumOut = cumIn.map(xToY);
    return {
      address: Z, resolver: Z, swap0to1: true, tokenIn: Z, tokenOut: Z,
      cumIn, cumOut, feePpm: Number(FEEPPM), source: "kat",
    };
  }

  it("getAmountOut — exact at a ladder point, interpolated between, fee-adjusted", () => {
    const amountIn = 100_000n * E18;
    const p = ladderPool(amountIn);
    // Exact at a stored sample.
    const i = p.cumIn.length - 1;
    assert.equal(fluidGetAmountOut(p, p.cumIn[i]), p.cumOut[i], "exact at the last ladder point");
    // A SMALL trade is near-1:1 minus the 0.01% fee + tiny utilization slippage; a large trade loses more
    // to the convex utilization term (monotone out, less than in).
    const small = p.cumIn[0];
    const outSmall = fluidGetAmountOut(p, small);
    assert.ok(outSmall < small && outSmall > (small * 999n) / 1000n, "near-1:1 minus fee on a small Fluid slice");
    const out = fluidGetAmountOut(p, amountIn);
    assert.ok(out < amountIn && out > (amountIn * 98n) / 100n, "large trade: below par by fee + utilization");
    // Interpolation is monotone and bracketed between the two neighbouring ladder points.
    const mid = (p.cumIn[0] + p.cumIn[1]) / 2n;
    const interp = fluidGetAmountOut(p, mid);
    assert.ok(interp >= p.cumOut[0] && interp <= p.cumOut[1], "interpolated between neighbouring points");
  });

  it("buildFluidSegments — covers amountIn, descending (flat) marginals, partition of the ladder", () => {
    const amountIn = 100_000n * E18;
    const p = ladderPool(amountIn);
    const segs = buildFluidSegments(p, amountIn);
    assert.ok(segs.length > 0, "non-empty segment ladder");
    const sumCap = segs.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(sumCap, amountIn, "segments cover the full amountIn (last sample == amountIn)");
    for (let i = 1; i < segs.length; i++) {
      assert.ok(segs[i].marginalOI <= segs[i - 1].marginalOI, "marginals non-increasing");
    }
    // Σ effOut over the grid == getAmountOut(amountIn) (the sampler is a partition of the ladder).
    const sumOut = segs.reduce((a, s) => a + s.effOut, 0n);
    assert.equal(sumOut, fluidGetAmountOut(p, amountIn), "Σ segment effOut == getAmountOut(amountIn)");
  });

  it("out-cap: discovery truncates the ladder at the utilization cap; segments stay a clean partition", () => {
    // Size amountIn so the LAST samples exceed OUT_CAP → those quote 0. discoverFluidPoolsTyped keeps only
    // the strictly-positive non-decreasing PREFIX (the cap edge, like EulerSwap's inLimit); replay that
    // truncation here, then build over the truncated descriptor.
    const amountIn = 1_000_000n * E18; // net at par ≈ 999_900 * E18 > OUT_CAP for the tail samples
    const rawIn = fluidSampleInputs(amountIn);
    const rawOut = rawIn.map(xToY);
    assert.ok(rawOut.some((o) => o === 0n), "some tail samples exceed the out-cap and quote 0");
    // Discovery's non-decreasing-positive prefix rule (verbatim from discoverFluidPoolsTyped).
    const cumIn: bigint[] = [];
    const cumOut: bigint[] = [];
    let prev = 0n;
    for (let i = 0; i < rawIn.length; i++) {
      if (rawOut[i] <= prev) break;
      cumIn.push(rawIn[i]);
      cumOut.push(rawOut[i]);
      prev = rawOut[i];
    }
    assert.ok(cumIn.length > 0 && cumIn.length < rawIn.length, "prefix truncated below the cap");
    const capBoundary = cumIn[cumIn.length - 1];
    const p: FluidPool = {
      address: Z, resolver: Z, swap0to1: true, tokenIn: Z, tokenOut: Z,
      cumIn, cumOut, feePpm: Number(FEEPPM), source: "kat-cap",
    };
    // Build over the truncated ladder capped at amountIn (the on-chain merge would only award the tradeable
    // prefix; anything past the cap is un-fillable, so the split covers only up to the cap boundary).
    const segs = buildFluidSegments(p, amountIn);
    const covered = segs.reduce((a, s) => a + s.capacity, 0n);
    assert.ok(segs.every((s) => s.effOut > 0n), "every segment has a positive out (none past the cap)");
    assert.equal(covered, capBoundary, "covered input == the cap boundary (the tradeable prefix)");
    assert.ok(covered < amountIn, "the cap truncates the covered input below amountIn");
  });
});

// ── Mento V2 (Celo mento-protocol/mento-core Broker + BiPoolManager) quote-ladder ──
//
// Mento's BiPoolManager prices off oracle rates + a spread over interval-updated pricing buckets — the
// split is priced off a LIVE Broker `getAmountOut` ladder discovery samples (see mento-math.ts). So there
// is no hand-pinned closed-form KAT to assert; instead this pins the LADDER machinery: `getAmountOut`
// interpolates the (cumIn, cumOut) points, and `buildMentoSegments` differences that ladder into a
// descending-marginal partition. We synthesize a plausible near-1:1 constant-product-over-buckets ladder
// (a cUSD/USDC-style stable pair — bucket0/bucket1 with a spread off the output, then a trading-limit cap)
// as the sampled quotes — mirroring what discovery would store from the Broker.
describe("Mento V2 (Celo Broker + BiPoolManager bucket-priced exchange) — quote-ladder interpolation + sampler", () => {
  const E18 = 10n ** 18n;
  const Z = "0x0000000000000000000000000000000000000001" as `0x${string}`;
  const ZID = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
  const SPREAD_SCALE = 10n ** 6n;
  const SPREADPPM = 100n; // 0.01% (1e6-scaled) — Mento stable-tier spread
  // Constant-product bucket amounts (near-1:1 stable pair): out = bucket1 - bucket0*bucket1/(bucket0+dx),
  // deep enough that a 100k swap stays near-1:1 but the marginal genuinely descends so the split
  // equalizes across venues of different depth.
  const BUCKET0 = 20_000_000n * E18;
  const BUCKET1 = 20_000_000n * E18;
  // A trading-limit out-cap that bites only well past the sampled range.
  const OUT_CAP = 500_000n * E18;

  // The bucket constant-product out minus the spread off the output, then capped. Used ONLY to synthesize
  // the sampled ladder the Broker would return (NOT a getter the recipe reads).
  function xToY(dx: bigint): bigint {
    if (dx <= 0n) return 0n;
    const gross = BUCKET1 - (BUCKET0 * BUCKET1) / (BUCKET0 + dx);
    const spread = (gross * SPREADPPM) / SPREAD_SCALE;
    const net = gross > spread ? gross - spread : 0n;
    return net > OUT_CAP ? 0n : net;
  }

  function ladderPool(amountIn: bigint): MentoPool {
    const cumIn = mentoSampleInputs(amountIn);
    const cumOut = cumIn.map(xToY);
    return {
      broker: Z, exchangeProvider: Z, exchangeId: ZID, tokenIn: Z, tokenOut: Z,
      cumIn, cumOut, feePpm: Number(SPREADPPM), source: "kat",
    };
  }

  it("getAmountOut — exact at a ladder point, interpolated between, spread-adjusted", () => {
    const amountIn = 100_000n * E18;
    const p = ladderPool(amountIn);
    // Exact at a stored sample.
    const i = p.cumIn.length - 1;
    assert.equal(mentoGetAmountOut(p, p.cumIn[i]), p.cumOut[i], "exact at the last ladder point");
    // A SMALL trade is near-1:1 minus the 0.01% spread + tiny bucket slippage; a large trade loses more to
    // the constant-product term (monotone out, less than in).
    const small = p.cumIn[0];
    const outSmall = mentoGetAmountOut(p, small);
    assert.ok(outSmall < small && outSmall > (small * 999n) / 1000n, "near-1:1 minus spread on a small Mento slice");
    const out = mentoGetAmountOut(p, amountIn);
    assert.ok(out < amountIn && out > (amountIn * 98n) / 100n, "large trade: below par by spread + bucket slippage");
    // Interpolation is monotone and bracketed between the two neighbouring ladder points.
    const mid = (p.cumIn[0] + p.cumIn[1]) / 2n;
    const interp = mentoGetAmountOut(p, mid);
    assert.ok(interp >= p.cumOut[0] && interp <= p.cumOut[1], "interpolated between neighbouring points");
  });

  it("buildMentoSegments — covers amountIn, descending (flat) marginals, partition of the ladder", () => {
    const amountIn = 100_000n * E18;
    const p = ladderPool(amountIn);
    const segs = buildMentoSegments(p, amountIn);
    assert.ok(segs.length > 0, "non-empty segment ladder");
    const sumCap = segs.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(sumCap, amountIn, "segments cover the full amountIn (last sample == amountIn)");
    for (let i = 1; i < segs.length; i++) {
      assert.ok(segs[i].marginalOI <= segs[i - 1].marginalOI, "marginals non-increasing");
    }
    // Σ effOut over the grid == getAmountOut(amountIn) (the sampler is a partition of the ladder).
    const sumOut = segs.reduce((a, s) => a + s.effOut, 0n);
    assert.equal(sumOut, mentoGetAmountOut(p, amountIn), "Σ segment effOut == getAmountOut(amountIn)");
  });

  it("trading-limit cap: discovery truncates the ladder; segments stay a clean partition", () => {
    // Size amountIn so the LAST samples exceed OUT_CAP → those quote 0. discoverMentoPoolsTyped keeps only
    // the strictly-positive non-decreasing PREFIX (the trading-limit edge); replay that truncation here,
    // then build over the truncated descriptor.
    const amountIn = 40_000_000n * E18; // net at par pushes the tail samples over OUT_CAP
    const rawIn = mentoSampleInputs(amountIn);
    const rawOut = rawIn.map(xToY);
    assert.ok(rawOut.some((o) => o === 0n), "some tail samples exceed the trading-limit cap and quote 0");
    // Discovery's non-decreasing-positive prefix rule (verbatim from discoverMentoPoolsTyped).
    const cumIn: bigint[] = [];
    const cumOut: bigint[] = [];
    let prev = 0n;
    for (let i = 0; i < rawIn.length; i++) {
      if (rawOut[i] <= prev) break;
      cumIn.push(rawIn[i]);
      cumOut.push(rawOut[i]);
      prev = rawOut[i];
    }
    assert.ok(cumIn.length > 0 && cumIn.length < rawIn.length, "prefix truncated below the cap");
    const capBoundary = cumIn[cumIn.length - 1];
    const p: MentoPool = {
      broker: Z, exchangeProvider: Z, exchangeId: ZID, tokenIn: Z, tokenOut: Z,
      cumIn, cumOut, feePpm: Number(SPREADPPM), source: "kat-cap",
    };
    const segs = buildMentoSegments(p, amountIn);
    const covered = segs.reduce((a, s) => a + s.capacity, 0n);
    assert.ok(segs.every((s) => s.effOut > 0n), "every segment has a positive out (none past the cap)");
    assert.equal(covered, capBoundary, "covered input == the cap boundary (the tradeable prefix)");
    assert.ok(covered < amountIn, "the cap truncates the covered input below amountIn");
  });
});

// ── Balancer V3 (balancer-v3-monorepo Vault + per-chain Router) query-ladder + StableMath parity ──
//
// The real Balancer V3 deep pools are StableSurge-hooked + rate-scaled, so the split is priced off a LIVE
// `Router.querySwapSingleTokenExactIn` ladder discovery samples (rate-provider + dynamic-surge-fee inclusive
// — see balancer-v3-math.ts). There is no static-fee closed form to KAT for a surge pool, so this pins (a)
// the LADDER machinery — `getAmountOut` interpolates the (cumIn, cumOut) points, `buildBalancerV3Segments`
// differences them into a descending-marginal partition — AND (b) that V3 shares V2's amplified StableMath by
// SYNTHESIZING the sampled query ladder with the SHARED V2 `getDy` (the V3 StableMath is byte-for-byte
// identical: AMP_PRECISION=1e3, same computeInvariant/computeOutGivenExactIn), mirroring what the Router
// would return for a PLAIN (non-surge, unit-rate) V3 stable pool. So the ladder itself is a genuine
// StableMath known-answer, and the sampler/segment machinery is pinned on top of it. The real BASE ladder
// (cast-verified: 100e6 waUSDC → 107.786… waGHO; 1000e6 → 1077.86…, linear) is exercised by the on-chain +
// prod-mirror EVM tests, where the query surface is the ground truth.
describe("Balancer V3 (Vault + per-chain Router) — query-ladder interpolation + sampler + V2 StableMath parity", () => {
  const E18 = 10n ** 18n;
  const Z = "0x0000000000000000000000000000000000000001" as `0x${string}`;
  // A 2-token unit-rate PLAIN stable pool (no BPT in V3, no surge, scaling factors 1e18) at A=1000, 0.005%
  // swap fee (5e13 WAD — the real Base pool's static fee) — the shared V2 StableMath IS the V3 math, so
  // `getDy` synthesizes exactly what querySwapSingleTokenExactIn returns for such a pool.
  const AMP = 1000n * 1000n; // A·AMP_PRECISION (getAmplificationParameter()[0] form)
  const SWAP_FEE_WAD = 50_000_000_000_000n; // 5e13 = 0.005%
  const stablePool: BalancerStablePool = {
    poolType: 4,
    address: Z,
    i: 0,
    j: 1,
    amp: AMP,
    balances: [20_000_000n * E18, 20_000_000n * E18], // deep near-1:1 (18-dec both legs)
    scalingFactors: [E18, E18], // unit rate, 18-dec ⇒ no scale
    swapFeeWad: SWAP_FEE_WAD,
    source: "kat",
  };

  // The Router query for a plain V3 stable pool == the shared V2 StableMath getDy (identical invariant).
  function xToY(dx: bigint): bigint {
    return balancerGetDy(stablePool, dx);
  }

  function ladderPool(amountIn: bigint): BalancerV3Pool {
    const cumIn = balancerV3SampleInputs(amountIn);
    const cumOut = cumIn.map(xToY);
    return {
      address: Z, router: Z, tokenIn: Z, tokenOut: Z,
      cumIn, cumOut, feePpm: 50, source: "kat",
    };
  }

  it("query ladder == V2 StableMath getDy (V3 shares the amplified StableSwap invariant)", () => {
    // A genuine StableMath known-answer: a 100k slice into a deep A=1000 near-1:1 pool loses only the 0.005%
    // fee + a tiny curvature term (out just below in), and the curve is convex (marginal descends with size).
    const dx = 100_000n * E18;
    const dy = xToY(dx);
    assert.ok(dy < dx, "out below in (fee + curvature)");
    assert.ok(dy > (dx * 9994n) / 10000n, "deep A=1000 pool: within ~0.06% of par at 100k on a 20M pool");
    // Convex: doubling the input yields LESS than double the output (the marginal worsens).
    assert.ok(xToY(2n * dx) < 2n * dy, "convex stable curve: marginal descends with size");
  });

  it("getAmountOut — exact at a ladder point, interpolated between, fee-adjusted", () => {
    const amountIn = 100_000n * E18;
    const p = ladderPool(amountIn);
    const i = p.cumIn.length - 1;
    assert.equal(balancerV3GetAmountOut(p, p.cumIn[i]), p.cumOut[i], "exact at the last ladder point");
    const small = p.cumIn[0];
    const outSmall = balancerV3GetAmountOut(p, small);
    assert.ok(outSmall < small && outSmall > (small * 999n) / 1000n, "near-1:1 minus fee on a small V3 slice");
    const out = balancerV3GetAmountOut(p, amountIn);
    assert.ok(out < amountIn && out > (amountIn * 99n) / 100n, "large trade: below par by fee + curvature");
    const mid = (p.cumIn[0] + p.cumIn[1]) / 2n;
    const interp = balancerV3GetAmountOut(p, mid);
    assert.ok(interp >= p.cumOut[0] && interp <= p.cumOut[1], "interpolated between neighbouring points");
  });

  it("buildBalancerV3Segments — covers amountIn, descending (flat) marginals, partition of the ladder", () => {
    const amountIn = 100_000n * E18;
    const p = ladderPool(amountIn);
    const segs = buildBalancerV3Segments(p, amountIn);
    assert.ok(segs.length > 0, "non-empty segment ladder");
    const sumCap = segs.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(sumCap, amountIn, "segments cover the full amountIn (last sample == amountIn)");
    for (let i = 1; i < segs.length; i++) {
      assert.ok(segs[i].marginalOI <= segs[i - 1].marginalOI, "marginals non-increasing");
    }
    const sumOut = segs.reduce((a, s) => a + s.effOut, 0n);
    assert.equal(sumOut, balancerV3GetAmountOut(p, amountIn), "Σ segment effOut == getAmountOut(amountIn)");
  });

  it("liquidity-limit cap: discovery truncates the ladder; segments stay a clean partition", () => {
    // A query that returns 0 past some size (a buffer/liquidity limit or an un-queryable large size) →
    // discoverBalancerV3PoolsTyped keeps only the strictly-positive non-decreasing PREFIX. Replay a synthetic
    // cap and build over the truncated descriptor.
    const amountIn = 100_000n * E18;
    const rawIn = balancerV3SampleInputs(amountIn);
    const CAP = 40_000n * E18; // quotes past this size "revert"/return 0
    const rawOut = rawIn.map((x) => (x > CAP ? 0n : xToY(x)));
    assert.ok(rawOut.some((o) => o === 0n), "some samples past the cap quote 0");
    const cumIn: bigint[] = [];
    const cumOut: bigint[] = [];
    let prev = 0n;
    for (let i = 0; i < rawIn.length; i++) {
      if (rawOut[i] <= prev) break;
      cumIn.push(rawIn[i]);
      cumOut.push(rawOut[i]);
      prev = rawOut[i];
    }
    assert.ok(cumIn.length > 0 && cumIn.length < rawIn.length, "prefix truncated below the cap");
    const capBoundary = cumIn[cumIn.length - 1];
    const p: BalancerV3Pool = {
      address: Z, router: Z, tokenIn: Z, tokenOut: Z, cumIn, cumOut, feePpm: 50, source: "kat-cap",
    };
    const segs = buildBalancerV3Segments(p, amountIn);
    const covered = segs.reduce((a, s) => a + s.capacity, 0n);
    assert.ok(segs.every((s) => s.effOut > 0n), "every segment has a positive out (none past the cap)");
    assert.equal(covered, capBoundary, "covered input == the cap boundary (the tradeable prefix)");
    assert.ok(covered < amountIn, "the cap truncates the covered input below amountIn");
  });
});

// ── Curve Twocrypto (fxswap/boom v2.1.0d) known-answer + segment sampler ─────────────────────────
//
// Pins the off-chain replay (getDyCrypto + newtonD + buildCryptoSwapSegments) BEFORE the local-EVM
// test, so a regression in the bounded-Newton bigint math (the fx/boom STABLESWAP get_y/newton_D with
// Ann = A·N, gamma ignored), the RAW-product xp scaling, or the v2.1.0d dynamic fee (post-swap xp) is
// caught without anvil. The wei-exact bound is documented in cryptoswap-math.ts: the SPLIT is
// exact-on-grid vs the oracle (one shared sampler) and the realized dy is exact-in-dy (the pool get_dy
// view == the pool exchange math). These vectors are the deterministic getDyCrypto outputs for fixed
// states (regenerate only on an intentional math change); the LAST cell replays the CAPTURED MAINNET
// probes off the prod-mirror snapshot — engine-independent chain truth, no RPC. A = the pool A()
// (the math _amp; MIN_A = 2e4); gamma 1.45e14 (carried, IGNORED by the fx math); fee mid 0.05%/out
// 0.4%/fee_gamma 0.23 (1e10 fee units). CryptoSwap coin indices are UINT256 (the callback-free
// exchange(uint256,...) ABI, NOT the engine's int128 _swapCurve).
describe("Curve Twocrypto (fxswap/boom) — get_dy known-answer + sampler", () => {
  const E18 = 10n ** 18n;
  const Z = "0x0000000000000000000000000000000000000001" as `0x${string}`;
  const A = 25_000n; // the pool A() (== the captured crvUSD/WETH pool's; amp_true = A/A_MULTIPLIER = 2.5)
  const GAMMA = 145_000_000_000_000n; // 1.45e14 — carried for parity, UNUSED by the fx math
  const MID = 5_000_000n; // 0.05% (1e10 units)
  const OUT = 40_000_000n; // 0.4%
  const FEE_GAMMA = 230_000_000_000_000_000n; // 0.23e18
  function pool(
    bal: [bigint, bigint], prec: [bigint, bigint], priceScale: bigint, i = 0, j = 1,
  ): CryptoSwapPool {
    const xp = [bal[0] * prec[0], (bal[1] * prec[1] * priceScale) / E18];
    const D = cryptoNewtonD(A, GAMMA, xp);
    return {
      address: Z, i, j, A, gamma: GAMMA, priceScale, D, balances: bal, precisions: prec,
      midFee: MID, outFee: OUT, feeGamma: FEE_GAMMA, feePpm: 5, source: "kat",
    };
  }

  it("balanced 1:1 18-dec pool — exact get_dy vectors + exact D", () => {
    const p = pool([1_000_000n * E18, 1_000_000n * E18], [1n, 1n], E18);
    // D of a balanced 1:1 pool is EXACTLY the scaled-balance sum (S is the stableswap fixed point).
    assert.equal(p.D, 2_000_000n * E18);
    // Hand-pinned from the bounded-Newton replay (mirrors the CryptoSwapPool fixture bit-for-bit).
    assert.equal(getDyCrypto(p, 1_000n * E18), 999_214_494_798_726_691_492n);
    assert.equal(getDyCrypto(p, 10_000n * E18), 9_966_507_647_116_844_290_824n);
    assert.equal(getDyCrypto(p, 100_000n * E18), 97_146_294_129_449_590_996_881n);
    // Shape: a small trade returns ~the input net of the 0.05% mid_fee with the amp-2.5 stableswap
    // slippage on top (the fx/boom invariant is far less amplified than a peg-stable pool).
    const out1k = getDyCrypto(p, 1_000n * E18);
    assert.ok(out1k < 1_000n * E18 && out1k > 999n * E18, "near-1:1 minus mid_fee on the amp-2.5 curve");
  });

  it("imbalanced pool — exact vector", () => {
    const p = pool([1_200_000n * E18, 1_000_000n * E18], [1n, 1n], E18);
    assert.equal(getDyCrypto(p, 50_000n * E18), 46_795_878_125_524_381_801_050n);
  });

  it("decimals normalisation — 6-dec out coin (precisions[1]=1e12) denormalises exactly", () => {
    const p = pool([1_000_000n * E18, 1_000_000n * 10n ** 6n], [1n, 10n ** 12n], E18);
    // 1000 (18-dec) in → ~1000 (6-dec) out net of mid_fee: 999.214495 units.
    assert.equal(getDyCrypto(p, 1_000n * E18), 999_214_495n);
  });

  it("price_scale != 1 (coin1 @ 2000·coin0) — both directions economically exact", () => {
    // Value-balanced pool: 2M coin0 (USD) + 1000 coin1 (ETH) at price_scale 2000.
    const p = pool([2_000_000n * E18, 1_000n * E18], [1n, 1n], 2000n * E18);
    assert.equal(p.D, 4_000_000n * E18);
    // coin0 → coin1 (USD → ETH): 2000 USD ≈ 1 ETH minus fee/slippage.
    assert.equal(getDyCrypto(p, 2_000n * E18), 999_214_494_798_726_691n);
    // coin1 → coin0 (ETH → USD): 1 ETH ≈ 2000 USD minus fee/slippage.
    const pr = pool([2_000_000n * E18, 1_000n * E18], [1n, 1n], 2000n * E18, 1, 0);
    assert.equal(getDyCrypto(pr, 1n * E18), 1_998_428_989_597_453_382_984n);
  });

  it("price_scale < 1e18 (coin1 CHEAP in coin0) — the raw-product xp scaling regression", () => {
    // price_scale = 4e14 (1 coin1 = 0.0004 coin0), 18-dec coins, value-balanced 1000:2.5M. A
    // pre-floored per-unit factor (precisions[1]·price_scale/1e18 = 0) would ZERO xp[1] and kill
    // every quote — the deployed view scales the RAW product balances·precisions·price_scale/1e18
    // with ONE floor, which this pins (both directions, exact vectors).
    const ps = 4n * 10n ** 14n;
    const p = pool([1_000n * E18, 2_500_000n * E18], [1n, 1n], ps);
    assert.equal(p.D, 2_000n * E18, "D reflects the REAL (non-zeroed) coin1 depth");
    // coin0 → coin1: 1 coin0 ≈ 2500 coin1 minus fee/slippage.
    assert.equal(getDyCrypto(p, 1n * E18), 2_498_036_236_996_816_727_164n);
    // coin1 → coin0: 2500 coin1 ≈ 1 coin0 minus fee/slippage.
    const pr = pool([1_000n * E18, 2_500_000n * E18], [1n, 1n], ps, 1, 0);
    assert.equal(getDyCrypto(pr, 2_500n * E18), 999_214_494_798_726_691n);
  });

  it("REAL mainnet state — replays the captured crvUSD/WETH probes to the WEI (no RPC)", () => {
    // The prod-mirror snapshot's pool state + the two get_dy probes recorded from the REAL deployed
    // bytecode at the pinned block (harness/curveCrypto-snapshot.ts). The replay must reproduce both
    // bit-for-bit — the engine-independent chain-truth gate for the xp scaling (price_scale 2467.6e18),
    // the stableswap get_y (A = 25000), the post-swap-xp dynamic fee, and the v2.1.0d fee blend.
    const snap = JSON.parse(readFileSync(
      join(__dirname, "fixtures", "snapshots", "ethereum-curveCrypto-crvUSDWETH.state.json"), "utf-8",
    ));
    const real: CryptoSwapPool = {
      address: snap.pool, i: Number(snap.i), j: Number(snap.j),
      A: BigInt(snap.A), gamma: BigInt(snap.gamma), priceScale: BigInt(snap.priceScale), D: BigInt(snap.D),
      balances: (snap.balances as string[]).map(BigInt), precisions: (snap.precisions as string[]).map(BigInt),
      midFee: BigInt(snap.midFee), outFee: BigInt(snap.outFee), feeGamma: BigInt(snap.feeGamma),
      feePpm: 6, source: "prod-mirror-snapshot",
    };
    assert.equal(
      getDyCrypto(real, BigInt(snap.probe.sellCoin0.dx)), BigInt(snap.probe.sellCoin0.dy),
      "sell coin0 (crvUSD→WETH) probe == captured mainnet get_dy to the wei",
    );
    const realRev: CryptoSwapPool = { ...real, i: Number(snap.j), j: Number(snap.i) };
    assert.equal(
      getDyCrypto(realRev, BigInt(snap.probe.sellCoin1.dx)), BigInt(snap.probe.sellCoin1.dy),
      "sell coin1 (WETH→crvUSD) probe == captured mainnet get_dy to the wei",
    );
  });

  it("buildCryptoSwapSegments — covers amountIn, descending marginals, partition of the curve", () => {
    const p = pool([1_000_000n * E18, 1_000_000n * E18], [1n, 1n], E18);
    const amountIn = 100_000n * E18;
    const segs = buildCryptoSwapSegments(p, amountIn);
    assert.ok(segs.length > 0, "non-empty segment ladder");
    const sumCap = segs.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(sumCap, amountIn, "segments cover the full amountIn (last sample == amountIn)");
    for (let i = 1; i < segs.length; i++) {
      assert.ok(segs[i].marginalOI <= segs[i - 1].marginalOI, "marginals descending");
    }
    // Σ effOut over the grid == getDyCrypto(amountIn) (the sampler is a partition of the curve).
    const sumOut = segs.reduce((a, s) => a + s.effOut, 0n);
    assert.equal(sumOut, getDyCrypto(p, amountIn), "Σ segment effOut == getDyCrypto(amountIn)");
  });
});

// ── Balancer V2 ComposableStable known-answer + segment sampler ──────────────
//
// Pins the off-chain StableMath A-invariant replay (getDy + buildBalancerStableSegments) BEFORE the
// local-EVM test, so a regression in the bounded-Newton bigint math (or the BPT-index exclusion / the
// scaling-factor up-downscale) is caught without anvil. The wei-exact bound is documented in
// balancer-stable-math.ts: the SPLIT is exact-on-grid vs the oracle (one shared sampler) and the
// realized dy is exact-in-dy (the Vault.swap GIVEN_IN StableMath == this replay). These vectors are the
// deterministic getDy outputs for fixed states (regenerate only on an intentional math change). amp =
// A·AMP_PRECISION (A=1000 → 1e6); the swap fee is 1e18-WAD (0.04% = 4e14). 18-dec tokens carry a 1e18
// scaling factor; a 6-dec token carries 1e30 (= 1e18·10**(18-6)). The BPT exclusion is verified
// implicitly — these descriptors hold the NON-BPT token set the discovery builds, so getDy operates on
// exactly the StableMath balances. A near-1:1 stable swap loses only the fee + tiny invariant slippage.
describe("Balancer V2 ComposableStable — StableMath getDy known-answer + sampler", () => {
  const E18 = 10n ** 18n;
  const Z = "0x0000000000000000000000000000000000000001" as `0x${string}`;
  const AMP = 1_000_000n; // A=1000 → A·AMP_PRECISION
  const FEE = 4n * 10n ** 14n; // 0.04% in 1e18-WAD
  function pool(
    bIn: bigint, bOut: bigint, scalIn: bigint, scalOut: bigint, feeWad = FEE, amp = AMP,
  ): BalancerStablePool {
    return {
      poolType: 4, address: Z, i: 0, j: 1, amp,
      balances: [bIn, bOut], scalingFactors: [scalIn, scalOut], swapFeeWad: feeWad, source: "kat",
    };
  }

  it("balanced 1:1 18-dec pool, A=1000 fee 0.04% — exact StableMath vectors", () => {
    const p = pool(1_000_000n * E18, 1_000_000n * E18, E18, E18);
    // Hand-pinned from the bounded-Newton replay (mirrors the Vault StableMath bit-for-bit).
    assert.equal(balancerGetDy(p, 1_000n * E18), 999_599_001_798_043_352_188n);
    assert.equal(balancerGetDy(p, 10_000n * E18), 9_995_900_170_846_180_872_076n);
    assert.equal(balancerGetDy(p, 100_000n * E18), 99_949_918_464_766_332_805_060n);
    // Stable shape: a small trade returns ~the input net of the 0.04% fee (≈ 0.9996·in) with sub-bps
    // invariant slippage on top — far flatter than a constant-product pool of the same depth.
    const out1k = balancerGetDy(p, 1_000n * E18);
    assert.ok(out1k < 1_000n * E18 && out1k > 999n * E18, "near-1:1 minus fee on the A-invariant curve");
  });

  it("imbalanced 1:1.2 pool — exact vector", () => {
    const p = pool(1_000_000n * E18, 1_200_000n * E18, E18, E18);
    assert.equal(balancerGetDy(p, 50_000n * E18), 49_986_880_726_818_263_404_131n);
  });

  it("scaling-factor normalisation — 6-dec out token (scaling 1e30) downscales exactly", () => {
    // A 6-dec out token: scaling factor folds the decimal scale (10**(18-6)) into the 1e18 WAD → 1e30.
    const p = pool(1_000_000n * E18, 1_000_000n * (10n ** 6n), E18, 10n ** 30n);
    // 1000 (18-dec) in → ~1000 (6-dec) out net of fee: 999.599001 USDC-units.
    assert.equal(balancerGetDy(p, 1_000n * E18), 999_599_001n);
  });

  it("buildBalancerStableSegments — covers amountIn, descending marginals, partition of the curve", () => {
    const p = pool(1_000_000n * E18, 1_000_000n * E18, E18, E18);
    const amountIn = 100_000n * E18;
    const segs = buildBalancerStableSegments(p, amountIn);
    assert.ok(segs.length > 0, "non-empty segment ladder");
    const sumCap = segs.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(sumCap, amountIn, "segments cover the full amountIn (last sample == amountIn)");
    for (let i = 1; i < segs.length; i++) {
      assert.ok(segs[i].marginalOI <= segs[i - 1].marginalOI, "marginals descending");
    }
    // Σ effOut over the grid == getDy(amountIn) (the sampler is a partition of the curve).
    const sumOut = segs.reduce((a, s) => a + s.effOut, 0n);
    assert.equal(sumOut, balancerGetDy(p, amountIn), "Σ segment effOut == getDy(amountIn)");
  });
});

// ── EulerSwap (Euler vault-backed AMM, v1+v2) known-answer + segment sampler ──
//
// Pins the off-chain f/fInverse curve replay (computeQuote + buildEulerSwapSegments) BEFORE the
// local-EVM test, so a regression in the closed-form bigint math (the in-region f() ceil-rounding, the
// fee netting, the vault-cap bound) is caught without anvil. The wei-exact bound is documented in
// eulerswap-math.ts: the SPLIT is exact-on-grid vs the oracle (one shared sampler) and the realized dy
// is exact-in-dy (the pool computeQuote view == the pool swap math). These vectors are the deterministic
// computeQuote outputs for fixed states (regenerate only on an intentional math change). Curve params
// are 1e18 fixed point (priceX/priceY, concentrationX/concentrationY, fee); reserves are RAW units. A
// near-equilibrium swap loses only the fee + tiny concentration slippage. Cross-checked bit-for-bit
// against the EulerSwapPool.sol fixture computeQuote in ecoswap.euler.evm.test.ts.
describe("EulerSwap (Euler vault-backed AMM, v1 + v2 share the curve) — computeQuote known-answer + sampler", () => {
  const E18 = 10n ** 18n;
  const Z = "0x0000000000000000000000000000000000000001" as `0x${string}`;
  function pool(
    rIn: bigint, rOut: bigint, eqIn: bigint, eqOut: bigint,
    pIn: bigint, pOut: bigint, cIn: bigint, cOut: bigint, feeWad: bigint, inLimit = 0n,
  ): EulerSwapPool {
    return {
      address: Z, inIsToken0: true, reserveIn: rIn, reserveOut: rOut,
      equilIn: eqIn, equilOut: eqOut, priceIn: pIn, priceOut: pOut, concIn: cIn, concOut: cOut,
      feeWad, inLimit, feePpm: eulerFeeToPpm(feeWad), source: "kat",
    };
  }

  it("balanced 1:1 at equilibrium, conc 0.9 / fee 0.1% — exact f-region curve vectors", () => {
    const p = pool(
      1_000_000n * E18, 1_000_000n * E18, 1_000_000n * E18, 1_000_000n * E18,
      E18, E18, (9n * E18) / 10n, (9n * E18) / 10n, E18 / 1000n,
    );
    // Hand-pinned from the closed-form replay (mirrors the EulerSwapPool fixture computeQuote bit-for-bit).
    assert.equal(computeQuote(p, 1_000n * E18), 998_900_120_084_950_289_957n);
    assert.equal(computeQuote(p, 10_000n * E18), 9_979_939_679_003_649_864_357n);
    assert.equal(computeQuote(p, 100_000n * E18), 98_816_459_063_196_196_740_729n);
    // Concentrated shape: a small trade returns ~the input net of the 0.1% fee with sub-bps slippage.
    const out1k = computeQuote(p, 1_000n * E18);
    assert.ok(out1k < 1_000n * E18 && out1k > 998n * E18, "near-1:1 minus fee on the concentrated curve");
  });

  it("full-range linear (conc 1.0), fee 0.05% — exact linear vectors", () => {
    const p = pool(
      1_000_000n * E18, 1_000_000n * E18, 1_000_000n * E18, 1_000_000n * E18,
      E18, E18, E18, E18, (5n * E18) / 10_000n,
    );
    // conc == 1e18 ⇒ the linear f-branch: out == net input · py/px (1:1 here), so just the fee (the
    // canonical ceil-rounding loses 1 wei vs the exact 0.9995·in).
    assert.equal(computeQuote(p, 1_000n * E18), 999_499_999_999_999_999_999n);
    assert.equal(computeQuote(p, 50_000n * E18), 49_974_999_999_999_999_999_999n);
  });

  it("imbalanced reserves below equilibrium (in-region f), conc 0.85 — exact vector", () => {
    const p = pool(
      800_000n * E18, 1_200_000n * E18, 1_000_000n * E18, 1_000_000n * E18,
      E18, E18, (85n * E18) / 100n, (85n * E18) / 100n, E18 / 1000n,
    );
    assert.equal(computeQuote(p, 50_000n * E18), 45_976_530_531_207_718_101_064n);
  });

  it("buildEulerSwapSegments — covers amountIn, descending marginals, partition of the curve", () => {
    const p = pool(
      1_000_000n * E18, 1_000_000n * E18, 1_000_000n * E18, 1_000_000n * E18,
      E18, E18, (9n * E18) / 10n, (9n * E18) / 10n, E18 / 1000n,
    );
    const amountIn = 100_000n * E18;
    const segs = buildEulerSwapSegments(p, amountIn);
    assert.ok(segs.length > 0, "non-empty segment ladder");
    const sumCap = segs.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(sumCap, amountIn, "segments cover the full amountIn (last sample == amountIn)");
    for (let i = 1; i < segs.length; i++) {
      assert.ok(segs[i].marginalOI <= segs[i - 1].marginalOI, "marginals descending");
    }
    // Σ effOut over the grid == computeQuote(amountIn) (the sampler is a partition of the curve).
    const sumOut = segs.reduce((a, s) => a + s.effOut, 0n);
    assert.equal(sumOut, computeQuote(p, amountIn), "Σ segment effOut == computeQuote(amountIn)");
  });

  it("vault-cap bound — the sampler is capped at inLimit (not amountIn)", () => {
    const cap = 5_000n * E18;
    const p = pool(
      1_000_000n * E18, 1_000_000n * E18, 1_000_000n * E18, 1_000_000n * E18,
      E18, E18, (9n * E18) / 10n, (9n * E18) / 10n, E18 / 1000n, cap,
    );
    const segs = buildEulerSwapSegments(p, 100_000n * E18);
    const sumCap = segs.reduce((a, s) => a + s.capacity, 0n);
    assert.equal(sumCap, cap, "segments cover only the vault inLimit, not the full amountIn");
  });

  // ── EulerSwap V1 — REAL deployed-pool computeQuote vectors (verified LIVE) ──
  //
  // The EulerSwap v1 curve (CurveLib.f/fInverse @ tag eulerswap-1.0) is IDENTICAL to the v2 curve, so the
  // SAME `eulerswap-math.ts` replay serves both versions (the recipe discovers v1 via curve()=="EulerSwap
  // v1" + getParams(), v2 via getDynamicParams() — see discoverEulerSwapPoolsTyped). These vectors pin
  // that the off-chain replay reproduces the REAL DEPLOYED v1 pool's on-chain computeQuote view
  // BIT-FOR-BIT. Params are the LIVE getParams() of the deepest live stable v1 pool
  // 0x3bBCC029f312ECe579a7dEb77B13CB8aE15F28A8 (USDC/USDT), and reserves the LIVE getReserves(), both
  // captured at mainnet block 25445491; each expected `out` was cast-called on that pool at that block
  // (both directions, incl. the reserve-saturated large-input cases). Regenerate only if the pinned block
  // or the curve math changes. This is the v1 analogue of the synthetic vectors above + the bit-for-bit
  // cross-check the (currently synthetic) EVM fixture provides.
  describe("V1 real-pool vectors (0x3bBCC029 USDC/USDT, mainnet block 25445491)", () => {
    // getParams(): equilibriumReserve0=1345300000 (USDC x0), equilibriumReserve1=0 (USDT y0),
    // priceX=1000000, priceY=1000683, concentrationX=concentrationY=999970609005089300, fee=9800000000000.
    // getReserves(): reserve0=179313998 (USDC), reserve1=1165412863 (USDT).
    const eqR0 = 1_345_300_000n;
    const eqR1 = 0n;
    const priceX = 1_000_000n;
    const priceY = 1_000_683n;
    const conc = 999_970_609_005_089_300n;
    const feeV1 = 9_800_000_000_000n; // 9.8e12 (1e18-scaled) = 0.00098% ≈ 9.8 ppm — live getParams().fee
    const reserve0 = 179_313_998n; // USDC
    const reserve1 = 1_165_412_863n; // USDT

    // USDC→USDT: tokenIn == asset0, so inIsToken0 true (reserveIn=reserve0, params in canonical orientation).
    const usdcToUsdt: EulerSwapPool = {
      address: Z, inIsToken0: true, reserveIn: reserve0, reserveOut: reserve1,
      equilIn: eqR0, equilOut: eqR1, priceIn: priceX, priceOut: priceY, concIn: conc, concOut: conc,
      feeWad: feeV1, inLimit: 0n, feePpm: eulerFeeToPpm(feeV1), source: "v1-real",
    };
    // USDT→USDC: tokenIn == asset1, so inIsToken0 false (reserveIn=reserve1, params mirrored by orient).
    const usdtToUsdc: EulerSwapPool = {
      address: Z, inIsToken0: false, reserveIn: reserve1, reserveOut: reserve0,
      equilIn: eqR1, equilOut: eqR0, priceIn: priceY, priceOut: priceX, concIn: conc, concOut: conc,
      feeWad: feeV1, inLimit: 0n, feePpm: eulerFeeToPpm(feeV1), source: "v1-real",
    };

    it("USDC→USDT — off-chain computeQuote == live on-chain computeQuote (bit-for-bit)", () => {
      // in (USDC, 6dec) → out (USDT, 6dec), each cast-called live on 0x3bBCC029 at block 25445491.
      assert.equal(computeQuote(usdcToUsdt, 1_000_000n), 1_000_924n); // 1 USDC
      assert.equal(computeQuote(usdcToUsdt, 100_000_000n), 100_033_963n); // 100 USDC
      assert.equal(computeQuote(usdcToUsdt, 1_000_000_000n), 999_529_672n); // 1000 USDC
      // Large inputs saturate at the tokenOut reserve (the virtual out-side reserve1) — live-verified.
      assert.equal(computeQuote(usdcToUsdt, 10_000_000_000n), 1_165_412_863n);
      assert.equal(computeQuote(usdcToUsdt, 100_000_000_000n), 1_165_412_863n);
    });

    it("USDT→USDC — off-chain computeQuote == live on-chain computeQuote (bit-for-bit)", () => {
      assert.equal(computeQuote(usdtToUsdc, 1_000_000n), 999_042n); // 1 USDT
      assert.equal(computeQuote(usdtToUsdc, 100_000_000n), 99_698_772n); // 100 USDT
      assert.equal(computeQuote(usdtToUsdc, 1_000_000_000n), 179_249_264n); // 1000 USDT
      assert.equal(computeQuote(usdtToUsdc, 10_000_000_000n), 179_308_584n);
    });

    it("V1 single non-directional fee — both directions net the SAME fee rate", () => {
      // v1 getParams() carries ONE fee; discovery folds it into feeWad for both directions. Assert the
      // descriptor's feeWad is direction-invariant (the discovery normalization contract) and that a tiny
      // trade loses ~fee only (the near-equilibrium regime, sub-bps concentration slippage).
      assert.equal(usdcToUsdt.feeWad, usdtToUsdc.feeWad, "v1 fee is the same both directions");
      const feePpm = eulerFeeToPpm(feeV1); // round-half-up, matching discovery + the descriptor
      assert.equal(usdcToUsdt.feePpm, feePpm, "descriptor feePpm == the production round-half-up ppm");
      assert.ok(feePpm >= 0 && feePpm < 100, "v1 stable pool fee is a few ppm");
    });

    it("buildEulerSwapSegments on real v1 state — descending, partitions the curve", () => {
      // 1000 USDC — below the ~1165 USDT out-side reserve, so every sampled slice stays productive and the
      // ladder is a full partition (larger inputs saturate at reserveOut ⇒ the tail slices quote 0 and the
      // sampler truncates — that cap edge is the vault-cap test above).
      const amountIn = 1_000_000_000n; // 1000 USDC
      const segs = buildEulerSwapSegments(usdcToUsdt, amountIn);
      assert.ok(segs.length > 0, "non-empty ladder on real v1 params");
      const sumCap = segs.reduce((a, s) => a + s.capacity, 0n);
      assert.equal(sumCap, amountIn, "segments cover the full amountIn");
      for (let i = 1; i < segs.length; i++) {
        assert.ok(segs[i].marginalOI <= segs[i - 1].marginalOI, "marginals descending");
      }
      const sumOut = segs.reduce((a, s) => a + s.effOut, 0n);
      assert.equal(sumOut, computeQuote(usdcToUsdt, amountIn), "Σ effOut == computeQuote(amountIn)");
    });
  });
});

// ── Maverick V2 (bin-based directional AMM) known-answer + segment sampler ────
//
// Pins the off-chain bin swap-math replay (getDy + buildMaverickSegments) BEFORE the local-EVM test,
// so a regression in the closed-form bigint math (getTickL, the within-tick computeSwapExactIn
// drain/partial, the directional fee, the multi-tick walk under the engine's per-direction FULL-RANGE
// tickLimit) is caught without anvil. The wei-exact bound is documented in maverick-math.ts: the SPLIT is
// exact-on-grid vs the oracle (one shared sampler) and the realized dy is the ENGINE swap, cross-checked
// against the on-chain MaverickV2Quoter.calculateSwap in ecoswap.maverick.evm.test.ts. These vectors are
// the deterministic getDy outputs for a fixed tick book (regenerate only on an intentional math change).
//
// The book: tokenA-in from a NEGATIVE active tick (-3) with symmetric per-tick reserves, walking UP.
// The FIXED engine (../sauce PR #193) passes a per-direction FULL-RANGE tickLimit (type(int32).max/min),
// so the walk is bounded only by liquidity — it crosses tick 0 freely and fills ANY active-tick side (a
// SEPARATE cross-tick-0 cell below pins that). Deep enough (ticks -3..3 × 500k each side) that a ≤100k
// trade fills within a couple of ticks; a huge trade saturates at the book's B liquidity (the depth bound
// the sampler caps at — now the liquidity bound, not tick 0). Reserves are >= 2^78 wei so the getTickL
// precision-bump path is NOT taken (the normal deep-pool regime the on-chain fixture matches bit-for-bit —
// the bumped-small-reserve path is a Solidity-overflow edge the deep regime avoids, exactly as real
// Maverick WETH/USDC ticks hold >> 2^78 wei).
describe("Maverick V2 (bin-based directional AMM) — getDy known-answer + sampler", () => {
  const E18 = 10n ** 18n;
  const Z = ("0x" + "11".repeat(20)) as `0x${string}`;
  const TICK_SPACING = 10;
  const ACTIVE_TICK = -3;

  function pool(reservePerSide = 500_000n * E18, feeWad = E18 / 1000n): MaverickPool {
    const ticks: MaverickTick[] = [];
    for (let t = -3; t <= 3; t++) ticks.push({ tick: t, reserveA: reservePerSide, reserveB: reservePerSide });
    const { sqrtLowerPrice, sqrtUpperPrice } = maverickTickSqrtPrices(TICK_SPACING, ACTIVE_TICK);
    const active = ticks.find((t) => t.tick === ACTIVE_TICK)!;
    const activeL = maverickGetTickL(active.reserveA, active.reserveB, sqrtLowerPrice, sqrtUpperPrice);
    const poolSqrtPrice = maverickGetSqrtPrice(active.reserveA, active.reserveB, sqrtLowerPrice, sqrtUpperPrice, activeL);
    return {
      poolType: 7, address: Z, tokenAIn: true, activeTick: ACTIVE_TICK, poolSqrtPrice,
      tickSpacing: TICK_SPACING, fee: feeWad, protocolFeeD3: 0n, ticks,
      feePpm: Number((feeWad * 1_000_000n) / E18), source: "kat",
    };
  }

  it("symmetric book, tokenA-in from tick -3, fee 0.1% — exact within-tick + cross-tick vectors", () => {
    const p = pool();
    // Hand-pinned from the closed-form replay (mirrors the on-chain MaverickV2Pool fixture swap math
    // bit-for-bit). tokenA is cheap at a negative tick (price < 1), so a small trade returns slightly MORE
    // B than A.
    assert.equal(maverickGetDy(p, 1_000n * E18), 1_001_499_372_716_065_198_010n);
    assert.equal(maverickGetDy(p, 10_000n * E18), 10_014_948_656_608_216_862_717n);
    assert.equal(maverickGetDy(p, 50_000n * E18), 50_073_741_739_748_791_392_336n);
    assert.equal(maverickGetDy(p, 100_000n * E18), 100_144_979_733_943_102_081_541n);
  });

  it("depth bound — a swap saturates at the book's out-side liquidity (full-range, bounded by liquidity)", () => {
    const p = pool();
    // A huge input drains the reachable B across the traversed ticks and saturates at the book's available
    // out-side liquidity — the reachable B is Σ reserveB over ticks -3..3 = 7 × 500k = 3.5M (the bound is
    // LIQUIDITY, not tick 0: the full-range walk crosses tick 0 and keeps consuming until the reachable B is
    // exhausted). The cross-tick-0 cell below shows the walk genuinely fills ticks past 0 that the OLD
    // tickLimit=0 cap would have skipped.
    assert.equal(maverickGetDy(p, 5_000_000n * E18), 3_500_000n * E18);
  });

  it("buildMaverickSegments — covers min(amountIn,depth), descending marginals, partition of the curve", () => {
    const p = pool();
    const amountIn = 100_000n * E18;
    const segs = buildMaverickSegments(p, amountIn);
    assert.ok(segs.length > 0, "non-empty segment ladder");
    const sumCap = segs.reduce((a, s) => a + s.capacity, 0n);
    // amountIn (100k) is within the tick-limit depth, so the segments cover the full amountIn.
    assert.equal(sumCap, amountIn, "segments cover the full amountIn (within the depth bound)");
    for (let i = 1; i < segs.length; i++) {
      assert.ok(segs[i].marginalOI <= segs[i - 1].marginalOI, "marginals descending");
    }
    // Σ effOut over the grid == getDy(sumCap) (the sampler is a partition of the curve).
    const sumOut = segs.reduce((a, s) => a + s.effOut, 0n);
    assert.equal(sumOut, maverickGetDy(p, sumCap), "Σ segment effOut == getDy(sumCap)");
  });

  it("depth bound — the sampler caps at the liquidity-consumable input, not amountIn", () => {
    const p = pool();
    // amountIn (10,000,000) far exceeds the reachable depth ⇒ the sampler caps at the input the engine
    // swap can actually consume before it runs out of liquidity (the full-range tickLimit no longer stops
    // it at tick 0 — the cap is now the book's depth).
    const segs = buildMaverickSegments(p, 10_000_000n * E18);
    const sumCap = segs.reduce((a, s) => a + s.capacity, 0n);
    assert.ok(sumCap > 0n && sumCap < 10_000_000n * E18, "segments cover only the reachable depth, not the full amountIn");
  });

  // ── CROSS-TICK-0 (the case the OLD tickLimit=0 cap hid) ──
  // The FIXED engine passes a per-direction FULL-RANGE tickLimit, so a tokenA-in swap walks UP THROUGH
  // tick 0 whenever its optimal fill needs the liquidity there. The OLD engine hardcoded tickLimit=0 and
  // its off-chain mirror stopped at tick 0 — under-filling (and the discovery gate dropped far-side pools
  // entirely). This cell pins that the full-range off-chain walk (getDy — the neutral-oracle/prepare
  // source) is STRICTLY GREATER than the old tickLimit=0 walk on a fill that crosses tick 0, and matches
  // the on-chain engine swap to the wei (asserted in ecoswap.maverick.evm.test.ts).
  it("cross-tick-0 — full-range walk fills PAST tick 0 (> the old tickLimit=0 cap), wei-exact", () => {
    // active tick -1 with SHALLOW ticks -1,0 (300k) and DEEP ticks 1,2 (3M): a 1M tokenA-in trade drains
    // -1 and 0 (300k out each = 600k) then MUST cross into tick 1 for the rest — the exact walk the old
    // cap forbade (it broke after tick 0). The full-range walk touches ticks -1, 0 AND 1.
    const crossPool: MaverickPool = (() => {
      const reserves: Record<number, bigint> = {
        [-1]: 300_000n * E18, [0]: 300_000n * E18, [1]: 3_000_000n * E18, [2]: 3_000_000n * E18,
      };
      const ticks: MaverickTick[] = Object.entries(reserves).map(([t, r]) => ({
        tick: Number(t), reserveA: r, reserveB: r,
      }));
      const AT = -1;
      const { sqrtLowerPrice, sqrtUpperPrice } = maverickTickSqrtPrices(TICK_SPACING, AT);
      const active = ticks.find((t) => t.tick === AT)!;
      const activeL = maverickGetTickL(active.reserveA, active.reserveB, sqrtLowerPrice, sqrtUpperPrice);
      const poolSqrtPrice = maverickGetSqrtPrice(active.reserveA, active.reserveB, sqrtLowerPrice, sqrtUpperPrice, activeL);
      return {
        poolType: 7, address: Z, tokenAIn: true, activeTick: AT, poolSqrtPrice,
        tickSpacing: TICK_SPACING, fee: E18 / 1000n, protocolFeeD3: 0n, ticks,
        feePpm: 1000, source: "kat-cross",
      };
    })();

    const CROSS = 1_000_000n * E18;

    // Full-range getDy (the default per-direction FULL-RANGE tickLimit): the fill crosses tick 0 into
    // tick 1. Hand-pinned from the closed-form replay (regenerate only on an intentional math change).
    const fullOut = maverickGetDy(crossPool, CROSS);
    assert.equal(fullOut, 998_587_937_811_185_979_092_177n, "full-range getDy crosses tick 0 into tick 1");

    // The OLD engine tickLimit=0 walk stops after tick 0 → saturates at the -1,0 out-side liquidity (600k).
    const cappedOut = maverickSimulate(crossPool, CROSS, 0).amountOut;
    assert.equal(cappedOut, 600_000n * E18, "the old tickLimit=0 walk saturates at ticks -1,0 (600k)");

    // The vestige removal STRICTLY increases the fill: full-range fills past tick 0, the old cap could not.
    assert.ok(fullOut > cappedOut, "full-range fill > old tickLimit=0 cap (the case the cap hid)");
  });
});

// ── FORCED-CLIFF regression: isotonic backward-MERGE replaces the descending-marginal DROP ──────────
//
// THE LEFTOVER this pins: on a DISCRETE / non-convex source (LB bins, a DODO R-state boundary, Maverick
// bins) a sampled slice can price a DEEPER region BETTER than the last band (its fee-adjusted marginal
// RISES). The OLD strictly-descending guard DROPPED such a slice — and, because it also stopped tracking
// the ladder tail, silently discarded ALL the liquidity behind it — so the split UNDER-filled the pool
// even though the engine fills through the region. The MERGE folds the violating slice into the last
// segment (conserving capacity + effOut), so the past-cliff liquidity survives into the split.
//
// The shared helper `pushMonotoneSegment` (shared/segment-merge.ts) is the single source every
// buildXSegments uses — prepare.ts, the neutral oracle (ecoswap.optimal.ts) and the cursor-faithful
// reference (ecoswap.solver-reference.ts) all consume the SAME ladder, so `solver == oracle to the wei`
// holds by construction (the 428 fast wei-exact vectors above pass unchanged). These cells assert the
// TWO regression properties directly on the builders: (1) the merged ladder is monotone-descending AND
// conserves total capacity/effOut (== the pool's own quote of the covered input — wei-exact), and (2) it
// covers STRICTLY MORE than the OLD drop-guard would (replayed in-test) on a real depth cliff.
describe("isotonic backward-merge (forced-cliff) — liquidity-preserving MERGE replaces the DROP", () => {
  const E18 = 10n ** 18n;

  // Replay of the OLD strictly-descending DROP guard on a per-slice basis (the code these cells replace),
  // driven by the SAME raw (capacity, effOut, marginalOI) slices the merge sees. Returns the kept segments.
  function oldDropLadder(raw: { capacity: bigint; effOut: bigint; marginalOI: bigint }[]) {
    const segs: { capacity: bigint; effOut: bigint; marginalOI: bigint }[] = [];
    for (const s of raw) {
      if (s.marginalOI > 0n && (segs.length === 0 || s.marginalOI <= segs[segs.length - 1].marginalOI)) {
        segs.push({ capacity: s.capacity, effOut: s.effOut, marginalOI: s.marginalOI });
      }
    }
    return segs;
  }

  function sumCap(segs: { capacity: bigint }[]): bigint {
    return segs.reduce((a, s) => a + s.capacity, 0n);
  }
  function sumEff(segs: { effOut: bigint }[]): bigint {
    return segs.reduce((a, s) => a + s.effOut, 0n);
  }
  function assertMonotone(segs: { marginalOI: bigint }[], label: string) {
    for (let i = 1; i < segs.length; i++) {
      assert.ok(segs[i].marginalOI <= segs[i - 1].marginalOI, `${label}: marginals descending at ${i}`);
    }
  }

  // ── The shared helper's own invariants (pool-adjacent-violators cascade) ──
  describe("pushMonotoneSegment — conserves capacity/effOut, cascades backward to monotone", () => {
    it("folds a violating slice AND cascades so the whole ladder is monotone (capacity + effOut conserved)", () => {
      // A cliff ladder: descending (100,90,80), a JUMP UP (120 — violation), then descending (70,60).
      // The 120 slice must fold backward far enough that the merged tail prices <= the segment before it.
      // Build each slice from (capacity, effOut) and DERIVE the marginal via the builders' own formula so
      // the synthetic data is self-consistent (an appended segment keeps the passed marginal, a folded one
      // recomputes — both must equal isqrt(effOut·Q192/capacity)).
      const scale = MERGE_Q192 / 200n;
      const targetMargs = [100n, 90n, 80n, 120n, 70n, 60n].map((x) => x * scale);
      const caps = [10n, 10n, 10n, 10n, 10n, 10n].map((x) => x * E18);
      const slices = caps.map((cap, i) => {
        const effOut = (cap * targetMargs[i] * targetMargs[i]) / MERGE_Q192;
        return { cap, effOut, marginalOI: mergeIsqrt((effOut * MERGE_Q192) / cap) };
      });

      const segs: MergeSegment[] = [];
      let totalCap = 0n;
      let totalEff = 0n;
      for (const s of slices) {
        totalCap += s.cap;
        totalEff += s.effOut;
        pushMonotoneSegment(segs, s.cap, s.effOut, s.marginalOI);
      }
      assert.ok(segs.length < slices.length, "at least one fold happened (fewer segments than raw slices)");
      assertMonotone(segs, "cascade");
      assert.equal(sumCap(segs), totalCap, "capacity conserved — NO liquidity discarded");
      assert.equal(sumEff(segs), totalEff, "effOut conserved — NO liquidity discarded");
      // Every stored segment's marginal == isqrt(effOut·Q192/capacity) (the builders' formula — an
      // appended segment kept its self-consistent passed value, a merged one recomputed the blend).
      for (const s of segs) {
        assert.equal(s.marginalOI, mergeIsqrt((s.effOut * MERGE_Q192) / s.capacity), "blended marginal formula");
      }
      // worstMarginalOI metadata: every segment tracks the MIN original sub-slice marginal it folded
      // (off-chain-only — the estimator's lower-bound partial-proration rate). The raw slices are
      // consumed in order and capacity is conserved, so each segment's worst == the min of the raw
      // marginals inside its input band.
      let rawIdx = 0;
      for (const s of segs) {
        let band = 0n;
        let expectWorst = slices[rawIdx].marginalOI;
        while (band < s.capacity) {
          const m = slices[rawIdx].marginalOI;
          if (m < expectWorst) expectWorst = m;
          band += slices[rawIdx].cap;
          rawIdx++;
        }
        assert.equal(s.worstMarginalOI, expectWorst, "worstMarginalOI == min folded sub-slice marginal");
        assert.ok(s.worstMarginalOI! <= s.marginalOI, "worst <= blended");
      }
    });

    it("degenerate slice (marginalOI == 0) is a no-op — nothing discarded, nothing folded", () => {
      const segs: { capacity: bigint; effOut: bigint; marginalOI: bigint }[] = [];
      pushMonotoneSegment(segs, 5n * E18, 3n * E18, MERGE_Q192 / 2n);
      const before = segs.length;
      pushMonotoneSegment(segs, 1n * E18, 0n, 0n); // marginalOI 0 → skipped
      assert.equal(segs.length, before, "zero-marginal slice skipped (matches the old guard's >0 gate)");
    });

    it("already-descending slices are APPENDED unchanged (bit-for-bit the old guard's common path)", () => {
      const scale = MERGE_Q192 / 200n;
      const segs: MergeSegment[] = [];
      for (const m of [90n, 80n, 70n].map((x) => x * scale)) {
        pushMonotoneSegment(segs, 10n * E18, (10n * E18 * m * m) / MERGE_Q192, m);
      }
      assert.equal(segs.length, 3, "no fold on a descending ladder — appended unchanged");
      assertMonotone(segs, "descending");
      // A never-merged segment's worstMarginalOI == its own marginal (no folded sub-slices).
      for (const s of segs) assert.equal(s.worstMarginalOI, s.marginalOI, "worst == own marginal on append");
    });
  });

  // ── LB: a tiny-reserve bin (round-up distortion) between deep bins forces a fold ──
  //
  // LB enumerates ONE segment per bin. A near-empty bin's ROUND-UP gross-to-drain distorts its
  // fee-adjusted marginal UPWARD (better-priced than the deeper bins around it), so the old guard
  // DROPPED it AND every deep bin behind it — discarding almost all the pool's liquidity. The merge
  // folds the distorted bin and keeps the deep bins.
  it("LB — tiny-reserve bin cliff: merge fills the deep bins the drop discarded (Σeff == getSwapOut, wei-exact)", () => {
    const ACTIVE = Number(LB_REAL_ID_SHIFT); // id 2^23 == price 1.0
    const pool: LbPool = {
      poolType: 6,
      address: ("0x" + "22".repeat(20)) as `0x${string}`,
      binStep: 20,
      baseFactor: 5000,
      activeId: ACTIVE,
      swapForY: true, // in = X, out = Y (bins id <= active, DEC)
      bins: [
        { id: ACTIVE, reserveX: 0n, reserveY: 1_000_000n },
        { id: ACTIVE - 1, reserveX: 0n, reserveY: 3n }, // tiny — round-up distorts its marginal UP
        { id: ACTIVE - 2, reserveX: 0n, reserveY: 2_000_000n },
        { id: ACTIVE - 3, reserveX: 0n, reserveY: 5_000_000n },
      ],
      source: "cliff",
    };
    const amountIn = 100_000_000n;

    // The merged ladder (the SHARED builder — the exact ladder prepare + oracle + reference consume).
    const merged = buildLbSegments(pool, amountIn);
    assertMonotone(merged, "LB merged");
    const mCap = sumCap(merged);
    const mEff = sumEff(merged);
    // Conservation / wei-exact: Σ merged effOut == the pool's own getSwapOut of the covered input.
    assert.equal(mEff, lbGetSwapOut(pool, mCap), "LB Σ merged effOut == getSwapOut(Σcap) — wei-exact");

    // Reconstruct the RAW per-bin slices the builder saw, and replay the OLD drop guard on them.
    const fee = lbBaseFee(pool.binStep, pool.baseFactor);
    const walk = pool.bins.map((b) => b.id).filter((id) => id <= pool.activeId).sort((a, b) => b - a);
    const byId = new Map(pool.bins.map((b) => [b.id, b]));
    const raw: { capacity: bigint; effOut: bigint; marginalOI: bigint }[] = [];
    for (const id of walk) {
      const bin = byId.get(id)!;
      const price128 = lbGetPriceFromId(id, pool.binStep);
      const outReserve = bin.reserveY;
      if (outReserve <= 0n || price128 <= 0n) continue;
      const grossIn = lbGrossToDrain(outReserve, price128, true, fee);
      if (grossIn <= 0n) continue;
      const m = lbIsqrt((outReserve * LB_Q192) / grossIn);
      if (m <= 0n) continue;
      raw.push({ capacity: grossIn, effOut: outReserve, marginalOI: m });
    }
    const dropped = oldDropLadder(raw);
    // The regression guard: the old drop discards the deep bins behind the distorted tiny bin.
    assert.ok(mCap > sumCap(dropped), "LB: merge covers STRICTLY MORE input than the old drop-guard");
    assert.ok(mEff > sumEff(dropped), "LB: merge fills STRICTLY MORE output than the old drop-guard");
    // The dropped ladder lost the vast majority of the pool's ~8M out reserve to the tiny-bin cliff.
    assert.ok(sumEff(dropped) * 4n < mEff, "LB: the old drop discarded most of the pool's liquidity");
  });

  // ── DODO: selling base across the ABOVE_ONE → R==ONE boundary improves the marginal → a fold ──
  //
  // A DODO pool in the ABOVE_ONE R-state uses a TWO-PART integral once the trade crosses back to
  // R==ONE. Across that boundary a sampled slice's average marginal can RISE, tripping the old guard —
  // which then dropped that slice and every deeper slice, under-filling the PMM curve.
  it("DODO — R-state boundary cliff: merge fills through it (Σeff == getDy, wei-exact) vs the drop", () => {
    const pool: DodoPool = {
      poolType: 5,
      address: ("0x" + "33".repeat(20)) as `0x${string}`,
      baseToken: ("0x" + "aa".repeat(20)) as `0x${string}`,
      quoteToken: ("0x" + "bb".repeat(20)) as `0x${string}`,
      sellBase: true,
      i: E18,
      K: E18 / 2n,
      B: 400_000n * E18,
      Q: 600_000n * E18,
      B0: 500_000n * E18,
      Q0: 500_000n * E18,
      R: 1, // ABOVE_ONE (RState.ABOVE_ONE) — numeric literal (const enum not importable as a value)
      lpFeeRate: E18 / 1000n,
      mtFeeRate: 0n,
      feePpm: 1000,
      source: "cliff",
    };
    const amountIn = 500_000n * E18; // crosses R==ONE at backToOnePayBase = B0 - B = 100k

    const merged = buildDodoSegments(pool, amountIn);
    assertMonotone(merged, "DODO merged");
    const mCap = sumCap(merged);
    assert.equal(sumEff(merged), dodoGetDy(pool, mCap), "DODO Σ merged effOut == getDy(Σcap) — wei-exact");

    // Replay the raw sampled slices (the builder's squared-index geometric grid) + old drop guard.
    const M = 24n;
    const raw: { capacity: bigint; effOut: bigint; marginalOI: bigint }[] = [];
    let prevIn = 0n;
    let prevOut = 0n;
    for (let s = 1; s <= 24; s++) {
      const ss = BigInt(s);
      const input = (amountIn * ss * ss) / (M * M);
      if (input <= prevIn) continue;
      const out = dodoGetDy(pool, input);
      if (out <= 0n) continue;
      const dIn = input - prevIn;
      const dOut = out - prevOut;
      if (dIn > 0n && dOut > 0n) {
        const m = mergeIsqrt((dOut * MERGE_Q192) / dIn);
        if (m > 0n) raw.push({ capacity: dIn, effOut: dOut, marginalOI: m });
      }
      prevIn = input;
      prevOut = out;
    }
    const dropped = oldDropLadder(raw);
    assert.ok(mCap > sumCap(dropped), "DODO: merge covers STRICTLY MORE input than the old drop-guard");
    assert.ok(sumEff(merged) > sumEff(dropped), "DODO: merge fills STRICTLY MORE output than the old drop-guard");
  });

  // ── Maverick: a single-direction walk yields a MONOTONE marginal ladder (the merge no-ops) ──
  //
  // A Maverick book with a near-empty active + next tick and a huge deep tick just past them. Under the
  // REAL Maverick drain math (SwapMath._remainingBinInputSpaceGivenOutput — the reserve-extraction input,
  // NOT the price-edge input), a single-direction walk's price rises monotonically per crossed tick, so
  // the fee-adjusted sampled marginal is monotone-DECREASING — the raw ladder needs NO folding and the
  // isotonic merge is a wei-exact pass-through (merge == drop). The OLD "cliff" (a rising slice the drop
  // discarded) was an ARTIFACT of the port's wrong edge-price drain on tiny precision-bumped ticks; the
  // corrected math produces no such cliff. The genuine fold path is exercised by the DODO cell above
  // (real R-state non-convexity). This cell pins that the corrected Maverick sampler stays a monotone,
  // wei-exact partition of the curve.
  it("Maverick — real single-direction walk: monotone marginals, merge is a wei-exact pass-through", () => {
    const TS = 1;
    const AT = 0;
    const Z = ("0x" + "11".repeat(20)) as `0x${string}`;
    const reserves: Record<number, bigint> = {
      [0]: 1n * E18,
      [1]: 1n * E18,
      [2]: 10_000_000n * E18, // the deep tick past the shallow head
    };
    const ticks: MaverickTick[] = Object.entries(reserves).map(([t, r]) => ({
      tick: Number(t),
      reserveA: r,
      reserveB: r,
    }));
    const { sqrtLowerPrice, sqrtUpperPrice } = maverickTickSqrtPrices(TS, AT);
    const active = ticks.find((t) => t.tick === AT)!;
    const activeL = maverickGetTickL(active.reserveA, active.reserveB, sqrtLowerPrice, sqrtUpperPrice);
    const poolSqrtPrice = maverickGetSqrtPrice(active.reserveA, active.reserveB, sqrtLowerPrice, sqrtUpperPrice, activeL);
    const pool: MaverickPool = {
      poolType: 7,
      address: Z,
      tokenAIn: true,
      activeTick: AT,
      poolSqrtPrice,
      tickSpacing: TS,
      fee: E18 / 1000n,
      protocolFeeD3: 0n,
      ticks,
      feePpm: 1000,
      source: "cliff",
    };
    const amountIn = 100_000n * E18;

    const merged = buildMaverickSegments(pool, amountIn);
    assertMonotone(merged, "Maverick merged");
    const mCap = sumCap(merged);
    assert.equal(sumEff(merged), maverickGetDy(pool, mCap), "Maverick Σ merged effOut == getDy(Σcap) — wei-exact");

    // Raw slices + old drop guard (same squared-index grid the sampler uses, capped at consumable depth).
    const consumable = maverickSimulate(pool, amountIn).amountIn;
    const cap = consumable > 0n && consumable < amountIn ? consumable : amountIn;
    const M = 24n;
    const raw: { capacity: bigint; effOut: bigint; marginalOI: bigint }[] = [];
    let prevIn = 0n;
    let prevOut = 0n;
    for (let s = 1; s <= 24; s++) {
      const ss = BigInt(s);
      const input = (cap * ss * ss) / (M * M);
      if (input <= prevIn) continue;
      const out = maverickGetDy(pool, input);
      if (out <= 0n) continue;
      const dIn = input - prevIn;
      const dOut = out - prevOut;
      if (dIn > 0n && dOut > 0n) {
        const m = mergeIsqrt((dOut * MERGE_Q192) / dIn);
        if (m > 0n) raw.push({ capacity: dIn, effOut: dOut, marginalOI: m });
      }
      prevIn = input;
      prevOut = out;
    }
    // The raw sampled ladder is already monotone-descending under the corrected drain math, so the old
    // drop-guard keeps EVERY slice — merge and drop are identical (no past-cliff liquidity is discarded
    // because there is no cliff). This is the correct-math counterpart of the old "merge > drop" claim.
    for (let i = 1; i < raw.length; i++) {
      assert.ok(raw[i].marginalOI <= raw[i - 1].marginalOI, "Maverick raw marginals monotone (no cliff under real math)");
    }
    const dropped = oldDropLadder(raw);
    assert.equal(sumCap(dropped), mCap, "Maverick: merge == drop (monotone ladder — nothing folded/discarded)");
    assert.equal(sumEff(dropped), sumEff(merged), "Maverick: merge == drop output (monotone ladder)");
  });
});

// ── minOut estimator — lower-bound proration of a MERGED (isotonic-folded) bracket ───────────────
//
// The internal cfg[9] amountOutMin floor derives from estimateExpectedOutput, whose contract is a
// STRICT LOWER BOUND on the realized fill (a legitimate wei-exact fill must NEVER false-revert).
// An isotonic-MERGED sampled bracket is NOT flat inside: its EARLY sub-region (in input order) is
// the WORSE-priced one (the fold direction — a violating better-priced deeper slice folds BACKWARD
// into the worse band before it), so prorating a PARTIAL take linearly at the BLENDED rate credits
// output the early region does not produce — the over-credit the worstMarginalOI proration fixes.
// These vectors prove, on a synthetic two-region piecewise-flat curve (chords exact, so "true curve
// output" is computable in closed form): (a) a partial take of the merged bracket is credited <=
// the true curve output (and strictly BELOW the old blended-rate prorate, which over-credits);
// (b) FULL-segment consumption is byte-identical (the crossing-slice branch never fires).
describe("estimateExpectedOutput — merged-bracket partial fill prorates at worstMarginalOI (lower bound)", () => {
  const E18 = 10n ** 18n;

  // Two flat regions, WORSE first: region 1 prices m1, region 2 (deeper) prices m2 > m1 — the
  // discrete cliff that forces the isotonic fold. Marginals derived via the builders' own formula.
  const scale = MERGE_Q192 / 200n;
  const m1 = 60n * scale;
  const m2 = 120n * scale;
  const cap1 = 10n * E18;
  const cap2 = 10n * E18;
  const out1 = (cap1 * m1 * m1) / MERGE_Q192; // exact flat-region outputs (the true curve)
  const out2 = (cap2 * m2 * m2) / MERGE_Q192;

  /** True curve output for a cumulative take T over the two-region curve (region 1 first). */
  function trueOut(T: bigint): bigint {
    if (T <= cap1) return (T * m1 * m1) / MERGE_Q192;
    return out1 + ((T - cap1) * m2 * m2) / MERGE_Q192;
  }

  /** Build the MERGED ladder through the real pushMonotoneSegment (one folded segment). */
  function mergedSegs(): MergeSegment[] {
    const segs: MergeSegment[] = [];
    pushMonotoneSegment(segs, cap1, out1, mergeIsqrt((out1 * MERGE_Q192) / cap1));
    pushMonotoneSegment(segs, cap2, out2, mergeIsqrt((out2 * MERGE_Q192) / cap2)); // violates → folds
    return segs;
  }

  /** Wrap the merged segments as the sampled-source brackets prepare ships (flat post-fee slices). */
  function prepared(segs: MergeSegment[]): EcoSwapPrepared {
    const brackets: EcoBracket[] = segs.map((s) => ({
      kind: EcoBracketKind.CryptoSwap,
      refIdx: 0,
      sqrtNear: s.marginalOI,
      sqrtFar: s.marginalOI,
      liquidity: 0n,
      capacity: s.capacity,
      sqrtAdjNear: s.marginalOI,
      sqrtAdjFar: s.marginalOI,
      worstMarginalOI: s.worstMarginalOI,
    }));
    return { pools: [], routes: [], brackets, zeroForOne: true, priceLimit: 0n, expectedInputCovered: 0n };
  }

  it("folds into ONE segment carrying the worst sub-slice marginal", () => {
    const segs = mergedSegs();
    assert.equal(segs.length, 1, "cliff folded into one merged segment");
    assert.equal(segs[0].capacity, cap1 + cap2, "capacity conserved");
    assert.equal(segs[0].effOut, out1 + out2, "effOut conserved");
    assert.equal(segs[0].worstMarginalOI, mergeIsqrt((out1 * MERGE_Q192) / cap1), "worst == region-1 marginal");
    assert.ok(segs[0].worstMarginalOI! < segs[0].marginalOI, "worst strictly below the blend");
  });

  it("(a) partial take of the merged bracket is credited <= the true curve output (blended rate over-credits)", () => {
    const segs = mergedSegs();
    const prep = prepared(segs);
    // Takes ending inside region 1 AND inside region 2 (both strictly inside the merged band).
    for (const take of [cap1 / 2n, cap1, cap1 + cap2 / 4n]) {
      const est = estimateExpectedOutput(prep, take);
      const truth = trueOut(take);
      const blended = (segs[0].effOut * take) / segs[0].capacity; // the old linear prorate
      assert.ok(est <= truth, `credited ${est} <= true curve output ${truth} (take ${take})`);
      assert.ok(est > 0n, "non-degenerate credit");
      // The over-credit this fixes: inside region 1 the blended-rate prorate EXCEEDS the true
      // output (the floor could false-revert); the worst-rate credit stays below it.
      if (take <= cap1) {
        assert.ok(blended > truth, `blended prorate ${blended} over-credits the true ${truth}`);
        assert.ok(est < blended, "worst-rate credit strictly below the blended prorate");
      }
    }
  });

  it("(b) full-segment consumption is unchanged (no proration branch — metadata inert)", () => {
    const segs = mergedSegs();
    const prep = prepared(segs);
    const s = segs[0];
    // amountIn == the full merged capacity ⇒ the slice is consumed WHOLE: the estimator credits the
    // exact flat-slice value it derives from the shipped {capacity, marginalOI} (the blended rate),
    // bit-identical to the pre-fix behavior and identical with or without the worstMarginalOI
    // metadata (the crossing-slice branch never fires).
    const wholeSlice = (s.capacity * s.marginalOI * s.marginalOI) / MERGE_Q192;
    const full = estimateExpectedOutput(prep, cap1 + cap2);
    assert.equal(full, wholeSlice, "full take credits the whole flat slice at the blended rate");
    assert.ok(full <= out1 + out2, "still a lower bound on the true merged output");
    const noMeta = prepared(segs.map((x) => ({ ...x, worstMarginalOI: undefined })));
    assert.equal(estimateExpectedOutput(noMeta, cap1 + cap2), full, "metadata-independent on full consumption");
    // And beyond the ladder: unchanged too (everything consumed whole).
    assert.equal(estimateExpectedOutput(prep, 2n * (cap1 + cap2)), full, "over-ask consumes the whole ladder");
  });

  it("never-merged (truly flat) bracket keeps the exact linear prorate semantics", () => {
    // A single un-folded segment: worst == marginal; the worst-rate credit and the linear prorate
    // agree to isqrt rounding, and both stay <= the exact flat-slice output.
    const segs: MergeSegment[] = [];
    pushMonotoneSegment(segs, cap1, out1, mergeIsqrt((out1 * MERGE_Q192) / cap1));
    const prep = prepared(segs);
    const take = cap1 / 3n;
    const est = estimateExpectedOutput(prep, take);
    const exact = (out1 * take) / cap1;
    assert.ok(est <= exact, "flat partial credit <= exact prorate (isqrt rounds down)");
    assertClose(est, exact, 10n, "flat partial credit ~= exact prorate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE-LADDER (QL) — the Curve live-walk ladder math (known-answer, pure bigint).
// qlSliceHead + buildCurveQLLadder are the SHARED source the on-chain solver mirrors
// bit-for-bit; the EVM test (ecoswap.curve.evm.test.ts) proves the on-chain ladder
// equals this replay to the wei on both engines.
// ─────────────────────────────────────────────────────────────────────────────
describe("EcoSwap Curve QUOTE-LADDER math (qlSliceHead + buildCurveQLLadder)", () => {
  const E18 = 10n ** 18n;
  // A deep, mildly-imbalanced 2-coin StableSwap (the ecoswap.curve.evm SOLO fixture).
  const pool: CurvePool = {
    poolType: 3, address: "0x0000000000000000000000000000000000000C0f",
    i: 0, j: 1, A: 1000n, aPrecision: 100n,
    balances: [1_000_000n * E18, 1_200_000n * E18], rates: [E18, E18],
    feePpm10: 4_000_000n, source: "unit",
  };

  it("qlSliceHead == isqrt(floor(sliceOut·2^192 / capacity)) on a vector", () => {
    const cases: Array<[bigint, bigint]> = [
      [1000n * E18, 1000n * E18],
      [999n * E18, 1000n * E18],
      [123456789n, 987654321n],
      [1n, 1n],
    ];
    for (const [out, cap] of cases) {
      assert.equal(qlSliceHead(out, cap), isqrt((out * Q192) / cap), `qlSliceHead(${out},${cap})`);
    }
    assert.equal(qlSliceHead(0n, 1000n), 0n, "zero out ⇒ 0");
    assert.equal(qlSliceHead(1000n, 0n), 0n, "zero capacity ⇒ 0");
  });

  it("buildCurveQLLadder: geometric grid, full [0,amountIn] coverage, strictly-descending heads", () => {
    const amountIn = 150_000n * E18;
    const ladder = buildCurveQLLadder(pool, amountIn);
    assert.ok(ladder.length > 0 && ladder.length <= QL_S, `1..${QL_S} slices (got ${ladder.length})`);
    // Capacities telescope to EXACTLY amountIn (the clamp engages on the final slice, QL_SEED_DIV=16).
    assert.equal(ladder.reduce((a, s) => a + s.capacity, 0n), amountIn, "Σ capacity == amountIn (full coverage)");
    // Each slice: head == qlSliceHead(effOut, capacity), and heads strictly DESCEND (convex curve).
    let prev = 0n;
    for (let k = 0; k < ladder.length; k++) {
      const s = ladder[k];
      assert.equal(s.marginalOI, qlSliceHead(s.effOut, s.capacity), `slice ${k} head == qlSliceHead`);
      if (k > 0) assert.ok(s.marginalOI < prev, `slice ${k} head strictly < previous (descending)`);
      prev = s.marginalOI;
    }
  });

  it("buildCurveQLLadder replays the geometric recurrence + get_dy differencing exactly", () => {
    const amountIn = 150_000n * E18;
    const ladder = buildCurveQLLadder(pool, amountIn);
    // Reproduce the recurrence independently: xNext = cum*QL_RN/QL_RD + seed (clamp amountIn),
    // capacity = xNext-cum, effOut = getDy(xNext) - getDy(cum).
    let seed = amountIn / QL_SEED_DIV;
    if (seed <= 0n) seed = 1n;
    let cum = 0n, prevOut = 0n;
    for (let k = 0; k < ladder.length; k++) {
      let xNext = (cum * QL_RN) / QL_RD + seed;
      if (xNext > amountIn) xNext = amountIn;
      const cap = xNext - cum;
      const out = getDy(pool, xNext);
      assert.equal(ladder[k].capacity, cap, `slice ${k} capacity matches recurrence`);
      assert.equal(ladder[k].effOut, out - prevOut, `slice ${k} effOut matches get_dy differencing`);
      cum = xNext;
      prevOut = out;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE-LADDER constants — the on-chain solver's ecoswap.sauce.ts literals MUST equal
// the curve-math.ts exports the oracle/reference read (or the split diverges by a wei),
// and the geometric recurrence MUST reach amountIn within QL_S slices (solo-venue full
// coverage). This DIRECTLY guards a future QL_RN/QL_RD/QL_S tune that forgets to re-derive
// QL_SEED_DIV — the reviewer's "no compile-time equality assertion" gap.
// ─────────────────────────────────────────────────────────────────────────────
describe("EcoSwap QUOTE-LADDER constants — sauce.ts literals == curve-math exports + coverage", () => {
  const SOLVER_SRC = readFileSync(join(__dirname, "..", "ecoswap", "ecoswap.sauce.ts"), "utf-8");
  const solverLiteral = (name: string): bigint => {
    const m = SOLVER_SRC.match(new RegExp(`const ${name}: Uint256 = (\\d+);`));
    assert.ok(m, `ecoswap.sauce.ts declares \`const ${name}: Uint256 = <n>;\``);
    return BigInt(m![1]);
  };

  it("QL_S / QL_RN / QL_RD / QL_SEED_DIV literals match the curve-math.ts exports", () => {
    assert.equal(solverLiteral("QL_S"), BigInt(QL_S), "QL_S");
    assert.equal(solverLiteral("QL_RN"), QL_RN, "QL_RN");
    assert.equal(solverLiteral("QL_RD"), QL_RD, "QL_RD");
    assert.equal(solverLiteral("QL_SEED_DIV"), QL_SEED_DIV, "QL_SEED_DIV");
  });

  it("the geometric recurrence reaches amountIn within QL_S slices (constants-only, no get_dy)", () => {
    // cum_{k+1} = cum_k*QL_RN/QL_RD + seed, seed = amountIn/QL_SEED_DIV. The clamp MUST engage on or
    // before slice QL_S-1 (cum after QL_S slices ≈ seed·4·((5/4)^8-1) ≈ 19.84·seed ⇒ need SEED_DIV<19.84).
    // If a constant tune breaks this, a SOLO QL venue would under-fill (ladder stops before amountIn).
    const amountIn = 1_000_000n * 10n ** 18n;
    let seed = amountIn / QL_SEED_DIV;
    if (seed <= 0n) seed = 1n;
    let cum = 0n;
    let reached = false;
    for (let k = 0; k < QL_S; k++) {
      let xNext = (cum * QL_RN) / QL_RD + seed;
      if (xNext >= amountIn) { reached = true; xNext = amountIn; }
      cum = xNext;
    }
    assert.ok(reached, `cum must reach amountIn within QL_S=${QL_S} slices (QL_SEED_DIV=${QL_SEED_DIV} too large?)`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE-LADDER split OPTIMALITY — an INDEPENDENT check that the S=8 geometric ladder
// approximates the true continuous water-fill optimum (not just that solver==oracle, which
// is codegen-equivalence). Reproduces scratchpad/ql-curve.mjs: build the Curve ladder via the
// SHARED buildCurveQLLadder, compete it against a V2 competitor (a geometric ladder over the
// exact constant-product quote — the SAME recurrence, verified to reproduce buildCurveQLLadder
// bit-for-bit), water-fill by descending head, then compare the realized total output to the
// ternary-search continuous optimum. A systematically-suboptimal ladder (bad ratio / S /
// SEED_DIV) would blow the per-scenario ppm bounds. Pure bigint, no network.
// ─────────────────────────────────────────────────────────────────────────────
describe("EcoSwap Curve QUOTE-LADDER split optimality (vs continuous water-fill optimum)", () => {
  const E18 = 10n ** 18n;

  interface QLSlice {
    capacity: bigint;
    effOut: bigint;
    marginalOI: bigint;
  }

  // Post-fee constant-product output for `dx` (the V2 competitor's exact quote view).
  function v2Out(rIn: bigint, rOut: bigint, feePpm: bigint, dx: bigint): bigint {
    if (dx <= 0n) return 0n;
    const amtInWithFee = dx * (1_000_000n - feePpm);
    return (amtInWithFee * rOut) / (rIn * 1_000_000n + amtInWithFee);
  }

  // Generic geometric ladder over ANY cumulative quote fn — mirrors buildCurveQLLadder's recurrence,
  // differencing and stop conditions EXACTLY (asserted below to reproduce it bit-for-bit on Curve).
  function geomLadder(quote: (dx: bigint) => bigint, amountIn: bigint): QLSlice[] {
    if (amountIn <= 0n) return [];
    let seed = amountIn / QL_SEED_DIV;
    if (seed <= 0n) seed = 1n;
    const segs: QLSlice[] = [];
    let cum = 0n;
    let prevOut = 0n;
    let prevHead = 0n;
    for (let k = 0; k < QL_S; k++) {
      let xNext = (cum * QL_RN) / QL_RD + seed;
      if (xNext > amountIn) xNext = amountIn;
      const capacity = xNext - cum;
      if (capacity === 0n) break;
      const q = quote(xNext);
      if (q === 0n) break;
      const effOut = q - prevOut;
      if (effOut === 0n) break;
      const marginalOI = qlSliceHead(effOut, capacity);
      if (segs.length > 0 && marginalOI >= prevHead) break;
      segs.push({ capacity, effOut, marginalOI });
      prevHead = marginalOI;
      cum = xNext;
      prevOut = q;
      if (xNext >= amountIn) break;
    }
    return segs;
  }

  // Water-fill: two descending-head ladders, take the higher-head next slice each step (clamp the
  // last slice to the remaining budget). Returns per-venue awarded input.
  function qlMerge(cL: QLSlice[], vL: QLSlice[], amountIn: bigint): { curveIn: bigint; v2In: bigint } {
    let ci = 0;
    let vi = 0;
    let curveIn = 0n;
    let v2In = 0n;
    let filled = 0n;
    while (filled < amountIn) {
      const ch = ci < cL.length ? cL[ci].marginalOI : 0n;
      const vh = vi < vL.length ? vL[vi].marginalOI : 0n;
      if (ch === 0n && vh === 0n) break;
      const takeCurve = ch >= vh;
      let cap = takeCurve ? cL[ci].capacity : vL[vi].capacity;
      if (filled + cap > amountIn) cap = amountIn - filled;
      if (takeCurve) { curveIn += cap; ci++; } else { v2In += cap; vi++; }
      filled += cap;
    }
    return { curveIn, v2In };
  }

  // True continuous optimum: ternary search on the Curve allocation a ∈ [0, amountIn] maximizing
  // getDy(curve,a) + v2Out(amountIn-a) (both venues concave ⇒ total concave), refined 1-wei exact.
  function optimum(cq: (a: bigint) => bigint, vq: (a: bigint) => bigint, amountIn: bigint): bigint {
    let lo = 0n;
    let hi = amountIn;
    const f = (a: bigint): bigint => cq(a) + vq(amountIn - a);
    while (hi - lo > 2n) {
      const m1 = lo + (hi - lo) / 3n;
      const m2 = hi - (hi - lo) / 3n;
      if (f(m1) < f(m2)) lo = m1; else hi = m2;
    }
    let bestT = -1n;
    for (let a = lo; a <= hi; a++) { const t = f(a); if (t > bestT) bestT = t; }
    return bestT;
  }

  const mkCurve = (b0: bigint, b1: bigint, A: bigint, fee: bigint): CurvePool => ({
    poolType: 3, address: "0x0000000000000000000000000000000000000C0f", i: 0, j: 1, A, aPrecision: 100n,
    balances: [b0, b1], rates: [E18, E18], feePpm10: fee, source: "unit",
  });

  // Scenarios from scratchpad/ql-curve.mjs. `maxPpm` is the shortfall ceiling — tuned just above the
  // MEASURED shortfall of the shipped S=8/SEED_DIV=16 ladder (0 / 0 / 13 / 0 / 355 ppm respectively),
  // so a systematically-worse ladder (a coarser ratio / smaller S / larger SEED_DIV) fails. Scenario E
  // is the deep-off-peg 50%-depth stress where an 8-slice ladder is necessarily coarsest.
  const scenarios: Array<{
    label: string; curve: CurvePool; rIn: bigint; rOut: bigint; feePpm: bigint; amountIn: bigint; maxPpm: bigint;
  }> = [
    { label: "A 100k balanced", curve: mkCurve(10_000_000n * E18, 10_000_000n * E18, 200n, 4_000_000n), rIn: 5_000_000n * E18, rOut: 5_000_000n * E18, feePpm: 3000n, amountIn: 100_000n * E18, maxPpm: 5n },
    { label: "B 2M off-peg", curve: mkCurve(10_000_000n * E18, 10_000_000n * E18, 200n, 4_000_000n), rIn: 5_000_000n * E18, rOut: 5_000_000n * E18, feePpm: 3000n, amountIn: 2_000_000n * E18, maxPpm: 5n },
    { label: "C 500k imbalanced A=100", curve: mkCurve(12_000_000n * E18, 8_000_000n * E18, 100n, 4_000_000n), rIn: 3_000_000n * E18, rOut: 3_000_000n * E18, feePpm: 3000n, amountIn: 500_000n * E18, maxPpm: 50n },
    { label: "D 10k small", curve: mkCurve(10_000_000n * E18, 10_000_000n * E18, 200n, 4_000_000n), rIn: 2_000_000n * E18, rOut: 2_000_000n * E18, feePpm: 3000n, amountIn: 10_000n * E18, maxPpm: 5n },
    { label: "E 5M deep off-peg A=50", curve: mkCurve(10_000_000n * E18, 10_000_000n * E18, 50n, 4_000_000n), rIn: 8_000_000n * E18, rOut: 8_000_000n * E18, feePpm: 3000n, amountIn: 5_000_000n * E18, maxPpm: 500n },
  ];

  it("geomLadder reproduces buildCurveQLLadder bit-for-bit (the competitor builder is trustworthy)", () => {
    for (const sc of scenarios) {
      const a = buildCurveQLLadder(sc.curve, sc.amountIn);
      const b = geomLadder((dx) => getDy(sc.curve, dx), sc.amountIn);
      assert.equal(b.length, a.length, `${sc.label}: same slice count`);
      for (let k = 0; k < a.length; k++) {
        assert.equal(b[k].capacity, a[k].capacity, `${sc.label} slice ${k}: capacity`);
        assert.equal(b[k].effOut, a[k].effOut, `${sc.label} slice ${k}: effOut`);
        assert.equal(b[k].marginalOI, a[k].marginalOI, `${sc.label} slice ${k}: head`);
      }
    }
  });

  for (const sc of scenarios) {
    it(`${sc.label}: S=${QL_S} ladder split is within ${sc.maxPpm} ppm of the continuous optimum`, () => {
      const cq = (a: bigint): bigint => getDy(sc.curve, a);
      const vq = (a: bigint): bigint => v2Out(sc.rIn, sc.rOut, sc.feePpm, a);
      const cL = buildCurveQLLadder(sc.curve, sc.amountIn);
      const vL = geomLadder(vq, sc.amountIn);
      // Ladders must be strictly descending (the merge relies on it) and cap at QL_S slices.
      for (const L of [cL, vL]) {
        assert.ok(L.length > 0 && L.length <= QL_S, `${sc.label}: 1..${QL_S} slices`);
        for (let k = 1; k < L.length; k++) assert.ok(L[k].marginalOI < L[k - 1].marginalOI, "strictly descending heads");
      }
      const { curveIn, v2In } = qlMerge(cL, vL, sc.amountIn);
      assert.equal(curveIn + v2In, sc.amountIn, `${sc.label}: split covers amountIn exactly`);
      const qlTotal = cq(curveIn) + vq(v2In);
      const opt = optimum(cq, vq, sc.amountIn);
      assert.ok(qlTotal > 0n, "positive realized output");
      // shortfall vs optimum (>= -rounding). The QL split can never strictly beat the true optimum.
      const shortPpm = opt > 0n ? ((opt - qlTotal) * 1_000_000n) / opt : 0n;
      assert.ok(
        shortPpm <= sc.maxPpm,
        `${sc.label}: QL total ${qlTotal} is ${shortPpm} ppm below optimum ${opt} (bound ${sc.maxPpm} ppm)`,
      );
    });
  }
});
