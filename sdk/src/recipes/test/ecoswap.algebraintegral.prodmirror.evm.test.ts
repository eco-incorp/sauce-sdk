/**
 * EcoSwap Algebra-INTEGRAL PROD-MIRROR local EVM test — NO fork, NO live RPC.
 *
 * Sibling of ecoswap.algebra.prodmirror.evm.test.ts (Algebra V1 — BSC THENA Fusion,
 * 7-word globalState). This one covers the Algebra INTEGRAL layout (THENA "V3,3" on
 * BSC, SwapX on Sonic, nest/Kittenswap on HyperEVM): it reproduces a REAL production
 * THENA Integral WBNB/USDT pool's tick state (BSC pool 0x9EA0f51F…, captured by
 * harness/algebra-snapshot.ts in its auto-detected Integral mode), then discovers it
 * through the PRODUCTION Algebra path with `algebraFeeLayout: "integral"` and runs
 * the compiled EcoSwap recipe against it.
 *
 * WHAT THE INTEGRAL LAYOUT CHANGES (and what this test pins)
 * ──────────────────────────────────────────────────────────
 * Integral returns SHORTER tuples for the SAME selectors as Algebra v1/Camelot:
 *   - globalState() is SIX words (price, tick, lastFee, pluginConfig, communityFee,
 *     unlocked): the single dynamic fee is word 2; word 3 is pluginConfig — NOT a fee.
 *   - ticks() is SIX words (liquidityTotal, liquidityDelta, prevTick, nextTick,
 *     outerFeeGrowth0, outerFeeGrowth1): liquidityNet is STILL index 1, but there is
 *     NO trailing `initialized` bool.
 * The local AlgebraIntegralPool adapter reproduces those EXACT tuple shapes (with a
 * POISON pluginConfig at word 3), so this test genuinely exercises:
 *   - the off-chain discovery's shape-tolerant globalState fallback (the typed 8-word
 *     Camelot decode REVERTS on 6-word returndata → raw word decode + the config's
 *     "integral" layout pins the fee to word 2 for BOTH directions),
 *   - the on-chain LENS's algSingleFee=1 path (globalState word 2, never word 3) over
 *     genuine 6-word returndata, through the engine's ABI decode,
 *   - the solver's Algebra spot read (globalState()[0]/[1]) + tick walk (ticks()[1])
 *     over the short Integral tuples,
 *   - the REAL engine algebraSwapCallback mid-swap re-entry (Integral kept the same
 *     callback selector as v1; sauce#186).
 * The swap CURVE math is genuine v3-core math over the captured state — Integral's
 * per-tick liquidityNet + sqrtPrice grid + swap step are byte-identical to Uniswap V3
 * (same as Algebra v1; see the sibling's header for the fidelity rationale — real
 * captured STATE, reconstructed pool, real callback + discovery paths).
 *
 * Offline by design: it loads the CHECKED-IN captured snapshot
 * (fixtures/snapshots/bsc-algebraintegral-USDTWBNB-60.json). Recapture with:
 *   set -a; . sdk/.env; set +a
 *   npx tsx src/recipes/test/harness/algebra-snapshot.ts \
 *     0x9EA0f51Fd2133d995Cf00229bc523737415ad318 integral
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.algebraintegral.prodmirror.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, parseAbi, parseUnits, type Hex, type Account, type Abi } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import { loadArtifact } from "./harness/artifacts";
import { deployContract, writeAndWait } from "./harness/deploy";
import {
  ensureMulticall3,
  deployStack,
  mint,
  approve,
  balanceOf,
  getSlot0,
  getLiquidity,
  deployAlgebraFactory,
  algebraFactoryAbi,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  type Engine,
  selectedEngines,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import {
  verifyReproduction,
  type ReproducedPool,
  type ReproductionDiff,
} from "./harness/reproduce-pool";
import { reproducePoolShifted } from "./harness/reproduce-pool-shifted";
import { withCachedState } from "./harness/state-cache";
import type { ProdPoolSnapshot } from "./harness/prod-snapshot";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { driftPoolPrice } from "./harness/drift";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "fixtures", "snapshots");
// The captured REAL BSC THENA Integral (V3,3) CL pool 0x9EA0f51F… (WBNB/USDT —
// token0=USDT, token1=WBNB by address order; tickSpacing 60; live Integral lastFee
// 988 ppm at capture). Captured by harness/algebra-snapshot.ts (Integral mode).
const SNAPSHOT_FILE = "bsc-algebraintegral-USDTWBNB-60.json";

// Both tokens are 18-decimal on BSC (USDT and WBNB).
const HUGE = parseUnits("1000000000", 18);

// POISON word 3 of the adapter's globalState (a realistic Integral pluginConfig
// bitmask). Any consumer that misreads word 3 as a fee (the Camelot directional
// decode) picks up 193 ppm instead of the real 988 ppm — failing the feePpm and
// wei-exact asserts below instead of silently mispricing.
const PLUGIN_CONFIG_POISON = 193;

// Uniswap-V3 / Algebra canonical MIN_TICK (the zeroForOne price-limit floor). See the
// Algebra-v1 sibling: a swap terminating HERE drained past the reconstructed window to
// the price limit — NOT a genuine interior liquidity cut. Asserted against below.
const MIN_TICK = -887272;

// RECONSTRUCTED-BAND BUDGET (ts=60 WBNB/USDT, live tick −63501, Integral lastFee 988).
// Down-walk (zeroForOne, USDT in) from the captured spot over the captured profile:
//   - the live band [−63540, −63501) absorbs ≈2118 USDT gross (active L ≈ 4.52e22),
//   - the next bands thin to L ≈ 5.1e21 (≈371 USDT per 60-tick band): cum ≈2488 to
//     −63600, ≈3979 to −63840, ≈4354 to −63900,
//   - the FULL ±200-tickSpacing window absorbs ≈24,235 USDT gross before its floor.
// Every trade below stays well inside that ≈24.2k budget so its cut is a GENUINE
// interior liquidity cut of the real captured profile, not a window-edge artifact.

// Per-pool net-cache measure (mirrors the V3 / Algebra-v1 prod-mirror): a scanned
// WINDOW (windowTopShifted > 0) is a populated per-pool cache. Defined locally.
function cacheWindowedPools(
  pools: { isV2?: boolean; windowTopShifted?: bigint }[],
): number {
  return pools.filter((p) => !p.isV2 && (p.windowTopShifted ?? 0n) > 0n).length;
}

// Single engine per (heavy) file: the one selected engine (default v12;
// ECO_ENGINE=v1 forces v1). See harness/engine.ts.
const PROD_ENGINE: Engine = selectedEngines()[0];

// The Integral adapter fixture (fixtures/src/AlgebraIntegralPool.sol — built by
// fixtures/build.sh). Loaded here directly (not via setup.ts) — this file is the
// only consumer of the Integral tuple shapes.
const FIXTURES_OUT = join(__dirname, "fixtures", "out");
const integralPoolArtifact = loadArtifact(
  join(FIXTURES_OUT, "AlgebraIntegralPool.sol", "AlgebraIntegralPool.json"),
);

// Integral 6-word globalState — the read surface the lens/solver must survive.
const integralPoolAbi = parseAbi([
  "function globalState() view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)",
  "function initialize(address innerPool, uint16 dynLastFee, uint8 pluginConfigPoison)",
]);

function loadSnapshot(): ProdPoolSnapshot {
  return JSON.parse(readFileSync(join(SNAPSHOT_DIR, SNAPSHOT_FILE), "utf-8")) as ProdPoolSnapshot;
}

/** Manifest the cache stores/rehydrates: everything the test needs post-loadState. */
interface AlgIntegralManifest {
  stack: DeployedStack;
  v12: DeployedV12Stack | null;
  /** The reproduced INNER v3-core pool (carries the reconstructed tick profile). */
  repro: ReproducedPool;
  /** The Algebra factory shim (poolByPair registry — shared with the v1 fixture). */
  algebraFactory: Hex;
  /** The INTEGRAL adapter (6-word globalState/ticks) discovery surfaces via poolByPair. */
  adapter: Hex;
}

describe("EcoSwap Algebra-INTEGRAL prod-mirror (reproduced real THENA V3,3 tick state, 6-word tuples)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let algebraFactory: Hex;
  let adapter: Hex;
  let snap: ProdPoolSnapshot;
  let repro: ReproducedPool;
  let diff: ReproductionDiff;
  let cleanSnapshot: Hex; // pristine reconstructed state (for the drift case)

  before(async () => {
    snap = loadSnapshot();
    console.log(
      `  [algebra-integral-prod-mirror] using REAL snapshot ${SNAPSHOT_FILE}` +
        ` (${snap.symbol0}/${snap.symbol1} lastFee=${snap.fee} tickSpacing=${snap.tickSpacing}` +
        ` tick=${snap.tick}, ${snap.ticks.length} boundaries)`,
    );

    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);

    // Full deploy + reconstruction, cached once per engine
    // (fixtures/anvil-state/algebraintegral-prodmirror-<engine>) so later runs
    // loadState in seconds. Recapture: RECAPTURE_ANVIL_STATE=1.
    const { manifest, fromCache } = await withCachedState<AlgIntegralManifest>({
      name: "algebraintegral-prodmirror",
      engine: PROD_ENGINE,
      c,
      build: async () => {
        await ensureMulticall3(c.publicClient, c.testClient);
        const s = await deployStack(c.walletClient, c.publicClient);
        // Reconstruct the captured Integral pool's tick profile into a REAL v3-core
        // INNER pool at the captured lastFee (988 ppm — the reproducer enables the
        // non-standard tier) + tickSpacing (60). The SHIFTED reproducer (not the
        // sibling tests' reproducePool) because THIS profile's net prefix dips
        // NEGATIVE mid-window (LPs whose positions open below the window bottom and
        // close inside it) — the original slab stack would drop 5 boundary nets; the
        // shifted scheme reproduces every interior + b0 net EXACTLY (see its header).
        const r = await reproducePoolShifted(c.walletClient, c.publicClient, s.factory, s.helper, snap, HUGE);
        // Deploy the (shared) AlgebraFactory shim + wrap the inner pool in the
        // INTEGRAL adapter: 6-word globalState (lastFee at word 2, POISON pluginConfig
        // at word 3), 6-word ticks (no initialized bool), algebraSwapCallback re-entry.
        const af = await deployAlgebraFactory(c.walletClient, c.publicClient);
        const ad = await deployContract(c.walletClient, c.publicClient, {
          abi: integralPoolArtifact.abi,
          bytecode: integralPoolArtifact.bytecode,
        });
        await writeAndWait(c.walletClient, c.publicClient, {
          address: ad,
          abi: integralPoolAbi as Abi,
          functionName: "initialize",
          args: [r.pool, snap.fee, PLUGIN_CONFIG_POISON],
        });
        await writeAndWait(c.walletClient, c.publicClient, {
          address: af,
          abi: algebraFactoryAbi as Abi,
          functionName: "setPool",
          args: [r.token0, r.token1, ad],
        });
        const v = await maybeDeployV12Stack(c, c.walletClient.account as Account);
        if (v) await approve(c.walletClient, c.publicClient, r.token0, v.pot, HUGE);
        return { stack: s, v12: v, repro: r, algebraFactory: af, adapter: ad };
      },
    });
    console.log(
      `  [algebra-integral-prod-mirror] state ${fromCache ? "LOADED from cache" : "RECONSTRUCTED + cached"} (engine ${PROD_ENGINE})`,
    );
    stack = manifest.stack;
    v12 = manifest.v12;
    repro = manifest.repro;
    algebraFactory = manifest.algebraFactory;
    adapter = manifest.adapter;

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  /**
   * poolConfig pointing discovery + the lens at the local AlgebraFactory shim, with
   * the LOAD-BEARING `algebraFeeLayout: "integral"` (single fee at globalState word 2
   * for BOTH directions; word 3 is the poisoned pluginConfig). baseTokens = the swap
   * pair so the route loop yields zero routes (single reproduced pool → direct-only),
   * exactly as the Algebra-v1 sibling.
   */
  function integralPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: algebraFactory,
          poolType: SwapPoolType.UniV3,
          factoryType: FactoryType.AlgebraV3,
          label: "Local Algebra Integral (prod-mirror)",
          algebraTickSpacing: snap.tickSpacing,
          algebraFeeLayout: "integral",
        },
      ],
      feeTiers: [snap.fee],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  it("reproduces the snapshot's on-chain tick state (sqrt EXACT via 6-word globalState + boundary nets EXACT)", async () => {
    // verifyReproduction reads slot0/liquidity/ticks off the INNER v3-core pool (which
    // carries the reconstructed state). The adapter's Integral read surface is asserted
    // separately below.
    diff = await verifyReproduction(c.publicClient, repro.pool, snap, {
      baselineClamped: repro.baselineClamped,
    });

    console.log(
      `  [algebra-integral-prod-mirror] reproduction diff:\n` +
        `    sqrtPriceX96 snapshot=${diff.sqrtSnapshot} onchain=${diff.sqrtOnchain} match=${diff.sqrtPriceMatch}\n` +
        `    active liquidity snapshot=${diff.activeSnapshot} onchain=${diff.activeOnchain} match=${diff.activeLiquidityMatch}\n` +
        `    boundaries checked (interior + b0)=${diff.boundariesChecked} net mismatches=${diff.netMismatches.length}\n` +
        `    baseline=${repro.baseline} clamped=${repro.baselineClamped} positions=${repro.positions.length}`,
    );

    assert.equal(diff.sqrtPriceMatch, true, "reproduced sqrtPriceX96 must equal snapshot globalState price");
    if (!repro.baselineClamped) {
      assert.equal(diff.activeLiquidityMatch, true, "reproduced active liquidity must equal snapshot");
    }
    assert.equal(
      diff.netMismatches.length,
      0,
      `interior boundary liquidityNet must match snapshot exactly (${diff.netMismatches
        .map((m) => `tick ${m.tick}: ${m.snapshot} vs ${m.onchain}`)
        .join("; ")})`,
    );
    assert.equal(diff.ok, true, "reproduction must be faithful");

    // FIDELITY GUARD: the adapter's globalState() returndata is EXACTLY 6 words — the
    // genuine Integral shape (a Camelot-shaped 8-word adapter would silently pass the
    // typed decode paths this test exists to break).
    const raw = await c.publicClient.call({
      to: adapter,
      data: encodeFunctionData({ abi: integralPoolAbi, functionName: "globalState" }),
    });
    assert.equal(
      (raw.data!.length - 2) / 64,
      6,
      "adapter globalState() must return the genuine 6-word Integral tuple",
    );

    // The Integral adapter proxies the SAME live price/tick as the inner pool (== the
    // captured snapshot price), reports the captured lastFee at word 2, and carries the
    // POISON (non-fee) pluginConfig at word 3.
    const gs = (await c.publicClient.readContract({
      address: adapter,
      abi: integralPoolAbi,
      functionName: "globalState",
    })) as readonly [bigint, number, number, number, number, boolean];
    assert.equal(gs[0], BigInt(snap.sqrtPriceX96), "adapter globalState price == captured sqrtPriceX96");
    assert.equal(Number(gs[2]), snap.fee, "adapter globalState word 2 == the captured Integral lastFee");
    assert.equal(Number(gs[3]), PLUGIN_CONFIG_POISON, "adapter globalState word 3 is the POISON pluginConfig (NOT a fee)");
    assert.ok((await getLiquidity(c.publicClient, adapter)) > 0n, "adapter proxies inner pool active liquidity > 0");

    // The Algebra shim resolves the adapter by poolByPair(token0, token1).
    const resolved = (await c.publicClient.readContract({
      address: algebraFactory,
      abi: algebraFactoryAbi as Abi,
      functionName: "poolByPair",
      args: [repro.token0, repro.token1],
    })) as Hex;
    assert.equal(resolved.toLowerCase(), adapter.toLowerCase(), "shim resolves the adapter by poolByPair");
  });

  it("decodes the Integral fee at word 2 for the ONEFORZERO direction too (word 3 is pluginConfig, not a fee)", async () => {
    // READ-ONLY prepare (no cook): tokenIn = token1 (WBNB) > token0 → oneForZero. The
    // Camelot layout would read the DIRECTIONAL oneForZero fee from globalState word 3 —
    // which on Integral is the poisoned pluginConfig (193), not a fee. The "integral"
    // layout must pin the fee to word 2 (988) for BOTH directions, in BOTH the off-chain
    // discovery fallback and the on-chain lens (algSingleFee=1).
    const tokenIn = repro.token1;
    const tokenOut = repro.token0;
    const { prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn: parseUnits("1", 18) },
      anvil.rpcUrl,
      cookTarget(PROD_ENGINE, stack, v12),
      c.account0,
      integralPoolConfig(tokenIn, tokenOut),
      { slippageBps: 0 },
      PROD_ENGINE,
    );
    assert.equal(prepared.pools.length, 1, "exactly one direct pool (oneForZero)");
    assert.equal(prepared.zeroForOne, false, "tokenIn = token1 → oneForZero");
    assert.equal(
      prepared.pools[0].feePpm,
      snap.fee,
      `oneForZero feePpm must be the word-2 lastFee (${snap.fee}), NOT the word-3 pluginConfig poison (${PLUGIN_CONFIG_POISON})`,
    );
    assert.notEqual(prepared.pools[0].feePpm, PLUGIN_CONFIG_POISON, "poison word 3 must never surface as a fee");
  });

  it("runs EcoSwap through the reproduced Integral pool (wei-exact vs the neutral oracle, real algebraSwapCallback)", async () => {
    // zeroForOne: tokenIn = token0 (USDT) < token1 (WBNB) = tokenOut (matches prepare's
    // downward tick scan and the snapshot's lower-boundary staircase).
    const target = cookTarget(PROD_ENGINE, stack, v12);
    const tokenIn = repro.token0;
    const tokenOut = repro.token1;
    const caller = c.account0;

    // Size the trade to cross SEVERAL real captured boundaries and land at a GENUINE
    // interior cut (see BUDGET note): 4000 USDT walks through the deep live band
    // (≈2118 to −63540), crosses −63600/−63660/…/−63840 (cum ≈3979) and lands inside
    // the [−63900, −63840) band — ≈16% of the ≈24.2k window budget, far from the floor.
    const amountIn = parseUnits("4000", 18);

    const poolConfig = integralPoolConfig(tokenIn, tokenOut);

    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);

    // The engine pulls tokenIn INTO the adapter (which forwards it to the inner pool).
    // Track the INNER pool's reserves (where the reconstructed liquidity lives).
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, repro.pool);
    const poolOutBefore = await balanceOf(c.publicClient, tokenOut, repro.pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const { tick: tickBefore } = await getSlot0(c.publicClient, repro.pool);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(PROD_ENGINE, stack, v12),
      caller,
      poolConfig,
      undefined,
      PROD_ENGINE,
    );

    const v3Count = prepared.pools.filter((p) => !p.isV2).length;
    assert.equal(v3Count, 1, "should discover exactly the 1 reproduced Integral pool");
    assert.equal(prepared.pools.length, 1, "exactly one direct pool");
    assert.equal(prepared.routes.length, 0, "no routes (baseTokens == swap pair)");
    assert.equal(
      prepared.pools[0].poolType,
      SwapPoolType.UniV3,
      "Integral pool surfaces as a UniV3-shaped row (poolType=1)",
    );
    assert.equal(
      prepared.pools[0].address.toLowerCase(),
      adapter.toLowerCase(),
      "the discovered pool is the Integral adapter (via poolByPair)",
    );
    assert.equal(
      prepared.pools[0].feePpm,
      snap.fee,
      "the Integral lastFee read from globalState word 2 threads into feePpm",
    );
    assert.ok(
      cacheWindowedPools(prepared.pools) > 0,
      "should build a per-pool net-cache window from reconstructed ticks",
    );
    assert.ok(prepared.zeroForOne, "tokenIn < tokenOut → zeroForOne");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(
      receipt.status,
      "success",
      "cook() must succeed against reproduced Integral geometry (algebraSwapCallback serviced)",
    );

    const poolInAfter = await balanceOf(c.publicClient, tokenIn, repro.pool);
    const poolOutAfter = await balanceOf(c.publicClient, tokenOut, repro.pool);
    const callerInAfter = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutAfter = await balanceOf(c.publicClient, tokenOut, caller);
    const { tick: tickAfter } = await getSlot0(c.publicClient, repro.pool);

    const spent = callerInBefore - callerInAfter;
    const received = callerOutAfter - callerOutBefore;

    assert.ok(spent > 0n, "caller should spend tokenIn");
    assert.ok(received > 0n, "caller should receive tokenOut > 0");
    assert.equal(
      poolInAfter - poolInBefore,
      spent,
      "inner pool tokenIn reserve increases by spent (input pulled via algebraSwapCallback)",
    );
    assert.ok(poolOutBefore - poolOutAfter > 0n, "inner pool tokenOut reserve decreases");

    // zeroForOne moves the price DOWN through reconstructed initialized ticks…
    assert.ok(
      tickAfter < tickBefore,
      `swap must cross reconstructed ticks (tick ${tickBefore} -> ${tickAfter})`,
    );
    // …landing at a GENUINE interior liquidity cut, NOT the price-limit floor.
    assert.ok(
      tickAfter > MIN_TICK,
      `swap lands at an interior cut, not the price-limit floor (tick ${tickAfter})`,
    );

    // WEI-EXACT oracle cross-check: deterministic local state == prepared state, so the
    // neutral oracle (ecoswap.optimal.ts via the bit-for-bit ecoSwapReference adapter)
    // allocates EXACTLY the on-chain spend for the single reproduced pool.
    const ref = ecoSwapReference(prepared, amountIn);
    const refIn = ref.perPoolInput[0] ?? 0n;
    assert.ok(refIn > 0n, "oracle allocates to the reproduced pool");
    assert.equal(spent, ref.totalInput, "single-pass: spent == oracle totalInput EXACTLY (to the wei)");
    assert.equal(spent, refIn, "per-pool awarded input == oracle to the wei");
    assert.equal(poolInAfter - poolInBefore, refIn, "inner pool tokenIn delta == oracle per-pool input to the wei");

    console.log(
      `  [algebra-integral-prod-mirror] swap landed: spent=${spent} received=${received}` +
        ` tick ${tickBefore}->${tickAfter} (crossed ticks)` +
        ` oracle totalInput=${ref.totalInput} perPool[0]=${refIn} (wei-exact, lastFee=${snap.fee})`,
    );
  });

  it("re-anchors to the live 6-word globalState price when the Integral pool drifts after prepare", async () => {
    await c.testClient.revert({ id: cleanSnapshot });

    const target = cookTarget(PROD_ENGINE, stack, v12);
    const tokenIn = repro.token0;
    const tokenOut = repro.token1;
    const caller = c.account0;
    // Sized SMALL relative to the ≈24.2k budget so that, AFTER the boundary-crossing
    // drift, the re-anchored full-amountIn fill still lands at a GENUINE interior cut:
    // drift (2200) + amountIn (300) = 2500 gross-in ≪ the window budget.
    const amountIn = parseUnits("300", 18);
    const poolConfig = integralPoolConfig(tokenIn, tokenOut);
    const { tick: preparedTick } = await getSlot0(c.publicClient, repro.pool);

    // PREPARE against the clean (pre-drift) tick state. slippageBps:0 disables the
    // internal whole-trade amountOutMin floor — this test DELIBERATELY moves the price
    // adversely to exercise Phase-B live re-anchoring (see the Algebra-v1 sibling for
    // the rationale; the floor's default is exercised by the wei-exact case above).
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(PROD_ENGINE, stack, v12),
      caller,
      poolConfig,
      { slippageBps: 0 },
      PROD_ENGINE,
    );
    const ref = ecoSwapReference(prepared, amountIn);
    const refV3 = ref.perPoolInput[0] ?? 0n;
    assert.ok(refV3 > 0n, "baseline allocates to the Integral pool");

    // DRIFT: push the pool's price DOWN with a real swap routed through the engine
    // (which re-enters via algebraSwapCallback — the same path the recipe uses). The
    // live band [−63540, −63501) absorbs ≈2118 USDT, so 2200 crosses the −63540
    // boundary — the drift moves the live tick by an OBSERVABLE, boundary-crossing
    // amount (a sub-tick drift could not distinguish live re-anchoring from stale-price
    // behavior; see the Algebra-v1 sibling).
    const driftAmount = parseUnits("2200", 18);
    await driftPoolPrice(c, stack.sauceRouter, prepared.pools[0], tokenIn, tokenOut, true, driftAmount, caller);
    const { sqrtPriceX96: driftedSqrt, tick: driftedTick } = await getSlot0(c.publicClient, repro.pool);

    assert.ok(
      driftedTick < preparedTick,
      `drift crossed a real initialized boundary: live tick ${preparedTick} -> ${driftedTick}`,
    );
    assert.ok(driftedSqrt < BigInt(snap.sqrtPriceX96), "drift moved the live price below the prepared price");

    // EXECUTE the pre-drift bytecodes — Phase B must read the NEW (6-word) globalState price.
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, repro.pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against drifted globalState");

    const v3InDelta = (await balanceOf(c.publicClient, tokenIn, repro.pool)) - poolInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const { tick: afterTick } = await getSlot0(c.publicClient, repro.pool);

    // SINGLE-PASS RE-ANCHORING (input-anchored) — the SAME semantics every prod-mirror
    // sibling asserts: Phase B re-reads the LIVE (drifted) globalState price and walks
    // the frontier from THERE, spending the full amountIn against the drifted price.
    assert.ok(v3InDelta > 0n, "pool still participates");
    assert.equal(v3InDelta, spent, "single pool → spent == its fill");
    assert.ok(spent <= amountIn, "never overspends amountIn");
    assert.ok(
      spent >= (amountIn * 80n) / 100n,
      `spends the large majority of the trade against the drifted price (spent ${spent} of ${amountIn})`,
    );
    assert.ok(
      afterTick > MIN_TICK,
      `re-anchored fill lands at an interior cut, not the price-limit floor (tick ${afterTick})`,
    );
    assert.ok(
      afterTick <= driftedTick,
      `re-anchored fill walks down from the drifted price (drifted ${driftedTick} -> after ${afterTick})`,
    );

    console.log(
      `  [algebra-integral-prod-mirror] RUNTIME re-anchor (single-pass, input-anchored): ` +
        `drift ${driftAmount} moved live tick ${preparedTick}->${driftedTick}; ` +
        `then recipe spent ${spent} of amountIn ${amountIn} (baseline fill ${refV3}); ` +
        `tick ${driftedTick}->${afterTick}`,
    );
  });
});
