/**
 * EcoSwap COMPILE-ONLY unit test (no fork, no RPC).
 *
 * Builds a minimal hand-rolled "prepared" dataset — the simplest real case:
 * TWO Uniswap V3 pools, a few brackets, no routes — and runs it through the
 * real compiler exactly the way index.ts does. This deterministically catches
 * compiler errors in ecoswap.sauce.ts (and arg-tuple encoding) without a fork.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.compile.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import ts from "typescript";

import { compile } from "../../../../compiler/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECIPE_DIR = join(__dirname, "..", "ecoswap");
const REPO_ROOT = join(__dirname, "..", "..");

function stripTypes(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
}

// ── Minimal fixture: 2 V3 pools, no routes ───────────────────
const WETH = BigInt("0x4200000000000000000000000000000000000006");
const USDC = BigInt("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const CALLER = BigInt("0x1111111111111111111111111111111111111111");
const PRICE_LIMIT = 4295128740n; // MIN_SQRT_RATIO + 1

// [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0, stateView, poolId,
//  stepRatio, windowTopShifted, windowBotShifted, extremeShifted, netStart, netCount]
const OFFSET = 888000n;
const STEP_10 = 79232123823359799118286999567n; // sqrt(1.0001^10)*2^96 (ts 10)
const STEP_60 = 79426470787362580746886972461n; // sqrt(1.0001^60)*2^96 (ts 60)
const pools: bigint[][] = [
  [1n, BigInt("0xaaaa000000000000000000000000000000000001"), 500n, 10n, 0n, 500n, 0n, 1n, 0n, 0n,
   STEP_10, OFFSET, OFFSET - 50n, OFFSET - 30n, 0n, 1n],
  [1n, BigInt("0xbbbb000000000000000000000000000000000002"), 3000n, 60n, 0n, 3000n, 0n, 1n, 0n, 0n,
   STEP_60, OFFSET, OFFSET - 300n, OFFSET - 180n, 1n, 1n],
];
const routes: bigint[][] = [];
// netCache: [shiftedTick, rawNet] rows — one initialized tick per pool (netStart 0 then 1).
const netCache: bigint[][] = [
  [OFFSET - 30n, 10n ** 17n],
  [OFFSET - 180n, 5n * 10n ** 16n],
];
const routeSegs: bigint[][] = [];

// ── The unified-walk merge solver — ecoswap.sauce.ts ─────────────────
// The sole on-chain solver (one price-ordered merge over {each pool's live frontier, route
// segments}). Lowers new Array(n) + arr[i]=… element mutation, the per-pool net-cache cursor,
// and the V2/V3/V4 live reads, and must compile clean on BOTH the v1 (prefix) and v12
// (postfix-Huff) targets — this catches array-mutation / merge / net-cursor lowering regressions
// on either engine.
describe("ecoswap.sauce.ts (unified-walk merge solver)", () => {
  const SINGLEPASS = join(RECIPE_DIR, "ecoswap.sauce.ts");

  // Compile the solver for BOTH targets with the given fixture (16-field pool tuples + the flat
  // netCache + routeSegs) and assert each produces >=1 non-empty bytecode segment.
  function compileBoth(poolsArg: bigint[][], netCacheArg: bigint[][], routeSegsArg: bigint[][]) {
    const source = readFileSync(SINGLEPASS, "utf-8");
    const stripped = stripTypes(source);
    const args = [WETH, USDC, 10n ** 18n, CALLER, PRICE_LIMIT, poolsArg, routes, netCacheArg, routeSegsArg];

    const v1: any = compile(stripped, { baseDirs: [REPO_ROOT, RECIPE_DIR], args });
    const v12: any = compile(stripped, { baseDirs: [REPO_ROOT, RECIPE_DIR], args, target: "v12" });

    for (const [label, result] of [["v1", v1], ["v12", v12]] as const) {
      const segments: Uint8Array[] = result.bytecode ?? result.bytecodes;
      assert.ok(Array.isArray(segments) && segments.length >= 1, `${label}: should produce >=1 bytecode segment`);
      for (const seg of segments) assert.ok(seg.length > 0, `${label}: segment should not be empty`);
    }
  }

  it("compiles a 2-V3-pool fixture (v1 + v12)", () => {
    compileBoth(pools, netCache, routeSegs);
  });

  // V2 + V3 mix — guards the unified swap(SwapParams) nested-PoolKey branch (isV2=1) plus the
  // V2 getReserves staticcall path in the live-price read. V2 carries no net cache (netCount 0).
  it("compiles a V2 + V3 mix (v1 + v12)", () => {
    const mixedPools: bigint[][] = [
      [1n, BigInt("0xaaaa000000000000000000000000000000000001"), 500n, 10n, 0n, 500n, 0n, 1n, 0n, 0n,
       STEP_10, OFFSET, OFFSET - 50n, OFFSET - 30n, 0n, 1n],
      [0n, BigInt("0xcccc000000000000000000000000000000000003"), 3000n, 0n, 0n, 3000n, 1n, 1n, 0n, 0n,
       0n, 0n, 0n, 0n, 0n, 0n],
    ];
    const mixedNetCache: bigint[][] = [[OFFSET - 30n, 10n ** 17n]];
    compileBoth(mixedPools, mixedNetCache, routeSegs);
  });

  // V4 pool — guards the StateView getSlot0 read (dp[8]/dp[9]) + unified swap poolType=2.
  it("compiles a V4 pool (v1 + v12)", () => {
    const STATE_VIEW = BigInt("0xA3c0c9b65baD0189c5c041BF29d8f6DCF1c8e3e1");
    const POOL_ID = BigInt("0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef");
    const POOL_MANAGER = BigInt("0x498581fF718922c3f8e6A244956aF099B2652b2b");
    // poolType=2 (V4), tickSpacing=60, stateView + poolId populated.
    const v4Pools: bigint[][] = [
      [2n, POOL_MANAGER, 3000n, 60n, 0n, 3000n, 0n, 1n, STATE_VIEW, POOL_ID,
       STEP_60, OFFSET, OFFSET - 120n, OFFSET - 60n, 0n, 1n],
    ];
    const v4NetCache: bigint[][] = [[OFFSET - 60n, 10n ** 17n]];
    compileBoth(v4Pools, v4NetCache, routeSegs);
  });
});

// ── The on-chain PREPARE LENS (read-only discovery+state+ticks) ───────────────
describe("ecoswap.lens.sauce.ts", () => {
  // Compile the lens with the SAME arg shape lens.ts passes (factory/feeTier/spec
  // tuples + precomputed poolIds). Deterministically guards the byte-blob
  // accumulation + inlined signed-tick walk without anvil.
  const TOKEN_IN = WETH;
  const TOKEN_OUT = USDC;
  const FACTORY = BigInt("0x33128a8fC17869897dcE68Ed026d694621f6FDfD");
  const V2_FACTORY = BigInt("0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6");
  const POOL_MANAGER = BigInt("0x498581fF718922c3f8e6A244956aF099B2652b2b");
  const STATE_VIEW = BigInt("0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71");
  const POOL_ID = BigInt("0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef");

  // Arbitrary stepRatio placeholders (compile only inspects shape, not value).
  const STEP_10 = 79232123823359799118286999567n; // sqrt(1.0001^10)*2^96 (fee 500)
  const STEP_60 = 79426470787362580746886972461n; // sqrt(1.0001^60)*2^96 (fee 3000)

  // main(cfg, v3Factories, v3FeeTiers, v2Factories, v4Factories, v4Specs, v4PoolIds):
  // the 7 SCALARS bundled into one `cfg` tuple (the EXACT shape lens.ts builds) + the
  // 6 tuple-of-tuples params kept separate. Bundling only the scalars clears the v12
  // SDUP16 overflow (13 separate params → "REF position out of range") while keeping
  // the tuple params at the depth-2 access that round-trips on BOTH engines (folding
  // them into cfg would make a depth-3 nested-arg var read that reverts INDEX on v1).
  // Compile both targets.
  function compileLens(zeroForOne: bigint, target: "v1" | "v12") {
    const source = readFileSync(join(RECIPE_DIR, "ecoswap.lens.sauce.ts"), "utf-8");
    const result: any = compile(stripTypes(source), {
      baseDirs: [REPO_ROOT, RECIPE_DIR],
      target,
      // cfg[0..6]: tokenIn,tokenOut,zeroForOne,amountIn,driftTicks,minRelBps,maxTicks
      //   (no absolute floor — relative-depth minRelBps is the sole liquidity gate),
      //   then v3Factories,v3FeeTiers[fee,stepRatio],v2Factories,v4Factories,
      //   v4Specs[fee,ts,stepRatio],v4PoolIds as separate tuple params.
      args: [
        [TOKEN_IN, TOKEN_OUT, zeroForOne, 1000n, 2n, 100n, 96n],
        [[FACTORY]],                       // v3Factories
        [[500n, STEP_10], [3000n, STEP_60]], // v3FeeTiers [fee, stepRatio]
        [[V2_FACTORY]],                    // v2Factories
        [[POOL_MANAGER, STATE_VIEW]],      // v4Factories
        [[3000n, 60n, STEP_60]],           // v4Specs [fee, tickSpacing, stepRatio]
        [[POOL_ID]],                       // v4PoolIds (1 factory × 1 spec)
      ],
    });
    return result.bytecode ?? result.bytecodes;
  }

  for (const target of ["v1", "v12"] as const) {
    it(`compiles the lens for zeroForOne (price-down tick walk) [${target}]`, () => {
      const segments: Uint8Array[] = compileLens(1n, target);
      assert.ok(Array.isArray(segments) && segments.length >= 1, "should produce >=1 segment");
      for (const seg of segments) assert.ok(seg.length > 0, "segment not empty");
    });

    it(`compiles the lens for oneForZero (price-up tick walk) [${target}]`, () => {
      const segments: Uint8Array[] = compileLens(0n, target);
      assert.ok(Array.isArray(segments) && segments.length >= 1, "should produce >=1 segment");
      for (const seg of segments) assert.ok(seg.length > 0, "segment not empty");
    });
  }
});
