/**
 * EcoSwap K-WAY-LAZY reference — known-answer cross-check vs the neutral optimal oracle.
 *
 * The canonical on-chain k-way solver (ecoswap.sauce.ts) is mirrored bit-for-bit by
 * ecoswap.kway.reference.ts. This test proves that mirror produces the OPTIMAL split
 * (ecoswap.optimal.ts optimalSplit, built from TRUE live state) to the wei across the
 * scenario matrix — WITHOUT anvil. The EVM lane (ecoswap.kway.evm.test.ts) then confirms
 * the compiled bytecode realizes the same split on-chain.
 *
 * The synthetic prepared datasets are built with the SAME multiplicative-step geometry
 * prepare.ts now uses (buildV3Brackets stepReal edges), so the prepared region and the
 * oracle's live walk share one geometry — the load-bearing exactness alignment (spec §7).
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.kway.reference.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Q96,
  Q192,
  FEE_DENOM,
  OFFSET,
  isqrt,
  toOutIn,
  getSqrtRatioAtTick,
  sqrtOneMinusFeeScaled,
  V2_STEP_BPS,
  V2_STEP_DEN,
} from "./ecoswap.math";
import { kwayReference, type KwayLivePool } from "./ecoswap.kway.reference";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { EcoBracketKind, type EcoBracket, type EcoPool, type EcoSwapPrepared } from "../shared/types";
import { SwapPoolType } from "../shared/constants";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const PRICE_LIMIT = 4295128740n; // MIN_SQRT_RATIO + 1 (zeroForOne extreme)

function feeAdjust(oi: bigint, feePpm: number): bigint {
  return (oi * sqrtOneMinusFeeScaled(feePpm)) / FEE_DENOM;
}
function stepRealTs(s: bigint, ratio: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? (s * Q96) / ratio : (s * ratio) / Q96;
}

/**
 * Build a flat-L V3 EcoPool + its prepared brackets, mirroring prepare.ts's
 * multiplicative buildV3Brackets walk from a prepare-time spot tick. Single wide
 * position ⇒ empty net ⇒ constant L (the exact regime the EVM lane uses).
 */
function buildV3(
  refIdx: number,
  feePpm: number,
  ts: number,
  L: bigint,
  nBr: number,
  prepTick: number,
  zeroForOne: boolean,
): { pool: EcoPool; brackets: EcoBracket[] } {
  const spotReal = getSqrtRatioAtTick(prepTick);
  const stepRatio = getSqrtRatioAtTick(ts);
  const base = Math.floor(prepTick / ts) * ts;
  const brackets: EcoBracket[] = [];
  let nearReal = spotReal;
  for (let k = 0; k < nBr; k++) {
    const farReal = stepRealTs(nearReal, stepRatio, zeroForOne);
    const near = toOutIn(nearReal, zeroForOne);
    const far = toOutIn(farReal, zeroForOne);
    const effIn = (L * Q96) / far - (L * Q96) / near;
    const cap = (effIn * FEE_DENOM) / BigInt(1_000_000 - feePpm);
    brackets.push({
      kind: EcoBracketKind.V3, refIdx, sqrtNear: near, sqrtFar: far, liquidity: L,
      capacity: cap > 0n ? cap : 0n, sqrtAdjNear: feeAdjust(near, feePpm), sqrtAdjFar: feeAdjust(far, feePpm),
    });
    nearReal = farReal;
  }
  const startBoundary = zeroForOne ? base : base + ts;
  const step = zeroForOne ? -ts : ts;
  const pool: EcoPool = {
    poolType: SwapPoolType.UniV3, address: ZERO, fee: feePpm, tickSpacing: ts, hooks: ZERO,
    feePpm, isV2: false, inIsToken0: zeroForOne, stateView: ZERO, poolId: ZERO,
    adaptiveStartShifted: BigInt(startBoundary + Number(OFFSET)) + BigInt(step) * BigInt(nBr),
    adaptiveNearReal: nearReal, adaptiveStartL: L, adaptiveStepRatio: stepRatio,
    topNearReal: spotReal, bracketCount: nBr, adaptiveNet: new Map<number, bigint>(), source: "synthetic",
  };
  return { pool, brackets };
}

/**
 * Build a V3 EcoPool whose active L CHANGES at initialized ticks (a non-empty `net` map),
 * mirroring prepare.ts buildV3Brackets: walk forward from the prepare-time spot multipli-
 * catively, emit a bracket per step, and update L by ±net at each boundary. The dn-frontier
 * seed is stamped CONTIGUOUS with the last emitted bracket (matching prepare's post-trim
 * re-stamp — no seed/cache gap), and `adaptiveNet` carries the FULL signed-net curve for the
 * reference's mirrored live walk. This is the regime the prior single-wide-position vectors
 * never exercised — the one that hid the B3 drift-down / L-change defect.
 */
function buildV3WithNet(
  refIdx: number,
  feePpm: number,
  ts: number,
  startL: bigint,
  net: Map<number, bigint>,
  nBr: number,
  prepTick: number,
  zeroForOne: boolean,
): { pool: EcoPool; brackets: EcoBracket[] } {
  const spotReal = getSqrtRatioAtTick(prepTick);
  const stepRatio = getSqrtRatioAtTick(ts);
  const base = Math.floor(prepTick / ts) * ts;
  const step = zeroForOne ? -ts : ts;
  const brackets: EcoBracket[] = [];
  let nearReal = spotReal;
  let L = startL;
  let b = zeroForOne ? base : base + ts;
  for (let k = 0; k < nBr; k++) {
    const farReal = stepRealTs(nearReal, stepRatio, zeroForOne);
    const near = toOutIn(nearReal, zeroForOne);
    const far = toOutIn(farReal, zeroForOne);
    if (L > 0n && far > 0n && near > far) {
      const effIn = (L * Q96) / far - (L * Q96) / near;
      const cap = (effIn * FEE_DENOM) / BigInt(1_000_000 - feePpm);
      brackets.push({
        kind: EcoBracketKind.V3, refIdx, sqrtNear: near, sqrtFar: far, liquidity: L,
        capacity: cap > 0n ? cap : 0n, sqrtAdjNear: feeAdjust(near, feePpm), sqrtAdjFar: feeAdjust(far, feePpm),
      });
    }
    const n = net.get(b) ?? 0n;
    L = zeroForOne ? L - n : L + n;
    if (L < 0n) L = 0n;
    nearReal = farReal;
    b += step;
  }
  const startBoundary = zeroForOne ? base : base + ts;
  const pool: EcoPool = {
    poolType: SwapPoolType.UniV3, address: ZERO, fee: feePpm, tickSpacing: ts, hooks: ZERO,
    feePpm, isV2: false, inIsToken0: zeroForOne, stateView: ZERO, poolId: ZERO,
    adaptiveStartShifted: BigInt(startBoundary + Number(OFFSET)) + BigInt(step) * BigInt(nBr),
    adaptiveNearReal: nearReal, adaptiveStartL: L, adaptiveStepRatio: stepRatio,
    topNearReal: spotReal, bracketCount: brackets.length, adaptiveNet: net, source: "synthetic",
  };
  return { pool, brackets };
}

/** A V2 EcoPool + prepared brackets, mirroring buildV2Brackets + the WS2 #104 seed. */
function buildV2(
  refIdx: number,
  reserveIn: bigint,
  reserveOut: bigint,
  nBr: number,
): { pool: EcoPool; brackets: EcoBracket[]; spotOI: bigint; L: bigint } {
  const L = isqrt(reserveIn * reserveOut);
  const fee = 3000;
  const spotOI = isqrt((reserveOut * Q192) / reserveIn);
  const brackets: EcoBracket[] = [];
  let near = spotOI;
  for (let i = 0; i < nBr; i++) {
    const far = near - (near * V2_STEP_BPS) / V2_STEP_DEN;
    if (far <= 0n || far >= near) break;
    const effIn = (L * Q96) / far - (L * Q96) / near;
    const cap = (effIn * FEE_DENOM) / BigInt(1_000_000 - fee);
    brackets.push({
      kind: EcoBracketKind.V2, refIdx, sqrtNear: near, sqrtFar: far, liquidity: L,
      capacity: cap > 0n ? cap : 0n, sqrtAdjNear: feeAdjust(near, fee), sqrtAdjFar: feeAdjust(far, fee),
    });
    near = far;
  }
  const deepestFar = brackets[brackets.length - 1].sqrtFar;
  const pool: EcoPool = {
    poolType: SwapPoolType.UniV2, address: ZERO, fee, tickSpacing: 0, hooks: ZERO,
    feePpm: fee, isV2: true, inIsToken0: true, stateView: ZERO, poolId: ZERO,
    adaptiveStartShifted: 1n, adaptiveNearReal: deepestFar, adaptiveStartL: 0n, adaptiveStepRatio: 0n,
    topNearReal: spotOI, bracketCount: 0, source: "synthetic",
  };
  return { pool, brackets, spotOI, L };
}

/** Mirror prepare.ts's global ladder sort EXACTLY (adjNear DESC, adjFar DESC, refIdx ASC). */
function sortLadder(brackets: EcoBracket[]): EcoBracket[] {
  return brackets.slice().sort((a, b) => {
    if (a.sqrtAdjNear !== b.sqrtAdjNear) return a.sqrtAdjNear < b.sqrtAdjNear ? 1 : -1;
    if (a.sqrtAdjFar !== b.sqrtAdjFar) return a.sqrtAdjFar < b.sqrtAdjFar ? 1 : -1;
    return a.refIdx - b.refIdx;
  });
}

function assertWeiExact(
  kw: { perPoolInput: bigint[]; totalInput: bigint },
  opt: { perPoolInput: bigint[]; totalInput: bigint },
  label: string,
): void {
  assert.equal(kw.totalInput, opt.totalInput, `${label}: total != oracle`);
  for (let i = 0; i < kw.perPoolInput.length; i++) {
    assert.equal(kw.perPoolInput[i], opt.perPoolInput[i], `${label}: pool[${i}] != oracle`);
  }
}

const E18 = 10n ** 18n;

describe("k-way reference == optimal oracle (no-drift, window covers / dn under-fill)", () => {
  // DEEP flat-L pools so the dn walk fills within SAFETY for the larger sizes.
  const L1 = 2n * 10n ** 24n;
  const L2 = 10n ** 24n;
  const p0 = buildV3(0, 500, 10, L1, 40, 0, true);
  const p1 = buildV3(1, 3000, 60, L2, 40, 0, true);
  const prepared: EcoSwapPrepared = {
    pools: [p0.pool, p1.pool], routes: [], brackets: sortLadder([...p0.brackets, ...p1.brackets]),
    zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
  };
  const optPools: OptimalPool[] = [
    { isV2: false, feePpm: 500, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 10, liquidity: L1, net: new Map() },
    { isV2: false, feePpm: 3000, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 60, liquidity: L2, net: new Map() },
  ];

  for (const amountIn of [100n * E18, 5000n * E18, 50000n * E18]) {
    it(`amountIn=${amountIn} — wei-exact split == oracle`, () => {
      const kw = kwayReference(prepared, amountIn);
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT });
      assert.equal(kw.totalInput, amountIn, "spends amountIn exactly (liquidity allows)");
      assertWeiExact(kw, opt, `no-drift A=${amountIn}`);
      // The cheaper-fee pool 0 always engages; pool 1 joins once the trade is large
      // enough to push pool 0's marginal down to pool 1's spot adjusted price.
      assert.ok(kw.perPoolInput[0] > 0n, "cheaper pool funded");
      if (amountIn >= 5000n * E18) {
        assert.ok(kw.perPoolInput[1] > 0n, "both pools funded for the larger trade");
      }
    });
  }
});

describe("k-way reference == optimal oracle (drift-UP → drift-UP re-anchor)", () => {
  const L1 = 2n * 10n ** 24n;
  const L2 = 10n ** 24n;
  // Both prepared at spot tick 0; pool0 live drifts UP to tick +600 (against the swap).
  const p0 = buildV3(0, 500, 10, L1, 40, 0, true);
  const p1 = buildV3(1, 3000, 60, L2, 40, 0, true);
  const prepared: EcoSwapPrepared = {
    pools: [p0.pool, p1.pool], routes: [], brackets: sortLadder([...p0.brackets, ...p1.brackets]),
    zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
  };
  const driftTick = 600;
  const liveReal0 = getSqrtRatioAtTick(driftTick);
  const live: (KwayLivePool | undefined)[] = [
    { curOI: toOutIn(liveReal0, true), liveRealSqrt: liveReal0, liveTick: driftTick, liveL: L1 },
    undefined,
  ];
  const optPools: OptimalPool[] = [
    { isV2: false, feePpm: 500, sqrtPriceX96: liveReal0, tick: driftTick, tickSpacing: 10, liquidity: L1, net: new Map() },
    { isV2: false, feePpm: 3000, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 60, liquidity: L2, net: new Map() },
  ];
  for (const amountIn of [100n * E18, 5000n * E18]) {
    it(`drift-UP amountIn=${amountIn} — drift-UP re-anchor (spot,top] == oracle, wei-exact`, () => {
      const kw = kwayReference(prepared, amountIn, live);
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT });
      assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
      assertWeiExact(kw, opt, `drift-up A=${amountIn}`);
    });
  }
});

describe("k-way reference == optimal oracle (no-bracket QUOTE path, dn from spot)", () => {
  const L1 = 2n * 10n ** 24n;
  const ts = 10;
  const spotReal = getSqrtRatioAtTick(0);
  const pool: EcoPool = {
    poolType: SwapPoolType.UniV3, address: ZERO, fee: 500, tickSpacing: ts, hooks: ZERO,
    feePpm: 500, isV2: false, inIsToken0: true, stateView: ZERO, poolId: ZERO,
    adaptiveStartShifted: BigInt(0 + Number(OFFSET)), adaptiveNearReal: spotReal, adaptiveStartL: L1,
    adaptiveStepRatio: getSqrtRatioAtTick(ts), topNearReal: spotReal, bracketCount: 0,
    adaptiveNet: new Map<number, bigint>(), source: "synthetic",
  };
  const prepared: EcoSwapPrepared = {
    pools: [pool], routes: [], brackets: [], zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
  };
  const optPools: OptimalPool[] = [
    { isV2: false, feePpm: 500, sqrtPriceX96: spotReal, tick: 0, tickSpacing: ts, liquidity: L1, net: new Map() },
  ];
  for (const amountIn of [100n * E18, 3000n * E18]) {
    it(`empty cache amountIn=${amountIn} — full live walk from spot == oracle, wei-exact`, () => {
      const kw = kwayReference(prepared, amountIn);
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT });
      assert.equal(kw.totalInput, amountIn, "spends amountIn exactly from live data alone (no cache)");
      assertWeiExact(kw, opt, `no-bracket A=${amountIn}`);
    });
  }
});

describe("k-way reference == optimal oracle (V2 prepared window + dn stream)", () => {
  const resIn = 2_000_000n * E18;
  const resOut = 2_000_000n * E18;
  const v2 = buildV2(0, resIn, resOut, 16);
  const prepared: EcoSwapPrepared = {
    pools: [v2.pool], routes: [], brackets: sortLadder(v2.brackets),
    zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
  };
  const live: (KwayLivePool | undefined)[] = [{ curOI: v2.spotOI, liveV2L: v2.L }];
  const optPools: OptimalPool[] = [{ isV2: true, feePpm: 3000, reserveIn: resIn, reserveOut: resOut }];
  for (const amountIn of [100n * E18, 5000n * E18]) {
    it(`V2 amountIn=${amountIn} — window+dn stream == constant-product integral, wei-exact`, () => {
      const kw = kwayReference(prepared, amountIn, live);
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT });
      assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
      assertWeiExact(kw, opt, `V2 A=${amountIn}`);
    });
  }
});

describe("k-way reference == optimal oracle (cross-version V2 + V3 + V4, equal-fee tie)", () => {
  // V3 0.05% (deep) + V4 0.30% + V2 0.30%, all at 1:1. The V4 and V2 first brackets have
  // IDENTICAL fee-adjusted spot price (same 0.30% fee, same spot) — the equal-fee TIE that
  // requires prepare's adjFar/refIdx tie-break to match the oracle's stable sort. Build
  // order V3, V4, V2 mirrors index.ts (refIdx 0,1,2).
  const v3 = buildV3(0, 500, 10, 3_000_000n * E18, 40, 0, true);
  const v4 = buildV3(1, 3000, 60, 3_000_000n * E18, 40, 0, true);
  // Tag pool1 as V4 (geometry identical to V3; the merge treats them the same).
  v4.pool.poolType = SwapPoolType.UniV4;
  const v2 = buildV2(2, 3_000_000n * E18, 3_000_000n * E18, 16);
  const prepared: EcoSwapPrepared = {
    pools: [v3.pool, v4.pool, v2.pool], routes: [],
    brackets: sortLadder([...v3.brackets, ...v4.brackets, ...v2.brackets]),
    zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
  };
  const live: (KwayLivePool | undefined)[] = [undefined, undefined, { curOI: v2.spotOI, liveV2L: v2.L }];
  const optPools: OptimalPool[] = [
    { isV2: false, feePpm: 500, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 10, liquidity: 3_000_000n * E18, net: new Map() },
    { isV2: false, feePpm: 3000, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 60, liquidity: 3_000_000n * E18, net: new Map() },
    { isV2: true, feePpm: 3000, reserveIn: 3_000_000n * E18, reserveOut: 3_000_000n * E18 },
  ];
  for (const amountIn of [20000n * E18, 60000n * E18]) {
    it(`cross-version amountIn=${amountIn} — all 3 funded, wei-exact == oracle (equal-fee tie ordered correctly)`, () => {
      const kw = kwayReference(prepared, amountIn, live);
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT });
      assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
      assertWeiExact(kw, opt, `cross-version A=${amountIn}`);
      assert.ok(kw.perPoolInput.every((v) => v > 0n), "all 3 versions funded");
    });
  }
});

describe("k-way reference == optimal oracle (V2 drift-UP → V2 drift-UP re-anchor)", () => {
  const resIn = 2_000_000n * E18;
  const resOut = 2_000_000n * E18;
  const v2 = buildV2(0, resIn, resOut, 16);
  const prepared: EcoSwapPrepared = {
    pools: [v2.pool], routes: [], brackets: sortLadder(v2.brackets),
    zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
  };
  // Live reserves drifted so the V2 out/in spot is ABOVE the prepared window top (spotOI):
  // a smaller reserveIn (more tokenOut per tokenIn) raises out/in = sqrt(resOut/resIn).
  const driftResIn = (resIn * 90n) / 100n; // -10% reserveIn → out/in spot up ~+5.4%
  const driftL = isqrt(driftResIn * resOut);
  const driftSpotOI = isqrt((resOut * Q192) / driftResIn);
  const live: (KwayLivePool | undefined)[] = [{ curOI: driftSpotOI, liveV2L: driftL }];
  const optPools: OptimalPool[] = [{ isV2: true, feePpm: 3000, reserveIn: driftResIn, reserveOut: resOut }];
  for (const amountIn of [100n * E18, 5000n * E18]) {
    it(`V2 drift-UP amountIn=${amountIn} — V2 drift-UP re-anchor (spot,top] == oracle, wei-exact`, () => {
      const kw = kwayReference(prepared, amountIn, live);
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT });
      assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
      assertWeiExact(kw, opt, `V2 drift-up A=${amountIn}`);
    });
  }
});

// ── V2 DRIFT-DOWN re-anchor (the second remaining blocker) ────────────────
//
// A V2 0.30% pool whose live out/in spot drifted DOWN (below the prepared window top)
// against a deeper V3 0.05% pool at spot. BEFORE the fix the V2 dn frontier kept the
// prepare-time deepestFar seed and competed at feeAdj(deepestFar) — ABOVE the true live
// head feeAdj(liveSpot) — over-funding the drifted V2 pool by up to ~38% at 20% drift
// (and its stale brackets were never skipped). The fix re-anchors the V2 dn frontier to the
// LIVE out/in spot (V2 is constant-L) and stale-skips its prepared brackets above the live
// spot. Continuity gate: 0% drift ⇒ 0 misallocation (cl==topV2OI ⇒ neither branch fires).
describe("k-way reference == optimal oracle (V2 drift-DOWN → re-anchor to live spot)", () => {
  const resIn = 2_000_000n * E18;
  const resOut = 2_000_000n * E18;
  const v3 = buildV3(0, 500, 10, 3_000_000n * E18, 96, 0, true); // deep V3 0.05% at spot
  const v2 = buildV2(1, resIn, resOut, 16); // V2 0.30%, prepared at spot
  const prepared: EcoSwapPrepared = {
    pools: [v3.pool, v2.pool], routes: [], brackets: sortLadder([...v3.brackets, ...v2.brackets]),
    zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
  };
  const amountIn = 200_000n * E18;
  // V2 drifts DOWN: a LARGER reserveIn lowers out/in spot = sqrt(resOut/resIn).
  for (const driftPct of [0n, 10n, 20n]) {
    it(`V2 drift-DOWN ${driftPct}% — re-anchored to live spot == oracle, wei-exact (0% ⇒ 0 misalloc)`, () => {
      const driftResIn = (resIn * (100n + driftPct)) / 100n;
      const driftL = isqrt(driftResIn * resOut);
      const driftSpotOI = isqrt((resOut * Q192) / driftResIn);
      const live: (KwayLivePool | undefined)[] = [undefined, { curOI: driftSpotOI, liveV2L: driftL }];
      const optPools: OptimalPool[] = [
        { isV2: false, feePpm: 500, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 10, liquidity: 3_000_000n * E18, net: new Map() },
        { isV2: true, feePpm: 3000, reserveIn: driftResIn, reserveOut: resOut },
      ];
      const kw = kwayReference(prepared, amountIn, live);
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT });
      assert.equal(kw.totalInput, amountIn, `V2 drift-down ${driftPct}%: spends amountIn exactly`);
      assertWeiExact(kw, opt, `V2 drift-down ${driftPct}%`);
    });
  }
});

// ── B2 CAP-BINDING regression: a fillable trade pushed PAST the per-pool budget ──────────
//
// A single shallow/wide-L V3 pool (ts=10, fee=500, EMPTY cache) sized so the dn walk's reach
// exceeds the PER_POOL=2048 step budget (≈a 7.75× price excursion). The solver's run-until-
// filled merge then HITS the budget and truncates — and the optimal oracle's MAX_V3_STEPS
// (== PER_POOL) truncates IDENTICALLY, so the reach is the SAME (PER_POOL steps) and the split
// is wei-exact EVEN WHEN THE CAP BINDS. This is the exactness guarantee at the cap: a deeper-
// than-budget trade fills to exactly the budget on BOTH the solver and the measuring stick.
describe("k-way reference == optimal oracle (B2 cap-binding: reach == budget on both)", () => {
  const ts = 10;
  const L = 1000n * E18; // shallow enough that the cap binds before fill at large amountIn
  const spotReal = getSqrtRatioAtTick(0);
  const pool: EcoPool = {
    poolType: SwapPoolType.UniV3, address: ZERO, fee: 500, tickSpacing: ts, hooks: ZERO,
    feePpm: 500, isV2: false, inIsToken0: true, stateView: ZERO, poolId: ZERO,
    adaptiveStartShifted: BigInt(0 + Number(OFFSET)), adaptiveNearReal: spotReal, adaptiveStartL: L,
    adaptiveStepRatio: getSqrtRatioAtTick(ts), topNearReal: spotReal, bracketCount: 0,
    adaptiveNet: new Map<number, bigint>(), source: "synthetic",
  };
  const prepared: EcoSwapPrepared = {
    pools: [pool], routes: [], brackets: [], zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
  };
  const optPools: OptimalPool[] = [
    { isV2: false, feePpm: 500, sqrtPriceX96: spotReal, tick: 0, tickSpacing: ts, liquidity: L, net: new Map() },
  ];
  // Sizes that all FAR exceed what PER_POOL=2048 steps can absorb (≈1785e18), so the cap
  // binds for every one and the reach is trade-size-INDEPENDENT (the fixed-cap signature),
  // but the solver and oracle agree on that capped reach to the wei.
  for (const amountIn of [50_000n * E18, 100_000n * E18, 500_000n * E18]) {
    it(`cap binds at amountIn=${amountIn} — reach == PER_POOL budget, solver == oracle wei-exact`, () => {
      const kw = kwayReference(prepared, amountIn);
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT });
      // The cap binds: neither fills amountIn (the reach is the budget, not the trade size).
      assert.ok(kw.totalInput < amountIn, "cap binds (under-fills the over-budget trade)");
      // EXACTNESS AT THE CAP: solver reach == oracle reach to the wei.
      assertWeiExact(kw, opt, `cap-binding A=${amountIn}`);
    });
  }
  // Trade-size-INDEPENDENCE of the capped reach: 100k and 500k cap at the SAME total
  // (the fixed-cap signature), and BOTH equal the oracle.
  it("capped reach is trade-size-independent and == oracle for both sizes", () => {
    const a = kwayReference(prepared, 100_000n * E18);
    const b = kwayReference(prepared, 500_000n * E18);
    const oa = optimalSplit({ pools: optPools, amountIn: 100_000n * E18, zeroForOne: true, priceLimit: PRICE_LIMIT });
    assert.equal(a.totalInput, b.totalInput, "capped reach independent of trade size");
    assert.equal(a.totalInput, oa.totalInput, "capped reach == oracle");
  });
});

// ── B1/B2/B3: NON-EMPTY net (L change) + drift-DOWN MID-GRID ──────────────
//
// The vectors above all use net=new Map() (constant L) and only drift UP — exactly the
// regime that hid the blockers. These two pools instead carry a genuine initialized-tick
// L change, and the engaged pool0 drifts DOWN to a true MID-GRID live tick (not a tickSpacing
// multiple). With the prepared cache spot-anchored, the merge must (B3) RE-ANCHOR pool0's dn
// frontier to the LIVE tick lattice (drift-down) instead of consuming stale spot brackets,
// (B1) compete pool0 at its TRUE live head, and (B2) run-until-filled past the old fixed cap.
// kwayReference must equal optimalSplit (built from the SAME post-drift live state) to the wei.
describe("k-way reference == optimal oracle (drift-DOWN mid-grid + initialized-tick L change)", () => {
  const TS0 = 10, FEE0 = 500, TS1 = 60, FEE1 = 3000;
  const LCHANGE = -2000;
  const L0_BASE = 4n * 10n ** 24n;
  const L0_NARROW = 6n * 10n ** 24n;
  const L0_START = L0_BASE + L0_NARROW; // active L above LCHANGE
  const L1 = 2n * 10n ** 24n;
  // pool0 net: +narrow at LCHANGE (add-from-below), +base at -60000, -(both) at the top edge.
  const NET0 = new Map<number, bigint>([
    [LCHANGE, L0_NARROW],
    [-60000, L0_BASE],
    [60000, -(L0_BASE + L0_NARROW)],
  ]);
  const NBR = 96; // a deep window (no trim in the reference vectors → seed is contiguous)

  // The drift-DOWN MID-GRID live override for pool0: a true non-ts-multiple tick.
  const DRIFT_TICK = -199;
  const driftReal0 = getSqrtRatioAtTick(DRIFT_TICK);

  function build(): EcoSwapPrepared {
    const p0 = buildV3WithNet(0, FEE0, TS0, L0_START, NET0, NBR, 0, true);
    const p1 = buildV3WithNet(1, FEE1, TS1, L1, new Map<number, bigint>(), NBR, 0, true);
    return {
      pools: [p0.pool, p1.pool], routes: [],
      brackets: sortLadder([...p0.brackets, ...p1.brackets]),
      zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
    };
  }
  // pool0 drifted DOWN to a mid-grid live tick; pool1 undrifted.
  const live: (KwayLivePool | undefined)[] = [
    { curOI: toOutIn(driftReal0, true), liveRealSqrt: driftReal0, liveTick: DRIFT_TICK, liveL: L0_START },
    undefined,
  ];
  function optPools(): OptimalPool[] {
    return [
      { isV2: false, feePpm: FEE0, sqrtPriceX96: driftReal0, tick: DRIFT_TICK, tickSpacing: TS0, liquidity: L0_START, net: NET0 },
      { isV2: false, feePpm: FEE1, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: TS1, liquidity: L1, net: new Map() },
    ];
  }

  // (1) drift-down mid-grid, cut stays ABOVE LCHANGE (no L cross).
  // (2) drift-down mid-grid, cut CROSSES LCHANGE (L drops 1e7→4e6 mid-fill).
  // (4) LARGE run-until-filled (deep walk well past the old 1024 cap).
  for (const [tag, amountIn] of [
    ["no L-cross", 50_000n * E18],
    ["crossing L change", 5_000_000n * E18],
    ["LARGE run-until-filled", 9_000_000n * E18],
  ] as const) {
    it(`drift-DOWN mid-grid (${tag}) amountIn=${amountIn} — kwayReference == oracle, wei-exact`, () => {
      const prepared = build();
      const kw = kwayReference(prepared, amountIn, live);
      const opt = optimalSplit({ pools: optPools(), amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT });
      assert.equal(kw.totalInput, amountIn, `${tag}: spends amountIn exactly`);
      assertWeiExact(kw, opt, `drift-down mid-grid ${tag} A=${amountIn}`);
      assert.ok(kw.perPoolInput[0] > 0n && kw.perPoolInput[1] > 0n, `${tag}: both pools funded`);
    });
  }

  // (3) NO-drift regression guard: cut crosses LCHANGE, no drift override → constant-anchor
  // path must still equal the oracle (guards the B1 static-key fix doesn't regress no-drift).
  it("no-drift, cut crosses the L change — kwayReference == oracle, wei-exact (regression guard)", () => {
    const prepared = build();
    const amountIn = 5_000_000n * E18;
    const kw = kwayReference(prepared, amountIn); // no live override
    const opt = optimalSplit({
      pools: [
        { isV2: false, feePpm: FEE0, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: TS0, liquidity: L0_START, net: NET0 },
        { isV2: false, feePpm: FEE1, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: TS1, liquidity: L1, net: new Map() },
      ],
      amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT,
    });
    assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
    assertWeiExact(kw, opt, "no-drift L-change A=5M");
  });

  // (5) EMPTY-cache drift-down mid-grid (the quote / no-cache path): NBR=0 ⇒ no prepared
  // brackets AND the dn seed is the SPOT seed (exactly what prepare stamps at maxTicks:0),
  // so the dn frontier does everything from the LIVE drifted price + spot. Must equal oracle.
  // (Building with NBR=0 keeps the seed CONTIGUOUS with the empty cache — no seed/cache gap.)
  it("EMPTY cache + drift-down mid-grid — kwayReference == oracle from live alone, wei-exact", () => {
    const p0 = buildV3WithNet(0, FEE0, TS0, L0_START, NET0, 0, 0, true);
    const p1 = buildV3WithNet(1, FEE1, TS1, L1, new Map<number, bigint>(), 0, 0, true);
    const noCache: EcoSwapPrepared = {
      pools: [p0.pool, p1.pool], routes: [], brackets: [],
      zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
    };
    const amountIn = 5_000_000n * E18;
    const kw = kwayReference(noCache, amountIn, live);
    const opt = optimalSplit({ pools: optPools(), amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT });
    assert.equal(kw.totalInput, amountIn, "spends amountIn exactly from live data alone");
    assertWeiExact(kw, opt, "empty-cache drift-down L-change A=5M");
  });
});

// ── MATRIX CLOSURE: L-change on the STEADY pool, ALIGNED drift-down, fully-out-of-range ──
//
// The block above carries an initialized-tick L change only on the DRIFTED pool (pool0); the
// STEADY pool (pool1) is wide constant-L. The spec wants the L-change axis covered for BOTH
// the drifted AND the steady pool, plus an ALIGNED (tickSpacing-multiple) drift-down (the prior
// drift cases all land mid-grid), plus a FULLY-OUT-OF-RANGE pool (live price entirely below all
// its prepared brackets ⇒ the whole cache is stale-skipped and only the live dn-frontier
// engages). These close the last drift × L-change × range quadrants on the fast tier.
describe("k-way reference == optimal oracle (L-change on BOTH pools, aligned drift-down, OOR)", () => {
  const TS0 = 10, FEE0 = 500, TS1 = 60, FEE1 = 3000;
  // pool0 (drifted) L change at LC0; pool1 (STEADY) ALSO carries an L change at LC1 crossed
  // inside the fill — so the steady pool's active L drops mid-trade too (the previously
  // uncovered "L change on the steady pool" quadrant).
  const LC0 = -2000;
  const LC1 = -3000; // pool1's L-change tick (a TS1=60 multiple) — crossed by the larger fills
  const L0_BASE = 4n * 10n ** 24n;
  const L0_NARROW = 6n * 10n ** 24n;
  const L0_START = L0_BASE + L0_NARROW;
  const L1_BASE = 1n * 10n ** 24n;
  const L1_NARROW = 2n * 10n ** 24n;
  const L1_START = L1_BASE + L1_NARROW;
  const NET0 = new Map<number, bigint>([
    [LC0, L0_NARROW], [-60000, L0_BASE], [60000, -(L0_BASE + L0_NARROW)],
  ]);
  const NET1 = new Map<number, bigint>([
    [LC1, L1_NARROW], [-60000, L1_BASE], [60000, -(L1_BASE + L1_NARROW)],
  ]);
  const NBR = 96;

  function build(): EcoSwapPrepared {
    const p0 = buildV3WithNet(0, FEE0, TS0, L0_START, NET0, NBR, 0, true);
    const p1 = buildV3WithNet(1, FEE1, TS1, L1_START, NET1, NBR, 0, true);
    return {
      pools: [p0.pool, p1.pool], routes: [],
      brackets: sortLadder([...p0.brackets, ...p1.brackets]),
      zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
    };
  }

  // (A) ALIGNED drift-down: pool0 drifts DOWN to a true tickSpacing multiple (-200, a TS0=10
  // multiple), large enough that the cut crosses BOTH pools' L changes (LC0=-2000, LC1=-3000).
  const ALIGNED_TICK = -200;
  const alignedReal0 = getSqrtRatioAtTick(ALIGNED_TICK);
  it("ALIGNED drift-down (ts multiple) + L change on BOTH pools crossed — kwayReference == oracle, wei-exact", () => {
    const prepared = build();
    const amountIn = 9_000_000n * E18; // deep enough to cross LC1=-3000 on the steady pool too
    const live: (KwayLivePool | undefined)[] = [
      { curOI: toOutIn(alignedReal0, true), liveRealSqrt: alignedReal0, liveTick: ALIGNED_TICK, liveL: L0_START },
      undefined,
    ];
    const kw = kwayReference(prepared, amountIn, live);
    const opt = optimalSplit({
      pools: [
        { isV2: false, feePpm: FEE0, sqrtPriceX96: alignedReal0, tick: ALIGNED_TICK, tickSpacing: TS0, liquidity: L0_START, net: NET0 },
        { isV2: false, feePpm: FEE1, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: TS1, liquidity: L1_START, net: NET1 },
      ],
      amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT,
    });
    assert.ok(ALIGNED_TICK % TS0 === 0, "drift tick is ts-aligned");
    assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
    assertWeiExact(kw, opt, "aligned drift-down both-L-change A=9M");
    assert.ok(kw.perPoolInput[0] > 0n && kw.perPoolInput[1] > 0n, "both pools funded across both L changes");
  });

  // (B) FULLY-OUT-OF-RANGE: pool0's live price drifts DOWN so far that it is BELOW the deepest
  // prepared bracket (the whole cache is stale → skipped), so pool0 engages ONLY via the live
  // dn-frontier re-anchored from the deep live spot. The steady pool1 fills the rest. This is
  // the "fully out of range" drift case the spec calls out — the cache contributes nothing for
  // the drifted pool and the solver must be optimal from the live frontier alone.
  it("FULLY-OUT-OF-RANGE drifted pool (cache fully stale) → live dn-frontier only — kwayReference == oracle, wei-exact", () => {
    const prepared = build();
    const amountIn = 2_000_000n * E18;
    // Drift pool0 WAY down — below the deepest prepared bracket far edge (≈ tick -NBR*TS0 with
    // multiplicative geometry; -20000 is well past the 96-bracket window so the cache is stale).
    const OOR_TICK = -20000;
    const oorReal0 = getSqrtRatioAtTick(OOR_TICK);
    const live: (KwayLivePool | undefined)[] = [
      { curOI: toOutIn(oorReal0, true), liveRealSqrt: oorReal0, liveTick: OOR_TICK, liveL: L0_BASE }, // L past LC0 ⇒ base only
      undefined,
    ];
    // Sanity: the live price IS below the deepest prepared bracket far edge (cache fully stale).
    const deepestFar = prepared.pools[0].adaptiveNearReal!; // the post-window dn seed near == window bottom
    assert.ok(oorReal0 < deepestFar, "OOR live price below the deepest prepared bracket (cache fully stale)");
    const kw = kwayReference(prepared, amountIn, live);
    const opt = optimalSplit({
      pools: [
        { isV2: false, feePpm: FEE0, sqrtPriceX96: oorReal0, tick: OOR_TICK, tickSpacing: TS0, liquidity: L0_BASE, net: NET0 },
        { isV2: false, feePpm: FEE1, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: TS1, liquidity: L1_START, net: NET1 },
      ],
      amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT,
    });
    assert.equal(kw.totalInput, amountIn, "spends amountIn exactly from the live frontier alone");
    assertWeiExact(kw, opt, "fully-OOR drift-down A=2M");
  });
});

// ── D1: V2 DRIFT-UP COMPETING in a multi-pool merge (the grid-splice quadrant) ──────────
//
// The existing V2-drift-UP block above is SINGLE-POOL — the splice never mis-orders a
// cross-pool merge because there is no competitor. The D1 defect lives in the uncovered
// {DRIFT-UP × V2 × multi-pool} quadrant: a V2 0.30% pool prepared at spot competes with a
// deep V3 0.05% pool, then the V2 live spot drifts UP. The OLD up-frontier clamped the
// straddling up-slice to the prepare-time window top (topV2OI) and handed off to the
// prepared brackets anchored at the prepare-time spot — SPLICING two geometric grids that
// (for generic drift) do NOT share a boundary. The clamped partial slice then spanned a
// different near→far than the oracle's single clean grid from the live spot, giving a
// different fee-adjusted-near MERGE KEY → mis-ordered cross-pool merge → ~0.5-0.8%
// misallocation. The FIX re-anchors the V2 single geometric grid to the LIVE spot (consume
// it as one continuous dn stream, dropping the spliced up→prepared clamp), matching the
// oracle's single from-live-spot grid. INVARIANT to bracket depth (NOT a shallow-window
// artifact), 0 misallocation at 0% drift (continuity), wei-exact at every drift.
describe("k-way reference == optimal oracle (V2 drift-UP COMPETING — re-anchor single grid)", () => {
  const resIn = 1_000_000n * E18;
  const resOut = 1_000_000n * E18;
  const amountIn = 200_000n * E18; // large enough to push the deep V3 down to the V2 grid
  // Deep V3 0.05% at spot tick 0 (undrifted) + V2 0.30% prepared at spot, then V2 drifts UP.
  for (const driftPct of [0n, 1n, 2n, 5n, 10n, 12n, 20n]) {
    for (const nBr of [16, 64, 200]) {
      it(`V2 drift-UP ${driftPct}% (nBr=${nBr}) competing vs deep V3 — re-anchored == oracle, wei-exact`, () => {
        const v3 = buildV3(0, 500, 10, 2_000_000n * E18, 96, 0, true);
        const v2 = buildV2(1, resIn, resOut, nBr);
        const prepared: EcoSwapPrepared = {
          pools: [v3.pool, v2.pool], routes: [], brackets: sortLadder([...v3.brackets, ...v2.brackets]),
          zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
        };
        // V2 live drifts UP: a SMALLER reserveIn raises out/in spot = sqrt(resOut/resIn).
        const driftResIn = (resIn * (100n - driftPct)) / 100n;
        const driftL = isqrt(driftResIn * resOut);
        const driftSpotOI = isqrt((resOut * Q192) / driftResIn);
        const live: (KwayLivePool | undefined)[] = [undefined, { curOI: driftSpotOI, liveV2L: driftL }];
        const optPools: OptimalPool[] = [
          { isV2: false, feePpm: 500, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 10, liquidity: 2_000_000n * E18, net: new Map() },
          { isV2: true, feePpm: 3000, reserveIn: driftResIn, reserveOut: resOut },
        ];
        const kw = kwayReference(prepared, amountIn, live);
        const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT });
        assert.equal(kw.totalInput, amountIn, `V2 drift-up competing ${driftPct}%/${nBr}: spends amountIn exactly`);
        assertWeiExact(kw, opt, `V2 drift-up competing ${driftPct}%/${nBr}`);
        if (driftPct === 0n) {
          // continuity: at 0% drift the V2 share is exactly the no-drift baseline.
          const base = optimalSplit({
            pools: [optPools[0], { isV2: true, feePpm: 3000, reserveIn: resIn, reserveOut: resOut }],
            amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT,
          });
          assert.equal(kw.perPoolInput[1], base.perPoolInput[1], "0% drift ⇒ V2 share == no-drift baseline");
        }
      });
    }
  }
});

// ── D2: B2 CAP-BINDING with a NON-EMPTY cache (window + up + dn share ONE budget) ─────────
//
// The existing B2 cap-binding block uses an EMPTY cache (maxTicks:0), so the dn frontier
// alone walks the whole reach — which hid the defect. With a NON-EMPTY cache the prepared
// window brackets were consumed via the merge cursor WITHOUT counting against the per-pool
// dnSteps budget, while the dn frontier resumed from the post-window seed and walked a FULL
// PER_POOL more steps. So a cached pool reached (K window brackets) + (PER_POOL dn steps) =
// DEEPER than the oracle's single from-spot loop bounded by MAX_V3_STEPS == PER_POOL → it
// over-filled at the cap, growing with K. The FIX counts a consumed window bracket against
// the SAME per-pool budget as dn (and skip-advances the cursor for an over-budget pool), so
// window + up + dn together are bounded by PER_POOL == the oracle MAX_V3_STEPS — solver ==
// oracle at the cap for BOTH empty AND non-empty cache.
describe("k-way reference == optimal oracle (D2 cap-binding WITH a non-empty cache)", () => {
  const ts = 10;
  const L = 1000n * E18; // shallow/wide ⇒ the cap binds before fill at large amountIn
  const spotReal = getSqrtRatioAtTick(0);
  const optPools: OptimalPool[] = [
    { isV2: false, feePpm: 500, sqrtPriceX96: spotReal, tick: 0, tickSpacing: ts, liquidity: L, net: new Map() },
  ];
  // amountIn far exceeds what PER_POOL steps can absorb on this L (≈1785e18), so the cap
  // binds; the reach must equal the oracle's capped reach to the wei REGARDLESS of K (the
  // non-empty cache must NOT push the pool deeper than the empty-cache / oracle reach).
  for (const nBr of [0, 1, 40, 96, 255]) {
    for (const amountIn of [50_000n * E18, 1_000_000n * E18]) {
      it(`cap binds, cache nBr=${nBr}, amountIn=${amountIn} — reach == PER_POOL budget, solver == oracle wei-exact`, () => {
        const v3 = buildV3(0, 500, ts, L, nBr, 0, true);
        const prepared: EcoSwapPrepared = {
          pools: [v3.pool], routes: [], brackets: sortLadder(v3.brackets),
          zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
        };
        const kw = kwayReference(prepared, amountIn);
        const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT });
        // The cap binds: the reach is the budget, not the trade.
        assert.ok(kw.totalInput < amountIn, `cache nBr=${nBr}: cap binds (under-fills the over-budget trade)`);
        // EXACTNESS AT THE CAP, with a cache: solver reach == oracle reach to the wei.
        assertWeiExact(kw, opt, `D2 cap-binding nBr=${nBr} A=${amountIn}`);
      });
    }
  }
  // Cache-INDEPENDENCE of the capped reach: empty (nBr=0) and deep (nBr=96) caps cap at the
  // SAME total (the window must not deepen the reach), and BOTH equal the oracle.
  it("capped reach is independent of cache depth and == oracle", () => {
    const amountIn = 1_000_000n * E18;
    const empty = kwayReference(
      { pools: [buildV3(0, 500, ts, L, 0, 0, true).pool], routes: [], brackets: [], zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n },
      amountIn,
    );
    const deepP = buildV3(0, 500, ts, L, 96, 0, true);
    const deep = kwayReference(
      { pools: [deepP.pool], routes: [], brackets: sortLadder(deepP.brackets), zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n },
      amountIn,
    );
    const oracle = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT });
    assert.equal(empty.totalInput, deep.totalInput, "capped reach independent of cache depth");
    assert.equal(empty.totalInput, oracle.totalInput, "capped reach == oracle");
  });
});

// ── DRIFT-UP × CAP-BINDING: the up + dn budget unification (the {drift-up × cap} quadrant) ──
//
// The DEFECT: upSteps[] and dnSteps[] were TWO INDEPENDENT per-pool PER_POOL=2048 budgets. A
// pool drifted UP (against the swap) burned up-steps from the LIVE spot down to the prepared
// window top, THEN got a FRESH full PER_POOL for window+dn below — so its TOTAL reach was
// up-steps + PER_POOL (up to ~2× budget). The optimal oracle (v3Segments) instead walks a
// SINGLE MAX_V3_STEPS loop FROM THE LIVE (drifted) SPOT — its up+window+dn share ONE budget.
// So at the cap the drifted pool OVER-REACHED vs the oracle by exactly the burned up-steps,
// scrambling the cross-pool split at the cut (confirmed: +600t → +4.75%, +5000t → +44%,
// +12000t → +128% over). The FIX unifies up+window+dn into ONE SHARED per-pool budget
// (dnSteps), so the reach is bounded by PER_POOL from the LIVE spot == the oracle's single
// MAX_V3_STEPS loop → solver == oracle to the wei EVEN WHEN THE CAP BINDS, for drift-UP.
//
// These vectors are production-reachable: a large/out-of-range run-until-filled trade against
// a pool that drifted up (against-swap drift), and the empty-cache QUOTE path (prepare always
// stamps topNearReal=spotReal, so a drifted-up live spot triggers the up frontier even with
// no cache). Both single-pool (the defect in isolation) and multi-pool (the scrambled cut).
describe("k-way reference == optimal oracle (drift-UP × cap-binding — shared up+dn budget)", () => {
  const ts = 10;
  const SHALLOW_L = 1000n * E18; // shallow ⇒ a from-live-spot 2048-step walk under-fills a big trade
  // amountIn FAR exceeds what PER_POOL=2048 steps absorb from ANY spot on this L, so the cap
  // binds for every drift. The DEFECT made the drifted pool reach up-steps + PER_POOL; the fix
  // bounds it to PER_POOL from the live spot == the oracle. Drift ticks span the spec's repro
  // points (+600, +5000, +12000 — where the OLD over-reach was +4.75%, +44%, +128%).
  for (const driftTick of [600, 5000, 12000]) {
    const liveReal = getSqrtRatioAtTick(driftTick);

    // (A) SINGLE-POOL drift-up cap-binding: the defect in isolation. The pool drifted up by
    // driftTick; with the cap binding, the reach must be PER_POOL steps FROM THE LIVE SPOT
    // (== the oracle), NOT up-steps + PER_POOL. Both empty-cache (quote) and a deep cache.
    for (const nBr of [0, 96]) {
      for (const amountIn of [200_000n * E18, 1_000_000n * E18]) {
        it(`single-pool drift +${driftTick}t × cap (nBr=${nBr}) amountIn=${amountIn} — reach == PER_POOL from live spot == oracle, wei-exact`, () => {
          const p = buildV3(0, 500, ts, SHALLOW_L, nBr, 0, true);
          const prepared: EcoSwapPrepared = {
            pools: [p.pool], routes: [], brackets: sortLadder(p.brackets),
            zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
          };
          const live: (KwayLivePool | undefined)[] = [
            { curOI: toOutIn(liveReal, true), liveRealSqrt: liveReal, liveTick: driftTick, liveL: SHALLOW_L },
          ];
          const kw = kwayReference(prepared, amountIn, live);
          const opt = optimalSplit({
            pools: [{ isV2: false, feePpm: 500, sqrtPriceX96: liveReal, tick: driftTick, tickSpacing: ts, liquidity: SHALLOW_L, net: new Map() }],
            amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT,
          });
          // The cap binds: the reach is the (shared) budget from the live spot, not the trade.
          assert.ok(kw.totalInput < amountIn, `drift +${driftTick}t nBr=${nBr}: cap binds`);
          // EXACTNESS AT THE CAP under drift-up: the unified budget bounds the reach to PER_POOL
          // from the live spot == the oracle's single MAX_V3_STEPS loop. (OLD: up-steps + PER_POOL.)
          assertWeiExact(kw, opt, `drift-up +${driftTick}t cap single nBr=${nBr} A=${amountIn}`);
        });
      }
    }

    // (B) MULTI-POOL drift-up cap-binding: the scrambled cross-pool cut. A drifted-up shallow
    // pool0 competes with a deeper undrifted pool1; with pool0 capped, the OLD over-reach pushed
    // pool0 past the oracle's cut and stole share from pool1 (the split was scrambled at the
    // cut). The shared budget restores the exact split.
    for (const amountIn of [400_000n * E18, 2_000_000n * E18]) {
      it(`multi-pool drift +${driftTick}t × cap amountIn=${amountIn} — split at the cut == oracle, wei-exact`, () => {
        const p0 = buildV3(0, 500, ts, SHALLOW_L, 96, 0, true); // shallow, drifts up
        const p1 = buildV3(1, 500, ts, 50_000n * E18, 96, 0, true); // deeper, undrifted (equal fee)
        const prepared: EcoSwapPrepared = {
          pools: [p0.pool, p1.pool], routes: [], brackets: sortLadder([...p0.brackets, ...p1.brackets]),
          zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
        };
        const live: (KwayLivePool | undefined)[] = [
          { curOI: toOutIn(liveReal, true), liveRealSqrt: liveReal, liveTick: driftTick, liveL: SHALLOW_L },
          undefined,
        ];
        const kw = kwayReference(prepared, amountIn, live);
        const opt = optimalSplit({
          pools: [
            { isV2: false, feePpm: 500, sqrtPriceX96: liveReal, tick: driftTick, tickSpacing: ts, liquidity: SHALLOW_L, net: new Map() },
            { isV2: false, feePpm: 500, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: ts, liquidity: 50_000n * E18, net: new Map() },
          ],
          amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT,
        });
        // Both engaged: the drifted shallow pool0 caps; the deeper pool1 absorbs the rest at the cut.
        assert.ok(kw.perPoolInput[0] > 0n && kw.perPoolInput[1] > 0n, "both pools funded");
        // The defect was a per-pool over-reach on the DRIFTED pool → wrong cross-pool split.
        assertWeiExact(kw, opt, `drift-up +${driftTick}t cap multi A=${amountIn}`);
      });
    }
  }
});

// ── oneForZero (zeroForOne === false) reference == oracle ──────────────────────────────
//
// COVERAGE GAP (spec item 2): every block above runs zeroForOne=true. The kwayReference math
// is direction-parametric (toOutIn = Q192/sqrt, stepReal up-direction, tickArg negatives), so
// these mirror the representative scenarios with zeroForOne=false — no-drift multi-V3, drift-UP
// (up frontier), drift-DOWN (dn re-anchor), V2, and cap-binding — proving the reference is
// wei-exact == the oracle on the oneForZero side too. (The compiled-bytecode oneForZero path is
// the genuine unknown the EVM lane H1–H6 + C2-V4 cells close; this fast block pins the math.)
//
// oneForZero geometry: the swap walks ticks UP, so a pool "drifts UP" (against the swap, → up
// frontier) when its live out/in spot is ABOVE the prepared window top, i.e. its REAL price has
// fallen. We model that directly via the live override (lower liveRealSqrt). The oneForZero
// price extreme is MAX_SQRT_RATIO − 1 (the dn-walk guard upper bound).
describe("k-way reference == optimal oracle (oneForZero — direction symmetry)", () => {
  const PRICE_LIMIT_O4O = 1461446703485210103287273052203988822378723970341n; // MAX_SQRT_RATIO − 1
  const L1 = 2n * 10n ** 24n;
  const L2 = 10n ** 24n;

  // (1) no-drift multi-V3 split.
  {
    const p0 = buildV3(0, 500, 10, L1, 40, 0, false);
    const p1 = buildV3(1, 3000, 60, L2, 40, 0, false);
    const prepared: EcoSwapPrepared = {
      pools: [p0.pool, p1.pool], routes: [], brackets: sortLadder([...p0.brackets, ...p1.brackets]),
      zeroForOne: false, priceLimit: PRICE_LIMIT_O4O, expectedInputCovered: 0n,
    };
    const optPools: OptimalPool[] = [
      { isV2: false, feePpm: 500, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 10, liquidity: L1, net: new Map() },
      { isV2: false, feePpm: 3000, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 60, liquidity: L2, net: new Map() },
    ];
    for (const amountIn of [5000n * E18, 50000n * E18]) {
      it(`oneForZero no-drift multi-V3 amountIn=${amountIn} — wei-exact split == oracle`, () => {
        const kw = kwayReference(prepared, amountIn);
        const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: false, priceLimit: PRICE_LIMIT_O4O });
        assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
        assertWeiExact(kw, opt, `o4o no-drift A=${amountIn}`);
        assert.ok(kw.perPoolInput[0] > 0n && kw.perPoolInput[1] > 0n, "both pools funded");
      });
    }
  }

  // (2) drift-UP (up frontier): pool0's REAL price falls (live out/in spot ABOVE the window top).
  {
    const p0 = buildV3(0, 500, 10, L1, 40, 0, false);
    const p1 = buildV3(1, 3000, 60, L2, 40, 0, false);
    const prepared: EcoSwapPrepared = {
      pools: [p0.pool, p1.pool], routes: [], brackets: sortLadder([...p0.brackets, ...p1.brackets]),
      zeroForOne: false, priceLimit: PRICE_LIMIT_O4O, expectedInputCovered: 0n,
    };
    const driftTick = -600; // REAL price down ⇒ out/in spot UP (against the oneForZero swap)
    const liveReal0 = getSqrtRatioAtTick(driftTick);
    const live: (KwayLivePool | undefined)[] = [
      { curOI: toOutIn(liveReal0, false), liveRealSqrt: liveReal0, liveTick: driftTick, liveL: L1 },
      undefined,
    ];
    const optPools: OptimalPool[] = [
      { isV2: false, feePpm: 500, sqrtPriceX96: liveReal0, tick: driftTick, tickSpacing: 10, liquidity: L1, net: new Map() },
      { isV2: false, feePpm: 3000, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 60, liquidity: L2, net: new Map() },
    ];
    for (const amountIn of [100n * E18, 5000n * E18]) {
      it(`oneForZero drift-UP amountIn=${amountIn} — up frontier == oracle, wei-exact`, () => {
        const kw = kwayReference(prepared, amountIn, live);
        const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: false, priceLimit: PRICE_LIMIT_O4O });
        assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
        assertWeiExact(kw, opt, `o4o drift-up A=${amountIn}`);
      });
    }
  }

  // (3) drift-DOWN (dn re-anchor): pool0's REAL price rises (live out/in spot BELOW the window top).
  {
    const p0 = buildV3(0, 500, 10, L1, 96, 0, false);
    const p1 = buildV3(1, 3000, 60, L2, 96, 0, false);
    const prepared: EcoSwapPrepared = {
      pools: [p0.pool, p1.pool], routes: [], brackets: sortLadder([...p0.brackets, ...p1.brackets]),
      zeroForOne: false, priceLimit: PRICE_LIMIT_O4O, expectedInputCovered: 0n,
    };
    const driftTick = 600; // REAL price up ⇒ out/in spot DOWN (with the oneForZero swap)
    const liveReal0 = getSqrtRatioAtTick(driftTick);
    const live: (KwayLivePool | undefined)[] = [
      { curOI: toOutIn(liveReal0, false), liveRealSqrt: liveReal0, liveTick: driftTick, liveL: L1 },
      undefined,
    ];
    const optPools: OptimalPool[] = [
      { isV2: false, feePpm: 500, sqrtPriceX96: liveReal0, tick: driftTick, tickSpacing: 10, liquidity: L1, net: new Map() },
      { isV2: false, feePpm: 3000, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 60, liquidity: L2, net: new Map() },
    ];
    for (const amountIn of [5000n * E18, 50000n * E18]) {
      it(`oneForZero drift-DOWN amountIn=${amountIn} — dn re-anchor == oracle, wei-exact`, () => {
        const kw = kwayReference(prepared, amountIn, live);
        const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: false, priceLimit: PRICE_LIMIT_O4O });
        assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
        assertWeiExact(kw, opt, `o4o drift-down A=${amountIn}`);
      });
    }
  }

  // (4) V2 window + dn stream (constant-product), oneForZero.
  {
    const resIn = 2_000_000n * E18;
    const resOut = 2_000_000n * E18;
    const v2 = buildV2(0, resIn, resOut, 16);
    const prepared: EcoSwapPrepared = {
      pools: [v2.pool], routes: [], brackets: sortLadder(v2.brackets),
      zeroForOne: false, priceLimit: PRICE_LIMIT_O4O, expectedInputCovered: 0n,
    };
    const live: (KwayLivePool | undefined)[] = [{ curOI: v2.spotOI, liveV2L: v2.L }];
    const optPools: OptimalPool[] = [{ isV2: true, feePpm: 3000, reserveIn: resIn, reserveOut: resOut }];
    for (const amountIn of [100n * E18, 5000n * E18]) {
      it(`oneForZero V2 amountIn=${amountIn} — window+dn == constant-product integral, wei-exact`, () => {
        const kw = kwayReference(prepared, amountIn, live);
        const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: false, priceLimit: PRICE_LIMIT_O4O });
        assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
        assertWeiExact(kw, opt, `o4o V2 A=${amountIn}`);
      });
    }
  }

  // (5) cap-binding (empty cache): a shallow/wide V3 pool whose from-spot reach exceeds PER_POOL.
  {
    const ts = 10;
    const L = 1000n * E18;
    const spotReal = getSqrtRatioAtTick(0);
    const pool: EcoPool = {
      poolType: SwapPoolType.UniV3, address: ZERO, fee: 500, tickSpacing: ts, hooks: ZERO,
      feePpm: 500, isV2: false, inIsToken0: false, stateView: ZERO, poolId: ZERO,
      adaptiveStartShifted: BigInt(0 + Number(OFFSET)), adaptiveNearReal: spotReal, adaptiveStartL: L,
      adaptiveStepRatio: getSqrtRatioAtTick(ts), topNearReal: spotReal, bracketCount: 0,
      adaptiveNet: new Map<number, bigint>(), source: "synthetic",
    };
    const prepared: EcoSwapPrepared = {
      pools: [pool], routes: [], brackets: [], zeroForOne: false, priceLimit: PRICE_LIMIT_O4O, expectedInputCovered: 0n,
    };
    const optPools: OptimalPool[] = [
      { isV2: false, feePpm: 500, sqrtPriceX96: spotReal, tick: 0, tickSpacing: ts, liquidity: L, net: new Map() },
    ];
    for (const amountIn of [100_000n * E18, 500_000n * E18]) {
      it(`oneForZero cap-binding amountIn=${amountIn} — reach == PER_POOL budget, wei-exact == oracle`, () => {
        const kw = kwayReference(prepared, amountIn);
        const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: false, priceLimit: PRICE_LIMIT_O4O });
        assert.ok(kw.totalInput < amountIn, "cap binds (under-fills the over-budget trade)");
        assertWeiExact(kw, opt, `o4o cap-binding A=${amountIn}`);
      });
    }
  }
});

// ── DRIFT-UP RE-ANCHOR (the clamp-splice fix): symmetric to drift-DOWN, both directions ──
//
// The old code handled a drifted-UP V3/V4 pool with a separate `up` frontier that walked the
// live grid DOWN and then CLAMPED the final segment to the tick-aligned window top, handing off
// to the prepared window brackets anchored at a DIFFERENT sqrt. Because the oracle walks ONE
// continuous multiplicative grid from the live spot and NEVER clamps, that splice mis-priced the
// handoff heads, with two production-reachable manifestations:
//   (a) oneForZero × drift-UP × cap-binding: a Q192/sqrt inversion double-rounds the handoff →
//       the capped reach UNDER-fills the oracle by ~0.08%.
//   (b) EQUAL-FEE multi-pool × drift-UP (non-cap, fully fills): the mis-priced clamped up-slice
//       wins/loses the merge tie wrong → ~0.3-0.6% of the up-region routes to the WRONG pool.
// The FIX re-anchors a drifted-UP V3/V4 pool's WHOLE walk to the live spot (dn frontier from the
// live tick) and stale-skips its prepared cache — EXACTLY as drift-DOWN already does — so the
// walk is ONE continuous from-live-spot grid == the oracle, for BOTH drift directions and both
// swap directions, cap-binding or not.
describe("k-way reference == optimal oracle (drift-UP re-anchor — clamp-splice removed)", () => {
  const ts = 10;
  const SHALLOW_L = 1000n * E18; // shallow ⇒ a from-live-spot 2048-step walk under-fills a big trade

  // (a) oneForZero × drift-UP × cap-binding — the ~0.08% under-fill quadrant. A pool whose REAL
  // price has FALLEN (out/in spot ABOVE the window top, against the oneForZero swap), with the
  // cap binding, must reach EXACTLY PER_POOL steps FROM THE LIVE SPOT == the oracle, wei-exact.
  const PRICE_LIMIT_O4O = 1461446703485210103287273052203988822378723970341n; // MAX_SQRT_RATIO − 1
  for (const driftTick of [-600, -5000]) {
    const liveReal = getSqrtRatioAtTick(driftTick); // REAL price down ⇒ out/in spot UP
    for (const nBr of [0, 96]) {
      for (const amountIn of [200_000n * E18, 500_000n * E18]) {
        it(`(a) oneForZero drift-UP ${driftTick}t × cap (nBr=${nBr}) amountIn=${amountIn} — re-anchored == oracle, wei-exact`, () => {
          const p = buildV3(0, 500, ts, SHALLOW_L, nBr, 0, false);
          const prepared: EcoSwapPrepared = {
            pools: [p.pool], routes: [], brackets: sortLadder(p.brackets),
            zeroForOne: false, priceLimit: PRICE_LIMIT_O4O, expectedInputCovered: 0n,
          };
          const live: (KwayLivePool | undefined)[] = [
            { curOI: toOutIn(liveReal, false), liveRealSqrt: liveReal, liveTick: driftTick, liveL: SHALLOW_L },
          ];
          const kw = kwayReference(prepared, amountIn, live);
          const opt = optimalSplit({
            pools: [{ isV2: false, feePpm: 500, sqrtPriceX96: liveReal, tick: driftTick, tickSpacing: ts, liquidity: SHALLOW_L, net: new Map() }],
            amountIn, zeroForOne: false, priceLimit: PRICE_LIMIT_O4O,
          });
          assert.ok(kw.totalInput < amountIn, `o4o drift-UP ${driftTick}t cap nBr=${nBr}: cap binds`);
          assertWeiExact(kw, opt, `(a) o4o drift-UP ${driftTick}t cap nBr=${nBr} A=${amountIn}`);
        });
      }
    }
  }

  // (b) EQUAL-FEE multi-pool × drift-UP (non-cap, fully fills) — the mis-route quadrant. Two DEEP
  // equal-fee (0.05%) V3 pools prepared at spot tick 0; pool0's REAL price drifts UP (against the
  // zeroForOne swap), so its up-region competes with pool1's window at the SAME fee. The trade
  // fully fills (non-cap) and the split must equalize marginals == the oracle to the wei — the
  // merge tie in the up-region must route to the correct pool (the old clamp-splice did not).
  for (const driftTick of [600, 5000]) {
    const liveReal = getSqrtRatioAtTick(driftTick);
    for (const amountIn of [50_000n * E18, 200_000n * E18, 1_000_000n * E18]) {
      it(`(b) equal-fee multi-pool drift-UP +${driftTick}t (non-cap) amountIn=${amountIn} — split == oracle, wei-exact`, () => {
        const DEEP_L = 500_000n * E18;
        const p0 = buildV3(0, 500, ts, DEEP_L, 200, 0, true); // drifts up
        const p1 = buildV3(1, 500, ts, DEEP_L, 200, 0, true); // undrifted, equal fee
        const prepared: EcoSwapPrepared = {
          pools: [p0.pool, p1.pool], routes: [], brackets: sortLadder([...p0.brackets, ...p1.brackets]),
          zeroForOne: true, priceLimit: PRICE_LIMIT, expectedInputCovered: 0n,
        };
        const live: (KwayLivePool | undefined)[] = [
          { curOI: toOutIn(liveReal, true), liveRealSqrt: liveReal, liveTick: driftTick, liveL: DEEP_L },
          undefined,
        ];
        const kw = kwayReference(prepared, amountIn, live);
        const opt = optimalSplit({
          pools: [
            { isV2: false, feePpm: 500, sqrtPriceX96: liveReal, tick: driftTick, tickSpacing: ts, liquidity: DEEP_L, net: new Map() },
            { isV2: false, feePpm: 500, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: ts, liquidity: DEEP_L, net: new Map() },
          ],
          amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT,
        });
        assert.equal(kw.totalInput, amountIn, `equal-fee drift-UP +${driftTick}t A=${amountIn}: fully fills (non-cap)`);
        assertWeiExact(kw, opt, `(b) equal-fee multi drift-UP +${driftTick}t A=${amountIn}`);
        // Where the trade is large enough to cross the up-region tie (the oracle funds both),
        // the re-anchored split must too — this is the quadrant where the old clamp-splice
        // mis-routed the up-region share to the wrong pool.
        if (opt.perPoolInput[1] > 0n) {
          assert.ok(kw.perPoolInput[0] > 0n && kw.perPoolInput[1] > 0n, "both equal-fee pools funded at the tie");
        }
      });
    }
  }
});

