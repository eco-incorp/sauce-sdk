/**
 * EcoSwap Balancer V3 (balancer/balancer-v3-monorepo — Vault singleton + per-chain Router) local-EVM
 * integration of the on-chain StableMath QUOTE-LADDER (segKind 14) + the callback-free Permit2 exec.
 *
 * FIXTURE-GAP NOTE (documented scope). Balancer V3 was migrated from a static off-chain-sampled segment source
 * to a LIVE-WALK QL venue: the on-chain solver now reads the LIVE Vault StableMath state (getCurrentLiveBalances
 * / getAmplificationParameter / getStaticSwapFeePercentage + each token's rateProvider.getRate) and REPLAYS the
 * amplified StableSwap invariant on-chain to build its price ladder. The local `BalancerV3.sol` fixture is a
 * CONSTANT-PRODUCT stub (a convex query proxy) with NO StableMath state surface — it exposes no
 * getCurrentLiveBalances / amp / static-fee / rate-provider getters — so it CANNOT exercise the migrated QL
 * path. Rather than rewrite that fixture into a full StableSwap replica (a fourth copy of the math, high risk of
 * a subtly-wrong fixture masking or false-failing), this test runs the REAL etched Base graph (the same whole-
 * graph etch the prod-mirror uses — REAL bytecode, real rate-scaled ERC4626 wrappers, seconds to stand up, NO
 * fork/RPC). The prod-mirror file is the primary wei-exactness + adverse-drift validation; THIS file is the
 * fast local-EVM INTEGRATION of the production discovery → prepare → compile → cook path across sizes, plus the
 * treeshake regression. (The constant-product stub is retained in fixtures/ only for reference / any future
 * exec-surface-only test.)
 *
 * Asserts, on BOTH engines (v1 + v12, ECO_ENGINE):
 *   (1) DISCOVERY — the production FactoryType.BalancerV3 path surfaces the venue as a QL DESCRIPTOR: pool +
 *       in/out Vault indices + BOTH rate providers (via getPoolTokenInfo) + const decimal scales + the CREATE2
 *       Vault, and ships NO static segments (brackets == []).
 *   (2) MULTI-SIZE WEI-EXACT — for several trade sizes, the caller-received tokenOut == the neutral oracle
 *       (optimalSplit over buildBalancerV3QLLadder off the LIVE state) == the REAL Router's LIVE querySwap of
 *       the awarded slice, all to the wei. Exercises the ladder differencing / head / emit across slice counts.
 *   (3) TREESHAKE — a Balancer-V3-only universe compiles (treeshake:true) with HAS_BALANCER_V3 as the ONLY live
 *       segment/QL flag; the cook lands a NON-ZERO fill, guarding that HAS_BALANCER_V3 is wired across the guard
 *       QUADRUPLE (the qlv outer guard + the per-venue live-state read + the qlv compute branch + the accumulate
 *       + the exec) — else the QL ladder is dead under treeshake and the swap lands ZERO (the Balancer-class bug).
 *
 * Callback-free exec UNCHANGED: the Permit2 two-step (ERC20.approve(PERMIT2) + Permit2.approve(ROUTER)) +
 * Router.swapSingleTokenExactIn (the V3 input is PULLED via Permit2; the reentrancy is contained inside
 * Balancer's Router+Vault, never the cooking contract).
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
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
import { type BalancerV3Pool } from "../shared/balancer-v3-math";

const SNAP_NAME = "base-balancerv3-waUSDCwaGHO";
const ENGINE_CELLS = engineCells();
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

describe("EcoSwap Balancer V3 (on-chain StableMath QL, real etched graph) — discovery + multi-size wei-exact + treeshake", () => {
  const snaps = loadBalancerV3Snapshots(SNAP_NAME);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedBalancerV3Graph;

  async function setup(): Promise<void> {
    const prev = anvil;
    prev?.stop();
    await prev?.stopped;
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
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

  function balancerV3PoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.vault,
          poolType: SwapPoolType.UniV2, // inert for Balancer V3 — discovery keys off factoryType
          factoryType: FactoryType.BalancerV3,
          label: "Local Balancer V3 (etched real graph)",
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

  /** Neutral-oracle BalancerV3Pool from the LIVE Vault StableMath state (the SAME state the solver reads
   *  on-chain) + the discovered descriptor (indices / rate providers / const decimal scales). */
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
      source: "etched",
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

  // ── (1) DISCOVERY — the QL descriptor is fully populated + NO static segments. ──
  it("discovers the Balancer V3 venue as a QL descriptor (rate providers, vault, decimal scales) + no segments", async () => {
    await setup();
    const amountIn = 10_000n * 10n ** BigInt(snaps.state.tokenInDecimals);
    const { prepared } = await ecoSwap(
      { tokenIn: etched.tokenIn, tokenOut: etched.tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget("v1", stack, v12),
      c.account0,
      balancerV3PoolConfig(etched.tokenIn, etched.tokenOut),
    );
    assert.equal((prepared.balancerV3Pools ?? []).length, 1, "discovered exactly the 1 etched Balancer V3 venue");
    const d = prepared.balancerV3Pools![0];
    assert.equal(d.address.toLowerCase(), etched.pool.toLowerCase(), "descriptor pool == the etched pool");
    assert.equal(d.router.toLowerCase(), etched.router.toLowerCase(), "descriptor carries the etched Router");
    assert.equal(d.vault.toLowerCase(), etched.vault.toLowerCase(), "descriptor carries the CREATE2 Vault (cfg[10])");
    assert.ok(d.rpIn !== ZERO && d.rpOut !== ZERO, "both rate providers discovered via getPoolTokenInfo");
    assert.notEqual(d.inIdx, d.outIdx, "in/out Vault indices are distinct");
    // waUSDC 6d → decScaleIn = 1e12; waGHO 18d → decScaleOut = 1.
    assert.equal(d.decScaleIn, 10n ** BigInt(18 - snaps.state.tokenInDecimals), "decScaleIn = 10^(18-decIn)");
    assert.equal(d.decScaleOut, 10n ** BigInt(18 - snaps.state.tokenOutDecimals), "decScaleOut = 10^(18-decOut)");
    assert.equal((prepared.brackets ?? []).length, 0, "NO static sampled segments — BalV3 is descriptor-only QL");
    console.log(
      `  [BalancerV3 discovery] pool=${d.address} vault=${d.vault} rpIn=${d.rpIn} rpOut=${d.rpOut} ` +
        `inIdx=${d.inIdx} outIdx=${d.outIdx} decScaleIn=${d.decScaleIn} decScaleOut=${d.decScaleOut}`,
    );
  });

  // ── (2) MULTI-SIZE WEI-EXACT — the QL ladder differencing across slice counts, both engines. ──
  const SIZES = [10_000n, 50_000n, 100_000n];
  async function runSize(engine: Engine, sizeUnits: bigint): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;
    const amountIn = sizeUnits * 10n ** BigInt(snaps.state.tokenInDecimals);
    const poolConfig = balancerV3PoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);

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
    const op = await liveOracle(descr);
    const oracle = optimalSplit({ pools: [{ balancerV3: op, feePpm: 0 }] as OptimalPool[], amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the venue");
    const onViewAwarded = await onQuery(awarded);

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    // Pin the cook's block clock to the SAME fixed timestamp onQuery read (the latest mined block sits at
    // snaps.state.blockTimestamp from the setup pin, and eth_call reads that block's ts). Without this the
    // cook mines a NEW block stamped with the drifted wall clock (real seconds elapse during ecoSwap compile),
    // so the ERC4626 wrapper rate accrues between the query and the cook — a sub-second drift that only exceeds
    // wei-equality at the largest size. Pinning both to the same ts keeps received == LIVE query wei-exact.
    await c.testClient.request({ method: "anvil_setTime", params: [Number(snaps.state.blockTimestamp)] });
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() succeeds against the REAL Balancer V3 bytecode");
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(spent > 0n && received > 0n, "non-zero fill");
    assert.equal(spent, awarded, "spent == oracle awarded input (wei-exact)");
    assert.equal(received, onViewAwarded, "received == REAL Router LIVE querySwap(awarded) (exact-in-dy)");
    // RESIDUE SWEEP (the Metric USDT-class lesson) — BOTH Permit2 legs consumed exactly (the Router's
    // _takeTokenIn pulls exactly amountIn via Permit2, which decrements the ERC20 allowance in lockstep).
    const erc20Residue = (await c.publicClient.readContract({
      address: tokenIn, abi: parseAbi(["function allowance(address, address) view returns (uint256)"]) as Abi,
      functionName: "allowance", args: [target, etched.permit2],
    })) as bigint;
    assert.equal(erc20Residue, 0n, "no ERC20→Permit2 allowance residue (pull == approve)");
    const p2Allow = (await c.publicClient.readContract({
      address: etched.permit2,
      abi: parseAbi(["function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]) as Abi,
      functionName: "allowance", args: [target, tokenIn, etched.router],
    })) as readonly [bigint, number, number];
    assert.equal(p2Allow[0], 0n, "no Permit2→Router allowance residue (exact uint160(Σ) consumption)");
    console.log(`  [BalancerV3 size:${engine}:${sizeUnits}k] spent=${spent} received=${received} (wei-exact vs oracle+query; residue 0)`);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    for (const s of SIZES) {
      it(`BalancerV3 QL [${engine}] size ${s}k — received == oracle == LIVE query to the wei`, { skip }, async () => {
        await runSize(engine, s);
      });
    }
  }

  // ── (3) TREESHAKE — a Balancer-V3-only universe treeshakes to HAS_BALANCER_V3 only + lands a non-zero fill. ──
  async function runTreeshake(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const tokenIn = etched.tokenIn;
    const tokenOut = etched.tokenOut;
    const amountIn = 25_000n * 10n ** BigInt(snaps.state.tokenInDecimals);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);

    // The production ecoSwap() compiles with treeshake:true + protocolDefines(prepared); for a Balancer-V3-only
    // universe that is HAS_BALANCER_V3 as the ONLY live segment/QL flag (every other HAS_* folds away). So this
    // cook IS the treeshake regression: if HAS_BALANCER_V3 were not wired across the qlv guard / per-venue
    // live-state read / compute branch / accumulate / exec, the ladder would be dead under treeshake and the
    // fill would be ZERO.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      target,
      caller,
      balancerV3PoolConfig(tokenIn, tokenOut),
      undefined,
      engine,
    );
    assert.equal(prepared.pools.length, 0, "Balancer-V3-only universe (no direct V2/V3/V4 pools)");
    assert.equal((prepared.balancerV3Pools ?? []).length, 1, "one QL venue");
    const op = await liveOracle(prepared.balancerV3Pools![0]);
    const oracle = optimalSplit({ pools: [{ balancerV3: op, feePpm: 0 }] as OptimalPool[], amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    // Ground-truth query for the awarded share BEFORE the cook (the cook is a real swap that moves the pool).
    const onViewAwarded = await onQuery(awarded);

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    // Pin the cook clock to the fixed snapshot ts (same reason as runSize) so the wrapper rate does not
    // accrue between onQuery and the cook.
    await c.testClient.request({ method: "anvil_setTime", params: [Number(snaps.state.blockTimestamp)] });
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "treeshaken Balancer-V3-only cook() must succeed");
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(spent > 0n, "treeshaken Balancer-V3-only: NON-ZERO fill (guard quadruple alive)");
    assert.equal(spent, awarded, "treeshaken spent == oracle awarded (wei-exact)");
    assert.equal(received, onViewAwarded, "treeshaken received == LIVE query(share) to the wei");
    console.log(`  [BalancerV3 treeshake:${engine}] spent=${spent} received=${received} (HAS_BALANCER_V3-only define set)`);
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`BalancerV3 treeshake [${engine}] — Balancer-V3-only define set lands a non-zero QL fill`, { skip }, async () => {
      await runTreeshake(engine);
    });
  }
});
