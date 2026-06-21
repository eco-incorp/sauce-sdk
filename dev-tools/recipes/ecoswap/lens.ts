/**
 * EcoSwap on-chain prepare LENS — off-chain caller + decoder.
 *
 * Compiles ecoswap.lens.sauce.ts, invokes it through the engine via ONE read-only
 * eth_call `cook(bytes[])` (viem simulateContract — the pattern in
 * dev-tools/test/e2e.test.ts:147-164), and decodes the returned raw reads.
 *
 * The lens collapses what used to be ~100 discovery/state/tick RPCs into ONE
 * eth_call. It returns ONLY raw reads; bracket build + sort + water-fill + trim +
 * route composition stay in prepare.ts.
 *
 * Return shape (must mirror ecoswap.lens.sauce.ts EXACTLY):
 *   abi.encode(poolBlob: bytes, tickBlob: bytes)
 *   poolBlob = 11 words/pool: [type,addr,fee,tickSpacing,hooks,sqrtP,liq,tickRaw,inIsToken0,stateView,poolId]
 *   tickBlob = 3 words/row:   [poolIdx, tickIndexRaw, liquidityNetRaw]
 * Signed words (tickRaw int24, tickIndexRaw int24, liquidityNetRaw int128) are
 * ZERO-extended on return; reinterpreted here via BigInt.asIntN.
 */

import { createRequire } from "module";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import ts from "typescript";
import {
  parseAbi,
  decodeAbiParameters,
  keccak256,
  encodeAbiParameters,
  type PublicClient,
  type Abi,
  type Hex,
} from "viem";

import {
  SwapPoolType,
  FactoryType,
  type ChainPoolConfig,
  type FactoryConfig,
} from "./../shared/constants";

const require = createRequire(import.meta.url);
const { compile } = require("@eco-incorp/sauce-compiler");

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const POOL_STRIDE = 11;
const TICK_STRIDE = 3;
const ZERO_HOOKS = "0x0000000000000000000000000000000000000000" as Hex;

const cookAbi = parseAbi([
  "function cook(bytes[] ingredients) payable returns (bytes returnData)",
]);

function toHex(bytes: Uint8Array): Hex {
  return ("0x" + Buffer.from(bytes).toString("hex")) as Hex;
}

function stripTypes(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
}

/** Slice a raw bytes blob into its 32-byte words as bigints. */
function decodeWords(blob: Hex): bigint[] {
  const hex = blob.slice(2);
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) {
    out.push(BigInt("0x" + hex.slice(i, i + 64)));
  }
  return out;
}

/** V4 poolId = keccak256(abi.encode(PoolKey)). Mirrors discovery's computeV4PoolId. */
function computeV4PoolId(
  currency0: Hex,
  currency1: Hex,
  fee: number,
  tickSpacing: number,
  hooks: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [currency0, currency1, fee, tickSpacing, hooks],
    ),
  );
}

const TICK_SPACING_BY_FEE: Record<number, number> = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 };
function feeToTickSpacing(fee: number): number {
  return TICK_SPACING_BY_FEE[fee] ?? 60;
}

/** One discovered direct pool, decoded from the lens poolBlob. */
export interface LensPool {
  poolType: SwapPoolType;
  address: Hex;
  fee: number;
  tickSpacing: number;
  hooks: Hex;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  /** Signed current tick (asIntN(24)). 0 for V2. */
  tick: number;
  /** V2 only: tokenIn is pool.token0. */
  inIsToken0: boolean;
  /** V4 only. */
  stateView: Hex;
  poolId: Hex;
  /** liquidityNet keyed by tick boundary (signed), for the scanned window. V3/V4 only. */
  net: Map<number, bigint>;
}

/** Decoded lens output: every direct pool with live state + tick window. */
export interface LensResult {
  pools: LensPool[];
}

export interface LensCallParams {
  tokenIn: Hex;
  tokenOut: Hex;
  zeroForOne: boolean;
  /** V3_TICK_STEPS — window size per pool (matches prepare.ts). */
  tickSteps: number;
}

/**
 * Compile + invoke the lens via ONE eth_call cook() and decode the raw reads.
 *
 * Discovery config is derived from poolConfig: V3Standard factories (each with its
 * own feeTiers), V2Standard factories, and UniswapV4 factories (with stateView).
 * V4 poolIds are precomputed off-chain (keccak of the sorted PoolKey) and passed in.
 */
export async function runLens(
  client: PublicClient,
  sauceRouter: Hex,
  poolConfig: ChainPoolConfig,
  params: LensCallParams,
): Promise<LensResult> {
  const { tokenIn, tokenOut, zeroForOne, tickSteps } = params;

  // Group factories the same way discoverPools does, but only the three families
  // the lens understands (V2/V3/V4). Others are not collapsed in v1.
  const v3Factories: FactoryConfig[] = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.V3Standard,
  );
  const v2Factories: FactoryConfig[] = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.V2Standard,
  );
  const v4Factories: FactoryConfig[] = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.UniswapV4 && !!f.stateView,
  );

  // For per-factory fee tiers, the lens currently uses ONE global v3FeeTiers list.
  // To honor per-factory tiers (Pancake 2500 ≠ Uni 3000) we expand the V3 list as
  // ONE flat fee-tier list = union of each factory's tiers; getPool returns 0 for
  // tiers a factory doesn't have, so over-querying is harmless (just discovered as
  // absent). Keep it bounded to the configured tiers.
  const v3FeeSet = new Set<number>();
  for (const f of v3Factories) for (const fee of f.feeTiers ?? poolConfig.feeTiers) v3FeeSet.add(fee);
  const v3FeeTiers = [...v3FeeSet];

  // V4: sorted currencies + precomputed poolIds per (factory × spec).
  const [currency0, currency1] =
    BigInt(tokenIn) < BigInt(tokenOut) ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
  const v4SpecSet = new Set<number>();
  for (const f of v4Factories) for (const fee of f.feeTiers ?? poolConfig.feeTiers) v4SpecSet.add(fee);
  const v4Fees = [...v4SpecSet];
  const v4Specs = v4Fees.map((fee) => ({ fee, tickSpacing: feeToTickSpacing(fee) }));
  // poolIds row-major over (factory, spec): index = qi*specs.length + si.
  const v4PoolIds: Hex[] = [];
  for (let qi = 0; qi < v4Factories.length; qi++) {
    for (const spec of v4Specs) {
      v4PoolIds.push(computeV4PoolId(currency0, currency1, spec.fee, spec.tickSpacing, ZERO_HOOKS));
    }
  }

  const source = readFileSync(join(__dirname, "ecoswap.lens.sauce.ts"), "utf-8");
  const jsSource = stripTypes(source);

  const result = compile(jsSource, {
    baseDirs: [REPO_ROOT, __dirname],
    args: [
      BigInt(tokenIn),
      BigInt(tokenOut),
      zeroForOne ? 1n : 0n,
      BigInt(tickSteps),
      v3Factories.map((f) => [BigInt(f.address)]),
      v3FeeTiers.map((fee) => [BigInt(fee)]),
      v2Factories.map((f) => [BigInt(f.address)]),
      v4Factories.map((f) => [BigInt(f.address), BigInt(f.stateView as Hex)]),
      v4Specs.map((s) => [BigInt(s.fee), BigInt(s.tickSpacing)]),
      v4PoolIds.map((id) => [BigInt(id)]),
    ],
  });

  const segments: Uint8Array[] = result.bytecode ?? result.bytecodes;
  const bytecodes = segments.map(toHex);

  // ONE read-only eth_call cook() — the entire discovery + state + tick read.
  const { result: returnData } = await client.simulateContract({
    address: sauceRouter,
    abi: cookAbi as Abi,
    functionName: "cook",
    args: [bytecodes],
    account: "0x0000000000000000000000000000000000000001" as Hex,
  });

  const [poolBlob, tickBlob] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes" }],
    returnData as Hex,
  ) as [Hex, Hex];

  return decodeLens(poolBlob, tickBlob);
}

/** Decode the lens poolBlob/tickBlob into LensPool[] with reconstructed net maps. */
export function decodeLens(poolBlob: Hex, tickBlob: Hex): LensResult {
  const pw = decodeWords(poolBlob);
  const tw = decodeWords(tickBlob);
  const nPools = Math.floor(pw.length / POOL_STRIDE);

  const pools: LensPool[] = [];
  for (let i = 0; i < nPools; i++) {
    const o = i * POOL_STRIDE;
    const poolType = Number(pw[o]) as SwapPoolType;
    const addr = ("0x" + pw[o + 1].toString(16).padStart(40, "0")) as Hex;
    const stateViewWord = pw[o + 9];
    const poolIdWord = pw[o + 10];
    pools.push({
      poolType,
      address: addr,
      fee: Number(pw[o + 2]),
      tickSpacing: Number(pw[o + 3]),
      hooks: ("0x" + pw[o + 4].toString(16).padStart(40, "0")) as Hex,
      sqrtPriceX96: pw[o + 5],
      liquidity: pw[o + 6],
      tick: Number(BigInt.asIntN(24, pw[o + 7])),
      inIsToken0: pw[o + 8] === 1n,
      stateView: ("0x" + stateViewWord.toString(16).padStart(40, "0")) as Hex,
      poolId: ("0x" + poolIdWord.toString(16).padStart(64, "0")) as Hex,
      net: new Map<number, bigint>(),
    });
  }

  const nRows = Math.floor(tw.length / TICK_STRIDE);
  for (let r = 0; r < nRows; r++) {
    const o = r * TICK_STRIDE;
    const poolIdx = Number(tw[o]);
    if (poolIdx < 0 || poolIdx >= pools.length) continue;
    const tickIdx = Number(BigInt.asIntN(24, tw[o + 1]));
    const net = BigInt.asIntN(128, tw[o + 2]);
    if (net !== 0n) pools[poolIdx].net.set(tickIdx, net);
  }

  return { pools };
}
