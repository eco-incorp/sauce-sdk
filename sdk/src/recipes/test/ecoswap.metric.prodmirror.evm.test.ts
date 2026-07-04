/**
 * EcoSwap METRIC (metric.xyz oracle-anchored bin-curve OMM) PROD-MIRROR — REAL BYTECODE, NO FORK,
 * OFFLINE, BOTH DIRECTIONS. MANDATORY for this family: every Metric contract (Router, per-pair pool,
 * PriceProvider, its offchain-oracle hub) is UNVERIFIED — no source exists anywhere — so the genuine
 * etched runtime is the ONLY way to prove the production discovery + anchor-hoist + QL-ladder +
 * swapExactInput path against the real bin math.
 *
 * Unlike ecoswap.metric.evm.test.ts (which deploys the MetricPool/Router/Provider .sol fixtures),
 * this test stands up the GENUINE Base-mainnet graph captured by harness/metric-snapshot.ts —
 * router + pool + provider + the provider's offchain hub + the THREE Chainlink feed proxies and
 * their aggregators (real round data) — via the fermi harness verbatim (the snapshot is
 * FERMI-SHAPED: fermiSwapper = the ROUTER, vault = the POOL holding the payout inventory), and runs
 * the swap against it: etch + setStorageAt, seconds, no RPC.
 *
 * ── block.timestamp (the 10-second staleness gate) ──────────────────────────────────────────────────
 * The REAL provider reverts 0x9a0423af once the maker's posted price is older than MAX_TIME_DELTA
 * (10 s) vs block.timestamp, plus Chainlink staleness/sequencer-grace checks. The harness pins the
 * anvil clock to the captured block timestamp (pinFermiBlockTimestamp, zero block-time interval), so
 * every quote and every cook sees the capture instant — where the anchor is fresh and equal to the
 * persisted `metricAnchor` — making the etched quotes deterministic ground truth.
 *
 * Cells (× v1/v12 via ECO_ENGINE):
 *   (a) INTEGRITY — every checked-in runtime hashes to its capture anchor, eth_getCode matches
 *       byte-for-byte, the etched provider returns the persisted anchor, and the captured probe
 *       ladders (BOTH directions) reproduce WEI-EXACT.
 *   (b) The production discovery→anchor-hoist→QL→exec run FORWARD (WETH→USDC), wei-exact vs the
 *       prefetched-grid oracle + the real router's own pre-swap quote.
 *   (c) The SAME run in REVERSE (USDC→WETH) — the real-stack directional-limit cell (yToX,
 *       limit = uint128.max; |amount0Delta| decode).
 *   (d) DRIFT — move the REAL bin book with a GENUINE swapExactInput through the etched router, then
 *       cook the PRE-drift bytecodes: the in-cook anchor hoist + live ladder RE-ANCHOR to the moved
 *       state (received == the post-drift live quote of the awarded share).
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.metric.prodmirror.evm.test.ts
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAbi, getAddress, type Abi, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import { ensureMulticall3, deployStack, mint, approve, balanceOf, type DeployedStack, type DeployedV12Stack } from "./harness/setup";
import {
  etchFermiGraph,
  loadFermiSnapshots,
  verifyFermiBytecodeIntegrity,
  pinFermiBlockTimestamp,
  type EtchedFermiGraph,
} from "./harness/etch-pool";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { metricQLGridInputs, METRIC_LIMIT_MAX_U128, type MetricPool } from "../shared/metric-math";

const SNAP_NAME = "base-metric-WETHUSDC";
const ENGINE_CELLS = engineCells();

const providerAbi = parseAbi(["function getBidAndAskPrice() view returns (uint128 bid, uint128 ask)"]);
const routerAbi = parseAbi([
  "function quoteSwap(address pool, bool xToY, int128 amountSpecified, uint128 priceLimit, uint128 bid, uint128 ask) view returns (int256 amount0Delta, int256 amount1Delta)",
  "function swapExactInput(address pool, address recipient, bool xToY, uint128 amountIn, uint128 priceLimit, uint256 minAmountOut, uint256 deadline)",
]);

describe("EcoSwap METRIC prod-mirror — REAL router+pool+provider+oracle bytecode, no fork, offline, both directions", () => {
  const snaps = loadFermiSnapshots(SNAP_NAME);
  const POOL = getAddress(snaps.state.metricPool!) as Hex;
  const PROVIDER = getAddress(snaps.state.metricProvider!) as Hex;
  const ROUTER = getAddress(snaps.state.fermiSwapper) as Hex;
  const ANCHOR = { bid: BigInt(snaps.state.metricAnchor!.bid), ask: BigInt(snaps.state.metricAnchor!.ask) };

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedFermiGraph;

  async function setup(): Promise<void> {
    const prev = anvil;
    prev?.stop();
    await prev?.stopped;
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    etched = await etchFermiGraph(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: 300n * 10n ** 18n, // WETH headroom (forward cooks + the drift swap)
    });
    // The REVERSE cells spend USDC — mint the caller a generous local-USDC balance (6 dec).
    await mint(c.walletClient, c.publicClient, etched.tokenOut, c.account0, 500_000n * 10n ** 6n);
    // PIN THE CLOCK to the capture instant — the provider's 10-second staleness gate + the Chainlink
    // freshness windows are all block.timestamp-keyed. MUST precede the first quote/cook.
    await pinFermiBlockTimestamp(c.testClient as never, snaps.state);
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** The etched provider's LIVE anchor (== the persisted capture anchor at the pinned clock). */
  async function liveAnchor(): Promise<{ bid: bigint; ask: bigint }> {
    const [bid, ask] = (await c.publicClient.readContract({
      address: PROVIDER, abi: providerAbi as Abi, functionName: "getBidAndAskPrice",
    })) as readonly [bigint, bigint];
    return { bid, ask };
  }

  /** The REAL etched router's quote at the live anchor — |negative out-delta| for the direction. */
  async function onQuote(xToY: boolean, amt: bigint): Promise<bigint> {
    const { bid, ask } = await liveAnchor();
    const [a0, a1] = (await c.publicClient.readContract({
      address: ROUTER, abi: routerAbi as Abi, functionName: "quoteSwap",
      args: [POOL, xToY, amt, xToY ? 0n : METRIC_LIMIT_MAX_U128, bid, ask],
    })) as readonly [bigint, bigint];
    const outDelta = xToY ? a1 : a0;
    return outDelta < 0n ? -outDelta : 0n;
  }

  /** The Fluid/Tessera PREFETCH pattern: quote the REAL etched router at the DETERMINISTIC QL grid
   *  (metricQLGridInputs) at the frozen etched anchor, answer by exact-point lookup — the oracle's
   *  `getDy` quote model. */
  async function offPool(xToY: boolean, amountIn: bigint): Promise<MetricPool> {
    const grid = metricQLGridInputs(amountIn);
    const quotes = new Map<bigint, bigint>();
    for (const x of grid) quotes.set(x, await onQuote(xToY, x));
    return {
      address: POOL, provider: PROVIDER, router: ROUTER, xToY,
      tokenIn: xToY ? etched.tokenIn : etched.tokenOut,
      tokenOut: xToY ? etched.tokenOut : etched.tokenIn,
      feePpm: 0, source: "prod-mirror-prefetch",
      getDy: (dx: bigint): bigint => {
        const q = quotes.get(dx);
        if (q === undefined) throw new Error(`metric prefetch grid miss at ${dx}`);
        return q;
      },
    };
  }

  function metricPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: ROUTER,
          poolType: SwapPoolType.UniV2, // INERT placeholder (discovery keys off factoryType)
          factoryType: FactoryType.Metric,
          label: "Local Metric (prod-mirror)",
          metricRouter: ROUTER,
          metricPools: [POOL],
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  // ── (a) REAL BYTECODE — integrity + the persisted anchor + both captured probe ladders wei-exact ──
  it("etches the REAL Metric router+pool+provider+oracle graph (byte-equal) + reproduces the captured anchor and BOTH probe ladders", async () => {
    await setup();
    // NO-NETWORK integrity tripwire FIRST: every checked-in runtime still hashes to its capture anchor.
    const integ = verifyFermiBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.allOk, "every captured runtime sha256 matches its capture anchor");

    for (const cc of snaps.bytecode.contracts) {
      const addr = getAddress(cc.address) as Hex;
      const isToken = ["WETH", "USDC"].some(
        (sym) => getAddress(snaps.state.tokens[sym].address).toLowerCase() === addr.toLowerCase(),
      );
      if (isToken) continue; // repointed to local MintableERC20s
      const code = await c.publicClient.getCode({ address: addr });
      assert.equal(code?.toLowerCase(), cc.runtime.toLowerCase(), `eth_getCode at ${addr} == captured REAL runtime [${cc.role}]`);
    }

    // The etched provider returns EXACTLY the persisted capture anchor at the pinned clock — the
    // 10-second staleness gate + the Chainlink windows are all satisfied at the capture instant.
    const { bid, ask } = await liveAnchor();
    assert.equal(bid, ANCHOR.bid, "etched getBidAndAskPrice bid == the persisted capture anchor");
    assert.equal(ask, ANCHOR.ask, "etched getBidAndAskPrice ask == the persisted capture anchor");

    // BOTH captured probe ladders reproduce WEI-EXACT — the strongest single-shot proof the etched
    // graph IS Base mainnet (real router dispatch, real bin book, real oracle graph).
    for (const p of snaps.state.probe.target.ladder) {
      const out = await onQuote(true, BigInt(p.amountIn));
      assert.equal(out.toString(), p.amountOut, `REAL quoteSwap fwd(${p.amountIn}) == captured Base ${p.amountOut}`);
    }
    for (const p of snaps.state.probe.second!.ladder) {
      const out = await onQuote(false, BigInt(p.amountIn));
      assert.equal(out.toString(), p.amountOut, `REAL quoteSwap rev(${p.amountIn}) == captured Base ${p.amountOut}`);
    }
    console.log(
      `  [metric-prod-mirror] REAL bytecode etched (${etched.contractCount} contracts, ${etched.slotCount} slots); ` +
        `pool inventory ${snaps.state.vault.reserves.WETH} WETH / ${snaps.state.vault.reserves.USDC} USDC; ` +
        `anchor bid=${bid} ask=${ask}; BOTH probe ladders wei-exact @ pinned ts ${snaps.state.blockTimestamp}`,
    );
  });

  // ── (b)/(c) The production discovery→anchor-hoist→QL→exec run, either direction, wei-exact. ──
  async function runProdMirror(engine: Engine, xToY: boolean): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const tokenIn = xToY ? etched.tokenIn : etched.tokenOut; // WETH fwd / USDC rev (local mints at real addrs)
    const tokenOut = xToY ? etched.tokenOut : etched.tokenIn;
    // FORWARD: 40 WETH ≈ 71k USDC — deep inside the ~164k-USDC captured inventory. REVERSE:
    // 30,000 USDC ≈ 17 WETH — deep inside the ~105-WETH side. Both sizes are large enough that the
    // real bin curve's per-slice curvature clears the out-token integer rounding (the ladder's
    // strict-descent guard may still fold a genuinely-flat tail — solver and oracle stop
    // IDENTICALLY, so the split stays wei-exact; the >= 50% coverage bound below catches a gross
    // under-fill instead).
    const amountIn = xToY ? 40n * 10n ** 18n : 30_000n * 10n ** 6n;
    const poolConfig = metricPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await c.publicClient.request({
      method: "anvil_setBalance" as never,
      params: [target as never, "0x8AC7230489E80000" as never],
    } as never);

    // Discovery + compile against the etched graph (the venue quotes live at the pinned clock).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, undefined, engine,
    );
    assert.equal(prepared.pools.length, 0, "no direct pools (Metric-only config)");
    assert.equal((prepared.metricPools ?? []).length, 1, "discovered exactly the 1 REAL Metric venue");
    const venue = prepared.metricPools![0];
    assert.equal(venue.address.toLowerCase(), POOL.toLowerCase(), "the venue IS the etched pool");
    assert.equal(venue.router.toLowerCase(), ROUTER.toLowerCase(), "the descriptor carries the etched ROUTER");
    assert.equal(venue.provider.toLowerCase(), PROVIDER.toLowerCase(), "the descriptor carries the etched PROVIDER");
    assert.equal(venue.xToY, xToY, "the descriptor's direction bit matches the edge");

    // PREFETCH the REAL router's quotes at the deterministic QL grid (frozen etched anchor) → oracle.
    const op = await offPool(xToY, amountIn);
    const oracle = optimalSplit({ pools: [{ metric: op, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the REAL Metric venue");
    assert.ok(awarded * 2n >= amountIn, `awarded covers >= 50% of amountIn (awarded=${awarded})`);

    // The REAL router's own pre-swap quote of the awarded share — the ground truth for the executed
    // dy (the exec's minAmountOut re-reads exactly this inside the cook, same anchor, same bin book).
    const onViewPre = await onQuote(xToY, awarded);

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, POOL);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", `cook() must succeed against the REAL Metric graph (${xToY ? "fwd" : "REV"})`);

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, POOL)) - poolInBefore;

    assert.equal(spent, awarded, "on-chain spent == prefetched-oracle awarded (wei-exact)");
    assert.equal(poolIn, spent, "the REAL router's callback pulled the input into the POOL");
    assert.equal(received, onViewPre, "received == REAL router pre-swap quoteSwap(awarded) (wei-exact-vs-live-quote)");
    assert.ok(received > 0n, "caller receives tokenOut from the pool inventory");

    const ms = Date.now() - t0;
    console.log(
      `  [metric-prod-mirror:${engine}:${xToY ? "fwd" : "REV"}] WEI-EXACT — spent=${spent} received=${received} ` +
        `(== real quoteSwap); wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  // ── (d) DRIFT — move the REAL bin book with a GENUINE swap, then cook the PRE-drift bytecodes. ──
  async function runDrift(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const tokenIn = etched.tokenIn; // WETH
    const tokenOut = etched.tokenOut; // USDC
    const amountIn = 40n * 10n ** 18n;
    const poolConfig = metricPoolConfig(tokenIn, tokenOut);

    const driftAmt = 10n * 10n ** 18n;
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, ROUTER, driftAmt);
    await c.publicClient.request({
      method: "anvil_setBalance" as never,
      params: [target as never, "0x8AC7230489E80000" as never],
    } as never);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, target, caller, poolConfig, undefined, engine,
    );
    assert.equal((prepared.metricPools ?? []).length, 1, "discovered the REAL Metric venue");
    const baselineQuote = await onQuote(true, amountIn);

    // GENUINE drift: a REAL swapExactInput (10 WETH) through the REAL router — the bin book moves
    // (the same live state the cook's ladder + anchor hoist will read). Deadline = pinned ts + 1h.
    const deadline = BigInt(snaps.state.blockTimestamp) + 3600n;
    const driftHash = await c.walletClient.writeContract({
      address: ROUTER, abi: routerAbi as Abi, functionName: "swapExactInput",
      args: [POOL, caller, true, driftAmt, 0n, 0n, deadline], account: c.walletClient.account as Account,
      chain: c.walletClient.chain, gas: 5_000_000n,
    });
    const driftReceipt = await c.publicClient.waitForTransactionReceipt({ hash: driftHash });
    assert.equal(driftReceipt.status, "success", "the REAL drift swap lands on the etched graph");

    // Re-prefetch the POST-drift grid — the oracle the PRE-drift bytecodes must re-anchor to.
    const opDrift = await offPool(true, amountIn);
    const driftQuote = opDrift.getDy(metricQLGridInputs(amountIn).at(-1)!);
    console.log(`  [metric-prod-mirror drift:${engine}] baseline quote=${baselineQuote} post-drift full-size quote=${driftQuote}`);
    const oracleDrift = optimalSplit({ pools: [{ metric: opDrift, feePpm: 0 } as OptimalPool], amountIn, zeroForOne: true });
    const awardedDrift = oracleDrift.perPoolInput[0] ?? 0n;
    assert.ok(awardedDrift > 0n, "post-drift oracle still allocates");
    const onViewDrift = await onQuote(true, awardedDrift);

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "PRE-drift bytecodes cook successfully after a REAL bin-book move");
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.equal(spent, awardedDrift, "spent == the POST-drift prefetched-oracle award (re-anchored)");
    assert.equal(received, onViewDrift, "received == the POST-drift live quote of the awarded share (re-anchored, wei-exact)");
    console.log(
      `  [metric-prod-mirror drift:${engine}] real 10-WETH drift swap, then pre-drift cook — ` +
        `spent=${spent} received=${received} == post-drift quote (re-anchored)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL Metric graph FORWARD (WETH→USDC) [${engine}] — wei-exact, offline`, { skip }, async () => {
      await runProdMirror(engine, true);
    });
    it(`runs EcoSwap through the REAL Metric graph REVERSE (USDC→WETH) [${engine}] — the directional-limit cell, wei-exact`, { skip }, async () => {
      await runProdMirror(engine, false);
    });
    it(`REAL-swap drift re-anchor [${engine}] — pre-drift bytecodes re-anchor to the moved bin book`, { skip }, async () => {
      await runDrift(engine);
    });
  }
});
