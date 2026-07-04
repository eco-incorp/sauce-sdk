/**
 * Slipstream CL-pool tick-state snapshot capturer (RPC-gated, standalone).
 *
 * A thin sibling of prod-snapshot.ts (the Uniswap V3 capturer): it produces the
 * IDENTICAL `ProdPoolSnapshot` shape so reproduce-pool.ts / the prod-mirror test
 * replay a Slipstream pool with the EXISTING V3 reconstruct/exec harness
 * UNCHANGED. Slipstream (Aerodrome / Velodrome CL) CLPool.swap re-enters via the
 * standard `uniswapV3SwapCallback` selector and exposes the standard
 * slot0/ticks/liquidity/tickSpacing/fee() surface, so its swap execution is
 * V3-identical. Only two Slipstream-specific bits differ and are handled here:
 *
 *   (a) discovery keys by int24 tickSpacing — `getPool(tokenA, tokenB, int24
 *       tickSpacing)` — not by uint24 fee, and
 *   (b) fee is DECOUPLED from tickSpacing, so it is READ from the pool's own
 *       `fee()` (never derived from the tickSpacing key), and slot0() returns a
 *       6-field tuple (no `feeProtocol` byte between observationCardinalityNext
 *       and unlocked) — Slipstream's slot0 layout, distinct from Uniswap V3's
 *       7-field slot0.
 *
 * NOT imported by any test. Run it only when you have a live RPC:
 *
 *   BASE_RPC_URL=<url> npx tsx src/recipes/test/harness/slipstream-snapshot.ts [poolAddressOrPair] [venueTag]
 *
 * With no arg it discovers the deepest all-stablecoin Aerodrome CL pool on Base
 * (USDC/USDbC) from the Slipstream CLFactory (the pool address is read from
 * getPool, never hardcoded). An optional CLI arg overrides the target with an
 * explicit pool address.
 *
 * NON-Base Slipstream-family venues (Topaz CL on BSC, Hybra V4 / Ramses CL on
 * HyperEVM, Velodrome CL on Unichain, …) are captured by pointing SNAPSHOT_RPC_URL
 * at the venue's chain (it takes precedence over BASE_RPC_URL) and passing the
 * pool address + a venue tag (argv[3], folded into the filename — mirrors
 * prod-snapshot.ts's source tag):
 *
 *   SNAPSHOT_RPC_URL=<bsc-url> npx tsx src/recipes/test/harness/slipstream-snapshot.ts \
 *     0x767F1F4bF9E5E40F3D865c172c9bD0AE216e65B4 topaz
 *
 * → fixtures/snapshots/bsc-topaz-<symbol0><symbol1>-<tickSpacing>.json. The
 * captured shape is IDENTICAL (ProdPoolSnapshot): every Slipstream-family pool
 * exposes the same 6-field slot0 + decoupled fee() surface. The tick-window scan
 * is CHUNKED with retry/backoff so rate-limited public RPCs (e.g. HyperEVM's
 * rpc.hyperliquid.xyz/evm) sustain the capture.
 *
 * It reads the pool's static config (token0/token1/fee/tickSpacing), its live
 * slot0 (sqrtPriceX96 + tick) and active liquidity(), and a WINDOW of
 * initialized ticks around the current tick, then serialises everything (bigints
 * as decimal strings) to a JSON fixture under
 *   src/recipes/test/fixtures/snapshots/base-slipstream-<symbol0><symbol1>-<ts>.json
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

import { MULTICALL3, USDC, USDbC } from "../../shared/constants";
// Reuse the EXACT schema the V3 capturer defines and reproduce-pool.ts consumes.
import type { ProdPoolSnapshot } from "./prod-snapshot";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "..", "fixtures", "snapshots");

// ── Minimal ABIs ─────────────────────────────────────────────

// Slipstream CLFactory keys pools by int24 tickSpacing (NOT uint24 fee).
const slipstreamFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address pool)",
]);

// Slipstream CLPool surface. slot0() is a 6-field tuple: it OMITS the uint8
// feeProtocol field that Uniswap V3 carries before `unlocked`. Everything else
// (token0/token1/tickSpacing/liquidity/ticks) is byte-identical to Uniswap V3.
const clPoolAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 stakedLiquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, uint256 rewardGrowthOutsideX128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)",
]);

const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/**
 * Aerodrome Slipstream CLFactory on Base (from the shared Base config). Read via
 * getPool(tokenA, tokenB, int24 tickSpacing) — tickSpacing-keyed, per Slipstream.
 */
const BASE_SLIPSTREAM_FACTORY = "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A" as Hex;

/** Slipstream-common enabled tickSpacings on Base (Aerodrome CL). */
const SLIPSTREAM_TICK_SPACINGS = [1, 50, 100, 200, 2000] as const;

/**
 * How many tickSpacings to scan each direction around the live tick. Mirrors the
 * V3 capturer's WINDOW: wide enough that the window edges land where cumulative
 * liquidityNet has returned to ~baseline, so reproduce-pool's prefix-sum
 * reconstruction matches every interior boundary. Cost is one mint tx per
 * initialised boundary at replay time, so this is a HEAVY prod-mirror lane.
 */
const WINDOW_TICKSPACINGS = 200;

/**
 * ticks() calls per multicall round-trip. Small enough that a rate-limited public
 * RPC (HyperEVM) accepts each aggregate3; on a paid RPC the whole window is still
 * only a handful of round-trips.
 */
const TICKS_CHUNK = 50;

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
    client.readContract({ address: pool, abi: clPoolAbi, functionName: "token0" }) as Promise<Hex>,
    client.readContract({ address: pool, abi: clPoolAbi, functionName: "token1" }) as Promise<Hex>,
    client.readContract({ address: pool, abi: clPoolAbi, functionName: "fee" }) as Promise<number>,
    client.readContract({ address: pool, abi: clPoolAbi, functionName: "tickSpacing" }) as Promise<number>,
    client.readContract({ address: pool, abi: clPoolAbi, functionName: "liquidity" }) as Promise<bigint>,
    client.readContract({ address: pool, abi: clPoolAbi, functionName: "slot0" }) as Promise<
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

  // Chunked multicall over the window (one aggregate3 per chunk) with
  // retry/backoff per chunk — a 401-call single round-trip is fine on a paid
  // RPC but can exceed a public RPC's request/gas budget or trip rate limits.
  const tickCalls = boundaries.map((b) => ({
    address: pool,
    abi: clPoolAbi,
    functionName: "ticks" as const,
    args: [b] as const,
  }));
  const results: { status: "success" | "failure"; result?: unknown }[] = [];
  for (let off = 0; off < tickCalls.length; off += TICKS_CHUNK) {
    const chunk = tickCalls.slice(off, off + TICKS_CHUNK);
    let lastErr: unknown;
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      if (attempt > 0) {
        const backoffMs = 1000 * 2 ** (attempt - 1);
        console.log(`  ticks chunk @${off}: retry ${attempt} after ${backoffMs}ms`);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
      try {
        const part = await client.multicall({ contracts: chunk, allowFailure: true });
        results.push(...part);
        ok = true;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!ok) throw lastErr;
  }

  const ticks: [number, string][] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const r = results[i];
    if (r.status !== "success") continue;
    // Slipstream ticks(): [liquidityGross, liquidityNet, stakedLiquidityNet, ...].
    // liquidityNet is index 1 (same slot as Uniswap V3) — the staked field sits
    // AFTER it, so the index we read is unchanged.
    const tup = r.result as unknown as [bigint, bigint, ...unknown[]];
    const liquidityNet = tup[1];
    // The trailing `initialized` bool is the last element regardless of shape.
    const initialized = tup[tup.length - 1] as boolean;
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
  if (chainId === 56) return "bsc";
  if (chainId === 999) return "hyperevm";
  if (chainId === 130) return "unichain";
  if (chainId === 42220) return "celo";
  if (chainId === 146) return "sonic";
  return `chain${chainId}`;
}

/**
 * Discover the deepest all-stablecoin Aerodrome CL pool: enumerate the enabled
 * tickSpacings for USDC/USDbC, keep the non-zero pools, read active liquidity(),
 * and return the deepest. Both tokens are Base baseTokens (on-charter stable pair).
 */
async function discoverDefaultPool(client: PublicClient): Promise<Hex> {
  const calls = SLIPSTREAM_TICK_SPACINGS.map((tickSpacing) => ({
    address: BASE_SLIPSTREAM_FACTORY,
    abi: slipstreamFactoryAbi,
    functionName: "getPool" as const,
    args: [USDC, USDbC, tickSpacing] as const,
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
      `slipstream-snapshot: Slipstream factory ${BASE_SLIPSTREAM_FACTORY} returned no USDC/USDbC pool across tickSpacings ${SLIPSTREAM_TICK_SPACINGS.join(",")}`,
    );
  }

  const liq = await client.multicall({
    contracts: pools.map((p) => ({ address: p, abi: clPoolAbi, functionName: "liquidity" as const })),
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
    `slipstream-snapshot: discovered ${pools.length} USDC/USDbC Aerodrome CL pool(s); deepest = ${best} (liquidity ${bestLiq})`,
  );
  return best;
}

async function main(): Promise<void> {
  // SNAPSHOT_RPC_URL points the capture at ANY Slipstream-family chain (BSC
  // Topaz, HyperEVM Hybra V4, …); BASE_RPC_URL keeps the original Base default.
  const rpcUrl = process.env.SNAPSHOT_RPC_URL || process.env.BASE_RPC_URL;
  if (!rpcUrl) {
    console.error(
      "slipstream-snapshot: neither SNAPSHOT_RPC_URL nor BASE_RPC_URL is set.\n" +
        "  Set one and re-run, e.g.:\n" +
        "    BASE_RPC_URL=https://... npx tsx src/recipes/test/harness/slipstream-snapshot.ts\n" +
        "    SNAPSHOT_RPC_URL=https://<other-chain> npx tsx src/recipes/test/harness/slipstream-snapshot.ts <pool> <venueTag>\n" +
        "  Optional args: an explicit Slipstream-family pool address (argv[2]) and a venue tag (argv[3])\n" +
        "  folded into the snapshot filename (default 'slipstream').",
    );
    process.exit(0);
    return;
  }

  const client = await makeClient(rpcUrl);
  const arg = process.argv[2];
  // Optional venue tag (argv[3]) — folded into the filename so a Slipstream-family
  // fork's pool (topaz, hybrav4, …) lands beside the Aerodrome default without
  // clobbering it. Mirrors prod-snapshot.ts's source tag.
  const tag = (process.argv[3] ?? "slipstream").replace(/[^a-zA-Z0-9]/g, "") || "slipstream";

  let pool: Hex;
  if (arg && /^0x[0-9a-fA-F]{40}$/.test(arg)) {
    pool = getAddress(arg);
    console.log(`slipstream-snapshot: capturing explicit pool ${pool}`);
  } else {
    pool = await discoverDefaultPool(client);
  }

  const snap = await captureSnapshot(client, pool);

  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  // <chain>-<venueTag>-<symbol0><symbol1>-<tickSpacing>.json — keyed by tickSpacing
  // (Slipstream's pool key), NOT fee, since Slipstream decouples the two. Symbols
  // are ASCII-sanitized for the filename only (Tether's ₮ glyph → T; the snapshot
  // JSON keeps the raw symbol): checked-in fixture names stay plain ASCII.
  const fsSafe = (s: string) => s.replace(/₮/g, "T").replace(/[^a-zA-Z0-9]/g, "");
  const file = join(
    SNAPSHOT_DIR,
    `${chainName(snap.chainId)}-${tag}-${fsSafe(snap.symbol0)}${fsSafe(snap.symbol1)}-${snap.tickSpacing}.json`,
  );
  writeFileSync(file, JSON.stringify(snap, null, 2) + "\n");

  console.log(
    `slipstream-snapshot: wrote ${file}\n` +
      `  ${snap.symbol0}/${snap.symbol1} fee=${snap.fee} tickSpacing=${snap.tickSpacing}\n` +
      `  tick=${snap.tick} sqrtPriceX96=${snap.sqrtPriceX96} activeLiquidity=${snap.liquidity}\n` +
      `  initialized boundaries in window: ${snap.ticks.length} (±${snap.windowTickSpacings} tickSpacings)`,
  );
}

main().catch((e) => {
  console.error("slipstream-snapshot failed:", e);
  process.exit(1);
});
