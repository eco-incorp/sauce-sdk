/**
 * EcoSwap recipe entry point.
 *
 * Off-chain:  reconstruct per-tick liquidity brackets for every pool, build a
 *             global fee-adjusted marginal-price ladder.
 * On-chain:   greedy water-fill over the ladder using LIVE prices, then one
 *             swap per pool (one per hop for routes) — equal marginal price =
 *             synchronized minimal slippage, no per-pool price-limit needed.
 */

import { createPublicClient, http, defineChain, type Hex } from "viem";
import { createRequire } from "module";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import ts from "typescript";

import { prepareEcoSwap, type EcoSwapPrepareOpts } from "./prepare";
import { MULTICALL3, BASE_CHAIN_POOL_CONFIG, type ChainPoolConfig } from "../shared/constants";
import type { EcoSwapConfig, EcoSwapPrepared, EcoPool, EcoRoute, EcoBracket } from "../shared/types";

const require = createRequire(import.meta.url);
const { compile } = require("@eco-incorp/sauce-compiler");

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

function toHex(bytes: Uint8Array): Hex {
  return ("0x" + Buffer.from(bytes).toString("hex")) as Hex;
}

function stripTypes(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
}

export interface EcoSwapOutput {
  bytecodes: Hex[];
  prepared: EcoSwapPrepared;
  source: string;
}

// ── Compile-arg tuple builders (all values are bigint scalars) ──

/** [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0, stateView, poolId] */
function buildPoolTuple(p: EcoPool): bigint[] {
  return [
    BigInt(p.poolType),
    BigInt(p.address),
    BigInt(p.fee),
    BigInt(p.tickSpacing),
    BigInt(p.hooks),
    BigInt(p.feePpm),
    p.isV2 ? 1n : 0n,
    p.inIsToken0 ? 1n : 0n,
    BigInt(p.stateView), // V4 StateView lens (0 for V2/V3)
    BigInt(p.poolId), // V4 poolId (0 for V2/V3)
  ];
}

/**
 * [inter, h1Type,h1Pool,h1Fee,h1TS,h1Hooks, h2Type,h2Pool,h2Fee,h2TS,h2Hooks]
 * (tickSpacing/hooks default to 0 — routes use V3/V2 pools discovered with V3 keys).
 */
function buildRouteTuple(r: EcoRoute): bigint[] {
  const { hop1Pool, hop2Pool, intermediateToken } = r.route;
  return [
    BigInt(intermediateToken),
    BigInt(hop1Pool.poolType),
    BigInt(hop1Pool.address),
    BigInt(hop1Pool.fee),
    0n,
    0n,
    BigInt(hop2Pool.poolType),
    BigInt(hop2Pool.address),
    BigInt(hop2Pool.fee),
    0n,
    0n,
  ];
}

/** [kind, refIdx, sqrtNear, sqrtFar, liquidity, capacity, sqrtAdjNear, sqrtAdjFar] */
function buildBracketTuple(b: EcoBracket): bigint[] {
  return [
    BigInt(b.kind),
    BigInt(b.refIdx),
    b.sqrtNear,
    b.sqrtFar,
    b.liquidity,
    b.capacity,
    b.sqrtAdjNear,
    b.sqrtAdjFar,
  ];
}

/**
 * Prepare and compile an EcoSwap.
 *
 * @param config - Swap configuration (tokenIn, tokenOut, amountIn)
 * @param rpcUrl - RPC URL for the chain
 * @param sauceRouterAddress - Deployed SauceRouter address (used for quoting routes)
 * @param caller - Address that will call cook() (for transferFrom)
 * @param poolConfig - Optional chain pool-discovery config (factories/fee tiers/
 *   base tokens). Omitted → prepareEcoSwap defaults to BASE_CHAIN_POOL_CONFIG,
 *   preserving prior behavior. Lets tests point discovery at local pools.
 */
export async function ecoSwap(
  config: EcoSwapConfig,
  rpcUrl: string,
  sauceRouterAddress: Hex,
  caller: Hex,
  poolConfig?: ChainPoolConfig,
  opts?: EcoSwapPrepareOpts,
): Promise<EcoSwapOutput> {
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

  const prepared = await prepareEcoSwap(
    config,
    client,
    sauceRouterAddress,
    poolConfig ?? BASE_CHAIN_POOL_CONFIG,
    opts ?? {},
  );

  // Solver selection: the default two-pass solver, or the single-pass (live-cut)
  // variant via ECO_SOLVER=singlepass. Both consume the SAME prepared data; the
  // single-pass folds Phase A+B into one sweep with unrolled per-pool registers.
  const solverFile =
    process.env.ECO_SOLVER === "singlepass" ? "ecoswap.singlepass.sauce.ts" : "ecoswap.sauce.ts";
  const source = readFileSync(join(__dirname, solverFile), "utf-8");
  const jsSource = stripTypes(source);

  const result = compile(jsSource, {
    // REPO_ROOT resolves "./artifacts/*.json"; __dirname resolves "./IUniswapV2Pair.json".
    baseDirs: [REPO_ROOT, __dirname],
    args: [
      BigInt(config.tokenIn),
      BigInt(config.tokenOut),
      config.amountIn,
      BigInt(caller),
      prepared.zeroForOne ? 1n : 0n,
      prepared.priceLimit,
      prepared.pools.map(buildPoolTuple),
      prepared.routes.map(buildRouteTuple),
      prepared.brackets.map(buildBracketTuple),
    ],
  });

  // This compiler returns { bytecode }; older recipe drafts referenced `bytecodes`.
  const segments: Uint8Array[] = result.bytecode ?? result.bytecodes;
  const bytecodes = segments.map(toHex);

  return { bytecodes, prepared, source };
}
