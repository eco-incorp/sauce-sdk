/**
 * EcoSwap Fluid DEX (Instadapp fluid-contracts-public FluidDexT1 — a Liquidity-Layer-backed re-centering
 * AMM) PROD-MIRROR — REAL BYTECODE, NO FORK, OFFLINE.
 *
 * The Fluid analogue of ecoswap.wombat.prodmirror.evm.test.ts / ecoswap.dodo.prodmirror.evm.test.ts.
 * Unlike ecoswap.fluid.evm.test.ts (which deploys a MOCK FluidDexPool.sol fixture), this test stands up
 * the GENUINE FluidDexT1 pool + its WHOLE quote/swap contract graph captured from Ethereum mainnet and
 * runs the swap against it — proving the production discovery + execution path works on the real
 * contracts, with NO fork and NO RPC at run time (etch + setStorageAt, seconds).
 *
 * MECHANISM (mirrors the repo's Uniswap-V4 real-runtime etch, generalised in harness/etch-pool.ts):
 *   CAPTURE (one-time, harness/fluid-snapshot.ts, uses the RPC key):
 *     the wired FactoryType.Fluid target on Ethereum — the DEEPEST on-charter STABLE-pair FluidDexT1 pool
 *     (USDC/USDT DexT1 0x6677…, constants.ts fluidPools[0]) — has NO closed-form curve: its price comes
 *     from the SHARED Liquidity-Layer supply/borrow exchange prices + a re-centering center price + caps,
 *     across a MULTI-CONTRACT graph. We eth_getCode the pool + the periphery DexResolver (0x11D8…) + the
 *     Liquidity InfiniteProxy (0x52Aa…) + its two dispatch modules (operate 0x4bDC…, secondary 0x4350…)
 *     into fixtures/snapshots/ethereum-fluid-USDCUSDT.bytecode.json (WITH sha256 anchors), and the
 *     swap-relevant STATE (the pool's low slots + the Liquidity proxy's touched slots — the operate()
 *     sig→module dispatch entry + the packed exchange-price/supply-borrow/center-price slots — captured by
 *     ABSOLUTE key, + the real Liquidity reserves + a bidirectional estimateSwapIn probe ladder) into
 *     .state.json. Block pinned (25441755). The estimate is bit-exact with a REAL swapIn (verified on the
 *     pinned fork). No key/url is ever persisted.
 *   ETCH (this test, OFFLINE): boot a plain anvil (NO fork); setCode the REAL pool + resolver + Liquidity
 *     proxy + both modules at their captured addresses; setStorageAt the captured pool + Liquidity storage
 *     VERBATIM by absolute key; etch a local MintableERC20 AT EACH REAL token address (token0/token1 are
 *     pool IMMUTABLES — the V4 StateView→PoolManager immutable-address class), funding the etched Liquidity
 *     proxy with the captured reserves; then PIN block.timestamp to storedTs + a few seconds
 *     (pinFluidBlockTimestamp — Fluid accrual underflows at delta 0 and drifts at a large delta). The swap
 *     then runs the GENUINE graph: resolver.estimateSwapIn returns the mainnet-identical dy and pool.swapIn
 *     PULLS via safeTransferFrom + pays out through the Liquidity layer.
 *
 * CENTRAL VERIFICATION (this file asserts all three explicitly):
 *   (a) REAL bytecode — eth_getCode at the pool + resolver + Liquidity proxy + BOTH modules in the test ==
 *       the captured real runtime, byte-for-byte (a NO-RPC sha256 tripwire proves the checked-in blobs are
 *       intact). No mock FluidDexPool.sol is in the swap path (the addresses are the captured mainnet
 *       addresses, running captured code). The REAL resolver.getDexTokens orients the pair off the pool's
 *       immutables, and resolver.estimateSwapIn reproduces the captured probe ladder to the WEI, both
 *       directions.
 *   (b) FAST + OFFLINE — no fork, no RPC at run time; per-engine wall-clock logged (seconds).
 *   (c) WEI-EXACT — the caller-received tokenOut == the neutral oracle (ecoswap.optimal.ts optimalSplit,
 *       seeded from the REAL etched resolver's LIVE estimateSwapIn ladder via the SHARED buildFluidSegments,
 *       the identical grid discoverFluidPoolsTyped samples) == the REAL pool's OWN LIVE estimateSwapIn view
 *       of the awarded slice, all to the wei. spent == the awarded Σ is asserted explicitly.
 *
 * HONEST fidelity — SNAPSHOTTED-QUOTE (Class-A, exogenous residual), the SAME class the recipe documents
 * for Fluid: the split is priced off the LIVE estimateSwapIn ladder sampled at prepare (a SNAPSHOT of the
 * layer's exchange prices + center price + caps), so it is EXACT-ON-GRID vs the oracle (both segment the
 * SAME sampled ladder off the SAME etched resolver at the SAME pinned block); per-pool EXECUTION re-reads
 * the out via the LIVE estimateSwapIn view (used as amountOutMin), so the realized out equals the live
 * estimate for the awarded share to the wei. Because block.timestamp is PINNED (pinFluidBlockTimestamp) the
 * layer prices do NOT accrue between prepare and cook here, so the snapshot ladder == the live view and the
 * fill is exact-on-grid AND exact-in-dy — the strongest form. Fluid folds its fee + cap into the resolver
 * quote (there is no separate fee getter), and the pool nets the FULL tokenIn into the Liquidity layer, so
 * poolIn (== the Liquidity-layer tokenIn delta) == spent is asserted explicitly.
 *
 * SINGLE-VENUE FULL-FILL is the documented expectation for this sizing (amountIn == the full sampled
 * ladder cap, one Fluid venue, the segment ladder covers [0, amountIn] since the deep ~$15M/$11M reserves
 * quote monotonically) — so the whole trade allocates to this one pool and spent == amountIn.
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE (default v12; skip-by-default for v12 when the artifacts are
 * absent). No state cache — etch+setStorage is a few seconds.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.fluid.prodmirror.evm.test.ts
 *      ECO_ENGINE=both pnpm --filter './sdk' test:recipes:evm
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  mint,
  approve,
  balanceOf,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  etchFluidPool,
  loadFluidSnapshots,
  verifyFluidBytecodeIntegrity,
  pinFluidBlockTimestamp,
  fluidPoolReadAbi,
  fluidResolverReadAbi,
  type EtchedFluidPool,
} from "./harness/etch-pool";
import {
  type Engine,
  engineCells,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { EcoBracketKind } from "../shared/types";
import { ecoSwap } from "../ecoswap/index";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { buildFluidSegments, fluidSampleInputs, type FluidPool } from "../shared/fluid-math";

const SNAP_NAME = "ethereum-fluid-USDCUSDT";
const ENGINE_CELLS = engineCells();

describe("EcoSwap Fluid DEX (Instadapp FluidDexT1) prod-mirror — REAL bytecode, no fork, offline", () => {
  const snaps = loadFluidSnapshots(SNAP_NAME);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedFluidPool;

  // Boot a fresh anvil + etch the real pool graph + deploy the engine, then PIN the block clock (Fluid
  // accrual — see harness header). Called before each cell so each engine runs in full isolation (cheap:
  // the whole setup is etch + setStorageAt + a handful of deploys, seconds not minutes).
  async function setup(): Promise<void> {
    const prev = anvil;
    prev?.stop();
    await prev?.stopped;
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    // Caller headroom in token0 (USDC, the swap0to1 direction) — 2x the trade sizing below.
    etched = await etchFluidPool(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: 200_000n * 10n ** BigInt(snaps.state.token0Decimals),
    });
    // PIN block.timestamp to storedTs + a few seconds — the ONLY window Fluid's exchange-price accrual is
    // both non-underflowing AND below the accrual rounding quantum (bit-exact with the captured probe).
    await pinFluidBlockTimestamp(c.testClient, snaps.state);
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** A poolConfig with ONLY a Fluid factory carrying the reproduced pool + resolver → the production
   *  FactoryType.Fluid discovery path resolves the etched pool via the resolver's getDexTokens +
   *  estimateSwapIn; the lens ignores non-V2/V3/V4 factory types, so no direct pools are surfaced and the
   *  Fluid venue rides entirely through discoverFluidPoolsTyped. (No factory shim is needed — discovery
   *  reads the config-carried resolver + the fluidPools list directly.) The `address`/`poolType` are inert
   *  placeholders (discovery keys off factoryType). */
  function fluidPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.pool,
          poolType: SwapPoolType.UniV2, // inert for Fluid — discovery keys off factoryType
          factoryType: FactoryType.Fluid,
          label: "Local Fluid DEX (prod-mirror)",
          fluidResolver: etched.resolver,
          fluidPools: [etched.pool],
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  // The resolver's own on-chain estimateSwapIn view — the engine-independent ground truth for the executed
  // dy (swap0to1 = true since tokenIn == token0). amountOutMin 0 ⇒ pure quote.
  async function onQuery(amt: bigint): Promise<bigint> {
    return (await c.publicClient.readContract({
      address: etched.resolver, abi: fluidResolverReadAbi, functionName: "estimateSwapIn",
      args: [etched.pool, true, amt, 0n],
    })) as bigint;
  }

  /** The neutral oracle's FluidPool descriptor — sample the REAL etched resolver's LIVE estimateSwapIn
   *  ladder over [0, amountIn] on the SAME grid discoverFluidPoolsTyped uses (fluidSampleInputs). Since the
   *  oracle and prepare sample the IDENTICAL grid off the IDENTICAL etched resolver at the SAME pinned
   *  block, they produce identical segments ⇒ the split is exact-on-grid vs the oracle by construction. */
  async function offPool(amountIn: bigint): Promise<FluidPool> {
    const cumIn = fluidSampleInputs(amountIn);
    const cumOut: bigint[] = [];
    for (const amt of cumIn) cumOut.push(await onQuery(amt));
    return {
      address: etched.pool,
      resolver: etched.resolver,
      swap0to1: true,
      tokenIn: etched.token0,
      tokenOut: etched.token1,
      cumIn,
      cumOut,
      feePpm: 0,
      source: "prod-mirror",
    };
  }

  // ── (a) REAL BYTECODE — the etched code IS the captured mainnet runtime, byte-for-byte. ──
  it("etches the REAL Fluid pool + resolver + Liquidity graph bytecode (byte-equal) + reproduces the captured quotes", async () => {
    // NO-NETWORK integrity tripwire FIRST: the checked-in runtime blobs still hash to the sha256 anchors
    // recorded at capture time (byte-equal to the pinned-block on-chain code). A reviewer without the RPC
    // key can run this — it proves the snapshot wasn't silently altered after capture, with NO RPC.
    const integ = verifyFluidBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.pool.ok, `pool runtime sha256 matches the capture anchor (got ${integ.pool.actual})`);
    assert.ok(snaps.bytecode.pool.runtimeSha256, "pool snapshot carries a sha256 integrity anchor");
    const expectedDeps = ["resolver", "liquidity", "liquidityOperateModule", "liquiditySecondaryModule"];
    assert.equal(integ.dependencies.length, expectedDeps.length, "all 4 dependency runtimes present in the snapshot");
    for (const name of expectedDeps) {
      const d = integ.dependencies.find((x) => x.name === name);
      assert.ok(d, `dependency ${name} present in the bytecode snapshot`);
      assert.ok(d!.ok, `dependency ${name} runtime sha256 matches the capture anchor (got ${d!.actual})`);
    }

    // getCode at the pool + EVERY dependency must EQUAL the captured real runtime (no mock in the path).
    const poolCode = await c.publicClient.getCode({ address: etched.pool });
    assert.ok(poolCode, "pool has code");
    assert.equal(
      poolCode!.toLowerCase(),
      snaps.bytecode.pool.runtime.toLowerCase(),
      "eth_getCode at the pool == the captured REAL FluidDexT1 runtime (byte-equal)",
    );
    assert.equal(etched.pool.toLowerCase(), snaps.bytecode.pool.address.toLowerCase(), "pool at captured mainnet address");
    for (const dep of snaps.bytecode.dependencies ?? []) {
      const code = await c.publicClient.getCode({ address: dep.address });
      assert.ok(code, `dependency ${dep.name} has code`);
      assert.equal(
        code!.toLowerCase(),
        dep.runtime.toLowerCase(),
        `eth_getCode at ${dep.name} (${dep.address}) == the captured REAL runtime (byte-equal)`,
      );
    }

    // The REAL pool immutables (token0/token1 baked in the runtime, read via constantsView()'s struct)
    // resolve to the LOCAL tokens etched at the real addresses, and the Liquidity/module map matches.
    const cv = (await c.publicClient.readContract({
      address: etched.pool, abi: fluidPoolReadAbi, functionName: "constantsView",
    })) as readonly unknown[];
    const cvToken0 = (cv[9] as Hex).toLowerCase();
    const cvToken1 = (cv[10] as Hex).toLowerCase();
    const cvLiquidity = (cv[1] as Hex).toLowerCase();
    assert.equal(cvToken0, etched.token0.toLowerCase(), "constantsView token0 == the etched local token0 (real USDC address)");
    assert.equal(cvToken1, etched.token1.toLowerCase(), "constantsView token1 == the etched local token1 (real USDT address)");
    assert.equal(cvLiquidity, etched.liquidity.toLowerCase(), "constantsView liquidity == the etched Liquidity proxy address");

    // The REAL resolver.getDexTokens orients the pair off the pool's immutables.
    const [t0, t1] = (await c.publicClient.readContract({
      address: etched.resolver, abi: fluidResolverReadAbi, functionName: "getDexTokens", args: [etched.pool],
    })) as [Hex, Hex];
    assert.equal(t0.toLowerCase(), etched.token0.toLowerCase(), "resolver.getDexTokens token0 == the etched local token0");
    assert.equal(t1.toLowerCase(), etched.token1.toLowerCase(), "resolver.getDexTokens token1 == the etched local token1");

    // The REAL resolver.estimateSwapIn reproduces the captured probe ladder to the WEI, BOTH directions
    // (the exchange-price/center-price integral over the reconstructed Liquidity-layer state).
    for (const p of snaps.state.probe.swap0to1) {
      const got = (await c.publicClient.readContract({
        address: etched.resolver, abi: fluidResolverReadAbi, functionName: "estimateSwapIn",
        args: [etched.pool, true, BigInt(p.amountIn), 0n],
      })) as bigint;
      assert.equal(got, BigInt(p.amountOut), `REAL estimateSwapIn(0to1, ${p.amountIn}) == captured mainnet value`);
    }
    for (const p of snaps.state.probe.swap1to0) {
      const got = (await c.publicClient.readContract({
        address: etched.resolver, abi: fluidResolverReadAbi, functionName: "estimateSwapIn",
        args: [etched.pool, false, BigInt(p.amountIn), 0n],
      })) as bigint;
      assert.equal(got, BigInt(p.amountOut), `REAL estimateSwapIn(1to0, ${p.amountIn}) == captured mainnet value`);
    }

    console.log(
      `  [fluid-prod-mirror] REAL bytecode etched: pool ${etched.pool} (${(poolCode!.length - 2) / 2} B) + ` +
        `${(snaps.bytecode.dependencies ?? []).map((d) => `${d.name} ${(d.runtime.length - 2) / 2}B`).join(" + ")}; ` +
        `captured block ${snaps.state.block}; reserves ${etched.reserve0}/${etched.reserve1}; ` +
        `${snaps.state.token0Symbol}/${snaps.state.token1Symbol}`,
    );
  });

  // ── (b)+(c) FAST/OFFLINE run through the production discovery path, wei-exact vs the oracle. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // Swap token0 → token1 (USDC → USDT, the captured probe direction): tokenIn = token0, tokenOut = token1.
    const tokenIn = etched.token0;
    const tokenOut = etched.token1;

    // amountIn == the full sampled ladder cap (100k USDC) — well within the deep ~$15M/$11M Liquidity-layer
    // reserves, so the ladder quotes monotonically and the merge awards the WHOLE Σ to this one venue.
    const amountIn = 100_000n * 10n ** BigInt(snaps.state.token0Decimals);
    const poolConfig = fluidPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn); // ensure headroom

    // Run EcoSwap through the PRODUCTION FactoryType.Fluid discovery path (samples the etched resolver).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig,
      undefined,
      engine,
    );

    // Discovery surfaced exactly the ONE reproduced Fluid venue (via the real resolver getters).
    assert.equal(prepared.pools.length, 0, "lens surfaces no direct V2/V3/V4 pools (Fluid-only config)");
    assert.equal((prepared.fluidPools ?? []).length, 1, "discovered exactly the 1 reproduced Fluid venue");
    assert.equal(
      prepared.fluidPools![0].address.toLowerCase(),
      etched.pool.toLowerCase(),
      "the discovered Fluid venue is the REAL etched pool",
    );
    assert.equal(prepared.fluidPools![0].swap0to1, true, "discovery oriented the venue as swap0to1 (tokenIn == token0)");
    assert.ok(
      (prepared.brackets ?? []).some((b) => b.kind === EcoBracketKind.Fluid),
      "Fluid segments present",
    );

    // NEUTRAL ORACLE (ecoswap.optimal.ts) — one Fluid venue seeded from the REAL etched resolver's LIVE
    // estimateSwapIn ladder via the SHARED buildFluidSegments (the identical grid discoverFluidPoolsTyped
    // sampled). Pure off-chain math (computed BEFORE the cook), so the awarded Σ is known ahead — and the
    // engine's static-segment cursor consumes the IDENTICAL grid, so on-chain spent == oracle.totalInput.
    const op = await offPool(amountIn);
    assert.ok(buildFluidSegments(op, amountIn).length > 0, "non-empty Fluid segment ladder from the live etched resolver");
    const optPools: OptimalPool[] = [{ fluid: op, feePpm: 0 }];
    const oracle = optimalSplit({ pools: optPools, amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the reproduced Fluid venue");

    // The REAL resolver's OWN LIVE estimateSwapIn view for the KNOWN awarded Σ — the engine-independent
    // ground truth for the executed dy of the awarded slice (Fluid re-reads this LIVE view at exec). The
    // block clock is PINNED, so the layer prices do NOT accrue between this read and the cook.
    const onViewAwarded = await onQuery(awarded);

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    // Fluid PULLS the tokenIn via safeTransferFrom into the shared Liquidity layer (NOT the pool) — measure
    // the Liquidity-layer tokenIn delta for the "netted the full input" check.
    const liqInBefore = await balanceOf(c.publicClient, tokenIn, etched.liquidity);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the REAL Fluid bytecode");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const liqIn = (await balanceOf(c.publicClient, tokenIn, etched.liquidity)) - liqInBefore;

    assert.ok(spent > 0n, "caller spends tokenIn");
    assert.ok(received > 0n, "caller receives tokenOut");
    // HONEST fee accounting: Fluid folds its fee + cap into the resolver quote (no separate fee getter) and
    // the pool nets the FULL tokenIn into the Liquidity layer — the fee shows up as a smaller tokenOut, not
    // a smaller input. Assert the Liquidity layer received exactly what was spent.
    assert.equal(liqIn, spent, "REAL Fluid Liquidity layer netted the FULL input (fee is folded into the output quote)");

    // WEI-EXACT: the on-chain spend == the oracle's awarded input to the WEI. NO tolerance. (The Fluid
    // ladder is sampled to cover [0, amountIn]; the deep monotonic reserves ⇒ the merge awards the whole Σ,
    // and the engine's static-segment cursor consumes the IDENTICAL grid ⇒ spent == oracle.totalInput.)
    assert.equal(spent, awarded, "on-chain spent == neutral oracle awarded input (wei-exact-on-grid)");
    assert.equal(spent, oracle.totalInput, "single venue: spent == oracle totalInput (wei-exact-on-grid)");
    // SINGLE-VENUE FULL-FILL (documented for this sizing — amountIn == the ladder cap, one deep venue, the
    // segment ladder covers [0, amountIn]): the whole trade allocates to this one pool. Assert explicitly.
    assert.equal(spent, amountIn, "single-venue full-fill: spent == amountIn (no unspent wei, no split)");

    // The caller-received tokenOut == the REAL resolver's OWN LIVE estimateSwapIn(spent) view, to the WEI.
    // Because the block clock is PINNED (no accrual), the snapshot ladder the split priced == the live view
    // at exec, so this is BOTH exact-on-grid AND exact-in-dy (the strongest Fluid cross-check).
    assert.equal(received, onViewAwarded, "received == REAL resolver LIVE estimateSwapIn(awarded Σ) (exact-in-dy)");
    // And it equals the captured mainnet probe for this exact size (100k USDC → 100077906643) — a direct
    // tie to the real chain value, not just an internally-consistent replay.
    const probe100k = snaps.state.probe.swap0to1.find((p) => BigInt(p.amountIn) === amountIn);
    assert.ok(probe100k, "captured probe includes the 100k USDC size");
    assert.equal(received, BigInt(probe100k!.amountOut), "received == the CAPTURED mainnet estimateSwapIn(100k USDC) value to the wei");

    const ms = Date.now() - t0;
    console.log(
      `  [fluid-prod-mirror:${engine}] WEI-EXACT vs neutral oracle — spent=${spent} received=${received} ` +
        `(oracle awarded=${awarded}, liveView=${onViewAwarded}, capturedProbe=${probe100k!.amountOut}, amountIn=${amountIn}); ` +
        `wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL Fluid bytecode [${engine}] — wei-exact vs the neutral oracle, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
  }
});
