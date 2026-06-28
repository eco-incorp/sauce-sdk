/**
 * DIAGNOSTIC (not a test): measure each discovered pool's IN-RANGE capacity the way
 * the on-chain lens does, to settle the all-pools survivor-set question (is the
 * Pancake 0.01% tier correctly dropped, or is the lens under-measuring it?).
 *
 * It boots a fresh anvil, loads the CACHED allpools reconstructed state
 * (fixtures/anvil-state/allpools-<engine>), runs the lens with the filter OFF
 * (minRelBps=0 → every alive pool is emitted with its full forward tick walk), then
 * replicates the lens's MEASURE-A (common floor) + MEASURE-B (per-pool windowed
 * capacity) walks OFF-CHAIN over the lens's own emitted tick data — using the exact
 * same fee-adjust / bracket-capacity / out-in math the lens uses. For each pool it
 * prints: in-range capacity, % of Σ, the 1% floor, and PASS/DROP, plus Pancake-100's
 * reproduced active-L profile so we can see whether its spot L sits in a thin band.
 *
 * Run (needs the cached blob; capture it first via the allpools test with
 * RECAPTURE_ANVIL_STATE=1):
 *   npx tsx src/recipes/test/harness/lens-capacity-probe.ts
 *   ECO_ENGINE=v1 npx tsx src/recipes/test/harness/lens-capacity-probe.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { parseEther, createPublicClient, http, defineChain, type Hex } from "viem";

import { startAnvil } from "./anvil";
import { makeClients } from "./clients";
import { selectedEngines } from "./engine";
import { runLens, type LensPool } from "../../ecoswap/lens";
import { getTickLiquidityNet } from "./setup";
import { SwapPoolType, FactoryType, MULTICALL3, type ChainPoolConfig } from "../../shared/constants";
import type { ProdPoolSnapshot } from "./prod-snapshot";
import type { ProdV4Snapshot } from "./v4-snapshot";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "..", "fixtures", "snapshots");
const STATE_DIR = join(__dirname, "..", "fixtures", "anvil-state");

const Q96 = 1n << 96n;
const Q192 = Q96 * Q96;
const FEE_DENOM = 1_000_000n;

function isqrt(x: bigint): bigint {
  if (x <= 0n) return 0n;
  let z = x;
  let y = (z + 1n) / 2n;
  while (y < z) {
    z = y;
    y = (x / y + y) / 2n;
  }
  return z;
}
function sqrtOneMinusFeeScaled(feePpm: number): bigint {
  return isqrt(BigInt(1_000_000 - feePpm) * FEE_DENOM);
}
function feeAdjust(sqrtSpot: bigint, feePpm: number): bigint {
  return (sqrtSpot * sqrtOneMinusFeeScaled(feePpm)) / FEE_DENOM;
}
function bracketCapacity(L: bigint, sqrtNear: bigint, sqrtFar: bigint, feePpm: number): bigint {
  if (L <= 0n || sqrtFar <= 0n || sqrtNear <= sqrtFar) return 0n;
  const effIn = (L * Q96) / sqrtFar - (L * Q96) / sqrtNear;
  if (effIn <= 0n) return 0n;
  return (effIn * FEE_DENOM) / BigInt(1_000_000 - feePpm);
}
function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = BigInt(tick < 0 ? -tick : tick);
  let ratio =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  const mul = (m: bigint) => {
    ratio = (ratio * m) >> 128n;
  };
  if (absTick & 0x2n) mul(0xfff97272373d413259a46990580e213an);
  if (absTick & 0x4n) mul(0xfff2e50f5f656932ef12357cf3c7fdccn);
  if (absTick & 0x8n) mul(0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if (absTick & 0x10n) mul(0xffcb9843d60f6159c9db58835c926644n);
  if (absTick & 0x20n) mul(0xff973b41fa98c081472e6896dfb254c0n);
  if (absTick & 0x40n) mul(0xff2ea16466c96a3843ec78b326b52861n);
  if (absTick & 0x80n) mul(0xfe5dee046a99a2a811c461f1969c3053n);
  if (absTick & 0x100n) mul(0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if (absTick & 0x200n) mul(0xf987a7253ac413176f2b074cf7815e54n);
  if (absTick & 0x400n) mul(0xf3392b0822b70005940c7a398e4b70f3n);
  if (absTick & 0x800n) mul(0xe7159475a2c29b7443b29c7fa6e889d9n);
  if (absTick & 0x1000n) mul(0xd097f3bdfd2022b8845ad8f792aa5825n);
  if (absTick & 0x2000n) mul(0xa9f746462d870fdf8a65dc1f90e061e5n);
  if (absTick & 0x4000n) mul(0x70d869a156d2a1b890bb3df62baf32f7n);
  if (absTick & 0x8000n) mul(0x31be135f97d08fd981231505542fcfa6n);
  if (absTick & 0x10000n) mul(0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if (absTick & 0x20000n) mul(0x5d6af8dedb81196699c329225ee604n);
  if (absTick & 0x40000n) mul(0x2216e584f5fa1ea926041bedfe98n);
  if (absTick & 0x80000n) mul(0x48a170391f7dc42444e8fa2n);
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}
function toOutIn(sqrtReal: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? sqrtReal : Q192 / sqrtReal;
}

/**
 * Walk a survivor pool's forward (swap-direction) brackets EXACTLY as the lens does,
 * accumulating gross-input capacity until cumIn >= amountIn or the fee-adjusted price
 * falls to/below `floorAdj` (0 disables the floor stop, used for the solo walk to
 * find each pool's amountIn-coverage excursion). Returns { cap, soloFloorAdj }.
 *   - cap          = cumIn at the stop (windowed capacity to the floor / amountIn).
 *   - soloFloorAdj = feeAdj(far) at the step cumIn first crosses amountIn (0 if it
 *                    never does within the walked window) — the MEASURE-A solo floor.
 */
function walkPool(
  p: LensPool,
  zeroForOne: boolean,
  amountIn: bigint,
  floorAdj: bigint,
): { cap: bigint; soloFloorAdj: bigint } {
  const fee = p.fee;
  const ts = p.tickSpacing;
  // V2 pools carry no ticks (tickSpacing 0) — skip the tick walk; the on-chain lens
  // computes V2 capacity in closed form and the header reflects it. (The diagnostic
  // focuses on the V3/Pancake survivor question; V2 is dropped anyway.)
  if (ts <= 0 || p.poolType === SwapPoolType.UniV2) return { cap: 0n, soloFloorAdj: 0n };
  // Snap spot to the tickSpacing grid (real tick index, NOT shifted). The first
  // far boundary in the swap direction: for zeroForOne (price DOWN) it's the snapped
  // boundary at/below spot; for oneForZero (price UP) one tickSpacing above it.
  const base = Math.floor(p.tick / ts) * ts;
  let curTick = zeroForOne ? base : base + ts;
  let L = p.liquidity;
  let nearReal = p.sqrtPriceX96; // exact spot real sqrt (first bracket starts here)
  let cumIn = 0n;
  let soloFloorAdj = 0n;
  const steps = Math.max(p.scannedForward, 1);
  for (let k = 0; k < steps; k++) {
    // The bracket spans [nearReal, far boundary]; far boundary's real sqrt is the
    // exact tick-aligned sqrt at curTick (TickMath), mirroring the lens's stepReal.
    const farRealExact = getSqrtRatioAtTick(curTick);
    const nearOI = toOutIn(nearReal, zeroForOne);
    const farOI = toOutIn(farRealExact, zeroForOne);
    if (L > 0n && nearOI > farOI) {
      cumIn += bracketCapacity(L, nearOI, farOI, fee);
    }
    // Apply the crossed boundary's net to L (the lens reads net keyed by tick index).
    const net = p.net.get(curTick) ?? 0n;
    if (zeroForOne) {
      L = net < 0n ? L + -net : L >= net ? L - net : 0n;
      curTick -= ts;
    } else {
      L = net < 0n ? (L >= -net ? L - -net : 0n) : L + net;
      curTick += ts;
    }
    nearReal = farRealExact;
    const fa = feeAdjust(farOI, fee);
    if (cumIn >= amountIn && soloFloorAdj === 0n) soloFloorAdj = fa;
    if (cumIn >= amountIn) break;
    if (floorAdj > 0n && fa <= floorAdj) break;
  }
  return { cap: cumIn, soloFloorAdj };
}

function load<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(join(SNAPSHOT_DIR, file), "utf-8")) as T;
  } catch {
    return null;
  }
}

async function main() {
  const engine = selectedEngines()[0];
  const blob = join(STATE_DIR, `allpools-${engine}.state.json.gz`);
  const manifestPath = join(STATE_DIR, `allpools-${engine}.manifest.json`);
  if (!existsSync(blob) || !existsSync(manifestPath)) {
    console.error(
      `cached allpools state for engine ${engine} not found at ${blob}\n` +
        `capture it first: RECAPTURE_ANVIL_STATE=1 npx tsx --test src/recipes/test/ecoswap.allpools.prodmirror.evm.test.ts`,
    );
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")).data as {
    pancakeDeployer: Hex;
    poolManager: Hex;
    stateView: Hex;
    tokenIn: Hex;
    tokenOut: Hex;
    v2Factory: Hex;
    cake100: Hex;
    stack: { factory: Hex; sauceRouter: Hex };
    v12: { sauceRouter: Hex } | null;
  };

  const anvil = await startAnvil();
  try {
    const c = await makeClients(anvil.rpcUrl);
    const state = ("0x" + gunzipSync(readFileSync(blob)).toString("hex")) as Hex;
    await c.testClient.loadState({ state });

    const v4snap = (() => {
      const f = readdirSync(SNAPSHOT_DIR).find((x) => /-v4-.*\.json$/.test(x));
      return f ? load<ProdV4Snapshot>(f) : null;
    })();

    const poolConfig: ChainPoolConfig = {
      factories: [
        { address: manifest.stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3", feeTiers: [100, 500, 3000, 10000] },
        { address: manifest.pancakeDeployer, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local PancakeV3", feeTiers: [100, 500, 2500, 10000] },
        { address: manifest.poolManager, stateView: manifest.stateView, poolType: SwapPoolType.UniV4, factoryType: FactoryType.UniswapV4, label: "Local UniV4", feeTiers: [v4snap!.fee] },
        { address: manifest.v2Factory, poolType: SwapPoolType.UniV2, factoryType: FactoryType.V2Standard, label: "Local UniV2" },
      ],
      feeTiers: [100, 500, 3000, 10000],
      baseTokens: [manifest.tokenIn, manifest.tokenOut],
    };

    const chainId = await c.publicClient.getChainId();
    const chain = defineChain({
      id: chainId, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [anvil.rpcUrl] } }, contracts: { multicall3: { address: MULTICALL3 } },
    });
    const client = createPublicClient({ chain, transport: http(anvil.rpcUrl, { timeout: 120_000 }) });

    const amountIn = parseEther("3000");
    const zeroForOne = BigInt(manifest.tokenIn) < BigInt(manifest.tokenOut);
    // This is a measurement probe: per-pool in-range capacity is engine-agnostic in
    // VALUE, so always read through the v1 SauceRouter (present in BOTH cached blobs)
    // with the v1 lens. The v12 lens requires the owner-gated V12Pot + owner account,
    // neither of which the cached manifest records.
    const router = manifest.stack.sauceRouter;

    // Filter OFF: emit every alive pool with its full forward walk so we can measure
    // per-pool capacity off-chain (the on-chain header carries Σ + the floor too).
    const all = await runLens(client, router, poolConfig, {
      tokenIn: manifest.tokenIn, tokenOut: manifest.tokenOut, zeroForOne, amountIn,
      driftTicks: 2, minRelBps: 0, maxTicks: 96, target: "v1",
    });

    // MEASURE A (off-chain mirror): floorAdj = shallowest (max) solo floor among pools
    // that solo-cover amountIn within their walked window.
    let floorAdj = 0n;
    for (const p of all.pools) {
      const { soloFloorAdj } = walkPool(p, zeroForOne, amountIn, 0n);
      if (soloFloorAdj > floorAdj) floorAdj = soloFloorAdj;
    }

    // MEASURE B (off-chain mirror): per-pool in-range capacity to the common floor.
    const rows = all.pools.map((p) => {
      const { cap } = walkPool(p, zeroForOne, amountIn, floorAdj);
      return { p, cap };
    });
    const totalCap = rows.reduce((a, r) => a + r.cap, 0n);
    const floorBps = 100; // 1%
    const capFloor = (totalCap * BigInt(floorBps)) / 10000n;

    const fmtEth = (x: bigint) => (Number(x) / 1e18).toFixed(3);
    const pct = (x: bigint) => (totalCap === 0n ? 0 : (Number(x) / Number(totalCap)) * 100).toFixed(3);

    console.log(`\n=== ALL-POOLS in-range capacity (engine ${engine}, amountIn ${fmtEth(amountIn)} WETH) ===`);
    console.log(`floorAdj (common cut, out/in Q96)= ${floorAdj}`);
    console.log(`Σ in-range capacity              = ${fmtEth(totalCap)} WETH`);
    console.log(`1% floor                         = ${fmtEth(capFloor)} WETH\n`);
    console.log(
      "type fee     addr                                        capacity(WETH)   %ofΣ     verdict",
    );
    const typeStr = (t: SwapPoolType) => (t === SwapPoolType.UniV2 ? "V2" : t === SwapPoolType.UniV4 ? "V4" : "V3");
    for (const { p, cap } of rows.sort((a, b) => (a.cap < b.cap ? 1 : -1))) {
      const verdict = cap >= capFloor ? "KEEP" : "DROP";
      console.log(
        `${typeStr(p.poolType).padEnd(4)} ${String(p.fee).padEnd(7)} ${p.address}  ` +
          `${fmtEth(cap).padStart(14)}  ${pct(cap).padStart(7)}  ${verdict}`,
      );
    }

    // Cross-check the on-chain header (Σ, capFloor at 1%) against the off-chain mirror.
    const onchain = await runLens(client, router, poolConfig, {
      tokenIn: manifest.tokenIn, tokenOut: manifest.tokenOut, zeroForOne, amountIn,
      driftTicks: 2, minRelBps: floorBps, maxTicks: 96, target: "v1",
    });
    console.log(
      `\non-chain header: discovered=${onchain.discoveredCount} survivors=${onchain.survivorCount} ` +
        `Σcap=${fmtEth(onchain.totalInRangeCapacity)} capFloor=${fmtEth(onchain.capacityFloor)}`,
    );
    console.log(
      `off-chain mirror: Σcap=${fmtEth(totalCap)} capFloor=${fmtEth(capFloor)} ` +
        `(survivors would be ${rows.filter((r) => r.cap >= capFloor).length})`,
    );

    // Pancake-100 active-L profile: how concentrated is its spot L (thin band → low
    // in-range capacity despite huge spot L)?
    const cake100 = all.pools.find((p) => p.address.toLowerCase() === manifest.cake100.toLowerCase());
    if (cake100) {
      console.log(
        `\nPancake-100 (cake100 ${manifest.cake100}): spot L=${cake100.liquidity} tick=${cake100.tick} ` +
          `tickSpacing=${cake100.tickSpacing} scannedForward=${cake100.scannedForward}`,
      );
      const ts = cake100.tickSpacing;
      const base = Math.floor(cake100.tick / ts) * ts;
      const span: string[] = [];
      for (let i = -3; i <= 3; i++) {
        const t = base + i * ts;
        const n = await getTickLiquidityNet(c.publicClient, manifest.cake100, t);
        span.push(`  tick ${t}: net=${n.liquidityNet}`);
      }
      console.log("Pancake-100 reproduced net profile near spot:\n" + span.join("\n"));
    }
  } finally {
    anvil.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
