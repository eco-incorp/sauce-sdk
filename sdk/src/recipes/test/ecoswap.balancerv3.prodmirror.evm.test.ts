/**
 * EcoSwap Balancer V3 (balancer/balancer-v3-monorepo — Vault singleton + per-chain Router) PROD-MIRROR —
 * REAL BYTECODE, NO FORK, OFFLINE. The PRIMARY validation of the on-chain StableMath QUOTE-LADDER.
 *
 * Balancer V3's querySwapSingleTokenExactIn is eth_call-ONLY (uncallable on-chain in a cook), so — UNLIKE every
 * other QL venue — the on-chain solver cannot quote a live view. Instead it reads the LIVE Vault StableMath
 * state (getCurrentLiveBalances / getAmplificationParameter / getStaticSwapFeePercentage + each token's
 * rateProvider.getRate — all SCALARS / inline-indexed bare arrays, v12-safe) and REPLAYS the amplified
 * StableSwap invariant (V3 rounding, LIVE rate scaling) in SauceScript to build its price ladder. This test
 * stands up the GENUINE ~20-contract Base graph (etch + setStorageAt, seconds — NO fork/RPC at run time) and
 * proves that replay is wei-exact against the pool's OWN querySwapSingleTokenExactIn, and that because the
 * state is read LIVE the split RE-ANCHORS to cook-time balances + rates (the ADVERSE-DRIFT money test — a
 * snapshot rate would FAIL it).
 *
 * MECHANISM: see harness/etch-pool.ts etchBalancerV3Graph (the whole-graph etch, block pinned 48120913; the
 * wired 0x7ab1… "Balancer Aave USDC-Aave GHO" pool — StableSurge-HOOKED + rate-scaled ERC4626 wrappers
 * waUSDC/waGHO). For waUSDC→waGHO the swap moves the pool TOWARD balance so the surge hook returns exactly the
 * static fee (the ladder is near-linear) — so the static-fee StableMath is wei-exact here; a surge-ACTIVE pool
 * is EXCLUDED at discovery (documented scope, a follow-up lane).
 *
 * CENTRAL VERIFICATION (this file asserts all explicitly):
 *   (a) REAL bytecode — eth_getCode at EVERY graph contract == the captured real runtime (sha256 tripwire), and
 *       the REAL Router.querySwapSingleTokenExactIn reproduces the captured mainnet probe to the wei.
 *   (b) STABLEMATH LADDER == REAL QUERY at S points — the on-chain StableMath replay (balancerV3StableGetDy, the
 *       exact math the solver runs on-chain + the oracle mirrors) equals the pool's OWN querySwapSingleTokenExactIn
 *       at every geometric QL ladder input, to the wei. This is the wei-exact gate the whole design rests on.
 *   (c) WEI-EXACT COOK (zero-cache) — the caller-received tokenOut == the neutral oracle (optimalSplit over
 *       buildBalancerV3QLLadder off the LIVE state) == the REAL Router's LIVE querySwap of the awarded slice,
 *       all to the wei, on BOTH engines. No prepared segments — the ladder is built entirely on-chain.
 *   (d) ADVERSE-DRIFT RE-ANCHOR (the money test for LIVE rates) — prepare+compile at T0, then ADVANCE the block
 *       clock (the ERC4626 wrapper rate = Aave getReserveNormalizedIncome accrues on block.timestamp, so both
 *       token rates GROW), then cook the T0 bytecodes. Because the solver reads the rates + balances LIVE at
 *       cook, the fill re-anchors to the drifted state: received == the oracle rebuilt from the T1 live state
 *       AND == the REAL querySwap at T1, and it DIFFERS from the T0 value (drift genuinely moved the outcome).
 *       A SNAPSHOT rate would land the T0 value and FAIL this.
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE (default v12; skip-by-default for v12 when the artifacts are
 * absent). No state cache — etch+setStorage is a few seconds.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.balancerv3.prodmirror.evm.test.ts
 *      ECO_ENGINE=both pnpm --filter './sdk' test:recipes:evm
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAbi, type Abi, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  approve,
  balanceOf,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  etchBalancerV3Graph,
  loadBalancerV3Snapshots,
  verifyBalancerV3BytecodeIntegrity,
  pinBalancerV3BlockTimestamp,
  balancerV3VaultReadAbi,
  balancerV3RouterReadAbi,
  balancerV3PoolReadAbi,
  balancerV3RateProviderReadAbi,
  type EtchedBalancerV3Graph,
} from "./harness/etch-pool";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { type EcoBalancerV3 } from "../shared/types";
import { ecoSwap } from "../ecoswap/index";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import {
  buildBalancerV3QLLadder,
  balancerV3StableGetDy,
  type BalancerV3Pool,
} from "../shared/balancer-v3-math";
import { qlLadderInputs } from "../shared/curve-math";

const SNAP_NAME = "base-balancerv3-waUSDCwaGHO";
const ENGINE_CELLS = engineCells();
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

describe("EcoSwap Balancer V3 (on-chain StableMath quote-ladder, live-rate-scaled) prod-mirror — REAL bytecode, no fork, offline", () => {
  const snaps = loadBalancerV3Snapshots(SNAP_NAME);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedBalancerV3Graph;

  // Boot a fresh anvil + etch the whole real graph + deploy the engine, then PIN the block clock (the wrapper
  // rate accrual). Called before each cell so each engine runs in full isolation (cheap: setCode + setStorageAt
  // + a real transfer + a handful of deploys, seconds not minutes). Funds the caller with EXTRA tokenIn so the
  // adverse-drift cell can leave a healthy margin.
  async function setup(): Promise<void> {
    const prev = anvil;
    prev?.stop();
    await prev?.stopped;
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    // The caller is funded by a REAL transfer FROM the etched Vault (~122,742 waUSDC via the captured storage),
    // so callerFund MUST be ≤ the Vault's waUSDC balance — 100k fits, and the Permit2 pull returns it to the
    // Vault during the swap so the Vault nets back up to pay-out capacity.
    const callerFund = 100_000n * 10n ** BigInt(snaps.state.tokenInDecimals);
    etched = await etchBalancerV3Graph(
      c.walletClient,
      c.publicClient,
      c.testClient as unknown as Parameters<typeof etchBalancerV3Graph>[2],
      anvil.rpcUrl,
      snaps,
      { caller: c.account0, callerFund },
    );
    await pinBalancerV3BlockTimestamp(
      c.testClient as unknown as Parameters<typeof pinBalancerV3BlockTimestamp>[0],
      snaps.state,
    );
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** A poolConfig with ONLY a Balancer V3 factory carrying the reproduced Vault + Router + pool → the
   *  production FactoryType.BalancerV3 discovery path resolves the etched pool via Vault.getPoolTokens +
   *  getPoolTokenInfo (rate providers) + the live StableMath state; the lens ignores non-V2/V3/V4 factory
   *  types, so no direct pools are surfaced and the Balancer V3 venue rides entirely through
   *  discoverBalancerV3PoolsTyped. */
  function balancerV3PoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.vault, // the CREATE2 Vault singleton (probed via getPoolTokens / getPoolTokenInfo)
          poolType: SwapPoolType.UniV2, // inert for Balancer V3 — discovery keys off factoryType
          factoryType: FactoryType.BalancerV3,
          label: "Local Balancer V3 (prod-mirror)",
          balancerV3Router: etched.router,
          balancerV3Pools: [etched.pool],
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  const rd = (address: Hex, abi: Abi, fn: string, args: unknown[] = []): Promise<unknown> =>
    c.publicClient.readContract({ address, abi, functionName: fn, args });

  // The Router's own on-chain querySwapSingleTokenExactIn view — the engine-independent GROUND TRUTH for the
  // executed dy. sender = ZERO, userData = "0x" (a pure quote; the query unlock()s the Vault in QUERY mode).
  async function onQuery(amt: bigint): Promise<bigint> {
    return (await rd(etched.router, balancerV3RouterReadAbi as Abi, "querySwapSingleTokenExactIn", [
      etched.pool,
      etched.tokenIn,
      etched.tokenOut,
      amt,
      ZERO,
      "0x",
    ])) as bigint;
  }

  /** Build the neutral oracle's BalancerV3Pool from the LIVE Vault StableMath state read at call time — the
   *  SAME state the on-chain solver reads at cook (getCurrentLiveBalances / amp / static fee / each rate
   *  provider's getRate), so the oracle's `buildBalancerV3QLLadder` == the solver's on-chain ladder to the wei
   *  at WHATEVER block this is called (before OR after drift). The descriptor (indices / rate providers / const
   *  decimal scales) comes from the production discovery output. */
  async function liveOracle(descr: EcoBalancerV3): Promise<BalancerV3Pool> {
    const [bal, fee, ampRes, rateIn, rateOut] = await Promise.all([
      rd(etched.vault, balancerV3VaultReadAbi as Abi, "getCurrentLiveBalances", [etched.pool]) as Promise<bigint[]>,
      rd(etched.vault, balancerV3VaultReadAbi as Abi, "getStaticSwapFeePercentage", [etched.pool]) as Promise<bigint>,
      rd(etched.pool, balancerV3PoolReadAbi as Abi, "getAmplificationParameter") as Promise<readonly [bigint, boolean, bigint]>,
      rd(descr.rpIn, balancerV3RateProviderReadAbi as Abi, "getRate") as Promise<bigint>,
      rd(descr.rpOut, balancerV3RateProviderReadAbi as Abi, "getRate") as Promise<bigint>,
    ]);
    return {
      address: descr.address,
      router: descr.router,
      tokenIn: etched.tokenIn,
      tokenOut: etched.tokenOut,
      feePpm: descr.feePpm,
      source: "prod-mirror",
      vault: descr.vault,
      inIdx: descr.inIdx,
      outIdx: descr.outIdx,
      amp: ampRes[0],
      staticFeeWad: fee,
      liveBalances: bal,
      rateIn,
      rateOut,
      decScaleIn: descr.decScaleIn,
      decScaleOut: descr.decScaleOut,
      rpIn: descr.rpIn,
      rpOut: descr.rpOut,
    };
  }

  /** Advance the anvil block clock (accrues the ERC4626 wrapper rate — the drift). Uses anvil_setTime (can
   *  jump forward past the pinned capture ts) + mine one block. */
  async function advanceClock(seconds: bigint): Promise<void> {
    const target = BigInt(snaps.state.blockTimestamp) + seconds;
    await (c.testClient as unknown as { request: (a: { method: string; params: unknown[] }) => Promise<unknown> }).request({
      method: "anvil_setTime",
      params: [Number(target)],
    });
    await (c.testClient as unknown as { mine: (a: { blocks: number }) => Promise<void> }).mine({ blocks: 1 });
  }

  // ── (a) REAL BYTECODE — the etched code IS the captured mainnet runtime, byte-for-byte. ──
  it("etches the REAL Balancer V3 graph bytecode (byte-equal) + reproduces the captured quotes", async () => {
    const integ = verifyBalancerV3BytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.allOk, `all ${integ.contracts.length} graph runtimes hash to their capture anchors`);
    for (const cc of integ.contracts) {
      assert.ok(cc.expected, `contract ${cc.address} (${cc.role}) carries a sha256 anchor`);
      assert.ok(cc.ok, `contract ${cc.address} (${cc.role}) runtime sha256 matches (got ${cc.actual})`);
    }
    assert.ok(snaps.bytecode.contracts.length >= 15, "the whole ~20-contract graph is captured");

    for (const cc of snaps.bytecode.contracts) {
      const code = await c.publicClient.getCode({ address: cc.address });
      assert.ok(code, `contract ${cc.address} (${cc.role}) has code`);
      assert.equal(
        code!.toLowerCase(),
        cc.runtime.toLowerCase(),
        `eth_getCode at ${cc.role} (${cc.address}) == the captured REAL runtime (byte-equal)`,
      );
    }
    assert.equal(etched.vault.toLowerCase(), snaps.bytecode.vault.toLowerCase(), "Vault at captured mainnet address");
    assert.equal(etched.pool.toLowerCase(), snaps.bytecode.pool.toLowerCase(), "pool at captured mainnet address");
    assert.equal(etched.router.toLowerCase(), snaps.bytecode.router.toLowerCase(), "Router at captured mainnet address");

    const registered = (await rd(etched.vault, balancerV3VaultReadAbi as Abi, "isPoolRegistered", [etched.pool])) as boolean;
    assert.ok(registered, "REAL Vault.isPoolRegistered(pool) == true");
    const tokens = (await rd(etched.vault, balancerV3VaultReadAbi as Abi, "getPoolTokens", [etched.pool])) as readonly Hex[];
    const set = new Set(tokens.map((t) => t.toLowerCase()));
    assert.ok(
      set.has(etched.tokenIn.toLowerCase()) && set.has(etched.tokenOut.toLowerCase()),
      "REAL Vault.getPoolTokens returns the swappable waGHO/waUSDC pair",
    );
    const p2 = (await rd(etched.router, balancerV3RouterReadAbi as Abi, "getPermit2")) as Hex;
    assert.equal(p2.toLowerCase(), etched.permit2.toLowerCase(), "REAL Router.getPermit2() == canonical Permit2");

    for (const p of snaps.state.probe.inToOut) {
      const got = await onQuery(BigInt(p.amountIn));
      assert.equal(got, BigInt(p.amountOut), `REAL querySwap(in->out, ${p.amountIn}) == captured mainnet value`);
    }

    console.log(
      `  [bv3-prod-mirror] REAL bytecode etched: ${etched.contractCount} contracts ` +
        `(${etched.slotCount} storage slots); Vault ${etched.vault}; pool ${etched.pool}; ` +
        `captured block ${snaps.state.block}; ${snaps.state.tokenInSymbol}(${snaps.state.tokenInDecimals}) -> ` +
        `${snaps.state.tokenOutSymbol}(${snaps.state.tokenOutDecimals})`,
    );
  });

  // ── (b) STABLEMATH LADDER == REAL QUERY at S points — the wei-exact gate the whole design rests on. ──
  it("on-chain StableMath replay == REAL querySwapSingleTokenExactIn at every QL ladder point (wei-exact)", async () => {
    await setup();
    const amountIn = 100_000n * 10n ** BigInt(snaps.state.tokenInDecimals);
    const { prepared } = await ecoSwap(
      { tokenIn: etched.tokenIn, tokenOut: etched.tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget("v1", stack, v12),
      c.account0,
      balancerV3PoolConfig(etched.tokenIn, etched.tokenOut),
    );
    assert.equal((prepared.balancerV3Pools ?? []).length, 1, "discovered exactly the 1 reproduced Balancer V3 venue");
    const descr = prepared.balancerV3Pools![0];
    const op = await liveOracle(descr);

    // At EACH geometric QL ladder input, the StableMath replay (the exact math the solver runs on-chain, and
    // the oracle mirrors) must equal the pool's OWN live query to the wei — an INACTIVE-surge pool.
    const pts = qlLadderInputs(amountIn);
    assert.ok(pts.length >= 4, "ladder has multiple points");
    let maxAbsDiff = 0n;
    for (const x of pts) {
      const replay = balancerV3StableGetDy(op, x);
      const truth = await onQuery(x);
      const diff = replay > truth ? replay - truth : truth - replay;
      if (diff > maxAbsDiff) maxAbsDiff = diff;
      assert.equal(replay, truth, `StableMath replay(${x}) == REAL querySwap(${x}) to the wei (diff ${diff})`);
    }
    assert.ok(buildBalancerV3QLLadder(op, amountIn).length > 0, "non-empty QL ladder from the live StableMath state");
    console.log(`  [bv3-prod-mirror] StableMath ladder == REAL query at ${pts.length} points, maxAbsDiff=${maxAbsDiff} wei`);
  });

  // ── (c) WEI-EXACT COOK (zero-cache) — cook == oracle == live query, both engines. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;
    // amountIn well within the deep ~$358k/$131k pool — the ladder quotes monotonically and the merge awards
    // the WHOLE Σ to this one venue (documented single-venue full-fill for this sizing).
    const amountIn = 100_000n * 10n ** BigInt(snaps.state.tokenInDecimals);
    const poolConfig = balancerV3PoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);

    // Production discovery → prepare → compile. NO prepared segments (BalV3 ships descriptor-only) — the ladder
    // is built ENTIRELY on-chain from live StableMath state (inherently zero-cache).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      target,
      caller,
      poolConfig,
      undefined,
      engine,
    );

    assert.equal(prepared.pools.length, 0, "lens surfaces no direct V2/V3/V4 pools (Balancer-V3-only config)");
    assert.equal((prepared.balancerV3Pools ?? []).length, 1, "discovered exactly the 1 reproduced Balancer V3 venue");
    const descr = prepared.balancerV3Pools![0];
    assert.equal(descr.address.toLowerCase(), etched.pool.toLowerCase(), "the discovered venue is the REAL etched pool");
    assert.equal(descr.router.toLowerCase(), etched.router.toLowerCase(), "venue carries the etched Router");
    assert.equal(descr.vault.toLowerCase(), etched.vault.toLowerCase(), "venue carries the CREATE2 Vault (cfg[10])");
    assert.ok(descr.rpIn !== ZERO && descr.rpOut !== ZERO, "discovery found both rate providers (getPoolTokenInfo)");
    assert.equal((prepared.brackets ?? []).length, 0, "NO static sampled segments — BalV3 is descriptor-only QL");

    // NEUTRAL ORACLE — one Balancer V3 venue seeded from the LIVE StableMath state via buildBalancerV3QLLadder
    // (the IDENTICAL ladder the on-chain solver builds). Pure off-chain math (before the cook), so the awarded Σ
    // is known ahead.
    const op = await liveOracle(descr);
    const optPools: OptimalPool[] = [{ balancerV3: op, feePpm: 0 }];
    const oracle = optimalSplit({ pools: optPools, amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the reproduced Balancer V3 venue");

    // The REAL Router's LIVE querySwap for the KNOWN awarded Σ — the engine-independent ground truth (an
    // off-chain cross-check; the exec passes minAmountOut=0 and the exactIn fill equals this view because the
    // block clock is pinned so the state is unchanged between this read and the cook).
    const onViewAwarded = await onQuery(awarded);

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const vaultInBefore = await balanceOf(c.publicClient, tokenIn, etched.vault);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the REAL Balancer V3 bytecode");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const vaultIn = (await balanceOf(c.publicClient, tokenIn, etched.vault)) - vaultInBefore;

    assert.ok(spent > 0n, "caller spends tokenIn");
    assert.ok(received > 0n, "caller receives tokenOut");
    // Balancer V3 folds its fee + rate scaling into the output; the Vault nets the FULL input via the Permit2 pull.
    assert.equal(vaultIn, spent, "REAL Balancer V3 Vault netted the FULL input (fee is folded into the output quote)");

    // WEI-EXACT: on-chain spend == the oracle's awarded input, to the WEI (the on-chain ladder == the oracle
    // ladder by construction — same StableMath, same live state).
    assert.equal(spent, awarded, "on-chain spent == neutral oracle awarded input (wei-exact)");
    assert.equal(spent, oracle.totalInput, "single venue: spent == oracle totalInput (wei-exact)");
    assert.equal(spent, amountIn, "single-venue full-fill: spent == amountIn (no unspent wei, no split)");

    // received == the REAL Router LIVE querySwap(spent) — the exact-in-dy cross-check (clock pinned ⇒ no accrual).
    assert.equal(received, onViewAwarded, "received == REAL Router LIVE querySwap(awarded Σ) (exact-in-dy)");
    const probe100k = snaps.state.probe.inToOut.find((p) => BigInt(p.amountIn) === amountIn);
    assert.ok(probe100k, "captured probe includes the 100k waUSDC size");
    assert.equal(received, BigInt(probe100k!.amountOut), "received == the CAPTURED mainnet querySwap(100k waUSDC) value to the wei");

    // RESIDUE SWEEP (the Metric USDT-class lesson) — BOTH Permit2 legs: the exec raw-approves
    // ERC20(tokenIn)→PERMIT2 for the awarded Σ (the USDT-class DoS surface: a residue there bricks the
    // next cook's nonzero→nonzero approve) and Permit2→ROUTER for uint160(Σ). The VERIFIED pull chain
    // consumes EXACTLY Σ (RouterCommon._takeTokenIn → permit2.transferFrom(sender, vault, amountIn) —
    // balancer-v3-monorepo; Permit2 decrements both its own allowance and the ERC20 one by the exact
    // transferred amount). Assert both residues are 0 on the GENUINE bytecode.
    const erc20Residue = (await c.publicClient.readContract({
      address: tokenIn, abi: parseAbi(["function allowance(address, address) view returns (uint256)"]) as Abi,
      functionName: "allowance", args: [target, etched.permit2],
    })) as bigint;
    assert.equal(erc20Residue, 0n, "no ERC20→Permit2 allowance residue on the REAL graph (pull == approve)");
    const p2Allow = (await c.publicClient.readContract({
      address: etched.permit2,
      abi: parseAbi(["function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]) as Abi,
      functionName: "allowance", args: [target, tokenIn, etched.router],
    })) as readonly [bigint, number, number];
    assert.equal(p2Allow[0], 0n, "no Permit2→Router allowance residue (the Router consumed exactly uint160(Σ))");

    const ms = Date.now() - t0;
    console.log(
      `  [bv3-prod-mirror:${engine}] WEI-EXACT vs neutral oracle — spent=${spent} received=${received} ` +
        `(oracle awarded=${awarded}, liveView=${onViewAwarded}); wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL Balancer V3 bytecode [${engine}] — wei-exact vs the neutral oracle, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
  }

  // ── (d) ADVERSE-DRIFT RE-ANCHOR — the money test for LIVE rate reads. ──
  async function runDrift(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;
    // A modest size (10k) so a small ladder-share is awarded and the drift's effect on the OUTPUT is clean.
    const amountIn = 10_000n * 10n ** BigInt(snaps.state.tokenInDecimals);
    const poolConfig = balancerV3PoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);

    // PREPARE + COMPILE at T0 (the on-chain solver reads state at cook, so the bytecode is state-independent —
    // it will re-anchor to whatever is live at cook).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      target,
      caller,
      poolConfig,
      undefined,
      engine,
    );
    const descr = prepared.balancerV3Pools![0];

    // The T0 oracle (snapshot) — what a STALE-rate solver would land.
    const opT0 = await liveOracle(descr);
    const oracleT0 = optimalSplit({ pools: [{ balancerV3: opT0, feePpm: 0 }], amountIn, zeroForOne: true });
    const awardedT0 = oracleT0.perPoolInput[0] ?? 0n;
    const receivedIfStale = balancerV3StableGetDy(opT0, awardedT0);

    // ADVERSE DRIFT: advance the clock ~120 days — the ERC4626 wrapper rates ACCRUE (both getRate() grow), so
    // the pool re-prices. (A pure LIVE-RATE drift — the strongest test that the rate is read at cook, not snapshotted.)
    await advanceClock(120n * 86400n);

    // The T1 oracle (rebuilt from the DRIFTED live state) — what a LIVE-rate solver must land.
    const opT1 = await liveOracle(descr);
    const oracleT1 = optimalSplit({ pools: [{ balancerV3: opT1, feePpm: 0 }], amountIn, zeroForOne: true });
    const awardedT1 = oracleT1.perPoolInput[0] ?? 0n;
    const onViewT1 = await onQuery(awardedT1);

    // Sanity: the drift genuinely moved the rates and thus the priced output.
    assert.ok(opT1.rateIn! !== opT0.rateIn! && opT1.rateOut! !== opT0.rateOut!, "both wrapper rates drifted");
    assert.notEqual(receivedIfStale, onViewT1, "drift moved the output (a stale-rate fill would differ)");

    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "drifted cook() must succeed against the REAL Balancer V3 bytecode");
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    // RE-ANCHOR: the fill tracked the DRIFTED live state — received == the T1 oracle == the REAL T1 querySwap,
    // and it is NOT the stale-T0 value. This proves the rate is read LIVE at cook (a snapshot would fail).
    assert.equal(received, onViewT1, "received == REAL querySwap at the DRIFTED (T1) state — re-anchored (exact-in-dy)");
    assert.equal(awardedT1, awardedT0, "single-venue full-fill: the awarded input is the whole trade at either state");
    assert.notEqual(received, receivedIfStale, "received != the stale-T0 fill — the LIVE rate read re-anchored the output");
    console.log(
      `  [bv3-prod-mirror:${engine}:drift] re-anchored: received=${received} (T1 query=${onViewT1}, ` +
        `stale-T0 would be=${receivedIfStale}); rateIn ${opT0.rateIn}->${opT1.rateIn}, rateOut ${opT0.rateOut}->${opT1.rateOut}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`ADVERSE-DRIFT re-anchor — LIVE wrapper-rate accrual between prepare and cook [${engine}]`, { skip }, async () => {
      await runDrift(engine);
    });
  }
});
