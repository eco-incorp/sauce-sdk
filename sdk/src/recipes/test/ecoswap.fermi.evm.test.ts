/**
 * EcoSwap Fermi / propAMM (gattaca-com/propamm FermiSwapper — an OBRIC-style proactive AMM) local-EVM
 * integration — the callback-free exec + the snapshotted-quote split model.
 *
 * Stands up a local propAMM pool (the FermiPool.sol fixture, which prices internally with the Obric
 * K=v0²·multX/multY closed form + fee off the output but exposes only the REAL FermiSwapper SURFACE:
 * `quoteAmounts(tokenIn, tokenOut, int256)` returning a (amountIn, amountOut) TUPLE and
 * `fermiSwapWithAllowances(tokenIn, tokenOut, int256, amountCheck, recipient)` with a SETTABLE private state),
 * deploys the Sauce engine, and cooks an EcoSwap whose static-segment cursor consumes Fermi segments
 * (segKind 11) and executes them CALLBACK-FREE: an on-chain `quoteAmounts(tokenIn, tokenOut, +awarded)[1]`
 * staticcall (reading the LIVE state, used as amountCheck) + `token.approve(pool, awarded)` +
 * `pool.fermiSwapWithAllowances(tokenIn, tokenOut, +awarded, amountCheck, self)` (propAMM PULLS via
 * transferFrom — approve-first, unlike WOOFi's transfer-first path). Fermi is NOT xy=k, so the engine's
 * _swapV2 would mis-price it; the swap is callback-free, so it needs NO engine dispatch. Then asserts:
 *
 *   (1) SOLO Fermi venue — the on-chain dy the caller receives == the pool's own LIVE `quoteAmounts(+share)`
 *       to the WEI (the exec re-reads the live quote). Per-pool input == the whole trade. NO tolerance on
 *       the exec gate; the off-chain ladder interpolation is only a segment/split diagnostic.
 *   (2) TWO Fermi venues — ONE EcoSwap splits across both; each leg's received output == the LIVE
 *       `quoteAmounts` for its awarded share to the wei, and the post-fee marginals equalize within the
 *       sampled-grid bound.
 *   (3) TREESHAKE regression cell — compiles the PRODUCTION treeshake define set (HAS_FERMI only, all other
 *       segment flags false) and cooks a REAL Fermi fill: guards that HAS_FERMI was added to the segment-head
 *       price-merge guard + the accumulator branch + the exec block across the guard triple (else the segment
 *       head is dead under treeshake and the swap lands ZERO — the Balancer-class bug).
 *   (4) STATE MOVES between prepare and cook — the split is priced at the SNAPSHOT ladder, then the maker
 *       posts new params (setState) before the cook. The exec stays exact-vs-live-quote (received == the LIVE
 *       `quoteAmounts(+awarded)` at the moved state), demonstrating the snapshotted-quote model: exact-on-grid
 *       at the snapshot, exact-vs-live-quote at exec. The move is bounded/guarded (per-pool amountCheck == the
 *       LIVE quote + the whole-trade amountOutMin + the solver's terminal refund bound a bad fill).
 *
 * The Fermi math is OFF-CHAIN only for the SPLIT: the on-chain solver supplies the curve as STATIC
 * (capacity, marginalOI) segments (built by differencing a LIVE `quoteAmounts` ladder sampled off-chain) and
 * never recomputes the propAMM closed form. We build the prepared args DIRECTLY, then compile the production
 * solver template exactly as index.ts does and cook it.
 *
 * ISOLATED per-cell chain (the fresh-anvil-per-cell pattern all *.evm.test.ts use): every cell runs on its
 * OWN fresh anvil + freshly-deployed engine (setup()), then deploys its Fermi pool + sets approvals and
 * asserts the pre-cook invariants — so the compiled args always match live on-chain state. setup() awaits the
 * prior anvil's `stopped` promise before booting the next (the race-free pattern).
 *
 * No fork / no RPC env needed — a local fixture etches the whole stack. Runs on v1 (+ v12 when the v12
 * artifacts are present). Driven by ECO_ENGINE (default v12). Mirrors ecoswap.woofi.evm.test.ts.
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, type Abi, type Account, type Hex } from "viem";

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
  erc20Abi,
  deployFermiPool,
  fermiPoolAbi,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getAmountOut as fermiGetAmountOut, buildFermiSegments, fermiSampleInputs, isqrt, type FermiPool } from "../shared/fermi-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
// A deep near-1:1 propAMM curve: multX==multY (K=v0²), reserveX==targetX (base=v0). fee 0.03% (300,
// 1e6-scaled). Both tokens 18-dec so the split engages both venues on the flat part of the curve.
const FEE_PPM = 300n;
const ENGINE_CELLS = engineCells();

// The PRODUCTION treeshake define set for a Fermi-only universe (no other segment-bearing protocol):
// index.ts protocolDefines folds every other HAS_* to false. The fast/no-define test path leaves all HAS_*
// at their source default `true`, masking any merge-head guard that omits HAS_FERMI — so this cell compiles
// with the real treeshaken set and a REAL cook asserts a non-zero Fermi fill.
const FERMI_ONLY_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: true,
};

// Fermi-only run: zero direct pools/routes/netCache; the Fermi venues ride entirely inside segs (segKind 11).
// The solver's 5 compiler args, in index.ts order (cfg, pools, netCache, routing, segs).
function fermiArgs(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, segs: bigint[][]): unknown[] {
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

// One Fermi venue → its sampled segments as segs rows. refIdx tags the on-chain per-venue accumulator
// (feinp[refIdx]); venue is the pool address. Built from the SAME buildFermiSegments the oracle uses, so
// the awarded Σ == the off-chain share by construction. segKind = 11; a Fermi segment is a flat post-fee
// slice ⇒ sqrtAdjNear == sqrtAdjFar.
function fermiSegRows(pool: FermiPool, refIdx: number, amountIn: bigint): bigint[][] {
  return buildFermiSegments(pool, amountIn).map((s) => [
    BigInt(refIdx),
    s.capacity,
    s.marginalOI, // sqrtAdjNear (post-fee; the descending-price sort key)
    s.marginalOI, // sqrtAdjFar (a Fermi segment is a flat slice)
    11n, // segKind = Fermi (callback-free)
    BigInt(pool.address),
    0n, // venueAux (segs[6]) — unused for non-Mento kinds; padded to mirror production's 7-col seg shape
  ]);
}

// Interleave + sort segs rows the way index.ts buildSegs does: DESC by sqrtAdjNear, then DESC by
// sqrtAdjFar, then by refIdx. The on-chain static-segment cursor consumes them in array order.
function sortSegs(rows: bigint[][]): bigint[][] {
  return rows.slice().sort((a, b) => {
    if (a[2] !== b[2]) return a[2] < b[2] ? 1 : -1;
    if (a[3] !== b[3]) return a[3] < b[3] ? 1 : -1;
    return Number(a[0] - b[0]);
  });
}

describe("EcoSwap Fermi / propAMM (Obric-style proactive AMM, local fixture) — Class-A callback-free exact-in-dy + state-snapshot split", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == the Fermi X token (sellX: X → Y)
  let tokenOut: Hex; // == the Fermi Y token
  let solverSrc: string;

  async function setup(): Promise<void> {
    // Tear the prior anvil down and WAIT for it to fully exit (port released) before booting the next — a
    // fire-and-forget stop() raced the new startAnvil() under machine load and intermittently flaked a cook.
    const prev = anvil;
    prev?.stop();
    await prev?.stopped;
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

  // Assert the pre-cook invariants the compiled args assume: the caller can pay `amountIn` of tokenIn, the
  // cook target is approved to pull it, and every pool holds enough tokenOut (Y) to satisfy the out.
  async function assertPreCook(
    caller: Hex, target: Hex, amountIn: bigint, pools: { pool: Hex; expectedOut: bigint }[],
  ): Promise<void> {
    const callerIn = await balanceOf(c.publicClient, tokenIn, caller);
    assert.ok(callerIn >= amountIn, `caller tokenIn balance ${callerIn} >= amountIn ${amountIn}`);
    const allowance = (await c.publicClient.readContract({
      address: tokenIn, abi: erc20Abi as Abi, functionName: "allowance", args: [caller, target],
    })) as bigint;
    assert.ok(allowance >= amountIn, `cook target allowance ${allowance} >= amountIn ${amountIn}`);
    for (const { pool, expectedOut } of pools) {
      const poolOut = await balanceOf(c.publicClient, tokenOut, pool);
      assert.ok(poolOut >= expectedOut, `pool ${pool} tokenOut reserve ${poolOut} >= expected out ${expectedOut}`);
    }
  }

  // Off-chain FermiPool descriptor for a deployed fixture — SAMPLES the fixture's LIVE quoteAmounts ladder
  // over [0, amountIn] exactly as discovery does (no closed-form K/base read; the real router exposes none).
  async function offPool(address: Hex, amountIn: bigint): Promise<FermiPool> {
    const cumIn = fermiSampleInputs(amountIn);
    const cumOut: bigint[] = [];
    for (const amt of cumIn) cumOut.push(await onQuery(address, amt));
    return {
      address, tokenIn, tokenOut, cumIn, cumOut,
      feePpm: Number(FEE_PPM), source: "local-fixture",
    };
  }

  // Deploy a Fermi pool (X=tokenIn, Y=tokenOut) funded with X+Y reserves. `v0` sets the deep near-1:1 curve
  // (K=v0², base=v0). Reserves must cover the out.
  async function deploy(v0: bigint, xRes: bigint, yRes: bigint, minter: Account): Promise<{ pool: Hex; K: bigint; base: bigint }> {
    const K = v0 * v0;
    const base = v0;
    const pool = await deployFermiPool(
      c.walletClient, c.publicClient, tokenIn, tokenOut, K, base, FEE_PPM, xRes, yRes, minter,
    );
    return { pool, K, base };
  }

  // The fixture's own on-chain quoteAmounts view — the engine-independent ground truth for the executed dy.
  // The real FermiSwapper quote returns a (amountIn, amountOut) TUPLE; take [1] for the exact-in out.
  async function onQuery(pool: Hex, amt: bigint): Promise<bigint> {
    const r = (await c.publicClient.readContract({
      address: pool, abi: fermiPoolAbi as Abi, functionName: "quoteAmounts", args: [tokenIn, tokenOut, amt],
    })) as readonly [bigint, bigint];
    return r[1];
  }

  // ── (1) SOLO Fermi venue — received == getAmountOut(share) == on-chain getAmountOut to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const V0 = 10_000_000n * E18;
    const { pool } = await deploy(V0, 2_000_000n * E18, 2_000_000n * E18, caller);

    // amountIn == the full sampled ladder cap ⇒ the merge awards the WHOLE Σ to this one venue.
    const amountIn = 100_000n * E18;
    const op = await offPool(pool, amountIn);
    const segRows = fermiSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Fermi segment ladder");
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);
    assert.equal(segSum, amountIn, "Fermi segments cover the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, fermiArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: await onQuery(pool, segSum) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    const onViewPre = await onQuery(pool, amountIn);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo Fermi cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (the whole trade routed to the Fermi pool)");
    assert.equal(poolIn, amountIn, "the Fermi pool received the full input share (approve + pull)");

    // EXACT-VS-LIVE-QUOTE: received == the pool's own LIVE quoteAmounts(+share) view to the wei.
    assert.equal(received, onViewPre, "received == on-chain quoteAmounts view (exact-vs-live-quote)");
    assert.ok(received > 0n, "non-zero Fermi fill through the callback-free approve+swap path");

    console.log(`  [Fermi solo:${engine}] spent=${spent} received=${received} (== on-chain quoteAmounts to the wei)`);
  }

  // ── (2) TWO Fermi venues — split + per-leg exact-in-dy + marginals equalize ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Two venues at the same near-1:1 price but DIFFERENT depth (v0) → different marginal curves, so the
    // water-fill engages BOTH and equalizes their post-fee marginals. A (larger v0) is flatter/deeper, so it
    // drives first + more; B (smaller v0) steepens sooner.
    const V0a = 20_000_000n * E18; // deep/flat
    const V0b = 5_000_000n * E18; // shallower (steeper)
    const a = await deploy(V0a, 5_000_000n * E18, 5_000_000n * E18, caller);
    const b = await deploy(V0b, 5_000_000n * E18, 5_000_000n * E18, caller);

    const amountIn = 200_000n * E18;
    const opA = await offPool(a.pool, amountIn);
    const opB = await offPool(b.pool, amountIn);
    const segRows = sortSegs([...fermiSegRows(opA, 0, amountIn), ...fermiSegRows(opB, 1, amountIn)]);

    const { bytecodes } = compileSauce(
      solverSrc, fermiArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [
      { pool: a.pool, expectedOut: await onQuery(a.pool, amountIn) },
      { pool: b.pool, expectedOut: await onQuery(b.pool, amountIn) },
    ]);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const aInBefore = await balanceOf(c.publicClient, tokenIn, a.pool);
    const bInBefore = await balanceOf(c.publicClient, tokenIn, b.pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue Fermi cook() must succeed");

    const aIn = (await balanceOf(c.publicClient, tokenIn, a.pool)) - aInBefore;
    const bIn = (await balanceOf(c.publicClient, tokenIn, b.pool)) - bInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(aIn > 0n && bIn > 0n, "both Fermi venues are funded");
    assert.ok(aIn > bIn, `deeper venue A draws more than B (A ${aIn} > B ${bIn})`);

    // PER-LEG EXACT-VS-LIVE-QUOTE: received == quoteAmounts_A(aIn) + quoteAmounts_B(bIn) on-chain.
    const expected = (await onQuery(a.pool, aIn)) + (await onQuery(b.pool, bIn));
    assert.equal(received, expected, "received == Σ on-chain quoteAmounts(per-venue share) to the wei");

    // MARGINALS EQUALIZE within the GRID bound (exact-on-grid at the snapshot: the awarded inputs equal the
    // oracle bit-for-bit — checked by the wei-exact gate above; the realized post-fee marginal equalizes only
    // to within ONE sampled segment's price width). The propAMM curve is very flat near par, so a single
    // M=24 segment spans a wide band: the cut gap is a documented grid bound (converges as M grows).
    const margA = marginalAt(opA, aIn);
    const margB = marginalAt(opB, bIn);
    const diff = margA > margB ? margA - margB : margB - margA;
    const relPpm = margA > 0n ? (diff * 1_000_000n) / margA : 0n;
    assert.ok(relPpm <= 2500n, `Fermi split marginals equalize on the M=24 grid (rel ${relPpm} ppm; A ${margA} B ${margB})`);

    console.log(
      `  [Fermi split:${engine}] A in=${aIn} B in=${bIn} received=${received} ` +
        `(== Σ getAmountOut to the wei); marginals A=${margA} B=${margB} (${relPpm} ppm)`,
    );
  }

  // ── (3) SOLO Fermi under the PRODUCTION treeshake define set ──
  // Same trade as runSolo, but compiled with treeshake:true + Fermi-only defines (the exact compile a
  // production Fermi-without-other-segs cook carries). Guards the guard triple: if HAS_FERMI is missing from
  // the segment-head price-merge guard, the accumulator branch, OR the exec block, under treeshake the Fermi
  // head is never compared / never accumulated / never swapped and the swap lands ZERO (the Balancer bug).
  async function runSoloTreeshake(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const V0 = 10_000_000n * E18;
    const { pool } = await deploy(V0, 2_000_000n * E18, 2_000_000n * E18, caller);

    const amountIn = 100_000n * E18;
    const op = await offPool(pool, amountIn);
    const segRows = fermiSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Fermi segment ladder");

    const { bytecodes } = compileSauce(
      solverSrc, fermiArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
      { treeshake: true, defines: FERMI_ONLY_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: await onQuery(pool, amountIn) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "treeshaken Fermi-only cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // The merge MUST have routed the trade to Fermi — non-zero spend/receive is the regression gate.
    assert.ok(spent > 0n, "treeshaken Fermi-only: non-zero Fermi fill (guard triple alive)");
    assert.equal(received, await onQuery(pool, spent), "received == on-chain quoteAmounts(share) to the wei (treeshaken path)");

    console.log(`  [Fermi treeshake:${engine}] spent=${spent} received=${received} (production define set)`);
  }

  // ── (4) STATE MOVES between prepare and cook — exec stays exact-in-dy at the LIVE state ──
  // The split is priced at the SNAPSHOT state (op captures K/base), the segs are built from it, THEN the
  // maker posts a new (deeper) state via setState before the cook. The exec re-reads the LIVE state via
  // getAmountOut, so the received dy == the LIVE getAmountOut(awarded) at the MOVED state (exact-in-dy), NOT
  // the snapshot dy — the documented Class-A snapshot model: exact-on-grid at the snapshot, exact-in-dy at
  // the live view. A deeper curve ⇒ LESS slippage ⇒ MORE out; per-pool minOut (== the LIVE getAmountOut)
  // guards an adverse move. This is the same class as the WOOFi oracle-snapshot / V3 fee-snapshot assumption.
  async function runStateMoves(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const V0 = 10_000_000n * E18;
    // Fund with EXTRA Y so the moved-state (larger) output is still covered.
    const { pool } = await deploy(V0, 2_000_000n * E18, 4_000_000n * E18, caller);

    const amountIn = 100_000n * E18;
    const opSnapshot = await offPool(pool, amountIn); // the SNAPSHOT ladder the split is priced at
    const snapDy = await onQuery(pool, amountIn); // the snapshot quote for the whole trade (pre-move)
    const segRows = fermiSegRows(opSnapshot, 0, amountIn); // segments PRICED at the snapshot
    const { bytecodes } = compileSauce(
      solverSrc, fermiArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    // The state MOVES between prepare (segs above) and cook: the maker posts a DEEPER curve (2× v0 ⇒ 4× K,
    // 2× base) — less slippage per unit, so a strictly better fill.
    const V0moved = V0 * 2n;
    const Kmoved = V0moved * V0moved;
    const baseMoved = V0moved;
    const setHash = await c.walletClient.writeContract({
      address: pool, abi: fermiPoolAbi as Abi, functionName: "setState",
      args: [Kmoved, baseMoved],
      account: c.walletClient.account as Account, chain: c.walletClient.chain,
    });
    await c.publicClient.waitForTransactionReceipt({ hash: setHash });

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const liveOut = await onQuery(pool, amountIn); // LIVE quoteAmounts at the moved state — the exec ground truth
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: liveOut }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "state-moved Fermi cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // EXACT-VS-LIVE-QUOTE at the LIVE (moved) state — NOT the snapshot dy.
    assert.equal(spent, amountIn, "the whole trade routed to the single Fermi pool");
    assert.equal(received, liveOut, "received == on-chain LIVE quoteAmounts view at the moved state");
    // The move was to a deeper curve (less slippage) ⇒ received strictly exceeds the snapshot quote.
    assert.ok(received > snapDy, "moved (deeper) state yields more than the snapshot dy");

    console.log(
      `  [Fermi state-move:${engine}] spent=${spent} received=${received} ` +
        `(snapshot dy=${snapDy} < live dy — exact-vs-live-quote at the moved state)`,
    );
  }

  // Post-fee out/in marginal price at a cumulative input `share` — a small finite-difference slice of
  // getAmountOut around `share` (the same coordinate the segments carry). Used only to check the split
  // equalized marginals.
  function marginalAt(pool: FermiPool, share: bigint): bigint {
    if (share <= 0n) return 0n;
    const eps = share / 1000n > 0n ? share / 1000n : 1n;
    const lo = share - eps > 0n ? share - eps : 0n;
    const dIn = share - lo;
    const dOut = fermiGetAmountOut(pool, share) - fermiGetAmountOut(pool, lo);
    if (dIn <= 0n || dOut <= 0n) return 0n;
    return isqrt((dOut * (1n << 192n)) / dIn);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`Fermi solo [${engine}] — received == getAmountOut(share) == on-chain view to the wei (exact-in-dy)`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`Fermi split [${engine}] — two venues, per-leg exact-in-dy + marginals equalize`, { skip }, async () => {
      await runSplit(engine);
    });
    it(`Fermi solo treeshake [${engine}] — production define set lands a non-zero Fermi fill`, { skip }, async () => {
      await runSoloTreeshake(engine);
    });
    it(`Fermi state moves [${engine}] — split priced at snapshot, exec exact-in-dy at the live state`, { skip }, async () => {
      await runStateMoves(engine);
    });
  }
});
