/**
 * EcoSwap Curve StableSwap local-EVM integration — the engine `_swapCurve` exact-in-dy gate.
 *
 * Stands up a local Curve StableSwap plain-pool (the CurveStableSwap.sol fixture, whose
 * get_D/get_y/get_dy mirror the off-chain `curve-math.ts` replay bit-for-bit), deploys the
 * Sauce engine, and cooks an EcoSwap whose static-segment cursor consumes Curve segments and
 * executes them via the unified swap(SwapParams{poolType:3}) → live `_swapCurve` (one atomic
 * exchange per venue). Then asserts:
 *
 *   (1) SOLO Curve venue — the on-chain dy the caller receives == off-chain get_dy(awarded
 *       share) to the WEI (the exact-in-dy gate: one atomic exchange lands exactly the segment-
 *       summed output the merge accounted for). NO tolerance.
 *   (2) TWO Curve venues — ONE EcoSwap splits across both; each leg's received output ==
 *       get_dy(its awarded share) to the wei, and the post-fee marginals equalize within the
 *       sampled-grid bound (the documented exact-on-grid standard).
 *
 * The Curve math is OFF-CHAIN only: the on-chain solver supplies Curve as STATIC (capacity,
 * marginalOI) segments and never recomputes the StableSwap invariant. We build the prepared
 * args DIRECTLY (Curve discovery uses a registry whose addresses are placeholders), then
 * compile the production solver template exactly as index.ts does and cook it.
 *
 * No fork / no RPC env needed — a local fixture etches the whole stack. Runs on v1 (+ v12 when
 * the v12 artifacts are present). Driven by ECO_ENGINE (default v12).
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { compileSauce, ECOSWAP_DIR } from "./harness/compile";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  deploySortedTokens,
  mint,
  approve,
  balanceOf,
  deployCurveStableSwap,
  curveAbi,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  type Engine,
  engineCells,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getDy, buildCurveSegments, type CurvePool } from "../shared/curve-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const HUGE = parseEther("1000000000");
const E18 = 10n ** 18n;
const ENGINE_CELLS = engineCells();

// Curve-only run: zero direct pools/routes/netCache; the Curve venues ride entirely inside
// routeSegs (segKind 1). The solver's 9 compiler args, in index.ts order.
function curveArgs(
  tokenIn: Hex,
  tokenOut: Hex,
  amountIn: bigint,
  caller: Hex,
  routeSegs: bigint[][],
): unknown[] {
  return [
    BigInt(tokenIn),
    BigInt(tokenOut),
    amountIn,
    BigInt(caller),
    MIN_SQRT_RATIO + 1n, // priceLimit (unused by Curve; the merge ignores it for static segs)
    [], // pools (no direct V2/V3/V4 venue)
    [], // routes
    [], // netCache
    routeSegs,
  ];
}

// One Curve venue → its sampled segments as routeSegs rows. refIdx tags the on-chain per-venue
// accumulator (cinp[refIdx]); venue is the exchange() pool address. Built from the SAME
// buildCurveSegments the oracle uses, so the awarded Σ == the off-chain share by construction.
function curveSegRows(pool: CurvePool, refIdx: number, amountIn: bigint): bigint[][] {
  return buildCurveSegments(pool, amountIn).map((s) => [
    BigInt(refIdx),
    s.capacity,
    s.marginalOI, // sqrtAdjNear (post-fee; the descending-price sort key)
    s.marginalOI, // sqrtAdjFar (a Curve segment is a flat slice)
    1n, // segKind = Curve
    BigInt(pool.address),
  ]);
}

// Interleave + sort routeSegs rows the way index.ts buildRouteSegs does: DESC by sqrtAdjNear,
// then DESC by sqrtAdjFar, then by refIdx. The on-chain static-segment cursor consumes them in
// array order, so the global price order MUST be materialized here (multiple venues interleaved).
function sortRouteSegs(rows: bigint[][]): bigint[][] {
  return rows.slice().sort((a, b) => {
    if (a[2] !== b[2]) return a[2] < b[2] ? 1 : -1;
    if (a[3] !== b[3]) return a[3] < b[3] ? 1 : -1;
    return Number(a[0] - b[0]);
  });
}

describe("EcoSwap Curve StableSwap (local fixture) — engine _swapCurve exact-in-dy", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex;
  let tokenOut: Hex;
  let solverSrc: string;
  let cleanSnapshot: Hex;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;
    solverSrc = readFileSync(SOLVER, "utf-8");

    // Plenty of both tokens for funding pools + the caller's input.
    await mint(c.walletClient, c.publicClient, tokenIn, c.account0, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, c.account0, parseEther("50000000"));

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function reset(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
  }

  // Off-chain CurvePool descriptor for the deployed fixture (i=tokenIn coin 0, j=tokenOut coin 1).
  function offPool(address: Hex, balances: bigint[], a: bigint, fee: bigint): CurvePool {
    return {
      poolType: 3,
      address,
      i: 0,
      j: 1,
      A: a,
      aPrecision: 100n,
      balances,
      rates: [E18, E18],
      feePpm10: fee,
      source: "local-fixture",
    };
  }

  // ── (1) SOLO Curve venue — received == get_dy(share) to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Imbalanced 2-coin pool (coin1 deeper). A=1000, fee=0.04%.
    const balances = [1_000_000n * E18, 1_200_000n * E18];
    const A = 1000n;
    const FEE = 4_000_000n;
    const pool = await deployCurveStableSwap(
      c.walletClient, c.publicClient, [tokenIn, tokenOut], balances, [E18, E18], A, FEE, caller,
    );
    const op = offPool(pool, balances, A, FEE);

    // amountIn == the full sampled ladder cap ⇒ the merge awards the WHOLE Σ to this one venue,
    // so the awarded share == amountIn and the executed exchange is get_dy(amountIn).
    const amountIn = 150_000n * E18;
    const segRows = curveSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Curve segment ladder");
    // The sampled grid's Σ capacity equals amountIn (last sample s==M → input==amountIn).
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);
    assert.equal(segSum, amountIn, "Curve segments cover the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, curveArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    // The fixture's own on-chain get_dy view, read on the PRE-swap state (exchange mutates
    // balances). This is the engine-independent ground truth for the executed dy of `amountIn`.
    const onViewPre = (await c.publicClient.readContract({
      address: pool, abi: curveAbi, functionName: "get_dy", args: [0n, 1n, amountIn],
    })) as bigint;

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo Curve cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    // The whole amountIn flowed into the one Curve venue.
    assert.equal(spent, amountIn, "spent == amountIn (the whole trade routed to Curve)");
    assert.equal(poolIn, amountIn, "the Curve pool received the full input share");

    // WEI-EXACT-IN-DY: the on-chain executed dy (the caller's received tokenOut) equals the
    // off-chain get_dy(awarded share) to the WEI. One atomic exchange. NO tolerance.
    assert.equal(received, getDy(op, spent), "received == get_dy(share) to the wei (exact-in-dy)");
    // Cross-check against the fixture's own on-chain PRE-swap view (independent of the off-chain
    // replay) — the engine executed exactly this view's output, to the wei.
    assert.equal(received, onViewPre, "received == on-chain get_dy view (exact-in-dy)");

    console.log(`  [Curve solo:${engine}] spent=${spent} received=${received} (== get_dy to the wei)`);
  }

  // ── (2) TWO Curve venues — split + per-leg exact-in-dy + marginals equalize ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Two venues at the SAME spot (balanced 1:1) but different A/fee → different marginal
    // curves, so the water-fill engages BOTH and equalizes their post-fee marginals. Low A
    // (steeper curve) + a trade sized to bend both off peg makes the split non-degenerate.
    const balA = [1_000_000n * E18, 1_000_000n * E18];
    const balB = [1_000_000n * E18, 1_000_000n * E18];
    const AA = 100n, FA = 1_000_000n; // steeper, low fee → draws first + more
    const AB = 50n, FB = 4_000_000n; // steeper still, higher fee
    const poolA = await deployCurveStableSwap(
      c.walletClient, c.publicClient, [tokenIn, tokenOut], balA, [E18, E18], AA, FA, caller,
    );
    const poolB = await deployCurveStableSwap(
      c.walletClient, c.publicClient, [tokenIn, tokenOut], balB, [E18, E18], AB, FB, caller,
    );
    const opA = offPool(poolA, balA, AA, FA);
    const opB = offPool(poolB, balB, AB, FB);

    const amountIn = 600_000n * E18;
    // Each venue's segments capped at amountIn (the same bound the oracle samples). refIdx 0/1.
    // The solver's static-segment cursor walks routeSegs in array order assuming a global
    // DESCENDING price (sqrtAdjNear) order — so the two venues' segments must be INTERLEAVED and
    // sorted exactly as index.ts buildRouteSegs does (adjNear DESC, then adjFar DESC, then refIdx).
    const segRows = sortRouteSegs([...curveSegRows(opA, 0, amountIn), ...curveSegRows(opB, 1, amountIn)]);

    const { bytecodes } = compileSauce(
      solverSrc, curveArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const aInBefore = await balanceOf(c.publicClient, tokenIn, poolA);
    const bInBefore = await balanceOf(c.publicClient, tokenIn, poolB);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue Curve cook() must succeed");

    const aIn = (await balanceOf(c.publicClient, tokenIn, poolA)) - aInBefore;
    const bIn = (await balanceOf(c.publicClient, tokenIn, poolB)) - bInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // BOTH venues funded; the deep/low-fee A draws strictly more.
    assert.ok(aIn > 0n && bIn > 0n, "both Curve venues are funded");
    assert.ok(aIn > bIn, `deep/low-fee venue A draws more than B (A ${aIn} > B ${bIn})`);

    // PER-LEG WEI-EXACT-IN-DY: the caller's received tokenOut == get_dy_A(aIn) + get_dy_B(bIn)
    // (each venue executes one atomic exchange on its awarded share). NO tolerance.
    const expected = getDy(opA, aIn) + getDy(opB, bIn);
    assert.equal(received, expected, "received == Σ get_dy(per-venue share) to the wei");

    // MARGINALS EQUALIZE within the grid bound: the post-fee marginal price each venue reaches
    // at its awarded share agrees to a few ppm (the exact-on-grid bound at M=24). The marginal is
    // the last sampled segment's price ≤ the awarded share; approximate via get_dy slope at the share.
    const margA = marginalAt(opA, aIn);
    const margB = marginalAt(opB, bIn);
    const diff = margA > margB ? margA - margB : margB - margA;
    const relPpm = (diff * 1_000_000n) / margA;
    assert.ok(relPpm <= 200n, `Curve split marginals equalize (rel ${relPpm} ppm; A ${margA} B ${margB})`);

    console.log(
      `  [Curve split:${engine}] A in=${aIn} B in=${bIn} received=${received} ` +
        `(== Σ get_dy to the wei); marginals A=${margA} B=${margB} (${relPpm} ppm)`,
    );
  }

  // Post-fee out/in marginal price at a cumulative input `share`, in the unified √(out/in·2^192)
  // space — a small finite-difference slice of get_dy around `share` (the same coordinate the
  // segments carry). Used only to check the split equalized marginals.
  function marginalAt(pool: CurvePool, share: bigint): bigint {
    if (share <= 0n) return 0n;
    const eps = share / 1000n > 0n ? share / 1000n : 1n;
    const lo = share - eps > 0n ? share - eps : 0n;
    const dIn = share - lo;
    const dOut = getDy(pool, share) - getDy(pool, lo);
    if (dIn <= 0n || dOut <= 0n) return 0n;
    return isqrt((dOut * (1n << 192n)) / dIn);
  }
  function isqrt(x: bigint): bigint {
    if (x <= 0n) return 0n;
    let z = x;
    let y = (z + 1n) / 2n;
    while (y < z) {
      z = y;
      y = (x / y + y) / 2n;
    }
    return z;
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`Curve solo [${engine}] — received == get_dy(share) to the wei (exact-in-dy)`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`Curve split [${engine}] — two venues, per-leg exact-in-dy + marginals equalize`, { skip }, async () => {
      await runSplit(engine);
    });
  }
});
