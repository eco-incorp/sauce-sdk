/**
 * Algebra CL-pool tick-state snapshot capturer (RPC-gated, standalone).
 *
 * A thin sibling of prod-snapshot.ts (the Uniswap V3 capturer) and
 * slipstream-snapshot.ts (the Aerodrome CL capturer): it produces the IDENTICAL
 * `ProdPoolSnapshot` shape so reproduce-pool.ts / a prod-mirror test replay an
 * Algebra pool with the EXISTING V3 reconstruct/exec harness UNCHANGED. Algebra
 * pools (THENA Fusion on BSC, Camelot / QuickSwap V3, Ramses V2) are V3-shaped
 * concentrated-liquidity pools: their `swap()` is selector-identical to Uniswap
 * V3 and their per-tick liquidityNet + sqrtPrice grid are byte-identical to
 * Uniswap V3, so the swap-relevant state reproduces into a v3-core pool exactly.
 *
 * TWO Algebra-specific reads differ from Uniswap V3 and are handled here:
 *
 *   (a) STATE is read from `globalState()`, NOT `slot0()`. Algebra v1 (THENA
 *       Fusion, Camelot/QuickSwap V3) returns a 7-field tuple
 *         (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex,
 *          uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)
 *       where `price` is the sqrtPriceX96 and `fee` is the CURRENT dynamic fee
 *       (recomputed on-chain from the volatility oracle — NOT a fixed tier). The
 *       dynamic fee is captured as the snapshot's `fee`, so a downstream
 *       reconstruction prices at the EXACT fee the pool charged at capture time.
 *
 *   (b) `ticks()` returns an Algebra-shaped tuple, but `liquidityNet` sits at the
 *       SAME index (1) as Uniswap V3 — Algebra v1 ticks() is
 *         (uint128 liquidityTotal, int128 liquidityDelta, uint256, uint256,
 *          int56, uint160, uint32, bool initialized)
 *       so we read net at [1] and `initialized` at the LAST element, exactly like
 *       the Uniswap V3 / Slipstream capturers. (Verified empirically against the
 *       live pool before this was written, per the Slipstream pilot's method.)
 *
 * NOT imported by any test. Run it only when you have a live RPC. The chain RPC
 * is picked from the *_RPC_URL env vars (BSC by default — THENA Fusion). Load the
 * key from sdk/.env FIRST:
 *
 *   set -a; . sdk/.env; set +a
 *   npx tsx src/recipes/test/harness/algebra-snapshot.ts [poolAddressOrPair]
 *
 * With no arg it discovers the deepest all-stablecoin Algebra pool on BSC
 * (USDC/USDT) from the THENA Fusion AlgebraFactory via poolByPair(tokenA, tokenB)
 * (the pool address is read from the factory, never hardcoded). An optional CLI
 * arg overrides the target with an explicit pool address (on the same chain).
 *
 * It reads the pool's static config (token0/token1/tickSpacing), its live
 * globalState (sqrtPriceX96 + tick + the CURRENT dynamic fee) and active
 * liquidity(), and a WINDOW of initialized ticks around the current tick, then
 * serialises everything (bigints as decimal strings) to a JSON fixture under
 *   src/recipes/test/fixtures/snapshots/<chain>-algebra-<symbol0><symbol1>-<something>.json
 *
 * ALGEBRA INTEGRAL SUPPORT (additive). Algebra Integral (THENA V3,3 on BSC, SwapX on
 * Sonic, nest/Kittenswap on HyperEVM) returns SHORTER tuples for the SAME selectors:
 *   - globalState() is 6 words: (uint160 price, int24 tick, uint16 lastFee,
 *     uint8 pluginConfig, uint16 communityFee, bool unlocked) — the single fee is
 *     STILL word 2 (word 3 is pluginConfig, NOT a fee; see FactoryConfig.algebraFeeLayout).
 *   - ticks() is 6 words: (uint256 liquidityTotal, int128 liquidityDelta,
 *     int24 prevTick, int24 nextTick, uint256 outerFeeGrowth0Token,
 *     uint256 outerFeeGrowth1Token) — liquidityDelta (== liquidityNet) is STILL index 1,
 *     but there is NO trailing `initialized` bool: a tick is initialized iff it is
 *     threaded into the prev/next linked list (liquidityTotal > 0 covers every tick
 *     that carries positions; nets can be 0 on balanced ticks, which reproduce as no-ops).
 * The layout is AUTO-DETECTED from the raw globalState() returndata word count
 * (6 ⇒ integral, 7 ⇒ algebra-v1, 8+ ⇒ camelot), so the default THENA-Fusion capture
 * path is byte-identical to before. A second CLI arg tags the output filename
 * (mirrors prod-snapshot.ts's source-tag convention):
 *
 *   npx tsx src/recipes/test/harness/algebra-snapshot.ts <poolAddress> integral
 *     → <chain>-algebraintegral-<symbol0><symbol1>-<tickSpacing>.json
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
  getAddress,
  type PublicClient,
  type Hex,
} from "viem";

import { MULTICALL3, CHAIN_POOL_CONFIGS, FactoryType } from "../../shared/constants";
// Reuse the EXACT schema the V3 capturer defines and reproduce-pool.ts consumes.
import type { ProdPoolSnapshot } from "./prod-snapshot";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "..", "fixtures", "snapshots");

// ── Minimal ABIs ─────────────────────────────────────────────

// Algebra dynamic-fee factory: ONE pool per pair (no fee tiers), keyed by
// poolByPair(tokenA, tokenB) — NOT getPool(a, b, fee). Same call discovery uses.
const algebraFactoryAbi = parseAbi([
  "function poolByPair(address tokenA, address tokenB) view returns (address pool)",
]);

// Algebra CLPool surface. globalState() REPLACES slot0(): a 7-field tuple whose
// [0] is the sqrtPriceX96 (`price`), [1] the current tick, and [2] the CURRENT
// dynamic fee (recomputed on-chain from the volatility oracle — not a fixed
// tier). ticks() is Algebra-shaped but liquidityNet is at index 1 (same slot as
// Uniswap V3), and the trailing `initialized` bool is the last element.
const algebraPoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)",
  "function ticks(int24 tick) view returns (uint128 liquidityTotal, int128 liquidityDelta, uint256 outerFeeGrowth0Token, uint256 outerFeeGrowth1Token, int56 outerTickCumulative, uint160 outerSecondsPerLiquidity, uint32 outerSecondsSpent, bool initialized)",
]);

// Algebra INTEGRAL pool surface (THENA V3,3 / SwapX / nest / Kittenswap): the SAME
// selectors return SHORTER tuples. globalState() is 6 words with the single dynamic
// fee (lastFee) STILL at word 2; ticks() is 6 words with liquidityDelta STILL at
// index 1 but NO trailing `initialized` bool (the prev/next linked list replaces it).
const algebraIntegralPoolAbi = parseAbi([
  "function globalState() view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked)",
  "function ticks(int24 tick) view returns (uint256 liquidityTotal, int128 liquidityDelta, int24 prevTick, int24 nextTick, uint256 outerFeeGrowth0Token, uint256 outerFeeGrowth1Token)",
]);

/** The fork's globalState layout, keyed by raw returndata word count (the same
 *  length-guess shared/pool-discovery.ts uses when the config omits the layout). */
type AlgebraLayout = "camelot" | "algebra-v1" | "integral";

/** Detect the pool's globalState layout from ONE raw eth_call (word count). */
async function detectLayout(client: PublicClient, pool: Hex): Promise<AlgebraLayout> {
  const data = encodeFunctionData({ abi: algebraPoolAbi, functionName: "globalState" });
  const { data: ret } = await client.call({ to: pool, data });
  if (!ret) throw new Error(`algebra-snapshot: ${pool} returned no data for globalState()`);
  const words = (ret.length - 2) / 64;
  if (!Number.isInteger(words) || words < 3) {
    throw new Error(`algebra-snapshot: ${pool} globalState() returndata is ragged/short (${ret.length - 2} hex chars)`);
  }
  return words >= 8 ? "camelot" : words === 7 ? "algebra-v1" : "integral";
}

const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/**
 * DEFAULT capture target: BSC THENA Fusion (Algebra v1 dynamic-fee CL). The
 * factory + on-charter stablecoin pair are pulled from the shipped chain config so
 * this stays in lockstep with what discovery/the lens actually query.
 */
const DEFAULT_CHAIN = "bsc";
const DEFAULT_RPC_ENV = "BSC_RPC_URL";

/** The Algebra (AlgebraV3) factory + the chain's stablecoin baseTokens, from the shipped config. */
function defaultChainTargets(): { factory: Hex; stables: Hex[] } {
  const cfg = CHAIN_POOL_CONFIGS[DEFAULT_CHAIN];
  if (!cfg) throw new Error(`algebra-snapshot: no chain config for "${DEFAULT_CHAIN}"`);
  const alg = cfg.factories.find((f) => f.factoryType === FactoryType.AlgebraV3);
  if (!alg) throw new Error(`algebra-snapshot: no Algebra (AlgebraV3) factory in the "${DEFAULT_CHAIN}" config`);
  return { factory: alg.address, stables: [...cfg.baseTokens] };
}

/**
 * How many tickSpacings to scan each direction around the live tick. Mirrors the
 * V3 / Slipstream capturers' WINDOW: wide enough that the window edges land where
 * cumulative liquidityNet has returned to ~baseline, so reproduce-pool's prefix-sum
 * reconstruction matches every interior boundary. Cost is one mint tx per
 * initialised boundary at replay time, so this is a HEAVY prod-mirror lane.
 */
const WINDOW_TICKSPACINGS = 200;

async function makeClient(rpcUrl: string): Promise<PublicClient> {
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await probe.getChainId();
  const chain = defineChain({
    id: chainId,
    name: "Snapshot Source",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
  return createPublicClient({ chain, transport: http(rpcUrl, { timeout: 120_000 }) }) as PublicClient;
}

async function symbolOf(client: PublicClient, token: Hex): Promise<{ symbol: string; decimals: number }> {
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
    ]);
    return { symbol, decimals: Number(decimals) };
  } catch {
    return { symbol: token.slice(2, 6).toUpperCase(), decimals: 18 };
  }
}

async function captureSnapshot(client: PublicClient, pool: Hex): Promise<ProdPoolSnapshot> {
  const chainId = await client.getChainId();

  // Detect the fork's globalState/ticks tuple shape FIRST (one raw eth_call): a typed
  // 7-word decode on a 6-word Integral pool throws, so the reads below pick the ABI
  // by layout. The default (algebra-v1) path is unchanged.
  const layout = await detectLayout(client, pool);
  console.log(`algebra-snapshot: detected globalState layout "${layout}"`);
  const gsAbi = layout === "integral" ? algebraIntegralPoolAbi : algebraPoolAbi;

  const [token0, token1, tickSpacing, liquidity, globalState] = await Promise.all([
    client.readContract({ address: pool, abi: algebraPoolAbi, functionName: "token0" }) as Promise<Hex>,
    client.readContract({ address: pool, abi: algebraPoolAbi, functionName: "token1" }) as Promise<Hex>,
    client.readContract({ address: pool, abi: algebraPoolAbi, functionName: "tickSpacing" }) as Promise<number>,
    client.readContract({ address: pool, abi: algebraPoolAbi, functionName: "liquidity" }) as Promise<bigint>,
    // globalState() is Algebra's slot0() analogue: [0]=sqrtPriceX96, [1]=tick,
    // [2]=CURRENT dynamic fee (from the on-chain volatility oracle) — the fee sits at
    // word 2 on EVERY layout (integral's word 3 is pluginConfig, v1's the timepointIndex).
    client.readContract({ address: pool, abi: gsAbi, functionName: "globalState" }) as Promise<
      readonly [bigint, number, number, ...unknown[]]
    >,
  ]);

  const sqrtPriceX96 = globalState[0];
  const tick = Number(globalState[1]);
  // The DYNAMIC fee, read live from globalState (NOT a fixed tier). Captured as
  // the snapshot's `fee` so a reconstruction prices at the exact charged fee.
  const dynamicFee = Number(globalState[2]);
  const ts = Number(tickSpacing);

  const [sym0, sym1] = await Promise.all([symbolOf(client, token0), symbolOf(client, token1)]);

  // Scan tickSpacing-aligned boundaries in a symmetric window around the live
  // tick. base = current tick rounded DOWN to the nearest tickSpacing.
  const base = Math.floor(tick / ts) * ts;
  const boundaries: number[] = [];
  for (let k = -WINDOW_TICKSPACINGS; k <= WINDOW_TICKSPACINGS; k++) {
    boundaries.push(base + k * ts);
  }

  // One multicall round-trip for the whole window. The ticks() ABI is layout-keyed:
  // Integral's tuple is 6 words with NO trailing `initialized` bool.
  const ticksAbi = layout === "integral" ? algebraIntegralPoolAbi : algebraPoolAbi;
  const tickCalls = boundaries.map((b) => ({
    address: pool,
    abi: ticksAbi,
    functionName: "ticks" as const,
    args: [b] as const,
  }));
  const results = await client.multicall({ contracts: tickCalls, allowFailure: true });

  const ticks: [number, string][] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const r = results[i];
    if (r.status !== "success") continue;
    // Algebra ticks(): [liquidityTotal, liquidityDelta, …]. liquidityDelta (== the
    // Uniswap-V3 liquidityNet) is index 1 on EVERY layout — SAME slot as Uniswap V3.
    const tup = r.result as unknown as [bigint, bigint, ...unknown[]];
    const liquidityNet = tup[1];
    // Initialized: v1/camelot carry a trailing bool; Integral has NONE (membership in
    // the prev/next linked list replaces it) — there liquidityTotal > 0 marks a tick
    // that carries positions (a balanced tick can have net 0, reproducing as a no-op).
    const initialized =
      layout === "integral" ? tup[0] > 0n : (tup[tup.length - 1] as boolean);
    if (initialized || liquidityNet !== 0n) ticks.push([boundaries[i], liquidityNet.toString()]);
  }

  return {
    chainId,
    pool: getAddress(pool),
    token0: getAddress(token0),
    token1: getAddress(token1),
    symbol0: sym0.symbol,
    symbol1: sym1.symbol,
    decimals0: sym0.decimals,
    decimals1: sym1.decimals,
    // The captured LIVE dynamic fee (Algebra recomputes it on-chain; this is the
    // value in effect at the captured block). Threads through reproduce-pool as
    // the inner V3 pool's fee tier so pricing is wei-exact vs the fee charged.
    fee: dynamicFee,
    tickSpacing: ts,
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick,
    liquidity: liquidity.toString(),
    ticks,
    windowTickSpacings: WINDOW_TICKSPACINGS,
  };
}

function chainName(chainId: number): string {
  if (chainId === 8453) return "base";
  if (chainId === 1) return "ethereum";
  if (chainId === 42161) return "arbitrum";
  if (chainId === 10) return "optimism";
  if (chainId === 137) return "polygon";
  if (chainId === 56) return "bsc";
  if (chainId === 42220) return "celo";
  if (chainId === 146) return "sonic";
  return `chain${chainId}`;
}

/**
 * Discover the deepest all-stablecoin Algebra pool: enumerate poolByPair for every
 * ordered pair of the chain's stablecoin baseTokens, keep the non-zero pools, read
 * active liquidity(), and return the deepest. On BSC these are USDC/USDT — an
 * on-charter both-baseToken stable pair.
 */
async function discoverDefaultPool(client: PublicClient, factory: Hex, stables: Hex[]): Promise<Hex> {
  const pairs: [Hex, Hex][] = [];
  for (let i = 0; i < stables.length; i++) {
    for (let j = i + 1; j < stables.length; j++) {
      pairs.push([stables[i], stables[j]]);
    }
  }
  if (pairs.length === 0) {
    throw new Error(`algebra-snapshot: fewer than 2 stablecoin baseTokens configured for discovery`);
  }

  const calls = pairs.map(([a, b]) => ({
    address: factory,
    abi: algebraFactoryAbi,
    functionName: "poolByPair" as const,
    args: [a, b] as const,
  }));
  const results = await client.multicall({ contracts: calls, allowFailure: true });

  const pools: Hex[] = [];
  for (const r of results) {
    if (r.status === "success" && r.result && BigInt(r.result as Hex) !== 0n) {
      pools.push(getAddress(r.result as Hex));
    }
  }
  if (pools.length === 0) {
    throw new Error(
      `algebra-snapshot: Algebra factory ${factory} returned no stablecoin pool across ${pairs.length} baseToken pair(s)`,
    );
  }

  const liq = await client.multicall({
    contracts: pools.map((p) => ({ address: p, abi: algebraPoolAbi, functionName: "liquidity" as const })),
    allowFailure: true,
  });

  let best: Hex = pools[0];
  let bestLiq = -1n;
  for (let i = 0; i < pools.length; i++) {
    const l = liq[i].status === "success" ? (liq[i].result as bigint) : 0n;
    if (l > bestLiq) {
      bestLiq = l;
      best = pools[i];
    }
  }
  console.log(
    `algebra-snapshot: discovered ${pools.length} stablecoin Algebra pool(s); deepest = ${best} (liquidity ${bestLiq})`,
  );
  return best;
}

async function main(): Promise<void> {
  const rpcUrl = process.env[DEFAULT_RPC_ENV];
  if (!rpcUrl) {
    console.error(
      `algebra-snapshot: ${DEFAULT_RPC_ENV} is not set.\n` +
        `  Load the key from sdk/.env and re-run, e.g.:\n` +
        `    set -a; . sdk/.env; set +a\n` +
        `    npx tsx src/recipes/test/harness/algebra-snapshot.ts\n` +
        `  Optional arg: an explicit Algebra CL pool address to capture instead of the default USDC/USDT pool.`,
    );
    process.exit(0);
    return;
  }

  const client = await makeClient(rpcUrl);
  const arg = process.argv[2];
  // Optional source tag (mirrors prod-snapshot.ts): appended to the "algebra" stem in
  // the output filename, e.g. `integral` → <chain>-algebraintegral-<syms>-<ts>.json.
  // Keeps sibling Algebra-family captures (v1 vs Integral) from clobbering each other.
  const sourceTag = (process.argv[3] ?? "").replace(/[^a-zA-Z0-9]/g, "");

  let pool: Hex;
  if (arg && /^0x[0-9a-fA-F]{40}$/.test(arg)) {
    pool = getAddress(arg);
    console.log(`algebra-snapshot: capturing explicit pool ${pool}`);
  } else {
    const { factory, stables } = defaultChainTargets();
    pool = await discoverDefaultPool(client, factory, stables);
  }

  const snap = await captureSnapshot(client, pool);

  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  // <chain>-algebra<tag>-<symbol0><symbol1>-<tickSpacing>.json — Algebra has ONE pool
  // per pair (no fee tiers), so the tickSpacing is the stable disambiguator (the
  // dynamic fee floats and would drift the filename between captures).
  const file = join(
    SNAPSHOT_DIR,
    `${chainName(snap.chainId)}-algebra${sourceTag}-${snap.symbol0}${snap.symbol1}-${snap.tickSpacing}.json`,
  );
  writeFileSync(file, JSON.stringify(snap, null, 2) + "\n");

  console.log(
    `algebra-snapshot: wrote ${file}\n` +
      `  ${snap.symbol0}/${snap.symbol1} dynamicFee=${snap.fee} tickSpacing=${snap.tickSpacing}\n` +
      `  tick=${snap.tick} sqrtPriceX96=${snap.sqrtPriceX96} activeLiquidity=${snap.liquidity}\n` +
      `  initialized boundaries in window: ${snap.ticks.length} (±${snap.windowTickSpacings} tickSpacings)`,
  );
}

main().catch((e) => {
  console.error("algebra-snapshot failed:", e);
  process.exit(1);
});
