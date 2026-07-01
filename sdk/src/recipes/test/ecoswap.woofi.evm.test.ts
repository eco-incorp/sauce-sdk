/**
 * EcoSwap WOOFi (WooPPV2 synthetic proactive market maker, sPMM v2) local-EVM integration — the
 * callback-free exact-in-dy gate + the oracle-snapshot split model.
 *
 * Stands up a local WooPPV2-style pool (the WooFiPool.sol fixture, whose _calcQuoteAmountSellBase /
 * _calcBaseAmountSellQuote sPMM quote + fee mirror the off-chain `woofi-math.ts` replay bit-for-bit,
 * with a BUILT-IN settable WooracleV2 state), deploys the Sauce engine, and cooks an EcoSwap whose
 * static-segment cursor consumes WOOFi segments (segKind 10) and executes them CALLBACK-FREE: an
 * on-chain `pool.query(tokenIn, tokenOut, awarded)` staticcall (reading the LIVE oracle, used as
 * minToAmount) + `token.transfer(pool, awarded)` (WooPPV2 is TRANSFER-FIRST — swap computes the sold
 * amount from balanceOf − reserve) + `pool.swap(tokenIn, tokenOut, awarded, minToAmount, self, caller)`.
 * WOOFi is oracle-priced (NOT xy=k), so the engine's _swapV2 would mis-price it; the swap is transfer-
 * first callback-free, so it needs NO engine dispatch. Then asserts:
 *
 *   (1) SOLO WOOFi venue — the on-chain dy the caller receives == off-chain query(awarded share) AND ==
 *       the pool's own query view to the WEI (the exact-in-dy gate: the pool view IS the swap math).
 *       Per-pool input == the oracle share (exact-on-grid at the snapshot). NO tolerance.
 *   (2) TWO WOOFi venues — ONE EcoSwap splits across both; each leg's received output == query(its
 *       awarded share) to the wei, and the post-fee marginals equalize within the sampled-grid bound.
 *   (3) TREESHAKE regression cell — compiles the PRODUCTION treeshake define set (HAS_WOOFI only, all
 *       other segment flags false) and cooks a REAL WOOFi fill: guards that HAS_WOOFI was added to the
 *       segment-head price-merge guard + the accumulator branch + the exec block across the guard triple
 *       (else the segment head is dead under treeshake and the swap lands ZERO — the Balancer-class bug).
 *   (4) ORACLE MOVES between prepare and cook — the split is priced at the SNAPSHOT oracle, then a
 *       keeper posts a new price (setState) before the cook. The exec stays WEI-EXACT-IN-DY (received ==
 *       the LIVE query(awarded) at the moved price), demonstrating the documented oracle-snapshot model:
 *       exact-on-grid at the snapshot, exact-in-dy at the live oracle. The move is bounded/guarded (the
 *       whole-trade amountOutMin + the solver's terminal refund bound a bad fill).
 *
 * The WOOFi math is OFF-CHAIN only for the SPLIT: the on-chain solver supplies the curve as STATIC
 * (capacity, marginalOI) segments and never recomputes the sPMM. We build the prepared args DIRECTLY
 * (WOOFi discovery uses a config address that is a placeholder here), then compile the production solver
 * template exactly as index.ts does and cook it.
 *
 * ISOLATED per-cell chain (the fresh-anvil-per-cell pattern all *.evm.test.ts now use): every cell runs
 * on its OWN fresh anvil + freshly-deployed engine (setup()), then deploys its WOOFi pool + sets approvals
 * and asserts the pre-cook invariants — so the compiled args always match live on-chain state.
 *
 * No fork / no RPC env needed — a local fixture etches the whole stack. Runs on v1 (+ v12 when the v12
 * artifacts are present). Driven by ECO_ENGINE (default v12). Mirrors ecoswap.crypto.evm.test.ts.
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
  deployWooFiPool,
  wooFiPoolAbi,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { query as wooFiQuery, buildWooFiSegments, isqrt, type WooFiPool } from "../shared/woofi-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
const E8 = 10n ** 8n;
// Canonical stablecoin sPMM params: base priced at $1 (1e8), 1 bp spread (1e14 WAD), a small gamma
// coefficient (1e9 WAD), 0.025% feeRate (25, 1e5-scaled). Both tokens 18-dec here so the split engages
// both venues on the flat part of the curve. priceDec = 1e8 (WooracleV2 canonical).
const PRICE = E8;
const SPREAD = 10n ** 14n;
const COEFF = 10n ** 9n;
const FEE_RATE = 25n;
const PRICE_DEC = E8;
const ENGINE_CELLS = engineCells();

// The PRODUCTION treeshake define set for a WOOFi-only universe (no other segment-bearing protocol):
// index.ts protocolDefines folds every other HAS_* to false. The fast/no-define test path leaves all
// HAS_* at their source default `true`, masking any merge-head guard that omits HAS_WOOFI — so this cell
// compiles with the real treeshaken set and a REAL cook asserts a non-zero WOOFi fill.
const WOOFI_ONLY_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: true,
};

// WOOFi-only run: zero direct pools/routes/netCache; the WOOFi venues ride entirely inside segs
// (segKind 10). The solver's 5 compiler args, in index.ts order (cfg, pools, netCache, routing, segs).
function wooArgs(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, segs: bigint[][]): unknown[] {
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

// One WOOFi venue → its sampled segments as segs rows. refIdx tags the on-chain per-venue accumulator
// (wooinp[refIdx]); venue is the pool address. Built from the SAME buildWooFiSegments the oracle uses, so
// the awarded Σ == the off-chain share by construction. segKind = 10; a WOOFi segment is a flat post-fee
// slice ⇒ sqrtAdjNear == sqrtAdjFar.
function wooSegRows(pool: WooFiPool, refIdx: number, amountIn: bigint): bigint[][] {
  return buildWooFiSegments(pool, amountIn).map((s) => [
    BigInt(refIdx),
    s.capacity,
    s.marginalOI, // sqrtAdjNear (post-fee; the descending-price sort key)
    s.marginalOI, // sqrtAdjFar (a WOOFi segment is a flat slice)
    10n, // segKind = WOOFi (callback-free)
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

describe("EcoSwap WOOFi (WooPPV2 sPMM, local fixture) — callback-free exact-in-dy + oracle-snapshot split", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == the WOOFi base token (sellBase: base → quote)
  let tokenOut: Hex; // == the WOOFi quote token
  let solverSrc: string;

  // Boot a fresh anvil + deploy the whole stack. Called by before() once and by reset() before every
  // subsequent cell, tearing the prior anvil down first — so each cell is fully isolated.
  async function setup(): Promise<void> {
    // Tear the prior anvil down and WAIT for it to fully exit (port released) before
    // booting the next — a fire-and-forget stop() raced the new startAnvil() under
    // machine load and intermittently flaked a cell's cook (the solo-treeshake flake).
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

  // Assert the pre-cook invariants the compiled args assume: the caller can pay `amountIn` of tokenIn,
  // the cook target is approved to pull it, and every pool holds enough tokenOut (quote) to satisfy the out.
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

  // Off-chain WooFiPool descriptor for a deployed fixture: tokenIn is the base (sellBase), tokenOut the
  // quote, both 18-dec, price scale 1e8. `price`/`spread`/`coeff` are the SNAPSHOT oracle state.
  function offPool(address: Hex, price: bigint, spread: bigint, coeff: bigint): WooFiPool {
    return {
      address, tokenIn, tokenOut, sellBase: true,
      price, spread, coeff, priceDec: PRICE_DEC, quoteDec: E18, baseDec: E18,
      feeRate: FEE_RATE, feePpm: 250, source: "local-fixture",
    };
  }

  // Deploy a WOOFi pool (base=tokenIn, quote=tokenOut) funded with base+quote reserves.
  async function deploy(coeff: bigint, baseRes: bigint, quoteRes: bigint, minter: Account): Promise<Hex> {
    return deployWooFiPool(
      c.walletClient, c.publicClient, tokenIn, tokenOut,
      PRICE_DEC, E18, E18, PRICE, SPREAD, coeff, FEE_RATE, baseRes, quoteRes, minter,
    );
  }

  // The fixture's own on-chain query view — the engine-independent ground truth for the executed dy.
  async function onQuery(pool: Hex, amt: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: pool, abi: wooFiPoolAbi as Abi, functionName: "query", args: [tokenIn, tokenOut, amt],
    })) as bigint;
  }

  // ── (1) SOLO WOOFi venue — received == query(share) == on-chain query to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const pool = await deploy(COEFF, 2_000_000n * E18, 2_000_000n * E18, caller);
    const op = offPool(pool, PRICE, SPREAD, COEFF);

    // amountIn == the full sampled ladder cap ⇒ the merge awards the WHOLE Σ to this one venue.
    const amountIn = 100_000n * E18;
    const segRows = wooSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty WOOFi segment ladder");
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);
    assert.equal(segSum, amountIn, "WOOFi segments cover the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, wooArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: wooFiQuery(op, segSum) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    const onViewPre = await onQuery(pool, amountIn);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo WOOFi cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (the whole trade routed to the WOOFi pool)");
    assert.equal(poolIn, amountIn, "the WOOFi pool received the full input share (transfer-first)");

    // WEI-EXACT-IN-DY: received == off-chain query(share) == the pool's own PRE-swap query view.
    assert.equal(received, wooFiQuery(op, spent), "received == query(share) to the wei");
    assert.equal(received, onViewPre, "received == on-chain query view (exact-in-dy)");
    assert.ok(received > 0n, "non-zero WOOFi fill through the callback-free transfer+swap path");

    console.log(`  [WOOFi solo:${engine}] spent=${spent} received=${received} (== query == on-chain query to the wei)`);
  }

  // ── (2) TWO WOOFi venues — split + per-leg exact-in-dy + marginals equalize ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Two venues at the same $1 price but DIFFERENT gamma coefficient → different marginal curves, so the
    // water-fill engages BOTH and equalizes their post-fee marginals. A (smaller coeff) is flatter/deeper,
    // so it drives first + more; B (larger coeff) steepens sooner.
    const coeffA = COEFF; // deep/flat
    const coeffB = COEFF * 4n; // shallower (steeper gamma)
    const poolA = await deploy(coeffA, 3_000_000n * E18, 3_000_000n * E18, caller);
    const poolB = await deploy(coeffB, 3_000_000n * E18, 3_000_000n * E18, caller);
    const opA = offPool(poolA, PRICE, SPREAD, coeffA);
    const opB = offPool(poolB, PRICE, SPREAD, coeffB);

    const amountIn = 200_000n * E18;
    const segRows = sortSegs([...wooSegRows(opA, 0, amountIn), ...wooSegRows(opB, 1, amountIn)]);

    const { bytecodes } = compileSauce(
      solverSrc, wooArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [
      { pool: poolA, expectedOut: wooFiQuery(opA, amountIn) },
      { pool: poolB, expectedOut: wooFiQuery(opB, amountIn) },
    ]);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const aInBefore = await balanceOf(c.publicClient, tokenIn, poolA);
    const bInBefore = await balanceOf(c.publicClient, tokenIn, poolB);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue WOOFi cook() must succeed");

    const aIn = (await balanceOf(c.publicClient, tokenIn, poolA)) - aInBefore;
    const bIn = (await balanceOf(c.publicClient, tokenIn, poolB)) - bInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(aIn > 0n && bIn > 0n, "both WOOFi venues are funded");
    assert.ok(aIn > bIn, `flatter venue A draws more than B (A ${aIn} > B ${bIn})`);

    // PER-LEG WEI-EXACT-IN-DY: received == query_A(aIn) + query_B(bIn).
    const expected = wooFiQuery(opA, aIn) + wooFiQuery(opB, bIn);
    assert.equal(received, expected, "received == Σ query(per-venue share) to the wei");

    // MARGINALS EQUALIZE within the GRID bound (exact-on-grid at the snapshot: the awarded inputs equal the
    // oracle bit-for-bit — checked by the wei-exact gate above; the realized post-fee marginal equalizes
    // only to within ONE sampled segment's price width). The sPMM curve is very flat near par, so a single
    // M=24 segment spans a wide band: the cut gap is a documented grid bound (converges as M grows).
    const margA = marginalAt(opA, aIn);
    const margB = marginalAt(opB, bIn);
    const diff = margA > margB ? margA - margB : margB - margA;
    const relPpm = margA > 0n ? (diff * 1_000_000n) / margA : 0n;
    assert.ok(relPpm <= 2500n, `WOOFi split marginals equalize on the M=24 grid (rel ${relPpm} ppm; A ${margA} B ${margB})`);

    console.log(
      `  [WOOFi split:${engine}] A in=${aIn} B in=${bIn} received=${received} ` +
        `(== Σ query to the wei); marginals A=${margA} B=${margB} (${relPpm} ppm)`,
    );
  }

  // ── (3) SOLO WOOFi under the PRODUCTION treeshake define set ──
  // Same trade as runSolo, but compiled with treeshake:true + WOOFi-only defines (the exact compile a
  // production WOOFi-without-other-segs cook carries). Guards the guard triple: if HAS_WOOFI is missing
  // from the segment-head price-merge guard, the accumulator branch, OR the exec block, under treeshake the
  // WOOFi head is never compared / never accumulated / never swapped and the swap lands ZERO (the Balancer bug).
  async function runSoloTreeshake(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const pool = await deploy(COEFF, 2_000_000n * E18, 2_000_000n * E18, caller);
    const op = offPool(pool, PRICE, SPREAD, COEFF);

    const amountIn = 100_000n * E18;
    const segRows = wooSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty WOOFi segment ladder");

    const { bytecodes } = compileSauce(
      solverSrc, wooArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
      { treeshake: true, defines: WOOFI_ONLY_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: wooFiQuery(op, amountIn) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "treeshaken WOOFi-only cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // The merge MUST have routed the trade to WOOFi — non-zero spend/receive is the regression gate.
    assert.ok(spent > 0n, "treeshaken WOOFi-only: non-zero WOOFi fill (guard triple alive)");
    assert.equal(received, wooFiQuery(op, spent), "received == query(share) to the wei (treeshaken path)");

    console.log(`  [WOOFi treeshake:${engine}] spent=${spent} received=${received} (production define set)`);
  }

  // ── (4) ORACLE MOVES between prepare and cook — exec stays exact-in-dy at the LIVE oracle ──
  // The split is priced at the SNAPSHOT price (op captures PRICE), the segs are built from it, THEN a
  // keeper posts a new (higher) price via setState before the cook. The exec re-reads the LIVE oracle via
  // query, so the received dy == the LIVE query(awarded) at the MOVED price (exact-in-dy), NOT the snapshot
  // dy — the documented oracle-snapshot model: exact-on-grid at the snapshot, exact-in-dy at the live oracle.
  // A higher base price ⇒ MORE quote out per base ⇒ the fill is at least as good; the whole-trade min guards
  // an adverse move. This is the same class as the V3/Algebra fee-snapshot assumption the recipe documents.
  async function runOracleMoves(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Fund the pool with EXTRA quote so the moved-price (larger) output is still covered.
    const pool = await deploy(COEFF, 2_000_000n * E18, 4_000_000n * E18, caller);
    const opSnapshot = offPool(pool, PRICE, SPREAD, COEFF); // the SNAPSHOT the split is priced at

    const amountIn = 100_000n * E18;
    const segRows = wooSegRows(opSnapshot, 0, amountIn); // segments PRICED at the snapshot
    const { bytecodes } = compileSauce(
      solverSrc, wooArgs(tokenIn, tokenOut, amountIn, caller, segRows), ECOSWAP_DIR, engine,
    );

    // The oracle MOVES between prepare (segs above) and cook: a keeper posts a +0.5% base price.
    const movedPrice = (PRICE * 1005n) / 1000n;
    const setHash = await c.walletClient.writeContract({
      address: pool, abi: wooFiPoolAbi as Abi, functionName: "setState",
      args: [movedPrice, SPREAD, COEFF, true],
      account: c.walletClient.account as Account, chain: c.walletClient.chain,
    });
    await c.publicClient.waitForTransactionReceipt({ hash: setHash });
    const opLive = offPool(pool, movedPrice, SPREAD, COEFF); // the LIVE state the exec reads

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const liveOut = await onQuery(pool, amountIn); // LIVE query at the moved price — the exec ground truth
    await assertPreCook(caller, target, amountIn, [{ pool, expectedOut: liveOut }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "oracle-moved WOOFi cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // WEI-EXACT-IN-DY at the LIVE (moved) oracle — NOT the snapshot dy.
    assert.equal(received, wooFiQuery(opLive, spent), "received == LIVE query(share) at the moved price (exact-in-dy)");
    assert.equal(received, liveOut, "received == on-chain LIVE query view at the moved price");
    // The move was upward (better base price) ⇒ received strictly exceeds the snapshot-priced dy.
    assert.ok(received > wooFiQuery(opSnapshot, spent), "moved (higher) price yields more than the snapshot dy");

    console.log(
      `  [WOOFi oracle-move:${engine}] spent=${spent} received=${received} ` +
        `(snapshot dy=${wooFiQuery(opSnapshot, spent)} < live dy — exact-in-dy at the moved oracle)`,
    );
  }

  // Post-fee out/in marginal price at a cumulative input `share` — a small finite-difference slice of query
  // around `share` (the same coordinate the segments carry). Used only to check the split equalized marginals.
  function marginalAt(pool: WooFiPool, share: bigint): bigint {
    if (share <= 0n) return 0n;
    const eps = share / 1000n > 0n ? share / 1000n : 1n;
    const lo = share - eps > 0n ? share - eps : 0n;
    const dIn = share - lo;
    const dOut = wooFiQuery(pool, share) - wooFiQuery(pool, lo);
    if (dIn <= 0n || dOut <= 0n) return 0n;
    return isqrt((dOut * (1n << 192n)) / dIn);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`WOOFi solo [${engine}] — received == query(share) == on-chain query to the wei (exact-in-dy)`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`WOOFi split [${engine}] — two venues, per-leg exact-in-dy + marginals equalize`, { skip }, async () => {
      await runSplit(engine);
    });
    it(`WOOFi solo treeshake [${engine}] — production define set lands a non-zero WOOFi fill`, { skip }, async () => {
      await runSoloTreeshake(engine);
    });
    it(`WOOFi oracle moves [${engine}] — split priced at snapshot, exec exact-in-dy at the live oracle`, { skip }, async () => {
      await runOracleMoves(engine);
    });
  }
});
