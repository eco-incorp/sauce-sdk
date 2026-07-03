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
  encodeFunctionData,
  keccak256,
  encodeAbiParameters,
  type PublicClient,
  type Abi,
  type Hex,
} from "viem";

import {
  SwapPoolType,
  FactoryType,
  V2_DEFAULT_FEE_PPM,
  SLIPSTREAM_TICK_SPACINGS,
  feeToTickSpacing,
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

/**
 * Legacy per-pool forward-tick window (the clamp LO). A wide-ts pool (ts>=10 → every
 * standard tier except the 0.01%/ts=1 stable tier) floors here, so it is byte-identical
 * to the prior fixed 96-tick window — no regression, wei-exact preserved for those tiers
 * by construction. Exported so callers/tests can reference the floor.
 */
export const LENS_WINDOW_LO = 96;
/**
 * HARD per-pool gas ceiling on forward tick reads (the clamp HI + the lens outer loop
 * bound). A ts=1 pool can walk up to this many boundaries to cover the target price band.
 * 256 raw ticks at ts=1 ≈ a 2.6% band (1.0001^256 ≈ 1.0259); the lens's per-pool staticcall
 * cost is bounded by this even for the tightest tier. Chosen so the whole read stays under a
 * live RPC's eth_call gas cap (measured ≈503M gas on v1 — the heavier engine — on the heavy
 * 10-pool prod-mirror universe with 2 ts=1 pools, vs ≈234M at the legacy fixed-96 window;
 * production runs on v12 whose Huff-runtime lens read is far cheaper; both under Alchemy's
 * ~550M cap. See harness/lens-gas-probe.ts.) Override via opts.maxTicks / the
 * LensCallParams.maxTicks (a live RPC with a lower cap can lower it; a wider band never helps
 * — the in-range-capacity Σ CONVERGES by ≈192 ticks on the real Base WETH/USDC universe).
 */
export const LENS_MAX_TICKS = 256;
/**
 * Target survivorship PRICE BAND in RAW ticks. effTicks(ts) = clamp(bandTicks/max(1,ts),
 * LO, HI). 256 raw ticks ≈ a 2.6% price band: a ts=1 (0.01% stable tier) pool gets
 * clamp(256,96,256)=256 ticks, a ts=10 pool gets clamp(25,96,256)=96 (== legacy), every
 * wider tier floors at 96. So a deep tight-ts stable pool is measured across the SAME % band
 * as the volatile tiers and is no longer under-measured/dropped for an arbitrary tick-count
 * reason. Verified on the real Base WETH/USDC universe: the Pancake 0.01% (ts=1) pool's true
 * in-range capacity — ≈1.0% of Σ at the old 96 window, so a v1/v12-engine knife-edge — is
 * FULLY captured by ≈192 ticks (its Σ share stops growing), lifting it to a clean survivor on
 * BOTH engines. 256 leaves margin above that convergence point while staying gas-bounded.
 */
export const LENS_BAND_TICKS = 256;

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
  /**
   * HARD gas ceiling on forward tick reads per pool (the clamp HI; also the lens's outer
   * loop bound). Per-pool the walk stops EARLIER at effTicks = clamp(bandTicks/max(1,ts),
   * 96, maxTicks). Default LENS_MAX_TICKS.
   */
  maxTicks?: number;
  /**
   * Target survivorship PRICE BAND in RAW ticks. The per-pool tick budget is
   * clamp(bandTicks/max(1,tickSpacing), 96, maxTicks) — a tight ts=1 (0.01% stable
   * tier) pool gets MANY boundaries to cover the same % band a wide-ts pool covers in a
   * few, so its IN-RANGE-capacity survivorship metric + deactivation window is a fixed
   * price band, not a fixed tick count. Wide-ts pools floor at 96 (the legacy fixed
   * window → no regression). Default LENS_BAND_TICKS. 0 ⇒ every pool floors at 96 (legacy).
   */
  bandTicks?: number;
  /**
   * Bytecode target for the lens program: "v1" (prefix, Solidity SauceRouter) or
   * "v12" (postfix, Huff runtime behind a V12Pot). DEFAULT "v12" — the production
   * engine. The lens read is engine-agnostic in VALUE (same survivors/header on both
   * engines, verified); the target selects which engine bytecode is cooked, which MUST
   * match the `cookEntry` deployed in the chain being read (a v12 lens program only runs
   * on the V12Pot, never on a v1 SauceRouter). The cook RETURN is decoded per-engine (v1
   * wraps the program output in the ABI `bytes` envelope; the v12 Pot returns it raw).
   */
  target?: "v1" | "v12";
  /**
   * The account to simulate the read-only cook() from. v1's SauceRouter.cook is
   * open, so the default sentinel (0x…0001) works. The V12Pot's cook is OWNER-GATED
   * (reverts NotOwner unless msg.sender == owner|self), so a v12 lens read MUST be
   * simulated from the Pot's owner — callers pass the cook caller here.
   */
  account?: Hex;
  /**
   * Whether to feed Algebra factories into the lens. DEFAULT true — Algebra is EXECUTABLE.
   * The lens emits an Algebra pool as a `poolType=UniV3` row, indistinguishable downstream
   * from a real Uniswap-V3 pool, and prepare puts every UniV3 survivor into the EXECUTABLE
   * direct-pool set (cooked via swapV3). The engine now services the Algebra swap: the pool
   * re-enters via algebraSwapCallback, and the Router implements that selector (a mirror of
   * uniswapV3SwapCallback/pancakeV3SwapCallback → _handleV3Callback) as of sauce#186. An
   * Algebra pool's swap() is selector-identical to Uniswap V3, so _swapV3 drives it. Set false
   * only to suppress Algebra (e.g. a chain whose Algebra fork you don't want routed). The
   * lens's Algebra globalState reader is pinned by ecoswap.algebra.test.ts. See
   * FactoryType.AlgebraV3 + LIQUIDITY_SOURCES_FEASIBILITY.md §3.
   */
  includeAlgebra?: boolean;
}

const DEFAULT_LENS_ACCOUNT = "0x0000000000000000000000000000000000000001" as Hex;

/**
 * Compile the lens program to `params.target` bytecode for the given poolConfig +
 * call params (the shared front half of runLens). Returns the cook ingredient
 * bytecodes + the resolved account/target. Extracted so both the read-and-decode
 * path (runLens) and a gas probe (measureLensGas) share ONE compile.
 */
export function buildLensCook(
  poolConfig: ChainPoolConfig,
  params: LensCallParams,
): { bytecodes: Hex[]; account: Hex; target: "v1" | "v12" } {
  const { tokenIn, tokenOut, zeroForOne, amountIn } = params;
  const driftTicks = params.driftTicks ?? 2;
  const minRelBps = params.minRelBps ?? 0;
  const maxTicks = params.maxTicks ?? LENS_MAX_TICKS;
  const bandTicks = params.bandTicks ?? LENS_BAND_TICKS;
  const target = params.target ?? "v12";
  const account = params.account ?? DEFAULT_LENS_ACCOUNT;
  // Algebra is EXECUTABLE (default on): the engine implements algebraSwapCallback (sauce#186),
  // so an Algebra pool surfaced as a UniV3 row is cooked via swapV3 and the mid-swap input
  // pull is serviced. Feed Algebra factories into the lens config by default; pass false to
  // suppress Algebra on a given read. See LensCallParams.includeAlgebra.
  const includeAlgebra = params.includeAlgebra ?? true;

  // Group factories the same way discoverPools does, but only the families the lens
  // understands (V2/V3/V4/Algebra). Others are not collapsed.
  //
  // Algebra dynamic-fee forks (Camelot/QuickSwap V3, Ramses V2) are V3-SHAPED, so they
  // ride the SAME v3Factories param as standard V3: each row is tagged [factoryAddr,
  // isAlgebra]. An Algebra factory exposes ONE pool per pair via `poolByPair` (no fee
  // tiers) and reads `globalState()` (price/tick + the DYNAMIC fee) in place of `slot0()`;
  // the lens consumes that tag and branches the discovery/state read while reusing the V3
  // tick walk verbatim. Folding Algebra into v3Factories (rather than a new top-level
  // param) keeps main() at 7 params — a NEW param risks the v12 SDUP16 reference window.
  // Zero-address factories (documented placeholders for chains with no Algebra deployment)
  // are dropped so the lens never emits a dead poolByPair/getPool staticcall.
  const NON_FACTORY = "0x0000000000000000000000000000000000000000";
  // v3Factories carries BOTH standard V3 and Algebra factories, tagged with `isAlgebra`.
  // The order is the config order (so the per-pool ordinal the lens counts is stable across
  // its four passes). Standard V3 factories loop over the shared fee-tier list; an Algebra
  // factory discovers exactly ONE pool (at tier ordinal 0, poolByPair) and IGNORES the rest
  // of the tier list — the lens skips tiers>0 for an Algebra factory so its pool is counted
  // once. Zero-address (placeholder) factories are dropped here so no dead staticcall fires.
  const v3Factories: FactoryConfig[] = poolConfig.factories.filter(
    (f) =>
      (f.factoryType === FactoryType.V3Standard ||
        // Algebra rides the v3Factories param (tagged isAlgebra) and is EXECUTABLE (default on):
        // the engine services algebraSwapCallback (sauce#186), so a cooked Algebra swap lands.
        // includeAlgebra defaults true; pass false to suppress Algebra on a read.
        (includeAlgebra && f.factoryType === FactoryType.AlgebraV3) ||
        // Slipstream CL (Velodrome/Aerodrome Slipstream + Ramses-lineage Shadow CL) also rides
        // v3Factories (tagged isSlipstream). It is V3-shaped for pricing AND execution — the pool
        // exposes the standard V3 view surface and its swap() re-enters via uniswapV3SwapCallback
        // (the engine authenticates V3 callbacks by transient expectedPool, not a factory check),
        // so a discovered Slipstream pool is cooked via swapV3 unchanged. The ONLY difference is
        // discovery: getPool(a,b,int24 tickSpacing) keyed by tickSpacing, not fee. See
        // FactoryType.SlipstreamCL + discoverSlipstreamCLPools.
        f.factoryType === FactoryType.SlipstreamCL) &&
      f.address.toLowerCase() !== NON_FACTORY,
  );
  const v2Factories: FactoryConfig[] = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.V2Standard,
  );
  const v4Factories: FactoryConfig[] = poolConfig.factories.filter(
    (f) => f.factoryType === FactoryType.UniswapV4 && !!f.stateView,
  );

  // For per-factory fee tiers, the lens currently uses ONE global v3FeeTiers list.
  // To honor per-factory tiers (Pancake 2500 ≠ Uni 3000) we expand the V3 list as
  // ONE flat fee-tier list = union of each STANDARD-V3 factory's tiers; getPool returns 0
  // for tiers a factory doesn't have, so over-querying is harmless (just discovered as
  // absent). Algebra factories contribute no tiers (they read globalState's dynamic fee),
  // but the list MUST be non-empty so the lens's `ti===0` Algebra branch runs at least once
  // — fall back to the chain feeTiers (or a single sentinel) when only Algebra is present.
  const v3FeeSet = new Set<number>();
  for (const f of v3Factories) {
    if (f.factoryType === FactoryType.AlgebraV3) continue;
    if (f.factoryType === FactoryType.SlipstreamCL) {
      // A Slipstream factory keys pools by tickSpacing — its "tier column" values ARE
      // tickSpacings (getPool(a,b,int24 tickSpacing)). Contribute the factory's enabled
      // tickSpacing menu (default the Slipstream-common set) to the shared column. The lens
      // reinterprets ft[0] as a tickSpacing for a Slipstream row; over-querying a value a given
      // factory doesn't enable is harmless (getPool returns 0). The Slipstream-specific step
      // (ft[2] = stepRatioForSpacing(value)) disambiguates from a standard-V3 fee-tier that
      // happens to share the numeric value (only 100 overlaps: fee 100 → ts 1, Slipstream ts 100).
      for (const ts of f.slipstreamTickSpacings ?? [...SLIPSTREAM_TICK_SPACINGS]) v3FeeSet.add(ts);
      continue;
    }
    for (const fee of f.feeTiers ?? poolConfig.feeTiers) v3FeeSet.add(fee);
  }
  if (v3FeeSet.size === 0 && v3Factories.length > 0) {
    // Only Algebra factories present — seed one tier so the inner loop (and its ti===0
    // Algebra branch) executes. The fee value is irrelevant for Algebra (its fee comes
    // from globalState); pick the chain's first tier or 3000.
    v3FeeSet.add(poolConfig.feeTiers[0] ?? 3000);
  }
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

  // Args: the 8 SCALARS bundled into a single `cfg` tuple (cfg[0..7], the last being
  // bandTicks — the survivorship price-band budget) + the 6 tuple-of-tuples params kept
  // SEPARATE. Bundling only the scalars converts their deep reads from depth-sensitive
  // SDUP (which overflowed the v12 SDUP16 window at 14 params → "REF position out of
  // range") to fixed-depth heap INDEX, so the lens now compiles to v12. Adding bandTicks
  // to cfg (rather than as a new param) keeps main() at 7 params — the arg-prologue SDUP
  // window is unchanged. The tuple params stay separate because folding them into cfg
  // would make their reads depth-3 nested-arg INDEX through a variable, which reverts
  // on v1 (the nested-tuple descriptor is lost on the round-trip). See the layout
  // comment in ecoswap.lens.sauce.ts.
  const result = compile(jsSource, {
    baseDirs: [REPO_ROOT, __dirname],
    target,
    args: [
      [
        BigInt(tokenIn),
        BigInt(tokenOut),
        zeroForOne ? 1n : 0n,
        amountIn,
        BigInt(driftTicks),
        BigInt(minRelBps),
        BigInt(maxTicks),
        BigInt(bandTicks),
      ],
      // v3Factories[i] = [factoryAddr, isAlgebra, algebraTs, algebraStep] — isAlgebra=1 ⇒ the
      // lens discovers via poolByPair + reads globalState() (price/tick + dynamic fee) instead
      // of getPool + slot0(); 0 ⇒ standard Uniswap-V3 path. Both reuse the V3 tick walk.
      // algebraTs/algebraStep are the Algebra factory's fixed per-pool tickSpacing and its
      // precomputed multiplicative step ratio (getSqrtRatioAtTick(ts)) — the lens steps √price
      // by THIS ratio (it has no on-chain TickMath). Algebra v1 forks (Camelot/QuickSwap/Ramses)
      // use a fixed per-factory tickSpacing; configure it via FactoryConfig.algebraTickSpacing
      // (default 60). Standard-V3 rows carry 0 for both (unused — they read the tier's step).
      // v3Factories[i] = [factoryAddr, isAlgebra, algebraTs, algebraStep, isSlipstream]. A
      // Slipstream row (isSlipstream=1) discovers via getPool(a,b,int24 tickSpacing) — where the
      // tickSpacing is the v3FeeTiers[j][0] value — and reads the pool's OWN fee(). algebraTs/
      // algebraStep are 0 for Slipstream (it reads tickSpacing() live like standard V3 and uses the
      // Slipstream step column v3FeeTiers[j][2]). isAlgebra and isSlipstream are mutually exclusive.
      v3Factories.map((f) => {
        const isAlgebra = f.factoryType === FactoryType.AlgebraV3;
        const isSlipstream = f.factoryType === FactoryType.SlipstreamCL;
        const aTs = isAlgebra ? f.algebraTickSpacing ?? 60 : 0;
        return [
          BigInt(f.address),
          isAlgebra ? 1n : 0n,
          BigInt(aTs),
          isAlgebra ? stepRatioForSpacing(aTs) : 0n,
          isSlipstream ? 1n : 0n,
        ];
      }),
      // v3FeeTiers[j] = [value, stepAsFee, stepAsTickSpacing]. For a standard-V3 row the value is a
      // FEE tier and the step is stepAsFee = stepRatioForSpacing(feeToTickSpacing(value)). For a
      // Slipstream row the SAME value is a TICKSPACING and the step is stepAsTickSpacing =
      // stepRatioForSpacing(value). Carrying both disambiguates the single overlapping numeric
      // value (100): the lens picks column [1] for standard V3 / Algebra, column [2] for Slipstream.
      v3FeeTiers.map((v) => [
        BigInt(v),
        stepRatioForSpacing(feeToTickSpacing(v)),
        stepRatioForSpacing(v),
      ]),
      // v2Factories[i] = [factoryAddr, feePpm] — the per-pool constant-product fee
      // (V2_DEFAULT_FEE_PPM=3000 for canonical UniswapV2). Threaded so the lens grosses
      // V2 capacity/floor by the REAL fee, not a hardcoded 0.30%.
      v2Factories.map((f) => [BigInt(f.address), BigInt(f.v2FeePpm ?? V2_DEFAULT_FEE_PPM)]),
      v4Factories.map((f) => [BigInt(f.address), BigInt(f.stateView as Hex)]),
      v4Specs.map((s) => [BigInt(s.fee), BigInt(s.tickSpacing), s.stepRatio]),
      v4PoolIds.map((id) => [BigInt(id)]),
    ],
  });

  const segments: Uint8Array[] = result.bytecode ?? result.bytecodes;
  const bytecodes = segments.map(toHex);
  return { bytecodes, account, target };
}

/**
 * Compile + invoke the lens via ONE eth_call cook() and decode the raw reads.
 *
 * `cookEntry` is the engine cook entrypoint to run the lens read against: the
 * SauceRouter on v1, the owner's V12Pot on v12 (mirrors harness/engine.ts's
 * cookTarget). It must match `params.target` — a v12 lens program only runs on the
 * Pot. Discovery config is derived from poolConfig: V3Standard factories (each with
 * its own feeTiers), V2Standard factories, and UniswapV4 factories (with stateView).
 * V4 poolIds are precomputed off-chain (keccak of the sorted PoolKey) and passed in.
 */
export async function runLens(
  client: PublicClient,
  cookEntry: Hex,
  poolConfig: ChainPoolConfig,
  params: LensCallParams,
): Promise<LensResult> {
  const { bytecodes, account, target } = buildLensCook(poolConfig, params);

  // ONE read-only eth_call cook() — the entire discovery + state + tick read.
  // The lens runs up to 4 discovery passes × maxTicks × every pool of staticcalls
  // on the interpreter, which for a large universe (≈10 pools) blows past the
  // default eth_call gas cap (a node caps an eth_call's gas at the block gas
  // limit). Since this is a read-only call (never mined), pass a high explicit gas
  // so the node uses it as the call cap — set up to the test anvil's raised block
  // gas limit (harness/anvil.ts boots with --gas-limit 2e9). On a live RPC this is
  // clamped to that provider's eth_call cap, which is plenty for a single chain's
  // direct-pool universe.
  // ── Cook + decode — TARGET-GATED return handling ──
  // The lens program returns abi.encode(poolBlob, tickBlob). The two engines wrap that
  // program output DIFFERENTLY:
  //   • v1 SauceRouter.cook returns it inside the ABI `bytes returnData` envelope
  //     (offset+len+payload) — so simulateContract auto-decodes the outer `bytes` to the
  //     program output, then we decodeAbiParameters([bytes,bytes]) on it.
  //   • v12 V12Pot.cook returns the program output VERBATIM (no outer `bytes` envelope),
  //     so we read the RAW eth_call return and decodeAbiParameters([bytes,bytes]) on it
  //     directly. (This is the SAME v1-envelope-vs-v12-raw distinction handled in
  //     quoteEcoSwap's cook-return decode.)
  // Both cook from `account` (the V12Pot.cook is owner-gated → must be the Pot owner;
  // v1's cook is open → the sentinel works).
  let programOut: Hex;
  if (target === "v12") {
    const { data } = await client.call({
      account,
      to: cookEntry,
      data: encodeFunctionData({ abi: cookAbi as Abi, functionName: "cook", args: [bytecodes] }),
      gas: 2_000_000_000n,
    });
    programOut = (data ?? "0x") as Hex;
  } else {
    const { result } = await client.simulateContract({
      address: cookEntry,
      abi: cookAbi as Abi,
      functionName: "cook",
      args: [bytecodes],
      account,
      gas: 2_000_000_000n,
    });
    programOut = result as Hex;
  }

  const [poolBlob, tickBlob] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes" }],
    programOut,
  ) as [Hex, Hex];

  return decodeLens(poolBlob, tickBlob);
}

/**
 * Estimate the on-chain gas of ONE lens cook() for the given params (diagnostics only —
 * the lens is a read-only eth_call, never mined). Used to bound the gas cost of the
 * per-pool price-band tick window. Same compile path as runLens.
 */
export async function measureLensGas(
  client: PublicClient,
  cookEntry: Hex,
  poolConfig: ChainPoolConfig,
  params: LensCallParams,
): Promise<bigint> {
  const { bytecodes, account } = buildLensCook(poolConfig, params);
  return client.estimateGas({
    account,
    to: cookEntry,
    data: encodeFunctionData({ abi: cookAbi as Abi, functionName: "cook", args: [bytecodes] }),
  });
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
