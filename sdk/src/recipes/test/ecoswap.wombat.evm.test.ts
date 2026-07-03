/**
 * EcoSwap Wombat (single-sided stableswap) local-EVM integration — the callback-free exact-in-dy gate.
 *
 * Stands up a local Wombat pool (the WombatPool.sol fixture, whose CoreV2 coverage-ratio quote +
 * haircut mirror the off-chain `wombat-math.ts` replay bit-for-bit), deploys the Sauce engine, and
 * cooks an EcoSwap whose static-segment cursor consumes Wombat segments (segKind 5) and executes them
 * CALLBACK-FREE: an on-chain `pool.quotePotentialSwap(fromToken, toToken, awarded)` staticcall +
 * approve + `pool.swap(fromToken, toToken, awarded, minOut, to, deadline)` (Wombat PULLS via
 * transferFrom; NO engine SwapPoolType — Wombat is single-sided stableswap, NOT xy=k, so it must NOT
 * go through _swapV2). Then asserts:
 *
 *   (1) SOLO Wombat venue — the on-chain dy the caller receives == off-chain quotePotentialSwap(awarded
 *       share) AND == the pool's own quotePotentialSwap view to the WEI (the exact-in-dy gate: the
 *       pool view IS the swap math). NO tolerance.
 *   (2) TWO Wombat venues — ONE EcoSwap splits across both; each leg's received output ==
 *       quotePotentialSwap(its awarded share) to the wei, and the post-fee marginals equalize within
 *       the sampled-grid bound (the documented exact-on-grid standard).
 *
 * The Wombat math is OFF-CHAIN only for the SPLIT: the on-chain solver supplies the curve as STATIC
 * (capacity, marginalOI) segments and never recomputes the coverage-ratio quote. We build the prepared
 * args DIRECTLY (Wombat discovery uses a pool whose address is a placeholder here), then compile the
 * production solver template exactly as index.ts does and cook it.
 *
 * No fork / no RPC env needed — a local fixture etches the whole stack. Runs on v1 (+ v12 when the v12
 * artifacts are present). Driven by ECO_ENGINE (default v12). Mirrors ecoswap.solidly.evm.test.ts.
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
  deployWombatPool,
  wombatPoolAbi,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import {
  quotePotentialSwap,
  buildWombatSegments,
  type WombatPool,
} from "../shared/wombat-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const AMP = 2n * 10n ** 15n; // 0.002e18 = 0.2% (canonical Wombat main-pool amp)
const HC = 10n ** 14n; // 0.0001e18 = 0.01% haircut
const ENGINE_CELLS = engineCells();

// Wombat-only run: zero direct pools/routes/netCache; the Wombat venues ride entirely inside segs
// (segKind 5). The solver's 5 compiler args, in index.ts order (cfg, pools, netCache, routing, segs).
function wombatArgs(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, segs: bigint[][]): unknown[] {
  return [
    [
      BigInt(tokenIn),
      BigInt(tokenOut),
      amountIn,
      BigInt(caller),
      MIN_SQRT_RATIO + 1n, // priceLimit (unused by static segments)
      0n, // directCount — no direct pools
    ],
    [], // pools
    [], // netCache
    [], // routing
    segs,
    [], // qlv — no QL (Quote-Ladder) descriptors in this static-segment universe
  ];
}

// One Wombat venue → its sampled segments as segs rows. refIdx tags the on-chain per-venue accumulator
// (winp[refIdx]); venue is the pool address. Built from the SAME buildWombatSegments the oracle uses,
// so the awarded Σ == the off-chain share by construction. segKind = 5.
function wombatSegRows(pool: WombatPool, refIdx: number, amountIn: bigint): bigint[][] {
  return buildWombatSegments(pool, amountIn).map((s) => [
    BigInt(refIdx),
    s.capacity,
    s.marginalOI, // sqrtAdjNear (post-haircut; the descending-price sort key)
    s.marginalOI, // sqrtAdjFar (a Wombat segment is a flat slice)
    5n, // segKind = Wombat (callback-free)
    BigInt(pool.address),
    0n, // venueAux (segs[6]) — unused for non-Mento kinds; padded to mirror production's 7-col seg shape
  ]);
}

// Interleave + sort segs rows the way index.ts buildSegs does: DESC by sqrtAdjNear, then DESC by
// sqrtAdjFar, then by refIdx. The on-chain static-segment cursor consumes them in array order, so the
// global price order MUST be materialized here.
function sortSegs(rows: bigint[][]): bigint[][] {
  return rows.slice().sort((a, b) => {
    if (a[2] !== b[2]) return a[2] < b[2] ? 1 : -1;
    if (a[3] !== b[3]) return a[3] < b[3] ? 1 : -1;
    return Number(a[0] - b[0]);
  });
}

describe("EcoSwap Wombat (single-sided stableswap, local fixture) — callback-free exact-in-dy", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == token0 (lower address)
  let tokenOut: Hex; // == token1
  let solverSrc: string;
  // Each cell runs on its OWN fresh anvil + freshly-deployed stack (setup() below): no shared
  // mutable node state between cells, so there is no snapshot/loadState reset race (the old
  // revert+re-snapshot dance dropped a cell to a 0-fill; a bare loadState MERGES and drifts each
  // cell's pool address). reset() just tears the anvil down and rebuilds. See setup().

  // Boot a fresh anvil + deploy the whole stack. Called by before() once and by reset() before
  // every subsequent cell, tearing the prior anvil down first — so each cell is fully isolated.
  async function setup(): Promise<void> {
    anvil?.stop();
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;
    solverSrc = readFileSync(SOLVER, "utf-8");

    await mint(c.walletClient, c.publicClient, tokenIn, c.account0, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, c.account0, parseEther("50000000"));

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
  }

  before(setup);

  after(() => {
    anvil?.stop();
  });

  async function reset(): Promise<void> {
    await setup();
  }

  // Off-chain WombatPool descriptor for the deployed fixture (tokenIn = token0, tokenOut = token1).
  function offPool(
    address: Hex,
    fromCash: bigint,
    fromLiability: bigint,
    toCash: bigint,
    toLiability: bigint,
  ): WombatPool {
    return {
      address,
      fromCash,
      fromLiability,
      toCash,
      toLiability,
      ampFactor: AMP,
      haircutRate: HC,
      decIn: E18,
      decOut: E18,
      tokenIn,
      tokenOut,
      feePpm: 100,
      source: "local-fixture",
    };
  }

  // ── (1) SOLO Wombat venue — received == quotePotentialSwap(share) to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Balanced coverage on both assets; the pool HOLDS reserve1 (== cash1, 18-dec) to pay out tokenOut.
    const cash0 = 1_000_000n * E18, liab0 = 1_000_000n * E18;
    const cash1 = 1_000_000n * E18, liab1 = 1_000_000n * E18;
    const pool = await deployWombatPool(
      c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18,
      cash0, liab0, cash1, liab1, AMP, HC,
      0n, cash1, // reserve0 unneeded (we sell INTO token0); pool holds token1 to pay out
      caller,
    );
    const op = offPool(pool, cash0, liab0, cash1, liab1);

    // amountIn == the full sampled ladder cap ⇒ the merge awards the WHOLE Σ to this one venue.
    const amountIn = 100_000n * E18;
    const segRows = wombatSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Wombat segment ladder");
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);
    assert.equal(segSum, amountIn, "Wombat segments cover the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, wombatArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    // The fixture's own on-chain quotePotentialSwap view on the PRE-swap state — the engine-independent
    // ground truth for the executed dy of `amountIn`.
    const onViewPre = (await c.publicClient.readContract({
      address: pool, abi: wombatPoolAbi, functionName: "quotePotentialSwap",
      args: [tokenIn, tokenOut, amountIn],
    })) as readonly [bigint, bigint];

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo Wombat cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (the whole trade routed to the Wombat pool)");
    assert.equal(poolIn, amountIn, "the Wombat pool pulled the full input share");

    // WEI-EXACT-IN-DY: the on-chain received tokenOut == off-chain quotePotentialSwap(awarded share)
    // == the pool's own PRE-swap quotePotentialSwap view, all to the WEI. NO tolerance.
    assert.equal(received, quotePotentialSwap(op, spent), "received == quotePotentialSwap(share) to the wei");
    assert.equal(received, onViewPre[0], "received == on-chain quotePotentialSwap view (exact-in-dy)");

    console.log(`  [Wombat solo:${engine}] spent=${spent} received=${received} (== quotePotentialSwap to the wei)`);
  }

  // ── (2) TWO Wombat venues — split + per-leg exact-in-dy + marginals equalize ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Two venues at the SAME balanced coverage but different depth → different marginal curves, so the
    // water-fill engages BOTH and equalizes their post-haircut marginals. A drives first + more (deeper).
    const aCash = 3_000_000n * E18; // deep
    const bCash = 1_000_000n * E18; // shallower
    const poolA = await deployWombatPool(
      c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18,
      aCash, aCash, aCash, aCash, AMP, HC, 0n, aCash, caller,
    );
    const poolB = await deployWombatPool(
      c.walletClient, c.publicClient, tokenIn, tokenOut, E18, E18,
      bCash, bCash, bCash, bCash, AMP, HC, 0n, bCash, caller,
    );
    const opA = offPool(poolA, aCash, aCash, aCash, aCash);
    const opB = offPool(poolB, bCash, bCash, bCash, bCash);

    const amountIn = 800_000n * E18;
    const segRows = sortSegs([...wombatSegRows(opA, 0, amountIn), ...wombatSegRows(opB, 1, amountIn)]);

    const { bytecodes } = compileSauce(
      solverSrc, wombatArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const aInBefore = await balanceOf(c.publicClient, tokenIn, poolA);
    const bInBefore = await balanceOf(c.publicClient, tokenIn, poolB);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue Wombat cook() must succeed");

    const aIn = (await balanceOf(c.publicClient, tokenIn, poolA)) - aInBefore;
    const bIn = (await balanceOf(c.publicClient, tokenIn, poolB)) - bInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(aIn > 0n && bIn > 0n, "both Wombat venues are funded");
    assert.ok(aIn > bIn, `deep venue A draws more than B (A ${aIn} > B ${bIn})`);

    // PER-LEG WEI-EXACT-IN-DY: received == quotePotentialSwap_A(aIn) + quotePotentialSwap_B(bIn).
    const expected = quotePotentialSwap(opA, aIn) + quotePotentialSwap(opB, bIn);
    assert.equal(received, expected, "received == Σ quotePotentialSwap(per-venue share) to the wei");

    // MARGINALS EQUALIZE within the GRID bound. The SPLIT is exact-on-grid (the awarded inputs equal
    // the oracle bit-for-bit — checked by the wei-exact gate above), but the realized post-fee marginal
    // each venue reaches equalizes only to within ONE sampled segment's price width. The Wombat curve
    // is very FLAT near full coverage, so a single M=24 segment spans a wide price band: the cut gap is
    // a documented grid bound (it converges as M grows). The SPLIT itself is exact.
    const margA = marginalAt(opA, aIn);
    const margB = marginalAt(opB, bIn);
    const diff = margA > margB ? margA - margB : margB - margA;
    const relPpm = margA > 0n ? (diff * 1_000_000n) / margA : 0n;
    assert.ok(relPpm <= 2500n, `Wombat split marginals equalize on the M=24 grid (rel ${relPpm} ppm; A ${margA} B ${margB})`);

    console.log(
      `  [Wombat split:${engine}] A in=${aIn} B in=${bIn} received=${received} ` +
        `(== Σ quotePotentialSwap to the wei); marginals A=${margA} B=${margB} (${relPpm} ppm)`,
    );
  }

  // Post-fee out/in marginal price at a cumulative input `share` — a small finite-difference slice of
  // quotePotentialSwap around `share` (the same coordinate the segments carry). Used only to check the
  // split equalized marginals.
  function marginalAt(pool: WombatPool, share: bigint): bigint {
    if (share <= 0n) return 0n;
    const eps = share / 1000n > 0n ? share / 1000n : 1n;
    const lo = share - eps > 0n ? share - eps : 0n;
    const dIn = share - lo;
    const dOut = quotePotentialSwap(pool, share) - quotePotentialSwap(pool, lo);
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
    it(`Wombat solo [${engine}] — received == quotePotentialSwap(share) to the wei (exact-in-dy)`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`Wombat split [${engine}] — two venues, per-leg exact-in-dy + marginals equalize`, { skip }, async () => {
      await runSplit(engine);
    });
  }
});
