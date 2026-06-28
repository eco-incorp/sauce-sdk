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
describe("water-fill solver — single-pass (live-cut) [ecoSwapReference]", () => {
  // Two V3 pools, different fee tiers, several brackets each. ecoSwapReference
  // mirrors the single-pass on-chain solver in ecoswap.sauce.ts.
  const pools = [v3Pool(3000, 60), v3Pool(500, 10)];
  const L = 10n ** 21n;
  const ladder = sortLadder([
    ...v3Brackets(0, 3000, L, 0, 60, 6),
    ...v3Brackets(1, 500, L * 2n, 5, 10, 8),
  ]);
  const prep = prepared(pools, ladder);
  const cap = totalCapacity(ladder);

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
    // total capacity it spends amountIn EXACTLY (no per-pool re-derivation gap).
    // Verified: `=== amountIn` holds cleanly (diff 0) at 25/50/75% on this ladder,
    // no off-by-N.
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
// 5. WS2 pre-fill (against-swap drift) — oracle mirror (ecoSwapReference §2.1)
// ─────────────────────────────────────────────────────────────
describe("WS2 pre-fill — against-swap drift gap fill [ecoSwapReference]", () => {
  // ONE V3 pool (fee 3000, ts 60), constant L over the gap (empty adaptiveNet → no
  // boundary nets → L unchanged). Prepare-time spot = tick 0 (topNearReal = Q96). The
  // modeled LIVE price has drifted UP to tick 120 (liveCurRealOverride). The pre-fill
  // walks DOWN from the live tick to topNearOI, water-filling the gap (tick 120 → 0).
  const L = 10n ** 21n;
  const FEE = 3000;
  const STEP = getSqrtRatioAtTick(60); // multiplicative ts-step ratio (== prepare's seed)
  const spotReal = getSqrtRatioAtTick(0); // = Q96
  const liveReal = getSqrtRatioAtTick(120); // 2 ts above spot (against-swap drift)

  function drifted(): EcoSwapPrepared {
    const pool: EcoPool = {
      ...v3Pool(FEE, 60),
      adaptiveStepRatio: STEP,
      adaptiveNet: new Map<number, bigint>(), // no initialized ticks in the gap → constant L
      // pre-fill stop target = prepare-time spot real sqrt
      topNearReal: spotReal,
      bracketCount: 1,
      // modeled live (drifted-up) state
      liveCurRealOverride: liveReal,
      liveTickOverride: 120,
      liveLOverride: L,
    };
    // ONE in-window forward bracket starting at spot so the sweep has a pool to see,
    // but the trade is sized to be covered entirely by the gap pre-fill below.
    const ladder = v3Brackets(0, FEE, L, 0, 60, 4);
    return { pools: [pool], routes: [], brackets: sortLadder(ladder), zeroForOne: true, priceLimit: 0n, expectedInputCovered: 0n };
  }

  it("fills the gap (topNearOI, liveCur] at constant L — matches analytic gross", () => {
    // Analytic gap gross over a constant-L, no-crossing region telescopes to the gross
    // between liveCur and topNearOI (intermediate step boundaries cancel), so it equals
    // bracketCapacity(L, liveCur_oi, topNear_oi, fee). zeroForOne → out/in == real sqrt.
    const liveOI = toOutIn(liveReal, true);
    const topNearOI = toOutIn(spotReal, true);
    const analyticGap = bracketCapacity(L, liveOI, topNearOI, FEE);
    assert.ok(analyticGap > 0n, "gap has positive capacity");

    // amountIn bigger than the gap but smaller than gap + the in-window bracket, so the
    // gap is fully filled by the pre-fill and the sweep adds the remainder.
    const amountIn = analyticGap * 2n;
    const res = ecoSwapReference(drifted(), amountIn);
    // The pool's input includes BOTH the pre-fill gap AND the in-window sweep — assert
    // it fully covers at least the analytic gap (the pre-fill ran) and total == amountIn.
    assert.ok(res.perPoolInput[0] >= analyticGap, `pool got >= gap (${res.perPoolInput[0]} >= ${analyticGap})`);
    assert.equal(res.totalInput, amountIn, "spends amountIn exactly (gap + in-window covers it)");

    // Isolate the gap alone: amountIn == analyticGap → only the pre-fill runs, exact.
    const gapOnly = ecoSwapReference(drifted(), analyticGap);
    assertClose(gapOnly.perPoolInput[0], analyticGap, 50n, "gap-only fill == analytic gap (within step truncation)");
    assert.ok(gapOnly.totalInput <= analyticGap, "gap-only never exceeds the gap");
  });

  it("is a NO-OP without a live override (modeled live == spot → no gap)", () => {
    // Same pool WITHOUT the override fields → liveCur defaults to topNearReal → liveCur
    // <= topNearOI → pre-fill skipped → identical to the plain single-pass sweep.
    const noDrift: EcoSwapPrepared = {
      pools: [{ ...v3Pool(FEE, 60), adaptiveStepRatio: STEP, adaptiveNet: new Map(), topNearReal: spotReal, bracketCount: 1 }],
      routes: [],
      brackets: sortLadder(v3Brackets(0, FEE, L, 0, 60, 4)),
      zeroForOne: true,
      priceLimit: 0n,
      expectedInputCovered: 0n,
    };
    const cap = totalCapacity(noDrift.brackets);
    const res = ecoSwapReference(noDrift, cap / 2n);
    // No pre-fill: the sweep alone covers it, exactly like the non-pre-fill path.
    assert.equal(res.totalInput, cap / 2n, "no-override = plain sweep, spends amountIn exactly");
    assert.ok(res.perPoolInput[0] === cap / 2n, "all to the one pool via the sweep");
  });
});

// ─────────────────────────────────────────────────────────────
// 6. V2 constant-L FORWARD STREAM (with-swap drift) — oracle mirror (WS2 #104)
// ─────────────────────────────────────────────────────────────
describe("V2 constant-L forward stream — under-fill past the window [ecoSwapReference]", () => {
  // ONE synthetic V2 pool (constant-product √k, engine fee 0.3%). A small prepared
  // window (4 geometric brackets) is stamped with the WS2 #104 frontier seed
  // (adaptiveStartShifted=1 enable flag, adaptiveNearReal = deepest kept far). With an
  // amountIn larger than the window capacity the single-pass sweep under-fills, so the
  // V2 forward stream resumes from the frontier and keeps emitting geometric slices at
  // the constant L until amountIn — the cheap analogue of the V3/V4 tick walk (no ticks).
  const reserveIn = 1_000_000n * 10n ** 18n;
  const reserveOut = 2_000_000n * 10n ** 18n;
  const k = reserveIn * reserveOut;
  const L = isqrt(k); // √k = the constant V2 liquidity
  const FEE = 3000;
  const FEE_PPM = 3000n;
  const spotNear = isqrt((reserveOut * Q192) / reserveIn); // out/in spot sqrt
  const WINDOW = 4; // prepared V2 brackets (mirror prepare's kept window)

  function preparedV2(): { prep: EcoSwapPrepared; windowGross: bigint; deepestFar: bigint } {
    const { brackets, deepestFar } = v2Brackets(0, L, spotNear, FEE, WINDOW);
    const windowGross = brackets.reduce((s, b) => s + b.capacity, 0n);
    const pool: EcoPool = {
      ...v2Pool(),
      // WS2 #104 V2 stream seed: enable flag + out/in frontier (deepest kept far).
      adaptiveStartShifted: 1n,
      adaptiveNearReal: deepestFar,
      adaptiveStartL: 0n, // V2 reads live √k from the spot bracket's liquidity, not this
      adaptiveStepRatio: 0n, // V2 streams in out/in space (geometric), no tick step ratio
      topNearReal: 0n, // V2 has no against-swap pre-fill
      bracketCount: brackets.length,
    };
    const prep: EcoSwapPrepared = {
      pools: [pool],
      routes: [],
      brackets: sortLadder(brackets),
      zeroForOne: true,
      priceLimit: 0n,
      expectedInputCovered: 0n,
    };
    return { prep, windowGross, deepestFar };
  }

  it("streams past the window at constant L — matches the analytic geometric walk to the wei", () => {
    const { prep, windowGross } = preparedV2();

    // Size amountIn well past the window so the stream MUST fire (and verify the window
    // alone would under-fill — that's the precondition for the WS2 #104 branch).
    const amountIn = windowGross * 3n;
    assert.ok(amountIn > windowGross, "amountIn exceeds the prepared window → sweep under-fills");

    const res = ecoSwapReference(prep, amountIn);

    // KNOWN ANSWER: the window sweep + the V2 stream are ONE contiguous geometric walk
    // from spotNear at constant L (the stream resumes from the deepest kept far, which is
    // exactly where the window ended — path-additive). Replay it with the identical
    // per-slice integer math (window WINDOW slices + up to EXTRA_TICKS=64 stream slices),
    // capped at amountIn. The oracle's V2 fill must equal this to the wei.
    const walk = v2WalkGross(L, spotNear, FEE_PPM, WINDOW + 64, amountIn);
    assert.equal(res.perPoolInput[0], walk.gross, "V2 fill == analytic constant-L geometric walk (exact bigint)");
    assert.equal(res.totalInput, amountIn, "spends amountIn exactly (window + stream cover it)");
    // The stream actually contributed beyond the window (not a window-only fill).
    assert.ok(res.perPoolInput[0] > windowGross, `fill exceeds the window (stream fired: ${res.perPoolInput[0]} > ${windowGross})`);
  });

  it("effIn telescopes to one constant-product integral L·(1/farFinal − 1/spotNear)", () => {
    // The geometric chain (window + stream) at constant L is a single √k curve, so the
    // raw effIn (pre-fee-grossup) telescopes EXACTLY: interior boundary terms cancel and
    // Σ effIn == L·Q96/farFinal − L·Q96/spotNear. We walk the full window+stream span
    // (no amountIn cap) and check the telescoped identity to the wei, independent of the
    // oracle (this is the constant-product integral the V2 stream is integrating).
    const TOTAL_SLICES = WINDOW + 64;
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
