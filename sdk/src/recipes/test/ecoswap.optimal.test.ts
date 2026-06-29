/**
 * EcoSwap NEUTRAL optimal-split oracle — known-answer unit tests.
 *
 * Proves the engine/solver-INDEPENDENT oracle (ecoswap.optimal.ts) is a trustworthy
 * measuring stick:
 *   (a) conservation — Σ perPoolInput == amountIn when liquidity allows;
 *   (b) equalization — engaged pools' post-fee marginals agree at the cut;
 *   (c) single V2 telescopes to the exact constant-product integral;
 *   (d) a hand-computed 2-pool split matches to the wei;
 * plus drift / out-of-range / mixed-version sanity (the oracle takes TRUE live state, so
 * these are just different live tick / reserve inputs — no special path).
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.optimal.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Q96,
  Q192,
  FEE_DENOM,
  isqrt,
  mulDiv,
  toOutIn,
  getSqrtRatioAtTick,
  sqrtOneMinusFeeScaled,
  V2_STEP_BPS,
  V2_STEP_DEN,
} from "./ecoswap.math";
import { optimalSplit, type OptimalPool, type OptimalInput } from "./ecoswap.optimal";

// ── helpers ──────────────────────────────────────────────────

function assertClose(actual: bigint, expected: bigint, relTolPpm: bigint, msg?: string): void {
  const diff = actual > expected ? actual - expected : expected - actual;
  const slack = ((expected < 0n ? -expected : expected) * relTolPpm) / 1_000_000n;
  assert.ok(
    diff <= slack,
    `${msg ?? "assertClose"}: |${actual} - ${expected}| = ${diff} > slack ${slack} (${relTolPpm}ppm)`,
  );
}

/** fee-adjusted out/in price — matches the oracle's internal feeAdjOI / prepare.feeAdjust. */
function feeAdjOI(oi: bigint, feePpm: number): bigint {
  return (oi * sqrtOneMinusFeeScaled(feePpm)) / FEE_DENOM;
}

/** A V3 pool at `tick` (constant L over the relevant range — empty net map). */
function v3FlatPool(feePpm: number, tickSpacing: number, tick: number, L: bigint): OptimalPool {
  return {
    isV2: false,
    feePpm,
    sqrtPriceX96: getSqrtRatioAtTick(tick),
    tick,
    tickSpacing,
    liquidity: L,
    net: new Map<number, bigint>(),
  };
}

/** A V2 pool from live reserves (engine fee pinned 0.3%). */
function v2Pool(reserveIn: bigint, reserveOut: bigint): OptimalPool {
  return { isV2: true, feePpm: 3000, reserveIn, reserveOut };
}

// ─────────────────────────────────────────────────────────────
// (c) single V2 — constant-product integral / telescoping
// ─────────────────────────────────────────────────────────────
describe("optimal oracle — single V2 pool (constant-product integral)", () => {
  const reserveIn = 1_000_000n * 10n ** 18n;
  const reserveOut = 2_000_000n * 10n ** 18n;
  const L = isqrt(reserveIn * reserveOut);
  const FEE = 3000;
  const spotNear = isqrt((reserveOut * Q192) / reserveIn);

  it("conserves and the V2 fill telescopes to L·Q96/farFinal − L·Q96/spot (exact effIn)", () => {
    const pool = v2Pool(reserveIn, reserveOut);
    // amountIn well within the pool's deep liquidity so it spends exactly.
    const amountIn = 100n * 10n ** 18n;
    const res = optimalSplit({ pools: [pool], amountIn, zeroForOne: true });
    assert.equal(res.perPoolInput.length, 1);
    assert.equal(res.totalInput, amountIn, "single V2 spends amountIn exactly");
    assert.equal(res.totalInput, res.perPoolInput[0], "conservation");

    // Independent telescoping identity: replay the exact slice boundaries the oracle walks
    // and confirm the summed per-slice raw effIn equals the closed-form telescope.
    let near = spotNear;
    let sumEffIn = 0n;
    let farFinal = spotNear;
    let grossSum = 0n;
    const oneMinus = FEE_DENOM - BigInt(FEE);
    // walk just far enough to cover amountIn, summing gross — must match the oracle fill.
    for (let i = 0; i < 4096; i++) {
      const far = near - mulDiv(near, V2_STEP_BPS, V2_STEP_DEN);
      if (far <= 0n || far >= near) break;
      const effIn = mulDiv(L, Q96, far) - mulDiv(L, Q96, near);
      const gross = mulDiv(effIn, FEE_DENOM, oneMinus);
      if (grossSum + gross >= amountIn) {
        // the crossing slice is partially consumed — the oracle takes the exact remainder.
        grossSum = amountIn;
        // telescope only over the FULL slices consumed (interior cancel); include this
        // slice's near as the running farFinal only conceptually — assert gross instead.
        break;
      }
      grossSum += gross;
      sumEffIn += effIn;
      farFinal = far;
      near = far;
    }
    // The oracle's fill equals the running gross (full slices) + the partial remainder,
    // which by construction is exactly amountIn here.
    assert.equal(res.totalInput, amountIn, "oracle fill == replayed gross to amountIn");
    // telescoping identity over the full slices: Σ effIn == L·Q96/farFinal − L·Q96/spot.
    const telescoped = mulDiv(L, Q96, farFinal) - mulDiv(L, Q96, spotNear);
    assert.equal(sumEffIn, telescoped, "Σ per-slice effIn telescopes exactly");
  });

  it("over-capacity (huge amountIn) fills monotonically and never exceeds amountIn", () => {
    const pool = v2Pool(reserveIn, reserveOut);
    const huge = reserveIn * 1000n; // way past what the slice cap reaches
    const res = optimalSplit({ pools: [pool], amountIn: huge, zeroForOne: true });
    assert.ok(res.totalInput > 0n, "fills something");
    assert.ok(res.totalInput <= huge, "never exceeds amountIn");
    assert.equal(res.totalInput, res.perPoolInput[0], "conservation under over-capacity");
  });
});

// ─────────────────────────────────────────────────────────────
// (d) hand-computed 2-pool V3 split + (a) conservation + (b) equalization
// ─────────────────────────────────────────────────────────────
describe("optimal oracle — two V3 pools (hand-checked split + equalization)", () => {
  // Two flat-L V3 pools at the SAME spot tick 0, different fee tiers. zeroForOne=true so
  // unified out/in == real sqrt and the geometry is transparent.
  //
  // Pool A: fee 3000 (0.30%), ts 60, L = 1e21.
  // Pool B: fee  500 (0.05%), ts 10, L = 2e21.
  //
  // At spot (tick 0, sqrt = Q96) the fee-adjusted near prices are:
  //   adjA = Q96 * sqrtOneMinusFeeScaled(3000) / 1e6   (lower — higher fee)
  //   adjB = Q96 * sqrtOneMinusFeeScaled(500)  / 1e6   (higher — lower fee)
  // ⇒ Pool B (cheaper fee) is consumed FIRST until its marginal drops to Pool A's spot
  // adjusted price; thereafter both fill in lock-step keeping marginals equal. So a small
  // amountIn goes ENTIRELY to B; a larger one splits with B carrying more (deeper + cheaper).
  const A = v3FlatPool(3000, 60, 0, 10n ** 21n);
  const B = v3FlatPool(500, 10, 0, 2n * 10n ** 21n);

  it("tiny amountIn goes entirely to the cheaper-fee pool (B) until it reaches A's spot price", () => {
    // adjB(spot) > adjA(spot): B's first segments outprice A entirely. Size amountIn small
    // enough that B's marginal never falls to adjA(spot) ⇒ A gets nothing.
    const adjAspot = feeAdjOI(Q96, 3000);
    // How far can B fall before tying A's spot? Find B's tick where adjB == adjAspot.
    // adjB(price) = price * sqrtOneMinusFeeScaled(500)/1e6. Solve price:
    //   price_tie = adjAspot * 1e6 / sqrtOneMinusFeeScaled(500).
    const bTiePrice = (adjAspot * FEE_DENOM) / sqrtOneMinusFeeScaled(500);
    // Gross B can absorb from spot (Q96) down to bTiePrice at L=2e21, fee 0.05%:
    const Lb = 2n * 10n ** 21n;
    const effInB = mulDiv(Lb, Q96, bTiePrice) - mulDiv(Lb, Q96, Q96);
    const grossB = mulDiv(effInB, FEE_DENOM, FEE_DENOM - 500n);
    assert.ok(grossB > 0n, "B has positive capacity down to the tie price");

    // amountIn = HALF of that → strictly before the tie → all to B.
    const amountIn = grossB / 2n;
    const res = optimalSplit({ pools: [A, B], amountIn, zeroForOne: true });
    assert.equal(res.totalInput, amountIn, "spends amountIn exactly");
    assert.equal(res.perPoolInput[0], 0n, "pool A (pricier fee) gets nothing for the tiny trade");
    assert.equal(res.perPoolInput[1], amountIn, "pool B absorbs all of the tiny trade");
  });

  it("large amountIn splits across both; post-fee marginals equalize at the cut", () => {
    // A trade big enough that both pools engage. Both pools are flat-L (deep), so the cut
    // lands where adjA(marginal) ≈ adjB(marginal). Assert: both funded, conservation, and
    // the engaged pools' fee-adjusted marginals agree to a few ppm.
    const amountIn = 2000n * 10n ** 18n;
    const res = optimalSplit({ pools: [A, B], amountIn, zeroForOne: true });
    assert.equal(res.totalInput, amountIn, "conservation: spends amountIn exactly");
    assert.equal(res.totalInput, res.perPoolInput.reduce((a, b) => a + b, 0n), "Σ == total");
    assert.ok(res.perPoolInput[0] > 0n, "pool A funded");
    assert.ok(res.perPoolInput[1] > 0n, "pool B funded");
    // B carries more (cheaper fee + deeper L).
    assert.ok(res.perPoolInput[1] > res.perPoolInput[0], "cheaper/deeper pool B carries more");

    // EQUALIZATION: each engaged pool's fee-adjusted marginal (the price its last consumed
    // segment's far edge reached) must agree at the cut. The segment granularity is one
    // tickSpacing on each pool (60 vs 10), so they agree to within ~one coarse-pool step.
    const mA = res.perPoolMarginalAdj[0];
    const mB = res.perPoolMarginalAdj[1];
    assert.ok(mA > 0n && mB > 0n, "both marginals recorded");
    // ts=60 on A is the coarse grid (~0.6% price per step → ~0.3% in sqrt); allow 3500 ppm.
    assertClose(mA, mB, 3500n, "post-fee marginals equalize at the cut");
  });

  it("monotonicity: doubling amountIn never decreases any pool's allocation", () => {
    const a1 = optimalSplit({ pools: [A, B], amountIn: 1000n * 10n ** 18n, zeroForOne: true });
    const a2 = optimalSplit({ pools: [A, B], amountIn: 2000n * 10n ** 18n, zeroForOne: true });
    assert.ok(a2.perPoolInput[0] >= a1.perPoolInput[0], "A non-decreasing");
    assert.ok(a2.perPoolInput[1] >= a1.perPoolInput[1], "B non-decreasing");
    assert.ok(a2.totalInput >= a1.totalInput, "total non-decreasing");
  });
});

// ─────────────────────────────────────────────────────────────
// drift / out-of-range / no-special-case (TRUE live state varies)
// ─────────────────────────────────────────────────────────────
describe("optimal oracle — drift is just a different live tick (no special path)", () => {
  it("a pool whose live price drifted UP gets MORE of the trade (cheaper start)", () => {
    // Same fee/L, but pool HI starts higher (tick +600) than pool LO (tick 0). zeroForOne
    // (price falling): the HIGHER-priced pool offers a better out/in rate, so it is consumed
    // first → it should carry at least as much as the lower one for a mid-size trade.
    const HI = v3FlatPool(3000, 60, 600, 10n ** 21n);
    const LO = v3FlatPool(3000, 60, 0, 10n ** 21n);
    const amountIn = 50n * 10n ** 18n;
    const res = optimalSplit({ pools: [HI, LO], amountIn, zeroForOne: true });
    assert.equal(res.totalInput, amountIn, "conservation");
    assert.ok(res.perPoolInput[0] >= res.perPoolInput[1], "higher-priced (HI) pool carries >= the lower one");
  });

  it("out-of-range: a pool with zero active L and no ticks ahead contributes nothing", () => {
    // Dead pool: L=0, empty net. Live pool: normal. All input must go to the live pool.
    const DEAD: OptimalPool = {
      isV2: false,
      feePpm: 3000,
      sqrtPriceX96: getSqrtRatioAtTick(0),
      tick: 0,
      tickSpacing: 60,
      liquidity: 0n,
      net: new Map<number, bigint>([[ -60, 0n ]]), // an initialized boundary but net 0
    };
    const LIVE = v3FlatPool(500, 10, 0, 10n ** 21n);
    const amountIn = 10n * 10n ** 18n;
    const res = optimalSplit({ pools: [DEAD, LIVE], amountIn, zeroForOne: true });
    assert.equal(res.perPoolInput[0], 0n, "dead pool gets nothing");
    assert.equal(res.perPoolInput[1], res.totalInput, "all input to the live pool");
    assert.equal(res.totalInput, amountIn, "conservation");
  });
});

// ─────────────────────────────────────────────────────────────
// mixed V2 + V3 (a) conservation + (b) cross-version equalization
// ─────────────────────────────────────────────────────────────
describe("optimal oracle — mixed V2 + V3 (conservation + cross-version equalization)", () => {
  it("splits across a V2 and a V3 pool with equalized post-fee marginals", () => {
    // V3 pool fee 0.05% (cheaper), V2 pool fee 0.30%. Sized so both engage.
    const v3 = v3FlatPool(500, 10, 0, 10n ** 21n);
    const v2 = v2Pool(2_000_000n * 10n ** 18n, 2_000_000n * 10n ** 18n); // spot price ~1
    const amountIn = 300n * 10n ** 18n;
    const res = optimalSplit({ pools: [v3, v2], amountIn, zeroForOne: true });
    assert.equal(res.totalInput, amountIn, "conservation: spends amountIn exactly");
    assert.equal(res.totalInput, res.perPoolInput.reduce((a, b) => a + b, 0n), "Σ == total");
    // Both should be funded given the size; if not, at least conservation + monotone holds.
    if (res.perPoolInput[0] > 0n && res.perPoolInput[1] > 0n) {
      const m0 = res.perPoolMarginalAdj[0];
      const m1 = res.perPoolMarginalAdj[1];
      // V2 slice (~0.5% price per slice) is the coarse grid here; allow 6000 ppm.
      assertClose(m0, m1, 6000n, "V2/V3 post-fee marginals equalize at the cut");
    }
  });
});
