/**
 * EcoSwap Mento V2 (Celo mento-protocol/mento-core Broker + BiPoolManager stablecoin exchange) local-EVM
 * integration — the callback-free exec + the snapshotted-quote split model.
 *
 * Stands up a local Mento stack — the BiPoolManager (the ENUMERABLE exchange provider) + the Broker (the
 * swap entry) — via the MentoBroker.sol fixture, which prices internally off SETTABLE bucket state (oracle
 * rates + center price + spread + a utilization depth + a per-side trading-limit out-cap) but exposes only
 * the REAL VERIFIED Mento surface: `getExchangeProviders()`, `getAmountOut(exchangeProvider, exchangeId,
 * tokenIn, tokenOut, amountIn)` (a PLAIN VIEW — no revert-decode resolver, unlike Fluid), and
 * `swapIn(exchangeProvider, exchangeId, tokenIn, tokenOut, amountIn, amountOutMin)` (approve-first pull via
 * transferFrom, output to msg.sender). Discovery's Exchange { bytes32 exchangeId; address[] assets; } orient
 * the pair. Deploys the Sauce engine, and cooks an EcoSwap whose static-segment cursor consumes Mento
 * segments (segKind 13) and executes them CALLBACK-FREE: an on-chain
 * `broker.getAmountOut(provider, exchangeId, tokenIn, tokenOut, +awarded)` staticcall (the LIVE bucket
 * quote, used as amountOutMin) + `token.approve(broker, awarded)` +
 * `broker.swapIn(provider, exchangeId, tokenIn, tokenOut, +awarded, amountOutMin)` (Mento PULLS via
 * transferFrom into the reserve — approve the BROKER, unlike WOOFi's transfer-first path). Mento is NOT
 * xy=k, so the engine's _swapV2 would mis-price it; swapIn re-enters only the Reserve / stable-asset
 * mint-burn, never the cooking contract, so the swap is callback-free and needs NO engine dispatch. Then
 * asserts:
 *
 *   (1) SOLO Mento venue — the on-chain dy the caller receives == the Broker's own LIVE
 *       `getAmountOut(+share)` to the WEI (the exec re-reads the live quote). Per-venue input == the whole
 *       trade.
 *   (2) TWO Mento venues — ONE EcoSwap splits across both (two exchanges of different depth sharing ONE
 *       Broker); each leg's received output == the LIVE `getAmountOut` for its awarded share to the wei,
 *       and the post-spread marginals equalize within the sampled-grid bound.
 *   (3) TREESHAKE regression cell — compiles the PRODUCTION treeshake define set (HAS_MENTO only, all other
 *       segment flags false) and cooks a REAL Mento fill: guards that HAS_MENTO was added to the segment-
 *       head price-merge guard + the accumulator branch + the exec block across the guard triple (else the
 *       segment head is dead under treeshake and the swap lands ZERO — the Balancer-class bug).
 *   (4) STATE MOVES between prepare and cook — the split is priced at the SNAPSHOT bucket state, then the
 *       buckets refresh / re-center (setBuckets) before the cook. The exec stays exact-vs-live-quote
 *       (received == the LIVE `getAmountOut(+awarded)` at the moved state), demonstrating the snapshotted-
 *       quote model (buckets refresh on referenceRateResetFrequency — more exogenous than a fee snapshot).
 *
 * The Mento math is OFF-CHAIN only for the SPLIT: the on-chain solver supplies the curve as STATIC
 * (capacity, marginalOI) segments (built by differencing a LIVE Broker `getAmountOut` ladder sampled
 * off-chain) and never recomputes the bucket math. We build the prepared args DIRECTLY, then compile the
 * production solver template exactly as index.ts does and cook it.
 *
 * ISOLATED per-cell chain (the fresh-anvil-per-cell pattern all *.evm.test.ts use): every cell runs on its
 * OWN fresh anvil + freshly-deployed engine (setup()). setup() awaits the prior anvil's `stopped` promise
 * before booting the next (the race-free pattern).
 *
 * No fork / no RPC env needed — a local fixture etches the whole stack. Runs on v1 (+ v12 when the v12
 * artifacts are present). Driven by ECO_ENGINE (default v12). Mirrors ecoswap.fluid.evm.test.ts.
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
  deployMento,
  mentoBrokerAbi,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import {
  getAmountOut as mentoGetAmountOut,
  buildMentoSegments,
  mentoSampleInputs,
  isqrt,
  type MentoPool,
} from "../shared/mento-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const E18 = 10n ** 18n;
// A deep near-1:1 Mento bucket curve: oracle rates at par, 1:1 center price, 0.01% spread (100, 1e6-scaled).
// Both tokens 18-dec so the split engages both venues on the flat part of the bucket curve.
const SPREAD_PPM = 100n;
const RATE = E18; // par oracle rate both sides
const CENTER = E18; // 1:1 center price
// Utilization slippage depth (out reduced by amountIn²/DEPTH) — deep enough that a 100k swap stays near-1:1
// but the marginal genuinely descends so the split equalizes across venues of different depth.
const DEPTH = 20_000_000n * E18;
const ENGINE_CELLS = engineCells();

// The PRODUCTION treeshake define set for a Mento-only universe (no other segment-bearing protocol):
// index.ts protocolDefines folds every other HAS_* to false. The fast/no-define test path leaves all HAS_*
// at their source default `true`, masking any merge-head guard that omits HAS_MENTO — so this cell compiles
// with the real treeshaken set and a REAL cook asserts a non-zero Mento fill.
const MENTO_ONLY_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: true,
};

// Mento-only run: zero direct pools/routes/netCache; the Mento venues ride entirely inside segs (segKind
// 13). The solver's 5 compiler args, in index.ts order (cfg, pools, netCache, routing, segs). cfg[6] is the
// chain-wide Fluid resolver (0 — no Fluid), cfg[7] the chain-wide Mento Broker (the getAmountOut/swapIn
// target).
function mentoArgs(tokenIn: Hex, tokenOut: Hex, amountIn: bigint, caller: Hex, broker: Hex, segs: bigint[][]): unknown[] {
  return [
    [
      BigInt(tokenIn),
      BigInt(tokenOut),
      amountIn,
      BigInt(caller),
      MIN_SQRT_RATIO + 1n, // priceLimit (unused by static segments)
      0n, // directCount — no direct pools
      0n, // cfg[6] — chain-wide Fluid resolver (none)
      BigInt(broker), // cfg[7] — chain-wide Mento Broker
    ],
    [], // pools
    [], // netCache
    [], // routing
    segs,
  ];
}

// One Mento venue → its sampled segments as segs rows. refIdx tags the on-chain per-venue accumulator
// (mtinp[refIdx]); venue (segs[5]) is the exchangeProvider; segs[6] is the bytes32 exchangeId (as uint256,
// intact — not truncated). Built from the SAME buildMentoSegments the oracle uses, so the awarded Σ == the
// off-chain share by construction. segKind = 13; a Mento segment is a flat post-spread slice ⇒ sqrtAdjNear
// == sqrtAdjFar.
function mentoSegRows(pool: MentoPool, refIdx: number, amountIn: bigint): bigint[][] {
  return buildMentoSegments(pool, amountIn).map((s) => [
    BigInt(refIdx),
    s.capacity,
    s.marginalOI, // sqrtAdjNear (post-spread; the descending-price sort key)
    s.marginalOI, // sqrtAdjFar (a Mento segment is a flat slice)
    13n, // segKind = Mento (callback-free)
    BigInt(pool.exchangeProvider), // venue = the exchange provider (segs[5])
    BigInt(pool.exchangeId), // venueAux = the bytes32 exchangeId, as uint256 (segs[6])
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

describe("EcoSwap Mento V2 (Celo Broker + BiPoolManager bucket-priced exchange, local fixture) — Class-A callback-free exact-in-dy + state-snapshot split", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == the Mento asset0 (asset0 → asset1)
  let tokenOut: Hex; // == the Mento asset1
  let solverSrc: string;

  async function setup(): Promise<void> {
    // Tear the prior anvil down and WAIT for it to fully exit (port released) before booting the next.
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
  // cook target is approved to pull it, and the Broker holds enough tokenOut (asset1) to satisfy the out.
  async function assertPreCook(
    caller: Hex, target: Hex, amountIn: bigint, brokerHolds: { broker: Hex; expectedOut: bigint }[],
  ): Promise<void> {
    const callerIn = await balanceOf(c.publicClient, tokenIn, caller);
    assert.ok(callerIn >= amountIn, `caller tokenIn balance ${callerIn} >= amountIn ${amountIn}`);
    const allowance = (await c.publicClient.readContract({
      address: tokenIn, abi: erc20Abi as Abi, functionName: "allowance", args: [caller, target],
    })) as bigint;
    assert.ok(allowance >= amountIn, `cook target allowance ${allowance} >= amountIn ${amountIn}`);
    for (const { broker, expectedOut } of brokerHolds) {
      const held = await balanceOf(c.publicClient, tokenOut, broker);
      assert.ok(held >= expectedOut, `broker ${broker} tokenOut reserve ${held} >= expected out ${expectedOut}`);
    }
  }

  // Off-chain MentoPool descriptor for a deployed exchange — SAMPLES the Broker's LIVE getAmountOut ladder
  // over [0, amountIn] exactly as discovery does (no closed-form read; the real Broker exposes none).
  async function offPool(broker: Hex, provider: Hex, exchangeId: Hex, amountIn: bigint): Promise<MentoPool> {
    const cumIn = mentoSampleInputs(amountIn);
    const cumOut: bigint[] = [];
    for (const amt of cumIn) cumOut.push(await onQuery(broker, provider, exchangeId, amt));
    return {
      broker, exchangeProvider: provider, exchangeId, tokenIn, tokenOut, cumIn, cumOut,
      feePpm: Number(SPREAD_PPM), source: "local-fixture",
    };
  }

  // Deploy a Mento stack (asset0=tokenIn, asset1=tokenOut) — the BiPoolManager + Broker + one exchange,
  // funded with both reserves. `depth` sets the utilization slippage (larger ⇒ deeper/flatter).
  async function deploy(
    center: bigint, res0: bigint, res1: bigint, depth: bigint, minter: Account,
  ): Promise<{ broker: Hex; provider: Hex; exchangeId: Hex }> {
    return deployMento(
      c.walletClient, c.publicClient, tokenIn, tokenOut, RATE, RATE, center, SPREAD_PPM, res0, res1, depth, minter,
    );
  }

  // The Broker's own on-chain getAmountOut view — the engine-independent ground truth for the executed dy.
  async function onQuery(broker: Hex, provider: Hex, exchangeId: Hex, amt: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: broker, abi: mentoBrokerAbi as Abi, functionName: "getAmountOut",
      args: [provider, exchangeId, tokenIn, tokenOut, amt],
    })) as bigint;
  }

  // ── (1) SOLO Mento venue — received == getAmountOut(share) == on-chain view to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const { broker, provider, exchangeId } = await deploy(CENTER, 2_000_000n * E18, 2_000_000n * E18, DEPTH, caller);

    // amountIn == the full sampled ladder cap ⇒ the merge awards the WHOLE Σ to this one venue.
    const amountIn = 100_000n * E18;
    const op = await offPool(broker, provider, exchangeId, amountIn);
    const segRows = mentoSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Mento segment ladder");
    const segSum = segRows.reduce((a, r) => a + r[1], 0n);
    assert.equal(segSum, amountIn, "Mento segments cover the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, mentoArgs(tokenIn, tokenOut, amountIn, caller, broker, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [{ broker, expectedOut: await onQuery(broker, provider, exchangeId, segSum) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const brokerInBefore = await balanceOf(c.publicClient, tokenIn, broker);

    const onViewPre = await onQuery(broker, provider, exchangeId, amountIn);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo Mento cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const brokerIn = (await balanceOf(c.publicClient, tokenIn, broker)) - brokerInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (the whole trade routed to the Mento exchange)");
    assert.equal(brokerIn, amountIn, "the Broker received the full input share (approve + pull)");

    // EXACT-VS-LIVE-QUOTE: received == the Broker's own LIVE getAmountOut(+share) view to the wei.
    assert.equal(received, onViewPre, "received == on-chain getAmountOut view (exact-vs-live-quote)");
    assert.ok(received > 0n, "non-zero Mento fill through the callback-free approve+swapIn path");

    console.log(`  [Mento solo:${engine}] spent=${spent} received=${received} (== on-chain getAmountOut to the wei)`);
  }

  // ── (2) TWO Mento venues — split + per-leg exact-in-dy + marginals equalize ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Two venues at the same 1:1 center but DIFFERENT depth (utilization slippage) → different marginal
    // curves, so the water-fill engages BOTH and equalizes their post-spread marginals. A (larger depth) is
    // flatter/deeper, so it drives first + more; B (smaller depth) steepens sooner. Each is its own Broker +
    // exchange (one exchange per Broker in the fixture); the solver's cfg[7] is a SINGLE chain-wide Broker,
    // so both venues MUST share ONE Broker. We deploy ONE Broker and register a SECOND exchange on a SECOND
    // provider wired into the same Broker (exactly the production shape: one Broker, many exchanges).
    const DEPTH_A = 40_000_000n * E18; // deep/flat
    const DEPTH_B = 8_000_000n * E18; // shallower (steeper)
    const a = await deploy(CENTER, 5_000_000n * E18, 5_000_000n * E18, DEPTH_A, caller);
    const broker = a.broker;
    // Second exchange (provider B) on the SAME Broker: deploy a fresh provider, register the pair, configure
    // its bucket with a shallower depth, and fund the shared Broker with additional reserves.
    const providerB = await deployMentoProviderOnBroker(broker, DEPTH_B, 5_000_000n * E18, 5_000_000n * E18, caller);

    const amountIn = 200_000n * E18;
    const opA = await offPool(broker, a.provider, a.exchangeId, amountIn);
    const opB = await offPool(broker, providerB.provider, providerB.exchangeId, amountIn);
    const segRows = sortSegs([...mentoSegRows(opA, 0, amountIn), ...mentoSegRows(opB, 1, amountIn)]);

    const { bytecodes } = compileSauce(
      solverSrc, mentoArgs(tokenIn, tokenOut, amountIn, caller, broker, segRows), ECOSWAP_DIR, engine,
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [
      { broker, expectedOut: (await onQuery(broker, a.provider, a.exchangeId, amountIn)) + (await onQuery(broker, providerB.provider, providerB.exchangeId, amountIn)) },
    ]);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "two-venue Mento cook() must succeed");

    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // The awarded per-venue inputs are deterministic from the shared oracle sampler — recover them from the
    // off-chain optimal split (the awarded Σ == the oracle bit-for-bit by construction).
    const { aIn, bIn } = splitAwarded(opA, opB, amountIn);
    assert.ok(aIn > 0n && bIn > 0n, "both Mento venues are funded");
    assert.ok(aIn > bIn, `deeper venue A draws more than B (A ${aIn} > B ${bIn})`);

    // PER-LEG EXACT-VS-LIVE-QUOTE: received == getAmountOut_A(aIn) + getAmountOut_B(bIn) on-chain.
    const expected = (await onQuery(broker, a.provider, a.exchangeId, aIn)) + (await onQuery(broker, providerB.provider, providerB.exchangeId, bIn));
    assert.equal(received, expected, "received == Σ on-chain getAmountOut(per-venue share) to the wei");

    // MARGINALS EQUALIZE within the GRID bound (exact-on-grid at the snapshot: the awarded inputs equal the
    // oracle bit-for-bit — the realized post-spread marginal equalizes to within ONE sampled segment's price
    // width).
    const margA = marginalAt(opA, aIn);
    const margB = marginalAt(opB, bIn);
    const diff = margA > margB ? margA - margB : margB - margA;
    const relPpm = margA > 0n ? (diff * 1_000_000n) / margA : 0n;
    assert.ok(relPpm <= 3000n, `Mento split marginals equalize on the M=24 grid (rel ${relPpm} ppm; A ${margA} B ${margB})`);

    console.log(
      `  [Mento split:${engine}] A in=${aIn} B in=${bIn} received=${received} ` +
        `(== Σ getAmountOut to the wei); marginals A=${margA} B=${margB} (${relPpm} ppm)`,
    );
  }

  // ── (3) SOLO Mento under the PRODUCTION treeshake define set ──
  // Same trade as runSolo, but compiled with treeshake:true + Mento-only defines (the exact compile a
  // production Mento-without-other-segs cook carries). Guards the guard triple: if HAS_MENTO is missing from
  // the segment-head price-merge guard, the accumulator branch, OR the exec block, under treeshake the Mento
  // head is never compared / never accumulated / never swapped and the swap lands ZERO (Balancer bug).
  async function runSoloTreeshake(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const { broker, provider, exchangeId } = await deploy(CENTER, 2_000_000n * E18, 2_000_000n * E18, DEPTH, caller);

    const amountIn = 100_000n * E18;
    const op = await offPool(broker, provider, exchangeId, amountIn);
    const segRows = mentoSegRows(op, 0, amountIn);
    assert.ok(segRows.length > 0, "non-empty Mento segment ladder");

    const { bytecodes } = compileSauce(
      solverSrc, mentoArgs(tokenIn, tokenOut, amountIn, caller, broker, segRows), ECOSWAP_DIR, engine,
      { treeshake: true, defines: MENTO_ONLY_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await assertPreCook(caller, target, amountIn, [{ broker, expectedOut: await onQuery(broker, provider, exchangeId, amountIn) }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "treeshaken Mento-only cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // The merge MUST have routed the trade to Mento — non-zero spend/receive is the regression gate.
    assert.ok(spent > 0n, "treeshaken Mento-only: non-zero Mento fill (guard triple alive)");
    assert.equal(received, await onQuery(broker, provider, exchangeId, spent), "received == on-chain getAmountOut(share) to the wei (treeshaken path)");

    console.log(`  [Mento treeshake:${engine}] spent=${spent} received=${received} (production define set)`);
  }

  // ── (4) STATE MOVES between prepare and cook — exec stays exact-in-dy at the LIVE bucket state ──
  // The split is priced at the SNAPSHOT bucket state (op captures the oracle rates / center price), the segs
  // are built from it, THEN the buckets refresh / re-center via setBuckets before the cook. The exec re-reads
  // the LIVE state via the Broker getAmountOut, so the received dy == the LIVE quote at the MOVED state
  // (exact-in-dy), NOT the snapshot dy — the documented Class-A snapshot model. A re-center that RAISES the
  // asset1-per-asset0 center price ⇒ MORE out; per-venue minOut (== the LIVE quote) guards an adverse move.
  async function runStateMoves(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Fund with EXTRA asset1 so the moved-state (larger) output is still covered.
    const { broker, provider, exchangeId } = await deploy(CENTER, 2_000_000n * E18, 4_000_000n * E18, DEPTH, caller);

    const amountIn = 100_000n * E18;
    const opSnapshot = await offPool(broker, provider, exchangeId, amountIn); // the SNAPSHOT ladder the split is priced at
    const snapDy = await onQuery(broker, provider, exchangeId, amountIn); // the snapshot quote for the whole trade
    const segRows = mentoSegRows(opSnapshot, 0, amountIn); // segments PRICED at the snapshot
    const { bytecodes } = compileSauce(
      solverSrc, mentoArgs(tokenIn, tokenOut, amountIn, caller, broker, segRows), ECOSWAP_DIR, engine,
    );

    // The buckets MOVE between prepare (segs above) and cook: re-center to a BETTER asset1-per-asset0 price
    // (center 1.01× ⇒ more out per unit) — a strictly better fill.
    const movedCenter = (CENTER * 101n) / 100n;
    const setHash = await c.walletClient.writeContract({
      address: broker, abi: mentoBrokerAbi as Abi, functionName: "setBuckets",
      args: [provider, exchangeId, RATE, RATE, movedCenter],
      account: c.walletClient.account as Account, chain: c.walletClient.chain,
    });
    await c.publicClient.waitForTransactionReceipt({ hash: setHash });

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const liveOut = await onQuery(broker, provider, exchangeId, amountIn); // LIVE quote at the moved state — the exec ground truth
    await assertPreCook(caller, target, amountIn, [{ broker, expectedOut: liveOut }]);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "state-moved Mento cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // EXACT-VS-LIVE-QUOTE at the LIVE (moved) state — NOT the snapshot dy.
    assert.equal(spent, amountIn, "the whole trade routed to the single Mento exchange");
    assert.equal(received, liveOut, "received == on-chain LIVE getAmountOut view at the moved state");
    assert.ok(received > snapDy, "moved (re-centered up) state yields more than the snapshot dy");

    console.log(
      `  [Mento state-move:${engine}] spent=${spent} received=${received} ` +
        `(snapshot dy=${snapDy} < live dy — exact-vs-live-quote at the moved state)`,
    );
  }

  // Register a SECOND exchange (fresh provider) on an EXISTING Broker + fund the Broker with extra reserves.
  // Mirrors the production shape (one chain-wide Broker, many exchanges/providers) so cfg[7] serves both.
  async function deployMentoProviderOnBroker(
    broker: Hex, depth: bigint, res0: bigint, res1: bigint, minter: Account,
  ): Promise<{ provider: Hex; exchangeId: Hex }> {
    // Deploy a fresh Mento stack, then reuse ONLY its provider + exchange against the shared Broker.
    const fresh = await deployMento(
      c.walletClient, c.publicClient, tokenIn, tokenOut, RATE, RATE, CENTER, SPREAD_PPM, 0n, 0n, depth, minter,
    );
    // Wire the fresh provider into the shared Broker + configure its bucket there.
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: broker, abi: mentoBrokerAbi as Abi, functionName: "addExchangeProvider",
        args: [fresh.provider], account: minter, chain: c.walletClient.chain,
      }),
    });
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: broker, abi: mentoBrokerAbi as Abi, functionName: "configureExchange",
        args: [fresh.provider, fresh.exchangeId, tokenIn, tokenOut, RATE, RATE, CENTER, SPREAD_PPM, depth],
        account: minter, chain: c.walletClient.chain,
      }),
    });
    // Fund the shared Broker with the second venue's reserves (it pays both venues' outs).
    await writeTransfer(tokenOut, broker, res1, minter);
    await writeTransfer(tokenIn, broker, res0, minter);
    return { provider: fresh.provider, exchangeId: fresh.exchangeId };
  }

  async function writeTransfer(token: Hex, to: Hex, amount: bigint, from: Account): Promise<void> {
    if (amount <= 0n) return;
    await c.publicClient.waitForTransactionReceipt({
      hash: await c.walletClient.writeContract({
        address: token, abi: erc20Abi as Abi, functionName: "transfer", args: [to, amount],
        account: from, chain: c.walletClient.chain,
      }),
    });
  }

  // Post-spread out/in marginal price at a cumulative input `share` — a small finite-difference slice of
  // getAmountOut around `share` (the same coordinate the segments carry). Used only to check the split
  // equalized marginals.
  function marginalAt(pool: MentoPool, share: bigint): bigint {
    if (share <= 0n) return 0n;
    const eps = share / 1000n > 0n ? share / 1000n : 1n;
    const lo = share - eps > 0n ? share - eps : 0n;
    const dIn = share - lo;
    const dOut = mentoGetAmountOut(pool, share) - mentoGetAmountOut(pool, lo);
    if (dIn <= 0n || dOut <= 0n) return 0n;
    return isqrt((dOut * (1n << 192n)) / dIn);
  }

  // Recover the awarded per-venue inputs by replaying the descending-price merge over the SHARED sampled
  // segments (the same construction index.ts + the solver use). The solver awards each segment DESC by
  // marginalOI up to amountIn; summing per-venue capacity gives the awarded Σ, which the on-chain solver
  // matches bit-for-bit (exact-on-grid). This mirrors the oracle without importing the whole optimalSplit.
  function splitAwarded(opA: MentoPool, opB: MentoPool, amountIn: bigint): { aIn: bigint; bIn: bigint } {
    const segsA = buildMentoSegments(opA, amountIn).map((s) => ({ v: 0, cap: s.capacity, m: s.marginalOI }));
    const segsB = buildMentoSegments(opB, amountIn).map((s) => ({ v: 1, cap: s.capacity, m: s.marginalOI }));
    const all = [...segsA, ...segsB].sort((x, y) => (x.m === y.m ? x.v - y.v : x.m < y.m ? 1 : -1));
    let cum = 0n;
    let aIn = 0n;
    let bIn = 0n;
    for (const s of all) {
      if (cum >= amountIn) break;
      let take = s.cap;
      if (cum + take > amountIn) take = amountIn - cum;
      if (s.v === 0) aIn += take;
      else bIn += take;
      cum += take;
    }
    return { aIn, bIn };
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`Mento solo [${engine}] — received == getAmountOut(share) == on-chain view to the wei (exact-in-dy)`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`Mento split [${engine}] — two venues, per-leg exact-in-dy + marginals equalize`, { skip }, async () => {
      await runSplit(engine);
    });
    it(`Mento solo treeshake [${engine}] — production define set lands a non-zero Mento fill`, { skip }, async () => {
      await runSoloTreeshake(engine);
    });
    it(`Mento state moves [${engine}] — split priced at snapshot, exec exact-in-dy at the live state`, { skip }, async () => {
      await runStateMoves(engine);
    });
  }
});
