/**
 * Production V2-pair reserve snapshot capturer (RPC-gated, standalone).
 *
 * NOT imported by any test. Run it only when you have a live RPC:
 *
 *   BASE_RPC_URL=<url> npx tsx recipes/test/harness/v2-snapshot.ts [pairAddress]
 *
 * Probes the configured Base V2 factories for the WETH/USDC pair (or an explicit
 * pair address), reads its reserves + token0, and serialises a `ProdV2Snapshot`
 * to fixtures/snapshots/<chain>-v2-<symbol0><symbol1>.json. The prod-mirror V2
 * test reproduces that constant-product curve locally (etched V2Pair + matching
 * reserves) and runs EcoSwap through it offline.
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
} from "../../shared/constants";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, "..", "fixtures", "snapshots");

export interface ProdV2Snapshot {
  chainId: number;
  pair: Hex;
  token0: Hex;
  token1: Hex;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  /** Constant-product reserves (decimal strings), oriented to token0/token1. */
  reserve0: string;
  reserve1: string;
  /** Discovery label of the source factory. */
  source: string;
}

const v2FactoryAbi = parseAbi([
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
]);
const v2PairAbi = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

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

function chainName(chainId: number): string {
  return chainId === 8453 ? "base" : `chain${chainId}`;
}

async function main(): Promise<void> {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) {
    console.error("v2-snapshot: BASE_RPC_URL not set.");
    process.exit(0);
    return;
  }
  const client = await makeClient(rpcUrl);
  const arg = process.argv[2];

  // Resolve the deepest WETH/USDC V2 pair across the configured V2 factories
  // (or use an explicit pair address).
  let pair: Hex | undefined;
  let source = "explicit";
  if (arg && /^0x[0-9a-fA-F]{40}$/.test(arg)) {
    pair = getAddress(arg);
  } else {
    const v2Factories = BASE_CHAIN_POOL_CONFIG.factories.filter(
      (f) => f.factoryType === FactoryType.V2Standard,
    );
    let best = 0n;
    for (const f of v2Factories) {
      const p = (await client.readContract({
        address: f.address, abi: v2FactoryAbi, functionName: "getPair", args: [WETH, USDC],
      })) as Hex;
      if (!p || BigInt(p) === 0n) continue;
      const [r0, r1] = (await client.readContract({
        address: p, abi: v2PairAbi, functionName: "getReserves",
      })) as readonly [bigint, bigint, number];
      const depth = r0 < r1 ? r0 : r1;
      console.log(`  ${f.label}: pair ${p} reserves ${r0}/${r1}`);
      if (depth > best) {
        best = depth;
        pair = p;
        source = f.label;
      }
    }
  }
  if (!pair) {
    console.error("v2-snapshot: no WETH/USDC V2 pair with reserves found");
    process.exit(1);
    return;
  }

  const [token0, token1, reserves] = await Promise.all([
    client.readContract({ address: pair, abi: v2PairAbi, functionName: "token0" }) as Promise<Hex>,
    client.readContract({ address: pair, abi: v2PairAbi, functionName: "token1" }) as Promise<Hex>,
    client.readContract({ address: pair, abi: v2PairAbi, functionName: "getReserves" }) as Promise<
      readonly [bigint, bigint, number]
    >,
  ]);
  const [sym0, sym1] = await Promise.all([symbolOf(client, token0), symbolOf(client, token1)]);
  const chainId = await client.getChainId();

  const snap: ProdV2Snapshot = {
    chainId,
    pair: getAddress(pair),
    token0: getAddress(token0),
    token1: getAddress(token1),
    symbol0: sym0.symbol,
    symbol1: sym1.symbol,
    decimals0: sym0.decimals,
    decimals1: sym1.decimals,
    reserve0: reserves[0].toString(),
    reserve1: reserves[1].toString(),
    source,
  };

  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const file = join(SNAPSHOT_DIR, `${chainName(chainId)}-v2-${snap.symbol0}${snap.symbol1}.json`);
  writeFileSync(file, JSON.stringify(snap, null, 2) + "\n");
  console.log(
    `v2-snapshot: wrote ${file}\n  ${snap.symbol0}/${snap.symbol1} (${snap.source}) reserves ${snap.reserve0}/${snap.reserve1}`,
  );
}

main().catch((e) => {
  console.error("v2-snapshot failed:", e);
  process.exit(1);
});
