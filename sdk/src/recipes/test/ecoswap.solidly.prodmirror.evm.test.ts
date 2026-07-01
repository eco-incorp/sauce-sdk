/**
 * EcoSwap Solidly (Aerodrome sAMM) PROD-MIRROR — REAL BYTECODE, NO FORK, OFFLINE.
 *
 * This is the reference "real-code prod-mirror" the OTHER callback-free sources follow.
 * Unlike ecoswap.solidly.evm.test.ts (which deploys a MOCK SolidlyStablePool.sol fixture),
 * this test stands up the GENUINE Aerodrome Pool bytecode captured from Base mainnet and
 * runs the swap against it — proving the production discovery + execution path works on
 * the real contract, with NO fork and NO RPC at run time (etch + setStorageAt, seconds).
 *
 * MECHANISM (mirrors the repo's Uniswap-V4 real-runtime etch, generalised in harness/etch-pool.ts):
 *   CAPTURE (one-time, harness/solidly-snapshot.ts, uses the RPC key):
 *     the deepest real USDC/USDbC sAMM pool (Aerodrome PoolFactory getPool(USDC,USDbC,true))
 *     is an EIP-1167 CLONE — we eth_getCode BOTH the 45-byte proxy runtime AND the 21KB
 *     implementation runtime into fixtures/snapshots/base-solidly-USDCUSDbC.bytecode.json, and
 *     the swap-relevant state (reserves/tokens/decimals/stable/fee + the raw storage slots)
 *     into .state.json. Block pinned for provenance. No key/url is ever persisted.
 *   ETCH (this test, OFFLINE): boot a plain anvil (NO fork); setCode the REAL impl at its
 *     captured address + the REAL proxy at the pool address; setStorageAt the captured
 *     storage verbatim, then repoint token0/token1 at local MintableERC20s + the factory at
 *     a tiny SolidlyV2 shim (getPool/getFee). The swap then runs the GENUINE Aerodrome impl
 *     bytecode: getAmountOut returns the mainnet-identical dy for the captured reserves.
 *
 * CENTRAL VERIFICATION (this file asserts all three explicitly):
 *   (a) REAL bytecode — eth_getCode at the pool + impl in the test == the captured real
 *       runtime, byte-for-byte. No mock SolidlyStablePool.sol is in the swap path (the
 *       pool/impl addresses are the captured mainnet addresses, running captured code).
 *   (b) FAST + OFFLINE — no fork, no RPC at run time; per-engine wall-clock logged (seconds).
 *   (c) WEI-EXACT — the caller-received tokenOut == the neutral oracle (ecoswap.optimal.ts
 *       optimalSplit, seeded from the REAL captured reserves via the SHARED
 *       buildSolidlyStableSegments) == the REAL pool's own pre-swap getAmountOut view, all
 *       to the wei. (getAmountOutStable — the oracle's replay — was proven bit-for-bit with
 *       the real pool's getAmountOut across amounts, so the oracle IS the real curve.)
 *
 * Dual-engine (v1 + v12), gated by ECO_ENGINE (default v12; skip-by-default for v12 when the
 * artifacts are absent). No state cache — etch+setStorage is a few seconds.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.solidly.prodmirror.evm.test.ts
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
  etchSolidlyPool,
  loadSolidlySnapshots,
  verifyBytecodeIntegrity,
  solidlyPoolReadAbi,
  solidlyFactoryShimAbi,
  type EtchedSolidlyPool,
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
import {
  getAmountOutStable,
  type SolidlyStablePool,
} from "../shared/solidly-stable-math";

const SNAP_NAME = "base-solidly-USDCUSDbC";
const ENGINE_CELLS = engineCells();

/** Interpret a Solidly factory getFee (bps or ppm) as ppm — the SAME rule discovery uses. */
function solidlyFeeToPpm(fee: bigint): number {
  const n = Number(fee);
  if (n === 0) return 100;
  return n < 1000 ? n * 100 : n;
}

describe("EcoSwap Solidly (Aerodrome sAMM) prod-mirror — REAL bytecode, no fork, offline", () => {
  const snaps = loadSolidlySnapshots(SNAP_NAME);

  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let etched: EtchedSolidlyPool;

  // Boot a fresh anvil + etch the real pool + deploy the engine. Called before each cell so
  // each engine runs in full isolation (no shared mutable node state — cheap because the
  // whole setup is etch + setStorageAt + a handful of deploys, seconds not minutes).
  async function setup(): Promise<void> {
    anvil?.stop();
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    // ~10x the reserve as caller headroom (6-decimal token; reserves ~20k units).
    etched = await etchSolidlyPool(c.walletClient, c.publicClient, c.testClient, snaps, {
      minter: c.walletClient.account as Account,
      callerFund: BigInt(snaps.state.reserve0) * 10n,
    });
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  /** A poolConfig with ONLY a SolidlyV2 factory (the shim) → the production Solidly discovery
   *  path resolves the etched pool; the lens ignores non-V2/V3/V4 factory types, so no direct
   *  pools are surfaced and the stable pool rides entirely through discoverSolidlyStablePoolsTyped. */
  function solidlyPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: etched.factory,
          poolType: SwapPoolType.UniV2,
          factoryType: FactoryType.SolidlyV2,
          label: "Local Aerodrome sAMM (prod-mirror)",
        },
      ],
      feeTiers: [],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  /** The neutral oracle (ecoswap.optimal.ts) allocation for the single reproduced stable pool,
   *  seeded from the REAL captured reserves/decimals/fee via the SHARED buildSolidlyStableSegments. */
  function offPool(tokenIn: Hex, feePpm: number): SolidlyStablePool {
    // tokenIn == token0 (lower address) — see the zeroForOne assertion below.
    return {
      address: etched.pool,
      reserveIn: etched.reserve0,
      reserveOut: etched.reserve1,
      decIn: BigInt(snaps.state.decimals0),
      decOut: BigInt(snaps.state.decimals1),
      token0: tokenIn,
      inIsToken0: true,
      feePpm,
      source: "prod-mirror",
    };
  }

  // ── (a) REAL BYTECODE — the etched code IS the captured mainnet runtime, byte-for-byte. ──
  it("etches the REAL Aerodrome pool bytecode (byte-equal) + reconstructs the captured state", async () => {
    // NO-NETWORK integrity tripwire FIRST: the checked-in runtime blob still hashes to the
    // sha256 anchor recorded at capture time (which was byte-equal to the pinned-block on-chain
    // code). A reviewer without the RPC key can run this — it proves the snapshot wasn't silently
    // altered/truncated after capture, with NO RPC. (Skips gracefully for pre-anchor snapshots.)
    const integ = verifyBytecodeIntegrity(snaps.bytecode);
    assert.ok(integ.pool.ok, `pool runtime sha256 matches the capture anchor (got ${integ.pool.actual})`);
    assert.ok(
      integ.implementation?.ok ?? true,
      `impl runtime sha256 matches the capture anchor (got ${integ.implementation?.actual})`,
    );
    assert.ok(snaps.bytecode.pool.runtimeSha256, "pool snapshot carries a sha256 integrity anchor");
    assert.ok(snaps.bytecode.implementation?.runtimeSha256, "impl snapshot carries a sha256 integrity anchor");

    // getCode at the pool + impl must EQUAL the captured real runtime (no mock in the path).
    const poolCode = await c.publicClient.getCode({ address: etched.pool });
    const implCode = await c.publicClient.getCode({ address: etched.impl });
    assert.ok(poolCode, "pool has code");
    assert.equal(
      poolCode!.toLowerCase(),
      snaps.bytecode.pool.runtime.toLowerCase(),
      "eth_getCode at the pool == the captured REAL Aerodrome proxy runtime (byte-equal)",
    );
    assert.ok(implCode, "impl has code");
    assert.equal(
      implCode!.toLowerCase(),
      snaps.bytecode.implementation!.runtime.toLowerCase(),
      "eth_getCode at the impl == the captured REAL Aerodrome Pool implementation runtime (byte-equal)",
    );
    // The pool/impl addresses are the CAPTURED mainnet addresses — no locally-compiled mock.
    assert.equal(etched.pool.toLowerCase(), snaps.bytecode.pool.address.toLowerCase(), "pool at captured mainnet address");
    assert.equal(
      etched.impl.toLowerCase(),
      snaps.bytecode.implementation!.address.toLowerCase(),
      "impl at captured mainnet address",
    );

    // The REAL code reads the reconstructed state correctly.
    const [t0, t1, stable, reserves] = await Promise.all([
      c.publicClient.readContract({ address: etched.pool, abi: solidlyPoolReadAbi, functionName: "token0" }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: solidlyPoolReadAbi, functionName: "token1" }) as Promise<Hex>,
      c.publicClient.readContract({ address: etched.pool, abi: solidlyPoolReadAbi, functionName: "stable" }) as Promise<boolean>,
      c.publicClient.readContract({ address: etched.pool, abi: solidlyPoolReadAbi, functionName: "getReserves" }) as Promise<readonly [bigint, bigint, bigint]>,
    ]);
    assert.equal(t0.toLowerCase(), etched.token0.toLowerCase(), "token0 repointed at the local token");
    assert.equal(t1.toLowerCase(), etched.token1.toLowerCase(), "token1 repointed at the local token");
    assert.equal(stable, true, "REAL code reports stable == true (sAMM)");
    assert.equal(reserves[0], etched.reserve0, "reserve0 == captured");
    assert.equal(reserves[1], etched.reserve1, "reserve1 == captured");

    // The REAL getAmountOut computes the mainnet-identical dy for the captured probe.
    const probeIn = BigInt(snaps.state.probe.amountIn);
    const dy = (await c.publicClient.readContract({
      address: etched.pool, abi: solidlyPoolReadAbi, functionName: "getAmountOut", args: [probeIn, etched.token0],
    })) as bigint;
    assert.equal(
      dy.toString(),
      snaps.state.probe.amountOut,
      "REAL getAmountOut(probe) == the captured mainnet value (real code, real reserves)",
    );

    // The Solidly shim resolves the pool + fee the production discovery path reads.
    const gp = (await c.publicClient.readContract({
      address: etched.factory, abi: solidlyFactoryShimAbi, functionName: "getPool", args: [etched.token0, etched.token1, true],
    })) as Hex;
    const gf = (await c.publicClient.readContract({
      address: etched.factory, abi: solidlyFactoryShimAbi, functionName: "getFee", args: [etched.pool, true],
    })) as bigint;
    assert.equal(gp.toLowerCase(), etched.pool.toLowerCase(), "shim getPool resolves the etched pool");
    assert.equal(gf, etched.factoryFee, "shim getFee returns the captured factory fee");

    console.log(
      `  [solidly-prod-mirror] REAL bytecode etched: pool ${etched.pool} (proxy ${(poolCode!.length - 2) / 2} B) ` +
        `-> impl ${etched.impl} (${(implCode!.length - 2) / 2} B); ` +
        `captured block ${snaps.state.block}; reserves ${etched.reserve0}/${etched.reserve1}; fee ${etched.factoryFee}`,
    );
  });

  // ── (b)+(c) FAST/OFFLINE run through the production discovery path, wei-exact vs the oracle. ──
  async function runProdMirror(engine: Engine): Promise<void> {
    await setup();
    const t0 = Date.now();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // tokenIn = token0 (lower address) → zeroForOne; token0 is USDC-equivalent in the capture.
    const tokenIn = etched.token0;
    const tokenOut = etched.token1;
    const feePpm = solidlyFeeToPpm(etched.factoryFee);

    // A meaningful stable trade: ~5% of the reserve (still well within the curve).
    const amountIn = etched.reserve0 / 20n;
    const poolConfig = solidlyPoolConfig(tokenIn, tokenOut);

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    // caller already funded (callerFund in setup); ensure headroom.
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);

    // The REAL pool's OWN pre-swap getAmountOut view for the full amountIn — the engine-
    // independent ground truth for the executed dy (== the oracle, proven bit-for-bit). Read on
    // the pre-swap state so it is the ground truth for whatever the solver ends up spending.
    const onViewPre = (await c.publicClient.readContract({
      address: etched.pool, abi: solidlyPoolReadAbi, functionName: "getAmountOut", args: [amountIn, tokenIn],
    })) as bigint;

    // Run EcoSwap through the PRODUCTION FactoryType.SolidlyV2 discovery path.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(engine, stack, v12),
      caller,
      poolConfig,
      undefined,
      engine,
    );

    // Discovery surfaced exactly the ONE reproduced Solidly stable venue (via the real getters).
    assert.equal(prepared.pools.length, 0, "lens surfaces no direct V2/V3/V4 pools (Solidly-only config)");
    assert.equal((prepared.solidlyStables ?? []).length, 1, "discovered exactly the 1 reproduced Solidly stable venue");
    assert.equal(
      prepared.solidlyStables![0].address.toLowerCase(),
      etched.pool.toLowerCase(),
      "the discovered stable venue is the REAL etched pool",
    );
    assert.equal(prepared.solidlyStables![0].feePpm, feePpm, "discovery normalises the captured factory fee to ppm");
    assert.ok(
      (prepared.brackets ?? []).some((b) => b.kind === EcoBracketKind.SolidlyStable),
      "Solidly-stable segments present",
    );

    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, etched.pool);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against the REAL Aerodrome bytecode");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, etched.pool)) - poolInBefore;

    assert.ok(spent > 0n, "caller spends tokenIn");
    assert.ok(received > 0n, "caller receives tokenOut");
    // The REAL Aerodrome swap() routes the swap FEE (spent·fee/10000) out to its separate
    // PoolFees contract, so the pool's net tokenIn balance delta is spent MINUS the fee — a
    // genuine real-code behavior (not seen with the mock fixture). Assert the pool netted the
    // input less exactly the captured-fee cut.
    const feeCut = (spent * etched.factoryFee) / 10000n;
    assert.equal(poolIn, spent - feeCut, "REAL pool netted the input less the fee it routed to PoolFees");

    // NEUTRAL ORACLE (ecoswap.optimal.ts) — one solidlyStable venue seeded from the REAL
    // captured reserves via the SHARED buildSolidlyStableSegments. The whole amountIn should
    // allocate to this single venue (the segment ladder covers [0, amountIn]).
    const op = offPool(tokenIn, feePpm);
    const optPools: OptimalPool[] = [{ solidlyStable: op, feePpm }];
    const oracle = optimalSplit({ pools: optPools, amountIn, zeroForOne: true });
    const awarded = oracle.perPoolInput[0] ?? 0n;
    assert.ok(awarded > 0n, "oracle allocates to the reproduced stable venue");

    // WEI-EXACT: the on-chain spend == the oracle's awarded input to the WEI, and the caller-
    // received tokenOut == getAmountOutStable(awarded) (the oracle's realized dy) == the REAL
    // pool's own pre-swap getAmountOut view, all to the WEI. NO tolerance.
    assert.equal(spent, awarded, "on-chain spent == neutral oracle awarded input (wei-exact)");
    assert.equal(spent, oracle.totalInput, "single venue: spent == oracle totalInput (wei-exact)");
    assert.equal(
      received,
      getAmountOutStable(op, spent),
      "received == neutral-oracle getAmountOutStable(spent) (wei-exact)",
    );
    // SINGLE-VENUE FULL-FILL is the documented expectation for this sizing (amountIn = reserve0/20,
    // one Solidly stable venue, the segment ladder covers [0, amountIn]) — so the whole trade
    // allocates to this one pool and spent == amountIn. Assert it EXPLICITLY (not a silent guard):
    // a regression that leaves a wei unspent, or splits the trade, must fail here rather than
    // quietly skip the strongest cross-check.
    assert.equal(spent, amountIn, "single-venue full-fill: spent == amountIn (no unspent wei, no split)");
    // With spent == amountIn, the executed dy == the REAL pool's OWN pre-swap getAmountOut view
    // for the full amountIn — the three-way agreement (TS oracle == real Solidity view == executed
    // swap), all to the WEI, tying the executed output to the real pool's own curve.
    assert.equal(received, onViewPre, "received == REAL pool pre-swap getAmountOut(amountIn) (exact-in-dy)");

    const ms = Date.now() - t0;
    console.log(
      `  [solidly-prod-mirror:${engine}] WEI-EXACT vs neutral oracle — spent=${spent} received=${received} ` +
        `(oracle awarded=${awarded}, getAmountOutStable=${getAmountOutStable(op, spent)}, realView=${onViewPre}); ` +
        `wall-clock ${ms} ms (no fork, no RPC)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`runs EcoSwap through the REAL Aerodrome bytecode [${engine}] — wei-exact vs the neutral oracle, offline`, { skip }, async () => {
      await runProdMirror(engine);
    });
  }
});
