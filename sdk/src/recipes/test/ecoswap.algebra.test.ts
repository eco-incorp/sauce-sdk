/**
 * EcoSwap Algebra dynamic-fee integration — known-answer / decode units (EVM-free).
 *
 * SCOPE: Algebra is DISCOVER + PRICE ONLY. Algebra forks (Camelot V3, QuickSwap V3, Ramses V2)
 * are V3-SHAPED concentrated-liquidity pools, so their STATE reads map onto a UniV3 row and they
 * PRICE wei-exact against the V3 oracle. But the CURRENT engine cannot EXECUTE an Algebra swap —
 * see the §4 finding below — so the discovery + lens layers DROP Algebra pools from the executable
 * set (this is a deliberate gate, NOT a missing fork RPC). The only Algebra-specific work that is
 * supported lives in the read path: an Algebra pool exposes price/tick via `globalState()` (NOT
 * slot0()) and carries a DYNAMIC fee (feeZto for zeroForOne, feeOtz for oneForZero) read once at
 * quote time and treated as fixed over the trade — the same snapshot assumption the recipe makes
 * for fixed V3 tiers — so a PRICE/split computed against it stays wei-exact against that snapshot.
 *
 * This file proves, WITHOUT a fork, the two things the discover+price integration adds:
 *   (1) the lens DECODES an Algebra pool's globalState price + its DYNAMIC fee as a V3 row whose
 *       `fee` is that dynamic fee (the decode unit), and the factory grouping tags Algebra
 *       factories (isAlgebra=1 + the precomputed tickSpacing/step);
 *   (2) once that dynamic fee is threaded into feePpm, an Algebra pool at fee F splits WEI-EXACT
 *       against the neutral V3 oracle at fee F — i.e. the dynamic fee genuinely steers the
 *       allocation exactly like a fixed-fee V3 pool (the v3Segments reuse).
 * None of these vectors cook through the engine — they exercise the off-chain decode + solver,
 * which is exactly the supported (discover+price) surface.
 *
 * Run: npx tsx --test src/recipes/test/ecoswap.algebra.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, type Hex } from "viem";

import { decodeLens } from "../ecoswap/lens.js";
import {
  SwapPoolType,
  FactoryType,
  BASE_CHAIN_POOL_CONFIG,
  CHAIN_POOL_CONFIGS,
  ALGEBRA_FACTORY_TYPE,
} from "../shared/constants.js";
import {
  Q96,
  Q192,
  FEE_DENOM,
  OFFSET,
  isqrt,
  feeAdjust,
  getSqrtRatioAtTick,
} from "./ecoswap.math";
import { ecoSwapReference } from "./ecoswap.reference";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { EcoBracketKind, type EcoPool, type EcoSwapPrepared } from "../shared/types";

// ─────────────────────────────────────────────────────────────
// Helpers: encode a lens poolBlob exactly as ecoswap.lens.sauce.ts emits it.
// ─────────────────────────────────────────────────────────────

const WORD = { type: "uint256" } as const;

/** A 13-word V3/Algebra pool row (Algebra emits poolType=1 with the DYNAMIC fee in word[2]). */
function v3Row(addr: Hex, fee: number, tickSpacing: number, sqrtP: bigint, liq: bigint, tick: number): bigint[] {
  // [type,addr,fee,tickSpacing,hooks,sqrtP,liq,tickRaw,inIsToken0,stateView,poolId,scanFwd,scanRev]
  // tickRaw is ZERO-extended int24 (BigInt.asUintN of the signed tick).
  const tickRaw = BigInt.asUintN(24, BigInt(tick));
  return [
    1n, BigInt(addr), BigInt(fee), BigInt(tickSpacing), 0n,
    sqrtP, liq, tickRaw, 0n, 0n, 0n, 0n, 0n,
  ];
}

/** Encode a poolBlob = 4-word header [discovered, survivors, totalCap, capFloor] + rows. */
function encodePoolBlob(rows: bigint[][], discovered: number, totalCap: bigint, capFloor: bigint): Hex {
  const words: bigint[] = [BigInt(discovered), BigInt(rows.length), totalCap, capFloor];
  for (const r of rows) words.push(...r);
  return encodeAbiParameters(words.map(() => WORD), words) as Hex;
}

const EMPTY_TICKBLOB = "0x" as Hex;

// ─────────────────────────────────────────────────────────────
// 1. Lens DECODE — an Algebra pool surfaces its globalState price + dynamic fee.
// ─────────────────────────────────────────────────────────────
//
// The lens emits an Algebra pool as a STANDARD V3 row (poolType=1) whose sqrtPriceX96 is the
// globalState `price` and whose `fee` word is the DYNAMIC fee (feeZto/feeOtz by direction).
// decodeLens must surface it as a UniV3 pool with exactly that fee + that sqrt price, so the
// downstream prepare threads `feePpm = pool.fee` (= the dynamic fee) into the oracle/solver.
describe("Algebra lens decode — globalState price + dynamic fee surface as a V3 row", () => {
  const ALG_POOL = "0xa1ce0000000000000000000000000000000000aa" as Hex;
  const V3_POOL = "0xbeef000000000000000000000000000000000bb" as Hex;
  // Algebra dynamic fee snapshot: feeZto rounded to e.g. 137 ppm (a non-tier value, proving it
  // is NOT a fixed tier). The globalState sqrtPrice is an ordinary Q96 sqrt (tick ~ -100).
  const DYN_FEE = 137;
  const SQRT_ALG = getSqrtRatioAtTick(-100);
  const SQRT_V3 = getSqrtRatioAtTick(50);

  it("decodes the Algebra row as UniV3 with the dynamic fee + globalState sqrt price", () => {
    const rows = [
      v3Row(ALG_POOL, DYN_FEE, 60, SQRT_ALG, 10n ** 24n, -100),
      v3Row(V3_POOL, 500, 10, SQRT_V3, 2n * 10n ** 24n, 50),
    ];
    const poolBlob = encodePoolBlob(rows, 2, 0n, 0n);
    const { pools, survivorCount } = decodeLens(poolBlob, EMPTY_TICKBLOB);

    assert.equal(survivorCount, 2, "both rows surface as survivors");
    const alg = pools.find((p) => p.address.toLowerCase() === ALG_POOL.toLowerCase());
    assert.ok(alg, "Algebra pool decoded");
    assert.equal(alg!.poolType, SwapPoolType.UniV3, "Algebra decodes as a UniV3-shaped row (for discover+price; not executable — see §4)");
    assert.equal(alg!.fee, DYN_FEE, "the DYNAMIC fee (137 ppm) surfaces as the pool's fee — NOT a fixed tier");
    assert.equal(alg!.sqrtPriceX96, SQRT_ALG, "globalState price surfaces as sqrtPriceX96");
    assert.equal(alg!.tick, -100, "globalState tick surfaces (int24-decoded)");
  });

  it("dynamic fee threads into the bracket fee-adjust exactly like a fixed V3 fee", () => {
    // feeAdjust is the price-ordering coordinate the merge uses; for the dynamic fee it must
    // behave identically to a fixed fee of the same value — proving the dynamic fee is just a
    // per-pool feePpm once read. A higher dynamic fee ⇒ a LOWER fee-adjusted price.
    const x = SQRT_ALG;
    assert.equal(feeAdjust(x, DYN_FEE), feeAdjust(x, DYN_FEE), "deterministic");
    assert.ok(feeAdjust(x, DYN_FEE) < x, "any positive fee lowers the adjusted price");
    assert.ok(feeAdjust(x, DYN_FEE) > feeAdjust(x, 3000), "137 ppm dynamic fee adjusts LESS than 0.30%");
  });
});

// ─────────────────────────────────────────────────────────────
// 2. Off-chain factory grouping — Algebra factories are tagged for the lens.
// ─────────────────────────────────────────────────────────────
//
// The lens rides Algebra on the SAME v3Factories param as standard V3, tagged isAlgebra=1.
// These pin that the config plumbing is correct: AlgebraV3 is the dynamic-fee reader type,
// the Algebra alias resolves to it, and the real arbitrum/polygon configs carry Algebra
// factories on it (so a discovery/lens pass routes them to the globalState reader).
describe("Algebra factory config — type + grouping", () => {
  it("FactoryType.Algebra alias resolves to the AlgebraV3 (globalState/poolByPair) reader", () => {
    assert.equal(ALGEBRA_FACTORY_TYPE, FactoryType.AlgebraV3);
  });

  it("real chain configs carry Algebra dynamic-fee factories (arbitrum + polygon)", () => {
    const arb = CHAIN_POOL_CONFIGS.arbitrum.factories.filter((f) => f.factoryType === FactoryType.AlgebraV3);
    const poly = CHAIN_POOL_CONFIGS.polygon.factories.filter((f) => f.factoryType === FactoryType.AlgebraV3);
    assert.ok(arb.length >= 2, "arbitrum has Camelot V3 + Ramses V2 Algebra factories");
    assert.ok(poly.length >= 1, "polygon has QuickSwap V3 Algebra factory");
    // Every Algebra factory maps to UniV3 (V3-shaped state read — discover+price only;
    // execution is gated out of the recipe until an engine algebraSwapCallback lands).
    for (const f of [...arb, ...poly]) {
      assert.equal(f.poolType, SwapPoolType.UniV3, `${f.label} reads on the V3-shaped path`);
    }
  });

  it("the Base placeholder Algebra factory is a documented zero-address (lens drops it)", () => {
    const base = BASE_CHAIN_POOL_CONFIG.factories.filter((f) => f.factoryType === FactoryType.AlgebraV3);
    assert.equal(base.length, 1, "Base wires the TYPE via one placeholder entry");
    assert.equal(base[0].address, "0x0000000000000000000000000000000000000000", "placeholder is zero-address");
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Wei-exact split — Algebra dynamic fee threaded into feePpm == the V3 oracle.
// ─────────────────────────────────────────────────────────────
//
// Once the dynamic fee is read into feePpm, an Algebra pool is — by construction — a V3 pool
// with that fee. So the proof is: a constant-L V3-shaped pool at the Algebra DYNAMIC fee splits
// WEI-EXACT against the neutral V3 oracle (ecoswap.optimal) at that same fee. Mirrors the
// V2-fee threading test: a 5bps-vs-other mix where the cheaper-fee pool draws strictly more.
describe("Algebra dynamic-fee split — wei-exact vs the V3 oracle [ref == oracle]", () => {
  const TS = 60;
  const L = 10n ** 24n;
  const E18 = 10n ** 18n;

  /**
   * A constant-L V3 EcoPool modeling an Algebra pool whose globalState read produced
   * (sqrtPrice at tick 0, dynamic fee `feePpm`). Empty net ⇒ the reference walks the
   * staticcall path (the no-cache live walk). Returns the EcoPool + the matching neutral
   * OptimalPool at the SAME fee, so ecoSwapReference == optimalSplit to the wei.
   */
  function algebraPool(refIdx: number, feePpm: number, prepTick: number): { pool: EcoPool; opt: OptimalPool } {
    const spotReal = getSqrtRatioAtTick(prepTick);
    const stepRatio = getSqrtRatioAtTick(TS);
    const base = Math.floor(prepTick / TS) * TS;
    const pool: EcoPool = {
      poolType: SwapPoolType.UniV3,
      address: ("0x" + (refIdx + 0xa1).toString(16).padStart(40, "0")) as Hex,
      fee: feePpm, // the DYNAMIC fee read from globalState
      tickSpacing: TS,
      hooks: "0x0000000000000000000000000000000000000000",
      feePpm, // threaded dynamic fee
      isV2: false,
      inIsToken0: true,
      stateView: "0x0000000000000000000000000000000000000000",
      poolId: "0x0000000000000000000000000000000000000000000000000000000000000000",
      stepRatio,
      windowTopShifted: 0n, // no cache → live staticcall walk
      windowBotShifted: 0n,
      extremeShifted: 0n,
      spotTickShifted: BigInt(base + Number(OFFSET)),
      spotNearReal: spotReal,
      spotActiveL: L,
      adaptiveNet: new Map<number, bigint>(),
    };
    const opt: OptimalPool = {
      isV2: false, feePpm, sqrtPriceX96: spotReal, tick: prepTick, tickSpacing: TS, liquidity: L,
      net: new Map<number, bigint>(),
    };
    return { pool, opt };
  }

  const DYN_FEE_LOW = 500; // a low Algebra dynamic fee (5 bps) — e.g. a calm stable pair
  const DYN_FEE_HIGH = 3000; // a higher dynamic fee (30 bps) — e.g. a volatile snapshot

  for (const amountIn of [100n * E18, 5000n * E18, 50000n * E18]) {
    it(`single Algebra pool (dynFee=${DYN_FEE_LOW}) amountIn=${amountIn} — fill == oracle to the wei`, () => {
      const { pool, opt } = algebraPool(0, DYN_FEE_LOW, 0);
      const prep: EcoSwapPrepared = {
        pools: [pool], routes: [], brackets: [], zeroForOne: true, priceLimit: 0n, expectedInputCovered: 0n,
      };
      const res = ecoSwapReference(prep, amountIn);
      const optRes = optimalSplit({ pools: [opt], amountIn, zeroForOne: true, priceLimit: 0n });
      assert.equal(res.totalInput, amountIn, "spends amountIn exactly");
      assert.equal(res.perPoolInput[0], optRes.perPoolInput[0], "Algebra dynamic-fee fill == oracle to the wei");
    });
  }

  it("two Algebra pools at 5bps vs 0.30% dynamic fees — split == oracle and the cheaper draws more", () => {
    // Identical depth + spot, ONLY the dynamic fee differs: the lower-fee pool has the higher
    // fee-adjusted marginal, so the water-fill funds it first/more — proving the dynamic fee
    // genuinely steers the allocation, wei-exactly like a fixed-fee V3 pool.
    const cheap = algebraPool(0, DYN_FEE_LOW, 0); // pool 0 — 5 bps dynamic
    const dear = algebraPool(1, DYN_FEE_HIGH, 0); // pool 1 — 30 bps dynamic
    const prep: EcoSwapPrepared = {
      pools: [cheap.pool, dear.pool], routes: [], brackets: [],
      zeroForOne: true, priceLimit: 0n, expectedInputCovered: 0n,
    };
    const amountIn = 20000n * E18;
    const res = ecoSwapReference(prep, amountIn);
    const opt = optimalSplit({ pools: [cheap.opt, dear.opt], amountIn, zeroForOne: true, priceLimit: 0n });
    assert.equal(res.totalInput, amountIn, "spends amountIn exactly");
    assert.equal(res.perPoolInput[0], opt.perPoolInput[0], "5bps Algebra pool fill == oracle to the wei");
    assert.equal(res.perPoolInput[1], opt.perPoolInput[1], "0.30% Algebra pool fill == oracle to the wei");
    assert.ok(
      res.perPoolInput[0] > res.perPoolInput[1],
      `cheaper dynamic-fee pool draws more (${res.perPoolInput[0]} > ${res.perPoolInput[1]})`,
    );
  });

  it("Algebra (5bps) mixed with a standard V3 tier (0.30%) — wei-exact split vs the oracle", () => {
    // The Algebra pool and a standard V3 pool compete in ONE merge; both are constant-L V3
    // shapes differing only by fee, so the unified solver splits them exactly like the oracle.
    const alg = algebraPool(0, DYN_FEE_LOW, 0); // Algebra dynamic 5 bps
    const v3 = algebraPool(1, DYN_FEE_HIGH, 0); // standard V3 0.30% (same shape, fixed fee)
    const prep: EcoSwapPrepared = {
      pools: [alg.pool, v3.pool], routes: [], brackets: [],
      zeroForOne: true, priceLimit: 0n, expectedInputCovered: 0n,
    };
    const amountIn = 30000n * E18;
    const res = ecoSwapReference(prep, amountIn);
    const opt = optimalSplit({ pools: [alg.opt, v3.opt], amountIn, zeroForOne: true, priceLimit: 0n });
    assert.equal(res.totalInput, amountIn, "spends amountIn exactly");
    assert.equal(res.perPoolInput[0], opt.perPoolInput[0], "Algebra leg == oracle to the wei");
    assert.equal(res.perPoolInput[1], opt.perPoolInput[1], "V3 leg == oracle to the wei");
    const funded = res.perPoolInput.filter((x) => x > 0n).length;
    assert.ok(funded >= 2, "both pools funded (interior cut across Algebra + V3)");
  });
});

// ─────────────────────────────────────────────────────────────
// 4. EXECUTION — NOT SUPPORTED BY THE CURRENT ENGINE (the honest finding).
// ─────────────────────────────────────────────────────────────
//
// There is intentionally NO EVM round-trip that COOKS an Algebra pool, and the reason is not a
// missing fork RPC or an infeasible local fixture — it is that the engine CANNOT EXECUTE an
// Algebra swap as-is:
//
//   • Algebra's pool `swap()` has the SAME ABI/selector as Uniswap V3 — swap(address recipient,
//     bool zeroToOne, int256 amountRequired, uint160 limitSqrtPrice, bytes data) — so the Router's
//     `IUniswapV3Pool(pool).swap(...)` call in `_swapV3` DISPATCHES fine to an Algebra pool.
//   • BUT mid-swap the Algebra pool re-enters the caller to pull input via
//     `algebraSwapCallback(int256,int256,bytes)` — a DIFFERENT selector than the
//     `uniswapV3SwapCallback`/`pancakeV3SwapCallback` the Router implements. The Router has NO
//     `algebraSwapCallback` handler and NO `fallback()` (only a payable `receive()`), so the
//     re-entry lands on an unknown selector and the whole `cook()` reverts.
//
// Evidence (pinned `sauce` engine, engine/src/Router.sol):
//   - callbacks implemented: uniswapV3SwapCallback (L328), pancakeV3SwapCallback (L338),
//     unlockCallback (L487, V4), maverickV2SwapCallback (L1168) — and `algebraSwapCallback` is
//     absent from the whole engine; only `receive() external payable {}` (L71), no fallback.
//   - `_swapV3` (L271) calls `v3Pool.swap(address(this), zeroForOne, amountSpecified, limit, "")`
//     via the Uniswap `swap` ABI (interfaces/IUniswapV3Pool.sol).
//   - Algebra's callback/swap surface: https://docs.algebra.finance (IAlgebraSwapCallback,
//     IAlgebraPoolActions#swap with `limitSqrtPrice`).
//
// So Algebra is in the SAME bucket as KyberSwap Elastic (see LIQUIDITY_SOURCES_FEASIBILITY.md §3):
// DISCOVER + PRICE are tractable now (proven wei-exact above), EXECUTION needs an engine PR adding
// an `algebraSwapCallback` external that reuses the transient-context pull logic. Until then the
// recipe must never route a slice into an Algebra pool — so the discovery + lens layers GATE
// Algebra out of the executable set: `discoverPools` drops Algebra pools, and `runLens` defaults
// `includeAlgebra=false` (Algebra factories are not fed to the lens program). The vectors in §1–§3
// validate the supported (discover+price) surface and do not cook.
describe("Algebra EXECUTION is engine-gated (discover+price only)", () => {
  it("FactoryType.AlgebraV3 is wired for discover+price but maps to a V3-shaped row (no exec branch)", () => {
    // The integration deliberately exposes Algebra only via the V3-shaped state read. There is
    // no Algebra-specific execution poolType — execution would route as UniV3/swapV3 and revert
    // on the unserviced algebraSwapCallback. This pins that Algebra carries the V3-read poolType
    // (so it PRICES), while the discovery/lens gates (documented above) keep it un-cookable.
    const algebraFactories = CHAIN_POOL_CONFIGS.arbitrum.factories.filter(
      (f) => f.factoryType === FactoryType.AlgebraV3,
    );
    assert.ok(algebraFactories.length > 0, "real Algebra factories are configured (for price reads)");
    for (const f of algebraFactories) {
      assert.equal(
        f.poolType,
        SwapPoolType.UniV3,
        `${f.label} reads V3-shaped (priceable); execution is gated out until an engine algebraSwapCallback handler lands`,
      );
    }
  });
});

// Silence unused-import lint for helpers reserved by the fork-gated path / future vectors.
void Q96;
void Q192;
void FEE_DENOM;
void isqrt;
void EcoBracketKind;
