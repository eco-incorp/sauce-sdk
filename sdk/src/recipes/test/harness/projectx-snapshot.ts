/**
 * Project X (HyperEVM) CL-pool tick-state snapshot capturer (RPC-gated, standalone).
 *
 * A sibling of prod-snapshot.ts (the Uniswap V3 capturer): Project X is a
 * FEE-KEYED Uniswap V3 fork (getPool(a, b, uint24 fee); standard 7-field slot0 +
 * ticks/liquidity/tickSpacing surface + uniswapV3SwapCallback), so it produces the
 * IDENTICAL `ProdPoolSnapshot` shape and reproduce-pool.ts / verifyReproduction
 * replay it with the EXISTING V3 reconstruct/exec harness UNCHANGED. What makes
 * Project X worth its own capturer:
 *
 *   (a) NON-STANDARD fee tiers — the factory enables 200→4, 400→8 and 1000→20 on
 *       top of the canonical Uniswap set (see the Project X entry in
 *       shared/constants.ts and its TICK_SPACING_BY_FEE rows), so the tier menu is
 *       READ from the shared hyperevm ChainPoolConfig, not hardcoded;
 *   (b) the scan is BITMAP-DRIVEN and COMPLETE: instead of probing a fixed ±N
 *       window of tickSpacing-aligned boundaries, it walks the pool's tickBitmap
 *       over the FULL tick range and reads ticks() only for genuinely initialized
 *       boundaries. A complete profile is ALWAYS exactly representable by
 *       reproduce-pool's baseline+increment scheme (baseline = 0, every prefix sum
 *       is a real active-liquidity level ≥ 0) — the live WHYPE/USDT0 pools carry
 *       one-sided range-order ladders whose windowed profile DIPS BELOW the window
 *       left edge, which that scheme cannot mint (skipped negative increments →
 *       net mismatches). Complete capture kills the whole artifact class, at ~1000
 *       boundaries ≈ 11 batched mint txs at replay;
 *   (c) every read is PINNED to one block number (the public HyperEVM RPC serves
 *       historical state), so slot0/liquidity()/ticks() are mutually consistent —
 *       and the Σ liquidityNet invariants are verified before writing:
 *       Σ(all nets) == 0 and Σ(nets ≤ spot tick) == liquidity();
 *   (d) the source RPC is the PUBLIC HyperEVM endpoint by default, so all
 *       multicalls are CHUNKED with retry/backoff instead of one big blast.
 *
 * NOT imported by any test. Run it only when you have a live RPC (defaults to the
 * public HyperEVM endpoint; override with HYPEREVM_RPC_URL):
 *
 *   npx tsx src/recipes/test/harness/projectx-snapshot.ts [feeTier|poolAddress]
 *
 * With no arg it discovers the DEEPEST WHYPE/USDT0 Project X pool across the
 * config's enabled fee tiers (the pool address is read from getPool, never
 * hardcoded). A numeric arg pins a specific fee tier (e.g. `400` for the
 * non-standard ts=8 tier); a 0x arg captures that explicit pool address.
 *
 * Output: src/recipes/test/fixtures/snapshots/hyperevm-projectx-<sym0><sym1>-<fee>.json
 * (symbols are sanitized to alphanumerics — USDT0's on-chain symbol carries a
 * non-ASCII character that must not leak into filenames or local fixture-token
 * symbols).
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
  CHAIN_POOL_CONFIGS,
  FactoryType,
  SwapPoolType,
} from "../../shared/constants";
// Reuse the EXACT schema the V3 capturer defines and reproduce-pool.ts consumes.
import type { ProdPoolSnapshot } from "./prod-snapshot";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "..", "fixtures", "snapshots");

/** Public HyperEVM RPC (the chain has no paid entry in sdk/.env). */
const DEFAULT_HYPEREVM_RPC = "https://rpc.hyperliquid.xyz/evm";

/** Uniswap V3 canonical MIN/MAX tick (the bitmap scan's word range). */
const MIN_TICK = -887272;
const MAX_TICK = 887272;

// ── Minimal ABIs (standard Uniswap V3 surface — Project X is fee-keyed) ──

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
  "function tickBitmap(int16 wordPosition) view returns (uint256)",
]);

const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/** The Project X factory entry from the SHARED hyperevm config (address + tier menu). */
const HYPEREVM = CHAIN_POOL_CONFIGS.hyperevm;
const PROJECTX = HYPEREVM.factories.find(
  (f) =>
    f.factoryType === FactoryType.V3Standard &&
    f.poolType === SwapPoolType.UniV3 &&
    f.label === "Project X CL",
)!;
/** WHYPE / USDT0 — the two hub baseTokens the deep Project X pools pair. */
const WHYPE = "0x5555555555555555555555555555555555555555" as Hex;
const USDT0 = "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb" as Hex;

/** Public-RPC batching: calls per multicall round-trip. */
const CHUNK = 50;
/** Retries per chunk (exponential backoff) before giving up the capture. */
const CHUNK_RETRIES = 3;

/** Strip non-alphanumerics (USDT0's on-chain symbol is not pure ASCII). */
function sanitizeSymbol(s: string): string {
  const clean = s.replace(/[^a-zA-Z0-9]/g, "");
  return clean.length > 0 ? clean : "TOKEN";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
    return { symbol: sanitizeSymbol(symbol), decimals: Number(decimals) };
  } catch {
    return { symbol: token.slice(2, 6).toUpperCase(), decimals: 18 };
  }
}

/** Chunked, retried, block-pinned multicall — the public RPC drops oversized blasts. */
async function chunkedMulticall<T>(
  client: PublicClient,
  calls: { address: Hex; abi: typeof v3PoolAbi; functionName: "ticks" | "tickBitmap"; args: readonly [number] }[],
  blockNumber: bigint,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < calls.length; i += CHUNK) {
    const chunk = calls.slice(i, i + CHUNK);
    let lastErr: unknown;
    let done = false;
    for (let attempt = 0; attempt < CHUNK_RETRIES && !done; attempt++) {
      try {
        const res = await client.multicall({ contracts: chunk, allowFailure: false, blockNumber });
        out.push(...(res as T[]));
        done = true;
      } catch (e) {
        lastErr = e;
        const backoff = 1000 * 2 ** attempt;
        console.log(
          `  projectx-snapshot: chunk ${Math.floor(i / CHUNK)} attempt ${attempt + 1} failed; retrying in ${backoff}ms`,
        );
        await sleep(backoff);
      }
    }
    if (!done) throw lastErr;
  }
  return out;
}

/**
 * Bitmap-driven COMPLETE initialized-tick enumeration at a pinned block: read
 * every tickBitmap word covering [MIN_TICK, MAX_TICK] on the pool's grid and
 * decode the set bits into tick indexes.
 */
async function scanAllInitializedTicks(
  client: PublicClient,
  pool: Hex,
  tickSpacing: number,
  blockNumber: bigint,
): Promise<number[]> {
  const minWord = Math.floor(Math.ceil(MIN_TICK / tickSpacing) / 256);
  const maxWord = Math.floor(Math.floor(MAX_TICK / tickSpacing) / 256);
  const words: number[] = [];
  for (let w = minWord; w <= maxWord; w++) words.push(w);

  const values = await chunkedMulticall<bigint>(
    client,
    words.map((w) => ({
      address: pool,
      abi: v3PoolAbi,
      functionName: "tickBitmap" as const,
      args: [w] as const,
    })),
    blockNumber,
  );

  const ticks: number[] = [];
  for (let i = 0; i < words.length; i++) {
    let v = values[i];
    if (v === 0n) continue;
    for (let b = 0; b < 256 && v > 0n; b++) {
      if ((v >> BigInt(b)) & 1n) ticks.push((words[i] * 256 + b) * tickSpacing);
      // (no early clear — keep the loop simple; 256 iterations per non-zero word)
    }
  }
  ticks.sort((a, b) => a - b);
  return ticks;
}

async function captureSnapshot(client: PublicClient, pool: Hex): Promise<ProdPoolSnapshot> {
  const chainId = await client.getChainId();
  // Pin EVERY read to one block so slot0/liquidity/ticks are mutually consistent.
  const blockNumber = await client.getBlockNumber();

  const [token0, token1, fee, tickSpacing, liquidity, slot0] = await Promise.all([
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: "token0", blockNumber }) as Promise<Hex>,
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: "token1", blockNumber }) as Promise<Hex>,
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: "fee", blockNumber }) as Promise<number>,
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: "tickSpacing", blockNumber }) as Promise<number>,
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: "liquidity", blockNumber }) as Promise<bigint>,
    client.readContract({ address: pool, abi: v3PoolAbi, functionName: "slot0", blockNumber }) as Promise<
      readonly [bigint, number, ...unknown[]]
    >,
  ]);

  const sqrtPriceX96 = slot0[0];
  const tick = Number(slot0[1]);
  const ts = Number(tickSpacing);
  const feeNum = Number(fee);

  const [sym0, sym1] = await Promise.all([symbolOf(client, token0), symbolOf(client, token1)]);

  // COMPLETE bitmap-driven boundary enumeration, then nets for exactly those.
  const boundaries = await scanAllInitializedTicks(client, pool, ts, blockNumber);
  console.log(
    `  projectx-snapshot: block ${blockNumber} — ${boundaries.length} initialized boundaries (complete bitmap scan)`,
  );
  const tickResults = await chunkedMulticall<
    [bigint, bigint, bigint, bigint, bigint, bigint, number, boolean]
  >(
    client,
    boundaries.map((b) => ({
      address: pool,
      abi: v3PoolAbi,
      functionName: "ticks" as const,
      args: [b] as const,
    })),
    blockNumber,
  );

  const ticks: [number, string][] = [];
  let sumAll = 0n;
  let sumToSpot = 0n;
  for (let i = 0; i < boundaries.length; i++) {
    const liquidityNet = tickResults[i][1];
    const initialized = tickResults[i][7];
    if (!initialized) {
      throw new Error(
        `projectx-snapshot: bitmap says tick ${boundaries[i]} is initialized but ticks() disagrees (inconsistent read)`,
      );
    }
    ticks.push([boundaries[i], liquidityNet.toString()]);
    sumAll += liquidityNet;
    if (boundaries[i] <= tick) sumToSpot += liquidityNet;
  }

  // Consistency invariants of a complete profile at one block:
  //   Σ all nets == 0, and Σ nets at-or-below the spot tick == active liquidity().
  if (sumAll !== 0n) {
    throw new Error(`projectx-snapshot: complete profile Σ liquidityNet != 0 (${sumAll})`);
  }
  if (sumToSpot !== liquidity) {
    throw new Error(
      `projectx-snapshot: Σ nets ≤ spot (${sumToSpot}) != liquidity() (${liquidity}) — inconsistent capture`,
    );
  }

  // windowTickSpacings is metadata for the fixed-window capturers; report the
  // farthest boundary distance so consumers see the profile's true span.
  const span = Math.max(
    ...boundaries.map((b) => Math.ceil(Math.abs(b - tick) / ts)),
  );

  return {
    _note:
      `COMPLETE bitmap-driven profile (every initialized tick, full range), block-pinned at ${blockNumber}. ` +
      `Invariants verified: sum(nets)==0, sum(nets<=spot)==liquidity().`,
    sourceTag: "projectx",
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
    windowTickSpacings: span,
  };
}

function chainName(chainId: number): string {
  if (chainId === 8453) return "base";
  if (chainId === 1) return "ethereum";
  if (chainId === 42161) return "arbitrum";
  if (chainId === 10) return "optimism";
  if (chainId === 999) return "hyperevm";
  return `chain${chainId}`;
}

/**
 * Probe getPool(WHYPE, USDT0, fee) for every enabled Project X tier and return
 * the existing pools with their active liquidity (deepest first).
 */
async function probeTiers(
  client: PublicClient,
): Promise<{ fee: number; pool: Hex; liquidity: bigint }[]> {
  const tiers = PROJECTX.feeTiers ?? HYPEREVM.feeTiers;
  const poolCalls = tiers.map((fee) => ({
    address: PROJECTX.address,
    abi: v3FactoryAbi,
    functionName: "getPool" as const,
    args: [WHYPE, USDT0, fee] as const,
  }));
  const poolRes = await client.multicall({ contracts: poolCalls, allowFailure: true });

  const found: { fee: number; pool: Hex }[] = [];
  for (let i = 0; i < tiers.length; i++) {
    const r = poolRes[i];
    if (r.status === "success" && r.result && BigInt(r.result as Hex) !== 0n) {
      found.push({ fee: tiers[i], pool: getAddress(r.result as Hex) });
    }
  }
  if (found.length === 0) {
    throw new Error(
      `projectx-snapshot: factory ${PROJECTX.address} returned no WHYPE/USDT0 pool across tiers ${tiers.join(",")}`,
    );
  }

  const liqRes = await client.multicall({
    contracts: found.map((f) => ({ address: f.pool, abi: v3PoolAbi, functionName: "liquidity" as const })),
    allowFailure: true,
  });
  const withLiq = found.map((f, i) => ({
    ...f,
    liquidity: liqRes[i].status === "success" ? (liqRes[i].result as bigint) : 0n,
  }));
  withLiq.sort((a, b) => (a.liquidity > b.liquidity ? -1 : a.liquidity < b.liquidity ? 1 : 0));
  return withLiq;
}

async function main(): Promise<void> {
  const rpcUrl = process.env.HYPEREVM_RPC_URL ?? DEFAULT_HYPEREVM_RPC;
  const client = await makeClient(rpcUrl);
  const arg = process.argv[2];

  let pool: Hex;
  if (arg && /^0x[0-9a-fA-F]{40}$/.test(arg)) {
    pool = getAddress(arg);
    console.log(`projectx-snapshot: capturing explicit pool ${pool}`);
  } else {
    const tiers = await probeTiers(client);
    console.log(
      `projectx-snapshot: WHYPE/USDT0 tiers found: ` +
        tiers.map((t) => `fee=${t.fee} L=${t.liquidity}`).join(", "),
    );
    if (arg && /^\d+$/.test(arg)) {
      const pick = tiers.find((t) => t.fee === Number(arg));
      if (!pick) throw new Error(`projectx-snapshot: no WHYPE/USDT0 pool at fee tier ${arg}`);
      pool = pick.pool;
      console.log(`projectx-snapshot: capturing pinned tier fee=${pick.fee} pool ${pool}`);
    } else {
      pool = tiers[0].pool;
      console.log(`projectx-snapshot: capturing DEEPEST tier fee=${tiers[0].fee} pool ${pool}`);
    }
  }

  const snap = await captureSnapshot(client, pool);

  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  // hyperevm-projectx-<symbol0><symbol1>-<fee>.json — fee-keyed (Project X's pool
  // key), matching the Uniswap-V3 fixture convention with a fork tag.
  const file = join(
    SNAPSHOT_DIR,
    `${chainName(snap.chainId)}-projectx-${snap.symbol0}${snap.symbol1}-${snap.fee}.json`,
  );
  writeFileSync(file, JSON.stringify(snap, null, 2) + "\n");

  console.log(
    `projectx-snapshot: wrote ${file}\n` +
      `  ${snap.symbol0}/${snap.symbol1} fee=${snap.fee} tickSpacing=${snap.tickSpacing}\n` +
      `  tick=${snap.tick} sqrtPriceX96=${snap.sqrtPriceX96} activeLiquidity=${snap.liquidity}\n` +
      `  initialized boundaries (COMPLETE profile): ${snap.ticks.length} (farthest ${snap.windowTickSpacings} tickSpacings from spot)`,
  );
}

main().catch((e) => {
  console.error("projectx-snapshot failed:", e);
  process.exit(1);
});
