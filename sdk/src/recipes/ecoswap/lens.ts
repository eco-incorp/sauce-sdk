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
 *   poolBlob = a 4-word HEADER [discoveredCount, survivorCount, totalCap, capFloor]
 *              followed by survivorCount × 13-word pool rows
 *              [type,addr,fee,tickSpacing,hooks,sqrtP,liq,tickRaw,inIsToken0,stateView,poolId,scannedForward,scannedReverse]
 *   tickBlob = 3 words/row:   [poolIdx, tickIndexRaw, liquidityNetRaw]
 * The lens is the SINGLE SOURCE OF TRUTH for survivorship: it only emits pool rows
 * whose IN-RANGE (windowed) capacity clears the relative-depth floor — measured
 * across the crossed ticks, not spot active-L — so the consumer never re-filters.
 * Signed words (tickRaw int24, tickIndexRaw int24, liquidityNetRaw int128) are
 * ZERO-extended on return; reinterpreted here via BigInt.asIntN.
 *
 * v2 (LAZY): the lens reads ONLY the ticks the trade can cross, not a fixed 96
 * window. Each survivor's poolBlob carries `scannedForward` AND `scannedReverse`
 * — the number of tick boundaries the lens actually walked in the swap direction
 * and on the opposite (drift) side of spot. buildV3Brackets walks EXACTLY these
 * counts (never past the lens's data, so it never fabricates phantom brackets):
 * `scannedForward` forward brackets (the swap path) plus `scannedReverse` reverse
 * brackets ABOVE spot (capacity-0; consumed only by Phase B when the live price
 * has drifted against the swap between prepare and execution).
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
} from "../shared/constants.js";

const require = createRequire(import.meta.url);
const { compile } = require("@eco-incorp/sauce-compiler");

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const HEADER_WORDS = 4; // [discoveredCount, survivorCount, totalCap, capFloor]
const POOL_STRIDE = 13;
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

/**
 * Per-tickSpacing multiplicative step ratio used by the lens's lazy walk:
 *   stepRatio = floor( sqrt(1.0001^tickSpacing) * 2^96 ).
 * The lens steps √price UP via mulDiv(√,stepRatio,2^96) and DOWN via
 * mulDiv(√,2^96,stepRatio). Only the lens's internal capacity accounting uses
 * this (to decide HOW MANY ticks to scan); the emitted data is (tickIndex,net),
 * and prepare.ts recomputes exact sqrts via getSqrtRatioAtTick — so the
 * multiplicative drift here only affects the scanned COUNT (covered by drift +
 * the floor upper bound), never the bracket prices.
 *
 * sqrt(1.0001^ts) = 1.0001^(ts/2) = getSqrtRatioAtTick(ts) (which is exactly the
 * Q96 sqrt price at tick=ts). Reuse the exact TickMath there for fidelity.
 */
function stepRatioForSpacing(tickSpacing: number): bigint {
  return getSqrtRatioAtTickLocal(tickSpacing);
}

/** Exact Uniswap V3 TickMath.getSqrtRatioAtTick (Q96). Local copy for stepRatio. */
function getSqrtRatioAtTickLocal(tick: number): bigint {
  const absTick = BigInt(tick < 0 ? -tick : tick);
  let ratio =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  const mul = (m: bigint) => {
    ratio = (ratio * m) >> 128n;
  };
  if (absTick & 0x2n) mul(0xfff97272373d413259a46990580e213an);
  if (absTick & 0x4n) mul(0xfff2e50f5f656932ef12357cf3c7fdccn);
  if (absTick & 0x8n) mul(0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if (absTick & 0x10n) mul(0xffcb9843d60f6159c9db58835c926644n);
  if (absTick & 0x20n) mul(0xff973b41fa98c081472e6896dfb254c0n);
  if (absTick & 0x40n) mul(0xff2ea16466c96a3843ec78b326b52861n);
  if (absTick & 0x80n) mul(0xfe5dee046a99a2a811c461f1969c3053n);
  if (absTick & 0x100n) mul(0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if (absTick & 0x200n) mul(0xf987a7253ac413176f2b074cf7815e54n);
  if (absTick & 0x400n) mul(0xf3392b0822b70005940c7a398e4b70f3n);
  if (absTick & 0x800n) mul(0xe7159475a2c29b7443b29c7fa6e889d9n);
  if (absTick & 0x1000n) mul(0xd097f3bdfd2022b8845ad8f792aa5825n);
  if (absTick & 0x2000n) mul(0xa9f746462d870fdf8a65dc1f90e061e5n);
  if (absTick & 0x4000n) mul(0x70d869a156d2a1b890bb3df62baf32f7n);
  if (absTick & 0x8000n) mul(0x31be135f97d08fd981231505542fcfa6n);
  if (absTick & 0x10000n) mul(0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if (absTick & 0x20000n) mul(0x5d6af8dedb81196699c329225ee604n);
  if (absTick & 0x40000n) mul(0x2216e584f5fa1ea926041bedfe98n);
  if (absTick & 0x80000n) mul(0x48a170391f7dc42444e8fa2n);
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
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
  /**
   * Number of FORWARD tick boundaries the lens actually walked (lazy). The off-
   * chain bracket build must STOP at this — never walk past the lens's data.
   * 0 for V2 and for dust pools the lens chose not to scan.
   */
  scannedForward: number;
  /**
   * Number of REVERSE-drift tick boundaries the lens walked on the OPPOSITE side
   * of spot (= driftTicks for survivors, 0 for V2/dust). buildV3Brackets walks
   * exactly this many reverse boundaries to extend the curve above spot for
   * runtime price drift against the swap — never past the lens's data.
   */
  scannedReverse: number;
  /**
   * EVERY tick index the lens emitted a row for (forward walk + reverse drift),
   * including uninitialized (net 0) ticks the `net` map omits. Lets callers see
   * the full scanned span (e.g. that reads straddle spot for drift coverage).
   */
  scannedTickIndices: number[];
}

/** Decoded lens output: every SURVIVOR pool with live state + tick window. */
export interface LensResult {
  /** Survivor pools (already past the in-range-capacity floor on-chain). */
  pools: LensPool[];
  /** Total alive pools the lens discovered (survivors + dropped). */
  discoveredCount: number;
  /** Pool rows actually returned (= pools.length). */
  survivorCount: number;
  /** Σ IN-RANGE (windowed) capacity over alive pools, in gross tokenIn (diagnostics). */
  totalInRangeCapacity: bigint;
  /** The in-range-capacity survivor threshold the lens applied (gross tokenIn). */
  capacityFloor: bigint;
}

export interface LensCallParams {
  tokenIn: Hex;
  tokenOut: Hex;
  zeroForOne: boolean;
  /** Gross tokenIn — sizes the lazy walk (the trade can't cross past what this buys). */
  amountIn: bigint;
  /** Extra tick boundaries scanned past the stop, on EACH side (default 2). */
  driftTicks?: number;
  /**
   * Survivor floor in bps of Σ IN-RANGE capacity — the SOLE survivor gate (no
   * absolute floor). Pools whose windowed capacity (gross tokenIn absorbed across
   * the crossed ticks) is below this fraction of the total are not emitted. 0
   * disables (every alive pool survives).
   */
  minRelBps?: number;
  /** Hard cap on forward tick reads per pool (mirrors prepare.ts V3_TICK_STEPS=96). */
  maxTicks?: number;
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
  const { tokenIn, tokenOut, zeroForOne, amountIn } = params;
  const driftTicks = params.driftTicks ?? 2;
  const minRelBps = params.minRelBps ?? 0;
  const maxTicks = params.maxTicks ?? 96;

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
  const v4Specs = v4Fees.map((fee) => {
    const tickSpacing = feeToTickSpacing(fee);
    return { fee, tickSpacing, stepRatio: stepRatioForSpacing(tickSpacing) };
  });
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
      amountIn,
      BigInt(driftTicks),
      BigInt(minRelBps),
      BigInt(maxTicks),
      v3Factories.map((f) => [BigInt(f.address)]),
      v3FeeTiers.map((fee) => [BigInt(fee), stepRatioForSpacing(feeToTickSpacing(fee))]),
      v2Factories.map((f) => [BigInt(f.address)]),
      v4Factories.map((f) => [BigInt(f.address), BigInt(f.stateView as Hex)]),
      v4Specs.map((s) => [BigInt(s.fee), BigInt(s.tickSpacing), s.stepRatio]),
      v4PoolIds.map((id) => [BigInt(id)]),
    ],
  });

  const segments: Uint8Array[] = result.bytecode ?? result.bytecodes;
  const bytecodes = segments.map(toHex);

  // ONE read-only eth_call cook() — the entire discovery + state + tick read.
  // The lens runs up to 4 discovery passes × maxTicks × every pool of staticcalls
  // on the interpreter, which for a large universe (≈10 pools) blows past the
  // default eth_call gas cap (a node caps an eth_call's gas at the block gas
  // limit). Since this is a read-only call (never mined), pass a high explicit gas
  // so the node uses it as the call cap — set up to the test anvil's raised block
  // gas limit (harness/anvil.ts boots with --gas-limit 2e9). On a live RPC this is
  // clamped to that provider's eth_call cap, which is plenty for a single chain's
  // direct-pool universe.
  const { result: returnData } = await client.simulateContract({
    address: sauceRouter,
    abi: cookAbi as Abi,
    functionName: "cook",
    args: [bytecodes],
    account: "0x0000000000000000000000000000000000000001" as Hex,
    gas: 2_000_000_000n,
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

  // HEADER (4 words) precedes the survivor rows. Every row after it is a survivor.
  const discoveredCount = pw.length >= HEADER_WORDS ? Number(pw[0]) : 0;
  const survivorCount = pw.length >= HEADER_WORDS ? Number(pw[1]) : 0;
  const totalInRangeCapacity = pw.length >= HEADER_WORDS ? pw[2] : 0n;
  const capacityFloor = pw.length >= HEADER_WORDS ? pw[3] : 0n;
  const rowsBase = HEADER_WORDS;
  const nPools = Math.floor((pw.length - rowsBase) / POOL_STRIDE);

  const pools: LensPool[] = [];
  for (let i = 0; i < nPools; i++) {
    const o = rowsBase + i * POOL_STRIDE;
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
      scannedForward: Number(pw[o + 11]),
      scannedReverse: Number(pw[o + 12]),
      scannedTickIndices: [],
    });
  }

  const nRows = Math.floor(tw.length / TICK_STRIDE);
  for (let r = 0; r < nRows; r++) {
    const o = r * TICK_STRIDE;
    const poolIdx = Number(tw[o]);
    if (poolIdx < 0 || poolIdx >= pools.length) continue;
    const tickIdx = Number(BigInt.asIntN(24, tw[o + 1]));
    const net = BigInt.asIntN(128, tw[o + 2]);
    pools[poolIdx].scannedTickIndices.push(tickIdx);
    if (net !== 0n) pools[poolIdx].net.set(tickIdx, net);
  }

  return { pools, discoveredCount, survivorCount, totalInRangeCapacity, capacityFloor };
}
