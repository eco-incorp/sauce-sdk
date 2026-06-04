/**
 * AlphaSwap recipe entry point.
 *
 * Off-chain:  discover pools via factory multicalls (fast, no quoting)
 * On-chain:   read liquidity, split by depth, execute swaps (SauceScript)
 */

import { createPublicClient, http, defineChain, type Hex } from "viem";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import ts from "typescript";
import { compile as _compile } from "../../../../compiler/dist/index.js";

import { prepareAlphaSwap } from "./prepare.js";
import { MULTICALL3 } from "../shared/constants.js";
import type { AlphaSwapConfig, AlphaSwapPrepared, PoolInfo, DiscoveredMultiHopRoute } from "../shared/types.js";

// The full compiler (compiler-poc) supports args/bytecodes beyond the published types.
type ArgValue = string | bigint | bigint[][] | bigint[];
type FullCompile = (source: string, options?: {
  args?: ArgValue[];
  baseDir?: string;
  [k: string]: unknown;
}) => { bytecodes: Uint8Array[]; bytecode: Uint8Array; warnings: string[] };
const compile = _compile as unknown as FullCompile;

const __dirname = dirname(fileURLToPath(import.meta.url));

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

export interface AlphaSwapOutput {
  /** Compiled bytecodes ready for cook() */
  bytecodes: Hex[];
  /** Discovered pool data (no quotes -- decisions are on-chain) */
  prepared: AlphaSwapPrepared;
  /** Generated SauceScript source (for debugging) */
  source: string;
}

/**
 * Build a pool tuple: [poolType, poolAddress, fee, tickSpacing, hooks]
 */
function buildPoolTuple(p: PoolInfo): bigint[] {
  return [
    BigInt(p.poolType),
    BigInt(p.address),
    BigInt(p.fee),
    0n,  // tickSpacing (0 for V3)
    0n,  // hooks (0 for V3)
  ];
}

/**
 * Build a multi-hop route tuple:
 * [intermediateToken,
 *  hop1PoolType, hop1Pool, hop1Fee, hop1TickSpacing, hop1Hooks,
 *  hop2PoolType, hop2Pool, hop2Fee, hop2TickSpacing, hop2Hooks]
 */
function buildMultiHopTuple(r: DiscoveredMultiHopRoute): bigint[] {
  return [
    BigInt(r.intermediateToken),
    BigInt(r.hop1Pool.poolType),
    BigInt(r.hop1Pool.address),
    BigInt(r.hop1Pool.fee),
    0n,  // hop1 tickSpacing
    0n,  // hop1 hooks
    BigInt(r.hop2Pool.poolType),
    BigInt(r.hop2Pool.address),
    BigInt(r.hop2Pool.fee),
    0n,  // hop2 tickSpacing
    0n,  // hop2 hooks
  ];
}

/**
 * Prepare and compile an AlphaSwap.
 *
 * @param config - Swap configuration (tokenIn, tokenOut, amountIn)
 * @param rpcUrl - RPC URL for pool discovery
 * @param sauceRouterAddress - Deployed SauceRouter address (unused; kept for API compat)
 * @param caller - Address that will call cook() (for transferFrom)
 */
export async function alphaSwap(
  config: AlphaSwapConfig,
  rpcUrl: string,
  sauceRouterAddress: Hex,
  caller: Hex,
): Promise<AlphaSwapOutput> {
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

  // Off-chain: discover pools (no quoting)
  const prepared = await prepareAlphaSwap(config, client);

  console.log(
    `  Discovered: ${prepared.directPools.length} direct pools, ${prepared.multiHopRoutes.length} multi-hop routes`,
  );

  // Read static SauceScript (no source manipulation!)
  const source = readFileSync(join(__dirname, "alphaswap.sauce.ts"), "utf-8");

  // Strip TypeScript types for the transpiler (it parses JS)
  const jsSource = stripTypes(source);

  // Build pool data as arrays of tuples for compile args
  const directPoolTuples = prepared.directPools.map(buildPoolTuple);
  const multiHopTuples = prepared.multiHopRoutes.map(buildMultiHopTuple);

  // Compile to Sauce bytecodes -- pool data passed as function args
  const result = compile(jsSource, {
    args: [
      config.tokenIn,                         // tokenIn: Address
      config.tokenOut,                        // tokenOut: Address
      config.amountIn,                        // amountIn: Uint256
      caller,                                 // caller: Address
      directPoolTuples,                       // directPools: Tuple of Tuples
      multiHopTuples,                         // multiHopRoutes: Tuple of Tuples
    ],
  });

  const bytecodes = result.bytecodes.map(toHex);

  return { bytecodes, prepared, source };
}
