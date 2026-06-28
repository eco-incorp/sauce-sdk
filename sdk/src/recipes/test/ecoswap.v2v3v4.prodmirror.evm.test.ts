/**
 * EcoSwap PROD-MIRROR (Uniswap V2 + V3 + V4 in ONE swap) local EVM test —
 * NO fork, NO live RPC.
 *
 * This is the cross-version prod-mirror: it replays THREE real Base WETH/USDC
 * pools — V2 (constant-product), V3 (0.05% concentrated) and V4 (0.30% singleton)
 * — from their checked-in snapshots onto a SINGLE fresh anvil, sharing ONE local
 * token pair, then runs the compiled EcoSwap recipe ONCE so its water-fill splits
 * across all three AMM versions at once:
 *   - V3:  real @uniswap/v3-core factory + the snapshot's reconstructed tick profile
 *   - V2:  the canonical V2Pair runtime etched + funded to the captured reserves
 *   - V4:  the real Base PoolManager + StateView etched, pool re-minted to its ticks
 *
 * All three snapshots are WETH/USDC on Base captured at essentially the same price
 * (token0 = WETH for all), so they share orientation and a single sorted local pair
 * (token0 = tokenIn, zeroForOne). Because the V3 0.05% pool is the deepest + cheapest
 * fee tier, a large-enough trade pushes its marginal price below the V2 (0.30%) and
 * V4 (0.30%) starting marginals, so the water-fill allocates a slice to EVERY pool —
 * the whole point of this test.
 *
 * HEAVY: reproducing the V3 pool mints one position per initialised snapshot
 * boundary (~10 min, same cost as ecoswap.prodmirror.evm.test.ts). Part of the
 * EVM lane (`npm run test:recipes:evm`), not the fast path.
 *
 * Offline by design: loads the three checked-in snapshots. Recapture with the
 * per-version harness scripts (prod-snapshot.ts / v2-snapshot.ts / v4-snapshot.ts).
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.v2v3v4.prodmirror.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, type Hex, type Account } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  deploySortedTokens,
  deployV2Factory,
  setupEtchedV2Pool,
  etchV4Singletons,
  mint,
  approve,
  balanceOf,
  getSlot0,
  getV4Slot0,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import {
  type Engine,
  selectedEngines,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import { reproducePool, verifyReproduction, type ReproducedPool } from "./harness/reproduce-pool";
import { reproduceV4Pool, verifyV4Reproduction, type ReproducedV4Pool } from "./harness/reproduce-v4-pool";
import { withCachedState } from "./harness/state-cache";
import { driftPoolPrice } from "./harness/drift";
import type { ProdPoolSnapshot } from "./harness/prod-snapshot";
import type { ProdV2Snapshot } from "./harness/v2-snapshot";
import type { ProdV4Snapshot } from "./harness/v4-snapshot";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { Q96, FEE_DENOM, isqrt } from "./ecoswap.math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "fixtures", "snapshots");
const SYNTHETIC = "synthetic-wethusdc-500.json";
const HUGE = parseEther("1000000000");
/** Etched V2 pair address (distinct from any sequential CREATE address). */
const V2_PAIR_ADDR = "0x00000000000000000000000000000000ec05a2a2" as Hex;

// Single engine for this heavy test: picks the selected engine; default v12; ECO_ENGINE=v1 forces v1.
const PROD_ENGINE: Engine = selectedEngines()[0];

function load<T>(match: (f: string) => boolean): T | null {
  let files: string[] = [];
  try {
    files = readdirSync(SNAPSHOT_DIR).filter(match);
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(SNAPSHOT_DIR, files[0]), "utf-8")) as T;
}

/** Exact constant-product output (0.3% fee) the engine computes for `amountIn`. */
function cpAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const amountInWithFee = amountIn * 997n;
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
}

const v3snap = load<ProdPoolSnapshot>((f) => f.endsWith("-500.json") && f !== SYNTHETIC);
const v2snap = load<ProdV2Snapshot>((f) => /-v2-.*\.json$/.test(f));
const v4snap = load<ProdV4Snapshot>((f) => /-v4-.*\.json$/.test(f));
const haveAll = !!v3snap && !!v2snap && !!v4snap;

describe("EcoSwap prod-mirror V2+V3+V4 (one swap across all three reproduced Base pools)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let v2Factory: Hex;
  let poolManager: Hex;
  let stateView: Hex;
  let tokenIn: Hex; // local token0 == every snapshot's token0 (WETH) → zeroForOne
  let tokenOut: Hex; // local token1 (USDC)
  let v3repro: ReproducedPool;
  let v4repro: ReproducedV4Pool;
  let v2pair: Hex;
  let v2ReserveIn: bigint;
  let v2ReserveOut: bigint;
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex; // pristine reconstructed state (for the drift case to revert to)

  before(async () => {
    if (!haveAll) return;
    console.log(
      `  [v2v3v4 prod-mirror]\n` +
        `    V3 ${v3snap!.symbol0}/${v3snap!.symbol1} fee=${v3snap!.fee} tick=${v3snap!.tick} ` +
        `L=${v3snap!.liquidity} (${v3snap!.ticks.length} boundaries — HEAVY)\n` +
        `    V4 fee=${v4snap!.fee} tick=${v4snap!.tick} L=${v4snap!.liquidity} (${v4snap!.ticks.length} boundaries)\n` +
        `    V2 (${v2snap!.source}) reserves ${v2snap!.reserve0}/${v2snap!.reserve1}`,
    );

    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);

    // Full deploy + reconstruction (heavy — one V3 mint per snapshot boundary),
    // cached once per engine (fixtures/anvil-state/prodmirror-v2v3v4-<engine>) so
    // later runs loadState in seconds. Recapture: RECAPTURE_ANVIL_STATE=1.
    const { manifest, fromCache } = await withCachedState<{
      stack: DeployedStack;
      v12: DeployedV12Stack | null;
      v2Factory: Hex;
      poolManager: Hex;
      stateView: Hex;
      tokenIn: Hex;
      tokenOut: Hex;
      v3repro: ReproducedPool;
      v4repro: ReproducedV4Pool;
      v2pair: Hex;
      v2ReserveIn: bigint;
      v2ReserveOut: bigint;
    }>({
      name: "prodmirror-v2v3v4",
      engine: PROD_ENGINE,
      c,
      build: async () => {
        await ensureMulticall3(c.publicClient, c.testClient);
        const s = await deployStack(c.walletClient, c.publicClient);
        const vf = await deployV2Factory(c.walletClient, c.publicClient);
        const v4 = await etchV4Singletons(c.publicClient, c.testClient);
        // ONE shared, sorted local token pair (token0 < token1) for ALL three pools.
        const tk = await deploySortedTokens(c.walletClient, c.publicClient);
        // ── V2: etch the canonical pair + fund it to the captured reserves ──
        const rIn = BigInt(v2snap!.reserve0); // tokenIn == token0
        const rOut = BigInt(v2snap!.reserve1);
        await mint(c.walletClient, c.publicClient, tk.token0, c.account0, rIn);
        await mint(c.walletClient, c.publicClient, tk.token1, c.account0, rOut);
        const pair = await setupEtchedV2Pool(
          c.walletClient, c.publicClient, c.testClient, vf, V2_PAIR_ADDR,
          tk.token0, tk.token1, rIn, rOut,
        );
        // ── V4: re-mint the captured tick profile into the etched PoolManager ──
        const v4r = await reproduceV4Pool(
          c.walletClient, c.publicClient, v4.poolManager, tk.token0, tk.token1, v4snap!, HUGE,
        );
        // ── V3: reconstruct the captured tick profile on the real v3-core factory ──
        // (heavy — one mint per snapshot boundary). Shares the pair via `tokens`.
        const v3r = await reproducePool(
          c.walletClient, c.publicClient, s.factory, s.helper, v3snap!, HUGE,
          undefined, { token0: tk.token0, token1: tk.token1 },
        );
        const v = await maybeDeployV12Stack(c, c.walletClient.account as Account);
        if (v) await approve(c.walletClient, c.publicClient, tk.token0, v.pot, HUGE);
        return {
          stack: s, v12: v, v2Factory: vf, poolManager: v4.poolManager, stateView: v4.stateView,
          tokenIn: tk.token0, tokenOut: tk.token1, v3repro: v3r, v4repro: v4r,
          v2pair: pair, v2ReserveIn: rIn, v2ReserveOut: rOut,
        };
      },
    });
    console.log(
      `  [v2v3v4 prod-mirror] state ${fromCache ? "LOADED from cache" : "RECONSTRUCTED + cached"} (engine ${PROD_ENGINE})`,
    );
    stack = manifest.stack;
    v12 = manifest.v12;
    v2Factory = manifest.v2Factory;
    poolManager = manifest.poolManager;
    stateView = manifest.stateView;
    tokenIn = manifest.tokenIn;
    tokenOut = manifest.tokenOut;
    v3repro = manifest.v3repro;
    v4repro = manifest.v4repro;
    v2pair = manifest.v2pair;
    v2ReserveIn = manifest.v2ReserveIn;
    v2ReserveOut = manifest.v2ReserveOut;

    // Combined discovery config: all three factories, both fee tiers (V3=500,
    // V4=3000), baseTokens = the swap pair so the route loop yields 0 routes.
    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3 (prod-mirror)" },
        { address: poolManager, stateView, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Local UniV4 (prod-mirror)" },
        { address: v2Factory, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Local UniV2 (prod-mirror)" },
      ],
      feeTiers: [v3snap!.fee, v4snap!.fee],
      baseTokens: [tokenIn, tokenOut],
    };

    // Pristine reconstructed state — the drift case reverts here so it prepares
    // and executes against the SAME pools the no-drift case did, independently.
    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  it("reproduces all three pools' state (V2 reserves, V3 ticks, V4 ticks)", async () => {
    if (!haveAll) {
      console.log("  [v2v3v4 prod-mirror] missing one of the three snapshots — skipping");
      return;
    }

    // V3 tick state.
    const v3diff = await verifyReproduction(c.publicClient, v3repro.pool, v3snap!, {
      baselineClamped: v3repro.baselineClamped,
    });
    assert.equal(v3diff.sqrtPriceMatch, true, "V3 reproduced sqrtPriceX96 must equal snapshot");
    if (!v3repro.baselineClamped) {
      assert.equal(v3diff.activeLiquidityMatch, true, "V3 reproduced active liquidity must equal snapshot");
    }
    assert.equal(v3diff.netMismatches.length, 0, "V3 interior boundary nets must match exactly");
    assert.equal(v3diff.ok, true, "V3 reproduction must be faithful");

    // V4 tick state.
    const v4diff = await verifyV4Reproduction(c.publicClient, stateView, v4repro, v4snap!);
    assert.equal(v4diff.sqrtPriceMatch, true, "V4 reproduced sqrtPriceX96 must equal snapshot");
    if (!v4repro.baselineClamped) {
      assert.equal(v4diff.activeLiquidityMatch, true, "V4 reproduced active liquidity must equal snapshot");
    }
    assert.equal(v4diff.ok, true, "V4 reproduction must be faithful");

    // V2 reserves.
    const r0 = await balanceOf(c.publicClient, tokenIn, v2pair);
    const r1 = await balanceOf(c.publicClient, tokenOut, v2pair);
    assert.equal(r0, v2ReserveIn, "V2 reproduced reserve0 must equal snapshot");
    assert.equal(r1, v2ReserveOut, "V2 reproduced reserve1 must equal snapshot");

    console.log(
      `  [v2v3v4 prod-mirror] reproductions OK — ` +
        `V3 boundaries=${v3diff.boundariesChecked} positions=${v3repro.positions.length}, ` +
        `V4 positions=${v4repro.positions.length}, V2 reserves=${r0}/${r1}`,
    );
  });

  it("runs ONE EcoSwap that splits across V2 + V3 + V4", async () => {
    if (!haveAll) return;
    const caller = c.account0;
    const target = cookTarget(PROD_ENGINE, stack, v12);

    // Size the trade so the V3 0.05% pool's marginal price is pushed comfortably
    // below the V2/V4 0.30% starting marginals → all three pools get a slice.
    const amountIn = parseEther("120");

    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);

    // Per-pool tokenIn balances (the swap input lands in each pool/manager/pair).
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3repro.pool);
    const v4InBefore = await balanceOf(c.publicClient, tokenIn, poolManager);
    const v2InBefore = await balanceOf(c.publicClient, tokenIn, v2pair);
    const v2OutBefore = await balanceOf(c.publicClient, tokenOut, v2pair);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const v3Before = await getSlot0(c.publicClient, v3repro.pool);
    const v4Before = await getV4Slot0(c.publicClient, stateView, v4repro.poolId);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(PROD_ENGINE, stack, v12), caller, poolConfig,
      // Cross-version split demo: keep all three real pools regardless of the
      // relative-depth filter (the real V2/V4 are genuinely shallow vs the V3 500
      // pool; the dedicated all-pools test exercises the filter instead).
      { minRelBps: 0 },
      PROD_ENGINE,
    );

    // Discovery must surface exactly one pool of each version.
    const v3Pools = prepared.pools.filter((p) => p.poolType === SwapPoolType.UniV3);
    const v4Pools = prepared.pools.filter((p) => p.poolType === SwapPoolType.UniV4);
    const v2Pools = prepared.pools.filter((p) => p.isV2);
    assert.equal(v3Pools.length, 1, "discovers exactly 1 V3 pool");
    assert.equal(v4Pools.length, 1, "discovers exactly 1 V4 pool");
    assert.equal(v2Pools.length, 1, "discovers exactly 1 V2 pool");
    assert.equal(prepared.pools.length, 3, "exactly 3 direct pools, all versions");
    assert.equal(prepared.routes.length, 0, "no routes (baseTokens == swap pair)");
    assert.ok(prepared.zeroForOne, "tokenIn < tokenOut → zeroForOne");
    assert.ok(v4Pools[0].poolId === v4repro.poolId, "discovered V4 poolId matches reproduced pool");

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed across all three reproduced pools");

    const v2InAfter = await balanceOf(c.publicClient, tokenIn, v2pair);
    const v2OutAfter = await balanceOf(c.publicClient, tokenOut, v2pair);
    const v3InDelta = (await balanceOf(c.publicClient, tokenIn, v3repro.pool)) - v3InBefore;
    const v4InDelta = (await balanceOf(c.publicClient, tokenIn, poolManager)) - v4InBefore;
    const v2InDelta = v2InAfter - v2InBefore;
    const v2OutDelta = v2OutBefore - v2OutAfter;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;
    const v3After = await getSlot0(c.publicClient, v3repro.pool);
    const v3TickBefore = v3Before.tick;
    const v3TickAfter = v3After.tick;
    const v4After = await getV4Slot0(c.publicClient, stateView, v4repro.poolId);

    // The core assertion: a slice landed in EVERY version's pool.
    assert.ok(v3InDelta > 0n, "V3 pool received tokenIn");
    assert.ok(v4InDelta > 0n, "V4 PoolManager received tokenIn");
    assert.ok(v2InDelta > 0n, "V2 pair received tokenIn");

    // Conservation: total spent == sum of the three pool inputs (no routes).
    assert.equal(v3InDelta + v4InDelta + v2InDelta, spent, "spent == Σ per-pool tokenIn deltas");
    assert.ok(spent > 0n, "caller spends tokenIn");
    assert.ok(received > 0n, "caller receives tokenOut");
    assert.ok(spent <= amountIn, "never overspends amountIn");
    assert.ok(spent >= (amountIn * 90n) / 100n, `deploys most of input (spent ${spent} of ${amountIn})`);

    // Concentrated pools moved down (zeroForOne) and crossed reconstructed ticks.
    assert.ok(v3TickAfter < v3TickBefore, `V3 crossed ticks (${v3TickBefore} -> ${v3TickAfter})`);
    assert.ok(v4After.sqrtPriceX96 < v4Before.sqrtPriceX96, "V4 price moved down");
    assert.ok(v4After.tick <= v4Before.tick, `V4 tick non-increasing (${v4Before.tick} -> ${v4After.tick})`);

    // PROD-ACCURATE V2 leg: its output equals the EXACT constant-product result for
    // the input it received against the captured reserves (engine 997/1000 math).
    assert.equal(
      v2OutDelta,
      cpAmountOut(v2InDelta, v2ReserveIn, v2ReserveOut),
      "V2 leg output must equal exact constant-product for its input",
    );

    // Oracle cross-check: deterministic local state == prepared state, so the
    // reference solver's per-pool split should track the on-chain per-pool spend.
    const ref = ecoSwapReference(prepared, amountIn);
    const v3Idx = prepared.pools.findIndex((p) => p.poolType === SwapPoolType.UniV3);
    const v4Idx = prepared.pools.findIndex((p) => p.poolType === SwapPoolType.UniV4);
    const v2Idx = prepared.pools.findIndex((p) => p.isV2);
    const refV3 = ref.perPoolInput[v3Idx] ?? 0n;
    const refV4 = ref.perPoolInput[v4Idx] ?? 0n;
    const refV2 = ref.perPoolInput[v2Idx] ?? 0n;
    assert.ok(refV3 > 0n && refV4 > 0n && refV2 > 0n, "oracle also allocates to all three pools");

    const within = (onchain: bigint, oracle: bigint) => {
      if (oracle === 0n) return onchain === 0n;
      const diff = onchain > oracle ? onchain - oracle : oracle - onchain;
      const rel = Number(diff) / Number(onchain > oracle ? onchain : oracle);
      return rel < 0.15 || diff < parseEther("1");
    };
    assert.ok(within(v3InDelta, refV3), `V3 spend ${v3InDelta} vs oracle ${refV3}`);
    assert.ok(within(v4InDelta, refV4), `V4 spend ${v4InDelta} vs oracle ${refV4}`);
    assert.ok(within(v2InDelta, refV2), `V2 spend ${v2InDelta} vs oracle ${refV2}`);

    // ── Marginal-price equalization (the DEFINING EcoSwap invariant) ──
    // The solver equalizes each pool's POST-FEE marginal price, not its spot price.
    // So after the swap the three pools sit at DIFFERENT spot prices that differ by
    // exactly their fee tiers, while spot²·(1−fee) — i.e. the fee-adjusted out/in
    // sqrt marginal — converges to the same water-fill cut for all three.
    const Q192 = Q96 * Q96;
    const sqrtScale = (feePpm: bigint) => isqrt((FEE_DENOM - feePpm) * FEE_DENOM);
    // Mirrors prepare.ts feeAdjust / the sauce script's fee-adjust exactly.
    const feeAdjOutIn = (outInSqrt: bigint, feePpm: bigint) =>
      (outInSqrt * sqrtScale(feePpm)) / FEE_DENOM;

    // zeroForOne → the out/in spot sqrt IS the pool's real sqrtPrice (V3/V4).
    const v3FeeAdj = feeAdjOutIn(v3After.sqrtPriceX96, 500n);
    const v4FeeAdj = feeAdjOutIn(v4After.sqrtPriceX96, 3000n);
    // V2 out/in spot sqrt from post-swap reserves (matches the sauce curSqrt).
    const v2OutInSqrt = isqrt((v2OutAfter * Q192) / v2InAfter);
    const v2FeeAdj = feeAdjOutIn(v2OutInSqrt, 3000n);

    const relDiff = (a: bigint, b: bigint) => {
      const hi = a > b ? a : b;
      const lo = a > b ? b : a;
      return hi === 0n ? 0 : Number(hi - lo) / Number(hi);
    };
    const maxPair = Math.max(
      relDiff(v3FeeAdj, v4FeeAdj),
      relDiff(v3FeeAdj, v2FeeAdj),
      relDiff(v4FeeAdj, v2FeeAdj),
    );
    // All three post-fee marginals equalize (within tick/bracket discretization).
    assert.ok(maxPair < 0.005, `post-fee marginals must equalize across pools (max pairwise rel ${maxPair})`);
    // …and they sit at the solver's common cut (the water-fill level).
    assert.ok(relDiff(v3FeeAdj, ref.cutSqrtAdj) < 0.005, `V3 marginal at cut (${v3FeeAdj} vs ${ref.cutSqrtAdj})`);
    assert.ok(relDiff(v4FeeAdj, ref.cutSqrtAdj) < 0.005, `V4 marginal at cut (${v4FeeAdj} vs ${ref.cutSqrtAdj})`);
    assert.ok(relDiff(v2FeeAdj, ref.cutSqrtAdj) < 0.005, `V2 marginal at cut (${v2FeeAdj} vs ${ref.cutSqrtAdj})`);

    // Spot prices must genuinely DIFFER (else "equal marginal" would be trivial):
    // the lower-fee V3 pool ends cheaper (lower sqrt) than the 0.30% V2/V4 pools.
    assert.ok(v3After.sqrtPriceX96 < v4After.sqrtPriceX96, "V3 (0.05%) ends at a lower spot than V4 (0.30%)");

    console.log(
      `  [v2v3v4 prod-mirror] ONE swap split across 3 versions:\n` +
        `       spent=${spent} received=${received}\n` +
        `       V3 in=${v3InDelta} (oracle ${refV3}) tick ${v3TickBefore}->${v3TickAfter}\n` +
        `       V4 in=${v4InDelta} (oracle ${refV4}) tick ${v4Before.tick}->${v4After.tick}\n` +
        `       V2 in=${v2InDelta} (oracle ${refV2}) out=${v2OutDelta} (exact CP)\n` +
        `  [v2v3v4 prod-mirror] marginal-price sync (post-fee, out/in sqrt Q96):\n` +
        `       cut(oracle)=${ref.cutSqrtAdj}\n` +
        `       V3 spotSqrt=${v3After.sqrtPriceX96} feeAdj=${v3FeeAdj} (0.05%)\n` +
        `       V4 spotSqrt=${v4After.sqrtPriceX96} feeAdj=${v4FeeAdj} (0.30%)\n` +
        `       V2 spotSqrt=${v2OutInSqrt} feeAdj=${v2FeeAdj} (0.30%)\n` +
        `       max pairwise rel diff=${maxPair}`,
    );
  });

  it("adapts the split at RUNTIME when a pool's price drifts after prepare", async () => {
    if (!haveAll) return;
    // Revert to the pristine reconstructed pools so we prepare against the SAME
    // state the no-drift case saw, independently of it.
    await c.testClient.revert({ id: cleanSnapshot });

    const caller = c.account0;
    const target = cookTarget(PROD_ENGINE, stack, v12);
    const amountIn = parseEther("120");

    // 1) PREPARE + COMPILE against the clean (pre-drift) state. The bytecodes now
    //    embed a ladder/cut snapshotted from these prices.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, cookTarget(PROD_ENGINE, stack, v12), caller, poolConfig,
      // Cross-version split demo: keep all three real pools regardless of the
      // relative-depth filter (the real V2/V4 are genuinely shallow vs the V3 500
      // pool; the dedicated all-pools test exercises the filter instead).
      { minRelBps: 0 },
      PROD_ENGINE,
    );
    const ref = ecoSwapReference(prepared, amountIn);
    const v3Idx = prepared.pools.findIndex((p) => p.poolType === SwapPoolType.UniV3);
    const v4Idx = prepared.pools.findIndex((p) => p.poolType === SwapPoolType.UniV4);
    const v2Idx = prepared.pools.findIndex((p) => p.isV2);
    const refV3 = ref.perPoolInput[v3Idx] ?? 0n;
    const refV4 = ref.perPoolInput[v4Idx] ?? 0n;
    const refV2 = ref.perPoolInput[v2Idx] ?? 0n;
    assert.ok(refV3 > 0n && refV4 > 0n && refV2 > 0n, "baseline split funds all three pools");

    // 2) DRIFT: AFTER prepare, push the V3 pool's price DOWN with a real swap of
    //    ~1/3 of its baseline fill — moving its live price partway toward the cut.
    const driftAmount = refV3 / 3n;
    await driftPoolPrice(
      c, stack.sauceRouter, prepared.pools[v3Idx], tokenIn, tokenOut, true, driftAmount, caller,
    );
    const v3DriftedSqrt = (await getSlot0(c.publicClient, v3repro.pool)).sqrtPriceX96;

    // 3) Fund + record per-pool baselines AFTER the drift, then EXECUTE the
    //    pre-drift bytecodes — Phase B must re-anchor V3 to its new live price.
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3repro.pool);
    const v4InBefore = await balanceOf(c.publicClient, tokenIn, poolManager);
    const v2InBefore = await balanceOf(c.publicClient, tokenIn, v2pair);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against drifted state");

    const v3InDelta = (await balanceOf(c.publicClient, tokenIn, v3repro.pool)) - v3InBefore;
    const v4InDelta = (await balanceOf(c.publicClient, tokenIn, poolManager)) - v4InBefore;
    const v2InDelta = (await balanceOf(c.publicClient, tokenIn, v2pair)) - v2InBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));

    // ── The adaptation (SINGLE-PASS, input-anchored, WS2 #104) ──
    // The solver spends `amountIn` EXACTLY and re-anchors V3 to its LIVE (drifted-down)
    // slot0 price (it re-reads slot0 at cook, NOT the stale prepared price). V3's prepared
    // bracket window + always-on forward tick walk are PATH-ADDITIVE: starting from the
    // lower drifted price, the sweep fills less in the window but the forward walk streams
    // exactly the deficit further down the SAME tick profile, so V3's recipe-leg gross
    // lands at its prepared residual budget (= amountIn − V4 − V2) while V3's PRICE moves
    // strictly deeper than the no-drift run — that price re-anchoring IS the runtime
    // adaptation. (We deliberately do NOT assert "V3 shrinks": that describes a
    // RE-OPTIMIZING/price-anchored solver that would shed V3's share so drift+recipe ≈
    // baseline. Single-pass is input-anchored — it spends the user's full trade and lets
    // the drifted pool fill its prepared depth from the new live price, exactly as the
    // V2 single-pool drift case documents. The genuine correctness gates are: spends
    // amountIn exactly, conservation, and post-fee marginals equalize at the cut — all
    // asserted below. The combined drift+recipe input to V3 is LARGER than baseline,
    // i.e. the opposite of shrinking: the recipe added its full prepared share on top of
    // the drift.) ──
    const v3SqlAfter = (await getSlot0(c.publicClient, v3repro.pool)).sqrtPriceX96;
    assert.ok(v3InDelta > 0n, "V3 still participates");
    // Re-anchoring proof: the recipe read V3's LIVE (drifted) price, so V3's leg pushed
    // its price strictly BELOW the post-drift start — i.e. the recipe integrated from the
    // drifted price, not the stale prepared spot. (zeroForOne → price falls.)
    assert.ok(
      v3SqlAfter < v3DriftedSqrt,
      `V3 re-anchored to its live drifted price and filled further down (${v3DriftedSqrt} -> ${v3SqlAfter})`,
    );

    // Input-anchored: only V3 drifted; V2/V4 live prices never moved, so they fill their
    // full prepared depth to the common cut, and V3 takes the residual budget. The
    // recipe-leg fills track the baseline split closely (V3 is the residual; V2/V4 hold).
    // A small two-sided tolerance guards integer/bracket-granularity jitter at the cut.
    const near = (got: bigint, base: bigint) => {
      const hi = got > base ? got : base;
      const diff = got > base ? got - base : base - got;
      return hi === 0n ? got === 0n : Number(diff) / Number(hi) < 0.05;
    };
    assert.ok(near(v4InDelta, refV4), `V4 fill holds vs baseline (got ${v4InDelta}, baseline ${refV4})`);
    assert.ok(near(v2InDelta, refV2), `V2 fill holds vs baseline (got ${v2InDelta}, baseline ${refV2})`);
    assert.ok(near(v3InDelta, refV3), `V3 leg fills its residual share vs baseline (got ${v3InDelta}, baseline ${refV3})`);
    // Spends the user's full trade EXACTLY across the three pools (conservation).
    assert.equal(v3InDelta + v4InDelta + v2InDelta, spent, "spent == Σ per-pool deltas (drifted)");
    assert.ok(spent <= amountIn, "never overspends");
    assert.ok(spent >= (amountIn * 99n) / 100n, `spends the trade under drift (spent ${spent} of ${amountIn})`);

    // 4) Despite the drift, every pool still ends EQUALIZED at the common (now
    //    marginally deeper) cut — the recipe re-anchored V3 from its drifted price
    //    down to the SAME post-fee marginal the other pools reach. (We assert
    //    pairwise marginal equalization, NOT equality to the stale prepared
    //    `ref.cutSqrtAdj`: spending amountIn under drift moves the realised cut a
    //    little past the prepared one.)
    const Q192 = Q96 * Q96;
    const sqrtScale = (feePpm: bigint) => isqrt((FEE_DENOM - feePpm) * FEE_DENOM);
    const feeAdj = (outInSqrt: bigint, feePpm: bigint) => (outInSqrt * sqrtScale(feePpm)) / FEE_DENOM;
    const relDiff = (a: bigint, b: bigint) => {
      const hi = a > b ? a : b;
      const lo = a > b ? b : a;
      return hi === 0n ? 0 : Number(hi - lo) / Number(hi);
    };
    const v3After = await getSlot0(c.publicClient, v3repro.pool);
    const v4After = await getV4Slot0(c.publicClient, stateView, v4repro.poolId);
    const v2InAfter = await balanceOf(c.publicClient, tokenIn, v2pair);
    const v2OutAfter = await balanceOf(c.publicClient, tokenOut, v2pair);
    const v3FeeAdj = feeAdj(v3After.sqrtPriceX96, 500n);
    const v4FeeAdj = feeAdj(v4After.sqrtPriceX96, 3000n);
    const v2FeeAdj = feeAdj(isqrt((v2OutAfter * Q192) / v2InAfter), 3000n);
    const maxPair = Math.max(
      relDiff(v3FeeAdj, v4FeeAdj),
      relDiff(v3FeeAdj, v2FeeAdj),
      relDiff(v4FeeAdj, v2FeeAdj),
    );
    // Looser than the no-drift split's 0.5% bound: re-anchoring V3 from its drifted
    // price lands the realised cut at slightly coarser bracket granularity, so the
    // post-fee marginals equalize to ~0.5% rather than the no-drift ~0.13%. 1% is
    // still a tight cross-version agreement (the three pools carry different fees).
    assert.ok(maxPair < 0.01, `pools still equalize at the cut after drift (max pairwise rel ${maxPair})`);

    console.log(
      `  [v2v3v4 prod-mirror] RUNTIME adaptation under drift (single-pass, input-anchored):\n` +
        `       drifted V3 spotSqrt ${v3DriftedSqrt} -> post-recipe ${v3SqlAfter} (re-anchored, filled further down)\n` +
        `       V3 fill ${v3InDelta} (residual; baseline ${refV3}); V4 ${v4InDelta} (baseline ${refV4}), V2 ${v2InDelta} (baseline ${refV2}) held\n` +
        `       spent=${spent} of amountIn ${amountIn}; post-drift marginal sync max rel=${maxPair}`,
    );
  });
});
