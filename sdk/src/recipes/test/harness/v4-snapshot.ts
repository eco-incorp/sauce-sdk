/**
 * Production V4-pool tick-state snapshot capturer (RPC-gated, standalone).
 *
 *   BASE_RPC_URL=<url> npx tsx src/recipes/test/harness/v4-snapshot.ts [feeTier]
 *
 * V4 is a singleton: a pool is identified by poolId = keccak256(abi.encode(PoolKey)).
 * This probes the WETH/USDC hookless pool across the standard fee tiers via the
 * StateView lens, picks the initialised one with the most liquidity, and captures
 * its slot0 + active liquidity + a WINDOW of initialised ticks (getTickLiquidity)
 * around the live tick. The prod-mirror V4 test reproduces that profile inside the
 * etched PoolManager and runs EcoSwap through it offline.
 *
 * The snapshot reuses the V3 `ProdPoolSnapshot` field shape (so reproduce-pool's
 * segment derivation applies unchanged) plus the V4 keys (poolId/currencies/hooks).
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
  keccak256,
  encodeAbiParameters,
  type PublicClient,
  type Hex,
} from "viem";

import {
  MULTICALL3,
  WETH,
  USDC,
  UNISWAP_V4_STATE_VIEW,
} from "../../shared/constants";
import type { ProdPoolSnapshot } from "./prod-snapshot";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "..", "fixtures", "snapshots");
const ZERO_HOOKS = "0x0000000000000000000000000000000000000000" as Hex;
const WINDOW_TICKSPACINGS = 30;

/** V4 prod snapshot: a ProdPoolSnapshot plus the singleton key fields. */
export interface ProdV4Snapshot extends ProdPoolSnapshot {
  poolId: Hex;
  currency0: Hex;
  currency1: Hex;
  hooks: Hex;
}

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
  "function getTickLiquidity(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)",
]);
const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const TICK_SPACING_BY_FEE: Record<number, number> = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 };

function poolIdOf(c0: Hex, c1: Hex, fee: number, tickSpacing: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [c0, c1, fee, tickSpacing, ZERO_HOOKS],
    ),
  );
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
    return { symbol, decimals: Number(decimals) };
  } catch {
    return { symbol: token.slice(2, 6).toUpperCase(), decimals: 18 };
  }
}

async function main(): Promise<void> {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) {
    console.error("v4-snapshot: BASE_RPC_URL not set.");
    process.exit(0);
    return;
  }
  const client = await makeClient(rpcUrl);
  const chainId = await client.getChainId();

  const [currency0, currency1] =
    BigInt(WETH) < BigInt(USDC) ? [WETH, USDC] : [USDC, WETH];
  const argFee = process.argv[2] ? Number(process.argv[2]) : undefined;
  const feeTiers = argFee ? [argFee] : [100, 500, 3000, 10000];

  // Probe each fee tier; keep the initialised pool with the most liquidity.
  let chosen: { fee: number; tickSpacing: number; poolId: Hex; sqrtPriceX96: bigint; tick: number; liquidity: bigint } | undefined;
  for (const fee of feeTiers) {
    const tickSpacing = TICK_SPACING_BY_FEE[fee] ?? 60;
    const poolId = poolIdOf(currency0, currency1, fee, tickSpacing);
    const slot0 = (await client.readContract({
      address: UNISWAP_V4_STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [poolId],
    })) as readonly [bigint, number, number, number];
    const liquidity = (await client.readContract({
      address: UNISWAP_V4_STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId],
    })) as bigint;
    console.log(`  fee ${fee}: poolId ${poolId.slice(0, 10)}… sqrtP ${slot0[0]} liquidity ${liquidity}`);
    if (slot0[0] > 0n && liquidity > 0n && (!chosen || liquidity > chosen.liquidity)) {
      chosen = { fee, tickSpacing, poolId, sqrtPriceX96: slot0[0], tick: Number(slot0[1]), liquidity };
    }
  }
  if (!chosen) {
    console.error("v4-snapshot: no initialised WETH/USDC V4 pool with liquidity found");
    process.exit(1);
    return;
  }

  const [sym0, sym1] = await Promise.all([symbolOf(client, currency0), symbolOf(client, currency1)]);

  // Capture the initialised-tick window around the live tick (one multicall).
  const base = Math.floor(chosen.tick / chosen.tickSpacing) * chosen.tickSpacing;
  const boundaries: number[] = [];
  for (let k = -WINDOW_TICKSPACINGS; k <= WINDOW_TICKSPACINGS; k++) boundaries.push(base + k * chosen.tickSpacing);
  const results = await client.multicall({
    contracts: boundaries.map((b) => ({
      address: UNISWAP_V4_STATE_VIEW, abi: stateViewAbi, functionName: "getTickLiquidity" as const, args: [chosen!.poolId, b] as const,
    })),
    allowFailure: true,
  });
  const ticks: [number, string][] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const r = results[i];
    if (r.status !== "success") continue;
    const net = (r.result as readonly [bigint, bigint])[1];
    if (net !== 0n) ticks.push([boundaries[i], net.toString()]);
  }

  const snap: ProdV4Snapshot = {
    chainId,
    pool: UNISWAP_V4_STATE_VIEW, // not a per-pool address in V4; kept for schema parity
    poolId: chosen.poolId,
    currency0: getAddress(currency0),
    currency1: getAddress(currency1),
    hooks: ZERO_HOOKS,
    token0: getAddress(currency0),
    token1: getAddress(currency1),
    symbol0: sym0.symbol,
    symbol1: sym1.symbol,
    decimals0: sym0.decimals,
    decimals1: sym1.decimals,
    fee: chosen.fee,
    tickSpacing: chosen.tickSpacing,
    sqrtPriceX96: chosen.sqrtPriceX96.toString(),
    tick: chosen.tick,
    liquidity: chosen.liquidity.toString(),
    ticks,
    windowTickSpacings: WINDOW_TICKSPACINGS,
  };

  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const file = join(SNAPSHOT_DIR, `base-v4-${snap.symbol0}${snap.symbol1}-${snap.fee}.json`);
  writeFileSync(file, JSON.stringify(snap, null, 2) + "\n");
  console.log(
    `v4-snapshot: wrote ${file}\n  ${snap.symbol0}/${snap.symbol1} fee=${snap.fee} tickSpacing=${snap.tickSpacing}\n` +
      `  tick=${snap.tick} sqrtPriceX96=${snap.sqrtPriceX96} activeLiquidity=${snap.liquidity}\n` +
      `  initialised boundaries in window: ${snap.ticks.length} (±${WINDOW_TICKSPACINGS} tickSpacings)`,
  );
}

main().catch((e) => {
  console.error("v4-snapshot failed:", e);
  process.exit(1);
});
