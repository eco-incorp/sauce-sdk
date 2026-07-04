/**
 * EcoSwap Curve CryptoSwap (twocrypto/tricrypto-ng v2.1.0d) QUOTE-LADDER (QL) local-EVM integration —
 * the callback-free live-walk gate.
 *
 * CryptoSwap is the SECOND venue migrated to the QUOTE-LADDER framework (the direct adapter-reuse proof
 * after the Curve StableSwap pilot): prepare ships ONLY a descriptor (poolAddr, uint256 coin indices
 * i/j, fee) — NO off-chain sampled segments — and the on-chain solver BUILDS each CryptoSwap venue's
 * price ladder in setup from LIVE cook-time `get_dy(uint256,uint256,uint256)` (probe-then-decode, the
 * SAME generalized qlv loop the Curve pilot uses, dispatched on the descriptor segKind), emits the
 * slices into the merged sampled-segment stream, bounded-insertion-SORTs it DESC, and the SAME
 * bestKind===1 cursor consumes it. Execution is unchanged (callback-free: on-chain get_dy for min_dy +
 * approve + exchange(uint256 i, uint256 j, Σ, min_dy) — Curve exchange PULLS via transferFrom, and
 * crypto pools use UINT256 coin indices the engine's int128 _swapCurve does NOT match, so it MUST run
 * callback-free, NOT through the engine). This test stands up local CryptoSwapPool.sol fixtures (whose
 * fx/boom STABLESWAP get_y/newton_D invariant + raw-product xp scaling + v2.1.0d post-swap-xp dynamic
 * fee mirror the off-chain cryptoswap-math.ts replay bit-for-bit) + a real V3 pool + a Curve StableSwap
 * fixture, and asserts:
 *
 *   (1) SOLO QL CryptoSwap — the on-chain ladder is built from live get_dy, covers [0, amountIn], and the
 *       caller-received dy == off-chain getDyCrypto(awarded share) == the pool's own on-chain get_dy view,
 *       all to the WEI. NO tolerance.
 *   (2) QL CryptoSwap + a live V3 direct pool — the QL sampled-segment stream (bestKind 1) competes against
 *       the live V3 frontier (bestKind 3) in ONE merge; the per-venue split == the neutral oracle to the
 *       WEI (CryptoSwap via buildCryptoSwapQLLadder, V3 via v3Segments), both venues funded.
 *   (3) QL Curve + QL CryptoSwap — TWO QL venues of DIFFERENT segKind (1 + 9) ride ONE qlv; the generalized
 *       ladder loop builds BOTH on-chain (dispatching the quote per-row on segKind) and INTERLEAVES them in
 *       the merged-stream sort; each leg received == its own get_dy(share) to the wei, split == oracle.
 *   (4) ZERO-CACHE QUOTE — a read-only cook (eth_call) builds the ladder LIVE with NO prepared segments
 *       (only the descriptor) and returns the quote == get_dy(amountIn). Proves the QL quote is prepare-optional.
 *   (5) ADVERSE DRIFT — move the CryptoSwap pool's price with a REAL exchange BEFORE cooking; the QL ladder
 *       re-anchors to the drifted curve at cook time (the CryptoSwap↔V3 split ADAPTS — the drifted crypto
 *       share SHRINKS, V3's grows) and lands the DRIFTED oracle's split to the wei.
 *
 * No fork / no RPC env — local fixtures etch the whole stack. Runs on v1 (+ v12 when the v12 artifacts are
 * present), driven by ECO_ENGINE. Each cell runs on its OWN fresh anvil (a cooked exchange moves the pool
 * price, so cells must not share pool state). Mirrors ecoswap.curve.evm.test.ts.
 *
 * Run: pnpm --filter './sdk' test:recipes:evm   (or npx tsx --test this file)
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEther, encodeFunctionData, decodeFunctionResult, parseAbi, type Abi, type Account, type Hex } from "viem";

import { startAnvil, type AnvilHandle } from "./harness/anvil";
import { makeClients, type HarnessClients } from "./harness/clients";
import { compileSauce, ECOSWAP_DIR } from "./harness/compile";
import { cook } from "./harness/cook";
import {
  ensureMulticall3,
  deployStack,
  deploySortedTokens,
  createAndInitPool,
  mintPosition,
  getSlot0,
  getLiquidity,
  mint,
  approve,
  balanceOf,
  deployCurveStableSwap,
  curveAbi,
  deployCryptoSwapPool,
  cryptoSwapAbi,
  SQRT_PRICE_1_1,
  type DeployedStack,
  type DeployedV12Stack,
} from "./harness/setup";
import { type Engine, engineCells, maybeDeployV12Stack, cookTarget } from "./harness/engine";
import { MIN_SQRT_RATIO } from "../shared/constants";
import { getSqrtRatioAtTick } from "./ecoswap.math";
import { optimalSplit, type OptimalPool } from "./ecoswap.optimal";
import { getDy, type CurvePool } from "../shared/curve-math";
import {
  getDyCrypto,
  newtonD as cryptoNewtonD,
  buildCryptoSwapQLLadder,
  type CryptoSwapPool,
} from "../shared/cryptoswap-math";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOLVER = join(ECOSWAP_DIR, "ecoswap.sauce.ts");

const HUGE = parseEther("1000000000");
const E18 = 10n ** 18n;
const ENGINE_CELLS = engineCells();

// fx/boom Twocrypto v2.1.0d params (mirror the mainnet crvUSD/WETH capture — see the prod-mirror test).
// A = the pool A() (the math _amp; Ann = A·N inside); gamma stored for ABI parity (IGNORED by the fx
// math); fee mid 0.05% / out 0.4% / fee_gamma 0.23 (1e10 fee units); price_scale 1:1.
const ANN = 25_000n;
const GAMMA = 145_000_000_000_000n;
const MID = 5_000_000n;
const OUT = 40_000_000n;
const FEE_GAMMA = 230_000_000_000_000_000n;
const PRICE_SCALE = E18;

// CryptoSwap-only treeshake defines (HAS_CRYPTO lights the on-chain QL ladder build's crypto quote branch
// + the segKind-9 accumulator + the callback-free exec; the live V3 frontier + merge core are unguarded
// (always on) so a mixed Crypto+V3 universe still walks V3 with HAS_CRYPTO alone). Mirrors index.ts.
const CRYPTO_DEFINES: Record<string, boolean> = {
  HAS_V2: false, HAS_V3: false, HAS_V4: false, HAS_KYBER: false, HAS_ROUTES: false,
  HAS_CURVE: false, HAS_LB: false, HAS_DODO: false, HAS_SOLIDLY_STABLE: false, HAS_WOMBAT: false,
  HAS_BALANCER: false, HAS_EULER: false, HAS_MAVERICK: false, HAS_CRYPTO: true, HAS_WOOFI: false,
  HAS_FERMI: false, HAS_FLUID: false, HAS_MENTO: false, HAS_BALANCER_V3: false,
};

// Curve + CryptoSwap treeshake defines — BOTH QL adapter branches ship so the generalized qlv loop builds
// both a segKind-1 (StableSwap) and a segKind-9 (CryptoSwap) ladder in one pass. This is the real production
// define set index.ts would emit for a Curve+CryptoSwap universe.
const CURVE_CRYPTO_DEFINES: Record<string, boolean> = {
  ...CRYPTO_DEFINES,
  HAS_CURVE: true,
  HAS_CRYPTO: true,
};

// The solver's 6 compiler args (index.ts order): cfg, pools, netCache, routing, segs, qlv.
//   cfg = [tokenIn, tokenOut, amountIn, caller, priceLimit, directCount]
//   qlv = the QUOTE-LADDER venue descriptors [poolAddr, i, j, feePpm, segKind, refIdx] — NO sampled
//         values; the solver builds each ladder ON-CHAIN from live get_dy. segs = [] (no static venues).
function args(
  tokenIn: Hex,
  tokenOut: Hex,
  amountIn: bigint,
  caller: Hex,
  directCount: number,
  pools: bigint[][],
  qlv: bigint[][],
): unknown[] {
  return [
    [BigInt(tokenIn), BigInt(tokenOut), amountIn, BigInt(caller), MIN_SQRT_RATIO + 1n, BigInt(directCount)],
    pools,
    [], // netCache — V3 pool tuples use windowTop=0 (live ticks() staticcall), no cache
    [], // routing
    [], // segs — no static (non-QL) sampled venues in this universe
    qlv,
  ];
}

// One QL CryptoSwap descriptor: [poolAddr, i, j, feePpm, segKind=9, refIdx]. i/j are UINT256 coin indices
// (0/1 for the local fixture); feePpm is informational (a CryptoSwap get_dy is post-fee — the on-chain
// head needs no fee-adjust — so the descriptor's fee field is never read by the qlv loop).
function cryptoDescriptor(pool: Hex, refIdx: number): bigint[] {
  return [BigInt(pool), 0n, 1n, 5n, 9n, BigInt(refIdx)];
}

// One QL Curve StableSwap descriptor: [poolAddr, i, j, feePpm10, segKind=1, refIdx].
function curveDescriptor(pool: Hex, refIdx: number, feePpm10: bigint): bigint[] {
  return [BigInt(pool), 0n, 1n, feePpm10, 1n, BigInt(refIdx)];
}

// A live V3 direct-pool tuple with windowTop=0 (no cache ⇒ the solver staticcalls ticks() for every
// boundary from the live spot). A single wide V3 position ⇒ constant active L over the walk region, so
// the live walk matches the oracle's v3Segments (empty net map) bit-for-bit. Mirrors index.ts buildPoolTuple.
function v3PoolTuple(pool: Hex, feePpm: number, tickSpacing: number, inIsToken0: boolean): bigint[] {
  return [
    1n, // poolType = UniV3
    BigInt(pool),
    BigInt(feePpm),
    BigInt(tickSpacing),
    0n, // hooks
    BigInt(feePpm),
    0n, // isV2
    inIsToken0 ? 1n : 0n,
    0n, // stateView (V4 only)
    0n, // poolId (V4 only)
    getSqrtRatioAtTick(tickSpacing), // stepRatio
    0n, // windowTopShifted = 0 ⇒ staticcall every boundary (live walk, no cache)
    0n, // windowBotShifted
    0n, // extremeShifted
    0n, // netStart
    0n, // netCount
    0n, // isKyber
  ];
}

describe("EcoSwap Curve CryptoSwap QL live-walk (local fixture) — on-chain ladder, exact-in-dy", () => {
  let anvil: AnvilHandle;
  let c: HarnessClients;
  let stack: DeployedStack;
  let v12: DeployedV12Stack | null = null;
  let tokenIn: Hex; // == coin0 (lower address)
  let tokenOut: Hex; // == coin1
  let solverSrc: string;

  async function setup(): Promise<void> {
    anvil?.stop();
    anvil = await startAnvil();
    c = await makeClients(anvil.rpcUrl);
    await ensureMulticall3(c.publicClient, c.testClient);
    stack = await deployStack(c.walletClient, c.publicClient);
    const tk = await deploySortedTokens(c.walletClient, c.publicClient);
    tokenIn = tk.token0;
    tokenOut = tk.token1;
    solverSrc = readFileSync(SOLVER, "utf-8");
    await mint(c.walletClient, c.publicClient, tokenIn, c.account0, parseEther("500000000"));
    await mint(c.walletClient, c.publicClient, tokenOut, c.account0, parseEther("500000000"));
    await approve(c.walletClient, c.publicClient, tokenIn, stack.helper, HUGE);
    await approve(c.walletClient, c.publicClient, tokenOut, stack.helper, HUGE);
    v12 = await maybeDeployV12Stack(c, c.walletClient.account as Account);
  }

  before(setup);
  after(() => {
    anvil?.stop();
  });

  // Off-chain CryptoSwapPool descriptor for a deployed fixture (tokenIn = coin0, tokenOut = coin1). The
  // fixture recomputes D = newtonD(_xp()) in its ctor AND after each exchange, so recomputing D from the
  // (live) balances here matches the fixture's D() to the wei — for both the fresh and the drifted state.
  function offCryptoPool(address: Hex, bal0: bigint, bal1: bigint): CryptoSwapPool {
    const xp = [bal0, (bal1 * PRICE_SCALE) / E18];
    return {
      address, i: 0, j: 1, A: ANN, gamma: GAMMA, priceScale: PRICE_SCALE, D: cryptoNewtonD(ANN, GAMMA, xp),
      balances: [bal0, bal1], precisions: [1n, 1n], midFee: MID, outFee: OUT, feeGamma: FEE_GAMMA,
      feePpm: 5, source: "local-fixture",
    };
  }

  function offCurvePool(address: Hex, balances: bigint[], a: bigint, fee: bigint): CurvePool {
    return { poolType: 3, address, i: 0, j: 1, A: a, aPrecision: 100n, balances, rates: [E18, E18], feePpm10: fee, source: "local-fixture" };
  }

  // ── (1) SOLO QL CryptoSwap — the on-chain ladder is built live; received == getDyCrypto(share) to the WEI ──
  async function runSolo(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const bal = 1_000_000n * E18;
    const pool = await deployCryptoSwapPool(
      c.walletClient, c.publicClient, [tokenIn, tokenOut], [1n, 1n],
      ANN, GAMMA, PRICE_SCALE, [bal, bal], MID, OUT, FEE_GAMMA, caller,
    );
    const op = offCryptoPool(pool, bal, bal);

    const amountIn = 100_000n * E18;
    // The off-chain QL ladder (buildCryptoSwapQLLadder) — the SAME ladder the solver builds on-chain from
    // live get_dy — must cover [0, amountIn] so the solo venue absorbs the whole trade.
    const ladder = buildCryptoSwapQLLadder(op, amountIn);
    assert.ok(ladder.length > 0, "non-empty QL ladder");
    assert.equal(ladder.reduce((a, s) => a + s.capacity, 0n), amountIn, "QL ladder covers the full amountIn");

    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [cryptoDescriptor(pool, 0)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: CRYPTO_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const poolInBefore = await balanceOf(c.publicClient, tokenIn, pool);

    // The fixture's own on-chain get_dy view on the PRE-swap state — the engine-independent ground truth
    // for the executed dy of `amountIn` (coin0 → coin1 ⇒ i=0, j=1).
    const onViewPre = (await c.publicClient.readContract({
      address: pool, abi: cryptoSwapAbi, functionName: "get_dy", args: [0n, 1n, amountIn],
    })) as bigint;

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "solo QL CryptoSwap cook() must succeed");

    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;
    const poolIn = (await balanceOf(c.publicClient, tokenIn, pool)) - poolInBefore;

    assert.equal(spent, amountIn, "spent == amountIn (whole trade routed to the QL CryptoSwap venue)");
    assert.equal(poolIn, amountIn, "the CryptoSwap pool pulled the full input share (exchange PULLS)");
    // WEI-EXACT-IN-DY: received == off-chain getDyCrypto(share) == the pool's own get_dy view.
    assert.equal(received, getDyCrypto(op, spent), "received == getDyCrypto(share) to the wei (exact-in-dy)");
    assert.equal(received, onViewPre, "received == on-chain get_dy view (exact-in-dy)");
    assert.ok(received > 0n, "non-zero CryptoSwap fill through the callback-free exchange path");
    // RESIDUE SWEEP (the Metric USDT-class lesson): CryptoSwap's exchange pulls EXACTLY dx via
    // transferFrom (verified vyper source) — pull == approve, so no allowance residue survives on the
    // shared cooking contract (a residue would brick later cooks on nonzero→nonzero-revert tokens).
    const residue = (await c.publicClient.readContract({
      address: tokenIn, abi: parseAbi(["function allowance(address, address) view returns (uint256)"]) as Abi,
      functionName: "allowance", args: [target, pool],
    })) as bigint;
    assert.equal(residue, 0n, "no CryptoSwap pool allowance residue (pull == approve)");

    console.log(
      `  [QL CryptoSwap solo:${engine}] slices=${ladder.length} spent=${spent} received=${received} ` +
        `(== getDyCrypto == get_dy to the wei); cook gasUsed=${receipt.gasUsed}`,
    );
  }

  // ── (2) QL CryptoSwap + a live V3 direct pool — bestKind 1 vs 3 in ONE merge; split == oracle wei-exact ──
  async function runCryptoV3(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A SHALLOW-ish CryptoSwap (500k/side, lower 0.05% mid fee ⇒ draws FIRST) vs a DEEP 1:1 V3 pool
    // (fee 0.3%, ts 60, ONE wide position ⇒ constant L). The crypto curve BENDS below the deep V3's
    // post-fee marginal within the trade, so the two marginal curves CROSS inside [0, amountIn] and BOTH
    // venues receive input.
    const cbal = 500_000n * E18;
    const pool = await deployCryptoSwapPool(
      c.walletClient, c.publicClient, [tokenIn, tokenOut], [1n, 1n],
      ANN, GAMMA, PRICE_SCALE, [cbal, cbal], MID, OUT, FEE_GAMMA, caller,
    );
    const op = offCryptoPool(pool, cbal, cbal);

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);
    assert.ok(liquidity > 0n, "V3 pool has active liquidity");

    const amountIn = 300_000n * E18;
    // Neutral oracle: pool[0] = live V3 (empty net ⇒ constant-L walk), pool[1] = QL CryptoSwap.
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const oracle = optimalSplit({
      pools: [v3Opt, { cryptoSwap: op, feePpm: 0 }],
      amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n,
    });
    const oV3 = oracle.perPoolInput[0] ?? 0n;
    const oCrypto = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oV3 > 0n && oCrypto > 0n, `oracle splits across V3 + CryptoSwap (V3 ${oV3}, Crypto ${oCrypto})`);

    // Universe: ONE direct V3 pool (directCount=1) + ONE QL CryptoSwap venue (qlv).
    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [cryptoDescriptor(pool, 0)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: CRYPTO_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const cryptoInBefore = await balanceOf(c.publicClient, tokenIn, pool);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "CryptoSwap+V3 cook() must succeed");

    const cryptoIn = (await balanceOf(c.publicClient, tokenIn, pool)) - cryptoInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(cryptoIn > 0n && v3In > 0n, `both venues funded (Crypto ${cryptoIn}, V3 ${v3In})`);
    // WEI-EXACT SPLIT vs the neutral oracle: the QL CryptoSwap stream (bestKind 1) and the live V3 frontier
    // (bestKind 3) competed in ONE merge and landed the IDENTICAL per-venue inputs the oracle computed.
    assert.equal(v3In, oV3, "V3 awarded input == oracle (wei-exact split)");
    assert.equal(cryptoIn, oCrypto, "CryptoSwap awarded input == oracle (wei-exact split)");
    assert.equal(spent, oracle.totalInput, "spent == oracle totalInput (wei-exact)");
    assert.ok(received > 0n, "caller receives tokenOut");

    console.log(`  [QL CryptoSwap+V3:${engine}] V3 in=${v3In} Crypto in=${cryptoIn} spent=${spent} received=${received} (split == oracle wei-exact)`);
  }

  // ── (3) QL Curve + QL CryptoSwap — TWO QL venues of DIFFERENT segKind (1 + 9) in ONE qlv; the
  // generalized loop builds both + INTERLEAVES them in the sort; per-leg exact-in-dy; split == oracle. ──
  async function runCurveCrypto(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    // A SHALLOW steep Curve (low A, 0.03% fee ⇒ draws FIRST but bends fast) vs a DEEP CryptoSwap (1M/side,
    // 0.05% mid fee ⇒ flatter). The two marginal curves CROSS inside the trade, so BOTH QL venues (segKind
    // 1 + 9) receive input and their on-chain-built ladders INTERLEAVE in the merged-stream DESC sort.
    const curveBal = [150_000n * E18, 150_000n * E18];
    const CURVE_A = 20n, CURVE_FEE = 3_000_000n; // 0.03% (1e10-scaled), steep low-A curve
    const curve = await deployCurveStableSwap(c.walletClient, c.publicClient, [tokenIn, tokenOut], curveBal, [E18, E18], CURVE_A, CURVE_FEE, caller);
    const opCurve = offCurvePool(curve, curveBal, CURVE_A, CURVE_FEE);

    const cbal = 1_000_000n * E18;
    const crypto = await deployCryptoSwapPool(
      c.walletClient, c.publicClient, [tokenIn, tokenOut], [1n, 1n],
      ANN, GAMMA, PRICE_SCALE, [cbal, cbal], MID, OUT, FEE_GAMMA, caller,
    );
    const opCrypto = offCryptoPool(crypto, cbal, cbal);

    const amountIn = 300_000n * E18;
    // Neutral oracle: pool[0] = QL Curve (buildCurveQLLadder), pool[1] = QL CryptoSwap (buildCryptoSwapQLLadder).
    const oracle = optimalSplit({ pools: [{ curve: opCurve, feePpm: 0 }, { cryptoSwap: opCrypto, feePpm: 0 }], amountIn, zeroForOne: true });
    const oCurve = oracle.perPoolInput[0] ?? 0n;
    const oCrypto = oracle.perPoolInput[1] ?? 0n;
    assert.ok(oCurve > 0n && oCrypto > 0n, `oracle splits across QL Curve + QL CryptoSwap (Curve ${oCurve}, Crypto ${oCrypto})`);

    // ONE qlv carrying BOTH families: a segKind-1 Curve descriptor + a segKind-9 CryptoSwap descriptor.
    const qlv = [curveDescriptor(curve, 0, CURVE_FEE), cryptoDescriptor(crypto, 0)];
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: CURVE_CRYPTO_DEFINES },
    );

    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const curveInBefore = await balanceOf(c.publicClient, tokenIn, curve);
    const cryptoInBefore = await balanceOf(c.publicClient, tokenIn, crypto);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "QL Curve + QL CryptoSwap cook() must succeed");

    const curveIn = (await balanceOf(c.publicClient, tokenIn, curve)) - curveInBefore;
    const cryptoIn = (await balanceOf(c.publicClient, tokenIn, crypto)) - cryptoInBefore;
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(curveIn > 0n && cryptoIn > 0n, `both QL venues funded (Curve ${curveIn}, Crypto ${cryptoIn})`);
    // WEI-EXACT SPLIT: the generalized qlv loop built the segKind-1 (StableSwap) + segKind-9 (CryptoSwap)
    // ladders on-chain, interleaved them in the merged-stream sort, and landed the oracle's split to the WEI.
    assert.equal(curveIn, oCurve, "Curve awarded input == oracle (wei-exact split)");
    assert.equal(cryptoIn, oCrypto, "CryptoSwap awarded input == oracle (wei-exact split)");
    // PER-LEG WEI-EXACT-IN-DY: received == get_dy_Curve(curveIn) + getDyCrypto(cryptoIn). NO tolerance.
    assert.equal(received, getDy(opCurve, curveIn) + getDyCrypto(opCrypto, cryptoIn), "received == Σ per-venue get_dy(share) to the wei");

    console.log(
      `  [QL Curve+Crypto:${engine}] Curve in=${curveIn} Crypto in=${cryptoIn} received=${received} ` +
        `(two QL segKinds interleaved; split == oracle, dy wei-exact)`,
    );
  }

  // ── (4) ZERO-CACHE QUOTE — a read-only cook builds the ladder LIVE with NO prepared cache/segments. ──
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

  async function runZeroCacheQuote(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const bal = 1_000_000n * E18;
    const pool = await deployCryptoSwapPool(
      c.walletClient, c.publicClient, [tokenIn, tokenOut], [1n, 1n],
      ANN, GAMMA, PRICE_SCALE, [bal, bal], MID, OUT, FEE_GAMMA, caller,
    );
    const op = offCryptoPool(pool, bal, bal);

    const amountIn = 100_000n * E18;
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 0, [], [cryptoDescriptor(pool, 0)]),
      ECOSWAP_DIR, engine, { treeshake: true, defines: CRYPTO_DEFINES },
    );
    // Caller is funded + approved from setup, so a READ-ONLY cook (rolled back) runs the transferFrom +
    // the QL ladder build + the exchange, and returns the solver's tokenOut. NO prepared cache/segments —
    // the ladder is built from LIVE get_dy inside the eth_call (the zero-cache quote).
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const data = encodeFunctionData({ abi: cookCallAbi as Abi, functionName: "cook", args: [bytecodes] });
    const { data: ret } = await c.publicClient.call({ account: caller, to: target, data, gas: 2_000_000_000n });
    const quoted = decodeCookUint(ret as Hex, engine);

    assert.equal(quoted, getDyCrypto(op, amountIn), "zero-cache QUOTE == getDyCrypto(amountIn) to the wei (ladder built live in the eth_call)");
    console.log(`  [QL CryptoSwap zero-cache quote:${engine}] quoted=${quoted} (== getDyCrypto(amountIn), no prepared cache)`);
  }

  // ── (5) ADVERSE DRIFT — move the CryptoSwap pool's price with a REAL exchange BEFORE cooking. Because
  // the QL ladder is built from LIVE get_dy at cook time (no baked snapshot), it RE-ANCHORS to the drifted
  // curve: the Crypto↔V3 split ADAPTS (the drifted crypto share SHRINKS, V3's grows) and the output tracks
  // the LIVE curve — the proof that QL live-walks. ──
  async function runAdverseDriftSplit(engine: Engine): Promise<void> {
    await setup();
    const target = cookTarget(engine, stack, v12);
    const caller = c.account0;

    const cbal = 500_000n * E18;
    const crypto = await deployCryptoSwapPool(
      c.walletClient, c.publicClient, [tokenIn, tokenOut], [1n, 1n],
      ANN, GAMMA, PRICE_SCALE, [cbal, cbal], MID, OUT, FEE_GAMMA, caller,
    );

    const V3_FEE = 3000, V3_TS = 60;
    const v3 = await createAndInitPool(c.walletClient, c.publicClient, stack.factory, tokenIn, tokenOut, V3_FEE, SQRT_PRICE_1_1);
    await mintPosition(c.walletClient, c.publicClient, stack.helper, v3, caller, -60000, 60000, parseEther("3000000"));
    const { sqrtPriceX96, tick } = await getSlot0(c.publicClient, v3);
    const liquidity = await getLiquidity(c.publicClient, v3);

    const amountIn = 300_000n * E18;
    const pools = [v3PoolTuple(v3, V3_FEE, V3_TS, true)];
    const qlv = [cryptoDescriptor(crypto, 0)];
    // Bytecode built against the PRE-drift universe — the descriptor carries NO pool prices, so the SAME
    // bytecode is cooked after drift; only the LIVE get_dy the ladder reads changes.
    const { bytecodes } = compileSauce(
      solverSrc, args(tokenIn, tokenOut, amountIn, caller, 1, pools, qlv),
      ECOSWAP_DIR, engine, { treeshake: true, defines: CRYPTO_DEFINES },
    );

    // Baseline (NO drift) oracle split — the crypto share the un-drifted universe would award.
    const v3Opt: OptimalPool = { isV2: false, feePpm: V3_FEE, sqrtPriceX96, tick, tickSpacing: V3_TS, liquidity, net: new Map() };
    const opPre = offCryptoPool(crypto, cbal, cbal);
    const oraclePre = optimalSplit({ pools: [v3Opt, { cryptoSwap: opPre, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const cryptoSharePre = oraclePre.perPoolInput[1] ?? 0n;
    assert.ok(cryptoSharePre > 0n, "baseline oracle awards the CryptoSwap venue a share");

    // ADVERSE DRIFT: a REAL coin0→coin1 exchange on the CryptoSwap pool imbalances it (more coin0, less
    // coin1) so subsequent coin0→coin1 swaps price WORSE — the crypto venue is now less attractive.
    const driftIn = 50_000n * E18;
    await approve(c.walletClient, c.publicClient, tokenIn, crypto, driftIn);
    await c.walletClient.writeContract({
      address: crypto, abi: cryptoSwapAbi as Abi, functionName: "exchange", args: [0n, 1n, driftIn, 0n],
      account: caller, chain: null,
    });
    // The DRIFTED oracle — rebuilt from the pool's live post-drift balances (the fixture recomputes D from
    // them, so offCryptoPool's recomputed D matches the pool's D() to the wei). The drifted crypto share
    // must SHRINK (adverse drift) and V3's must GROW.
    const b0 = (await c.publicClient.readContract({ address: crypto, abi: cryptoSwapAbi as Abi, functionName: "balances", args: [0n] })) as bigint;
    const b1 = (await c.publicClient.readContract({ address: crypto, abi: cryptoSwapAbi as Abi, functionName: "balances", args: [1n] })) as bigint;
    const opDrift = offCryptoPool(crypto, b0, b1);
    const oracleDrift = optimalSplit({ pools: [v3Opt, { cryptoSwap: opDrift, feePpm: 0 }], amountIn, zeroForOne: true, priceLimit: MIN_SQRT_RATIO + 1n });
    const cryptoShareDrift = oracleDrift.perPoolInput[1] ?? 0n;
    assert.ok(cryptoShareDrift > 0n, "drifted oracle still awards the CryptoSwap venue a (smaller) share");
    assert.ok(cryptoShareDrift < cryptoSharePre, `adverse drift shrinks the crypto share (${cryptoShareDrift} < ${cryptoSharePre})`);

    // Cook the PRE-drift bytecode against the DRIFTED pool. The QL ladder re-anchors to the live curve.
    await approve(c.walletClient, c.publicClient, tokenIn, target, amountIn);
    const outBefore = await balanceOf(c.publicClient, tokenOut, caller);
    const inBefore = await balanceOf(c.publicClient, tokenIn, caller);
    const cryptoInBefore = await balanceOf(c.publicClient, tokenIn, crypto);
    const v3InBefore = await balanceOf(c.publicClient, tokenIn, v3);

    const { receipt } = await cook(c.walletClient, c.publicClient, target, bytecodes);
    assert.equal(receipt.status, "success", "adverse-drift CryptoSwap+V3 cook() must succeed");

    const cryptoIn = (await balanceOf(c.publicClient, tokenIn, crypto)) - cryptoInBefore;
    const v3In = (await balanceOf(c.publicClient, tokenIn, v3)) - v3InBefore;
    const spent = inBefore - (await balanceOf(c.publicClient, tokenIn, caller));
    const received = (await balanceOf(c.publicClient, tokenOut, caller)) - outBefore;

    assert.ok(cryptoIn > 0n && v3In > 0n, "both venues funded post-drift");
    // RE-ANCHORED: the on-chain split matches the DRIFTED oracle (built from live post-drift state), NOT
    // the pre-drift baseline — the QL ladder walked the LIVE (drifted) curve.
    assert.equal(v3In, oracleDrift.perPoolInput[0] ?? 0n, "V3 awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(cryptoIn, cryptoShareDrift, "CryptoSwap awarded input == drifted oracle (re-anchored, wei-exact)");
    assert.equal(spent, oracleDrift.totalInput, "spent == drifted oracle totalInput (wei-exact)");
    assert.ok(cryptoIn < cryptoSharePre, `crypto share ADAPTED down after adverse drift (${cryptoIn} < baseline ${cryptoSharePre})`);

    console.log(
      `  [QL Crypto+V3 adverse-drift:${engine}] baseline crypto share=${cryptoSharePre} → drifted=${cryptoIn} ` +
        `(V3 grew to ${v3In}); received=${received} (split RE-ANCHORED to live drifted curve)`,
    );
  }

  for (const { engine, skip } of ENGINE_CELLS) {
    it(`QL CryptoSwap solo [${engine}] — on-chain ladder, received == getDyCrypto(share) wei-exact`, { skip }, async () => {
      await runSolo(engine);
    });
    it(`QL CryptoSwap + V3 [${engine}] — sampled stream vs live frontier, split == oracle wei-exact`, { skip }, async () => {
      await runCryptoV3(engine);
    });
    it(`QL Curve + QL CryptoSwap [${engine}] — two QL segKinds in one loop, interleave + split == oracle`, { skip }, async () => {
      await runCurveCrypto(engine);
    });
    it(`QL CryptoSwap zero-cache QUOTE [${engine}] — ladder built live in eth_call, no prepared cache`, { skip }, async () => {
      await runZeroCacheQuote(engine);
    });
    it(`QL CryptoSwap + V3 adverse-drift [${engine}] — split RE-ANCHORS to the live drifted curve`, { skip }, async () => {
      await runAdverseDriftSplit(engine);
    });
  }
});
