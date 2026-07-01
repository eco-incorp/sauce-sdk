/**
 * EcoSwap EulerSwap (Euler v2 vault-backed AMM) local-EVM integration — the callback-free exact-in-dy gate.
 *
 * Stands up a local EulerSwap pool (the EulerSwapPool.sol fixture, whose CurveLib.f + QuoteLib.computeQuote
 * exact-in mirror the off-chain `eulerswap-math.ts` replay bit-for-bit), deploys the Sauce engine, and cooks
 * an EcoSwap whose static-segment cursor consumes EulerSwap segments (segKind 7) and executes them
 * CALLBACK-FREE: an on-chain `pool.computeQuote(tokenIn, tokenOut, awarded, true)` staticcall + transfer +
 * `pool.swap(amount0Out, amount1Out, to, "")` (EulerSwap's swap is V2-shaped; EMPTY data skips the flash
 * callback so the pool sweeps the pre-transferred input + verifies the curve — NO engine SwapPoolType, since
 * the asymmetric Euler curve is NOT xy=k). Then asserts:
 *
 *   (1) SOLO EulerSwap venue — the on-chain dy the caller receives == off-chain computeQuote(awarded share)
 *       AND == the pool's own computeQuote view to the WEI (the exact-in-dy gate: the periphery
 *       quoteExactInput delegates to this view, and the view IS the swap math). NO tolerance.
 *   (2) TWO EulerSwap venues — ONE EcoSwap splits across both; each leg's received output ==
 *       computeQuote(its awarded share) to the wei, and the post-fee marginals equalize within the
 *       sampled-grid bound (the documented exact-on-grid standard).
 *   (3) TREESHAKE regression cell — compiles the PRODUCTION treeshake define set (HAS_EULER only, all
 *       other segment flags false) and cooks a REAL EulerSwap fill: guards that HAS_EULER was added to the
 *       segment-head price-merge guard (else the segment head is dead under treeshake and the swap lands
 *       ZERO — the bug that bit Balancer). Mirrors ecoswap.balancer.evm.test.ts.
 *
 * The EulerSwap curve is OFF-CHAIN only for the SPLIT: the on-chain solver supplies the curve as STATIC
 * (capacity, marginalOI) segments and never recomputes f/fInverse. We build the prepared args DIRECTLY,
 * then compile the production solver template exactly as index.ts does and cook it.
 *
 * ENGINE PATH (verified here): EulerSwap executes CALLBACK-FREE. EulerSwap's real swap carries the EVC
 * `callThroughEVC` modifier + a vault deposit/withdraw, but with EMPTY data the only re-entry is INTERNAL
 * to Euler (the EVC self-wrap pool→EVC→pool, and the vault pool→EVault) — it NEVER re-enters the cooking
 * contract, so the V3/V4-callback barrier does not apply and the Solidly/Wombat pre-transfer + empty-data
 * swap pattern works. This fixture exercises exactly that surface (V2-style optimistic out + sweep input +
 * curve verify + vault output cap).
 *
 * No fork / no RPC env needed — a local fixture etches the whole stack. Runs on v1 (+ v12 when the v12
 * artifacts are present). Driven by ECO_ENGINE (default v12). Mirrors ecoswap.wombat.evm.test.ts.
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
  deployEulerSwapPool,
  eulerSwapPoolAbi,
  type EulerSwapParams,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import {
  computeQuote,
  buildEulerSwapSegments,
  type EulerSwapPool,
} from "../shared/eulerswap-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const CONC = (9n * E18) / 10n; // concentration 0.9 (concentrated near equilibrium)
const FEE = E18 / 1000n; // 0.1% (1e18-scaled)
const ENGINE_CELLS = engineCells();

// The PRODUCTION treeshake define set for an EulerSwap-only universe (no other segment-bearing
// protocol): index.ts protocolDefines folds every other HAS_* to false. The fast/no-define test path
// leaves all HAS_* at their source default `true`, masking any merge-head guard that omits HAS_EULER —
// so this cell compiles with the real treeshaken set and a REAL cook asserts a non-zero EulerSwap fill.
const EULER_ONLY_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: true,
};

// EulerSwap-only run: zero direct pools/routes/netCache; the EulerSwap venues ride entirely inside segs
// (segKind 7). The solver's 5 compiler args, in index.ts order (cfg, pools, netCache, routing, segs).
function eulerArgs(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, segs: bigint[][]): unknown[] {
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
  ];
}

// One EulerSwap venue → its sampled segments as segs rows. refIdx tags the on-chain per-venue accumulator
// (einp[refIdx]); venue is the pool address. Built from the SAME buildEulerSwapSegments the oracle uses,
// so the awarded Σ == the off-chain share by construction. segKind = 7.
function eulerSegRows(pool: EulerSwapPool, refIdx: number, amountIn: bigint): bigint[][] {
  return buildEulerSwapSegments(pool, amountIn).map((s) => [
    BigInt(refIdx),
    s.capacity,
    s.marginalOI, // sqrtAdjNear (post-fee; the descending-price sort key)
    s.marginalOI, // sqrtAdjFar (an EulerSwap segment is a flat slice)
    7n, // segKind = EulerSwap (callback-free)
    BigInt(pool.address),
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

describe("EcoSwap EulerSwap (Euler v2 vault-backed AMM, local fixture) — callback-free exact-in-dy", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == token0 (lower address) == the pool's asset0 (x side)
  let tokenOut: Hex; // == token1 == asset1 (y side)
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

  // Off-chain EulerSwapPool descriptor for the deployed fixture (tokenIn = asset0, tokenOut = asset1).
  // The fixture's asset0 == tokenIn, so the swap output is amount1Out (eA0 === tokenIn on-chain).
  function offPool(address: Hex, rIn: bigint, rOut: bigint, inLimit = 0n): EulerSwapPool {
    return {
      address,
      inIsToken0: true,
      reserveIn: rIn,
      reserveOut: rOut,
      equilIn: rIn, // deploy at equilibrium (reserve == equilibrium reserve)
      equilOut: rOut,
      priceIn: E18,
      priceOut: E18,
      concIn: CONC,
      concOut: CONC,
      feeWad: FEE,
      inLimit,
      feePpm: Number((FEE * 1_000_000n) / E18),
      source: "local-fixture",
    };
  }

  // Deploy a fixture EulerSwap pool at equilibrium (reserve == equilibrium), funded to pay out. asset0 ==
  // tokenIn (x side), asset1 == tokenOut (y side). outCap caps the tokenOut side (the vault available cash).
  async function deployPool(rIn: bigint, rOut: bigint, outCap1 = 0n, minter?: Account): Promise<Hex> {
    const params: EulerSwapParams = {
      reserve0: rIn,
      reserve1: rOut,
      equil0: rIn,
      equil1: rOut,
      priceX: E18,
      priceY: E18,
      concX: CONC,
      concY: CONC,
      fee: FEE,
      outCap0: 0n,
      outCap1,
    };
    return deployEulerSwapPool(c.walletClient, c.publicClient, tokenIn, tokenOut, params, minter);
  }

  // ── (1) SOLO EulerSwap venue — received == computeQuote(share) to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const rIn = 1_000_000n * E18;
    const rOut = 1_000_000n * E18;
    const pool = await deployPool(rIn, rOut, 0n, caller);
    const op = offPool(pool, rIn, rOut);

    // amountIn == the full sampled ladder cap ⇒ the merge awards the WHOLE Σ to this one venue.
    const amountIn = 100_000n * E18;
    const segRows = eulerSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty EulerSwap segment ladder");
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);
    assert.equal(segSum, amountIn, "EulerSwap segments cover the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, eulerArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    // The fixture's own on-chain computeQuote view on the PRE-swap state — the engine-independent ground
    // truth for the executed dy of `amountIn`.
    const onViewPre = (await c.publicClient.readContract({
      address: pool, abi: eulerSwapPoolAbi, functionName: "computeQuote",
      args: [tokenIn, tokenOut, amountIn, true],
    })) as bigint;

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo EulerSwap cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (the whole trade routed to the EulerSwap pool)");
    assert.equal(poolIn, amountIn, "the EulerSwap pool swept the full input share");

    // WEI-EXACT-IN-DY: the on-chain received tokenOut == off-chain computeQuote(awarded share) == the
    // pool's own PRE-swap computeQuote view, all to the WEI. NO tolerance.
    assert.equal(received, computeQuote(op, spent), "received == computeQuote(share) to the wei");
    assert.equal(received, onViewPre, "received == on-chain computeQuote view (exact-in-dy)");

    console.log(`  [Euler solo:${engine}] spent=${spent} received=${received} (== computeQuote to the wei)`);
  }

  // ── (2) TWO EulerSwap venues — split + per-leg exact-in-dy + marginals equalize ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Two venues at the SAME 1:1 equilibrium but different depth → different marginal curves, so the
    // water-fill engages BOTH and equalizes their post-fee marginals. A is deeper ⇒ draws first + more.
    const aR = 3_000_000n * E18; // deep
    const bR = 1_000_000n * E18; // shallower
    const poolA = await deployPool(aR, aR, 0n, caller);
    const poolB = await deployPool(bR, bR, 0n, caller);
    const opA = offPool(poolA, aR, aR);
    const opB = offPool(poolB, bR, bR);

    const amountIn = 800_000n * E18;
    const segRows = sortSegs([...eulerSegRows(opA, 0, amountIn), ...eulerSegRows(opB, 1, amountIn)]);

    const { bytecodes } = compileSauce(
      solverSrc, eulerArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const aInBefore = await balanceOf(c.publicClient, tokenIn, poolA);
    const bInBefore = await balanceOf(c.publicClient, tokenIn, poolB);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue EulerSwap cook() must succeed");

    const aIn = (await balanceOf(c.publicClient, tokenIn, poolA)) - aInBefore;
    const bIn = (await balanceOf(c.publicClient, tokenIn, poolB)) - bInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(aIn > 0n && bIn > 0n, "both EulerSwap venues are funded");
    assert.ok(aIn > bIn, `deep venue A draws more than B (A ${aIn} > B ${bIn})`);

    // PER-LEG WEI-EXACT-IN-DY: received == computeQuote_A(aIn) + computeQuote_B(bIn).
    const expected = computeQuote(opA, aIn) + computeQuote(opB, bIn);
    assert.equal(received, expected, "received == Σ computeQuote(per-venue share) to the wei");

    // MARGINALS EQUALIZE within the GRID bound. The SPLIT is exact-on-grid (the awarded inputs equal the
    // oracle bit-for-bit — checked by the wei-exact gate above), but the realized post-fee marginal each
    // venue reaches equalizes only to within ONE sampled segment's price width (the documented grid bound).
    const margA = marginalAt(opA, aIn);
    const margB = marginalAt(opB, bIn);
    const diff = margA > margB ? margA - margB : margB - margA;
    const relPpm = margA > 0n ? (diff * 1_000_000n) / margA : 0n;
    assert.ok(relPpm <= 2500n, `EulerSwap split marginals equalize on the M=24 grid (rel ${relPpm} ppm; A ${margA} B ${margB})`);

    console.log(
      `  [Euler split:${engine}] A in=${aIn} B in=${bIn} received=${received} ` +
        `(== Σ computeQuote to the wei); marginals A=${margA} B=${margB} (${relPpm} ppm)`,
    );
  }

  // ── (3) SOLO EulerSwap under the PRODUCTION treeshake define set ──
  // Same trade as runSolo, but compiled with treeshake:true + EulerSwap-only defines (the exact compile a
  // production EulerSwap-without-other-segs cook carries). Guards the merge-head guard at the call boundary:
  // if HAS_EULER is absent from the segment-head price-merge guard, under treeshake the EulerSwap head is
  // never compared, bestKind never hits 1, and the swap lands ZERO (the bug that bit Balancer).
  async function runSoloTreeshake(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const rIn = 1_000_000n * E18;
    const rOut = 1_000_000n * E18;
    const pool = await deployPool(rIn, rOut, 0n, caller);
    const op = offPool(pool, rIn, rOut);

    const amountIn = 100_000n * E18;
    const segRows = eulerSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty EulerSwap segment ladder");

    const { bytecodes } = compileSauce(
      solverSrc, eulerArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
      { treeshake: true, defines: EULER_ONLY_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "treeshaken EulerSwap-only cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // The merge MUST have routed the trade to EulerSwap — non-zero spend/receive is the regression gate.
    assert.ok(spent > 0n, "treeshaken EulerSwap-only: non-zero EulerSwap fill (merge-head guard alive)");
    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to EulerSwap)");
    assert.equal(received, computeQuote(op, spent), "received == computeQuote(share) to the wei (treeshaken path)");

    console.log(`  [Euler treeshake:${engine}] spent=${spent} received=${received} (production define set)`);
  }

  // ── (4) VAULT-CAP edge — the cap binds, the guarded terminal refund returns the un-spent input ──
  // The pool's vault output cap is set BELOW the full-fill out, so computeQuote(amountIn) returns 0 (the cap
  // binds). The recipe's pre-swap computeQuote read sees the 0, the EulerSwap branch does NOT swap, and the
  // solver's guarded terminal refund returns the pulled input to the caller — the swap stays atomic + safe.
  async function runVaultCap(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const rIn = 1_000_000n * E18;
    const rOut = 1_000_000n * E18;
    // Cap the tokenOut side at 5000e18 — far below the ~99k out of a 100k fill, so the awarded Σ trips it.
    const outCap = 5_000n * E18;
    const pool = await deployPool(rIn, rOut, outCap, caller);
    // Off-chain descriptor WITHOUT the inLimit bound (so the segments promise the full amountIn and the
    // merge awards it all to this venue) — modeling the cap shrinking AFTER prepare sampled.
    const op = offPool(pool, rIn, rOut, 0n);

    const amountIn = 100_000n * E18;
    const segRows = eulerSegRows(op, 0, amountIn);

    const { bytecodes } = compileSauce(
      solverSrc, eulerArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "vault-cap cook() must succeed (guarded refund, no revert)");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // The cap bound ⇒ computeQuote returned 0 ⇒ the EulerSwap branch did NOT swap ⇒ the terminal refund
    // returned the pulled input. Net: caller's tokenIn unchanged, no tokenOut received, no revert.
    assert.equal(spent, 0n, "vault-cap: the pulled input was fully refunded (cap bound, no fill)");
    assert.equal(received, 0n, "vault-cap: no tokenOut received (the EulerSwap branch declined)");

    console.log(`  [Euler vault-cap:${engine}] cap bound ⇒ guarded refund (spent=${spent} received=${received})`);
  }

  // Post-fee out/in marginal price at a cumulative input `share` — a small finite-difference slice of
  // computeQuote around `share` (the same coordinate the segments carry). Used only to check the split
  // equalized marginals.
  function marginalAt(pool: EulerSwapPool, share: bigint): bigint {
    if (share <= 0n) return 0n;
    const eps = share / 1000n > 0n ? share / 1000n : 1n;
    const lo = share - eps > 0n ? share - eps : 0n;
    const dIn = share - lo;
    const dOut = computeQuote(pool, share) - computeQuote(pool, lo);
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
    it(`EulerSwap solo [${engine}] — received == computeQuote(share) to the wei (exact-in-dy)`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`EulerSwap split [${engine}] — two venues, per-leg exact-in-dy + marginals equalize`, { skip }, async () => {
      await runSplit(engine);
    });
    it(`EulerSwap solo treeshake [${engine}] — production define set lands a non-zero EulerSwap fill`, { skip }, async () => {
      await runSoloTreeshake(engine);
    });
    it(`EulerSwap vault-cap [${engine}] — cap binds ⇒ guarded terminal refund (no revert)`, { skip }, async () => {
      await runVaultCap(engine);
    });
  }
});
