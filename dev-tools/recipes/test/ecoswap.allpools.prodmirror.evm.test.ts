/**
 * EcoSwap ALL-POOLS PROD-MIRROR (Uniswap V3 ×4 tiers + PancakeSwap V3 + V2 + V4)
 * local EVM test — NO fork, NO live RPC.
 *
 * This is the "give it everything, then filter" test. It reproduces the FULL real
 * Base WETH/USDC pool universe on ONE anvil sharing ONE local token pair:
 *   - Uniswap V3 at all four fee tiers (100 / 500 / 3000 / 10000)
 *   - PancakeSwap V3 at all four tiers (100 / 500 / 2500 / 10000) — GENUINE pancake
 *     pool bytecode (calls pancakeV3SwapCallback, the engine's Pancake path)
 *   - Uniswap V2 (etched constant-product pair)
 *   - Uniswap V4 (etched PoolManager + StateView singleton)
 * and asserts the improved prepare phase:
 *   1. DISCOVERY breadth — with the relative filter OFF, EcoSwap discovers ALL of
 *      them across both forks and every tier (per-factory fee tiers surface
 *      Pancake's 2500, which a single global list would miss).
 *   2. RELATIVE-DEPTH FILTER — with the filter ON (default 1% of total liquidity),
 *      only the genuinely-deep pools survive; the shallow tiers AND the real (but
 *      comparatively thin) V2/V4 pools are dropped so we don't waste gas on dust.
 *   3. CROSS-FORK SPLIT — ONE EcoSwap splits across the survivors, landing input in
 *      BOTH a Uniswap pool (uniswapV3SwapCallback) AND a Pancake pool
 *      (pancakeV3SwapCallback) in a single cook(), with post-fee marginals equalized.
 *   4. RUNTIME DRIFT — after prepare, a real swap moves a survivor's price; the
 *      pre-drift bytecodes still re-anchor it to the common cut.
 *
 * For the SAME pair, raw active-L at spot is comparable across V2 (≡ a V3 range with
 * L=√k), V3 and V4, so the 1%-of-total filter is a sound marginal-depth gate. On the
 * real Base snapshots the survivors are the Uniswap 0.05% + 0.30% pools and BOTH deep
 * Pancake pools (0.01% + 0.05%); everything else is < 1% of the combined depth.
 *
 * HEAVY: full reconstruction of the four survivors mints one position per snapshot
 * boundary (~1200 boundaries total). Part of the EVM lane, not the fast path.
 *
 * Run: npx tsx --test recipes/test/ecoswap.allpools.prodmirror.evm.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, createPublicClient, http, defineChain, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  deploySortedTokens,
  deployV2Factory,
  deployPancakeDeployer,
  setupEtchedV2Pool,
  etchV4Singletons,
  createAndInitPool,
  createAndInitPancakePool,
  setupV4Pool,
  deployV4Helper,
  mint,
  approve,
  balanceOf,
  mintPosition,
  getSlot0,
  v3FactoryAbi,
  type DeployedStack,
} from "./harness/setup";
import { writeAndWait } from "./harness/deploy";
import { reproducePool, reproducePancakePool, type ReproducedPool } from "./harness/reproduce-pool";
import { driftPoolPrice } from "./harness/drift";
import type { ProdPoolSnapshot } from "./harness/prod-snapshot";
import type { ProdV2Snapshot } from "./harness/v2-snapshot";
import type { ProdV4Snapshot } from "./harness/v4-snapshot";
import { SwapPoolType, FactoryType, MULTICALL3, type ChainPoolConfig } from "../shared/constants";
import { discoverPools } from "../shared/pool-discovery";
import { ecoSwap } from "../ecoswap/index";
import { ecoSwapReference } from "./ecoswap.reference";
import { FEE_DENOM, isqrt } from "./ecoswap.math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "fixtures", "snapshots");
const HUGE = parseEther("100000000000"); // generous helper funding (covers the deep 0.30% pool)
const V2_PAIR_ADDR = "0x00000000000000000000000000000000ec05a2a2" as Hex;

function load<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(join(SNAPSHOT_DIR, file), "utf-8")) as T;
  } catch {
    return null;
  }
}

/** Exact constant-product output (0.3% fee) the engine computes for `amountIn`. */
function cpAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const amountInWithFee = amountIn * 997n;
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
}

// Uniswap V3 tiers (untagged fixtures) + Pancake V3 tiers (tag "pancake") + V2 + V4.
const uni = {
  100: load<ProdPoolSnapshot>("base-WETHUSDC-100.json"),
  500: load<ProdPoolSnapshot>("base-WETHUSDC-500.json"),
  3000: load<ProdPoolSnapshot>("base-WETHUSDC-3000.json"),
  10000: load<ProdPoolSnapshot>("base-WETHUSDC-10000.json"),
};
const cake = {
  100: load<ProdPoolSnapshot>("base-WETHUSDC-pancake100.json"),
  500: load<ProdPoolSnapshot>("base-WETHUSDC-pancake500.json"),
  2500: load<ProdPoolSnapshot>("base-WETHUSDC-pancake2500.json"),
  10000: load<ProdPoolSnapshot>("base-WETHUSDC-pancake10000.json"),
};
const v2snap = (() => {
  const f = readdirSync(SNAPSHOT_DIR).find((x) => /-v2-.*\.json$/.test(x));
  return f ? load<ProdV2Snapshot>(f) : null;
})();
const v4snap = (() => {
  const f = readdirSync(SNAPSHOT_DIR).find((x) => /-v4-.*\.json$/.test(x));
  return f ? load<ProdV4Snapshot>(f) : null;
})();

const haveAll =
  Object.values(uni).every(Boolean) &&
  Object.values(cake).every(Boolean) &&
  !!v2snap &&
  !!v4snap;

describe("EcoSwap ALL-POOLS prod-mirror (Uni V3 ×4 + Pancake V3 ×4 + V2 + V4; discover → filter → split)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v2Factory: Hex;
  let pancakeDeployer: Hex;
  let poolManager: Hex;
  let stateView: Hex;
  let tokenIn: Hex; // local token0 == every snapshot's token0 (WETH) → zeroForOne
  let tokenOut: Hex; // local token1 (USDC)
  let poolConfig: ChainPoolConfig;
  let cleanSnapshot: Hex;

  // Survivor pool addresses (deep — fully reconstructed).
  let uni500: ReproducedPool;
  let uni3000: ReproducedPool;
  let cake100: ReproducedPool;
  let cake500: ReproducedPool;
  // Droppee addresses (shallow — light-minted at real price + real active L).
  const droppees: { label: string; address: Hex }[] = [];
  let v2pair: Hex;
  let v2ReserveIn: bigint;
  let v2ReserveOut: bigint;

  /** Light-mint a V3/Pancake pool at its real snapshot price + real active liquidity. */
  async function lightMint(
    snap: ProdPoolSnapshot,
    create: (fee: number, ts: number, sqrtP: bigint) => Promise<Hex>,
  ): Promise<Hex> {
    const ts = snap.tickSpacing;
    const pool = await create(snap.fee, ts, BigInt(snap.sqrtPriceX96));
    const base = Math.floor(snap.tick / ts) * ts;
    // One position straddling spot carrying the snapshot's active L → liquidity() == L.
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, pool, c.account0,
      base - 50 * ts, base + 50 * ts, BigInt(snap.liquidity),
    );
    return pool;
  }

  before(async () => {
    if (!haveAll) return;

    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    v2Factory = await deployV2Factory(c.walletClient, c.publicClient);
    pancakeDeployer = await deployPancakeDeployer(c.walletClient, c.publicClient);
    const v4 = await etchV4Singletons(c.publicClient, c.testClient);
    poolManager = v4.poolManager;
    stateView = v4.stateView;

    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;

    // Fund + approve the minter for the light mints (helper pulls via transferFrom).
    await mint(c.walletClient, c.publicClient, tokenIn, c.account0, HUGE);
    await mint(c.walletClient, c.publicClient, tokenOut, c.account0, HUGE);
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);

    // ── Survivors: FULL reconstruction (real tick profiles) ──
    const pair = { token0: tokenIn, token1: tokenOut };
    uni500 = await reproducePool(c.walletClient, c.publicClient, stack.factory, stack.helper, uni[500]!, HUGE, undefined, pair);
    uni3000 = await reproducePool(c.walletClient, c.publicClient, stack.factory, stack.helper, uni[3000]!, HUGE, undefined, pair);
    cake100 = await reproducePancakePool(c.walletClient, c.publicClient, pancakeDeployer, stack.helper, cake[100]!, HUGE, pair);
    cake500 = await reproducePancakePool(c.walletClient, c.publicClient, pancakeDeployer, stack.helper, cake[500]!, HUGE, pair);

    // ── Droppees: light mint at real price + real active L (discovery + filter only) ──
    const mkUni = async (fee: number, ts: number, sqrtP: bigint) => {
      // A fresh UniswapV3Factory only enables 500/3000/10000 — enable e.g. the 100 tier.
      const existing = (await c.publicClient.readContract({
        address: stack.factory, abi: v3FactoryAbi, functionName: "feeAmountTickSpacing", args: [fee],
      })) as number;
      if (Number(existing) === 0) {
        await writeAndWait(c.walletClient, c.publicClient, {
          address: stack.factory, abi: v3FactoryAbi, functionName: "enableFeeAmount", args: [fee, ts],
        });
      }
      return createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, fee, sqrtP);
    };
    const mkCake = (fee: number, ts: number, sqrtP: bigint) =>
      createAndInitPancakePool(c.walletClient, c.publicClient, pancakeDeployer, tokenIn, tokenOut, fee, ts, sqrtP);

    droppees.push({ label: "uni-100", address: await lightMint(uni[100]!, mkUni) });
    droppees.push({ label: "uni-10000", address: await lightMint(uni[10000]!, mkUni) });
    droppees.push({ label: "cake-2500", address: await lightMint(cake[2500]!, mkCake) });
    droppees.push({ label: "cake-10000", address: await lightMint(cake[10000]!, mkCake) });

    // V4 droppee: single position at real price + real active L on the etched singleton.
    const v4Helper = await deployV4Helper(c.walletClient, c.publicClient, poolManager);
    {
      const ts = v4snap!.tickSpacing;
      const base = Math.floor(v4snap!.tick / ts) * ts;
      await setupV4Pool(
        c.walletClient, c.publicClient, v4Helper, tokenIn, tokenOut,
        v4snap!.fee, ts, BigInt(v4snap!.sqrtPriceX96),
        base - 50 * ts, base + 50 * ts, BigInt(v4snap!.liquidity), HUGE,
      );
    }

    // V2 droppee: etch the canonical pair funded to the captured reserves.
    v2ReserveIn = BigInt(v2snap!.reserve0); // tokenIn == token0 (WETH)
    v2ReserveOut = BigInt(v2snap!.reserve1);
    await mint(c.walletClient, c.publicClient, tokenIn, c.account0, v2ReserveIn);
    await mint(c.walletClient, c.publicClient, tokenOut, c.account0, v2ReserveOut);
    v2pair = await setupEtchedV2Pool(
      c.walletClient, c.publicClient, c.testClient, v2Factory, V2_PAIR_ADDR,
      tokenIn, tokenOut, v2ReserveIn, v2ReserveOut,
    );

    // Discovery config: BOTH V3 forks (each with its OWN fee tiers — Pancake's 2500
    // ≠ Uniswap's 3000), the V4 singleton, and the V2 factory. baseTokens == swap
    // pair → zero multi-hop routes (focus on direct-pool discovery + filtering).
    poolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3", feeTiers: [100, 500, 3000, 10000] },
        { address: pancakeDeployer, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local PancakeV3", feeTiers: [100, 500, 2500, 10000] },
        { address: poolManager, stateView, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Local UniV4", feeTiers: [v4snap!.fee] },
        { address: v2Factory, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Local UniV2" },
      ],
      feeTiers: [100, 500, 3000, 10000],
      baseTokens: [tokenIn, tokenOut],
    };

    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => {
    anvil?.stop();
  });

  // viem/anvil evm_revert consumes the snapshot (and any taken after it), so each
  // consumer reverts to the clean reconstructed state then re-snapshots for the next.
  async function revertToClean(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
  }

  it("discovers the FULL pool universe across forks + tiers; relative filter keeps only the deep pools", async () => {
    if (!haveAll) {
      console.log("  [all-pools] missing one or more snapshots — skipping");
      return;
    }
    const amountIn = parseEther("3000");
    const caller = c.account0;
    const isCake = (s: string) => /Pancake/i.test(s);

    // ── DISCOVERY breadth: discoverPools (no floors) must surface ALL ten pools ──
    const chainId = await c.publicClient.getChainId();
    const chain = defineChain({
      id: chainId, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [anvil.rpcUrl] } }, contracts: { multicall3: { address: MULTICALL3 } },
    });
    const client = createPublicClient({ chain, transport: http(anvil.rpcUrl, { timeout: 120_000 }) });
    const found = await discoverPools(tokenIn, tokenOut, client, poolConfig);
    const fUni = found.filter((p) => p.poolType === SwapPoolType.UniV3 && !isCake(p.source));
    const fCake = found.filter((p) => p.poolType === SwapPoolType.UniV3 && isCake(p.source));
    assert.equal(fUni.length, 4, "discovers all 4 Uniswap V3 tiers");
    assert.equal(fCake.length, 4, "discovers all 4 PancakeSwap V3 tiers (incl. 2500 via per-factory tiers)");
    assert.equal(found.filter((p) => p.poolType === SwapPoolType.UniV4).length, 1, "discovers the V4 pool");
    assert.equal(found.filter((p) => p.poolType === SwapPoolType.UniV2).length, 1, "discovers the V2 pair");
    assert.equal(found.length, 10, "ten real pools discovered across both forks + all tiers");
    // Pancake's 2500 tier — the one a single GLOBAL fee list would miss — is present.
    assert.ok(fCake.some((p) => p.fee === 2500), "Pancake 2500 tier discovered (per-factory fee tiers)");

    // ── Filter ON (default 1% of total liquidity): only the deep pools survive ──
    const deep = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, stack.sauceRouter, caller, poolConfig,
    );
    const keptUni = deep.prepared.pools.filter((p) => p.poolType === SwapPoolType.UniV3 && !isCake(p.source));
    const keptCake = deep.prepared.pools.filter((p) => p.poolType === SwapPoolType.UniV3 && isCake(p.source));
    const keptUniFees = keptUni.map((p) => p.feePpm).sort((a, b) => a - b);
    const keptCakeFees = keptCake.map((p) => p.feePpm).sort((a, b) => a - b);

    // Survivors: Uniswap 500 + 3000, Pancake 100 + 500. Everything else (shallow
    // tiers + the real-but-thin V2 & V4) is below 1% of the combined marginal depth.
    assert.deepEqual(keptUniFees, [500, 3000], "keeps the two deep Uniswap pools (0.05% + 0.30%)");
    assert.deepEqual(keptCakeFees, [100, 500], "keeps the two deep Pancake pools (0.01% + 0.05%)");
    assert.equal(deep.prepared.pools.filter((p) => p.isV2).length, 0, "drops the thin V2 pair");
    assert.equal(deep.prepared.pools.filter((p) => p.poolType === SwapPoolType.UniV4).length, 0, "drops the thin V4 pool");
    assert.equal(deep.prepared.pools.length, 4, "filter keeps exactly the 4 deep pools");

    console.log(
      `  [all-pools] discovered 10 (4 Uni + 4 Pancake + V2 + V4); filter kept 4: ` +
        `Uni{${keptUniFees.join(",")}} Pancake{${keptCakeFees.join(",")}}`,
    );
  });

  it("runs ONE EcoSwap splitting across BOTH Uniswap and Pancake (uniswap + pancake callbacks)", async () => {
    if (!haveAll) return;
    await revertToClean();

    const amountIn = parseEther("3000");
    const caller = c.account0;
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, stack.sauceRouter, amountIn);

    const survivors = [
      { label: "uni-500", address: uni500.pool, fee: 500n },
      { label: "uni-3000", address: uni3000.pool, fee: 3000n },
      { label: "cake-100", address: cake100.pool, fee: 100n },
      { label: "cake-500", address: cake500.pool, fee: 500n },
    ];
    const inBefore = new Map<string, bigint>();
    for (const s of survivors) inBefore.set(s.label, await balanceOf(c.publicClient, tokenIn, s.address));
    // Droppees must receive ZERO (filter excluded them from execution).
    const dropInBefore = new Map<string, bigint>();
    for (const d of droppees) dropInBefore.set(d.label, await balanceOf(c.publicClient, tokenIn, d.address));
    const v2InBefore = await balanceOf(c.publicClient, tokenIn, v2pair);
    const pmInBefore = await balanceOf(c.publicClient, tokenIn, poolManager);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const callerOutBefore = await balanceOf(c.publicClient, tokenOut, caller);

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, stack.sauceRouter, caller, poolConfig,
    );
    assert.equal(prepared.pools.length, 4, "only the 4 deep pools are executed");

    const { receipt } = await cook(c.walletClient, c.publicClient, stack.sauceRouter, bytecodes);
    assert.equal(receipt.status, "success", "cook() across Uniswap + Pancake must succeed");

    // Per-survivor executed input.
    const delta = new Map<string, bigint>();
    for (const s of survivors) {
      delta.set(s.label, (await balanceOf(c.publicClient, tokenIn, s.address)) - inBefore.get(s.label)!);
    }
    const uniIn = delta.get("uni-500")! + delta.get("uni-3000")!;
    const cakeIn = delta.get("cake-100")! + delta.get("cake-500")!;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - callerOutBefore;

    // The headline: input lands in BOTH forks in ONE cook → exercises BOTH
    // uniswapV3SwapCallback AND pancakeV3SwapCallback.
    assert.ok(uniIn > 0n, "Uniswap pools received tokenIn (uniswapV3SwapCallback path)");
    assert.ok(cakeIn > 0n, "Pancake pools received tokenIn (pancakeV3SwapCallback path)");
    const filled = survivors.filter((s) => delta.get(s.label)! > 0n);
    assert.ok(filled.length >= 3, `splits across >=3 of the 4 deep pools (filled ${filled.length})`);

    // Filtered-out pools got NOTHING (we didn't waste gas swapping dust pools).
    for (const d of droppees) {
      assert.equal(
        (await balanceOf(c.publicClient, tokenIn, d.address)) - dropInBefore.get(d.label)!, 0n,
        `dropped pool ${d.label} received no input`,
      );
    }
    assert.equal((await balanceOf(c.publicClient, tokenIn, v2pair)) - v2InBefore, 0n, "dropped V2 pair untouched");
    assert.equal((await balanceOf(c.publicClient, tokenIn, poolManager)) - pmInBefore, 0n, "dropped V4 pool untouched");

    // Conservation across the executed survivors (no routes).
    const sumSurvivors = [...delta.values()].reduce((a, b) => a + b, 0n);
    assert.equal(sumSurvivors, spent, "spent == Σ survivor tokenIn deltas");
    assert.ok(received > 0n, "caller received tokenOut");
    assert.ok(spent <= amountIn, "never overspends");

    // ── Marginal-price equalization across the filled pools (post-fee) ──
    const sqrtScale = (feePpm: bigint) => isqrt((FEE_DENOM - feePpm) * FEE_DENOM);
    const feeAdj = (outInSqrt: bigint, feePpm: bigint) => (outInSqrt * sqrtScale(feePpm)) / FEE_DENOM;
    const relDiff = (a: bigint, b: bigint) => {
      const hi = a > b ? a : b;
      const lo = a > b ? b : a;
      return hi === 0n ? 0 : Number(hi - lo) / Number(hi);
    };
    const ref = ecoSwapReference(prepared, amountIn);
    const marg: { label: string; adj: bigint }[] = [];
    for (const s of survivors) {
      if (delta.get(s.label)! <= 0n) continue;
      const { sqrtPriceX96 } = await getSlot0(c.publicClient, s.address); // zeroForOne → out/in == real sqrt
      marg.push({ label: s.label, adj: feeAdj(sqrtPriceX96, s.fee) });
    }
    assert.ok(marg.length >= 3, "need >=3 filled pools to check equalization");
    let maxPair = 0;
    for (let i = 0; i < marg.length; i++)
      for (let j = i + 1; j < marg.length; j++) maxPair = Math.max(maxPair, relDiff(marg[i].adj, marg[j].adj));
    assert.ok(maxPair < 0.01, `post-fee marginals equalize across forks (max pairwise rel ${maxPair})`);
    for (const m of marg) {
      assert.ok(relDiff(m.adj, ref.cutSqrtAdj) < 0.01, `${m.label} marginal at the cut (${m.adj} vs ${ref.cutSqrtAdj})`);
    }

    console.log(
      `  [all-pools] ONE EcoSwap split across forks:\n` +
        `       spent=${spent} received=${received}\n` +
        `       Uniswap in: 500=${delta.get("uni-500")} 3000=${delta.get("uni-3000")} (Σ ${uniIn})\n` +
        `       Pancake in: 100=${delta.get("cake-100")} 500=${delta.get("cake-500")} (Σ ${cakeIn})\n` +
        `       filled ${filled.length}/4; post-fee marginal max pairwise rel=${maxPair}; cut=${ref.cutSqrtAdj}`,
    );
  });

  it("adapts the split at RUNTIME when a Pancake survivor drifts after prepare", async () => {
    if (!haveAll) return;
    await revertToClean();

    const amountIn = parseEther("3000");
    const caller = c.account0;

    // PREPARE + COMPILE against the clean state.
    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn, tokenOut, amountIn }, anvil.rpcUrl, stack.sauceRouter, caller, poolConfig,
    );
    const ref = ecoSwapReference(prepared, amountIn);
    // Locate the deep Pancake 0.05% survivor in the prepared set (drift target).
    const cakeIdx = prepared.pools.findIndex(
      (p) => p.address.toLowerCase() === cake500.pool.toLowerCase(),
    );
    assert.ok(cakeIdx >= 0, "deep Pancake pool is among the executed survivors");
    const refCake = ref.perPoolInput[cakeIdx] ?? 0n;
    assert.ok(refCake > 0n, "baseline split funds the Pancake survivor");

    // DRIFT: push the Pancake pool's price down with a real swap (~1/3 of its fill).
    const driftAmount = refCake / 3n;
    await driftPoolPrice(
      c, stack.sauceRouter, prepared.pools[cakeIdx], tokenIn, tokenOut, true, driftAmount, caller,
    );

    // Fund + execute the PRE-DRIFT bytecodes — Phase B must re-anchor to live price.
    await mint(c.walletClient, c.publicClient, tokenIn, caller, amountIn);
    await approve(c.walletClient, c.publicClient, tokenIn, stack.sauceRouter, amountIn);
    const cakeInBefore = await balanceOf(c.publicClient, tokenIn, cake500.pool);
    const callerInBefore = await balanceOf(c.publicClient, tokenIn, caller);

    const { receipt } = await cook(c.walletClient, c.publicClient, stack.sauceRouter, bytecodes);
    assert.equal(receipt.status, "success", "cook() must succeed against drifted state");

    const cakeInDelta = (await balanceOf(c.publicClient, tokenIn, cake500.pool)) - cakeInBefore;
    const spent = callerInBefore - (await balanceOf(c.publicClient, tokenIn, caller));

    // The Pancake pool's runtime fill SHRANK (its live price already moved toward the cut).
    assert.ok(cakeInDelta >= 0n, "Pancake pool still participates (or is filled)");
    assert.ok(cakeInDelta < refCake, `Pancake fill adapts DOWN vs baseline (got ${cakeInDelta}, baseline ${refCake})`);
    const within = (a: bigint, b: bigint, tol: number) => {
      const hi = a > b ? a : b;
      const lo = a > b ? b : a;
      return hi === 0n ? true : Number(hi - lo) / Number(hi) < tol;
    };
    // drift + recipe ≈ baseline (gross input from prepared price → cut is path-additive).
    assert.ok(
      within(driftAmount + cakeInDelta, refCake, 0.06),
      `drift(${driftAmount}) + recipe(${cakeInDelta}) ≈ baseline Pancake (${refCake})`,
    );
    assert.ok(spent <= amountIn, "never overspends under drift");

    console.log(
      `  [all-pools] RUNTIME drift on Pancake 0.05%: drift=${driftAmount} + recipe=${cakeInDelta} ` +
        `≈ baseline=${refCake}; spent=${spent}`,
    );
  });
});
