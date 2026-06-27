/**
 * Production V3-pool tick-state snapshot capturer (RPC-gated, standalone).
 *
 * NOT imported by any test. Run it only when you have a live RPC:
 *
 *   BASE_RPC_URL=<url> npx tsx src/recipes/test/harness/prod-snapshot.ts [poolAddressOrPair]
 *
 * It reads a real Uniswap-V3 pool's static config (token0/token1/fee/tickSpacing),
 * its live slot0 (sqrtPriceX96 + tick) and active liquidity(), and a WINDOW of
 * initialized ticks around the current tick, then serialises everything (bigints
 * as decimal strings) to a JSON fixture under
 *   src/recipes/test/fixtures/snapshots/<chain>-<symbol0><symbol1>-<fee>.json
 *
 * The fixture is the exact input `reproduce-pool.ts` replays locally and the
 * prod-mirror test asserts against. By default it captures the deep Uniswap V3
 * Base WETH/USDC 0.05% pool, discovered from the factory (the pool address is
 * read from getPool, never hardcoded). An optional CLI arg overrides the target
 * with an explicit pool address.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  createPublicClient,
  defineChain,
  http,
  parseAbi,
  getAddress,
  type PublicClient,
  type Hex,
} from "viem";

import {
  MULTICALL3,
  WETH,
  USDC,
  BASE_CHAIN_POOL_CONFIG,
  FactoryType,
  SwapPoolType,
} from "../../shared/constants";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "..", "fixtures", "snapshots");

// ── Snapshot schema ──────────────────────────────────────────

/**
 * A captured (or synthetic) Uniswap-V3 pool tick state. All bigint-valued
 * fields are serialised as decimal strings so the JSON round-trips losslessly.
 */
export interface ProdPoolSnapshot {
  /** Optional free-text note (the synthetic fixture flags itself here). */
  _note?: string;
  /**
   * Optional source/fork tag (e.g. "pancake") — distinguishes same-pair-same-fee
   * pools from different forks so their fixture filenames don't collide.
   */
  sourceTag?: string;
  /** Chain id the snapshot was captured on (8453 = Base). */
  chainId: number;
  /** Pool address (checksummed). */
  pool: Hex;
  /** token0 / token1 in the pool's canonical sort order (token0 < token1). */
  token0: Hex;
  token1: Hex;
  /** ERC-20 symbols (best-effort; used only for the filename + diagnostics). */
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  /** Fee tier in ppm (e.g. 500 = 0.05%). */
  fee: number;
  /** Pool tickSpacing (read from the pool). */
  tickSpacing: number;
  /** Live slot0 sqrtPriceX96 (decimal string). */
  sqrtPriceX96: string;
  /** Live slot0 tick. */
  tick: number;
  /** Live active liquidity() (decimal string). */
  liquidity: string;
  /**
   * Initialized tick boundaries in the scanned window, ascending by tickIndex.
   * Each entry is [tickIndex, liquidityNet as decimal string]. Only boundaries
   * with initialized == true (equivalently liquidityNet != 0) are recorded.
   */
  ticks: [number, string][];
  /** Window half-width actually scanned, in tickSpacing units (each direction). */
  windowTickSpacings: number;
}

// ── Minimal ABIs ─────────────────────────────────────────────

const v3FactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);

const v3PoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)",
]);

const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/** Uniswap V3 Base factory (from the shared Base config). */
const BASE_UNIV3_FACTORY = BASE_CHAIN_POOL_CONFIG.factories.find(
  (f) => f.factoryType === FactoryType.V3Standard && f.poolType === SwapPoolType.UniV3,
)!.address;

/**
 * How many tickSpacings to scan each direction around the live tick.
 *
 * Must be WIDE enough that the window edges land where the cumulative liquidityNet
 * has returned to ~baseline — otherwise reproduce-pool's prefix-sum reconstruction
 * can't match interior boundaries whose paired open/close falls outside the window
 * (a narrow ±50 window leaves ~14 such mismatches on the WETH/USDC pool; ±200 is
 * faithful with 0). The cost is one mint tx per initialised boundary, so the
 * prod-mirror V3 reproduction is a HEAVY test (~10 min for this pool) — run it in a
 * dedicated lane, not the fast path.
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

  const [token0, token1, fee, tickSpacing, liquidity, slot0] = await Promise.all([
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: "token0" }) as Promise<Hex>,
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: "token1" }) as Promise<Hex>,
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: "fee" }) as Promise<number>,
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: "tickSpacing" }) as Promise<number>,
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: "liquidity" }) as Promise<bigint>,
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: "slot0" }) as Promise<
      readonly [bigint, number, ...unknown[]]
    >,
  ]);

  const sqrtPriceX96 = slot0[0];
  const tick = Number(slot0[1]);
  const ts = Number(tickSpacing);
  const feeNum = Number(fee);

  const [sym0, sym1] = await Promise.all([symbolOf(client, token0), symbolOf(client, token1)]);

  // Scan tickSpacing-aligned boundaries in a symmetric window around the live
  // tick. base = current tick rounded DOWN to the nearest tickSpacing.
  const base = Math.floor(tick / ts) * ts;
  const boundaries: number[] = [];
  for (let k = -WINDOW_TICKSPACINGS; k <= WINDOW_TICKSPACINGS; k++) {
    boundaries.push(base + k * ts);
  }

  // One multicall round-trip for the whole window.
  const tickCalls = boundaries.map((b) => ({
    address: pool,
    abi: v3PoolAbi,
    functionName: "ticks" as const,
    args: [b] as const,
  }));
  const results = await client.multicall({ contracts: tickCalls, allowFailure: true });

  const ticks: [number, string][] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const r = results[i];
    if (r.status !== "success") continue;
    const tup = r.result as unknown as [bigint, bigint, bigint, bigint, bigint, bigint, number, boolean];
    const liquidityNet = tup[1];
    const initialized = tup[7];
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
    fee: feeNum,
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
  return `chain${chainId}`;
}

async function main(): Promise<void> {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) {
    console.error(
      "prod-snapshot: BASE_RPC_URL is not set.\n" +
        "  Set it to a Base RPC and re-run, e.g.:\n" +
        "    BASE_RPC_URL=https://eth-mainnet-... npx tsx src/recipes/test/harness/prod-snapshot.ts\n" +
        "  Optional arg: an explicit pool address to capture instead of the default WETH/USDC 0.05% pool.",
    );
    process.exit(0);
    return;
  }

  const client = await makeClient(rpcUrl);
  const arg = process.argv[2];
  // Optional source tag (argv[3]) — folded into the filename so a fork's pool
  // (e.g. PancakeSwap) doesn't overwrite Uniswap's at the same fee tier.
  const tag = (process.argv[3] ?? "").replace(/[^a-zA-Z0-9]/g, "");

  let pool: Hex;
  if (arg && /^0x[0-9a-fA-F]{40}$/.test(arg)) {
    pool = getAddress(arg);
    console.log(`prod-snapshot: capturing explicit pool ${pool}`);
  } else {
    // Default: discover the Uniswap V3 Base WETH/USDC 0.05% pool from the factory.
    const fee = 500;
    pool = (await client.readContract({
      address: BASE_UNIV3_FACTORY,
      abi: v3FactoryAbi,
      functionName: "getPool",
      args: [WETH, USDC, fee],
    })) as Hex;
    if (!pool || BigInt(pool) === 0n) {
      console.error(`prod-snapshot: factory ${BASE_UNIV3_FACTORY} returned no pool for WETH/USDC fee ${fee}`);
      process.exit(1);
      return;
    }
    console.log(`prod-snapshot: discovered WETH/USDC ${fee} pool ${pool} from factory ${BASE_UNIV3_FACTORY}`);
  }

  const snap = await captureSnapshot(client, pool);
  if (tag) snap.sourceTag = tag;

  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  // Untagged: base-WETHUSDC-<fee>.json (Uniswap convention, unchanged).
  // Tagged:   base-WETHUSDC-<tag><fee>.json (e.g. -pancake500) — never ends with
  // "-<fee>.json", so it can't collide with the Uniswap tier matcher.
  const file = join(
    SNAPSHOT_DIR,
    `${chainName(snap.chainId)}-${snap.symbol0}${snap.symbol1}-${tag}${snap.fee}.json`,
  );
  writeFileSync(file, JSON.stringify(snap, null, 2) + "\n");

  console.log(
    `prod-snapshot: wrote ${file}\n` +
      `  ${snap.symbol0}/${snap.symbol1} fee=${snap.fee} tickSpacing=${snap.tickSpacing}\n` +
      `  tick=${snap.tick} sqrtPriceX96=${snap.sqrtPriceX96} activeLiquidity=${snap.liquidity}\n` +
      `  initialized boundaries in window: ${snap.ticks.length} (±${snap.windowTickSpacings} tickSpacings)`,
  );
}

main().catch((e) => {
  console.error("prod-snapshot failed:", e);
  process.exit(1);
});
