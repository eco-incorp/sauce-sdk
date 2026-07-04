/**
 * EcoSwap ROUTE-LEG QL venues through the REAL PREPARE — discovery lane, local EVM, NO fork.
 *
 * The sibling of ecoswap.legql.evm.test.ts: that file hand-builds `prepared` (the solver/exec
 * lanes landed first); THIS file drives the PRODUCTION `ecoSwap(config, rpcUrl, cookEntry,
 * caller, poolConfig)` end-to-end, so prepare's per-edge QL discovery, direction stamping, the
 * estIn probe fold and the venue claim-set are all exercised for real:
 *
 *   (1) PINNED EXAMPLE via REAL prepare — a config-injected local ChainPoolConfig (local UniV3
 *       factory + pair-aware CurveRegistryMock + WooPPV2 fixture + EulerSwap known-pool entry +
 *       pair-aware MaverickFactoryMock, baseTokens [X]) must DISCOVER the epic's canonical
 *       shape: direct A→B V3 pool + route A→X→B with leg0 = {V3 pool + Maverick venue} and
 *       leg1 = {Curve + WOOFi + Euler venues, NO pools} — every venue direction-stamped for its
 *       EDGE (tokenAIn, i/j, base/quote orientation, inIsToken0). Cook lands WEI-EXACT vs
 *       kwayReference == optimalSplit built from the same fixture models (Transfer-log gated per
 *       member), and the REAL zero-cache quoteEcoSwap (noBrackets) == the cooked amountOut.
 *   (2) LEG-VENUE DRIFT via REAL prepare — prepare+compile, then a REAL third-party exchange
 *       moves the Curve fixture before cook: the pre-drift bytecodes RE-ANCHOR (awards == the
 *       mirrors run on the DRIFTED state; the drifted venue's share SHRINKS vs baseline while
 *       its leg siblings grow), state-override quote == cook.
 *   (3) CLAIMS — a 3-coin Curve pool {A, X, B} registered on BOTH edges of the route is
 *       discoverable on BOTH legs but admitted on exactly ONE (the earlier leg, DFS order):
 *       the multi-coin venue claim (one pool inventory ⇒ one ladder) the pools' 2-token
 *       claim-after-admission cannot provide.
 *   (4) DIRECT-vs-LEG EXCLUSION — the same 3-coin pool also registered for the DIRECT (A, B)
 *       pair is admitted ONLY as a direct venue; both legs drop it (and a leg whose venues all
 *       drop carries NO qlVenues key — the shape-stable contract).
 *   (5) POOL-ONLY SHAPE — a V3-only config yields legs WITHOUT the qlVenues key at all
 *       (prepared is shape-identical to the pre-lane output for every pool-only universe).
 *
 * Run: ECO_ENGINE=both npx tsx --test src/recipes/test/ecoswap.legql.prepare.evm.test.ts
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseEther,
  encodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  parseEventLogs,
  type Abi,
  type Account,
  type Hex,
  type TransactionReceipt,
} from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  deployToken,
  createAndInitPool,
  mintPosition,
  getSlot0,
  mint,
  approve,
  balanceOf,
  deployCurveStableSwap,
  deployMaverickV2Pool,
  deployWooFiPool,
  deployEulerSwapPool,
  deployCurveRegistryMock,
  deployMaverickFactoryMock,
  curveAbi,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
  type MaverickDeployParams,
  type EulerSwapParams,
} from "./harness/setup";
import { writeAndWait } from "./harness/deploy";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { SwapPoolType, FactoryType, type ChainPoolConfig } from "../shared/constants";
import type { EcoPool, EcoSwapPrepared, EcoLegQlVenue } from "../shared/types";
import { ecoSwap, quoteEcoSwap } from "../ecoswap/index";
import { mulDiv } from "./ecoswap.math";
import { kwayReference } from "./ecoswap.solver-reference";
import {
  optimalSplit,
  type OptimalPool,
  type OptimalRoute,
  type OptimalLegQlVenue,
} from "./ecoswap.optimal";
import type { CurvePool } from "../shared/curve-math";
import type { WooFiPool } from "../shared/woofi-math";
import type { EulerSwapPool } from "../shared/eulerswap-math";
import {
  getTickL,
  getSqrtPrice,
  tickSqrtPrices,
  type MaverickPool,
  type MaverickTick,
} from "../shared/maverick-math";

const HUGE = parseEther("1000000000");
const E18 = 10n ** 18n;
const E8 = 10n ** 8n;
const ENGINE_CELLS = engineCells();
const MINTABLE_ERC20_SLOTS = { balanceSlot: 4n, allowanceSlot: 5n };

// ── Fixture constants — the ecoswap.legql.evm.test.ts PINNED-EXAMPLE sizes verbatim (the awards
// are probe-verified there: every member funds at 20000e18 on exactly these depths). ──
const FEE_DIRECT = 3000;
const TS_DIRECT = 60;
const FEE_LEG0 = 500;
const TS_LEG0 = 10;
const MAV_TS = 10;
const MAV_FEE = E18 / 1000n; // 0.1% directional (1e18-scaled)
const MAV_FEE_PPM = Number((MAV_FEE * 1_000_000n) / E18); // 1000
const MAV_ACTIVE = -3;
const MAV_LO = -4;
const MAV_HI = 6;
const MAV_PER_TICK = 2_000n * E18;
const CURVE_PIN_BAL = [40_000n * E18, 40_000n * E18];
const CURVE_PIN_A = 20n;
const CURVE_PIN_FEE = 3_000_000n; // 0.03% (1e10-scaled)
const CURVE_PIN_FEE_PPM = 300; // curveFeeToPpm(3_000_000) — the prepare-stamped descriptor ppm
const WOO_PRICE = E8;
const WOO_SPREAD = 10n ** 14n;
const WOO_COEFF = 10n ** 13n;
const WOO_FEE_RATE = 25n;
const WOO_FEE_PPM = 250;
const WOO_BASE_RES = 500_000n * E18;
const WOO_QUOTE_RES = 500_000n * E18;
const EUL_RES = 60_000n * E18;
const EUL_CONC = (9n * E18) / 10n;
const EUL_FEE = E18 / 1000n;
const EUL_FEE_PPM = 1000;
// 3-coin {A, X, B} Curve pool for the CLAIMS / DIRECT-vs-LEG cells (deep + cheap so every
// liveness probe passes on every edge it is registered for).
const CURVE3_BAL = [200_000n * E18, 200_000n * E18, 200_000n * E18];
const CURVE3_A = 1000n;
const CURVE3_FEE = 4_000_000n; // 0.04%

const erc20TransferAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

describe("EcoSwap route-leg QL venues — REAL prepare (per-edge discovery, claims, drift)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  // Tokens relabeled ascending (A < X < B) — every edge zeroForOne, matching the pinned example.
  let tokA: Hex;
  let tokX: Hex;
  let tokB: Hex;
  let directPool: Hex; // A→B V3 (fee 3000)
  let leg0Pool: Hex; // A→X V3 (fee 500)
  let mavPool: Hex; // A→X Maverick fixture (tokenA == tokA)
  let curvePin: Hex; // X→B Curve fixture
  let wooPool: Hex; // X→B WOOFi fixture (base == tokX, quote == tokB)
  let eulPool: Hex; // X→B EulerSwap fixture (asset0 == tokX)
  let curve3: Hex; // 3-coin {A, X, B} Curve fixture (claims cells)
  let registryPinned: Hex; // CurveRegistryMock: (X,B) → curvePin
  let registryClaims: Hex; // CurveRegistryMock: (A,X) + (X,B) → curve3
  let registryDirect: Hex; // CurveRegistryMock: (A,B) + (A,X) + (X,B) → curve3
  let mavFactory: Hex; // MaverickFactoryMock: (A,X) → mavPool
  let cleanSnapshot: Hex;

  const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);

    const t1 = await deployToken(c.walletClient, c.publicClient, "TokOne", "T1");
    const t2 = await deployToken(c.walletClient, c.publicClient, "TokTwo", "T2");
    const t3 = await deployToken(c.walletClient, c.publicClient, "TokThree", "T3");
    [tokA, tokX, tokB] = [t1, t2, t3].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

    const minter = c.account0;
    for (const t of [tokA, tokX, tokB]) {
      await mint(c.walletClient, c.publicClient, t, minter, parseEther("1000000000"));
      await approve(c.walletClient, c.publicClient, t, stack.helper, HUGE);
    }

    directPool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokA, tokB, FEE_DIRECT, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, directPool, minter, -12000, 12000, parseEther("8000"),
    );
    leg0Pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokA, tokX, FEE_LEG0, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, leg0Pool, minter, -12000, 12000, parseEther("5000000"),
    );

    const mavTicks: MaverickTick[] = [];
    for (let t = MAV_LO; t <= MAV_HI; t++) {
      mavTicks.push({ tick: t, reserveA: MAV_PER_TICK, reserveB: MAV_PER_TICK });
    }
    const mavParams: MaverickDeployParams = {
      tokenA: tokA, tokenB: tokX, tickSpacing: MAV_TS, feeAIn: MAV_FEE, feeBIn: MAV_FEE,
      protocolFeeRatioD3: 0, ticks: mavTicks, activeTick: MAV_ACTIVE,
      poolSqrtPrice: mavModel("0x0000000000000000000000000000000000000000" as Hex).poolSqrtPrice,
    };
    mavPool = await deployMaverickV2Pool(c.walletClient, c.publicClient, mavParams, minter);
    curvePin = await deployCurveStableSwap(
      c.walletClient, c.publicClient, [tokX, tokB], CURVE_PIN_BAL, [E18, E18], CURVE_PIN_A, CURVE_PIN_FEE, minter,
    );
    wooPool = await deployWooFiPool(
      c.walletClient, c.publicClient, tokX, tokB,
      E8, E18, E18, WOO_PRICE, WOO_SPREAD, WOO_COEFF, WOO_FEE_RATE, WOO_BASE_RES, WOO_QUOTE_RES, minter,
    );
    const eulParams: EulerSwapParams = {
      reserve0: EUL_RES, reserve1: EUL_RES, equil0: EUL_RES, equil1: EUL_RES,
      priceX: E18, priceY: E18, concX: EUL_CONC, concY: EUL_CONC, fee: EUL_FEE,
      outCap0: 0n, outCap1: 0n,
    };
    eulPool = await deployEulerSwapPool(c.walletClient, c.publicClient, tokX, tokB, eulParams, minter);
    curve3 = await deployCurveStableSwap(
      c.walletClient, c.publicClient, [tokA, tokX, tokB], CURVE3_BAL, [E18, E18, E18], CURVE3_A, CURVE3_FEE, minter,
    );

    // Pair-aware discovery mocks — the production registry/factory surfaces, per cell.
    registryPinned = await deployCurveRegistryMock(c.walletClient, c.publicClient, [
      { a: tokX, b: tokB, pool: curvePin },
    ]);
    registryClaims = await deployCurveRegistryMock(c.walletClient, c.publicClient, [
      { a: tokA, b: tokX, pool: curve3 },
      { a: tokX, b: tokB, pool: curve3 },
    ]);
    registryDirect = await deployCurveRegistryMock(c.walletClient, c.publicClient, [
      { a: tokA, b: tokB, pool: curve3 },
      { a: tokA, b: tokX, pool: curve3 },
      { a: tokX, b: tokB, pool: curve3 },
    ]);
    mavFactory = await deployMaverickFactoryMock(c.walletClient, c.publicClient, [
      { tokenA: tokA, tokenB: tokX, pool: mavPool },
    ]);

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => anvil?.stop());

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  // ── ChainPoolConfig builders (config-injected discovery, one per cell shape) ──

  /** V3 factory + Curve registry + WOOFi + Euler + Maverick — the pinned-example universe. */
  function pinnedConfig(): ChainPoolConfig {
    return {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
        { address: registryPinned, poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Local Curve registry" },
        { address: wooPool, poolType: SwapPoolType.WOOFi, factoryType: FactoryType.WOOFi, label: "Local WooPPV2" },
        {
          address: eulPool,
          poolType: SwapPoolType.UniV2, // inert for EulerSwap — discovery keys off factoryType
          factoryType: FactoryType.EulerSwap,
          label: "Local EulerSwap",
          eulerSwapPools: [eulPool],
        },
        { address: mavFactory, poolType: SwapPoolType.MaverickV2, factoryType: FactoryType.MaverickV2Factory, label: "Local Maverick V2" },
      ],
      feeTiers: [FEE_LEG0, FEE_DIRECT],
      baseTokens: [tokX],
    };
  }

  /** V3 factory + the claims registry (curve3 on BOTH route edges) + WOOFi + Euler (leg1 survivors). */
  function claimsConfig(registry: Hex): ChainPoolConfig {
    return {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
        { address: registry, poolType: SwapPoolType.Curve, factoryType: FactoryType.CurveRegistry, label: "Local Curve registry" },
        { address: wooPool, poolType: SwapPoolType.WOOFi, factoryType: FactoryType.WOOFi, label: "Local WooPPV2" },
        {
          address: eulPool,
          poolType: SwapPoolType.UniV2,
          factoryType: FactoryType.EulerSwap,
          label: "Local EulerSwap",
          eulerSwapPools: [eulPool],
        },
      ],
      feeTiers: [FEE_LEG0, FEE_DIRECT],
      baseTokens: [tokX],
    };
  }

  // ── Fixture models (identical to the deploy constants — the mirrors' inputs) ──

  function mavModel(address: Hex): MaverickPool {
    const ticks: MaverickTick[] = [];
    for (let t = MAV_LO; t <= MAV_HI; t++) {
      ticks.push({ tick: t, reserveA: MAV_PER_TICK, reserveB: MAV_PER_TICK });
    }
    const { sqrtLowerPrice, sqrtUpperPrice } = tickSqrtPrices(MAV_TS, MAV_ACTIVE);
    const active = ticks.find((t) => t.tick === MAV_ACTIVE)!;
    const activeL = getTickL(active.reserveA, active.reserveB, sqrtLowerPrice, sqrtUpperPrice);
    const poolSqrtPrice = getSqrtPrice(active.reserveA, active.reserveB, sqrtLowerPrice, sqrtUpperPrice, activeL);
    return {
      poolType: 7, address, tokenAIn: true, activeTick: MAV_ACTIVE, poolSqrtPrice,
      tickSpacing: MAV_TS, fee: MAV_FEE, protocolFeeD3: 0n, ticks,
      feePpm: MAV_FEE_PPM, source: "legql-prepare-fixture",
    };
  }

  function curveModel(address: Hex, balances: bigint[]): CurvePool {
    return {
      poolType: 3, address, i: 0, j: 1, A: CURVE_PIN_A, aPrecision: 100n,
      balances: [...balances], rates: [E18, E18], feePpm10: CURVE_PIN_FEE, source: "legql-prepare-fixture",
    };
  }

  function wooModel(address: Hex): WooFiPool {
    return {
      address, tokenIn: tokX, tokenOut: tokB, sellBase: true,
      price: WOO_PRICE, spread: WOO_SPREAD, coeff: WOO_COEFF,
      priceDec: E8, quoteDec: E18, baseDec: E18,
      feeRate: WOO_FEE_RATE, feePpm: WOO_FEE_PPM, source: "legql-prepare-fixture",
    };
  }

  function eulModel(address: Hex): EulerSwapPool {
    return {
      address, inIsToken0: true,
      reserveIn: EUL_RES, reserveOut: EUL_RES, equilIn: EUL_RES, equilOut: EUL_RES,
      priceIn: E18, priceOut: E18, concIn: EUL_CONC, concOut: EUL_CONC, feeWad: EUL_FEE,
      inLimit: 0n, outLimit: 0n, feePpm: EUL_FEE_PPM, source: "legql-prepare-fixture",
    };
  }

  /** Live OptimalPool for a REAL-prepared V3 pool (slot0 + the prepared L/net seeds). */
  async function optV3(lp: EcoPool): Promise<OptimalPool> {
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, lp.address);
    return {
      isV2: false, feePpm: lp.feePpm, sqrtPriceX96, tick, tickSpacing: lp.tickSpacing,
      liquidity: lp.spotActiveL ?? 0n, net: lp.adaptiveNet ?? new Map<number, bigint>(),
    };
  }

  /** Σ of Transfer(token, * → to) values in a receipt. */
  function transferSumTo(receipt: TransactionReceipt, token: Hex, to: Hex): bigint {
    const events = parseEventLogs({ abi: erc20TransferAbi, logs: receipt.logs, eventName: "Transfer" });
    let sum = 0n;
    for (const ev of events) {
      if (ev.address.toLowerCase() !== token.toLowerCase()) continue;
      if ((ev.args.to as Hex).toLowerCase() === to.toLowerCase()) sum += ev.args.value as bigint;
    }
    return sum;
  }

  /** The exec's unified per-leg proportional split, mirrored off-chain (see ecoswap.legql). */
  function expectedLegShares(
    inBal: bigint,
    poolWeights: bigint[],
    venueWeights: bigint[],
  ): { pools: bigint[]; venues: bigint[] } {
    const lTotal = [...poolWeights, ...venueWeights].reduce((a, b) => a + b, 0n);
    const pools = poolWeights.map(() => 0n);
    const venues = venueWeights.map(() => 0n);
    if (lTotal === 0n || inBal === 0n) return { pools, venues };
    let lastIsQ = false;
    let lastIdx = 0;
    poolWeights.forEach((w, i) => { if (w > 0n) { lastIsQ = false; lastIdx = i; } });
    venueWeights.forEach((w, i) => { if (w > 0n) { lastIsQ = true; lastIdx = i; } });
    let spent = 0n;
    poolWeights.forEach((w, i) => {
      if (w === 0n) return;
      let share = mulDiv(inBal, w, lTotal);
      if (!lastIsQ && i === lastIdx) share = inBal - spent;
      if (share > 0n) { pools[i] = share; spent += share; }
    });
    venueWeights.forEach((w, i) => {
      if (w === 0n) return;
      let share = mulDiv(inBal, w, lTotal);
      if (lastIsQ && i === lastIdx) share = inBal - spent;
      if (share > 0n) { venues[i] = share; spent += share; }
    });
    return { pools, venues };
  }

  // ── Inline state-override quote (for the DRIFT cell — quoteEcoSwap would re-prepare on the
  // drifted state; the drift case must quote the PRE-DRIFT bytecodes) ──
  const cookCallAbi = parseAbi(["function cook(bytes[] ingredients) payable returns (bytes returnData)"]);
  function decodeCookUint(ret: Hex, engine: Engine): bigint {
    if (!ret || ret === "0x") return 0n;
    if (engine === "v1") {
      const blob = decodeFunctionResult({ abi: cookCallAbi as Abi, functionName: "cook", data: ret }) as unknown as Hex;
      const hex = blob.slice(2);
      return hex.length >= 64 ? BigInt("0x" + hex.slice(-64)) : 0n;
    }
    const hex = ret.slice(2);
    return hex.length >= 64 ? BigInt("0x" + hex.slice(-64)) : 0n;
  }
  function mappingSlot(key: Hex, slot: bigint): Hex {
    return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
  }
  function nestedMappingSlot(a: Hex, b: Hex, slot: bigint): Hex {
    return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [b, mappingSlot(a, slot)]));
  }
  const OVERRIDE_AMOUNT = ("0x" + "0".repeat(32) + "f".repeat(32)) as Hex;
  async function quoteViaStateOverride(
    engine: Engine,
    target: Hex,
    caller: Hex,
    bytecodes: Hex[],
  ): Promise<bigint> {
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({
      account: caller,
      to: target,
      data,
      gas: 2_000_000_000n,
      stateOverride: [
        {
          address: tokA,
          stateDiff: [
            { slot: mappingSlot(caller, 4n), value: OVERRIDE_AMOUNT },
            { slot: nestedMappingSlot(caller, target, 5n), value: OVERRIDE_AMOUNT },
          ],
        },
      ],
    });
    return decodeCookUint(ret as Hex, engine);
  }

  /** Narrow an EcoLegQlVenue to a family or fail the test. */
  function expectFamily<F extends EcoLegQlVenue["family"]>(
    v: EcoLegQlVenue,
    family: F,
  ): Extract<EcoLegQlVenue, { family: F }> {
    assert.equal(v.family, family, `venue family ${v.family} != expected ${family}`);
    return v as Extract<EcoLegQlVenue, { family: F }>;
  }

  /** The pinned prepared-topology gate (shared by the pinned + drift cells): 1 direct V3 pool +
   *  ONE route A→X→B, leg0 = {leg0Pool + Maverick venue}, leg1 = {Curve, WOOFi, Euler venues,
   *  no pools} — every descriptor DIRECTION-STAMPED for its edge. */
  function assertPinnedTopology(prepared: EcoSwapPrepared): void {
    assert.equal(prepared.pools.length, 1, "one direct pool");
    assert.equal(prepared.pools[0].address.toLowerCase(), directPool.toLowerCase(), "direct is the A→B V3 pool");
    // No DIRECT QL venues in this universe (all five families exist in config; none serves (A,B)).
    assert.equal(prepared.curves?.length ?? 0, 0, "no direct Curve venue");
    assert.equal(prepared.maverickPools?.length ?? 0, 0, "no direct Maverick venue");
    assert.equal(prepared.wooFiPools?.length ?? 0, 0, "no direct WOOFi venue");
    assert.equal(prepared.eulerSwaps?.length ?? 0, 0, "no direct Euler venue");
    assert.equal(prepared.routes.length, 1, "one route (through X)");
    const route = prepared.routes[0];
    assert.equal(route.legs.length, 2, "2-hop route");
    assert.equal(route.intermediateTokens[0].toLowerCase(), tokX.toLowerCase(), "intermediate is X");
    // Leg0 (A→X): the V3 pool + the Maverick venue, tokenAIn stamped for the EDGE (hopIn == tokenA).
    const leg0 = route.legs[0];
    assert.equal(leg0.pools.length, 1, "leg0 has the V3 pool");
    assert.equal(leg0.pools[0].address.toLowerCase(), leg0Pool.toLowerCase(), "leg0 pool address");
    assert.equal(leg0.qlVenues?.length ?? 0, 1, "leg0 has ONE QL venue (Maverick)");
    const mv = expectFamily(leg0.qlVenues![0], "maverick");
    assert.equal(mv.desc.address.toLowerCase(), mavPool.toLowerCase(), "maverick venue address");
    assert.equal(mv.desc.tokenAIn, true, "maverick direction: hopIn == tokenA ⇒ tokenAIn");
    assert.equal(mv.desc.tickSpacing, MAV_TS, "maverick tickSpacing");
    assert.equal(mv.desc.feePpm, MAV_FEE_PPM, "maverick feePpm");
    // Leg1 (X→B): venue-only — Curve + WOOFi + Euler in the canonical family order.
    const leg1 = route.legs[1];
    assert.equal(leg1.pools.length, 0, "leg1 has NO pools (venue-only leg)");
    assert.equal(leg1.qlVenues?.length ?? 0, 3, "leg1 has THREE QL venues");
    const cv = expectFamily(leg1.qlVenues![0], "curve");
    assert.equal(cv.desc.address.toLowerCase(), curvePin.toLowerCase(), "curve venue address");
    assert.equal(cv.desc.i, 0, "curve i: hopIn X is coin0");
    assert.equal(cv.desc.j, 1, "curve j: hopOut B is coin1");
    assert.equal(cv.desc.feePpm, CURVE_PIN_FEE_PPM, "curve feePpm (ppm-rounded by prepare)");
    const wv = expectFamily(leg1.qlVenues![1], "wooFi");
    assert.equal(wv.desc.address.toLowerCase(), wooPool.toLowerCase(), "woofi venue address");
    assert.equal(wv.desc.fromToken.toLowerCase(), tokX.toLowerCase(), "woofi fromToken == hopIn (base)");
    assert.equal(wv.desc.toToken.toLowerCase(), tokB.toLowerCase(), "woofi toToken == hopOut (quote)");
    assert.equal(wv.desc.feePpm, WOO_FEE_PPM, "woofi feePpm");
    const ev = expectFamily(leg1.qlVenues![2], "euler");
    assert.equal(ev.desc.address.toLowerCase(), eulPool.toLowerCase(), "euler venue address");
    assert.equal(ev.desc.inIsToken0, true, "euler direction: hopIn X is asset0");
    assert.equal(ev.desc.feePpm, EUL_FEE_PPM, "euler feePpm");
  }

  /** Mirrors for the pinned universe (models == deploy constants; curve balances injectable —
   *  the drift cell re-reads them live). */
  function pinnedMirrors(
    prepared: EcoSwapPrepared,
    amountIn: bigint,
    directOpt: OptimalPool,
    leg0Opt: OptimalPool,
    curveBalances: bigint[],
  ) {
    const mavOlv: OptimalLegQlVenue = { family: "maverick", model: mavModel(mavPool) };
    const curveOlv: OptimalLegQlVenue = { family: "curve", model: curveModel(curvePin, curveBalances) };
    const wooOlv: OptimalLegQlVenue = { family: "wooFi", model: wooModel(wooPool) };
    const eulOlv: OptimalLegQlVenue = { family: "euler", model: eulModel(eulPool) };
    const ref = kwayReference(prepared, amountIn, undefined, [[[mavOlv], [curveOlv, wooOlv, eulOlv]]]);
    const optRoute: OptimalRoute = {
      legs: [
        { zeroForOne: true, pools: [leg0Opt], qlvs: [mavOlv] },
        { zeroForOne: true, pools: [], qlvs: [curveOlv, wooOlv, eulOlv] },
      ],
    };
    const opt = optimalSplit({
      pools: [directOpt], routes: [optRoute], amountIn,
      zeroForOne: prepared.zeroForOne, priceLimit: prepared.priceLimit,
    });
    return { ref, opt };
  }

  // ── (1) PINNED EXAMPLE via REAL prepare — discovery + cook wei-exact + quoteEcoSwap parity ──
  async function runPinnedViaPrepare(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const amountIn = parseEther("20000");
    const poolConfig = pinnedConfig();

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn: tokA, tokenOut: tokB, amountIn },
      anvil.rpcUrl, target, caller, poolConfig, { minRelBps: 0 }, engine,
    );
    assertPinnedTopology(prepared);

    const directOpt = await optV3(prepared.pools[0]);
    const leg0Opt = await optV3(prepared.routes[0].legs[0].pools[0]);
    const { ref, opt } = pinnedMirrors(prepared, amountIn, directOpt, leg0Opt, CURVE_PIN_BAL);
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei)");
    assert.equal(ref.perRouteInput[0], opt.perRouteInput[0], "route award == oracle (wei)");
    assert.ok(ref.perPoolInput[0] > 0n, "direct pool funded");
    assert.ok(ref.perUniversePoolInput[1] > 0n, "leg0 V3 pool funded");
    for (let g = 0; g < 4; g++) assert.ok(ref.perLegQlvInput[g] > 0n, `leg venue g${g} funded`);

    // REAL zero-cache quote (quoteEcoSwap, noBrackets): its own prepare must carry the leg
    // venues identically (descriptors are cache-free identity data — nothing to clear).
    const quote = await quoteEcoSwap(
      { tokenIn: tokA, tokenOut: tokB, amountIn },
      anvil.rpcUrl, target, caller, poolConfig,
      { minRelBps: 0, noBrackets: true, erc20Slots: MINTABLE_ERC20_SLOTS, target: engine },
    );
    assert.equal(
      quote.prepared.routes[0].legs[1].qlVenues?.length ?? 0, 3,
      "zero-cache quote prepared carries the leg venues (parity)",
    );
    assert.ok(quote.amountOut > 0n, "quote returns a positive output");

    const callerABefore = await balanceOf(c.publicClient, tokA, caller);
    const callerBBefore = await balanceOf(c.publicClient, tokB, caller);
    const leg0XBefore = await balanceOf(c.publicClient, tokX, leg0Pool);
    const mavXBefore = await balanceOf(c.publicClient, tokX, mavPool);

    await approve(c.walletClient, c.publicClient, tokA, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "pinned-via-prepare cook() must succeed");

    const spent = callerABefore - (await balanceOf(c.publicClient, tokA, caller));
    const received = (await balanceOf(c.publicClient, tokB, caller)) - callerBBefore;
    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (wei)`);
    assert.equal(quote.amountOut, received, `[${engine}] quoteEcoSwap == cooked amountOut (wei)`);

    // Leg0 (tokenIn side): every member receives EXACTLY its award (Transfer-log gated).
    assert.equal(
      transferSumTo(receipt, tokA, leg0Pool), ref.perUniversePoolInput[1],
      `[${engine}] leg0 V3 pool received exactly its award`,
    );
    assert.equal(
      transferSumTo(receipt, tokA, mavPool), ref.perLegQlvInput[0],
      `[${engine}] Maverick venue received exactly its award (== qinp)`,
    );
    assert.equal(
      transferSumTo(receipt, tokA, directPool), ref.perPoolInput[0],
      `[${engine}] direct pool received exactly its award`,
    );
    // Leg1 (X side): realized X splits proportionally across the three venues.
    const inBalX =
      (leg0XBefore - (await balanceOf(c.publicClient, tokX, leg0Pool))) +
      (mavXBefore - (await balanceOf(c.publicClient, tokX, mavPool)));
    assert.ok(inBalX > 0n, `[${engine}] leg0 members produced intermediate X`);
    const exp = expectedLegShares(
      inBalX, [], [ref.perLegQlvInput[1], ref.perLegQlvInput[2], ref.perLegQlvInput[3]],
    );
    assert.equal(transferSumTo(receipt, tokX, curvePin), exp.venues[0], `[${engine}] Curve X share (wei)`);
    assert.equal(transferSumTo(receipt, tokX, wooPool), exp.venues[1], `[${engine}] WOOFi X share (wei)`);
    assert.equal(transferSumTo(receipt, tokX, eulPool), exp.venues[2], `[${engine}] Euler X share (wei)`);

    console.log(
      `  [legQL-prepare pinned:${engine}] direct=${ref.perPoolInput[0]} leg0V3=${ref.perUniversePoolInput[1]} ` +
        `mav=${ref.perLegQlvInput[0]} curve=${exp.venues[0]} woo=${exp.venues[1]} euler=${exp.venues[2]} ` +
        `received=${received} quoted=${quote.amountOut} (REAL prepare, all wei)`,
    );
  }

  // ── (2) LEG-VENUE DRIFT via REAL prepare — pre-drift bytecodes re-anchor at cook ──
  async function runDriftViaPrepare(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const amountIn = parseEther("20000");

    const { bytecodes, prepared } = await ecoSwap(
      { tokenIn: tokA, tokenOut: tokB, amountIn },
      anvil.rpcUrl, target, caller, pinnedConfig(), { minRelBps: 0 }, engine,
    );
    assertPinnedTopology(prepared);

    const directOpt = await optV3(prepared.pools[0]);
    const leg0Opt = await optV3(prepared.routes[0].legs[0].pools[0]);
    const { ref: refBase } = pinnedMirrors(prepared, amountIn, directOpt, leg0Opt, CURVE_PIN_BAL);
    assert.ok(refBase.perLegQlvInput[1] > 0n, "baseline: curve venue funded pre-drift");

    // REAL adverse drift: a third-party sells X→B through the Curve fixture AFTER prepare.
    const driftDx = parseEther("8000");
    await approve(c.walletClient, c.publicClient, tokX, curvePin, driftDx);
    await writeAndWait(c.walletClient, c.publicClient, {
      address: curvePin, abi: curveAbi as Abi, functionName: "exchange",
      args: [0n, 1n, driftDx, 0n],
    });
    const balX = (await c.publicClient.readContract({
      address: curvePin, abi: curveAbi as Abi, functionName: "balances", args: [0n],
    })) as bigint;
    const balB = (await c.publicClient.readContract({
      address: curvePin, abi: curveAbi as Abi, functionName: "balances", args: [1n],
    })) as bigint;
    const { ref: refDrift, opt: optDrift } = pinnedMirrors(
      prepared, amountIn, directOpt, leg0Opt, [balX, balB],
    );
    assert.equal(refDrift.totalInput, optDrift.totalInput, "drifted reference total == drifted oracle (wei)");
    // RE-ANCHORING: the drifted venue's live ladder is worse ⇒ its award SHRINKS; siblings grow.
    assert.ok(
      refDrift.perLegQlvInput[1] < refBase.perLegQlvInput[1],
      "drifted curve venue award < no-drift baseline",
    );
    assert.ok(
      refDrift.perLegQlvInput[2] > refBase.perLegQlvInput[2] ||
        refDrift.perLegQlvInput[3] > refBase.perLegQlvInput[3],
      "a sibling leg venue's award grows under the curve venue's adverse drift",
    );

    const quoted = await quoteViaStateOverride(engine, target, caller, bytecodes);

    const callerABefore = await balanceOf(c.publicClient, tokA, caller);
    const callerBBefore = await balanceOf(c.publicClient, tokB, caller);
    const leg0XBefore = await balanceOf(c.publicClient, tokX, leg0Pool);
    const mavXBefore = await balanceOf(c.publicClient, tokX, mavPool);

    await approve(c.walletClient, c.publicClient, tokA, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "drift-via-prepare cook() must succeed");

    const spent = callerABefore - (await balanceOf(c.publicClient, tokA, caller));
    const received = (await balanceOf(c.publicClient, tokB, caller)) - callerBBefore;
    // The PRE-DRIFT bytecodes carry NO venue state — the on-chain ladders re-anchored to the
    // drifted live quotes, so the cook realizes the DRIFTED mirrors exactly.
    assert.equal(spent, refDrift.totalInput, `[${engine}] spent == DRIFTED reference totalInput (wei)`);
    assert.equal(
      transferSumTo(receipt, tokA, leg0Pool), refDrift.perUniversePoolInput[1],
      `[${engine}] leg0 V3 award == drifted reference (wei)`,
    );
    assert.equal(
      transferSumTo(receipt, tokA, mavPool), refDrift.perLegQlvInput[0],
      `[${engine}] Maverick award == drifted reference (wei)`,
    );
    const inBalX =
      (leg0XBefore - (await balanceOf(c.publicClient, tokX, leg0Pool))) +
      (mavXBefore - (await balanceOf(c.publicClient, tokX, mavPool)));
    const exp = expectedLegShares(
      inBalX, [], [refDrift.perLegQlvInput[1], refDrift.perLegQlvInput[2], refDrift.perLegQlvInput[3]],
    );
    assert.equal(
      transferSumTo(receipt, tokX, curvePin), exp.venues[0],
      `[${engine}] drifted Curve venue X share == drifted proportional award (wei)`,
    );
    assert.equal(quoted, received, `[${engine}] state-override quote == cook (drifted state, wei)`);

    console.log(
      `  [legQL-prepare drift:${engine}] curve award ${refBase.perLegQlvInput[1]}→${refDrift.perLegQlvInput[1]} ` +
        `spent=${spent} received=${received} (pre-drift bytecodes re-anchored, wei)`,
    );
  }

  // ── (3) CLAIMS — a 3-coin venue reachable on BOTH legs is admitted on exactly ONE ──
  async function runClaims(): Promise<void> {
    await resetPools();
    const caller = c.account0;
    const amountIn = parseEther("20000");

    const { prepared } = await ecoSwap(
      { tokenIn: tokA, tokenOut: tokB, amountIn },
      anvil.rpcUrl, cookTarget("v1", stack, v12), caller, claimsConfig(registryClaims), { minRelBps: 0 }, "v1",
    );

    // No direct curve venue: (A,B) is NOT registered on the claims registry.
    assert.equal(prepared.curves?.length ?? 0, 0, "curve3 is NOT a direct venue (pair unregistered)");
    assert.equal(prepared.routes.length, 1, "the route survives the claim filter");
    const [leg0, leg1] = prepared.routes[0].legs;
    // Discovery surfaced curve3 on BOTH edges (it holds {A,X,B}); the claim set admits it on the
    // FIRST leg only (DFS order) — the multi-coin one-inventory rule (claim by pool ADDRESS).
    assert.equal(leg0.qlVenues?.length ?? 0, 1, "leg0 admitted ONE venue (curve3)");
    const cv0 = expectFamily(leg0.qlVenues![0], "curve");
    assert.equal(cv0.desc.address.toLowerCase(), curve3.toLowerCase(), "leg0 venue is curve3");
    assert.equal(cv0.desc.i, 0, "leg0 edge orientation: A is coin0");
    assert.equal(cv0.desc.j, 1, "leg0 edge orientation: X is coin1");
    const leg1Families = (leg1.qlVenues ?? []).map((v) => v.family);
    assert.ok(!leg1Families.includes("curve"), "leg1 DROPPED curve3 (claimed by leg0)");
    assert.deepEqual(leg1Families, ["wooFi", "euler"], "leg1 keeps its other venues (route alive)");

    console.log(
      `  [legQL-prepare claims] curve3 admitted on leg0 only; leg1 = ${leg1Families.join("+")} (route survived)`,
    );
  }

  // ── (4) DIRECT-vs-LEG — a pool serving the overall pair directly is excluded from EVERY leg ──
  async function runDirectVsLeg(): Promise<void> {
    await resetPools();
    const caller = c.account0;
    const amountIn = parseEther("20000");

    const { prepared } = await ecoSwap(
      { tokenIn: tokA, tokenOut: tokB, amountIn },
      anvil.rpcUrl, cookTarget("v1", stack, v12), caller, claimsConfig(registryDirect), { minRelBps: 0 }, "v1",
    );

    // curve3 IS the direct (A,B) venue now (i=0 → A, j=2 → B on the 3-coin pool)…
    assert.equal(prepared.curves?.length ?? 0, 1, "curve3 admitted as the direct venue");
    assert.equal(prepared.curves![0].address.toLowerCase(), curve3.toLowerCase(), "direct venue is curve3");
    assert.equal(prepared.curves![0].i, 0, "direct orientation: A is coin0");
    assert.equal(prepared.curves![0].j, 2, "direct orientation: B is coin2");
    // …so BOTH legs drop it (one shared inventory cannot serve direct AND a leg).
    assert.equal(prepared.routes.length, 1, "the route survives (leg1 keeps other venues)");
    const [leg0, leg1] = prepared.routes[0].legs;
    for (const leg of [leg0, leg1]) {
      for (const v of leg.qlVenues ?? []) {
        assert.notEqual(
          qlAddr(v).toLowerCase(), curve3.toLowerCase(),
          "no leg carries the direct-claimed curve3",
        );
      }
    }
    // Leg0's ONLY venue candidate was curve3 ⇒ all dropped ⇒ the leg carries NO qlVenues key
    // (the shape-stable contract: venue-free legs are byte-identical to pool-only legs).
    assert.equal(leg0.qlVenues, undefined, "leg0 venue-free ⇒ no qlVenues key");
    assert.ok(!("qlVenues" in leg0), "leg0 does not even carry the qlVenues property");
    assert.deepEqual(
      (leg1.qlVenues ?? []).map((v) => v.family), ["wooFi", "euler"],
      "leg1 keeps WOOFi + Euler",
    );

    console.log("  [legQL-prepare direct-vs-leg] curve3 direct-only; both legs excluded it");
  }

  /** The venue's pool address (all families here carry `address`). */
  function qlAddr(v: EcoLegQlVenue): Hex {
    return v.family === "mento" ? (v.desc.exchangeProvider as Hex) : (v.desc.address as Hex);
  }

  // ── (5) POOL-ONLY SHAPE — no QL configs ⇒ legs carry NO qlVenues key at all ──
  async function runPoolOnlyShape(): Promise<void> {
    await resetPools();
    const caller = c.account0;
    // Deploy an X→B V3 pool IN-CELL so a pool-only route exists (reverted by the next reset).
    const xbPool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokX, tokB, FEE_DIRECT, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, xbPool, c.account0, -12000, 12000, parseEther("400000"),
    );
    const poolConfig: ChainPoolConfig = {
      factories: [
        { address: stack.factory, poolType: SwapPoolType.UniV3, factoryType: FactoryType.V3Standard, label: "Local UniV3" },
      ],
      feeTiers: [FEE_LEG0, FEE_DIRECT],
      baseTokens: [tokX],
    };
    const { prepared } = await ecoSwap(
      { tokenIn: tokA, tokenOut: tokB, amountIn: parseEther("20000") },
      anvil.rpcUrl, cookTarget("v1", stack, v12), caller, poolConfig, { minRelBps: 0 }, "v1",
    );
    assert.equal(prepared.routes.length, 1, "one pool-only route");
    for (const leg of prepared.routes[0].legs) {
      assert.ok(leg.pools.length > 0, "pool-only leg has pools");
      assert.ok(!("qlVenues" in leg), "pool-only leg carries NO qlVenues key (prepared shape unchanged)");
    }
    console.log("  [legQL-prepare pool-only] legs carry no qlVenues key — shape-stable");
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`pinned example via REAL prepare [${engine}] — discovery + wei-exact cook + quoteEcoSwap parity`, { skip }, async () => {
      await runPinnedViaPrepare(engine);
    });
    it(`leg venue drift via REAL prepare [${engine}] — pre-drift bytecodes re-anchor`, { skip }, async () => {
      await runDriftViaPrepare(engine);
    });
  }
  it("claims: 3-coin venue on BOTH edges is admitted on exactly ONE leg", async () => {
    await runClaims();
  });
  it("direct-vs-leg exclusion: a direct venue is dropped from every leg", async () => {
    await runDirectVsLeg();
  });
  it("pool-only universe: legs carry NO qlVenues key (shape-stable prepared)", async () => {
    await runPoolOnlyShape();
  });
});
