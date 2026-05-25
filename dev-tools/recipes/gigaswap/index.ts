/**
 * GigaSwap recipe entry point.
 *
 * Off-chain:  quote-based depth measurement → proportional split → global price limit
 * On-chain:   series 1 (splits + price limit) → series 2 (leftover sweep)
 */

import { createPublicClient, http, defineChain, type Hex } from "viem";
import { createRequire } from "module";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import ts from "typescript";

import { prepareGigaSwap } from "./prepare";
import { MULTICALL3 } from "../shared/constants";
import type { GigaSwapConfig, GigaSwapPrepared, DiscoveredMultiHopRoute } from "../shared/types";

const require = createRequire(import.meta.url);
const { compile } = require("sauce-compiler");

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

function toHex(bytes: Uint8Array): Hex {
  return ("0x" + Buffer.from(bytes).toString("hex")) as Hex;
}

function stripTypes(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
}

export interface GigaSwapOutput {
  /** Compiled bytecodes ready for cook() */
  bytecodes: Hex[];
  /** Prepared pool data with splits and price limit */
  prepared: GigaSwapPrepared;
  /** Generated SauceScript source (for debugging) */
  source: string;
}

/**
 * Build a direct pool tuple:
 * [poolType, poolAddress, fee, tickSpacing, hooks, splitAmount, preSqrtPrice]
 */
function buildDirectPoolTuple(p: { pool: { address: Hex; fee: number; poolType: number; sqrtPriceX96: bigint }; splitAmount: bigint }): bigint[] {
  return [
    BigInt(p.pool.poolType),
    BigInt(p.pool.address),
    BigInt(p.pool.fee),
    0n,  // tickSpacing (0 for V3)
    0n,  // hooks (0 for V3)
    p.splitAmount,
    p.pool.sqrtPriceX96,  // pre-swap price for series 2 depth measurement
  ];
}

/**
 * Build a multi-hop route tuple:
 * [intermediateToken,
 *  hop1PoolType, hop1Pool, hop1Fee, hop1TickSpacing, hop1Hooks,
 *  hop2PoolType, hop2Pool, hop2Fee, hop2TickSpacing, hop2Hooks,
 *  splitAmount, hop1PreSqrtPrice]
 */
function buildMultiHopTuple(r: { route: DiscoveredMultiHopRoute; splitAmount: bigint }): bigint[] {
  return [
    BigInt(r.route.intermediateToken),
    BigInt(r.route.hop1Pool.poolType),
    BigInt(r.route.hop1Pool.address),
    BigInt(r.route.hop1Pool.fee),
    0n,  // hop1 tickSpacing
    0n,  // hop1 hooks
    BigInt(r.route.hop2Pool.poolType),
    BigInt(r.route.hop2Pool.address),
    BigInt(r.route.hop2Pool.fee),
    0n,  // hop2 tickSpacing
    0n,  // hop2 hooks
    r.splitAmount,
    r.route.hop1Pool.sqrtPriceX96,  // hop1 pre-swap price for series 2
  ];
}

/**
 * Prepare and compile a GigaSwap.
 *
 * @param config - Swap configuration (tokenIn, tokenOut, amountIn)
 * @param rpcUrl - RPC URL for the chain
 * @param sauceRouterAddress - Deployed SauceRouter address
 * @param caller - Address that will call cook() (for transferFrom)
 */
export async function gigaSwap(
  config: GigaSwapConfig,
  rpcUrl: string,
  sauceRouterAddress: Hex,
  caller: Hex,
): Promise<GigaSwapOutput> {
  // Fetch chain ID and create client with multicall support
  const tempClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await tempClient.getChainId();
  const chain = defineChain({
    id: chainId,
    name: "Fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 120_000 }),
  });

  // Off-chain: discover, quote, split, derive price limit
  const prepared = await prepareGigaSwap(config, client, sauceRouterAddress);

  console.log(
    `  GigaSwap: ${prepared.priceLimitedPools.length} V3 pools, ` +
      `${prepared.noLimitPools.length} V2 pools, ` +
      `${prepared.multiHopRoutes.length} multi-hop routes`,
  );

  // Read static SauceScript (no source manipulation!)
  const source = readFileSync(join(__dirname, "gigaswap.sauce.ts"), "utf-8");
  const jsSource = stripTypes(source);

  // Build pool data as arrays of tuples for compile args
  const priceLimitedTuples = prepared.priceLimitedPools.map(buildDirectPoolTuple);
  const noLimitTuples = prepared.noLimitPools.map(buildDirectPoolTuple);
  const multiHopTuples = prepared.multiHopRoutes.map(buildMultiHopTuple);

  // Compile to Sauce bytecodes — pool data passed as function args
  const result = compile(jsSource, {
    baseDir: REPO_ROOT,
    args: [
      config.tokenIn,                         // tokenIn: Address
      config.tokenOut,                        // tokenOut: Address
      config.amountIn,                        // amountIn: Uint256
      caller,                                 // caller: Address
      priceLimitedTuples,                     // priceLimitedPools: Tuple of Tuples (V3/V4)
      noLimitTuples,                          // noLimitPools: Tuple of Tuples (V2/Solidly)
      multiHopTuples,                         // multiHopRoutes: Tuple of Tuples
      prepared.globalPriceLimit,              // globalPriceLimit: Uint256
    ],
  });

  const bytecodes = result.bytecodes.map(toHex);

  return { bytecodes, prepared, source };
}
