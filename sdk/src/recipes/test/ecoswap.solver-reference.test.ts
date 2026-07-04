/**
 * EcoSwap K-WAY-LAZY reference — known-answer cross-check vs the neutral optimal oracle.
 *
 * The canonical on-chain k-way solver (ecoswap.sauce.ts) is mirrored bit-for-bit by
 * ecoswap.solver-reference.ts. This test proves that mirror produces the OPTIMAL split
 * (ecoswap.optimal.ts optimalSplit, built from TRUE live state) to the wei across the
 * scenario matrix — WITHOUT anvil. The EVM lane (ecoswap.matrix.evm.test.ts) then confirms
 * the compiled bytecode realizes the same split on-chain.
 *
 * The synthetic prepared datasets are built on the SAME multiplicative one-ts grid the
 * solver and oracle walk (stepReal from the live spot), so the cached net and the live
 * walk share one geometry — the load-bearing exactness alignment (spec §7).
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.solver-reference.test.ts
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
import { kwayReference, type KwayLivePool } from "./ecoswap.solver-reference";
import { optimalSplit, type OptimalPool, type OptimalRoute, type OptimalLegQlVenue } from "./ecoswap.optimal";
import { buildWooFiQLLadder } from "../shared/woofi-math";
import {
  EcoBracketKind,
  type EcoBracket,
  type EcoPool,
  type EcoRoute,
  type EcoSwapPrepared,
} from "../shared/types";
import { SwapPoolType } from "../shared/constants";
import type { Hex } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const PRICE_LIMIT = 4295128740n; // MIN_SQRT_RATIO + 1 (zeroForOne extreme)

function feeAdjust(oi: bigint, feePpm: number): bigint {
  return (oi * sqrtOneMinusFeeScaled(feePpm)) / FEE_DENOM;
}
function stepRealTs(s: bigint, ratio: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? (s * Q96) / ratio : (s * ratio) / Q96;
}

/**
 * Build a flat-L V3 EcoPool + synthetic route-style brackets on the multiplicative one-ts
 * grid from a prepare-time spot tick (the solver/oracle walk grid). Single wide position ⇒
 * empty net ⇒ constant L (the exact regime the EVM lane uses).
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
  // window: shallowest scanned tick (the spot boundary) → deepest (after nBr steps). Empty net
  // ⇒ no initialized ticks ⇒ extremeShifted 0 (constant-L curve, no gap gate).
  const spotBoundaryShifted = BigInt(startBoundary + Number(OFFSET));
  const windowBotShifted = spotBoundaryShifted + BigInt(step) * BigInt(nBr > 0 ? nBr - 1 : 0);
  const pool: EcoPool = {
    poolType: SwapPoolType.UniV3, address: ZERO, fee: feePpm, tickSpacing: ts, hooks: ZERO,
    feePpm, isV2: false, inIsToken0: zeroForOne, stateView: ZERO, poolId: ZERO,
    stepRatio,
    windowTopShifted: nBr > 0 ? spotBoundaryShifted : 0n,
    windowBotShifted: nBr > 0 ? windowBotShifted : 0n,
    extremeShifted: 0n,
    spotTickShifted: spotBoundaryShifted,
    spotNearReal: spotReal,
    spotActiveL: L,
    adaptiveNet: new Map<number, bigint>(),
    source: "synthetic",
  };
  return { pool, brackets };
}

/**
 * Build a V3 EcoPool whose active L CHANGES at initialized ticks (a non-empty `net` map),
 * walking forward from the prepare-time spot multiplicatively (the one-ts grid) and updating
 * L by ±net at each boundary. The window scalars + per-pool net cache are stamped to match
 * prepare's stampPoolCache, and `adaptiveNet` carries the FULL signed-net curve for the
 * reference's mirrored live walk. This is the regime the prior single-wide-position vectors
 * never exercised — the one that hid the drift-down / L-change defect.
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
  const spotBoundaryShifted = BigInt(startBoundary + Number(OFFSET));
  const windowBotShifted = spotBoundaryShifted + BigInt(step) * BigInt(nBr > 0 ? nBr - 1 : 0);
  // extremeShifted = the DEEPEST initialized tick (shifted) in the swap direction. Only
  // nonzero-net keys count (a zero-net key would never change L → must not extend the gate);
  // a no-op on producible data, mirroring prepare's stampPoolCache + the oracle extremeTick.
  const netKeys = [...net.entries()].filter(([, n]) => n !== 0n).map(([t]) => t);
  const extremeTick = netKeys.length
    ? (zeroForOne ? Math.min(...netKeys) : Math.max(...netKeys))
    : null;
  const extremeShifted = extremeTick === null ? 0n : BigInt(extremeTick + Number(OFFSET));
  const pool: EcoPool = {
    poolType: SwapPoolType.UniV3, address: ZERO, fee: feePpm, tickSpacing: ts, hooks: ZERO,
    feePpm, isV2: false, inIsToken0: zeroForOne, stateView: ZERO, poolId: ZERO,
    stepRatio,
    windowTopShifted: nBr > 0 ? spotBoundaryShifted : 0n,
    windowBotShifted: nBr > 0 ? windowBotShifted : 0n,
    extremeShifted,
    spotTickShifted: spotBoundaryShifted,
    spotNearReal: spotReal,
    spotActiveL: startL,
    adaptiveNet: net,
    source: "synthetic",
  };
  return { pool, brackets };
}

/** A V2 EcoPool + synthetic brackets + the live out/in spot + √k seed the walk reads. */
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
  const pool: EcoPool = {
    poolType: SwapPoolType.UniV2, address: ZERO, fee, tickSpacing: 0, hooks: ZERO,
    feePpm: fee, isV2: true, inIsToken0: true, stateView: ZERO, poolId: ZERO,
    // V2 has no tick cache: [10..15] zero. The prepare-time spot out/in + √k seed the no-drift
    // frontier (the reference adapter reads these when no drift override is set).
    spotNearReal: spotOI, spotActiveL: L, source: "synthetic",
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

describe("k-way reference == optimal oracle (drift-up vs prepare-time spot — live-spot walk)", () => {
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
    it(`drift-up amountIn=${amountIn} — live-spot walk fills (spot,top] == oracle, wei-exact`, () => {
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
    stepRatio: getSqrtRatioAtTick(ts),
    windowTopShifted: 0n, windowBotShifted: 0n, extremeShifted: 0n, // no cache (quote path)
    spotTickShifted: BigInt(0 + Number(OFFSET)), spotNearReal: spotReal, spotActiveL: L1,
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

describe("k-way reference == optimal oracle (V2 drift-up vs prepare-time spot — live-spot stream)", () => {
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
    it(`V2 drift-up amountIn=${amountIn} — live-spot stream fills (spot,top] == oracle, wei-exact`, () => {
      const kw = kwayReference(prepared, amountIn, live);
      const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: true, priceLimit: PRICE_LIMIT });
      assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
      assertWeiExact(kw, opt, `V2 drift-up A=${amountIn}`);
    });
  }
});

// ── V2 drift-down vs prepare-time spot (live-spot stream) ─────────────────
//
// A V2 0.30% pool whose live out/in spot drifted DOWN (below the prepare-time spot)
// against a deeper V3 0.05% pool at spot. The unified walk streams the V2 pool's
// constant-L geometry from its LIVE out/in spot, so the with-swap drift just lowers the
// stream start — no separate frontier, no stale handling. Continuity gate: 0% drift ⇒ 0
// misallocation (the live spot == the prepare-time spot, so the walk is identical).
describe("k-way reference == optimal oracle (V2 drift-down vs prepare-time spot — live-spot stream)", () => {
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
    it(`V2 drift-down ${driftPct}% — live-spot stream == oracle, wei-exact (0% ⇒ 0 misalloc)`, () => {
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
    stepRatio: getSqrtRatioAtTick(ts),
    windowTopShifted: 0n, windowBotShifted: 0n, extremeShifted: 0n,
    spotTickShifted: BigInt(0 + Number(OFFSET)), spotNearReal: spotReal, spotActiveL: L,
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
// The vectors above all use net=new Map() (constant L) and only drift up. These two pools
// instead carry a genuine initialized-tick L change, and the engaged pool0 drifts DOWN to a
// true MID-GRID live tick (not a tickSpacing multiple). The unified walk anchors pool0's
// frontier on the LIVE tick lattice (the cached net for the in-window boundaries, a
// staticcall past it), competes pool0 at its TRUE live head, and runs until filled within
// the per-pool budget. kwayReference must equal optimalSplit (built from the SAME post-drift
// live state) to the wei.
describe("k-way reference == optimal oracle (drift-down mid-grid + initialized-tick L change)", () => {
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

  // (3) NO-drift regression guard: cut crosses LCHANGE, no drift override → the live spot
  // equals the prepare-time spot and the walk must still equal the oracle (no-drift path).
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
  // net rows AND no cache window (exactly what prepare stamps at maxTicks:0), so the walk
  // does everything from the LIVE drifted spot, staticcalling each boundary. Must equal oracle.
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
// drift cases all land mid-grid), plus a FULLY-OUT-OF-RANGE pool (live price entirely below its
// cache window ⇒ every boundary is out-of-window staticcalled and the walk runs from the live
// spot alone). These close the last drift × L-change × range quadrants on the fast tier.
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

  // (B) FULLY-OUT-OF-RANGE: pool0's live price drifts DOWN so far that it is BELOW its whole
  // cache window, so every boundary is out-of-window staticcalled and pool0's frontier walks
  // from the deep live spot alone. The steady pool1 fills the rest. This is the "fully out of
  // range" drift case the spec calls out — the cache contributes nothing for the drifted pool
  // and the walk must be optimal from the live spot alone.
  it("FULLY-OUT-OF-RANGE drifted pool (cache window below the live spot) → live walk only — kwayReference == oracle, wei-exact", () => {
    const prepared = build();
    const amountIn = 2_000_000n * E18;
    // Drift pool0 WAY down — below the deepest scanned boundary (≈ tick -NBR*TS0 with
    // multiplicative geometry; -20000 is well past the 96-tick window so it is fully out of window).
    const OOR_TICK = -20000;
    const oorReal0 = getSqrtRatioAtTick(OOR_TICK);
    const live: (KwayLivePool | undefined)[] = [
      { curOI: toOutIn(oorReal0, true), liveRealSqrt: oorReal0, liveTick: OOR_TICK, liveL: L0_BASE }, // L past LC0 ⇒ base only
      undefined,
    ];
    // Sanity: the live price IS below the deepest scanned boundary (the whole cache window is
    // out of range). The window bottom is ≈ NBR steps below spot tick 0 (multiplicative ≈ tick -NBR*TS0).
    const windowBottomReal = getSqrtRatioAtTick(-NBR * TS0);
    assert.ok(oorReal0 < windowBottomReal, "OOR live price below the deepest scanned boundary (cache fully out of window)");
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

// ── D1: V2 drift-up COMPETING in a multi-pool merge ──────────────────────────────────────
//
// The V2-drift-up block above is SINGLE-POOL — there is no competitor to mis-order. D1 covers
// the {drift-up × V2 × multi-pool} quadrant: a V2 0.30% pool prepared at spot competes with a
// deep V3 0.05% pool, then the V2 live spot drifts UP (against the swap). The unified walk
// streams the V2 pool's constant-L geometry as ONE continuous run from the LIVE out/in spot —
// the same single grid the oracle walks — so its fee-adjusted-near merge head matches the
// oracle's and the cross-pool merge orders correctly. INVARIANT to cache depth (NOT a
// shallow-window artifact), 0 misallocation at 0% drift (continuity), wei-exact at every drift.
describe("k-way reference == optimal oracle (V2 drift-up COMPETING — single live-spot grid)", () => {
  const resIn = 1_000_000n * E18;
  const resOut = 1_000_000n * E18;
  const amountIn = 200_000n * E18; // large enough to push the deep V3 down to the V2 grid
  // Deep V3 0.05% at spot tick 0 (undrifted) + V2 0.30% prepared at spot, then V2 drifts UP.
  for (const driftPct of [0n, 1n, 2n, 5n, 10n, 12n, 20n]) {
    for (const nBr of [16, 64, 200]) {
      it(`V2 drift-up ${driftPct}% (nBr=${nBr}) competing vs deep V3 — live-spot grid == oracle, wei-exact`, () => {
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
// The B2 cap-binding block uses an EMPTY cache (maxTicks:0). With a NON-EMPTY cache, the
// unified walk consumes the in-window boundaries (net from the cache) and the out-of-window
// boundaries (net staticcalled) on ONE per-pool frontier counted against ONE shared per-pool
// step budget (PER_POOL == the oracle MAX_V3_STEPS). So the reach is bounded by PER_POOL from
// the live spot REGARDLESS of how many boundaries the cache covers — the cache never deepens
// the reach — and solver == oracle at the cap for BOTH empty AND non-empty cache.
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

// ── drift-up × CAP-BINDING: the single shared per-pool budget (the {drift-up × cap} quadrant) ──
//
// A pool drifted UP (against the swap), with the cap binding. The unified walk runs ONE
// per-pool frontier from the LIVE (drifted) spot, deeper, counted against ONE PER_POOL=2048
// step budget — exactly the optimal oracle's single MAX_V3_STEPS loop from the live spot. So
// the reach is bounded by PER_POOL from the live spot whether or not the pool drifted up (the
// against-swap region above the prepare-time spot is just more boundaries on the same single
// frontier), and solver == oracle to the wei EVEN WHEN THE CAP BINDS, for drift-up.
//
// These vectors are production-reachable: a large/out-of-range run-until-filled trade against
// a pool that drifted up (against-swap drift), and the empty-cache QUOTE path (the walk starts
// at the live spot with no cache). Both single-pool and multi-pool (the cross-pool cut).
describe("k-way reference == optimal oracle (drift-up × cap-binding — single live-spot budget)", () => {
  const ts = 10;
  const SHALLOW_L = 1000n * E18; // shallow ⇒ a from-live-spot 2048-step walk under-fills a big trade
  // amountIn FAR exceeds what PER_POOL=2048 steps absorb from ANY spot on this L, so the cap
  // binds for every drift. The single per-pool budget bounds the reach to PER_POOL from the
  // live spot == the oracle, independent of how far the pool drifted up. Drift ticks span a
  // wide against-swap range (+600, +5000, +12000).
  for (const driftTick of [600, 5000, 12000]) {
    const liveReal = getSqrtRatioAtTick(driftTick);

    // (A) SINGLE-POOL drift-up cap-binding. The pool drifted up by driftTick; with the cap
    // binding, the reach must be PER_POOL steps FROM THE LIVE SPOT (== the oracle), the
    // against-swap region being just more boundaries on the one frontier. Both empty-cache
    // (quote) and a deep cache.
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
          // The cap binds: the reach is the per-pool budget from the live spot, not the trade.
          assert.ok(kw.totalInput < amountIn, `drift +${driftTick}t nBr=${nBr}: cap binds`);
          // EXACTNESS AT THE CAP under drift-up: the single per-pool budget bounds the reach to
          // PER_POOL from the live spot == the oracle's single MAX_V3_STEPS loop.
          assertWeiExact(kw, opt, `drift-up +${driftTick}t cap single nBr=${nBr} A=${amountIn}`);
        });
      }
    }

    // (B) MULTI-POOL drift-up cap-binding: the cross-pool cut. A drifted-up shallow pool0
    // competes with a deeper undrifted pool1; with pool0 capped at PER_POOL from its live spot
    // == the oracle, the cross-pool split at the cut matches the oracle to the wei.
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
        // The per-pool reach on the drifted pool is bounded to PER_POOL from its live spot,
        // so the cross-pool split equals the oracle.
        assertWeiExact(kw, opt, `drift-up +${driftTick}t cap multi A=${amountIn}`);
      });
    }
  }
});

// ── oneForZero (zeroForOne === false) reference == oracle ──────────────────────────────
//
// COVERAGE GAP (spec item 2): every block above runs zeroForOne=true. The kwayReference math
// is direction-parametric (toOutIn = Q192/sqrt, stepReal up-direction, tickArg negatives), so
// these mirror the representative scenarios with zeroForOne=false — no-drift multi-V3, drift-up
// (against the swap), drift-down (with the swap), V2, and cap-binding — proving the reference is
// wei-exact == the oracle on the oneForZero side too. (The compiled-bytecode oneForZero path is
// the genuine unknown the EVM lane H1–H6 + C2-V4 cells close; this fast block pins the math.)
//
// oneForZero geometry: the swap walks ticks UP, so a pool drifts UP against the swap when its
// live out/in spot is ABOVE the prepare-time spot, i.e. its REAL price has fallen. We model that
// directly via the live override (lower liveRealSqrt). The oneForZero price extreme is
// MAX_SQRT_RATIO − 1 (the walk guard upper bound).
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

  // (2) drift-up (against the swap): pool0's REAL price falls (live out/in spot ABOVE the prepare-time spot).
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
      it(`oneForZero drift-up amountIn=${amountIn} — live-spot walk == oracle, wei-exact`, () => {
        const kw = kwayReference(prepared, amountIn, live);
        const opt = optimalSplit({ pools: optPools, amountIn, zeroForOne: false, priceLimit: PRICE_LIMIT_O4O });
        assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
        assertWeiExact(kw, opt, `o4o drift-up A=${amountIn}`);
      });
    }
  }

  // (3) drift-down (with the swap): pool0's REAL price rises (live out/in spot BELOW the prepare-time spot).
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
      it(`oneForZero drift-down amountIn=${amountIn} — live-spot walk == oracle, wei-exact`, () => {
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
      stepRatio: getSqrtRatioAtTick(ts),
      windowTopShifted: 0n, windowBotShifted: 0n, extremeShifted: 0n,
      // oneForZero walks UP: the spot boundary is base + ts (base 0 ⇒ ts).
      spotTickShifted: BigInt(ts + Number(OFFSET)), spotNearReal: spotReal, spotActiveL: L,
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

// ── drift-up live-spot walk: symmetric to drift-down, both directions ──────────────────────
//
// A drifted-UP V3/V4 pool is walked exactly like any other: ONE per-pool frontier from the
// LIVE spot on the live one-ts grid (the in-window net from the cache, out-of-window net
// staticcalled). The against-swap region above the prepare-time spot is just more out-of-window
// boundaries on that single frontier — the same continuous multiplicative grid the oracle
// walks, with no handoff, no clamp, no second frontier. Two production-reachable manifestations
// the walk must get wei-exact:
//   (a) oneForZero × drift-up × cap-binding: the capped reach must equal the oracle to the wei.
//   (b) EQUAL-FEE multi-pool × drift-up (non-cap, fully fills): the merge tie in the against-swap
//       region must route to the correct pool == the oracle.
// One continuous from-live-spot grid for BOTH drift directions and both swap directions,
// cap-binding or not.
describe("k-way reference == optimal oracle (drift-up live-spot walk — both directions)", () => {
  const ts = 10;
  const SHALLOW_L = 1000n * E18; // shallow ⇒ a from-live-spot 2048-step walk under-fills a big trade

  // (a) oneForZero × drift-up × cap-binding. A pool whose REAL price has FALLEN (out/in spot
  // ABOVE the prepare-time spot, against the oneForZero swap), with the cap binding, must reach
  // EXACTLY PER_POOL steps FROM THE LIVE SPOT == the oracle, wei-exact.
  const PRICE_LIMIT_O4O = 1461446703485210103287273052203988822378723970341n; // MAX_SQRT_RATIO − 1
  for (const driftTick of [-600, -5000]) {
    const liveReal = getSqrtRatioAtTick(driftTick); // REAL price down ⇒ out/in spot UP
    for (const nBr of [0, 96]) {
      for (const amountIn of [200_000n * E18, 500_000n * E18]) {
        it(`(a) oneForZero drift-up ${driftTick}t × cap (nBr=${nBr}) amountIn=${amountIn} — live-spot walk == oracle, wei-exact`, () => {
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
          assert.ok(kw.totalInput < amountIn, `o4o drift-up ${driftTick}t cap nBr=${nBr}: cap binds`);
          assertWeiExact(kw, opt, `(a) o4o drift-up ${driftTick}t cap nBr=${nBr} A=${amountIn}`);
        });
      }
    }
  }

  // (b) EQUAL-FEE multi-pool × drift-up (non-cap, fully fills) — the merge-tie quadrant. Two DEEP
  // equal-fee (0.05%) V3 pools prepared at spot tick 0; pool0's REAL price drifts UP (against the
  // zeroForOne swap), so its against-swap region competes with pool1's window at the SAME fee. The
  // trade fully fills (non-cap) and the split must equalize marginals == the oracle to the wei —
  // the merge tie in the against-swap region must route to the correct pool.
  for (const driftTick of [600, 5000]) {
    const liveReal = getSqrtRatioAtTick(driftTick);
    for (const amountIn of [50_000n * E18, 200_000n * E18, 1_000_000n * E18]) {
      it(`(b) equal-fee multi-pool drift-up +${driftTick}t (non-cap) amountIn=${amountIn} — split == oracle, wei-exact`, () => {
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
        assert.equal(kw.totalInput, amountIn, `equal-fee drift-up +${driftTick}t A=${amountIn}: fully fills (non-cap)`);
        assertWeiExact(kw, opt, `(b) equal-fee multi drift-up +${driftTick}t A=${amountIn}`);
        // Where the trade is large enough to cross the against-swap-region tie (the oracle funds
        // both), the live-spot walk's split must too — the merge tie must route correctly.
        if (opt.perPoolInput[1] > 0n) {
          assert.ok(kw.perPoolInput[0] > 0n && kw.perPoolInput[1] > 0n, "both equal-fee pools funded at the tie");
        }
      });
    }
  }
});


// ═══════════════════════════════════════════════════════════════════════════════════════════
// ROUTES = LIVE WALK — kwayReference (per-leg-pool live frontiers) == optimalSplit (oracle)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Routes are now first-class live-walk venues (no static segments). Each leg is a SET of leg
// pools, each with its own live frontier seeded by the SAME direct-pool SETUP (using the leg's
// zHop), and the route head is the LEFT-TO-RIGHT product fold of the per-leg internal-best
// fee-adjusted heads. These vectors prove the cursor-faithful reference's route walk is wei-exact
// vs the neutral oracle (optimalSplit, built from the SAME live leg state) across: a 2-hop route
// alone + competing with a direct pool, a MULTI-POOL leg (a leg splitting across two pools), and
// OPPOSITE-DIRECTION hops (z1 != z2). The reference IMPORTS routeHeadFold/routeEvent2/routePartial2
// from ecoswap.math.ts — the same helpers the oracle uses — so the two agree BY CONSTRUCTION.

const ROUTE_PRICE_LIMIT = 0n; // routes: no binding price limit in these fixtures (deep legs)

let addrSeq = 1;
/** A distinct non-zero pool address (the universe dedupes by address; leg pools must be unique). */
function nextAddr(): Hex {
  const h = (addrSeq++).toString(16).padStart(40, "0");
  return ("0x" + h) as Hex;
}

/**
 * A constant-L V3 leg/direct EcoPool at `prepTick` with explicit address + per-pool direction
 * (`zHop` → inIsToken0). Empty net ⇒ single constant-L curve (the regime the route legs use). The
 * window scalars are stamped from a `nBr`-deep scan (enough to reach a clean interior cut).
 */
function legPool(addr: Hex, feePpm: number, ts: number, L: bigint, nBr: number, prepTick: number, zHop: boolean): EcoPool {
  const spotReal = getSqrtRatioAtTick(prepTick);
  const stepRatio = getSqrtRatioAtTick(ts);
  const base = Math.floor(prepTick / ts) * ts;
  const startBoundary = zHop ? base : base + ts;
  const step = zHop ? -ts : ts;
  const spotBoundaryShifted = BigInt(startBoundary + Number(OFFSET));
  const windowBotShifted = spotBoundaryShifted + BigInt(step) * BigInt(nBr > 0 ? nBr - 1 : 0);
  return {
    poolType: SwapPoolType.UniV3, address: addr, fee: feePpm, tickSpacing: ts, hooks: ZERO,
    feePpm, isV2: false, inIsToken0: zHop, stateView: ZERO, poolId: ZERO,
    stepRatio,
    windowTopShifted: nBr > 0 ? spotBoundaryShifted : 0n,
    windowBotShifted: nBr > 0 ? windowBotShifted : 0n,
    extremeShifted: 0n,
    spotTickShifted: spotBoundaryShifted,
    spotNearReal: spotReal,
    spotActiveL: L,
    adaptiveNet: new Map<number, bigint>(),
    source: "synthetic-leg",
  };
}

/**
 * The oracle leg (OptimalRoute) mirror of `legPool` — true live state, same direction. A leg is a
 * SET of pools; this single-pool helper wraps one OptimalPool. For a MULTI-POOL leg use
 * `optLegMulti` (the leg-internal water-fill the oracle models, NOT parallel routes).
 */
function optLeg(feePpm: number, ts: number, L: bigint, prepTick: number, zHop: boolean): OptimalRoute["legs"][number] {
  return {
    zeroForOne: zHop,
    pools: [{ isV2: false, feePpm, sqrtPriceX96: getSqrtRatioAtTick(prepTick), tick: prepTick, tickSpacing: ts, liquidity: L, net: new Map() }],
  };
}

/** A MULTI-POOL oracle leg: the leg splits across all `pools` via the leg-internal merge. */
function optLegMulti(
  zHop: boolean,
  pools: { feePpm: number; ts: number; L: bigint; prepTick: number }[],
): OptimalRoute["legs"][number] {
  return {
    zeroForOne: zHop,
    pools: pools.map((p) => ({
      isV2: false, feePpm: p.feePpm, sqrtPriceX96: getSqrtRatioAtTick(p.prepTick), tick: p.prepTick,
      tickSpacing: p.ts, liquidity: p.L, net: new Map<number, bigint>(),
    })),
  };
}

function assertRouteExact(
  kw: { perPoolInput: bigint[]; perRouteInput: bigint[]; totalInput: bigint },
  opt: { perPoolInput: bigint[]; perRouteInput: bigint[]; totalInput: bigint },
  label: string,
): void {
  assert.equal(kw.totalInput, opt.totalInput, `${label}: total != oracle`);
  for (let i = 0; i < kw.perPoolInput.length; i++) {
    assert.equal(kw.perPoolInput[i], opt.perPoolInput[i], `${label}: pool[${i}] != oracle`);
  }
  for (let r = 0; r < kw.perRouteInput.length; r++) {
    assert.equal(kw.perRouteInput[r], opt.perRouteInput[r], `${label}: route[${r}] != oracle`);
  }
}

describe("k-way reference == optimal oracle (ROUTE-ONLY universe, 2-hop V3 legs)", () => {
  const DEEP = 10n ** 26n;
  for (const amountIn of [1000n * E18, 50_000n * E18]) {
    it(`route-only amountIn=${amountIn} — all input via the route, wei-exact == oracle`, () => {
      const a1 = nextAddr();
      const a2 = nextAddr();
      const route: EcoRoute = {
        legs: [
          { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a1, 3000, 60, DEEP, 200, 0, true)] },
          { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a2, 3000, 60, DEEP, 200, 0, true)] },
        ],
        intermediateTokens: [nextAddr()],
      };
      const prepared: EcoSwapPrepared = {
        pools: [], routes: [route], brackets: [], zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT, expectedInputCovered: 0n,
      };
      const optRoute: OptimalRoute = { legs: [optLeg(3000, 60, DEEP, 0, true), optLeg(3000, 60, DEEP, 0, true)] };
      const kw = kwayReference(prepared, amountIn);
      const opt = optimalSplit({ pools: [], routes: [optRoute], amountIn, zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT });
      assert.equal(kw.totalInput, amountIn, "spends amountIn exactly through the route");
      assert.ok(kw.perRouteInput[0] > 0n, "route engaged");
      assertRouteExact(kw, opt, `route-only A=${amountIn}`);
      assert.ok(kw.cursorChecks.length >= 0, "cursor checks recorded (window legs exercise the cursor)");
    });
  }
});

describe("k-way reference == optimal oracle (direct pool + 2-hop route — shared cut, wei-exact)", () => {
  const DEEP = 10n ** 26n;
  // A SHALLOW direct pool (one fee) competes with a DEEP 2-hop route (two fees). The direct pool
  // fills first; a large trade overflows into the route at the shared cut. Both engaged ⇒ the split
  // equalizes the direct marginal against the route's product head. Wei-exact vs the oracle.
  for (const [tag, amountIn] of [
    ["small: route unused", E18 / 10n],
    ["large: route engaged", 200_000n * E18],
  ] as const) {
    it(`${tag} amountIn=${amountIn} — direct + route split == oracle, wei-exact`, () => {
      const SHALLOW = 10n ** 21n;
      const dAddr = nextAddr();
      const direct: EcoPool = legPool(dAddr, 3000, 60, SHALLOW, 200, 0, true);
      const a1 = nextAddr();
      const a2 = nextAddr();
      const route: EcoRoute = {
        legs: [
          { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a1, 3000, 60, DEEP, 200, 0, true)] },
          { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a2, 3000, 60, DEEP, 200, 0, true)] },
        ],
        intermediateTokens: [nextAddr()],
      };
      const prepared: EcoSwapPrepared = {
        pools: [direct], routes: [route], brackets: [], zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT, expectedInputCovered: 0n,
      };
      const optDirect: OptimalPool = { isV2: false, feePpm: 3000, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 60, liquidity: SHALLOW, net: new Map() };
      const optRoute: OptimalRoute = { legs: [optLeg(3000, 60, DEEP, 0, true), optLeg(3000, 60, DEEP, 0, true)] };
      const kw = kwayReference(prepared, amountIn);
      const opt = optimalSplit({ pools: [optDirect], routes: [optRoute], amountIn, zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT });
      assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
      assertRouteExact(kw, opt, `${tag} A=${amountIn}`);
    });
  }
});

describe("k-way reference == optimal oracle (equalization: direct pool + route share a marginal)", () => {
  // The water-fill keystone: at the cut the direct pool's post-fee marginal == the route's product
  // head. SHALLOW venues so the route enters as many fine micro-segments at a clean interior cut.
  it("post-fee route head ≈ direct marginal at the cut; wei-exact == oracle", () => {
    const TS = 60;
    const directL = 10n ** 22n;
    const legL = 10n ** 22n;
    const dAddr = nextAddr();
    const direct: EcoPool = legPool(dAddr, 500, TS, directL, 400, 0, true);
    const a1 = nextAddr();
    const a2 = nextAddr();
    const route: EcoRoute = {
      legs: [
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a1, 3000, TS, legL, 400, 0, true)] },
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a2, 3000, TS, legL, 400, 0, true)] },
      ],
      intermediateTokens: [nextAddr()],
    };
    const amountIn = 10000n * E18;
    const prepared: EcoSwapPrepared = {
      pools: [direct], routes: [route], brackets: [], zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT, expectedInputCovered: 0n,
    };
    const optDirect: OptimalPool = { isV2: false, feePpm: 500, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: TS, liquidity: directL, net: new Map() };
    const optRoute: OptimalRoute = { legs: [optLeg(3000, TS, legL, 0, true), optLeg(3000, TS, legL, 0, true)] };
    const kw = kwayReference(prepared, amountIn);
    const opt = optimalSplit({ pools: [optDirect], routes: [optRoute], amountIn, zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT });
    assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
    assert.ok(kw.perPoolInput[0] > 0n && kw.perRouteInput[0] > 0n, "both venues engaged at the cut");
    assertRouteExact(kw, opt, "equalization direct+route");
  });
});

describe("k-way reference == optimal oracle (MULTI-POOL LEG — a leg splits across two pools)", () => {
  // A 2-hop route whose FIRST leg has TWO pools (different fees) the leg splits across, second leg
  // one pool. The reference's leg-internal merge picks the best pool per event; the route head folds
  // the leg-internal best with leg2. The oracle models the multi-pool leg as a SINGLE route with a
  // leg-internal water-fill (NOT parallel routes) — so the reference's ONE perRouteInput equals the
  // oracle's ONE route input to the WEI, and the per-leg-pool split agrees too. Both legs deep ⇒ a
  // clean interior split.
  it("first-leg two-pool split — route input + per-leg-pool split == oracle (wei-exact)", () => {
    const DEEP = 10n ** 26n;
    const TS = 60;
    // Leg1 pools: same spot, fees 0.05% and 0.30% (the leg-internal merge orders by fee-adjusted head).
    const l1a = nextAddr();
    const l1b = nextAddr();
    const l2 = nextAddr();
    const route: EcoRoute = {
      legs: [
        {
          hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true,
          pools: [legPool(l1a, 500, TS, DEEP, 300, 0, true), legPool(l1b, 3000, TS, DEEP, 300, 0, true)],
        },
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(l2, 3000, TS, DEEP, 300, 0, true)] },
      ],
      intermediateTokens: [nextAddr()],
    };
    const amountIn = 5000n * E18;
    const prepared: EcoSwapPrepared = {
      pools: [], routes: [route], brackets: [], zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT, expectedInputCovered: 0n,
    };
    // Oracle: ONE route, leg0 = the leg-internal water-fill over the two pools (NOT parallel routes).
    const optRoute: OptimalRoute = {
      legs: [
        optLegMulti(true, [{ feePpm: 500, ts: TS, L: DEEP, prepTick: 0 }, { feePpm: 3000, ts: TS, L: DEEP, prepTick: 0 }]),
        optLeg(3000, TS, DEEP, 0, true),
      ],
    };
    const kw = kwayReference(prepared, amountIn);
    const opt = optimalSplit({ pools: [], routes: [optRoute], amountIn, zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT });
    assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
    assert.ok(kw.perRouteInput[0] > 0n, "multi-pool-leg route engaged");
    assert.equal(kw.perRouteInput[0], opt.perRouteInput[0], "route input == oracle (wei-exact)");
    assert.equal(kw.perRouteInput[0], amountIn, "all input via the (deep) multi-pool-leg route");
  });
});

describe("k-way reference == optimal oracle (OPPOSITE-DIRECTION hops — z1 != z2)", () => {
  // A 2-hop route whose first leg swaps token0→token1 (zeroForOne) and second leg token1→token0
  // (oneForZero) — each leg works in its OWN out/in space (toOutIn absorbs the per-hop direction).
  // The per-pool direction comes from each leg pool's inIsToken0 (the leg's zHop), NOT a top-level
  // constant. Cross-checked against the oracle's opposite-direction route + a direct pool.
  it("z1=true, z2=false route composes + conserves; wei-exact == oracle", () => {
    const DEEP = 10n ** 26n;
    const TS = 60;
    const dAddr = nextAddr();
    const direct: EcoPool = legPool(dAddr, 500, 10, 10n ** 24n, 300, 0, true);
    const a1 = nextAddr();
    const a2 = nextAddr();
    const route: EcoRoute = {
      legs: [
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a1, 3000, TS, DEEP, 300, 0, true)] },
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: false, pools: [legPool(a2, 3000, TS, DEEP, 300, 0, false)] },
      ],
      intermediateTokens: [nextAddr()],
    };
    const amountIn = 5000n * E18;
    const prepared: EcoSwapPrepared = {
      pools: [direct], routes: [route], brackets: [], zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT, expectedInputCovered: 0n,
    };
    const optDirect: OptimalPool = { isV2: false, feePpm: 500, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 10, liquidity: 10n ** 24n, net: new Map() };
    const optRoute: OptimalRoute = { legs: [optLeg(3000, TS, DEEP, 0, true), optLeg(3000, TS, DEEP, 0, false)] };
    const kw = kwayReference(prepared, amountIn);
    const opt = optimalSplit({ pools: [optDirect], routes: [optRoute], amountIn, zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT });
    assert.equal(kw.totalInput, amountIn, "spends amountIn exactly with an opposite-direction route");
    assert.ok(kw.perRouteInput[0] > 0n, "opposite-direction route engaged");
    assertRouteExact(kw, opt, "opposite-direction hops");
  });
});

describe("k-way reference == optimal oracle (3-HOP route — N-leg event, wei-exact)", () => {
  // The N-hop generalization gate: a THREE-leg route (A→X→Y→B) walks the same per-leg-pool live
  // frontiers, the route head is the product fold of all three legs' fee-adjusted heads, and each
  // event binds whichever leg crosses first while the other TWO partial-fill (conservation at BOTH
  // intermediates X and Y). Both the reference's advanceRoute (routeEventN/routePartialN) and the
  // oracle's routeSegments are arbitrary-k; this asserts they agree to the wei on 3 hops.
  const DEEP = 10n ** 26n;
  const TS = 60;
  for (const amountIn of [1000n * E18, 80_000n * E18]) {
    it(`route-only 3-hop amountIn=${amountIn} — all input via the route, wei-exact == oracle`, () => {
      const a1 = nextAddr();
      const a2 = nextAddr();
      const a3 = nextAddr();
      // Three legs of differing fees so the binding leg genuinely rotates across events.
      const route: EcoRoute = {
        legs: [
          { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a1, 500, TS, DEEP, 300, 0, true)] },
          { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a2, 3000, TS, DEEP, 300, 0, true)] },
          { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a3, 500, TS, DEEP, 300, 0, true)] },
        ],
        intermediateTokens: [nextAddr(), nextAddr()],
      };
      const prepared: EcoSwapPrepared = {
        pools: [], routes: [route], brackets: [], zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT, expectedInputCovered: 0n,
      };
      const optRoute: OptimalRoute = {
        legs: [optLeg(500, TS, DEEP, 0, true), optLeg(3000, TS, DEEP, 0, true), optLeg(500, TS, DEEP, 0, true)],
      };
      const kw = kwayReference(prepared, amountIn);
      const opt = optimalSplit({ pools: [], routes: [optRoute], amountIn, zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT });
      assert.equal(kw.totalInput, amountIn, "spends amountIn exactly through the 3-hop route");
      assert.ok(kw.perRouteInput[0] > 0n, "3-hop route engaged");
      assertRouteExact(kw, opt, `3-hop route-only A=${amountIn}`);
    });
  }

  it("direct pool + 3-hop route — shared cut, wei-exact == oracle", () => {
    // A SHALLOW direct pool fills first; a large trade overflows into the 3-hop route at the shared
    // cut. Both engaged ⇒ the split equalizes the direct marginal against the route's 3-leg head.
    const SHALLOW = 10n ** 23n;
    const dAddr = nextAddr();
    const direct: EcoPool = legPool(dAddr, 3000, TS, SHALLOW, 300, 0, true);
    const a1 = nextAddr();
    const a2 = nextAddr();
    const a3 = nextAddr();
    const route: EcoRoute = {
      legs: [
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a1, 3000, TS, DEEP, 300, 0, true)] },
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a2, 3000, TS, DEEP, 300, 0, true)] },
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a3, 3000, TS, DEEP, 300, 0, true)] },
      ],
      intermediateTokens: [nextAddr(), nextAddr()],
    };
    const amountIn = 200_000n * E18;
    const prepared: EcoSwapPrepared = {
      pools: [direct], routes: [route], brackets: [], zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT, expectedInputCovered: 0n,
    };
    const optDirect: OptimalPool = { isV2: false, feePpm: 3000, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: TS, liquidity: SHALLOW, net: new Map() };
    const optRoute: OptimalRoute = {
      legs: [optLeg(3000, TS, DEEP, 0, true), optLeg(3000, TS, DEEP, 0, true), optLeg(3000, TS, DEEP, 0, true)],
    };
    const kw = kwayReference(prepared, amountIn);
    const opt = optimalSplit({ pools: [optDirect], routes: [optRoute], amountIn, zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT });
    assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
    assert.ok(kw.perPoolInput[0] > 0n, "direct pool engaged");
    assert.ok(kw.perRouteInput[0] > 0n, "3-hop route engaged");
    assertRouteExact(kw, opt, "direct + 3-hop route");
  });
});

describe("k-way reference == optimal oracle (k>=3 route with a MULTI-POOL MIDDLE leg — wei-exact)", () => {
  // THE k>=3 multi-pool-leg gate. A 3-hop route A→X→Y→B whose MIDDLE leg (leg1, X→Y) splits across
  // TWO pools (cheap-fee SHALLOW + dear-fee DEEP), leg0/leg2 single deep pools. This is the case the
  // OLD parallel-route oracle got WRONG (decomposing the multi-pool middle leg into parallel routes
  // over-credits the shared downstream leg2 depth at k>=3). The fixed oracle models the leg as an
  // INTERNAL water-fill (the leg-internal merge: the cheap pool drains, then the dear pool engages),
  // and its aggregate throughput feeds the chain — so it agrees with the cursor-faithful reference
  // (which advances the leg's best pool per event) to the WEI, and BOTH leg1 pools engage.
  const TS = 60;
  const DEEP = 10n ** 26n;
  const MIDA = 2n * 10n ** 22n; // leg1 pool A: cheap fee (0.05%) but SHALLOW ⇒ drains, then B engages
  const MIDB = 10n ** 26n; //       leg1 pool B: dear fee (0.30%), DEEP
  for (const amountIn of [1000n * E18, 8000n * E18]) {
    it(`3-hop multi-pool middle leg amountIn=${amountIn} — leg-internal split, wei-exact == oracle`, () => {
      const a0 = nextAddr();
      const m1 = nextAddr();
      const m2 = nextAddr();
      const a3 = nextAddr();
      const route: EcoRoute = {
        legs: [
          { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a0, 500, TS, DEEP, 400, 0, true)] },
          {
            hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true,
            pools: [legPool(m1, 500, TS, MIDA, 400, 0, true), legPool(m2, 3000, TS, MIDB, 400, 0, true)],
          },
          { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a3, 500, TS, DEEP, 400, 0, true)] },
        ],
        intermediateTokens: [nextAddr(), nextAddr()],
      };
      const prepared: EcoSwapPrepared = {
        pools: [], routes: [route], brackets: [], zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT, expectedInputCovered: 0n,
      };
      // The fixed oracle: ONE route, leg1 the leg-internal water-fill over its two pools (NOT
      // parallel routes through the shared leg0/leg2).
      const optRoute: OptimalRoute = {
        legs: [
          optLeg(500, TS, DEEP, 0, true),
          optLegMulti(true, [{ feePpm: 500, ts: TS, L: MIDA, prepTick: 0 }, { feePpm: 3000, ts: TS, L: MIDB, prepTick: 0 }]),
          optLeg(500, TS, DEEP, 0, true),
        ],
      };
      const kw = kwayReference(prepared, amountIn);
      const opt = optimalSplit({ pools: [], routes: [optRoute], amountIn, zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT });
      assert.equal(kw.totalInput, amountIn, "spends amountIn exactly through the 3-hop route");
      assert.equal(kw.perRouteInput[0], opt.perRouteInput[0], "route input == oracle (wei-exact)");
      assert.equal(kw.perRouteInput[0], amountIn, "all input via the (deep) multi-pool-middle-leg route");
      // The leg-internal split engaged BOTH leg1 pools (universe indices: 0=leg0, 1=leg1-A, 2=leg1-B,
      // 3=leg2). The SHALLOW cheap pool A drains, the DEEP dear pool B picks up the remainder.
      const u = kw.perUniversePoolInput;
      assert.ok(u[1] > 0n, "leg1 pool A engaged (leg-internal split)");
      assert.ok(u[2] > 0n, "leg1 pool B engaged (leg-internal split)");
      assert.ok(u[1] < u[2], "the SHALLOW cheap pool A took less than the DEEP dear pool B");
    });
  }

  // KNOWN-ANSWER: at the small trade the leg-internal split + chain output is a fixed bigint, pinned
  // exactly so a regression in either the oracle OR the reference (they share the leg primitives) is
  // caught without the EVM lane. Recomputed from the leg-internal merge; both engines must hit it.
  it("known-answer: small-trade leg-internal split is wei-stable (oracle ≡ reference)", () => {
    const a0 = nextAddr();
    const m1 = nextAddr();
    const m2 = nextAddr();
    const a3 = nextAddr();
    const amountIn = 1000n * E18;
    const route: EcoRoute = {
      legs: [
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a0, 500, TS, DEEP, 400, 0, true)] },
        {
          hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true,
          pools: [legPool(m1, 500, TS, MIDA, 400, 0, true), legPool(m2, 3000, TS, MIDB, 400, 0, true)],
        },
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a3, 500, TS, DEEP, 400, 0, true)] },
      ],
      intermediateTokens: [nextAddr(), nextAddr()],
    };
    const prepared: EcoSwapPrepared = {
      pools: [], routes: [route], brackets: [], zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT, expectedInputCovered: 0n,
    };
    const optRoute: OptimalRoute = {
      legs: [
        optLeg(500, TS, DEEP, 0, true),
        optLegMulti(true, [{ feePpm: 500, ts: TS, L: MIDA, prepTick: 0 }, { feePpm: 3000, ts: TS, L: MIDB, prepTick: 0 }]),
        optLeg(500, TS, DEEP, 0, true),
      ],
    };
    const kw = kwayReference(prepared, amountIn);
    const opt = optimalSplit({ pools: [], routes: [optRoute], amountIn, zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT });
    // Wei-stable leg1 split (computed by the leg-internal merge; the cheap SHALLOW pool A drains to
    // its leg-internal cut, the dear DEEP pool B absorbs the rest). Pins the leg-internal arithmetic.
    assert.equal(kw.perUniversePoolInput[1], 60117139824750888523n, "leg1 pool A input wei-stable");
    assert.equal(kw.perUniversePoolInput[2], 939372870272598188472n, "leg1 pool B input wei-stable");
    assert.equal(kw.perRouteInput[0], opt.perRouteInput[0], "route input == oracle (wei-exact)");
    assert.equal(kw.perRouteInput[0], amountIn, "full route input");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// LEG QL VENUE MEMBERS — kwayReference (per-leg slice cursors) == optimalSplit (qlvs models)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// A route leg's members are now {pools} ∪ {QL venues}: a venue enters the leg-internal merge as
// a flat constant-price SLICE cursor over its on-chain-built ladder (here: the SHARED
// build*QLLadder replay, sized by the chain-order fold — the identical grid on both sides by
// construction). These vectors prove the reference's per-leg qlCur/remCap/remOut mirror and
// the oracle's qlvs modeling agree to the WEI across: a MIXED leg (pool + venue), a POOL-LESS
// (venue-only) leg, an opposite-direction hop with a venue, a mid-leg venue in a 3-hop chain,
// and venue EXHAUSTION (a short ladder drains ⇒ remCap==0 ⇒ the leg dies ⇒ the route dies).
// The member-election ops are the pinned solver leg-scan ops (legMemberWins) at BOTH sites.

/** A synthetic 2-coin Curve StableSwap leg venue (the shared bigint model both sides replay). */
function curveVenue(balances: bigint[], a: bigint, fee: bigint): OptimalLegQlVenue {
  return {
    family: "curve",
    model: {
      poolType: 3, address: nextAddr(), i: 0, j: 1, A: a, aPrecision: 100n,
      balances, rates: [E18, E18], feePpm10: fee, source: "synthetic-leg-qlv",
    },
  };
}

function assertQlRouteExact(
  kw: { perPoolInput: bigint[]; perRouteInput: bigint[]; totalInput: bigint },
  opt: { perPoolInput: bigint[]; perRouteInput: bigint[]; totalInput: bigint },
  label: string,
): void {
  assert.equal(kw.totalInput, opt.totalInput, `${label}: total != oracle`);
  for (let i = 0; i < kw.perPoolInput.length; i++) {
    assert.equal(kw.perPoolInput[i], opt.perPoolInput[i], `${label}: pool[${i}] != oracle`);
  }
  for (let r = 0; r < kw.perRouteInput.length; r++) {
    assert.equal(kw.perRouteInput[r], opt.perRouteInput[r], `${label}: route[${r}] != oracle`);
  }
}

describe("k-way reference == optimal oracle (leg QL venue members — MIXED bracket+slice leg)", () => {
  const DEEP = 10n ** 26n;
  const TS = 60;
  // Leg0 = {V3 pool, near-peg Curve venue} — the venue's post-fee head (0.04%) beats the pool's
  // 0.30% fee-adjusted head, so the venue drains first and the pool engages as the cut descends
  // (the leg-internal merge across member KINDS). A shallow direct pool competes at the global cut.
  for (const amountIn of [1000n * E18, 60_000n * E18]) {
    it(`mixed leg0 (pool + Curve venue) amountIn=${amountIn} — wei-exact == oracle; qinp mirror consistent`, () => {
      const qv = curveVenue([2_000_000n * E18, 2_000_000n * E18], 1000n, 4_000_000n);
      const dAddr = nextAddr();
      const a1 = nextAddr();
      const a2 = nextAddr();
      const direct: EcoPool = legPool(dAddr, 500, TS, 10n ** 22n, 300, 0, true);
      const route: EcoRoute = {
        legs: [
          { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a1, 3000, TS, DEEP, 300, 0, true)] },
          { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a2, 3000, TS, DEEP, 300, 0, true)] },
        ],
        intermediateTokens: [nextAddr()],
      };
      const prepared: EcoSwapPrepared = {
        pools: [direct], routes: [route], brackets: [], zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT, expectedInputCovered: 0n,
      };
      const optDirect: OptimalPool = { isV2: false, feePpm: 500, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: TS, liquidity: 10n ** 22n, net: new Map() };
      const optRoute: OptimalRoute = {
        legs: [{ ...optLeg(3000, TS, DEEP, 0, true), qlvs: [qv] }, optLeg(3000, TS, DEEP, 0, true)],
      };
      const kw = kwayReference(prepared, amountIn, undefined, [[[qv], undefined]]);
      const opt = optimalSplit({ pools: [optDirect], routes: [optRoute], amountIn, zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT });
      assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
      assertQlRouteExact(kw, opt, `mixed leg0 A=${amountIn}`);
      assert.ok(kw.perLegQlvInput[0] > 0n, "the leg venue engaged (qinp mirror > 0)");
      // Leg0 flow-in accounting (the solver's rinp identity): every event awards leg0's elected
      // member its full route input, so Σ leg0 member awards == the route's token-A input.
      // Universe: [0]=direct, [1]=leg0 pool, [2]=leg1 pool.
      assert.equal(
        kw.perUniversePoolInput[1] + kw.perLegQlvInput[0],
        kw.perRouteInput[0],
        "leg0 pool inp + venue qinp == route input (tokenIn conservation)",
      );
    });
  }
});

describe("k-way reference == optimal oracle (POOL-LESS leg — venue-only, zero leg pools)", () => {
  const DEEP = 10n ** 26n;
  const TS = 60;
  // Leg1 has NO pools — only a Curve venue. Covers the `legPools.length == 0` route shape (a leg
  // is dead only when pools AND venues are BOTH exhausted) and the venue-only member election.
  it("venue-only leg1 — all input via the route, wei-exact == oracle", () => {
    const amountIn = 2000n * E18;
    const qv = curveVenue([5_000_000n * E18, 5_000_000n * E18], 1000n, 4_000_000n);
    const a1 = nextAddr();
    const route: EcoRoute = {
      legs: [
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a1, 3000, TS, DEEP, 300, 0, true)] },
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [] },
      ],
      intermediateTokens: [nextAddr()],
    };
    const prepared: EcoSwapPrepared = {
      pools: [], routes: [route], brackets: [], zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT, expectedInputCovered: 0n,
    };
    const optRoute: OptimalRoute = {
      legs: [optLeg(3000, TS, DEEP, 0, true), { zeroForOne: true, pools: [], qlvs: [qv] }],
    };
    const kw = kwayReference(prepared, amountIn, undefined, [[undefined, [qv]]]);
    const opt = optimalSplit({ pools: [], routes: [optRoute], amountIn, zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT });
    assert.equal(kw.totalInput, amountIn, "spends amountIn exactly through the venue-only leg");
    assertQlRouteExact(kw, opt, "pool-less leg");
    assert.ok(kw.perLegQlvInput[0] > 0n, "the venue-only leg's venue took the whole leg flow");
    assert.equal(kw.perRouteInput[0], amountIn, "all input via the route");
  });
});

describe("k-way reference == optimal oracle (OPPOSITE-DIRECTION hop with a leg venue)", () => {
  const DEEP = 10n ** 26n;
  const TS = 60;
  // Second hop swaps oneForZero AND carries a venue next to its pool — the venue's model is
  // direction-stamped for the EDGE (i/j), the pool's frontier for the leg's zHop; the slice and
  // the bracket compete in the same leg-internal out/in space.
  it("z1=true, z2=false with a leg1 venue — wei-exact == oracle", () => {
    const amountIn = 5000n * E18;
    const qv = curveVenue([3_000_000n * E18, 3_000_000n * E18], 1000n, 4_000_000n);
    const dAddr = nextAddr();
    const a1 = nextAddr();
    const a2 = nextAddr();
    const direct: EcoPool = legPool(dAddr, 500, 10, 10n ** 24n, 300, 0, true);
    const route: EcoRoute = {
      legs: [
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a1, 3000, TS, DEEP, 300, 0, true)] },
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: false, pools: [legPool(a2, 3000, TS, DEEP, 300, 0, false)] },
      ],
      intermediateTokens: [nextAddr()],
    };
    const prepared: EcoSwapPrepared = {
      pools: [direct], routes: [route], brackets: [], zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT, expectedInputCovered: 0n,
    };
    const optDirect: OptimalPool = { isV2: false, feePpm: 500, sqrtPriceX96: getSqrtRatioAtTick(0), tick: 0, tickSpacing: 10, liquidity: 10n ** 24n, net: new Map() };
    const optRoute: OptimalRoute = {
      legs: [optLeg(3000, TS, DEEP, 0, true), { ...optLeg(3000, TS, DEEP, 0, false), qlvs: [qv] }],
    };
    const kw = kwayReference(prepared, amountIn, undefined, [[undefined, [qv]]]);
    const opt = optimalSplit({ pools: [optDirect], routes: [optRoute], amountIn, zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT });
    assert.equal(kw.totalInput, amountIn, "spends amountIn exactly");
    assertQlRouteExact(kw, opt, "opposite-direction leg venue");
    assert.ok(kw.perLegQlvInput[0] > 0n, "the reverse-hop venue engaged");
  });
});

describe("k-way reference == optimal oracle (3-hop MID-LEG venue — slice upstream AND downstream)", () => {
  const DEEP = 10n ** 26n;
  const TS = 60;
  // A→X→Y→B with the venue on the MIDDLE leg next to a pool: across the event walk the slice sits
  // upstream of some binding legs and downstream of others (both inversion regimes), and the
  // leg-internal election rotates between the slice and the bracket as the cut descends.
  for (const amountIn of [1000n * E18, 20_000n * E18]) {
    it(`3-hop mid-leg venue amountIn=${amountIn} — wei-exact == oracle`, () => {
      const qv = curveVenue([1_500_000n * E18, 1_500_000n * E18], 1000n, 4_000_000n);
      const a0 = nextAddr();
      const m1 = nextAddr();
      const a3 = nextAddr();
      const route: EcoRoute = {
        legs: [
          { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a0, 500, TS, DEEP, 400, 0, true)] },
          { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(m1, 3000, TS, DEEP, 400, 0, true)] },
          { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a3, 500, TS, DEEP, 400, 0, true)] },
        ],
        intermediateTokens: [nextAddr(), nextAddr()],
      };
      const prepared: EcoSwapPrepared = {
        pools: [], routes: [route], brackets: [], zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT, expectedInputCovered: 0n,
      };
      const optRoute: OptimalRoute = {
        legs: [
          optLeg(500, TS, DEEP, 0, true),
          { ...optLeg(3000, TS, DEEP, 0, true), qlvs: [qv] },
          optLeg(500, TS, DEEP, 0, true),
        ],
      };
      const kw = kwayReference(prepared, amountIn, undefined, [[undefined, [qv], undefined]]);
      const opt = optimalSplit({ pools: [], routes: [optRoute], amountIn, zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT });
      assert.equal(kw.totalInput, amountIn, "spends amountIn exactly through the 3-hop route");
      assertQlRouteExact(kw, opt, `3-hop mid venue A=${amountIn}`);
      assert.ok(kw.perLegQlvInput[0] > 0n, "the mid-leg venue engaged");
    });
  }
});

describe("k-way reference == optimal oracle (leg venue EXHAUSTION — remCap==0 kills the leg)", () => {
  const DEEP = 10n ** 26n;
  const TS = 60;
  // A notional-CAPPED WOOFi venue as leg0's ONLY member: past maxNotionalSwap the shared query
  // self-truncates to 0 (the on-chain tryQuery's 0-return), so the ladder stops EARLY and the
  // route can absorb only Σ slice capacities. Once the last slice's remCap hits 0 the cursor
  // exhausts, the venue drops out of election, leg0 dies, the route dies — and (route-only
  // universe) the merge halts short of amountIn. Deterministic: every event the venue's slice
  // binds (the deep leg1 bracket cross costs far more token-A), so the venue's qinp == Σ ladder
  // capacities EXACTLY, on both sides.
  it("capped leg0 venue drains fully; totalInput == Σ ladder capacities < amountIn (wei-exact == oracle)", () => {
    const amountIn = 50_000n * E18;
    const qv: OptimalLegQlVenue = {
      family: "wooFi",
      model: {
        address: nextAddr(), tokenIn: nextAddr(), tokenOut: nextAddr(), sellBase: true,
        price: 10n ** 8n, spread: 10n ** 14n, coeff: 10n ** 10n,
        priceDec: 10n ** 8n, quoteDec: E18, baseDec: E18,
        feeRate: 25n, maxNotionalSwap: 4000n * E18, maxGamma: 0n,
        feePpm: 350, source: "synthetic-leg-qlv",
      },
    };
    // The expected drained capacity — the SAME shared ladder both sides build (leg0 ⇒ cap == amountIn).
    const ladder = buildWooFiQLLadder(qv.model, amountIn);
    const drained = ladder.reduce((s, row) => s + row.capacity, 0n);
    assert.ok(ladder.length > 0 && drained < amountIn, "precondition: the capped venue's ladder stops early");
    const a2 = nextAddr();
    const route: EcoRoute = {
      legs: [
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [] },
        { hopIn: nextAddr(), hopOut: nextAddr(), zeroForOne: true, pools: [legPool(a2, 3000, TS, DEEP, 300, 0, true)] },
      ],
      intermediateTokens: [nextAddr()],
    };
    const prepared: EcoSwapPrepared = {
      pools: [], routes: [route], brackets: [], zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT, expectedInputCovered: 0n,
    };
    const optRoute: OptimalRoute = {
      legs: [{ zeroForOne: true, pools: [], qlvs: [qv] }, optLeg(3000, TS, DEEP, 0, true)],
    };
    const kw = kwayReference(prepared, amountIn, undefined, [[[qv], undefined]]);
    const opt = optimalSplit({ pools: [], routes: [optRoute], amountIn, zeroForOne: true, priceLimit: ROUTE_PRICE_LIMIT });
    assertQlRouteExact(kw, opt, "venue exhaustion");
    assert.equal(kw.perLegQlvInput[0], drained, "the venue's qinp mirror == Σ ladder capacities (fully drained)");
    assert.equal(kw.perRouteInput[0], drained, "route input == the drained capacity (leg0 venue = tokenIn)");
    assert.ok(kw.totalInput < amountIn, "the route dies short of the budget (venue exhausted)");
  });
});
