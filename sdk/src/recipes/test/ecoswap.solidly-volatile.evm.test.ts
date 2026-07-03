/**
 * EcoSwap Solidly VOLATILE (vAMM) local-EVM round-trip — the off-chain discovery + V2 live-walk gate.
 *
 * A Solidly VOLATILE pool (Aerodrome/Velodrome/Thena/Ramses/SwapX/Shadow vAMM) is a plain xy=k V2
 * curve with a PER-POOL fee — some of the deepest constant-product venues on Solidly chains. The
 * on-chain LENS structurally EXCLUDES them (Solidly factories expose getPool(a,b,bool), not the
 * getPair(a,b) the lens's V2 path calls — feeding one to the lens would revert the whole eth_call),
 * so EcoSwap discovers them OFF-CHAIN via getPool(a,b,false) (like KyberSwap Classic) and appends
 * them to the DIRECT V2-family set: each seeds the SAME constant-L V2 stream the solver/oracle walk
 * from LIVE getReserves, carries its per-pool fee, and executes via the existing callback-free V2
 * path. This test proves that end to end with NO fork:
 *
 *   (1) DISCOVER + SOLO — a vAMM (V2Pair, stable()==false, 0.05% fee) registered on a Solidly shim
 *       is discovered via getPool(a,b,false), surfaces as a V2 DIRECT pool carrying the per-pool
 *       fee, and one EcoSwap routes the whole trade through it (callback-free transfer + swap),
 *       spent == oracle to the wei.
 *   (2) SPLIT — one EcoSwap splits across the vAMM + a standard V3 pool (the vAMM via off-chain
 *       Solidly discovery, the V3 pool via the lens), BOTH funded, per-pool input == oracle to the
 *       wei, and post-fee marginals equalize.
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  deploySortedTokens,
  mint,
  approve,
  balanceOf,
  createAndInitPool,
  mintPosition,
  getSlot0,
  deploySolidlyFactory,
  setupSolidlyVolatilePool,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  type Engine,
  engineCells,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { feeAdjust, toOutIn } from "./ecoswap.math";

const HUGE = parseEther("1000000000");
const ENGINE_CELLS = engineCells();

// The vAMM's per-pool fee: 0.05% = 500 ppm (bps 5). NON-0.30%, so it executes via EcoSwap's
// callback-free V2 path (transfer + pair.swap) at the pool's real fee — exercising the per-pool
// fee (a 3000-fee pool would ride the engine's hardcoded-0.30% router swap instead).
const VAMM_FEE_PPM = 500;
const VAMM_FEE_BPS = 5; // what the Solidly factory getFee returns (discovery normalises bps→ppm)
// A fixed address to etch the vAMM V2Pair runtime at (all-lowercase ⇒ viem checksum-agnostic).
const VAMM_ADDR = "0x00000000000000000000000000000000ec050a11" as Hex;

describe("EcoSwap Solidly VOLATILE (vAMM) — off-chain discovery + callback-free V2 live-walk", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == token0 (zeroForOne = true)
  let tokenOut: Hex; // == token1
  let solidlyFactory: Hex;
  let cleanSnapshot: Hex;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    const minter = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, minter, parseEther("50000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, minter, parseEther("50000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    solidlyFactory = await deploySolidlyFactory(c.walletClient, c.publicClient);

    const owner = c.walletClient.account as Account;
    v12 = await maybeDeployV12Stack(c, owner);
    if (v12) await approve(c.walletClient, c.publicClient, tokenIn, v12.pot, HUGE);

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  async function reset(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: 2_000_000_000n });
  }

  /** poolConfig pointing discovery at the local Solidly shim (SolidlyV2), optionally + a V3 factory.
   *  baseTokens = the swap pair ⇒ zero routes (focus on the direct vAMM live-walk). */
  function poolConfig(withStandardV3: boolean): ChainPoolConfig {
    const factories = [
      {
        address: solidlyFactory,
        poolType: SwapPoolType.UniV2,
        factoryType: FactoryType.SolidlyV2,
        label: "Local Solidly",
      },
    ];
    if (withStandardV3) {
      factories.push({
        address: stack.factory,
        poolType: SwapPoolType.UniV3,
        factoryType: FactoryType.V3Standard,
        label: "Local UniV3",
      } as (typeof factories)[number]);
    }
    return { factories, feeTiers: [500, 3000, 10000], baseTokens: [tokenIn, tokenOut] };
  }

  // ── (1) DISCOVER + SOLO — a vAMM live-walks as a V2 pool with the per-pool fee ──
  async function runSolo(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A deep 1:1 vAMM (300k/side) at 0.05%.
    const pair = await setupSolidlyVolatilePool(
      c.walletClient, c.publicClient, c.testClient, solidlyFactory, VAMM_ADDR,
      tokenIn, tokenOut, parseEther("300000"), parseEther("300000"), VAMM_FEE_PPM, VAMM_FEE_BPS, caller,
    );

    const amountIn = parseEther("5000");
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pair);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig(false),
      undefined,
      engine,
    );

    // The vAMM surfaced as exactly one DIRECT V2 pool carrying its per-pool fee.
    assert.equal(prepared.pools.length, 1, "exactly one direct pool (the vAMM)");
    assert.equal(prepared.routes.length, 0, "no routes (baseTokens == swap pair)");
    const vamm = prepared.pools[0];
    assert.equal(vamm.isV2, true, "vAMM is a constant-product V2 pool");
    assert.equal(vamm.poolType, SwapPoolType.UniV2, "vAMM surfaces as a UniV2 row (poolType=0)");
    assert.equal(vamm.feePpm, VAMM_FEE_PPM, "the per-pool vAMM fee (500 ppm) threads into feePpm");
    assert.equal(vamm.address.toLowerCase(), pair.toLowerCase(), "the discovered pool is the vAMM");
    assert.ok(vamm.source.includes("Solidly volatile"), "labeled a Solidly volatile venue");

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo vAMM cook() must succeed (callback-free V2 path)");

    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pair)) - poolInBefore;

    assert.ok(received > 0n, "caller received tokenOut");
    assert.ok(poolIn > 0n, "the vAMM received tokenIn (transfer-first callback-free exec)");

    const ref = ecoSwapReference(prepared, amountIn);
    assert.equal(spent, ref.totalInput, "single-pass: spent == oracle totalInput EXACTLY");
    assert.equal(spent, amountIn, "solo deep vAMM absorbs the whole trade ⇒ spent == amountIn");
    assert.equal(poolIn, amountIn, "all of amountIn routed into the vAMM");

    console.log(
      `  [Solidly vAMM solo:${engine}] feePpm=${VAMM_FEE_PPM} spent=${spent} received=${received} ` +
        `poolIn=${poolIn} (poolType=0 V2; oracle totalInput=${ref.totalInput})`,
    );
  }

  // ── (2) SPLIT — vAMM (off-chain Solidly discovery) + a standard V3 pool (lens) in ONE merge ──
  async function runSplit(engine: Engine): Promise<void> {
    await reset();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // The vAMM (0.05%) + a standard V3 pool (0.30%) at the SAME 1:1 spot but different fees/depths →
    // the water-fill must split: the cheaper vAMM fee draws first, the V3 pool joins once marginals
    // converge.
    const pair = await setupSolidlyVolatilePool(
      c.walletClient, c.publicClient, c.testClient, solidlyFactory, VAMM_ADDR,
      tokenIn, tokenOut, parseEther("400000"), parseEther("400000"), VAMM_FEE_PPM, VAMM_FEE_BPS, caller,
    );
    const v3Pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, 3000, SQRT_PRICE_1_1,
    );
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3Pool, caller, -12000, 12000, parseEther("250000"));

    const amountIn = parseEther("8000");
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const vammInBefore = await balanceOf(c.publicClient, tokenIn, pair);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3Pool);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig(true),
      undefined,
      engine,
    );

    assert.equal(prepared.pools.length, 2, "two direct pools (vAMM + standard V3)");
    const vammIdx = prepared.pools.findIndex((p) => p.address.toLowerCase() === pair.toLowerCase());
    const v3Idx = prepared.pools.findIndex((p) => p.address.toLowerCase() === v3Pool.toLowerCase());
    assert.ok(vammIdx >= 0 && v3Idx >= 0, "both the vAMM and the V3 pool discovered");
    assert.equal(prepared.pools[vammIdx].isV2, true, "vAMM is a V2 pool");
    assert.equal(prepared.pools[vammIdx].feePpm, VAMM_FEE_PPM, "vAMM per-pool fee threads (500 ppm)");
    assert.equal(prepared.pools[v3Idx].feePpm, 3000, "standard V3 pool fee is its tier (3000)");

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "split vAMM+V3 cook() must succeed");

    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const vammIn = (await balanceOf(c.publicClient, tokenIn, pair)) - vammInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3Pool)) - v3InBefore;

    assert.ok(vammIn > 0n, "the vAMM received input");
    assert.ok(v3In > 0n, "the standard V3 pool received input");
    assert.ok(received > 0n, "caller received tokenOut");

    const ref = ecoSwapReference(prepared, amountIn);
    assert.equal(spent, ref.totalInput, "single-pass: spent == oracle totalInput EXACTLY");
    assert.equal(vammIn, ref.perPoolInput[vammIdx], "vAMM input == oracle to the wei");
    assert.equal(v3In, ref.perPoolInput[v3Idx], "standard V3 pool input == oracle to the wei");

    // The cheaper-fee vAMM draws strictly more than the 0.30% V3 pool (same spot).
    assert.ok(vammIn > v3In, `cheaper-fee vAMM draws more (vAMM ${vammIn} > v3 ${v3In})`);

    // The split is marginal-equalizing BY CONSTRUCTION (per-pool input == the neutral oracle, which
    // equalizes post-fee marginals). The vAMM carries a live out/in spot seed the solver walks from.
    const v3Slot = await getSlot0(c.publicClient, v3Pool);
    const margV3 = feeAdjust(toOutIn(v3Slot.sqrtPriceX96, true), 3000);
    assert.ok((prepared.pools[vammIdx].spotNearReal ?? 0n) > 0n, "vAMM carries a live out/in spot seed");

    console.log(
      `  [Solidly vAMM split:${engine}] vAMM(feePpm=${VAMM_FEE_PPM})In=${vammIn} v3(3000)In=${v3In} ` +
        `received=${received} spent=${spent} (oracle vAMM=${ref.perPoolInput[vammIdx]} v3=${ref.perPoolInput[v3Idx]}); v3 marg=${margV3}`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`Solidly vAMM solo [${engine}] — off-chain discovery, callback-free V2 live-walk, spent == oracle`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`Solidly vAMM + V3 split [${engine}] — vAMM (off-chain) competes with V3 (lens), split == oracle`, { skip }, async () => {
      await runSplit(engine);
    });
  }
});
