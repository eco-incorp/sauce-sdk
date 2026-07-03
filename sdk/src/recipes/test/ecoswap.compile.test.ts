/**
 * EcoSwap COMPILE-ONLY unit test (no fork, no RPC).
 *
 * Builds minimal hand-rolled compiler-arg datasets in the SAME shape index.ts
 * builds (the cfg-bundle 4-arg shape: `main(cfg, pools, netCache, routing)`) and
 * runs them through the real compiler exactly the way index.ts does. This
 * deterministically catches compiler errors in ecoswap.sauce.ts (and arg-tuple
 * encoding) without a fork — direct-pool fixtures AND a multi-hop route fixture
 * (a 2-hop route with multi-pool legs, exercising the flat-universe routing
 * scalar tuples + the route-walk codegen).
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

// ── Fixture scalars ──────────────────────────────────────────
const WETH = BigInt("0x4200000000000000000000000000000000000006");
const USDC = BigInt("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const BASE_TOKEN = BigInt("0x2222222222222222222222222222222222222222"); // route intermediate
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
// netCache: [shiftedTick, rawNet] rows — one initialized tick per pool (netStart 0 then 1).
const netCache: bigint[][] = [
  [OFFSET - 30n, 10n ** 17n],
  [OFFSET - 180n, 5n * 10n ** 16n],
];
const routing: bigint[][] = [];
// Sampled-segment venue rows: [refIdx, capacity, sqrtAdjNear, sqrtAdjFar, segKind, venue, venueAux].
// One representative Curve segment so the compiler infers the 7-col `segs` row shape (the solver reads
// segs[i][0..6] — segs[6] = venueAux, the Mento bytes32 exchangeId, 0 for every other kind); kind 1 = Curve.
// Used as the default `segs` arg in compileBoth so every fixture compiles the bestKind===1 cursor + the
// Curve/LB/DODO execution loops.
const SEG_VENUE = BigInt("0xc0c0000000000000000000000000000000000001");
const segs: bigint[][] = [[0n, 10n ** 17n, 1n << 96n, 1n << 96n, 1n, SEG_VENUE, 0n]];

/**
 * Build the `cfg` scalar tuple index.ts emits:
 *   cfg = [tokenIn, tokenOut, amountIn, caller, priceLimit, directCount, ...extra].
 * `extra` appends the OPTIONAL trailing scalars (cfg[6..9]: fluidResolver, mentoBroker,
 * balancerV3Router, minOut) — omitted ⇒ the short (6-field) cfg the venue/mix tests hand-build,
 * which exercises the cfg.length guards (each optional field defaults 0).
 */
function cfgTuple(directCount: number, extra: bigint[] = []): bigint[] {
  return [WETH, USDC, 10n ** 18n, CALLER, PRICE_LIMIT, BigInt(directCount), ...extra];
}

// ── The unified-walk merge solver — ecoswap.sauce.ts ─────────────────
// The sole on-chain solver (one price-ordered merge over {each direct pool's live frontier, each
// route's composed live walk}). Lowers new Array(n) + arr[i]=… element mutation, the per-pool
// net-cache cursor, the V2/V3/V4 live reads, AND the flat-universe route loop, and must compile
// clean on BOTH the v1 (prefix) and v12 (postfix-Huff) targets — this catches array-mutation /
// merge / net-cursor / route-walk lowering regressions on either engine. The compile args are the
// cfg-bundle 4-arg shape `[cfg, pools, netCache, routing]` index.ts builds (cfg + each routing[r]
// are actual bigint arrays; pools/netCache are bigint[][]).
describe("ecoswap.sauce.ts (unified-walk merge solver)", () => {
  const SINGLEPASS = join(RECIPE_DIR, "ecoswap.sauce.ts");

  // Compile the solver for BOTH targets with the given universe (16-field pool tuples), flat
  // netCache, and routing scalar tuples + directCount, and assert each produces >=1 non-empty
  // bytecode segment.
  function compileBoth(
    poolsArg: bigint[][],
    netCacheArg: bigint[][],
    routingArg: bigint[][],
    directCount: number,
    segsArg: bigint[][] = segs,
    cfgExtra: bigint[] = [],
  ) {
    const source = readFileSync(SINGLEPASS, "utf-8");
    const stripped = stripTypes(source);
    const args = [cfgTuple(directCount, cfgExtra), poolsArg, netCacheArg, routingArg, segsArg];

    const v1: any = compile(stripped, { baseDirs: [REPO_ROOT, RECIPE_DIR], args });
    const v12: any = compile(stripped, { baseDirs: [REPO_ROOT, RECIPE_DIR], args, target: "v12" });

    for (const [label, result] of [["v1", v1], ["v12", v12]] as const) {
      const segments: Uint8Array[] = result.bytecode ?? result.bytecodes;
      assert.ok(Array.isArray(segments) && segments.length >= 1, `${label}: should produce >=1 bytecode segment`);
      for (const seg of segments) assert.ok(seg.length > 0, `${label}: segment should not be empty`);
    }
  }

  it("compiles a 2-V3-pool fixture (v1 + v12)", () => {
    compileBoth(pools, netCache, routing, 2);
  });

  it("compiles the FULL 10-field cfg incl. minOut>0 — floor guard (v1 + v12)", () => {
    // Production emits the full cfg (index.ts): cfg[6]=fluidResolver, [7]=mentoBroker,
    // [8]=balancerV3Router, [9]=minOut. Compiling with a NON-ZERO minOut exercises the terminal
    // `if (minOut > 0) { if (outBal < minOut) throw ... }` branch codegen on BOTH engines and
    // confirms the extra scalar does NOT disturb the v12 arg-prologue SDUP window (cfg is still
    // ONE tuple). The 6-field short-cfg cells above already prove the cfg.length guards.
    compileBoth(pools, netCache, routing, 2, segs, [0n, 0n, 0n, 10n ** 15n]);
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
    compileBoth(mixedPools, mixedNetCache, routing, 2);
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
    compileBoth(v4Pools, v4NetCache, routing, 1);
  });

  // MULTI-HOP ROUTE fixture — guards the flat-universe route loop: ONE direct A->B pool +
  // a 2-hop route A->X->B whose FIRST leg splits across TWO pools (multi-pool leg) and second
  // leg has one pool. The universe is [direct, leg0a, leg0b, leg1] (directCount=1), and routing
  // carries the per-leg [base,count,inter] scalar strides:
  //   routing[0] = [2 (legCount), 1,2,BASE_TOKEN (leg0: pools [1,3), inter=X), 3,1,0 (leg1: pool [3,4), final inter 0)]
  // This exercises composeStep/routeEvent2/routePartial2 codegen + the routing depth-2 reads.
  it("compiles a 2-hop route with a multi-pool leg (v1 + v12)", () => {
    const routePools: bigint[][] = [
      // [0] direct A->B (V3 0.30%)
      [1n, BigInt("0xaaaa000000000000000000000000000000000001"), 3000n, 60n, 0n, 3000n, 0n, 1n, 0n, 0n,
       STEP_60, OFFSET, OFFSET - 300n, OFFSET - 180n, 0n, 1n],
      // [1] leg0 pool a (A->X, V3 0.05%, zHop=1)
      [1n, BigInt("0xdddd000000000000000000000000000000000004"), 500n, 10n, 0n, 500n, 0n, 1n, 0n, 0n,
       STEP_10, OFFSET, OFFSET - 50n, OFFSET - 30n, 1n, 1n],
      // [2] leg0 pool b (A->X, V3 0.30%, zHop=1)
      [1n, BigInt("0xeeee000000000000000000000000000000000005"), 3000n, 60n, 0n, 3000n, 0n, 1n, 0n, 0n,
       STEP_60, OFFSET, OFFSET - 300n, OFFSET - 180n, 2n, 1n],
      // [3] leg1 pool (X->B, V3 0.30%, zHop=1)
      [1n, BigInt("0xffff000000000000000000000000000000000006"), 3000n, 60n, 0n, 3000n, 0n, 1n, 0n, 0n,
       STEP_60, OFFSET, OFFSET - 300n, OFFSET - 180n, 3n, 1n],
    ];
    const routeNetCache: bigint[][] = [
      [OFFSET - 180n, 10n ** 17n], // direct [0]
      [OFFSET - 30n, 10n ** 17n], // leg0a [1]
      [OFFSET - 180n, 10n ** 17n], // leg0b [2]
      [OFFSET - 180n, 10n ** 17n], // leg1 [3]
    ];
    const routeRouting: bigint[][] = [
      [2n, 1n, 2n, BASE_TOKEN, 3n, 1n, 0n],
    ];
    compileBoth(routePools, routeNetCache, routeRouting, 1);
  });

  // 3-HOP ROUTE fixture — guards the N-leg route loop (legCount=3): ONE direct A->B pool + a
  // 3-hop route A->X->Y->B (one V3 pool per leg). The universe is [direct, leg0, leg1, leg2]
  // (directCount=1); routing carries the uniform [base,count,inter] stride for THREE legs:
  //   routing[0] = [3, 1,1,X, 2,1,Y, 3,1,0]
  // (leg0 pool [1,2) inter=X; leg1 pool [2,3) inter=Y; leg2 pool [3,4) final inter 0). This is the
  // structural variant the 2-hop path can't cover: the route-event back/forward propagation runs
  // an actual upstream+downstream chain (the middle leg has BOTH an upstream and a downstream leg).
  it("compiles a 3-hop route (v1 + v12)", () => {
    const X_TOKEN = BigInt("0x3333333333333333333333333333333333333333");
    const Y_TOKEN = BigInt("0x4444444444444444444444444444444444444444");
    const routePools: bigint[][] = [
      // [0] direct A->B (V3 0.30%)
      [1n, BigInt("0xaaaa000000000000000000000000000000000001"), 3000n, 60n, 0n, 3000n, 0n, 1n, 0n, 0n,
       STEP_60, OFFSET, OFFSET - 300n, OFFSET - 180n, 0n, 1n],
      // [1] leg0 pool (A->X, V3 0.05%, zHop=1)
      [1n, BigInt("0xdddd000000000000000000000000000000000004"), 500n, 10n, 0n, 500n, 0n, 1n, 0n, 0n,
       STEP_10, OFFSET, OFFSET - 50n, OFFSET - 30n, 1n, 1n],
      // [2] leg1 pool (X->Y, V3 0.30%, zHop=1)
      [1n, BigInt("0xeeee000000000000000000000000000000000005"), 3000n, 60n, 0n, 3000n, 0n, 1n, 0n, 0n,
       STEP_60, OFFSET, OFFSET - 300n, OFFSET - 180n, 2n, 1n],
      // [3] leg2 pool (Y->B, V3 0.05%, zHop=1)
      [1n, BigInt("0xffff000000000000000000000000000000000006"), 500n, 10n, 0n, 500n, 0n, 1n, 0n, 0n,
       STEP_10, OFFSET, OFFSET - 50n, OFFSET - 30n, 3n, 1n],
    ];
    const routeNetCache: bigint[][] = [
      [OFFSET - 180n, 10n ** 17n], // direct [0]
      [OFFSET - 30n, 10n ** 17n], // leg0 [1]
      [OFFSET - 180n, 10n ** 17n], // leg1 [2]
      [OFFSET - 30n, 10n ** 17n], // leg2 [3]
    ];
    const routeRouting: bigint[][] = [
      [3n, 1n, 1n, X_TOKEN, 2n, 1n, Y_TOKEN, 3n, 1n, 0n],
    ];
    compileBoth(routePools, routeNetCache, routeRouting, 1);
  });

  // SAMPLED-SEGMENT venues (Curve / LB / DODO) — guards the bestKind===1 static-segment cursor +
  // the per-venue accumulators + the three execution loops (swap poolType 3/6/5). ONE direct V3
  // pool plus a mixed segs stream carrying a Curve (kind 1), an LB (kind 2) and a DODO (kind 3)
  // segment, each at a distinct venue address. The merge competes them against the live pool; the
  // execution loops dispatch on segKind. Compiles on BOTH engines.
  it("compiles sampled-segment venues: Curve + LB + DODO (v1 + v12)", () => {
    const directOnly: bigint[][] = [
      [1n, BigInt("0xaaaa000000000000000000000000000000000001"), 3000n, 60n, 0n, 3000n, 0n, 1n, 0n, 0n,
       STEP_60, OFFSET, OFFSET - 300n, OFFSET - 180n, 0n, 1n],
    ];
    const directNet: bigint[][] = [[OFFSET - 180n, 10n ** 17n]];
    const CURVE = BigInt("0xc0c0000000000000000000000000000000000001");
    const LB = BigInt("0x1b1b000000000000000000000000000000000002");
    const DODO = BigInt("0xd0d0000000000000000000000000000000000003");
    // [refIdx, capacity, sqrtAdjNear, sqrtAdjFar, segKind, venue, venueAux], DESC sqrtAdjNear.
    const mixedSegs: bigint[][] = [
      [0n, 4n * 10n ** 17n, (1n << 96n) + 30n, (1n << 96n) + 30n, 1n, CURVE, 0n], // Curve
      [0n, 3n * 10n ** 17n, (1n << 96n) + 20n, (1n << 96n) + 20n, 2n, LB, 0n], // LB
      [0n, 2n * 10n ** 17n, (1n << 96n) + 10n, (1n << 96n) + 10n, 3n, DODO, 0n], // DODO
    ];
    compileBoth(directOnly, directNet, routing, 1, mixedSegs);
  });

  // CONDITIONAL COMPILATION (the size win) — compile the SAME solver twice: once with every
  // declared HAS_* flag true (the all-protocols cook), once with every flag false (the V3-only
  // build — the V3 live walk is the unguarded merge core, so it carries NO flag). With treeshake
  // the V3-only build DROPS every per-protocol-separable block (Curve/LB/DODO/Solidly/Kyber/V2/
  // V4/Balancer-V3/routes) and every helper reachable only from a dropped branch, so its bytecode
  // is STRICTLY SMALLER on BOTH engines. The all-true build must also be byte-identical to the
  // no-defines legacy compile (the guards are transparent when their flag is true).
  it("conditional compilation: V3-only is strictly smaller than all-protocols (v1 + v12)", () => {
    const source = readFileSync(SINGLEPASS, "utf-8");
    const stripped = stripTypes(source);
    const args = [cfgTuple(1), pools.slice(0, 1), [netCache[0]], routing, segs];
    const ALL = {
      HAS_V2: true, HAS_V4: true, HAS_ALGEBRA: true, HAS_KYBER: true, HAS_ROUTES: true,
      HAS_CURVE: true, HAS_LB: true, HAS_DODO: true, HAS_SOLIDLY_STABLE: true, HAS_WOMBAT: true,
      HAS_BALANCER: true, HAS_EULER: true, HAS_MAVERICK: true, HAS_CRYPTO: true, HAS_WOOFI: true,
      HAS_FERMI: true, HAS_FLUID: true, HAS_MENTO: true, HAS_BALANCER_V3: true,
    };
    const V3_ONLY = {
      HAS_V2: false, HAS_V4: false, HAS_ALGEBRA: false, HAS_KYBER: false, HAS_ROUTES: false,
      HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
      HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: false, HAS_WOOFI: false,
      HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
    };
    // GUARD: the define-set keys must exactly equal the HAS_* consts declared in ecoswap.sauce.ts.
    // A flag declared in the source but missing here keeps its `true` default in EVERY reduced
    // build — the block silently ships (exactly how HAS_BALANCER_V3 slipped the V3-only cell).
    // A key here with no matching const is inert noise. Parse the declarations from the source,
    // annotation-agnostic: the compiler's define fold matches any top-level `const HAS_X = …`
    // with or without a `: boolean` annotation, so the guard must too.
    const declaredFlags = [...source.matchAll(/^const (HAS_[A-Z0-9_]+)\b/gm)]
      .map((m) => m[1])
      .sort();
    assert.deepEqual(Object.keys(ALL).sort(), declaredFlags, "ALL keys must exactly match the declared HAS_* consts");
    assert.deepEqual(Object.keys(V3_ONLY).sort(), declaredFlags, "V3_ONLY keys must exactly match the declared HAS_* consts");
    const size = (r: any): number =>
      (r.bytecode ?? r.bytecodes).reduce((a: number, b: Uint8Array) => a + b.length, 0);

    for (const target of ["v1", "v12"] as const) {
      const baseDirs = [REPO_ROOT, RECIPE_DIR];
      const legacy = compile(stripped, { baseDirs, target, args });
      const all = compile(stripped, { baseDirs, target, args, treeshake: true, defines: ALL });
      const v3 = compile(stripped, { baseDirs, target, args, treeshake: true, defines: V3_ONLY });
      // Transparency: all-flags-true folds to the same bytecode as the no-defines legacy compile.
      assert.equal(size(all), size(legacy), `${target}: all-protocols defines must be byte-identical to legacy`);
      // Size win: V3-only drops every other protocol's block + its dead helpers.
      assert.ok(
        size(v3) < size(all),
        `${target}: V3-only (${size(v3)}) must be strictly smaller than all-protocols (${size(all)})`,
      );
      // eslint-disable-next-line no-console
      console.log(`  [${target}] all-protocols=${size(all)}B  V3-only=${size(v3)}B  dropped=${size(all) - size(v3)}B`);
    }
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
  // the 8 SCALARS bundled into one `cfg` tuple (the EXACT shape lens.ts builds) + the
  // 6 tuple-of-tuples params kept separate. Bundling only the scalars clears the v12
  // SDUP16 overflow (14 separate params → "REF position out of range") while keeping
  // the tuple params at the depth-2 access that round-trips on BOTH engines (folding
  // them into cfg would make a depth-3 nested-arg var read that reverts INDEX on v1).
  // The v3Factories rows carry the full [factory,isAlgebra,algTs,algStep,isSlipstream]
  // 5-field shape so the per-pool effTicks(ts,bandTicks,maxTicks) budget + the Algebra/
  // Slipstream branches all lower. Compile both targets.
  function compileLens(zeroForOne: bigint, target: "v1" | "v12") {
    const source = readFileSync(join(RECIPE_DIR, "ecoswap.lens.sauce.ts"), "utf-8");
    const result: any = compile(stripTypes(source), {
      baseDirs: [REPO_ROOT, RECIPE_DIR],
      target,
      // cfg[0..7]: tokenIn,tokenOut,zeroForOne,amountIn,driftTicks,minRelBps,maxTicks,
      //   bandTicks (the per-pool survivorship price-band budget; effTicks =
      //   clamp(bandTicks/max(1,ts),96,maxTicks)). No absolute floor — relative-depth
      //   minRelBps is the sole liquidity gate. Then v3Factories,v3FeeTiers[fee,
      //   stepAsFee,stepAsTs],v2Factories[factory,feePpm],v4Factories,v4Specs[fee,ts,
      //   stepRatio],v4PoolIds as separate tuple params.
      args: [
        [TOKEN_IN, TOKEN_OUT, zeroForOne, 1000n, 2n, 100n, 960n, 960n],
        [[FACTORY, 0n, 0n, 0n, 0n]],       // v3Factories [factory,isAlgebra,algTs,algStep,isSlipstream]
        [[500n, STEP_10, STEP_10], [3000n, STEP_60, STEP_60]], // v3FeeTiers [fee, stepAsFee, stepAsTs]
        [[V2_FACTORY, 3000n]],             // v2Factories [factory, feePpm]
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
