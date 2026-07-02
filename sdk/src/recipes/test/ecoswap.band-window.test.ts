/**
 * EcoSwap CL survivorship PRICE-BAND window — fast, no-network regression.
 *
 * The lens's survivorship in-range-capacity metric + the per-pool deactivation window
 * used to walk a FIXED tick COUNT (V3_TICK_STEPS / maxTicks = 96) for EVERY pool. For a
 * TIGHT tickSpacing (ts=1, the 0.01% stable tier) 96 ticks ≈ a 0.96% price band, so a
 * large stable swap walked PAST it and the pool's in-range capacity Σ was UNDER-measured →
 * its relative-depth share understated → it could be DROPPED by the minRelBps filter
 * despite genuinely qualifying (the "Maverick class": a deep pool dropped for a
 * non-liquidity reason). See ecoswap.allpools.prodmirror.evm.test.ts for the real-pool
 * proof (Pancake 0.01% ts=1: dropped on v1 under the old 96 window, kept on BOTH engines
 * under the band window).
 *
 * The fix scales the per-pool budget to a FIXED PRICE BAND:
 *   effTicks(ts) = clamp( bandTicks / max(1, ts), LO=96, HI=maxTicks )
 * so a ts=1 pool scans MANY boundaries to cover the same % band a wide-ts pool covers in a
 * few, while every ts>=bandTicks/96 tier floors at LO=96 — byte-identical to the old fixed
 * window (no wide-ts regression, wei-exact preserved for those tiers by construction).
 *
 * This test pins that formula (a TS mirror of the on-chain `effTicks` in
 * ecoswap.lens.sauce.ts) and the shipped constants, guarding against a future regression of
 * either. It is pure arithmetic — no anvil, no RPC.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LENS_WINDOW_LO, LENS_MAX_TICKS, LENS_BAND_TICKS } from "../ecoswap/lens";

/** TS mirror of the on-chain effTicks(ts, bandTicks, maxTicks) — MUST stay identical. */
function effTicks(ts: number, bandTicks: number, maxTicks: number): number {
  const LO = 96;
  const denom = Math.max(1, ts);
  let n = Math.floor(bandTicks / denom);
  if (n < LO) n = LO;
  if (n > maxTicks) n = maxTicks;
  return n;
}

describe("EcoSwap CL survivorship price-band window (effTicks scaling)", () => {
  it("ships a gas-bounded band + ceiling (LO=96 <= BAND <= HI, HI within a live eth_call cap)", () => {
    assert.equal(LENS_WINDOW_LO, 96, "LO must remain the legacy fixed window (no wide-ts regression)");
    assert.ok(LENS_BAND_TICKS >= LENS_WINDOW_LO, "band must be at least the legacy window");
    assert.ok(LENS_MAX_TICKS >= LENS_BAND_TICKS, "HI (maxTicks) must be >= band so effTicks can reach the band");
    // HI=256 keeps the v1 lens read ≈503M gas (the heavier engine; ≈234M at the legacy 96
    // window) and the v12 read far lower on the heavy 10-pool prod-mirror universe — both under
    // a live RPC's eth_call cap (Alchemy ≈550M). Guard the ceiling so a future bump stays
    // gas-aware. (Measured by harness/lens-gas-probe.ts.)
    assert.ok(LENS_MAX_TICKS <= 512, "HI must stay gas-bounded (a bigger ceiling risks the eth_call cap)");
  });

  it("gives a TIGHT ts=1 pool MORE ticks than a wide-ts pool (same % band)", () => {
    const ts1 = effTicks(1, LENS_BAND_TICKS, LENS_MAX_TICKS);
    const ts10 = effTicks(10, LENS_BAND_TICKS, LENS_MAX_TICKS);
    const ts60 = effTicks(60, LENS_BAND_TICKS, LENS_MAX_TICKS);
    const ts200 = effTicks(200, LENS_BAND_TICKS, LENS_MAX_TICKS);
    // ts=1 (the 0.01% stable tier) walks strictly more boundaries than the wider tiers —
    // it needs bandTicks/1 steps to cover the same raw-tick band a wide tier covers in fewer.
    assert.ok(ts1 > ts10, `ts=1 (${ts1}) must scan more than ts=10 (${ts10})`);
    assert.ok(ts1 > ts60, `ts=1 (${ts1}) must scan more than ts=60 (${ts60})`);
    assert.ok(ts1 > ts200, `ts=1 (${ts1}) must scan more than ts=200 (${ts200})`);
    // ts=1 spans the FULL band (bandTicks raw ticks), not the legacy 96 (~10x more at band=256).
    assert.equal(ts1, Math.min(LENS_BAND_TICKS, LENS_MAX_TICKS), "ts=1 covers the full band budget");
    assert.ok(ts1 > 96, "ts=1 must exceed the old fixed 96-tick window (the under-measurement fix)");
  });

  it("floors every wide-ts tier at the legacy 96 window (byte-identical to the old behavior)", () => {
    // Every standard/Slipstream tickSpacing with ts >= bandTicks/96 floors at LO=96 — so those
    // tiers scan EXACTLY the old fixed 96 window and their wei-exact parity is preserved by
    // construction. At band=256: 256/96 ≈ 2.67, so ts>=3 floors at 96; ts=1 and ts=2 exceed it.
    for (const ts of [10, 50, 60, 100, 200, 2000]) {
      assert.equal(
        effTicks(ts, LENS_BAND_TICKS, LENS_MAX_TICKS),
        96,
        `ts=${ts} must floor at the legacy 96 window`,
      );
    }
  });

  it("bandTicks=0 reproduces the legacy fixed-96 window for EVERY pool", () => {
    for (const ts of [1, 2, 10, 50, 60, 200]) {
      assert.equal(effTicks(ts, 0, LENS_MAX_TICKS), 96, `band=0 → ts=${ts} floors at 96 (legacy)`);
    }
  });

  it("never exceeds the HARD gas ceiling (HI) even for the tightest ts", () => {
    // A pathological ts=1 with a huge band still clamps to HI — the per-pool staticcall cost
    // (hence the lens's total gas) is bounded regardless of the band.
    assert.equal(effTicks(1, 100000, LENS_MAX_TICKS), LENS_MAX_TICKS, "ts=1 clamps to HI");
    assert.equal(effTicks(0, 100000, LENS_MAX_TICKS), LENS_MAX_TICKS, "ts=0 (guarded to 1) clamps to HI");
  });
});
