/**
 * EcoSwap ROUTE-LEG QL venues (leg-QL) — MERGE lane, local EVM, NO fork.
 *
 * A QL venue (here: a Curve StableSwap fixture) competes as a MEMBER of a route LEG: the
 * solver builds its ladder ON-CHAIN at setup on the leg's EDGE pair (sized by the chain-order
 * fold), and the merge's route events elect/consume it as a flat constant-price SLICE
 * alongside the leg's pool brackets (1b venue head fold, Phase A legMemberWins election,
 * Phase B slice inversion, Phase C/D slice apply + cursor advance). This test hand-builds the
 * `prepared` universe (bypassing prepare — the epic's lane order puts discovery last), stands
 * up REAL local pools (UniV3 via V3LiquidityHelper + the CurveStableSwap.sol fixture whose
 * get_dy mirrors curve-math.ts bit-for-bit), compiles via the PRODUCTION buildSolverArgs /
 * protocolDefines path, cooks, and asserts the merge's awards WEI-EXACT against BOTH mirrors:
 *
 *   (1) VENUE-ONLY LEG — direct A→B V3 pool + route A→X→B whose X→B leg is ONE Curve QL
 *       venue (no pools). The route is viable ONLY through the venue, so the leg0 pool's
 *       tokenIn delta == the route award pins the slice event math end-to-end: the BINDING
 *       slice fully crosses (gross = remCap, out = remOut) and back-propagates through the
 *       leg0 POOL bracket (invertFarFromOut — the venue sits on the LAST leg, so the
 *       upstream inversion is the pool arm), and on leg0-binding events the DOWNSTREAM
 *       slice absorbs min(flow, remCap). kwayReference (cursor-faithful solver mirror) ==
 *       optimalSplit (neutral oracle) == the cooked deltas, to the WEI.
 *   (2) MIXED LEG, TWO cases — route-only universe whose X→B leg carries a V3 pool AND a
 *       steeper Curve venue, terminated by the global budget clamp (routePartialN). WHICH
 *       member the clamp elects is amount-dependent (probe-verified against an instrumented
 *       reference on these exact fixtures): at 100000e18 the merge splits INSIDE the leg
 *       (both members funded) but the clamp elects the leg1 V3 POOL — full slice events
 *       only; at 2000e18 the clamp lands ON the slice mid-row (remaining cap ≈115.8e18;
 *       5000e18+ elect the pool), exercising the CLAMPED-slice arm — min(pflow, remCap)
 *       consume + qinp accrual + cursor advance — ON-CHAIN. tokenIn-side deltas wei-exact;
 *       the leg1 X-side per-member exec split is asserted wei-exact in both cases.
 *   (3) DEAD UPSTREAM (hF==0) — a route whose leg0 has NO members folds the leg-QL venue's
 *       ladderCap to 0 (the chain-order sizing fold's hF==0 arm) ⇒ the venue builds a
 *       zero-row ladder (born exhausted) and contributes ZERO; the route is dead and the
 *       direct pool takes the whole trade. Driven through the QUOTE path too (eth_call +
 *       stateOverride, the quoteEcoSwap mechanics, MintableERC20 slots 4/5): quoted ==
 *       cooked amountOut to the wei.
 *
 * EXEC-side (the unified per-leg loop + the leg-QL venue dispatch in ecoswap.sauce.ts):
 *   (4) VENUE-ONLY OUTPUT — the X→B Curve venue EXECUTES its awarded share (the whole
 *       realized leg X, wei-exact vs the leg0 pool's X outflow), the caller receives
 *       tokenOut, quote == cook, and the per-route intermediate sweep NO-OPS (zero X back
 *       to the caller) on the happy path.
 *   (5) PINNED EXAMPLE — the epic's canonical shape: leg A→X = {UniV3 pool + Maverick
 *       venue}, leg X→B = {Curve + WOOFi + Euler venues} (+ a direct A→B pool competing at
 *       the global cut). EVERY funded member executes (Transfer-log gated): leg0 members
 *       receive EXACTLY their computed awards (leg0 inBal := lTotal ⇒ share == award), leg1
 *       members receive EXACTLY their proportional slice of the realized X (last-funded
 *       venue absorbs the division dust — the exec's member ordering mirrored off-chain),
 *       totals wei-exact vs kwayReference == optimalSplit, quote == cook.
 *   (6) ADVERSE DRIFT on a leg venue — a REAL exchange moves the mixed leg's Curve fixture
 *       between arg-build and cook; the cook RE-ANCHORS (the venue ladder is rebuilt
 *       on-chain from live get_dy at cook): awards == the mirrors run on the DRIFTED state,
 *       the drifted venue's share SHRINKS vs the no-drift baseline while the sibling V3
 *       pool's grows, and the X-side split still lands exactly proportional.
 *
 * Run: ECO_ENGINE=both npx tsx --test src/recipes/test/ecoswap.legql.evm.test.ts
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { compileSauce, ECOSWAP_DIR } from "./harness/compile";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  deployToken,
  createAndInitPool,
  mintPosition,
  getSlot0,
  getLiquidity,
  mint,
  approve,
  balanceOf,
  deployCurveStableSwap,
  deployMaverickV2Pool,
  deployWooFiPool,
  deployEulerSwapPool,
  curveAbi,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
  type MaverickDeployParams,
  type EulerSwapParams,
} from "./harness/setup";
import { writeAndWait } from "./harness/deploy";
import {
  type Engine,
  engineCells,
  maybeDeployV12Stack,
  cookTarget,
} from "./harness/engine";
import { MIN_SQRT_RATIO, SwapPoolType } from "../shared/constants";
import type { EcoPool, EcoSwapPrepared, EcoLegQlVenue } from "../shared/types";
import { buildSolverArgs, protocolDefines } from "../ecoswap/index";
import { getSqrtRatioAtTick, mulDiv, OFFSET } from "./ecoswap.math";
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

const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");
const HUGE = parseEther("1000000000");
const E18 = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const ZERO32 = ("0x" + "00".repeat(32)) as Hex;
const E8 = 10n ** 8n;
const ENGINE_CELLS = engineCells();

// Fee tiers (V3 feePpm == fee tier for the canonical tiers).
const FEE_DIRECT = 3000;
const TS_DIRECT = 60;
const FEE_LEG0 = 500;
const TS_LEG0 = 10;
const FEE_LEG1V3 = 3000;
const TS_LEG1V3 = 60;
// Curve fixture params (fee is 1e10-scaled — the descriptor's qd[3] carries it verbatim).
const CURVE_DEEP_BAL = [1_000_000n * E18, 1_200_000n * E18];
const CURVE_DEEP_A = 1000n;
const CURVE_DEEP_FEE = 4_000_000n; // 0.04%
const CURVE_STEEP_BAL = [150_000n * E18, 150_000n * E18];
const CURVE_STEEP_A = 20n;
const CURVE_STEEP_FEE = 3_000_000n; // 0.03%, steep low-A curve — bends within the trade
// ── PINNED-EXAMPLE fixtures (case 5): sizes PROBE-VERIFIED so EVERY leg member funds at
// 20000e18 (kwayReference on these exact models: leg0 V3 ≈7.8k, Maverick ≈12.0k, Curve ≈11.4k,
// WOOFi ≈1.25k, Euler ≈7.2k, direct ≈146) — shrinking any depth or the amount re-probes. ──
const MAV_TS = 10;
const MAV_FEE = E18 / 1000n; // 0.1% directional (1e18-scaled)
const MAV_FEE_PPM = Number((MAV_FEE * 1_000_000n) / E18); // 1000
const MAV_ACTIVE = -3;
const MAV_LO = -4;
const MAV_HI = 6;
const MAV_PER_TICK = 2_000n * E18; // shallow book — bends within the trade so the V3 pool splits
const CURVE_PIN_BAL = [40_000n * E18, 40_000n * E18];
const CURVE_PIN_A = 20n;
const CURVE_PIN_FEE = 3_000_000n; // 0.03%
const WOO_PRICE = E8; // 1:1 (WooracleV2 canonical 1e8 price decimals)
const WOO_SPREAD = 10n ** 14n; // 1 bp
const WOO_COEFF = 10n ** 13n; // large gamma — the sPMM bends within the trade
const WOO_FEE_RATE = 25n; // 0.025% (1e5-scaled)
const WOO_FEE_PPM = 250;
const WOO_BASE_RES = 500_000n * E18;
const WOO_QUOTE_RES = 500_000n * E18;
const EUL_RES = 60_000n * E18;
const EUL_CONC = (9n * E18) / 10n; // 0.9 — concentrated near equilibrium, bends off it
const EUL_FEE = E18 / 1000n; // 0.1%
const EUL_FEE_PPM = 1000;

// Minimal ERC20 Transfer event (erc20Abi in harness/setup is functions-only).
const erc20TransferAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

describe("EcoSwap route-leg QL venues — merge WEI-EXACT (venue-only / mixed / dead-upstream legs)", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  // Tokens RELABELED ascending by address (A < X < B) so EVERY edge (A→X, X→B, A→B) is
  // zeroForOne — one direction to hand-stamp, priceLimit = MIN_SQRT_RATIO + 1.
  let tokA: Hex; // tokenIn
  let tokX: Hex; // intermediate
  let tokB: Hex; // tokenOut
  let directPool: Hex; // A→B V3 (fee 3000)
  let leg0Pool: Hex; // A→X V3 (fee 500)
  let leg1V3Pool: Hex; // X→B V3 (fee 3000) — the mixed-leg pool member
  let curveDeep: Hex; // X→B Curve fixture (deep, 0.04%)
  let curveSteep: Hex; // X→B Curve fixture (steep low-A, 0.03%)
  // Pinned-example fixtures (case 5): A→X Maverick + X→B Curve/WOOFi/Euler venues.
  let mavPool: Hex; // A→X Maverick V2 fixture (tokenA == tokA, tokenAIn)
  let curvePin: Hex; // X→B Curve fixture (small, 0.03%)
  let wooPool: Hex; // X→B WOOFi fixture (base == tokX, quote == tokB)
  let eulPool: Hex; // X→B EulerSwap fixture (asset0 == tokX)
  let solverSrc: string;
  let cleanSnapshot: Hex;

  const COOK_BLOCK_TIMESTAMP = 2_000_000_000n;

  before(async () => {
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    solverSrc = readFileSync(SOLVER, "utf-8");

    const t1 = await deployToken(c.walletClient, c.publicClient, "TokOne", "T1");
    const t2 = await deployToken(c.walletClient, c.publicClient, "TokTwo", "T2");
    const t3 = await deployToken(c.walletClient, c.publicClient, "TokThree", "T3");
    [tokA, tokX, tokB] = [t1, t2, t3].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : 1,
    );

    const minter = c.account0;
    for (const t of [tokA, tokX, tokB]) {
      await mint(c.walletClient, c.publicClient, t, minter, parseEther("1000000000"));
      await approve(c.walletClient, c.publicClient, t, stack.helper, HUGE);
    }

    // DIRECT A→B: shallow-ish, engages at the global cut against the route.
    directPool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokA, tokB, FEE_DIRECT, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, directPool, minter, -12000, 12000, parseEther("8000"),
    );
    // ROUTE leg0 A→X: deep, one wide position ⇒ constant L over the walked region (empty net).
    leg0Pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokA, tokX, FEE_LEG0, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, leg0Pool, minter, -12000, 12000, parseEther("5000000"),
    );
    // MIXED-leg X→B V3: deep, competes inside the leg against the steep Curve venue.
    leg1V3Pool = await createAndInitPool(
      c.walletClient, c.publicClient, stack.factory, tokX, tokB, FEE_LEG1V3, SQRT_PRICE_1_1,
    );
    await mintPosition(
      c.walletClient, c.publicClient, stack.helper, leg1V3Pool, minter, -12000, 12000, parseEther("5000000"),
    );
    // Curve X→B fixtures (both at ~1:1 spot; deep/cheap vs steep low-A).
    curveDeep = await deployCurveStableSwap(
      c.walletClient, c.publicClient, [tokX, tokB], CURVE_DEEP_BAL, [E18, E18], CURVE_DEEP_A, CURVE_DEEP_FEE, minter,
    );
    curveSteep = await deployCurveStableSwap(
      c.walletClient, c.publicClient, [tokX, tokB], CURVE_STEEP_BAL, [E18, E18], CURVE_STEEP_A, CURVE_STEEP_FEE, minter,
    );
    // Pinned-example fixtures. Maverick A→X: tokenA == tokA (tokenAIn — the walk direction the
    // descriptor stamps), a SHALLOW uniform book so the leg splits pool+venue. The deploy params
    // mirror mavModel() below so the fixture state == the oracle model bit-for-bit.
    const mavTicks: MaverickTick[] = [];
    for (let t = MAV_LO; t <= MAV_HI; t++) {
      mavTicks.push({ tick: t, reserveA: MAV_PER_TICK, reserveB: MAV_PER_TICK });
    }
    const mavParams: MaverickDeployParams = {
      tokenA: tokA, tokenB: tokX, tickSpacing: MAV_TS, feeAIn: MAV_FEE, feeBIn: MAV_FEE,
      protocolFeeRatioD3: 0, ticks: mavTicks, activeTick: MAV_ACTIVE,
      poolSqrtPrice: mavModel(ZERO).poolSqrtPrice,
    };
    mavPool = await deployMaverickV2Pool(c.walletClient, c.publicClient, mavParams, minter);
    // X→B: small Curve (bends fast), WOOFi (1:1 oracle, big gamma), Euler (0.9-concentration).
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

    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
    cleanSnapshot = await c.testClient.snapshot();
  });

  after(() => anvil?.stop());

  async function resetPools(): Promise<void> {
    await c.testClient.revert({ id: cleanSnapshot });
    cleanSnapshot = await c.testClient.snapshot();
    // Pin the cook block timestamp: the V3 oracle accumulator depends on block.timestamp,
    // which drifts across evm_revert (the established routes-test idiom).
    await c.testClient.setNextBlockTimestamp({ timestamp: COOK_BLOCK_TIMESTAMP });
  }

  // ── Hand-built descriptor/model builders (bypass prepare — the epic lands discovery last) ──

  /** Live-read a V3 pool and build the matching hand-stamped EcoPool (windowTop=0 ⇒ the
   *  on-chain walk staticcalls every boundary — the no-cache live walk; empty net matches a
   *  single wide position whose mint-bound ticks the walk never reaches). All edges are
   *  zeroForOne (tokens relabeled ascending), so the start boundary is the tick base. */
  async function v3EcoPool(address: Hex, feePpm: number, ts: number): Promise<{
    pool: EcoPool;
    opt: OptimalPool;
  }> {
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, address);
    const liquidity = await getLiquidity(c.publicClient, address);
    const base = Math.floor(tick / ts) * ts;
    const pool: EcoPool = {
      poolType: SwapPoolType.UniV3,
      address,
      fee: feePpm,
      tickSpacing: ts,
      hooks: ZERO,
      feePpm,
      isV2: false,
      inIsToken0: true,
      stateView: ZERO,
      poolId: ZERO32,
      stepRatio: getSqrtRatioAtTick(ts),
      windowTopShifted: 0n,
      windowBotShifted: 0n,
      extremeShifted: 0n,
      spotTickShifted: BigInt(base) + OFFSET,
      spotNearReal: sqrtPriceX96,
      spotActiveL: liquidity,
      adaptiveNet: new Map<number, bigint>(),
      source: "legql-fixture",
    };
    const opt: OptimalPool = {
      isV2: false, feePpm, sqrtPriceX96, tick, tickSpacing: ts, liquidity,
      net: new Map<number, bigint>(),
    };
    return { pool, opt };
  }

  /** The Curve fixture as (a) the EcoLegQlVenue descriptor the qlv row is built from and
   *  (b) the shared-math CurvePool model the oracle/reference ladder from — SAME builder
   *  (buildLegQlVenueLadder → buildCurveQLLadder) as the on-chain live get_dy ladder. */
  function curveVenue(address: Hex, balances: bigint[], A: bigint, fee: bigint): {
    venue: EcoLegQlVenue;
    model: CurvePool;
    olv: OptimalLegQlVenue;
  } {
    const model: CurvePool = {
      poolType: 3, address, i: 0, j: 1, A, aPrecision: 100n,
      balances: [...balances], rates: [E18, E18], feePpm10: fee, source: "legql-fixture",
    };
    const venue: EcoLegQlVenue = {
      family: "curve",
      desc: { address, i: 0, j: 1, feePpm: Number(fee), source: "legql-fixture" },
    };
    return { venue, model, olv: { family: "curve", model } };
  }

  /** The Maverick fixture's shared-math model — the SAME uniform book the deploy params carry
   *  (offPoolAt construction from the maverick EVM test), so fixture state == model bit-for-bit
   *  and buildMaverickWalkLadder == the solver's on-chain bin-walk. */
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
      feePpm: MAV_FEE_PPM, source: "legql-fixture",
    };
  }

  function mavVenue(address: Hex): { venue: EcoLegQlVenue; olv: OptimalLegQlVenue } {
    const venue: EcoLegQlVenue = {
      family: "maverick",
      desc: { address, tokenAIn: true, tickSpacing: MAV_TS, feePpm: MAV_FEE_PPM, source: "legql-fixture" },
    };
    return { venue, olv: { family: "maverick", model: mavModel(address) } };
  }

  function wooVenue(address: Hex): { venue: EcoLegQlVenue; olv: OptimalLegQlVenue } {
    const model: WooFiPool = {
      address, tokenIn: tokX, tokenOut: tokB, sellBase: true,
      price: WOO_PRICE, spread: WOO_SPREAD, coeff: WOO_COEFF,
      priceDec: E8, quoteDec: E18, baseDec: E18,
      feeRate: WOO_FEE_RATE, feePpm: WOO_FEE_PPM, source: "legql-fixture",
    };
    const venue: EcoLegQlVenue = {
      family: "wooFi",
      desc: { address, fromToken: tokX, toToken: tokB, feePpm: WOO_FEE_PPM, source: "legql-fixture" },
    };
    return { venue, olv: { family: "wooFi", model } };
  }

  function eulVenue(address: Hex): { venue: EcoLegQlVenue; olv: OptimalLegQlVenue } {
    const model: EulerSwapPool = {
      address, inIsToken0: true,
      reserveIn: EUL_RES, reserveOut: EUL_RES, equilIn: EUL_RES, equilOut: EUL_RES,
      priceIn: E18, priceOut: E18, concIn: EUL_CONC, concOut: EUL_CONC, feeWad: EUL_FEE,
      inLimit: 0n, outLimit: 0n, feePpm: EUL_FEE_PPM, source: "legql-fixture",
    };
    const venue: EcoLegQlVenue = {
      family: "euler",
      desc: { address, inIsToken0: true, feePpm: EUL_FEE_PPM, source: "legql-fixture" },
    };
    return { venue, olv: { family: "euler", model } };
  }

  /** Σ of Transfer(token, * → to) values in a receipt — the venue-funding Transfer-log gate. */
  function transferSumTo(receipt: TransactionReceipt, token: Hex, to: Hex): bigint {
    const events = parseEventLogs({ abi: erc20TransferAbi, logs: receipt.logs, eventName: "Transfer" });
    let sum = 0n;
    for (const ev of events) {
      if (ev.address.toLowerCase() !== token.toLowerCase()) continue;
      if ((ev.args.to as Hex).toLowerCase() === to.toLowerCase()) sum += ev.args.value as bigint;
    }
    return sum;
  }

  /** The exec's unified per-leg proportional split, mirrored off-chain: pools first then venues
   *  (floor mulDiv shares), the LAST funded member (venues scanned second, so a funded venue
   *  wins 'last') takes inBal − spent — EXACTLY the solver's member ordering + dust rule. */
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

  // ── eth_call QUOTE drive (the quoteEcoSwap mechanics inline — hand-built prepared can't go
  // through quoteEcoSwap, which runs the real prepare; discovery lands in the prepare lane) ──
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
  /** MintableERC20 layout: balanceOf slot 4, allowance slot 5 (the quoteEcoSwap doc note). */
  function mappingSlot(key: Hex, slot: bigint): Hex {
    return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
  }
  function nestedMappingSlot(a: Hex, b: Hex, slot: bigint): Hex {
    return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [b, mappingSlot(a, slot)]));
  }
  const OVERRIDE_AMOUNT = ("0x" + "0".repeat(32) + "f".repeat(32)) as Hex;

  /** Read-only cook via eth_call with the caller's balance + allowance injected through
   *  stateOverride (NO on-chain approve) — the quoteEcoSwap state-override quote, inline. */
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

  function compilePrepared(
    engine: Engine,
    prepared: EcoSwapPrepared,
    amountIn: bigint,
    caller: Hex,
  ): Hex[] {
    const { bytecodes } = compileSauce(
      solverSrc,
      buildSolverArgs(tokA, tokB, amountIn, caller, prepared),
      ECOSWAP_DIR,
      engine,
      { treeshake: true, defines: protocolDefines(prepared) },
    );
    return bytecodes;
  }

  // ── (1) VENUE-ONLY LEG — the X→B leg is ONE Curve QL venue; wei-exact vs both mirrors ──
  async function runVenueOnlyLeg(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const amountIn = parseEther("20000");

    const direct = await v3EcoPool(directPool, FEE_DIRECT, TS_DIRECT);
    const leg0 = await v3EcoPool(leg0Pool, FEE_LEG0, TS_LEG0);
    const cv = curveVenue(curveDeep, CURVE_DEEP_BAL, CURVE_DEEP_A, CURVE_DEEP_FEE);

    const prepared: EcoSwapPrepared = {
      pools: [direct.pool],
      routes: [
        {
          legs: [
            { hopIn: tokA, hopOut: tokX, zeroForOne: true, pools: [leg0.pool] },
            { hopIn: tokX, hopOut: tokB, zeroForOne: true, pools: [], qlVenues: [cv.venue] },
          ],
          intermediateTokens: [tokX],
        },
      ],
      brackets: [],
      zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
      expectedInputCovered: 0n,
    };

    // Cursor-faithful reference (mirrors the solver bit-for-bit; its internal slice-equality +
    // conservation gates throw on ANY drift) and the neutral oracle — both from the SAME live
    // reads. The reference's fold/ladder use the SHARED buildLegQlVenueLadder the solver replays.
    const ref = kwayReference(prepared, amountIn, undefined, [[undefined, [cv.olv]]]);
    const optRoute: OptimalRoute = {
      legs: [
        { zeroForOne: true, pools: [leg0.opt] },
        { zeroForOne: true, pools: [], qlvs: [cv.olv] },
      ],
    };
    const opt = optimalSplit({
      pools: [direct.opt], routes: [optRoute], amountIn, zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
    });
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei)");
    assert.equal(ref.perPoolInput[0], opt.perPoolInput[0], "direct award == oracle (wei)");
    assert.equal(ref.perRouteInput[0], opt.perRouteInput[0], "route award == oracle (wei)");
    assert.ok(ref.perRouteInput[0] > 0n, "route engaged (viable ONLY through the leg venue)");
    assert.ok(ref.perPoolInput[0] > 0n, "direct engaged (global cut split)");
    assert.ok(ref.perLegQlvInput[0] > 0n, "leg venue awarded input (the qinp mirror)");

    const bytecodes = compilePrepared(engine, prepared, amountIn, caller);

    const callerABefore = await balanceOf(c.publicClient, tokA, caller);
    const directABefore = await balanceOf(c.publicClient, tokA, directPool);
    const leg0ABefore = await balanceOf(c.publicClient, tokA, leg0Pool);

    await approve(c.walletClient, c.publicClient, tokA, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "venue-only-leg cook() must succeed");

    const spent = callerABefore - (await balanceOf(c.publicClient, tokA, caller));
    const directIn = (await balanceOf(c.publicClient, tokA, directPool)) - directABefore;
    const leg0In = (await balanceOf(c.publicClient, tokA, leg0Pool)) - leg0ABefore;

    // WEI-EXACT: the pull is the merge's cum (compute-then-pull) — it INCLUDES the slice-bound
    // route events — and the per-universe-pool awards land exactly. The leg0 gross was
    // back-propagated THROUGH the venue's slice inversion every event, so leg0In == the route
    // award pins the on-chain slice arithmetic (Phase B/C/D) to the mirrors.
    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (wei)`);
    assert.equal(directIn, ref.perUniversePoolInput[0], `[${engine}] direct pool award == reference (wei)`);
    assert.equal(leg0In, ref.perUniversePoolInput[1], `[${engine}] leg0 pool award == reference (wei)`);
    assert.equal(leg0In, ref.perRouteInput[0], `[${engine}] leg0 gross == route award (2-leg identity)`);

    console.log(
      `  [legQL venue-only:${engine}] direct=${directIn} route=${leg0In} venueAward=${ref.perLegQlvInput[0]} spent=${spent} (== mirrors, wei)`,
    );
  }

  // ── (2) MIXED LEG — X→B carries a V3 pool AND a Curve venue; the leg splits internally ──
  async function runMixedLeg(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    // Route-only universe (no direct pool): the trade terminates via the global budget clamp
    // (routePartialN). At THIS amount the clamp event elects the leg1 V3 POOL (probe-verified:
    // 4 binding-slice + 13 downstream non-binding full events, 0 clamped-slice hits), so this
    // cook pins the FULL slice events + the leg-internal split; the clamped-slice arm is
    // pinned by the 2000e18 cook below (runMixedSliceClamp).
    const amountIn = parseEther("100000");

    const leg0 = await v3EcoPool(leg0Pool, FEE_LEG0, TS_LEG0);
    const leg1 = await v3EcoPool(leg1V3Pool, FEE_LEG1V3, TS_LEG1V3);
    const cv = curveVenue(curveSteep, CURVE_STEEP_BAL, CURVE_STEEP_A, CURVE_STEEP_FEE);

    const prepared: EcoSwapPrepared = {
      pools: [],
      routes: [
        {
          legs: [
            { hopIn: tokA, hopOut: tokX, zeroForOne: true, pools: [leg0.pool] },
            { hopIn: tokX, hopOut: tokB, zeroForOne: true, pools: [leg1.pool], qlVenues: [cv.venue] },
          ],
          intermediateTokens: [tokX],
        },
      ],
      brackets: [],
      zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
      expectedInputCovered: 0n,
    };

    const ref = kwayReference(prepared, amountIn, undefined, [[undefined, [cv.olv]]]);
    const optRoute: OptimalRoute = {
      legs: [
        { zeroForOne: true, pools: [leg0.opt] },
        { zeroForOne: true, pools: [leg1.opt], qlvs: [cv.olv] },
      ],
    };
    const opt = optimalSplit({
      pools: [], routes: [optRoute], amountIn, zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
    });
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei)");
    assert.equal(ref.perRouteInput[0], opt.perRouteInput[0], "route award == oracle (wei)");
    // The SPLIT INSIDE THE LEG: the steeper/cheaper Curve venue draws first, bends, and the
    // V3 pool takes the tail — BOTH leg1 members funded in the mirrors.
    assert.ok(ref.perLegQlvInput[0] > 0n, "leg venue awarded input (leg-internal split)");
    assert.ok(ref.perUniversePoolInput[1] > 0n, "leg1 V3 pool awarded input (leg-internal split)");

    const bytecodes = compilePrepared(engine, prepared, amountIn, caller);

    const callerABefore = await balanceOf(c.publicClient, tokA, caller);
    const callerXBefore = await balanceOf(c.publicClient, tokX, caller);
    const leg0ABefore = await balanceOf(c.publicClient, tokA, leg0Pool);
    const leg0XBefore = await balanceOf(c.publicClient, tokX, leg0Pool);
    const leg1XBefore = await balanceOf(c.publicClient, tokX, leg1V3Pool);
    const curveXBefore = await balanceOf(c.publicClient, tokX, curveSteep);

    await approve(c.walletClient, c.publicClient, tokA, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "mixed-leg cook() must succeed");

    const spent = callerABefore - (await balanceOf(c.publicClient, tokA, caller));
    const leg0In = (await balanceOf(c.publicClient, tokA, leg0Pool)) - leg0ABefore;
    const leg1V3In = (await balanceOf(c.publicClient, tokX, leg1V3Pool)) - leg1XBefore;
    const curveXIn = (await balanceOf(c.publicClient, tokX, curveSteep)) - curveXBefore;

    // tokenIn-side WEI gate (the merge): spent == cum; leg0 absorbs the whole route gross.
    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (wei)`);
    assert.equal(leg0In, ref.perUniversePoolInput[0], `[${engine}] leg0 pool award == reference (wei)`);
    assert.equal(leg0In, ref.perRouteInput[0], `[${engine}] leg0 gross == route award (2-leg identity)`);
    // X-side WEI gate (the exec): the leg's REALIZED X (the leg0 pool's X outflow) splits
    // across {leg1 V3 pool, Curve venue} proportional to the merged awards — the last-funded
    // member (the venue: venues scan second) absorbs the division dust. Mirrored exactly by
    // expectedLegShares, so both member inflows are wei-exact.
    const inBalX = leg0XBefore - (await balanceOf(c.publicClient, tokX, leg0Pool));
    assert.ok(inBalX > 0n, `[${engine}] leg0 produced intermediate X`);
    const exp = expectedLegShares(inBalX, [ref.perUniversePoolInput[1]], [ref.perLegQlvInput[0]]);
    assert.equal(leg1V3In, exp.pools[0], `[${engine}] leg1 V3 pool X share == proportional award (wei)`);
    assert.equal(curveXIn, exp.venues[0], `[${engine}] Curve venue X share == proportional award (wei)`);
    // Happy path: the per-route intermediate sweep NO-OPS (no X dust back to the caller).
    assert.equal(
      await balanceOf(c.publicClient, tokX, caller), callerXBefore,
      `[${engine}] intermediate sweep no-ops on the happy path`,
    );

    console.log(
      `  [legQL mixed:${engine}] route=${leg0In} leg1V3X=${leg1V3In} venueX=${curveXIn} spent=${spent} (both sides == mirrors, wei)`,
    );
  }

  // ── (2b) MIXED LEG, SLICE-CLAMP — same fixtures, sized so the clamp lands ON the slice ──
  async function runMixedSliceClamp(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    // Sized so the terminal routePartialN event elects the SLICE (probe-verified on these
    // exact fixtures: the clamp lands mid-row, remaining cap ≈115.8e18, consuming ≈114.96e18;
    // at 5000e18+ the leg1 V3 pool overtakes and the clamp elects it instead — the 100000e18
    // cook above). This executes the solver's CLAMPED-slice arm — min(pflow, remCap) consume
    // + qinp accrual + cursor bookkeeping — ON-CHAIN (any transcription drift that breaks its
    // uint256 arithmetic reverts the cook; the value-level pin is the reference's internal
    // clamped-slice equality gate, which throws while computing `ref` below, plus the X-side
    // venue-only drain assert below). tokenIn-side deltas stay the wei gate.
    const amountIn = parseEther("2000");

    const leg0 = await v3EcoPool(leg0Pool, FEE_LEG0, TS_LEG0);
    const leg1 = await v3EcoPool(leg1V3Pool, FEE_LEG1V3, TS_LEG1V3);
    const cv = curveVenue(curveSteep, CURVE_STEEP_BAL, CURVE_STEEP_A, CURVE_STEEP_FEE);

    const prepared: EcoSwapPrepared = {
      pools: [],
      routes: [
        {
          legs: [
            { hopIn: tokA, hopOut: tokX, zeroForOne: true, pools: [leg0.pool] },
            { hopIn: tokX, hopOut: tokB, zeroForOne: true, pools: [leg1.pool], qlVenues: [cv.venue] },
          ],
          intermediateTokens: [tokX],
        },
      ],
      brackets: [],
      zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
      expectedInputCovered: 0n,
    };

    const ref = kwayReference(prepared, amountIn, undefined, [[undefined, [cv.olv]]]);
    const optRoute: OptimalRoute = {
      legs: [
        { zeroForOne: true, pools: [leg0.opt] },
        { zeroForOne: true, pools: [leg1.opt], qlvs: [cv.olv] },
      ],
    };
    const opt = optimalSplit({
      pools: [], routes: [optRoute], amountIn, zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
    });
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei)");
    assert.equal(ref.perRouteInput[0], opt.perRouteInput[0], "route award == oracle (wei)");
    assert.equal(ref.totalInput, amountIn, "route-only universe absorbs the whole budget (clamped)");
    // The clamp-on-slice geometry: the venue is strictly cheaper all the way to the clamp, so
    // it takes the WHOLE leg1 award and the V3 pool takes NONE. If either assert fires, the
    // fixture drifted and the clamp election must be RE-PROBED — the clamped-slice arm this
    // case exists to cover may no longer execute.
    assert.ok(ref.perLegQlvInput[0] > 0n, "leg venue awarded input (incl. the clamped partial)");
    assert.equal(ref.perUniversePoolInput[1], 0n, "leg1 V3 pool NOT funded (venue cheaper to the clamp)");

    const bytecodes = compilePrepared(engine, prepared, amountIn, caller);

    const callerABefore = await balanceOf(c.publicClient, tokA, caller);
    const leg0ABefore = await balanceOf(c.publicClient, tokA, leg0Pool);
    const leg0XBefore = await balanceOf(c.publicClient, tokX, leg0Pool);
    const leg1XBefore = await balanceOf(c.publicClient, tokX, leg1V3Pool);
    const curveXBefore = await balanceOf(c.publicClient, tokX, curveSteep);

    await approve(c.walletClient, c.publicClient, tokA, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "slice-clamp cook() must succeed");

    const spent = callerABefore - (await balanceOf(c.publicClient, tokA, caller));
    const leg0In = (await balanceOf(c.publicClient, tokA, leg0Pool)) - leg0ABefore;

    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (wei)`);
    assert.equal(leg0In, ref.perUniversePoolInput[0], `[${engine}] leg0 pool award == reference (wei)`);
    assert.equal(leg0In, ref.perRouteInput[0], `[${engine}] leg0 gross == route award (2-leg identity)`);
    // X-side (the exec): the venue holds the WHOLE leg1 award (the V3 pool got 0), so the
    // whole realized X drains through the venue and the pool receives NOTHING.
    const inBalX = leg0XBefore - (await balanceOf(c.publicClient, tokX, leg0Pool));
    const curveXIn = (await balanceOf(c.publicClient, tokX, curveSteep)) - curveXBefore;
    assert.equal(curveXIn, inBalX, `[${engine}] venue drains the WHOLE realized X (sole funded member)`);
    assert.equal(
      await balanceOf(c.publicClient, tokX, leg1V3Pool), leg1XBefore,
      `[${engine}] unfunded leg1 V3 pool receives no X`,
    );

    console.log(
      `  [legQL slice-clamp:${engine}] route=${leg0In} venueX=${curveXIn} spent=${spent} (clamp landed ON the slice)`,
    );
  }

  // ── (3) DEAD UPSTREAM (hF==0) — empty leg0 folds the leg venue's ladderCap to 0 ──
  async function runDeadUpstream(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const amountIn = parseEther("2000");

    const direct = await v3EcoPool(directPool, FEE_DIRECT, TS_DIRECT);
    const cv = curveVenue(curveDeep, CURVE_DEEP_BAL, CURVE_DEEP_A, CURVE_DEEP_FEE);

    // leg0 has NO members ⇒ its best head hF == 0 ⇒ the chain-order sizing fold zeroes the
    // leg1 venue's ladderCap ⇒ the on-chain build emits a ZERO-ROW ladder (born exhausted;
    // zero quote staticcalls) AND the route is dead — the venue contributes ZERO and the
    // direct pool takes the whole trade.
    const prepared: EcoSwapPrepared = {
      pools: [direct.pool],
      routes: [
        {
          legs: [
            { hopIn: tokA, hopOut: tokX, zeroForOne: true, pools: [] },
            { hopIn: tokX, hopOut: tokB, zeroForOne: true, pools: [], qlVenues: [cv.venue] },
          ],
          intermediateTokens: [tokX],
        },
      ],
      brackets: [],
      zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
      expectedInputCovered: 0n,
    };

    const ref = kwayReference(prepared, amountIn, undefined, [[undefined, [cv.olv]]]);
    const optRoute: OptimalRoute = {
      legs: [
        { zeroForOne: true, pools: [] },
        { zeroForOne: true, pools: [], qlvs: [cv.olv] },
      ],
    };
    const opt = optimalSplit({
      pools: [direct.opt], routes: [optRoute], amountIn, zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
    });
    assert.equal(ref.perRouteInput[0], 0n, "dead route awarded nothing (reference)");
    assert.equal(opt.perRouteInput[0], 0n, "dead route awarded nothing (oracle)");
    assert.equal(ref.perLegQlvInput[0], 0n, "leg venue contributes ZERO (born-exhausted ladder)");
    assert.equal(ref.totalInput, opt.totalInput, "direct-only total == oracle (wei)");
    assert.equal(ref.totalInput, amountIn, "the direct pool absorbs the whole trade");

    const bytecodes = compilePrepared(engine, prepared, amountIn, caller);

    // QUOTE path FIRST (eth_call + stateOverride, NO on-chain approve — the override supplies
    // balance+allowance): a dead-route universe executes pool-only, so the read-only realized
    // output is exactly what the cook below lands.
    const quoted = await quoteViaStateOverride(engine, target, caller, bytecodes);
    assert.ok(quoted > 0n, `[${engine}] state-override quote returns a positive output`);

    const callerABefore = await balanceOf(c.publicClient, tokA, caller);
    const callerBBefore = await balanceOf(c.publicClient, tokB, caller);
    const directABefore = await balanceOf(c.publicClient, tokA, directPool);
    const curveXBefore = await balanceOf(c.publicClient, tokX, curveDeep);
    const curveBBefore = await balanceOf(c.publicClient, tokB, curveDeep);

    await approve(c.walletClient, c.publicClient, tokA, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "dead-upstream cook() must succeed");

    const spent = callerABefore - (await balanceOf(c.publicClient, tokA, caller));
    const received = (await balanceOf(c.publicClient, tokB, caller)) - callerBBefore;
    const directIn = (await balanceOf(c.publicClient, tokA, directPool)) - directABefore;

    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (wei)`);
    assert.equal(directIn, ref.perUniversePoolInput[0], `[${engine}] direct pool took the whole trade (wei)`);
    // The venue contributed zero — its pool balances are untouched (holds post-exec-lane too:
    // the route is dead, nothing is awarded, nothing executes).
    assert.equal(await balanceOf(c.publicClient, tokX, curveDeep), curveXBefore, "venue X balance untouched");
    assert.equal(await balanceOf(c.publicClient, tokB, curveDeep), curveBBefore, "venue B balance untouched");
    // QUOTE == COOK: the state-override eth_call realized the same output the cook landed.
    assert.equal(quoted, received, `[${engine}] quoted amountOut == cooked amountOut (wei)`);

    console.log(
      `  [legQL dead-upstream:${engine}] quoted=${quoted} cooked=${received} spent=${spent} (venue contributed zero)`,
    );
  }

  // ── (4) VENUE-ONLY OUTPUT — the leg venue EXECUTES its share (the exec dispatch) ──
  async function runVenueOnlyOutput(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const amountIn = parseEther("20000");

    const direct = await v3EcoPool(directPool, FEE_DIRECT, TS_DIRECT);
    const leg0 = await v3EcoPool(leg0Pool, FEE_LEG0, TS_LEG0);
    const cv = curveVenue(curveDeep, CURVE_DEEP_BAL, CURVE_DEEP_A, CURVE_DEEP_FEE);
    const prepared: EcoSwapPrepared = {
      pools: [direct.pool],
      routes: [
        {
          legs: [
            { hopIn: tokA, hopOut: tokX, zeroForOne: true, pools: [leg0.pool] },
            { hopIn: tokX, hopOut: tokB, zeroForOne: true, pools: [], qlVenues: [cv.venue] },
          ],
          intermediateTokens: [tokX],
        },
      ],
      brackets: [],
      zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
      expectedInputCovered: 0n,
    };
    const ref = kwayReference(prepared, amountIn, undefined, [[undefined, [cv.olv]]]);
    const bytecodes = compilePrepared(engine, prepared, amountIn, caller);

    // Zero-cache QUOTE == COOK (the spec's quote case on a venue-funded route): the leg venue
    // executes its awarded share, so the read-only realized output equals the cook's.
    const quoted = await quoteViaStateOverride(engine, target, caller, bytecodes);

    const callerABefore = await balanceOf(c.publicClient, tokA, caller);
    const callerBBefore = await balanceOf(c.publicClient, tokB, caller);
    const callerXBefore = await balanceOf(c.publicClient, tokX, caller);
    const leg0XBefore = await balanceOf(c.publicClient, tokX, leg0Pool);
    const curveXBefore = await balanceOf(c.publicClient, tokX, curveDeep);
    const curveBBefore = await balanceOf(c.publicClient, tokB, curveDeep);

    await approve(c.walletClient, c.publicClient, tokA, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "venue-only-leg output cook() must succeed");

    const spent = callerABefore - (await balanceOf(c.publicClient, tokA, caller));
    const received = (await balanceOf(c.publicClient, tokB, caller)) - callerBBefore;
    const curveXIn = (await balanceOf(c.publicClient, tokX, curveDeep)) - curveXBefore;
    const curveBOut = curveBBefore - (await balanceOf(c.publicClient, tokB, curveDeep));

    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (wei)`);
    // The venue (the leg's SOLE member) drains the WHOLE realized X — wei-exact vs the leg0
    // pool's X outflow — Transfer-log gated too (self → venue in the leg-INPUT token).
    const inBalX = leg0XBefore - (await balanceOf(c.publicClient, tokX, leg0Pool));
    assert.ok(inBalX > 0n, `[${engine}] leg0 produced intermediate X`);
    assert.equal(curveXIn, inBalX, `[${engine}] venue funded with the WHOLE realized X (wei)`);
    assert.equal(
      transferSumTo(receipt, tokX, curveDeep), inBalX,
      `[${engine}] Transfer log: venue received exactly the leg's realized X`,
    );
    assert.ok(curveBOut > 0n, `[${engine}] venue paid its tokenOut to self`);
    assert.ok(received > 0n, `[${engine}] caller received tokenOut through the venue leg`);
    assert.equal(quoted, received, `[${engine}] quoted amountOut == cooked amountOut (wei)`);
    // Happy path: the per-route intermediate sweep NO-OPS (no X dust back to the caller).
    assert.equal(
      await balanceOf(c.publicClient, tokX, caller), callerXBefore,
      `[${engine}] intermediate sweep no-ops on the happy path`,
    );

    console.log(
      `  [legQL venue-only OUTPUT:${engine}] venueX=${curveXIn} received=${received} quoted=${quoted} spent=${spent}`,
    );
  }

  // ── (5) PINNED EXAMPLE — leg A→X {UniV3 + Maverick}, leg X→B {Curve + WOOFi + Euler} ──
  async function runPinnedExample(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    // Probe-verified (see the fixture-size comment above): every member funds at this amount.
    const amountIn = parseEther("20000");

    const direct = await v3EcoPool(directPool, FEE_DIRECT, TS_DIRECT);
    const leg0 = await v3EcoPool(leg0Pool, FEE_LEG0, TS_LEG0);
    const mv = mavVenue(mavPool);
    const cv = curveVenue(curvePin, CURVE_PIN_BAL, CURVE_PIN_A, CURVE_PIN_FEE);
    const wv = wooVenue(wooPool);
    const ev = eulVenue(eulPool);

    const prepared: EcoSwapPrepared = {
      pools: [direct.pool],
      routes: [
        {
          legs: [
            { hopIn: tokA, hopOut: tokX, zeroForOne: true, pools: [leg0.pool], qlVenues: [mv.venue] },
            { hopIn: tokX, hopOut: tokB, zeroForOne: true, pools: [], qlVenues: [cv.venue, wv.venue, ev.venue] },
          ],
          intermediateTokens: [tokX],
        },
      ],
      brackets: [],
      zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
      expectedInputCovered: 0n,
    };

    // Both mirrors from the SAME models (global leg-venue order: mav g0, curve g1, woo g2,
    // euler g3 — routeIdx asc, legIdx asc, venue order).
    const ref = kwayReference(prepared, amountIn, undefined, [[[mv.olv], [cv.olv, wv.olv, ev.olv]]]);
    const optRoute: OptimalRoute = {
      legs: [
        { zeroForOne: true, pools: [leg0.opt], qlvs: [mv.olv] },
        { zeroForOne: true, pools: [], qlvs: [cv.olv, wv.olv, ev.olv] },
      ],
    };
    const opt = optimalSplit({
      pools: [direct.opt], routes: [optRoute], amountIn, zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
    });
    assert.equal(ref.totalInput, opt.totalInput, "reference total == oracle total (wei)");
    assert.equal(ref.perRouteInput[0], opt.perRouteInput[0], "route award == oracle (wei)");
    // The pinned shape only pins the exec dispatch if EVERY member funds — a zero here means
    // the fixtures drifted and the sizes must be RE-PROBED.
    assert.ok(ref.perPoolInput[0] > 0n, "direct pool funded");
    assert.ok(ref.perUniversePoolInput[1] > 0n, "leg0 V3 pool funded");
    for (let g = 0; g < 4; g++) assert.ok(ref.perLegQlvInput[g] > 0n, `leg venue g${g} funded`);

    const bytecodes = compilePrepared(engine, prepared, amountIn, caller);
    const quoted = await quoteViaStateOverride(engine, target, caller, bytecodes);

    const callerABefore = await balanceOf(c.publicClient, tokA, caller);
    const callerBBefore = await balanceOf(c.publicClient, tokB, caller);
    const callerXBefore = await balanceOf(c.publicClient, tokX, caller);
    const leg0XBefore = await balanceOf(c.publicClient, tokX, leg0Pool);
    const mavXBefore = await balanceOf(c.publicClient, tokX, mavPool);

    await approve(c.walletClient, c.publicClient, tokA, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "pinned-example cook() must succeed");

    const spent = callerABefore - (await balanceOf(c.publicClient, tokA, caller));
    const received = (await balanceOf(c.publicClient, tokB, caller)) - callerBBefore;
    assert.equal(spent, ref.totalInput, `[${engine}] spent == reference totalInput (wei)`);
    assert.ok(received > 0n, `[${engine}] caller received tokenOut`);
    assert.equal(quoted, received, `[${engine}] quoted amountOut == cooked amountOut (wei)`);

    // Leg0 (tokenIn side): inBal := lTotal ⇒ every member receives EXACTLY its computed award
    // (Transfer-log gated: self → member in tokA; the direct pool's inflow rides the same log).
    assert.equal(
      transferSumTo(receipt, tokA, leg0Pool), ref.perUniversePoolInput[1],
      `[${engine}] Transfer log: leg0 V3 pool received exactly its award`,
    );
    assert.equal(
      transferSumTo(receipt, tokA, mavPool), ref.perLegQlvInput[0],
      `[${engine}] Transfer log: Maverick venue received exactly its award (== qinp)`,
    );
    assert.equal(
      transferSumTo(receipt, tokA, directPool), ref.perPoolInput[0],
      `[${engine}] Transfer log: direct pool received exactly its award`,
    );

    // Leg1 (X side): the REALIZED X (leg0 pool + Maverick outflows) splits across the three
    // venues proportional to qinp, the last funded venue (Euler — venue order) absorbing the
    // dust — each inflow wei-exact and Transfer-log gated.
    const inBalX =
      (leg0XBefore - (await balanceOf(c.publicClient, tokX, leg0Pool))) +
      (mavXBefore - (await balanceOf(c.publicClient, tokX, mavPool)));
    assert.ok(inBalX > 0n, `[${engine}] leg0 members produced intermediate X`);
    const exp = expectedLegShares(
      inBalX, [], [ref.perLegQlvInput[1], ref.perLegQlvInput[2], ref.perLegQlvInput[3]],
    );
    assert.equal(
      transferSumTo(receipt, tokX, curvePin), exp.venues[0],
      `[${engine}] Transfer log: Curve venue X share == proportional award (wei)`,
    );
    assert.equal(
      transferSumTo(receipt, tokX, wooPool), exp.venues[1],
      `[${engine}] Transfer log: WOOFi venue X share == proportional award (wei)`,
    );
    assert.equal(
      transferSumTo(receipt, tokX, eulPool), exp.venues[2],
      `[${engine}] Transfer log: Euler venue X share == proportional award (wei)`,
    );
    // Every leg1 venue paid its out to self (B outflow > 0 — the exec actually swapped).
    assert.ok(transferSumTo(receipt, tokB, target) > 0n, `[${engine}] leg1 venues paid tokenOut to self`);
    // Happy path: the per-route intermediate sweep NO-OPS (no X dust back to the caller).
    assert.equal(
      await balanceOf(c.publicClient, tokX, caller), callerXBefore,
      `[${engine}] intermediate sweep no-ops on the happy path`,
    );

    console.log(
      `  [legQL pinned:${engine}] direct=${ref.perPoolInput[0]} leg0V3=${ref.perUniversePoolInput[1]} mav=${ref.perLegQlvInput[0]} curve=${exp.venues[0]} woo=${exp.venues[1]} euler=${exp.venues[2]} received=${received} (all members executed, wei)`,
    );
  }

  // ── (6) ADVERSE DRIFT on a leg QL venue — re-anchoring between arg-build and cook ──
  async function runLegVenueDrift(engine: Engine): Promise<void> {
    await resetPools();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;
    const amountIn = parseEther("100000"); // the mixed-leg shape (both leg1 members funded)

    // Arg-build against the PRE-drift state (descriptors are state-free; the V3 pools carry
    // windowTop=0 ⇒ fully live walks, so pre-drift args stay valid).
    const leg0 = await v3EcoPool(leg0Pool, FEE_LEG0, TS_LEG0);
    const leg1 = await v3EcoPool(leg1V3Pool, FEE_LEG1V3, TS_LEG1V3);
    const cv = curveVenue(curveSteep, CURVE_STEEP_BAL, CURVE_STEEP_A, CURVE_STEEP_FEE);
    const prepared: EcoSwapPrepared = {
      pools: [],
      routes: [
        {
          legs: [
            { hopIn: tokA, hopOut: tokX, zeroForOne: true, pools: [leg0.pool] },
            { hopIn: tokX, hopOut: tokB, zeroForOne: true, pools: [leg1.pool], qlVenues: [cv.venue] },
          ],
          intermediateTokens: [tokX],
        },
      ],
      brackets: [],
      zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
      expectedInputCovered: 0n,
    };
    // No-drift BASELINE mirror (what the venue would have been awarded on the pre-drift state).
    const refBase = kwayReference(prepared, amountIn, undefined, [[undefined, [cv.olv]]]);
    assert.ok(refBase.perLegQlvInput[0] > 0n, "baseline: venue funded pre-drift");
    const bytecodes = compilePrepared(engine, prepared, amountIn, caller);

    // REAL adverse drift: a third-party exchange sells 20000e18 X→B through the Curve fixture
    // (approve + exchange(0,1,dx,0) — the pool PULLS via transferFrom), so every later X→B
    // quote is worse. The cook below runs the PRE-drift bytecodes against this moved state.
    const driftDx = parseEther("20000");
    await approve(c.walletClient, c.publicClient, tokX, curveSteep, driftDx);
    await writeAndWait(c.walletClient, c.publicClient, {
      address: curveSteep, abi: curveAbi as Abi, functionName: "exchange",
      args: [0n, 1n, driftDx, 0n],
    });

    // DRIFTED mirrors: the venue model re-read from the LIVE (post-drift) pool balances —
    // exactly what the on-chain ladder build reads at cook (live get_dy).
    const balX = (await c.publicClient.readContract({
      address: curveSteep, abi: curveAbi as Abi, functionName: "balances", args: [0n],
    })) as bigint;
    const balB = (await c.publicClient.readContract({
      address: curveSteep, abi: curveAbi as Abi, functionName: "balances", args: [1n],
    })) as bigint;
    const cvDrift = curveVenue(curveSteep, [balX, balB], CURVE_STEEP_A, CURVE_STEEP_FEE);
    const refDrift = kwayReference(prepared, amountIn, undefined, [[undefined, [cvDrift.olv]]]);
    const optRoute: OptimalRoute = {
      legs: [
        { zeroForOne: true, pools: [leg0.opt] },
        { zeroForOne: true, pools: [leg1.opt], qlvs: [cvDrift.olv] },
      ],
    };
    const opt = optimalSplit({
      pools: [], routes: [optRoute], amountIn, zeroForOne: true,
      priceLimit: MIN_SQRT_RATIO + 1n,
    });
    assert.equal(refDrift.totalInput, opt.totalInput, "drifted reference total == drifted oracle (wei)");
    // RE-ANCHORING: the drifted venue's live ladder is WORSE, so its award SHRINKS vs the
    // baseline while the untouched sibling V3 pool's grows (the split adapts at cook time).
    assert.ok(
      refDrift.perLegQlvInput[0] < refBase.perLegQlvInput[0],
      "drifted venue award < no-drift baseline (adverse drift shrinks its share)",
    );
    assert.ok(
      refDrift.perUniversePoolInput[1] > refBase.perUniversePoolInput[1],
      "sibling leg1 V3 pool award grows under the venue's adverse drift",
    );

    const quoted = await quoteViaStateOverride(engine, target, caller, bytecodes);

    const callerABefore = await balanceOf(c.publicClient, tokA, caller);
    const callerBBefore = await balanceOf(c.publicClient, tokB, caller);
    const leg0ABefore = await balanceOf(c.publicClient, tokA, leg0Pool);
    const leg0XBefore = await balanceOf(c.publicClient, tokX, leg0Pool);
    const leg1XBefore = await balanceOf(c.publicClient, tokX, leg1V3Pool);
    const curveXBefore = await balanceOf(c.publicClient, tokX, curveSteep);

    await approve(c.walletClient, c.publicClient, tokA, target, amountIn);
    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "drift cook() must succeed");

    const spent = callerABefore - (await balanceOf(c.publicClient, tokA, caller));
    const received = (await balanceOf(c.publicClient, tokB, caller)) - callerBBefore;
    const leg0In = (await balanceOf(c.publicClient, tokA, leg0Pool)) - leg0ABefore;
    const leg1V3In = (await balanceOf(c.publicClient, tokX, leg1V3Pool)) - leg1XBefore;
    const curveXIn = (await balanceOf(c.publicClient, tokX, curveSteep)) - curveXBefore;

    // The cook RE-ANCHORED: awards == the mirrors run on the DRIFTED state (the pre-drift
    // bytecodes carry no venue state — the ladder was rebuilt on-chain from live get_dy).
    assert.equal(spent, refDrift.totalInput, `[${engine}] spent == DRIFTED reference totalInput (wei)`);
    assert.equal(leg0In, refDrift.perUniversePoolInput[0], `[${engine}] leg0 award == drifted reference (wei)`);
    const inBalX = leg0XBefore - (await balanceOf(c.publicClient, tokX, leg0Pool));
    const exp = expectedLegShares(inBalX, [refDrift.perUniversePoolInput[1]], [refDrift.perLegQlvInput[0]]);
    assert.equal(leg1V3In, exp.pools[0], `[${engine}] leg1 V3 X share == drifted proportional award (wei)`);
    assert.equal(curveXIn, exp.venues[0], `[${engine}] drifted venue X share == drifted proportional award (wei)`);
    assert.equal(quoted, received, `[${engine}] quoted amountOut == cooked amountOut (post-drift state, wei)`);

    console.log(
      `  [legQL drift:${engine}] venueX ${refBase.perLegQlvInput[0]}→${curveXIn} leg1V3X=${leg1V3In} spent=${spent} (re-anchored to the drifted ladder, wei)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`venue-only leg [${engine}] — Curve QL leg member, merge awards == mirrors wei-exact`, { skip }, async () => {
      await runVenueOnlyLeg(engine);
    });
    it(`mixed pool+venue leg [${engine}] — split INSIDE the leg, X-side exec split wei-exact`, { skip }, async () => {
      await runMixedLeg(engine);
    });
    it(`mixed leg slice-clamp [${engine}] — budget clamp lands ON the slice (routePartialN arm)`, { skip }, async () => {
      await runMixedSliceClamp(engine);
    });
    it(`dead upstream (hF==0) [${engine}] — venue contributes zero; state-override quote == cook`, { skip }, async () => {
      await runDeadUpstream(engine);
    });
    it(`venue-only leg OUTPUT [${engine}] — venue executes its share; quote == cook`, { skip }, async () => {
      await runVenueOnlyOutput(engine);
    });
    it(`pinned example [${engine}] — {V3+Maverick} → {Curve+WOOFi+Euler}: every member executes, wei-exact`, { skip }, async () => {
      await runPinnedExample(engine);
    });
    it(`leg venue adverse drift [${engine}] — cook re-anchors to the drifted live ladder`, { skip }, async () => {
      await runLegVenueDrift(engine);
    });
  }
});
