/**
 * MegaSwap recipe entry point.
 *
 * Orchestrates off-chain preparation (pool discovery, quoting, slippage calculation)
 * and on-chain execution (SauceScript compilation + cook()).
 */

import { createPublicClient, http, defineChain, type Hex } from "viem";
import { createRequire } from "module";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import ts from "typescript";

import { prepareMegaSwap } from "./prepare";
import { MULTICALL3, SwapPoolType } from "../shared/constants";
import type { MegaSwapConfig, MegaSwapResult } from "../shared/types";

const require = createRequire(import.meta.url);
const { compile } = require("@eco-incorp/sauce-compiler");

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

export interface MegaSwapOutput {
  /** Compiled bytecodes ready for cook() */
  bytecodes: Hex[];
  /** Prepared pool data */
  prepared: MegaSwapResult;
  /** Generated SauceScript source (for debugging) */
  source: string;
}

/**
 * Build a pool tuple for compile args: [poolType, poolAddress, fee, tickSpacing, hooks]
 */
function buildPoolTuple(pool: { pool: { address: Hex; fee: number; poolType: SwapPoolType } }): bigint[] {
  const p = pool.pool;
  return [
    BigInt(p.poolType),          // poolType (UniV3=1, UniV4=2)
    BigInt(p.address),           // pool address
    BigInt(p.fee),               // fee tier
    0n,                          // tickSpacing (0 for V3)
    0n,                          // hooks (0 for V3)
  ];
}

/**
 * Prepare and compile a MegaSwap.
 *
 * @param config - Swap configuration (tokenIn, tokenOut, amountIn)
 * @param rpcUrl - RPC URL for the chain
 * @param sauceRouterAddress - Deployed SauceRouter address
 * @param caller - Address that will call cook() (for transferFrom)
 */
export async function megaSwap(
  config: MegaSwapConfig,
  rpcUrl: string,
  sauceRouterAddress: Hex,
  caller: Hex,
): Promise<MegaSwapOutput> {
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
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 120_000 }) });

  // Off-chain preparation
  const prepared = await prepareMegaSwap(config, client, sauceRouterAddress);

  // Read static SauceScript (no source manipulation!)
  const source = readFileSync(join(__dirname, "megaswap.sauce.ts"), "utf-8");

  // Strip TypeScript types for the transpiler (it parses JS)
  const jsSource = stripTypes(source);

  // Build pools array as array of tuples for compile args
  const poolTuples = prepared.pools.map(buildPoolTuple);

  // Compile to Sauce bytecodes — pool data passed as function args
  const result = compile(jsSource, {
    baseDir: REPO_ROOT,
    args: [
      config.tokenIn,              // tokenIn: Address
      config.tokenOut,             // tokenOut: Address
      config.amountIn,             // amountIn: Uint256
      caller,                      // caller: Address
      poolTuples,                    // pools: Tuple of Tuples
      prepared.stepSize,              // stepSize: Uint256
    ],
  });

  const bytecodes = result.bytecodes.map(toHex);

  return { bytecodes, prepared, source };
}
