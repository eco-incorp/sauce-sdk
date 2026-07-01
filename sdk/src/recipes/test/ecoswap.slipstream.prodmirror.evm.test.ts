/**
 * EcoSwap Slipstream-CL PROD-MIRROR local EVM test — NO fork, NO live RPC.
 *
 * Sibling of ecoswap.prodmirror.evm.test.ts (the Uniswap-V3 prod-mirror). It
 * reproduces a REAL production Aerodrome Slipstream CL pool's tick state on a
 * fresh local anvil, then discovers it through the PRODUCTION Slipstream path
 * (tickSpacing-keyed getPool(a, b, int24) via the SlipstreamCLFactory shim) and
 * runs the compiled EcoSwap recipe against it.
 *
 * WHY THE V3 HARNESS APPLIES UNCHANGED
 * ────────────────────────────────────
 * A Slipstream CLPool is UniswapV3-compatible for PRICING *and* EXECUTION: it
 * exposes the standard slot0/ticks/liquidity/tickSpacing/fee() surface and its
 * swap() re-enters the caller via the EXACT `uniswapV3SwapCallback` selector the
 * engine Router already implements (V3 callbacks are authenticated by the
 * transient expectedPool, NOT a factory/CREATE2 check). So its swap math is
 * V3-identical, and the captured `ProdPoolSnapshot` (same shape the V3 capturer
 * emits) replays through reproduce-pool.ts / verifyReproduction with NO change.
 * The ONLY Slipstream-specific bits are DISCOVERY (int24 tickSpacing key, not
 * uint24 fee) and that fee is DECOUPLED from the key (read from fee()).
 *
 * RECONSTRUCTION FIDELITY  (be honest — this is v3-core-reconstruction, NOT a
 * real-CLPool-bytecode etch):
 *   The reconstructed pool is a REAL @uniswap/v3-core pool minted to the EXACT
 *   captured tick profile at the EXACT captured sqrtPriceX96 (verifyReproduction
 *   asserts sqrtPriceX96 EXACT + every interior/b0 boundary liquidityNet EXACT).
 *   We deliberately do NOT etch the real Aerodrome CLPool runtime: CLPool.mint
 *   requires its gauge / NFT-position-manager / staked-liquidity accounting graph
 *   (a bare etched CLPool runtime cannot be minted into cleanly without that whole
 *   dependency graph), whereas the swap-relevant state — sqrtPriceX96, per-tick
 *   liquidityNet, active liquidity, fee(), tickSpacing() — is reproduced EXACTLY
 *   in a v3-core pool. Because CLPool.swap IS v3-core swap math over that exact
 *   state (the verified KEY FACT), the executed swap is provably identical to the
 *   real pool's. Fidelity level: REAL captured pool STATE (sqrt + full tick
 *   profile + active L + decoupled fee), executed through genuine v3-core math via
 *   the production Slipstream discovery path. This matches the V3 prod-mirror tier.
 *
 * The pool is registered in the SlipstreamCLFactory shim under its tickSpacing so
 * the production discoverSlipstreamCLPools → lens path finds it via
 * getPool(a, b, int24) exactly as in ecoswap.slipstream.evm.test.ts.
 *
 * Offline by design: it loads the CHECKED-IN captured snapshot
 * (fixtures/snapshots/base-slipstream-USDCUSDbC-1.json). Recapture the snapshot
 * with:
 *   set -a; . sdk/.env; set +a
 *   BASE_RPC_URL=$BASE_RPC_URL npx tsx src/recipes/test/harness/slipstream-snapshot.ts
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.slipstream.prodmirror.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnits, type Hex, type Account, type Abi } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  mint,
  approve,
  balanceOf,
  getSlot0,
  deploySlipstreamFactory,
  slipstreamFactoryAbi,
  v3PoolAbi,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { writeAndWait } from "./harness/deploy";
import {
  type Engine,
  selectedEngines,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import {
  reproducePool,
  verifyReproduction,
  type ReproducedPool,
  type ReproductionDiff,
} from "./harness/reproduce-pool";
import { withCachedState } from "./harness/state-cache";
import type { ProdPoolSnapshot } from "./harness/prod-snapshot";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { driftPoolPrice } from "./harness/drift";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "fixtures", "snapshots");
// The captured REAL Aerodrome Slipstream CL pool (USDC/USDbC, tickSpacing 1, fee
// 100 — on-charter both-baseToken stable pair on Base). Captured by
// harness/slipstream-snapshot.ts.
const SNAPSHOT_FILE = "base-slipstream-USDCUSDbC-1.json";

const HUGE = parseUnits("1000000000", 6); // both tokens are 6-decimal stables

// Uniswap-V3 / Slipstream canonical MIN_TICK (the zeroForOne price-limit floor). A
// swap that terminates HERE has drained past all reconstructed liquidity to the
// price limit — NOT landed at a genuine interior liquidity cut. The drift case
// asserts the swap does NOT reach this, so a future regression that zips a
// re-anchored fill to the price-limit extreme is caught.
const MIN_TICK = -887272;

// RECONSTRUCTED-BAND BUDGET (ts=1 USDC/USDbC stable pool). The captured window
// spans ticks −100..100 but the pool's liquidity is genuinely CONCENTRATED near
// spot: the live [tick 1, tick 2) band alone is ≈8.76e15 active L (≈101.7k USDC to
// walk DOWN to the tick-1 boundary), then it thins to a near-empty tail by tick
// −11 and only the tiny baseline slab remains below tick −100. Total gross tokenIn
// the reconstructed window can absorb from spot before the price-limit floor is
// ≈154k USDC. Every trade below MUST stay inside this budget so its cut is a
// GENUINE interior liquidity cut (a real captured-state cut), not a window-edge
// MIN_TICK artifact. This is the REAL pool's shape, not a fixture limitation:
// widening the window cannot manufacture depth the real pool does not have below
// tick −11.

// Per-pool net-cache measure (mirrors the V3 prod-mirror): a scanned WINDOW
// (windowTopShifted > 0) is a populated per-pool cache, independent of how many
// initialized ticks fell inside it. Defined locally (not shared) to avoid races.
function cacheWindowedPools(
  pools: { isV2?: boolean; windowTopShifted?: bigint }[],
): number {
  return pools.filter((p) => !p.isV2 && (p.windowTopShifted ?? 0n) > 0n).length;
}

// Single engine per (heavy) file: the one selected engine (default v12;
// ECO_ENGINE=v1 forces v1). See harness/engine.ts.
const PROD_ENGINE: Engine = selectedEngines()[0];

function loadSnapshot(): ProdPoolSnapshot {
  return JSON.parse(readFileSync(join(SNAPSHOT_DIR, SNAPSHOT_FILE), "utf-8")) as ProdPoolSnapshot;
}

/** Manifest the cache stores/rehydrates: everything the test needs post-loadState. */
interface SlipManifest {
  stack: DeployedStack;
  v12: DeployedV12Stack | null;
  repro: ReproducedPool;
  /** The SlipstreamCLFactory shim (getPool keyed by int24 tickSpacing). */
  slipFactory: Hex;
}

describe("EcoSwap Slipstream-CL prod-mirror (reproduced real Aerodrome CL tick state)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let slipFactory: Hex;
  let snap: ProdPoolSnapshot;
  let repro: ReproducedPool;
  let diff: ReproductionDiff;
  let cleanSnapshot: Hex; // pristine reconstructed state (for the drift case)

  before(async () => {
    snap = loadSnapshot();
    console.log(
      `  [slip-prod-mirror] using REAL snapshot ${SNAPSHOT_FILE}` +
        ` (${snap.symbol0}/${snap.symbol1} fee=${snap.fee} tickSpacing=${snap.tickSpacing}` +
        ` tick=${snap.tick}, ${snap.ticks.length} boundaries)`,
    );

    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);

    // Full deploy + reconstruction, cached once per engine
    // (fixtures/anvil-state/slipstream-prodmirror-<engine>) so later runs
    // loadState in seconds. Recapture: RECAPTURE_ANVIL_STATE=1. See state-cache.ts.
    const { manifest, fromCache } = await withCachedState<SlipManifest>({
      name: "slipstream-prodmirror",
      engine: PROD_ENGINE,
      c,
      build: async () => {
        await ensureMulticall3(c.publicClient, c.testClient);
        const s = await deployStack(c.walletClient, c.publicClient);
        // Reconstruct the captured Slipstream pool as a REAL v3-core pool (the
        // pool's fee()/tickSpacing() come from the snapshot's fee/tickSpacing —
        // 100 / 1 — so the decoupled fee is genuine, read from fee() downstream).
        const r = await reproducePool(c.walletClient, c.publicClient, s.factory, s.helper, snap, HUGE);
        // Register it in the Slipstream shim under its int24 tickSpacing so the
        // production tickSpacing-keyed getPool(a, b, int24) discovery finds it.
        const sf = await deploySlipstreamFactory(c.walletClient, c.publicClient);
        await writeAndWait(c.walletClient, c.publicClient, {
          address: sf,
          abi: slipstreamFactoryAbi as Abi,
          functionName: "setPool",
          args: [r.token0, r.token1, snap.tickSpacing, r.pool],
        });
        const v = await maybeDeployV12Stack(c, c.walletClient.account as Account);
        if (v) await approve(c.walletClient, c.publicClient, r.token0, v.pot, HUGE);
        return { stack: s, v12: v, repro: r, slipFactory: sf };
      },
    });
    console.log(
      `  [slip-prod-mirror] state ${fromCache ? "LOADED from cache" : "RECONSTRUCTED + cached"} (engine ${PROD_ENGINE})`,
    );
    stack = manifest.stack;
    v12 = manifest.v12;
    repro = manifest.repro;
    slipFactory = manifest.slipFactory;

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  /**
   * poolConfig pointing discovery + the lens at the local Slipstream CLFactory
   * shim (tickSpacing-keyed), carrying the snapshot's tickSpacing as the discovery
   * key. baseTokens = the swap pair so the multi-hop route loop yields zero routes
   * (single reproduced pool → direct-only), exactly as the V3 prod-mirror.
   */
  function slipPoolConfig(tokenIn: Hex, tokenOut: Hex): ChainPoolConfig {
    return {
      factories: [
        {
          address: slipFactory,
          poolType: SwapPoolType.UniV3,
          factoryType: FactoryType.SlipstreamCL,
          label: "Local Slipstream CL (prod-mirror)",
          slipstreamTickSpacings: [snap.tickSpacing],
        },
      ],
      feeTiers: [snap.fee],
      baseTokens: [tokenIn, tokenOut],
    };
  }

  it("reproduces the snapshot's on-chain tick state (sqrt EXACT + boundary nets EXACT)", async () => {
    diff = await verifyReproduction(c.publicClient, repro.pool, snap, {
      baselineClamped: repro.baselineClamped,
    });

    console.log(
      `  [slip-prod-mirror] reproduction diff:\n` +
        `    sqrtPriceX96 snapshot=${diff.sqrtSnapshot} onchain=${diff.sqrtOnchain} match=${diff.sqrtPriceMatch}\n` +
        `    active liquidity snapshot=${diff.activeSnapshot} onchain=${diff.activeOnchain} match=${diff.activeLiquidityMatch}\n` +
        `    boundaries checked (interior + b0)=${diff.boundariesChecked} net mismatches=${diff.netMismatches.length}\n` +
        `    right-edge truncation artifact=${
          diff.rightEdgeArtifact
            ? `tick ${diff.rightEdgeArtifact.tick}: snapshot ${diff.rightEdgeArtifact.snapshot} vs onchain ${diff.rightEdgeArtifact.onchain}`
            : "none"
        }\n` +
        `    baseline=${repro.baseline} clamped=${repro.baselineClamped} positions=${repro.positions.length}`,
    );

    // sqrtPriceX96 must be EXACT (initialize sets it directly).
    assert.equal(diff.sqrtPriceMatch, true, "reproduced sqrtPriceX96 must equal snapshot");
    // Active liquidity exact within the window (unless baseline was clamped).
    if (!repro.baselineClamped) {
      assert.equal(diff.activeLiquidityMatch, true, "reproduced active liquidity must equal snapshot");
    }
    // Every interior + b0 boundary's liquidityNet must match EXACTLY.
    assert.equal(
      diff.netMismatches.length,
      0,
      `interior boundary liquidityNet must match snapshot exactly (${diff.netMismatches
        .map((m) => `tick ${m.tick}: ${m.snapshot} vs ${m.onchain}`)
        .join("; ")})`,
    );
    assert.equal(diff.ok, true, "reproduction must be faithful");

    // The reconstructed pool's decoupled fee/grid are the REAL Slipstream values,
    // read from the pool's own getters — the production discovery path reads them.
    const poolFee = Number(
      await c.publicClient.readContract({ address: repro.pool, abi: v3PoolAbi as Abi, functionName: "fee" }),
    );
    assert.equal(poolFee, snap.fee, "reconstructed pool fee() equals the captured decoupled fee");

    // The Slipstream shim resolves the pool by its int24 tickSpacing key.
    const resolved = (await c.publicClient.readContract({
      address: slipFactory,
      abi: slipstreamFactoryAbi as Abi,
      functionName: "getPool",
      args: [repro.token0, repro.token1, snap.tickSpacing],
    })) as Hex;
    assert.equal(resolved.toLowerCase(), repro.pool.toLowerCase(), "shim resolves the pool by its tickSpacing key");
  });

  it("runs EcoSwap through the reproduced Slipstream pool (wei-exact vs the neutral oracle)", async () => {
    // zeroForOne: tokenIn = token0 < token1 = tokenOut (matches prepare's downward
    // tick scan and the snapshot's lower-boundary staircase).
    const target = cookTarget(PROD_ENGINE, stack, v12);
    const tokenIn = repro.token0;
    const tokenOut = repro.token1;
    const caller = c.account0;

    // Size the trade so it crosses several reconstructed initialized ticks but
    // stays within the reconstructed-band budget (see MIN_TICK / budget note). The
    // live price sits inside the very deep [tick 1, tick 2) band (active L ≈
    // 8.76e15), so ~101.7k USDC is needed just to walk DOWN to the tick-1 boundary.
    // ~150k USDC crosses tick 1 → 0 → −1 and lands at tick −2 — a GENUINE interior
    // liquidity cut, comfortably above the ~154k budget ceiling / the price-limit
    // floor (asserted below via afterTick > MIN_TICK).
    const amountIn = parseUnits("150000", 6);

    const poolConfig = slipPoolConfig(tokenIn, tokenOut);

    // Fund + approve the caller for tokenIn.
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);

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
    assert.equal(v3Count, 1, "should discover exactly the 1 reproduced Slipstream pool");
    assert.equal(prepared.pools.length, 1, "exactly one direct pool");
    assert.equal(prepared.routes.length, 0, "no routes (baseTokens == swap pair)");
    assert.equal(
      prepared.pools[0].feePpm,
      snap.fee,
      "the fee READ from fee() threads into feePpm (Slipstream decouples fee from the tickSpacing key)",
    );
    assert.ok(
      cacheWindowedPools(prepared.pools) > 0,
      "should build a per-pool net-cache window from reconstructed ticks",
    );
    assert.ok(prepared.zeroForOne, "tokenIn < tokenOut → zeroForOne");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against reproduced Slipstream geometry");

    const poolInAfter = await balanceOf(c.publicClient, tokenIn, repro.pool);
    const poolOutAfter = await balanceOf(c.publicClient, tokenOut, repro.pool);
    const callerInAfter = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutAfter = await balanceOf(c.publicClient, tokenOut, caller);
    const { tick: tickAfter } = await getSlot0(c.publicClient, repro.pool);

    const spent = callerInBefore - callerInAfter;
    const received = callerOutAfter - callerOutBefore;

    assert.ok(spent > 0n, "caller should spend tokenIn");
    assert.ok(received > 0n, "caller should receive tokenOut > 0");
    assert.equal(poolInAfter - poolInBefore, spent, "pool tokenIn reserve increases by spent");
    assert.ok(poolOutBefore - poolOutAfter > 0n, "pool tokenOut reserve decreases");

    // zeroForOne moves the price DOWN — the live tick must have decreased, i.e. the
    // swap walked through reconstructed initialized ticks.
    assert.ok(
      tickAfter < tickBefore,
      `swap must cross reconstructed ticks (tick ${tickBefore} -> ${tickAfter})`,
    );
    // ...and landed at a GENUINE interior liquidity cut, NOT drained to the
    // price-limit floor (which would be a reconstructed-window artifact, not the
    // pool's real cut).
    assert.ok(
      tickAfter > MIN_TICK,
      `swap lands at an interior cut, not the price-limit floor (tick ${tickAfter})`,
    );

    // WEI-EXACT oracle cross-check: deterministic local state == prepared state, so
    // the neutral oracle (ecoswap.optimal.ts, via the bit-for-bit ecoSwapReference
    // adapter) allocates EXACTLY the on-chain spend for the single reproduced pool.
    const ref = ecoSwapReference(prepared, amountIn);
    const refIn = ref.perPoolInput[0] ?? 0n;
    assert.ok(refIn > 0n, "oracle allocates to the reproduced pool");
    assert.equal(spent, ref.totalInput, "single-pass: spent == oracle totalInput EXACTLY (to the wei)");
    assert.equal(spent, refIn, "per-pool awarded input == oracle to the wei");
    assert.equal(poolInAfter - poolInBefore, refIn, "pool tokenIn delta == oracle per-pool input to the wei");

    console.log(
      `  [slip-prod-mirror] swap landed: spent=${spent} received=${received}` +
        ` tick ${tickBefore}->${tickAfter} (crossed ticks)` +
        ` oracle totalInput=${ref.totalInput} perPool[0]=${refIn} (wei-exact)`,
    );
  });

  it("re-anchors to the live slot0 price when the Slipstream pool drifts after prepare", async () => {
    await c.testClient.revert({ id: cleanSnapshot });

    const target = cookTarget(PROD_ENGINE, stack, v12);
    const tokenIn = repro.token0;
    const tokenOut = repro.token1;
    const caller = c.account0;
    // The recipe's trade. Sized SMALL relative to the reconstructed-band budget so
    // that, AFTER a boundary-crossing drift, the re-anchored full-amountIn fill still
    // lands at a GENUINE interior liquidity cut (≈ tick −1), never at the price-limit
    // floor. drift (130k) + amountIn (10k) = 140k gross-in ≪ the ~154k budget.
    const amountIn = parseUnits("10000", 6);
    const poolConfig = slipPoolConfig(tokenIn, tokenOut);
    const { tick: preparedTick } = await getSlot0(c.publicClient, repro.pool);

    // PREPARE against the clean (pre-drift) tick state.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn },
      anvil.rpcUrl,
      cookTarget(PROD_ENGINE, stack, v12),
      caller,
      poolConfig,
      undefined,
      PROD_ENGINE,
    );
    const ref = ecoSwapReference(prepared, amountIn);
    const refV3 = ref.perPoolInput[0] ?? 0n;
    assert.ok(refV3 > 0n, "baseline allocates to the Slipstream pool");

    // DRIFT: push the Slipstream pool's price DOWN with a real swap routed through
    // the engine's swapV3 / uniswapV3SwapCallback path. This band is exceptionally
    // deep — ≈101.7k USDC just to walk from spot (tick 1) down to the tick-1 boundary
    // — so the drift is deliberately LARGE (130k USDC) to move the live tick by an
    // OBSERVABLE amount: it crosses tick 1 → 0 and lands the live tick at ≈ −1,
    // strictly below the prepared tick. A tiny drift here would leave the live price
    // essentially unchanged (sub-tick) and could NOT distinguish genuine Phase-B
    // live-price re-anchoring from stale-price behavior — so the drift must cross a
    // real initialized boundary. (This is why the drift is a fixed absolute size,
    // not a fraction of the tiny recipe fill.)
    const driftAmount = parseUnits("130000", 6);
    await driftPoolPrice(c, stack.sauceRouter, prepared.pools[0], tokenIn, tokenOut, true, driftAmount, caller);
    const { sqrtPriceX96: driftedSqrt, tick: driftedTick } = await getSlot0(c.publicClient, repro.pool);

    // The drift must have moved the LIVE tick by a discriminating amount — this is
    // the whole point: a re-anchoring recipe reads a DIFFERENT price than it prepared
    // against, so the test can distinguish live-price re-anchoring from stale-price
    // behavior only if the live tick actually changed.
    assert.ok(
      driftedTick < preparedTick,
      `drift crossed a real initialized boundary: live tick ${preparedTick} -> ${driftedTick}`,
    );
    assert.ok(driftedSqrt < BigInt(snap.sqrtPriceX96), "drift moved the live price below the prepared price");

    // EXECUTE the pre-drift bytecodes — Phase B must read the NEW slot0 price.
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, repro.pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against drifted slot0");

    const v3InDelta = (await balanceOf(c.publicClient, tokenIn, repro.pool)) - poolInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const { tick: afterTick } = await getSlot0(c.publicClient, repro.pool);

    // SINGLE-PASS RE-ANCHORING (input-anchored) — the SAME semantics the Uniswap-V3
    // prod-mirror sibling asserts. The solver re-reads the LIVE (drifted) slot0 price
    // in Phase B and walks the pool's frontier from THERE, spending the user's full
    // `amountIn` against the drifted price. With a SINGLE pool the whole trade lands
    // here regardless of drift — the drift moves WHERE the fill starts (and thus
    // ends), not HOW MUCH is spent. (The OLD two-pass solver was price-anchored and
    // filled only the gap to a prepared cut; single-pass deliberately spends the
    // trade. The re-anchoring is proven by driftedTick < preparedTick — Phase B read
    // the new live price — combined with a successful full-amount swap from it.)
    assert.ok(v3InDelta > 0n, "pool still participates");
    assert.equal(v3InDelta, spent, "single pool → spent == its fill");
    assert.ok(spent <= amountIn, "never overspends amountIn");
    // Input-anchored: it deploys the LARGE majority of the trade against the drifted
    // price. The >80% floor cleanly separates single-pass (spends the trade) from the
    // OLD two-pass gap-fill (which under this drift would have spent far less). With
    // this small `amountIn` well inside the post-drift depth the fill is a full 100%.
    assert.ok(
      spent >= (amountIn * 80n) / 100n,
      `spends the large majority of the trade against the drifted price (spent ${spent} of ${amountIn})`,
    );
    // ...and the re-anchored fill lands at a GENUINE interior liquidity cut, NOT the
    // price-limit floor. This is the discriminating guard the review asked for: a
    // regression that drains a re-anchored fill to the price limit (the old
    // window-edge MIN_TICK artifact, when the trade was sized past the reconstructed
    // depth) fails HERE.
    assert.ok(
      afterTick > MIN_TICK,
      `re-anchored fill lands at an interior cut, not the price-limit floor (tick ${afterTick})`,
    );
    // The fill walked DOWN from the drifted price (it moved the live tick further),
    // confirming it executed against the post-drift price rather than a stale one.
    assert.ok(
      afterTick <= driftedTick,
      `re-anchored fill walks down from the drifted price (drifted ${driftedTick} -> after ${afterTick})`,
    );

    console.log(
      `  [slip-prod-mirror] RUNTIME re-anchor (single-pass, input-anchored): ` +
        `drift ${driftAmount} moved live tick ${preparedTick}->${driftedTick}; ` +
        `then recipe spent ${spent} of amountIn ${amountIn} (baseline fill ${refV3}); ` +
        `tick ${driftedTick}->${afterTick}`,
    );
  });
});
