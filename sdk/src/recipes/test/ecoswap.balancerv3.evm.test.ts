/**
 * EcoSwap Balancer V3 (balancer/balancer-v3-monorepo — Vault singleton + per-chain Router) local-EVM
 * integration — the callback-free exec (Permit2-pull) + the snapshotted-quote split model.
 *
 * Stands up a local Balancer V3 stack — a per-chain Router (which doubles as the reserve-holding "Vault") + a
 * stable pool + the Permit2 fixture ETCHED at the CANONICAL Permit2 address (the solver hardcodes it) — the
 * BalancerV3.sol fixture, which exposes the REAL VERIFIED SURFACE the recipe hits on-chain:
 * `querySwapSingleTokenExactIn(pool, tokenIn, tokenOut, amountIn, sender, userData)` (the LIVE quote — pure
 * view of the pool's stable-math out; used OFF-CHAIN by the test + discovery, NOT on-chain in the cook — see
 * below), `swapSingleTokenExactIn(...)` (the exec leg: PULLS the input via Permit2.transferFrom(sender, Vault,
 * amountIn, tokenIn) then pays amountOut to the sender — the caller is NEVER re-entered, so it is
 * callback-free), `getPermit2()`, `getPoolTokens(pool)`, and the Permit2 `approve`/`transferFrom`. Deploys the
 * Sauce engine and cooks an EcoSwap whose static-segment cursor consumes Balancer V3 segments (segKind 14) and
 * executes them CALLBACK-FREE: the Permit2 TWO-STEP approval (`token.approve(PERMIT2, +awarded)` +
 * `Permit2.approve(tokenIn, ROUTER, +awarded, expiration)`) + `Router.swapSingleTokenExactIn(pool, tokenIn,
 * tokenOut, +awarded, minAmountOut, deadline, false, "")` — minAmountOut HARDCODED 0, because the
 * Router's querySwapSingleTokenExactIn is eth_call-ONLY (it demands a static-call context via the Vault's
 * quote() yet does a state write, so it is uncallable on-chain in a cook) and the solver has no whole-trade
 * output floor. Balancer V3 is NOT xy=k, so the engine's _swapV2 would mis-price it; the V3 reentrancy is
 * fully contained inside Balancer's own Router + Vault (never the cooking contract), so the swap is
 * callback-free and needs NO engine dispatch. Then asserts:
 *
 *   (1) SOLO Balancer V3 venue — the on-chain dy the caller receives == the Router's own LIVE
 *       `querySwapSingleTokenExactIn(+share)` to the WEI. This is a CROSS-CHECK: because the fixture's swap
 *       returns exactly what its query view returns and the state is fixed, the exactIn fill (minAmountOut=0)
 *       equals the live query for the awarded share — it does NOT mean the exec re-reads the query on-chain
 *       (it does not; minAmountOut is 0). Per-pool input == the whole trade. NO tolerance on the exec gate;
 *       the off-chain ladder interpolation is only a segment/split diagnostic.
 *   (2) TWO Balancer V3 venues — ONE EcoSwap splits across both (sharing ONE Router = ONE chain-wide cfg[8]);
 *       each leg's received output == the LIVE `querySwapSingleTokenExactIn` for its awarded share to the wei,
 *       and the post-fee marginals equalize within the sampled-grid bound.
 *   (3) TREESHAKE regression cell — compiles the PRODUCTION treeshake define set (HAS_BALANCER_V3 only, all
 *       other segment flags false) and cooks a REAL Balancer V3 fill: guards that HAS_BALANCER_V3 was added to
 *       the segment-head price-merge guard + the accumulator branch + the exec block across the guard triple
 *       (else the segment head is dead under treeshake and the swap lands ZERO — the Balancer-class bug).
 *   (4) STATE MOVES between prepare and cook — the split is priced at the SNAPSHOT ladder, then the pool
 *       re-centers (setState) before the cook. The exactIn exec (minAmountOut=0) yields received == the LIVE
 *       `querySwapSingleTokenExactIn(+awarded)` at the MOVED state, demonstrating the snapshotted-quote model:
 *       exact-on-grid at the snapshot, and the realized out tracks the live state at exec (the rate providers
 *       accrue + the surge fee moves — more exogenous than a fee snapshot). NOTE there is NO on-chain floor on
 *       a Balancer V3 leg (minAmountOut=0, no whole-trade output require) — the fill tracks the live state
 *       unconditionally; a Balancer V3 leg relies on the off-chain split + the integrator's transaction-level
 *       slippage, not a per-leg or whole-trade on-chain minOut. Here the move is UP (a strictly better fill),
 *       so received > the snapshot dy.
 *
 * The Balancer V3 math is OFF-CHAIN only for the SPLIT: the on-chain solver supplies the curve as STATIC
 * (capacity, marginalOI) segments (built by differencing a LIVE Router `querySwapSingleTokenExactIn` ladder
 * sampled off-chain) and never recomputes the stable math. We build the prepared args DIRECTLY, then compile
 * the production solver template exactly as index.ts does and cook it.
 *
 * ISOLATED per-cell chain (the fresh-anvil-per-cell pattern all *.evm.test.ts use). No fork / no RPC env
 * needed — a local fixture etches the whole stack. Runs on v1 (+ v12 when the v12 artifacts are present).
 * Driven by ECO_ENGINE (default v12). Mirrors ecoswap.fluid.evm.test.ts.
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
  deployBalancerV3,
  balancerV3RouterAbi,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import {
  getAmountOut as b3GetAmountOut,
  buildBalancerV3Segments,
  balancerV3SampleInputs,
  isqrt,
  type BalancerV3Pool,
} from "../shared/balancer-v3-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
// A deep near-1:1 Balancer V3 stable curve: 1:1 center price, 0.005% fee (50, 1e6-scaled — the real Base
// pool's static fee). Both tokens 18-dec so the split engages both venues on the flat part.
const FEE_PPM = 50n;
const CENTER = E18; // 1:1 center price
const ENGINE_CELLS = engineCells();

// The PRODUCTION treeshake define set for a Balancer-V3-only universe (no other segment-bearing protocol):
// index.ts protocolDefines folds every other HAS_* to false. The fast/no-define test path leaves all HAS_*
// at their source default `true`, masking any merge-head guard that omits HAS_BALANCER_V3 — so this cell
// compiles with the real treeshaken set and a REAL cook asserts a non-zero Balancer V3 fill.
const B3_ONLY_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: true,
};

// Balancer-V3-only run: zero direct pools/routes/netCache; the V3 venues ride entirely inside segs (segKind
// 14). The solver's 5 compiler args, in index.ts order (cfg, pools, netCache, routing, segs). cfg[8] carries
// the chain-wide Balancer V3 Router address (the query/swap/Permit2-approve target). cfg[6]/cfg[7] (Fluid
// resolver / Mento broker) are 0 (no such venue).
function b3Args(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, router: Hex, segs: bigint[][]): unknown[] {
  return [
    [
      BigInt(tokenIn),
      BigInt(tokenOut),
      amountIn,
      BigInt(caller),
      MIN_SQRT_RATIO + 1n, // priceLimit (unused by static segments)
      0n, // directCount — no direct pools
      0n, // cfg[6] — Fluid resolver (none)
      0n, // cfg[7] — Mento broker (none)
      BigInt(router), // cfg[8] — chain-wide Balancer V3 Router
    ],
    [], // pools
    [], // netCache
    [], // routing
    segs,
  ];
}

// One Balancer V3 venue → its sampled segments as segs rows. refIdx tags the on-chain per-venue accumulator
// (b3inp[refIdx]); venue is the Vault POOL address. Built from the SAME buildBalancerV3Segments the oracle
// uses, so the awarded Σ == the off-chain share by construction. segKind = 14; a Balancer V3 segment is a
// flat post-fee slice ⇒ sqrtAdjNear == sqrtAdjFar.
function b3SegRows(pool: BalancerV3Pool, refIdx: number, amountIn: bigint): bigint[][] {
  return buildBalancerV3Segments(pool, amountIn).map((s) => [
    BigInt(refIdx),
    s.capacity,
    s.marginalOI, // sqrtAdjNear (post-fee; the descending-price sort key)
    s.marginalOI, // sqrtAdjFar (a Balancer V3 segment is a flat slice)
    14n, // segKind = Balancer V3 (callback-free, Permit2-pull)
    BigInt(pool.address),
    0n, // venueAux (segs[6]) — unused for non-Mento kinds; padded to mirror production's 7-col seg shape
  ]);
}

// Interleave + sort segs rows the way index.ts buildSegs does: DESC by sqrtAdjNear, then DESC by sqrtAdjFar,
// then by refIdx. The on-chain static-segment cursor consumes them in array order.
function sortSegs(rows: bigint[][]): bigint[][] {
  return rows.slice().sort((a, b) => {
    if (a[2] !== b[2]) return a[2] < b[2] ? 1 : -1;
    if (a[3] !== b[3]) return a[3] < b[3] ? 1 : -1;
    return Number(a[0] - b[0]);
  });
}

describe("EcoSwap Balancer V3 (Vault + per-chain Router, local fixture) — callback-free Permit2 exec + state-snapshot split", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == the V3 pool token0
  let tokenOut: Hex; // == the V3 pool token1
  let solverSrc: string;

  async function setup(): Promise<void> {
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
  // cook target is approved to pull it, and the Router (Vault) holds enough tokenOut to satisfy the out.
  async function assertPreCook(
    caller: Hex, target: Hex, amountIn: bigint, router: Hex, expectedOut: bigint,
  ): Promise<void> {
    const callerIn = await balanceOf(c.publicClient, tokenIn, caller);
    assert.ok(callerIn >= amountIn, `caller tokenIn balance ${callerIn} >= amountIn ${amountIn}`);
    const allowance = (await c.publicClient.readContract({
      address: tokenIn, abi: erc20Abi as Abi, functionName: "allowance", args: [caller, target],
    })) as bigint;
    assert.ok(allowance >= amountIn, `cook target allowance ${allowance} >= amountIn ${amountIn}`);
    const vaultOut = await balanceOf(c.publicClient, tokenOut, router);
    assert.ok(vaultOut >= expectedOut, `Router(Vault) tokenOut reserve ${vaultOut} >= expected out ${expectedOut}`);
  }

  // Off-chain BalancerV3Pool descriptor for a deployed fixture — SAMPLES the Router's LIVE
  // querySwapSingleTokenExactIn ladder over [0, amountIn] exactly as discovery does.
  async function offPool(pool: Hex, router: Hex, amountIn: bigint): Promise<BalancerV3Pool> {
    const cumIn = balancerV3SampleInputs(amountIn);
    const cumOut: bigint[] = [];
    for (const amt of cumIn) cumOut.push(await onQuery(pool, router, amt));
    return {
      address: pool, router, tokenIn, tokenOut, cumIn, cumOut, feePpm: Number(FEE_PPM), source: "local-fixture",
    };
  }

  // The Router's own on-chain querySwapSingleTokenExactIn view — the engine-independent ground truth for the
  // executed dy. sender = 0x0, userData = "0x".
  async function onQuery(pool: Hex, router: Hex, amt: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: router, abi: balancerV3RouterAbi as Abi, functionName: "querySwapSingleTokenExactIn",
      args: [pool, tokenIn, tokenOut, amt, "0x0000000000000000000000000000000000000000", "0x"],
    })) as bigint;
  }

  // Deploy a V3 pool (token0=tokenIn, token1=tokenOut) on a Router. Reuse ONE Router (existingRouter) so both
  // pools share the chain-wide cfg[8], the production shape. Fund the Router (Vault) with `vaultOut` tokenOut.
  async function deploy(
    bal0: bigint, bal1: bigint, vaultOut: bigint, minter: Account, existingRouter?: Hex,
  ): Promise<{ router: Hex; pool: Hex }> {
    return deployBalancerV3(
      c.walletClient, c.publicClient, c.testClient, tokenIn, tokenOut, bal0, bal1, CENTER, FEE_PPM,
      tokenOut, vaultOut, existingRouter, minter,
    );
  }

  // ── (1) SOLO Balancer V3 venue — received == query(share) == on-chain view to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const { router, pool } = await deploy(20_000_000n * E18, 20_000_000n * E18, 2_000_000n * E18, caller);

    const amountIn = 100_000n * E18;
    const op = await offPool(pool, router, amountIn);
    const segRows = b3SegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Balancer V3 segment ladder");
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);
    assert.equal(segSum, amountIn, "Balancer V3 segments cover the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, b3Args(tokenIn, tokenOut, amountIn, caller, router, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, router, await onQuery(pool, router, segSum));
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const vaultInBefore = await balanceOf(c.publicClient, tokenIn, router);

    const onViewPre = await onQuery(pool, router, amountIn);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo Balancer V3 cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const vaultIn = (await balanceOf(c.publicClient, tokenIn, router)) - vaultInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (the whole trade routed to the Balancer V3 pool)");
    assert.equal(vaultIn, amountIn, "the Router(Vault) received the full input share (Permit2 pull)");
    assert.equal(received, onViewPre, "received == on-chain querySwapSingleTokenExactIn view (exact-vs-live-query)");
    assert.ok(received > 0n, "non-zero Balancer V3 fill through the callback-free Permit2 swap path");

    console.log(`  [BalancerV3 solo:${engine}] spent=${spent} received=${received} (== on-chain query to the wei)`);
  }

  // ── (2) TWO Balancer V3 venues — split + per-leg exact-in-dy + marginals equalize ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Two venues at the same 1:1 center but DIFFERENT depth (reserve size) → different marginal curves, so the
    // water-fill engages BOTH and equalizes their post-fee marginals. A (larger reserves) is flatter/deeper.
    // BOTH pools share ONE Router (the chain-wide cfg[8]) — exactly the production shape (one Router/chain).
    const a = await deploy(40_000_000n * E18, 40_000_000n * E18, 3_000_000n * E18, caller);
    const b = await deploy(8_000_000n * E18, 8_000_000n * E18, 3_000_000n * E18, caller, a.router);
    const router = a.router;

    const amountIn = 200_000n * E18;
    const opA = await offPool(a.pool, router, amountIn);
    const opB = await offPool(b.pool, router, amountIn);
    const segRows = sortSegs([...b3SegRows(opA, 0, amountIn), ...b3SegRows(opB, 1, amountIn)]);

    const { bytecodes } = compileSauce(
      solverSrc, b3Args(tokenIn, tokenOut, amountIn, caller, router, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    // The shared Router(Vault) must cover BOTH pools' output — funded 3M+3M above; assert against Σ query.
    await assertPreCook(caller, target, amountIn, router, await onQuery(a.pool, router, amountIn));
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const vaultInBefore = await balanceOf(c.publicClient, tokenIn, router);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue Balancer V3 cook() must succeed");

    const vaultIn = (await balanceOf(c.publicClient, tokenIn, router)) - vaultInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(vaultIn > 0n, "the shared Router(Vault) received input");
    // Reconstruct the per-venue awarded shares off the SAME oracle split (the wei-exact gate is `received`).
    const shareA = solveShare(opA, opB, amountIn);
    const shareB = amountIn - shareA;
    assert.ok(shareA > 0n && shareB > 0n, "both Balancer V3 venues are funded");
    assert.ok(shareA > shareB, `deeper venue A draws more than B (A ${shareA} > B ${shareB})`);

    // PER-LEG EXACT-VS-LIVE-QUERY: received == query_A(shareA) + query_B(shareB) on-chain.
    const expected = (await onQuery(a.pool, router, shareA)) + (await onQuery(b.pool, router, shareB));
    assert.equal(received, expected, "received == Σ on-chain query(per-venue share) to the wei");

    // MARGINALS EQUALIZE within the GRID bound.
    const margA = marginalAt(opA, shareA);
    const margB = marginalAt(opB, shareB);
    const diff = margA > margB ? margA - margB : margB - margA;
    const relPpm = margA > 0n ? (diff * 1_000_000n) / margA : 0n;
    assert.ok(relPpm <= 3000n, `Balancer V3 split marginals equalize on the M=24 grid (rel ${relPpm} ppm; A ${margA} B ${margB})`);

    console.log(
      `  [BalancerV3 split:${engine}] A share=${shareA} B share=${shareB} received=${received} ` +
        `(== Σ query to the wei); marginals A=${margA} B=${margB} (${relPpm} ppm)`,
    );
  }

  // ── (3) SOLO Balancer V3 under the PRODUCTION treeshake define set ──
  async function runSoloTreeshake(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const { router, pool } = await deploy(20_000_000n * E18, 20_000_000n * E18, 2_000_000n * E18, caller);

    const amountIn = 100_000n * E18;
    const op = await offPool(pool, router, amountIn);
    const segRows = b3SegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Balancer V3 segment ladder");

    const { bytecodes } = compileSauce(
      solverSrc, b3Args(tokenIn, tokenOut, amountIn, caller, router, segRows), ECOSWAP_DIR, engine,
      { treeshake: true, defines: B3_ONLY_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, router, await onQuery(pool, router, amountIn));
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "treeshaken Balancer-V3-only cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(spent > 0n, "treeshaken Balancer-V3-only: non-zero fill (guard triple alive)");
    assert.equal(received, await onQuery(pool, router, spent), "received == on-chain query(share) to the wei (treeshaken path)");

    console.log(`  [BalancerV3 treeshake:${engine}] spent=${spent} received=${received} (production define set)`);
  }

  // ── (4) STATE MOVES between prepare and cook — exec stays exact-vs-live-query at the moved state ──
  async function runStateMoves(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Fund with EXTRA tokenOut so the moved-state (larger) output is still covered.
    const { router, pool } = await deploy(20_000_000n * E18, 20_000_000n * E18, 4_000_000n * E18, caller);

    const amountIn = 100_000n * E18;
    const opSnapshot = await offPool(pool, router, amountIn); // the SNAPSHOT ladder the split is priced at
    const snapDy = await onQuery(pool, router, amountIn); // the snapshot query for the whole trade
    const segRows = b3SegRows(opSnapshot, 0, amountIn); // segments PRICED at the snapshot
    const { bytecodes } = compileSauce(
      solverSrc, b3Args(tokenIn, tokenOut, amountIn, caller, router, segRows), ECOSWAP_DIR, engine,
    );

    // The pool RE-CENTERS between prepare (segs above) and cook to a BETTER token1-per-token0 price (center
    // 1.01× ⇒ more out) — a strictly better fill.
    const movedCenter = (CENTER * 101n) / 100n;
    const setHash = await c.walletClient.writeContract({
      address: pool, abi: (await import("./harness/setup")).balancerV3PoolAbi as Abi, functionName: "setState",
      args: [movedCenter, FEE_PPM],
      account: c.walletClient.account as Account, chain: c.walletClient.chain,
    });
    await c.publicClient.waitForTransactionReceipt({ hash: setHash });

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const liveOut = await onQuery(pool, router, amountIn); // LIVE query at the moved state — the exec ground truth
    await assertPreCook(caller, target, amountIn, router, liveOut);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "state-moved Balancer V3 cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.equal(spent, amountIn, "the whole trade routed to the single Balancer V3 pool");
    assert.equal(received, liveOut, "received == on-chain LIVE query at the moved state (exact-vs-live-query)");
    assert.ok(received > snapDy, "moved (re-centered up) state yields more than the snapshot dy");

    console.log(
      `  [BalancerV3 state-move:${engine}] spent=${spent} received=${received} ` +
        `(snapshot dy=${snapDy} < live dy — exact-vs-live-query at the moved state)`,
    );
  }

  // Post-fee out/in marginal price at a cumulative input `share` — a small finite-difference slice.
  function marginalAt(pool: BalancerV3Pool, share: bigint): bigint {
    if (share <= 0n) return 0n;
    const eps = share / 1000n > 0n ? share / 1000n : 1n;
    const lo = share - eps > 0n ? share - eps : 0n;
    const dIn = share - lo;
    const dOut = b3GetAmountOut(pool, share) - b3GetAmountOut(pool, lo);
    if (dIn <= 0n || dOut <= 0n) return 0n;
    return isqrt((dOut * (1n << 192n)) / dIn);
  }

  // Solve the two-venue water-fill share off the SHARED oracle segment ladders (the same
  // buildBalancerV3Segments the solver consumes) — a pure off-chain replay of the merge for THIS pair, so we
  // can name the per-leg shares for the wei-exact gate. Merge both venues' segments in descending marginalOI,
  // accumulate per-venue capacity until Σ == amountIn.
  function solveShare(opA: BalancerV3Pool, opB: BalancerV3Pool, amountIn: bigint): bigint {
    const rows: { idx: number; cap: bigint; m: bigint }[] = [];
    for (const s of buildBalancerV3Segments(opA, amountIn)) rows.push({ idx: 0, cap: s.capacity, m: s.marginalOI });
    for (const s of buildBalancerV3Segments(opB, amountIn)) rows.push({ idx: 1, cap: s.capacity, m: s.marginalOI });
    rows.sort((x, y) => (x.m !== y.m ? (x.m < y.m ? 1 : -1) : 0));
    let cum = 0n;
    let shareA = 0n;
    for (const r of rows) {
      if (cum >= amountIn) break;
      let take = r.cap;
      if (cum + take > amountIn) take = amountIn - cum;
      if (r.idx === 0) shareA += take;
      cum += take;
    }
    return shareA;
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`BalancerV3 solo [${engine}] — received == query(share) == on-chain view to the wei (exact-vs-live-query)`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`BalancerV3 split [${engine}] — two venues, per-leg exact-vs-live-query + marginals equalize`, { skip }, async () => {
      await runSplit(engine);
    });
    it(`BalancerV3 solo treeshake [${engine}] — production define set lands a non-zero fill`, { skip }, async () => {
      await runSoloTreeshake(engine);
    });
    it(`BalancerV3 state moves [${engine}] — split priced at snapshot, exec exact-vs-live-query at the live state`, { skip }, async () => {
      await runStateMoves(engine);
    });
  }
});
