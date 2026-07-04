import { IUniswapV3Factory } from "./IUniswapV3Factory.json";
import { IUniswapV2Factory } from "./IUniswapV2Factory.json";
import { IUniswapV3PoolFull } from "./IUniswapV3PoolFull.json";
import { IUniswapV2Pair } from "./IUniswapV2Pair.json";
import { IStateViewFull } from "./IStateViewFull.json";
import { IAlgebraFactory } from "./IAlgebraFactory.json";
import { IAlgebraPool } from "./IAlgebraPool.json";
import { ISlipstreamCLFactory } from "./ISlipstreamCLFactory.json";

// EcoSwap on-chain PREPARE LENS (v2, LAZY / dynamic tick reading).
//
// A single read-only main() invoked via ONE eth_call cook(). It discovers every
// direct V2/V3/V4 pool for (tokenIn, tokenOut), reads each pool's LIVE state
// (slot0/getReserves/StateView), and reads ONLY the ticks the trade can actually
// cross — NOT a fixed 96-tick window. Returns ONLY RAW reads; the off-chain TS
// (prepare.ts) builds brackets, sorts, water-fills, trims and composes routes.
//
// FOUR INTERNAL PASSES (all in one eth_call). SPOT ACTIVE-L IS NEVER USED AS A DEPTH
// OR SELECTION METRIC — only as each pool's tick-walk ENTRY liquidity (the active L at
// the current tick, needed to integrate the first bracket). A narrow band of huge
// spot-L right at spot can't cover amountIn within maxTicks, so a spot-L-derived floor
// would silently disable the filter; measuring every pool sidesteps that.
//   1. CHEAP STATE PASS — discover all pools, read slot0 + liquidity ONLY (no ticks).
//      Just count ALIVE pools (sqrtP>0 && L>0) per family for the header. No depth
//      ranking, no spot-L sum.
//   2. MEASURE A (window floor BY MEASURING) — for EVERY alive pool, self-walk forward
//      until its OWN cumIn covers amountIn; record soloFloor = feeAdjust(far) at that
//      step (V2: closed-form). floorAdj = the SHALLOWEST solo floor among pools that
//      solo-covered amountIn = the MAX feeAdj-price among non-zero solo floors (out/in
//      price decreases with depth, so shallowest = highest = MAX). That is the deepest-
//      IN-RANGE pool's excursion — a tight-but-safe common bound, since the true shared
//      cut is at-or-shallower than every solo floor. If NO pool solo-covers amountIn →
//      floorAdj=0 → trade exceeds all depth → keep every alive pool. Deep pools early-
//      stop at amountIn, so this is cheap. Produces only the scalar floorAdj (no emit).
//   3. MEASURE B (capacity to the common floor) — walk EVERY ALIVE pool forward to
//      (feeAdjust(far) <= floorAdj OR cumIn>=amountIn OR maxTicks); cap = cumIn at the
//      stop; store capArr[ord]; totalCap += cap (V2: closed-form to floorAdj). capFloor
//      = minRelBps of totalCap (0 when floorAdj=0 or minRelBps=0).
//   4. EMIT PASS — for every SURVIVOR (capArr[ord] >= capFloor), lazy-walk forward until
//      (cumIn >= amountIn) OR (feeAdjust(far) <= floorAdj), then driftTicks MORE forward,
//      plus read driftTicks on the REVERSE side of spot for runtime drift. Hard cap at
//      MAX_TICKS. Emit pool row (incl scannedForward) + tick rows. NON-survivors are NOT
//      emitted — the lens is the single source of truth for survivorship, so the off-
//      chain consumer treats every returned pool row as a survivor. MEASURE B and EMIT
//      iterate ALIVE pools in the SAME order (V3→V2→V4) with the IDENTICAL aliveness
//      gate, so the capacity ordinal lines up with emission.
//
// TICK REPRESENTATION (avoids sign-magnitude branching): a tick is carried as a
// non-negative "shifted" value s = tick + OFFSET, OFFSET = 888000 (a multiple of
// every tickSpacing's LCM 3000, and > the max |tick| 887272 so s stays positive).
// Stepping is plain unsigned s ± tickSpacing. The int24 STATICCALL arg is
// recovered via tickArg(): s>=OFFSET ? s-OFFSET : Math.neg(OFFSET-s).
//
// All math via Math.mulDiv / Math.sqrt / Math.neg + guarded ifs. The expensive
// ticks()/getTickLiquidity STATICCALLs are gated behind a per-pool `done` flag so
// gas scales with ticks ACTUALLY read.
//
// ── Compiler-arg layout — scalars bundled into `cfg`, tuples kept separate (v12-native) ──
// main() takes the 8 SCALARS bundled into one `cfg` tuple plus the 6 tuple-of-tuples
// params unchanged. The scalars were the problem: as separate params, deep reads of
// them used depth-sensitive SDUP, which overflows the v12 SDUP16 reference window once
// the working stack is tall (the big 4-pass body) → "REF position out of range: 17".
// Bundling them into `cfg` turns each into a heap INDEX read (cfg[i]) at a fixed depth,
// clearing the overflow on v12. bandTicks (cfg[7], the survivorship price-band budget)
// was added to cfg — NOT as a new param — so main() stays at 7 params (the v12 arg-
// prologue SDUP window is unchanged).
//
// The 6 tuple-of-tuples params are LEFT as separate params on purpose: a top-level
// tuple-of-tuples param round-trips through a variable correctly on BOTH engines (the
// solver indexes `pools[i][j]` the same way). Folding them INTO cfg would add one more
// nesting level (cfg→cfg[7]→[i]→[j]), and a depth-3 nested compile-time-arg tuple read
// through a variable REVERTS on v1 (SauceInvalidOperationArgs(INDEX) — the nested-tuple
// descriptor is lost on the var round-trip); only inline depth-3 survives on v1. So the
// scalars bundle, the tuples don't.
//
//   cfg[0]  tokenIn    : Address
//   cfg[1]  tokenOut   : Address
//   cfg[2]  zeroForOne : Uint256 (1 if tokenIn < tokenOut)
//   cfg[3]  amountIn   : Uint256 (gross tokenIn; sizes the lazy walk)
//   cfg[4]  driftTicks : Uint256 (extra boundaries past the stop, each side)
//   cfg[5]  minRelBps  : Uint256 (survivor floor in bps of Σ in-range capacity)
//   cfg[6]  maxTicks   : Uint256 (HARD gas ceiling on forward tick reads per pool = the
//                        clamp HI; sizes every walk loop's bound. Per-pool the walk stops
//                        EARLIER at effTicks, see cfg[7].)
//   cfg[7]  bandTicks  : Uint256 (target survivorship PRICE BAND in RAW ticks. The per-pool
//                        effective tick budget is effTicks = clamp(bandTicks / max(1,ts),
//                        LO=96, HI=maxTicks): a TIGHT ts (ts=1, the 0.01% stable tier) gets
//                        MANY boundaries to cover the same % band a wide-ts pool covers in a
//                        few; a WIDE ts is floored at LO=96 (byte-identical to the prior fixed
//                        96 window → no wide-ts regression). This makes the IN-RANGE-capacity
//                        SURVIVORSHIP metric + the deactivation window a fixed price band per
//                        pool instead of a fixed tick COUNT, so a deep tight-ts stable pool is
//                        no longer under-measured (its Σ share understated) and dropped by the
//                        minRelBps filter for a non-liquidity reason. bandTicks=0 ⇒ effTicks=LO
//                        for every pool (the legacy fixed-96 behavior).)
//   v3Factories[i] = [factoryAddr, isAlgebra, algebraTs, algebraStep, isSlipstream, algSingleFee]
//                    isAlgebra=1 ⇒ Algebra dynamic-fee fork (Camelot/QuickSwap V3, Ramses V2,
//                    THENA Fusion, SwapX): discover via poolByPair(tokenIn,tokenOut) and read
//                    globalState() for (price, tick) + the DYNAMIC fee, in place of getPool/slot0().
//                    The fee word is PER-FORK (algSingleFee, col 5): algSingleFee=0 ⇒ Camelot
//                    directional (word 2 for zeroForOne, word 3 for oneForZero); algSingleFee=1 ⇒
//                    Algebra V1/Integral single fee ALWAYS at word 2 (word 3 is a timepointIndex /
//                    pluginConfig, NOT a fee — decoding it would feed a garbage fee up to 65535 ppm).
//                    algebraTs/algebraStep are the
//                    factory's fixed per-pool tickSpacing + its precomputed step ratio (the
//                    lens has no on-chain TickMath). For isAlgebra=1 the inner v3FeeTiers loop
//                    runs ONCE (ti===0) — Algebra has one pool per pair, no fee tiers. The tick
//                    walk (ticks()[1]=liquidityDelta shares the V3 selector + int128 layout),
//                    the capacity/floor math and the emitted V3 pool row are reused verbatim
//                    (poolType=1=UniV3; the dynamic fee rides the row's `fee` field).
//                    isSlipstream=1 ⇒ Velodrome/Aerodrome Slipstream (+ Ramses-lineage Shadow) CL:
//                    the CLFactory keys pools by TICK SPACING, so discover via
//                    getPool(tokenIn,tokenOut,int24 tickSpacing) where the "tickSpacing" is the
//                    v3FeeTiers[j][0] value REINTERPRETED as a tickSpacing (the lens is fed the
//                    Slipstream tickSpacing menu as that column for a Slipstream factory), then
//                    read the pool's OWN fee() (Slipstream DECOUPLES fee from tickSpacing) — after
//                    which slot0/liquidity/tickSpacing()/ticks() are byte-identical to standard V3,
//                    so the tick walk + capacity/floor math + emit are reused verbatim. A
//                    Slipstream row loops the full v3FeeTiers column (each value = one tickSpacing).
//                    Standard-V3 rows carry isAlgebra=0, algebraTs=0, algebraStep=0, isSlipstream=0.
//   v3FeeTiers[j]  = [fee, stepRatio]        stepRatio=floor(sqrt(1.0001^ts)*2^96)
//   v2Factories[i] = [factoryAddr, feePpm]   feePpm = the pool's constant-product fee
//                                            (3000 for canonical UniswapV2); the engine
//                                            _swapV2 hardcodes 0.30%, so a non-3000 pool
//                                            executes via the callback-free Sauce path.
//   v4Factories[i] = [poolManager, stateView]
//   v4Specs[j]     = [fee, tickSpacing, stepRatio]
//   v4PoolIds[i*J+j] = [poolId]
//
// ── Return shape (off-chain abi.decode against this EXACTLY) ──────────────────
//   abi.encode(poolBlob: bytes, tickBlob: bytes)
//
//   poolBlob = a HEADER followed by SURVIVOR pool rows. The lens is the single
//   source of truth for survivorship: only pools whose IN-RANGE capacity >= capFloor
//   are emitted, so the consumer never re-filters.
//
//   HEADER (HEADER_WORDS = 4 words, exactly once at the start):
//     [0] discoveredCount (alive pools seen across all families)
//     [1] survivorCount   (pool rows that follow)
//     [2] totalCap        (Σ in-range/windowed capacity over alive pools)
//     [3] capFloor        (the in-range-capacity survivor threshold actually applied)
//
//   then survivorCount rows, POOL_STRIDE = 13 words per pool:
//     [0] poolType (0=V2,1=V3,2=V4)  [1] address  [2] fee  [3] tickSpacing
//     [4] hooks(0)  [5] sqrtPriceX96 (synthetic out/in for V2)
//     [6] liquidity (synthetic √(rIn·rOut) for V2)  [7] tickRaw (int24 ZERO-EXT)
//     [8] inIsToken0 (V2 only)  [9] stateView (V4)  [10] poolId (V4)
//     [11] scannedForward (forward tick boundaries walked; 0 for V2)
//     [12] scannedReverse (reverse-drift tick boundaries walked; 0 for V2)
//
//   tickBlob = concatenated 32-byte words, TICK_STRIDE = 3 words per tick row:
//     [0] poolIdx  [1] tickIndexRaw (int24 ZERO-EXT)  [2] liquidityNetRaw (int128 ZERO-EXT)

// ── Pure helpers (no contract scope needed) ──────────────────────────────────

// int24 STATICCALL arg from a shifted tick.
//
// SIGN-EXTEND to a full 32-byte word. The engine stores a value decoded from an
// `intN`/`uintN` contract output (e.g. slot0/getSlot0 `tick`) at that type's
// byte-width, and a value derived from it inherits that narrow width — so when it
// is ABI-ENCODED back as an `int24` call argument the engine emits only the low 3
// bytes, ZERO-extended. Uniswap V3 pools (Solidity 0.7, lax ABI decode) tolerate a
// non-sign-extended `int24`, but the Uniswap V4 StateView (Solidity 0.8, strict
// decode) reverts on it — bare 0x — for any NEGATIVE tick (real Base pools sit near
// tick -201700). OR-ing the high bits in for negatives both fixes the sign extension
// AND widens the value back to a full 32-byte word (the literal HIGH is a 32-byte
// constant), so getTickLiquidity/ticks receive valid `int24` calldata.
function tickArg(shifted: Uint256, OFFSET: Uint256): Uint256 {
  // bits [255:24] — set for a negative int24 to sign-extend to int256.
  const HIGH: Uint256 = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000;
  if (shifted >= OFFSET) {
    const up: Uint256 = shifted - OFFSET;
    if (up >= 8388608) {
      return up | HIGH;
    } // |tick| >= 2^23 can't happen (MAX_TICK 887272) but keep it total
    return up;
  }
  return Math.neg(OFFSET - shifted) | HIGH;
}

// ts-aligned SHIFTED base tick from a slot0/getSlot0/globalState int24 tick READ —
// verbatim from the solver (ecoswap.sauce.ts tickShiftedBase).
//
// The engine decodes a signed intN CONTRACT-OUTPUT (slot0/getSlot0/globalState tick,
// int24) by ZERO-extending it (not sign-extending) — a negative tick like -180 comes
// back as its raw 24-bit two's-complement 16777036 (= 2^24 - 180), NOT 2^256-180. So
// the naive `((tickRaw + OFFSET) / ts) * ts` produces a grid base displaced by
// -(2^24 mod ts) ticks for any pool below tick 0 with ts > 1 (ts=10 → +4, ts=50/60/
// 200 → -16): every scanned boundary lands OFF-GRID, every ticks()/getTickLiquidity
// read returns 0 (L never updates; emitted net rows are all zero). Recover the true
// SHIFTED tick directly: a raw value with the int24 sign bit set (>= 2^23) is
// negative, so shift = rawTick + OFFSET - 2^24; otherwise shift = rawTick + OFFSET.
// Both are non-negative (OFFSET > max|tick|). Then floor to the tickSpacing lattice.
// Mirrors the off-chain BigInt.asIntN(24, tickRaw).
function tickShiftedBase(tickRaw: Uint256, OFFSET: Uint256, ts: Uint256): Uint256 {
  const INT24_SIGN: Uint256 = 8388608; // 2^23
  const INT24_MOD: Uint256 = 16777216; // 2^24
  let shifted: Uint256 = tickRaw + OFFSET;
  if (tickRaw >= INT24_SIGN) {
    shifted = tickRaw + OFFSET - INT24_MOD;
  }
  return (shifted / ts) * ts;
}

// fee-adjusted out/in sqrt: sqrt * sqrt(1-fee) (sqrt(1-fee) scaled by 1e6).
function feeAdj(sqrtV: Uint256, fee: Uint256): Uint256 {
  const sf: Uint256 = Math.sqrt((1000000 - fee) * 1000000);
  return Math.mulDiv(sqrtV, sf, 1000000);
}

// Convert a real pool sqrt (token1/token0) into unified out/in sqrt.
function toOutIn(sqrtReal: Uint256, zeroForOne: Uint256): Uint256 {
  if (zeroForOne === 1) {
    return sqrtReal;
  }
  const Q192: Uint256 = 2 ** 192;
  return Q192 / sqrtReal;
}

// Next REAL sqrt one tickSpacing step in the swap direction.
//   zeroForOne (price down): sqrt' = mulDiv(sqrt, 2^96, stepRatio)
//   oneForZero (price up):   sqrt' = mulDiv(sqrt, stepRatio, 2^96)
function stepReal(sqrtReal: Uint256, stepRatio: Uint256, zeroForOne: Uint256): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  if (zeroForOne === 1) {
    return Math.mulDiv(sqrtReal, Q96, stepRatio);
  }
  return Math.mulDiv(sqrtReal, stepRatio, Q96);
}

// Per-pool effective forward tick budget = clamp(bandTicks / max(1,ts), LO, HI).
// Each walk step advances ONE tickSpacing, so `n` steps span n*ts RAW ticks — a price
// band of 1.0001^(n*ts). To cover a FIXED raw-tick band `bandTicks` a pool needs
// n = bandTicks/ts steps: a tight ts=1 pool gets MANY steps, a wide ts gets FEW. LO=96
// floors the budget at the legacy fixed window (so ts>=10 tiers are byte-identical to the
// old behavior — no wide-ts regression, wei-exact preserved for them by construction);
// HI=maxTicks caps the tight-ts budget so the lens gas stays bounded (it is also the outer
// loop bound below, so effTicks<=maxTicks always). bandTicks=0 ⇒ LO for every pool (legacy).
// The SOLVER (ecoswap.sauce.ts, PER_POOL=2048 with out-of-window staticcalls) and the neutral
// ORACLE (ecoswap.optimal.ts, MAX_V3_STEPS=2048 over the SAME adaptiveNet this window ships)
// both derive their deactivation extreme from the net map the lens emits over THIS budget, so
// widening the budget widens BOTH in lockstep — survivorship + deactivation stay identical.
function effTicks(ts: Uint256, bandTicks: Uint256, maxTicks: Uint256): Uint256 {
  const LO: Uint256 = 96;
  let denom: Uint256 = ts;
  if (denom < 1) {
    denom = 1;
  }
  let n: Uint256 = bandTicks / denom;
  if (n < LO) {
    n = LO;
  }
  if (n > maxTicks) {
    n = maxTicks;
  }
  return n;
}

function main(
  cfg: Tuple,
  v3Factories: Tuple,
  v3FeeTiers: Tuple,
  v2Factories: Tuple,
  v4Factories: Tuple,
  v4Specs: Tuple,
  v4PoolIds: Tuple
): bytes {
  // Destructure the bundled SCALARS (see "Compiler-arg layout" above). Bundling the 7
  // scalars into `cfg` makes their deep reads heap INDEX loads at a fixed depth, so the
  // tall-stack 4-pass body below stays inside the v12 SDUP16 reference window. The 6
  // tuple-of-tuples params stay separate (a depth-3 nested-arg read through a var
  // reverts INDEX on v1; depth-2 tuple params round-trip fine on both engines).
  const tokenIn: Address = cfg[0];
  const tokenOut: Address = cfg[1];
  const zeroForOne: Uint256 = cfg[2];
  const amountIn: Uint256 = cfg[3];
  const driftTicks: Uint256 = cfg[4];
  const minRelBps: Uint256 = cfg[5];
  const maxTicks: Uint256 = cfg[6];
  const bandTicks: Uint256 = cfg[7];

  let poolBlob: bytes = abi.encode(tokenIn).slice(0, 0);
  let tickBlob: bytes = abi.encode(tokenIn).slice(0, 0);
  let poolCount: Uint256 = 0;
  let discovered: Uint256 = 0; // alive pools seen across all families (for header)

  const OFFSET: Uint256 = 888000; // tick shift (multiple of LCM(spacings)=3000, > max|tick|)
  const Q96: Uint256 = 2 ** 96;
  const Q192: Uint256 = 2 ** 192;
  const HALF128: Uint256 = 2 ** 127; // int128 sign bit
  const MOD128: Uint256 = 2 ** 128;

  // Upper bound on the pool count across all families (V3 factories×feeTiers + V2
  // factories + V4 factories×specs) — sizes the measure pass's per-pool capacity
  // array. All small (≤255). getPool/getPair return 0 for absent tiers, so the
  // actual ALIVE count (the live ordinal) is ≤ this.
  const maxPools: Uint256 =
    v3Factories.length * v3FeeTiers.length +
    v2Factories.length +
    v4Factories.length * v4Specs.length;

  // ════ PASS 1: CHEAP STATE — discover + slot0 + liquidity (NO ticks) ════
  // Count ALIVE pools (sqrtP>0 && L>0) per family for the header's discoveredCount.
  // Spot active-L is NEVER used as a depth or selection metric: the only legitimate
  // use of active L is as each pool's walk-ENTRY liquidity (re-read per pool in the
  // measure passes below). There is no deepest-by-spot-L pool and no spot-L floor.
  for (let fi = 0; fi < v3Factories.length; fi = fi + 1) {
    const vf: Tuple = v3Factories[fi];
    const factory: Address = vf[0];
    const isAlg: Uint256 = vf[1]; // 1 ⇒ Algebra dynamic-fee fork (poolByPair + globalState)
    const isSlip: Uint256 = vf[4]; // 1 ⇒ Slipstream CL (getPool by int24 tickSpacing + fee())
    for (let ti = 0; ti < v3FeeTiers.length; ti = ti + 1) {
      const ft: Tuple = v3FeeTiers[ti];
      const fee: Uint256 = ft[0];
      // Algebra factories yield ONE pool per pair (no fee tiers) — only act at ti===0 so the
      // pool is discovered/counted exactly once. Standard V3 AND Slipstream loop every column
      // value (a fee tier for V3, a tickSpacing for Slipstream).
      let runIt: Uint256 = 1;
      if (isAlg === 1) {
        if (ti !== 0) {
          runIt = 0;
        }
      }
      if (runIt === 1) {
        let poolAddr: Address = 0;
        let sqrtP: Uint256 = 0;
        if (isAlg === 1) {
          poolAddr = IAlgebraFactory.at(factory).poolByPair(tokenIn, tokenOut);
          if (poolAddr !== 0) {
            sqrtP = IAlgebraPool.at(poolAddr).globalState()[0]; // price (== sqrtPriceX96)
          }
        } else {
          if (isSlip === 1) {
            // Slipstream: the column value `fee` is a TICKSPACING (getPool keyed by int24 tickSpacing).
            poolAddr = ISlipstreamCLFactory.at(factory).getPool(tokenIn, tokenOut, fee);
          } else {
            poolAddr = IUniswapV3Factory.at(factory).getPool(tokenIn, tokenOut, fee);
          }
          if (poolAddr !== 0) {
            // Slipstream pools have the standard slot0() surface (only DISCOVERY differs).
            sqrtP = IUniswapV3PoolFull.at(poolAddr).slot0()[0];
          }
        }
        if (poolAddr !== 0) {
          // liquidity() shares a selector across Uniswap V3 and Algebra, so the V3 binding works.
          const liq: Uint256 = IUniswapV3PoolFull.at(poolAddr).liquidity();
          if (sqrtP > 0) {
            if (liq > 0) {
              discovered = discovered + 1;
            }
          }
        }
      }
    }
  }

  for (let qi = 0; qi < v4Factories.length; qi = qi + 1) {
    const vf4: Tuple = v4Factories[qi];
    const stateView: Address = vf4[1];
    for (let si = 0; si < v4Specs.length; si = si + 1) {
      const spec: Tuple = v4Specs[si];
      const idRow: Tuple = v4PoolIds[qi * v4Specs.length + si];
      const poolId: Uint256 = idRow[0];
      const sqrtP4: Uint256 = IStateViewFull.at(stateView).getSlot0(poolId)[0];
      if (sqrtP4 > 0) {
        const liq4: Uint256 = IStateViewFull.at(stateView).getLiquidity(poolId);
        if (liq4 > 0) {
          discovered = discovered + 1;
        }
      }
    }
  }

  for (let vli = 0; vli < v2Factories.length; vli = vli + 1) {
    const vlf: Tuple = v2Factories[vli];
    const factoryL: Address = vlf[0];
    const pairL: Address = IUniswapV2Factory.at(factoryL).getPair(tokenIn, tokenOut);
    if (pairL !== 0) {
      const lr0: Uint256 = IUniswapV2Pair.at(pairL).getReserves()[0];
      const lr1: Uint256 = IUniswapV2Pair.at(pairL).getReserves()[1];
      if (lr0 > 0) {
        if (lr1 > 0) {
          const synthLpre: Uint256 = Math.sqrt(lr0 * lr1);
          if (synthLpre > 0) {
            discovered = discovered + 1;
          }
        }
      }
    }
  }

  // ════ MEASURE A: derive the window floor BY MEASURING (no spot L) ════
  // For EVERY alive pool, self-walk forward until its OWN cumulative gross input
  // covers amountIn; record that pool's solo-excursion fee-adjusted price soloFloor
  // = feeAdj(farOI, fee) at the step it crosses amountIn. The shared window floor
  // `floorAdj` = the SHALLOWEST solo floor across pools that solo-covered amountIn.
  //
  // In unified out/in space the price DECREASES with depth, so a SHALLOWER excursion
  // is a HIGHER feeAdj-price → "shallowest solo floor" = the MAX soloFloor among the
  // non-zero ones. That pool is the deepest-IN-RANGE one (covers amountIn with the
  // least excursion); the true shared cut sits at-or-above every solo floor, so the
  // MAX solo floor is the tightest SAFE common bound. If NO pool solo-covers amountIn
  // within maxTicks, floorAdj stays 0 → trade exceeds all depth → keep every alive
  // pool (filter disabled). Each walk early-stops at amountIn, so deep pools are cheap.
  // The walks are INLINED (compiler forbids helper→helper calls; the walk needs
  // stepReal/toOutIn/feeAdj/tickArg).
  let floorAdj: Uint256 = 0;

  // — V3 + Algebra solo walks —
  // Algebra branches ONLY the discovery + the (sqrt,tick,fee,ts,step) resolve; the walk body
  // below is byte-identical to standard V3 (ticks()[1] = liquidityDelta shares the V3 selector
  // + int128 layout, so the V3 binding reads the net). For Algebra the fee is the DYNAMIC fee
  // from globalState (feeZto for zeroForOne, feeOtz for oneForZero) and the step/ts come from
  // the factory row (precomputed; the lens has no on-chain TickMath).
  for (let fa3 = 0; fa3 < v3Factories.length; fa3 = fa3 + 1) {
    const vfa3: Tuple = v3Factories[fa3];
    const factoryA3: Address = vfa3[0];
    const isAlgA3: Uint256 = vfa3[1];
    const algTsA3: Uint256 = vfa3[2];
    const algStepA3: Uint256 = vfa3[3];
    const isSlipA3: Uint256 = vfa3[4];
    const algSingleA3: Uint256 = vfa3[5]; // 1 ⇒ Algebra V1/Integral single fee (word 2); 0 ⇒ Camelot directional
    for (let ta3 = 0; ta3 < v3FeeTiers.length; ta3 = ta3 + 1) {
      const fta3: Tuple = v3FeeTiers[ta3];
      let runA3: Uint256 = 1;
      if (isAlgA3 === 1) {
        if (ta3 !== 0) {
          runA3 = 0;
        }
      }
      if (runA3 === 1) {
        let poolA3: Address = 0;
        let sqrtA3: Uint256 = 0;
        let feeA3: Uint256 = fta3[0];
        let stepA3: Uint256 = fta3[1];
        if (isAlgA3 === 1) {
          poolA3 = IAlgebraFactory.at(factoryA3).poolByPair(tokenIn, tokenOut);
          if (poolA3 !== 0) {
            // Index globalState() DIRECTLY on each call (NOT via a stored Tuple var): the v1
            // engine reverts SauceInvalidOperationArgs(INDEX) when a contract-return tuple is
            // round-tripped through a variable and then indexed (the descriptor is lost). The
            // standard-V3 path already indexes slot0() inline; mirror that for Algebra.
            sqrtA3 = IAlgebraPool.at(poolA3).globalState()[0];
            // Per-fork fee: Algebra V1/Integral carry a SINGLE fee at word 2 (word 3 is a
            // timepointIndex/pluginConfig — NOT a fee); Camelot is DIRECTIONAL (word 2 zeroForOne /
            // word 3 oneForZero). Decoding word 3 as a fee on a V1/Integral fork would feed a garbage
            // value (up to 65535 ppm) into the survivor filter + merge pricing.
            if (algSingleA3 === 1) {
              feeA3 = IAlgebraPool.at(poolA3).globalState()[2];
            } else {
              feeA3 = zeroForOne === 1
                ? IAlgebraPool.at(poolA3).globalState()[2]
                : IAlgebraPool.at(poolA3).globalState()[3];
            }
            stepA3 = algStepA3;
          }
        } else {
          if (isSlipA3 === 1) {
            // Slipstream: fta3[0] is a TICKSPACING (getPool by int24), and the step is the
            // Slipstream column fta3[2] = stepRatioForSpacing(tickSpacing). The per-pool fee is
            // READ from fee() (decoupled from tickSpacing), replacing the tier value.
            poolA3 = ISlipstreamCLFactory.at(factoryA3).getPool(tokenIn, tokenOut, feeA3);
            stepA3 = fta3[2];
            if (poolA3 !== 0) {
              feeA3 = IUniswapV3PoolFull.at(poolA3).fee();
              sqrtA3 = IUniswapV3PoolFull.at(poolA3).slot0()[0];
            }
          } else {
            poolA3 = IUniswapV3Factory.at(factoryA3).getPool(tokenIn, tokenOut, feeA3);
            if (poolA3 !== 0) {
              sqrtA3 = IUniswapV3PoolFull.at(poolA3).slot0()[0];
            }
          }
        }
      if (poolA3 !== 0) {
        const liqA3: Uint256 = IUniswapV3PoolFull.at(poolA3).liquidity();
        if (sqrtA3 > 0) {
          if (liqA3 > 0) {
            let tsA3: Uint256 = IUniswapV3PoolFull.at(poolA3).tickSpacing();
            if (isAlgA3 === 1) {
              tsA3 = algTsA3;
            }
            // Tick from globalState (Algebra) or slot0 (standard V3). A real Algebra pool has NO
            // slot0(), so the read MUST branch on isAlg — calling slot0() on an Algebra pool would
            // revert the whole lens. (Standard V3 keeps its slot0()[1] read verbatim.)
            let tickA3: Uint256 = 0;
            if (isAlgA3 === 1) {
              tickA3 = IAlgebraPool.at(poolA3).globalState()[1];
            } else {
              tickA3 = IUniswapV3PoolFull.at(poolA3).slot0()[1];
            }
            const baseA3: Uint256 = tickShiftedBase(tickA3, OFFSET, tsA3);
            let curA3: Uint256 = baseA3;
            if (zeroForOne === 0) {
              curA3 = baseA3 + tsA3;
            }
            let La3: Uint256 = liqA3;
            let nearRealA3: Uint256 = sqrtA3;
            let cumA3: Uint256 = 0;
            let doneA3: Uint256 = 0;
            const budA3: Uint256 = effTicks(tsA3, bandTicks, maxTicks);
            for (let ka3 = 0; ka3 < maxTicks; ka3 = ka3 + 1) {
              if (ka3 >= budA3) {
                doneA3 = 1;
              }
              if (doneA3 === 0) {
                const farRealA3: Uint256 = stepReal(nearRealA3, stepA3, zeroForOne);
                const nearOIa3: Uint256 = toOutIn(nearRealA3, zeroForOne);
                const farOIa3: Uint256 = toOutIn(farRealA3, zeroForOne);
                if (La3 > 0) {
                  if (nearOIa3 > farOIa3) {
                    const effA3: Uint256 = Math.mulDiv(La3, Q96, farOIa3) - Math.mulDiv(La3, Q96, nearOIa3);
                    cumA3 = cumA3 + Math.mulDiv(effA3, 1000000, 1000000 - feeA3);
                  }
                }
                const argA3: Uint256 = tickArg(curA3, OFFSET);
                const netA3: Uint256 = IUniswapV3PoolFull.at(poolA3).ticks(argA3)[1];
                const isNegA3: Uint256 = netA3 >= HALF128 ? 1 : 0;
                if (zeroForOne === 1) {
                  if (isNegA3 === 1) {
                    La3 = La3 + (MOD128 - netA3);
                  } else {
                    La3 = La3 >= netA3 ? La3 - netA3 : 0;
                  }
                  curA3 = curA3 - tsA3;
                } else {
                  if (isNegA3 === 1) {
                    const magA3: Uint256 = MOD128 - netA3;
                    La3 = La3 >= magA3 ? La3 - magA3 : 0;
                  } else {
                    La3 = La3 + netA3;
                  }
                  curA3 = curA3 + tsA3;
                }
                nearRealA3 = farRealA3;
                if (cumA3 >= amountIn) {
                  const soloA3: Uint256 = feeAdj(farOIa3, feeA3);
                  if (soloA3 > floorAdj) {
                    floorAdj = soloA3;
                  }
                  doneA3 = 1;
                }
              }
            }
          }
        }
      }
      }
    }
  }

  // — V2 solo floor (closed form; per-pool fee feeV2 from v2Factories[va][1]). V2 has
  // infinite range, so it ALWAYS solo-covers amountIn: invert the constant-product
  // gross-in equation for the out/in sqrt s where grossIn(near→s)=amountIn, then
  // soloFloor=feeAdj(s,feeV2).
  //   effIn = amountIn*(1-fee);  L*Q96/s = L*Q96/near + effIn;  s = L*Q96/(that). —
  for (let va = 0; va < v2Factories.length; va = va + 1) {
    const vfa2: Tuple = v2Factories[va];
    const factoryA2: Address = vfa2[0];
    const feeV2A: Uint256 = vfa2[1];
    const pairA: Address = IUniswapV2Factory.at(factoryA2).getPair(tokenIn, tokenOut);
    if (pairA !== 0) {
      const ar0: Uint256 = IUniswapV2Pair.at(pairA).getReserves()[0];
      const ar1: Uint256 = IUniswapV2Pair.at(pairA).getReserves()[1];
      if (ar0 > 0) {
        if (ar1 > 0) {
          const t0A: Address = IUniswapV2Pair.at(pairA).token0();
          const inIsT0A: Uint256 = t0A === tokenIn ? 1 : 0;
          const rInA: Uint256 = inIsT0A === 1 ? ar0 : ar1;
          const rOutA: Uint256 = inIsT0A === 1 ? ar1 : ar0;
          const synthLA: Uint256 = Math.sqrt(rInA * rOutA);
          if (synthLA > 0) {
            const nearA: Uint256 = Math.sqrt(Math.mulDiv(rOutA, Q192, rInA));
            const effA2: Uint256 = Math.mulDiv(amountIn, 1000000 - feeV2A, 1000000);
            const invNearA: Uint256 = Math.mulDiv(synthLA, Q96, nearA);
            const invLowA: Uint256 = invNearA + effA2;
            if (invLowA > 0) {
              const sLowA: Uint256 = Math.mulDiv(synthLA, Q96, invLowA);
              const sf2A: Uint256 = Math.sqrt((1000000 - feeV2A) * 1000000);
              const soloA2: Uint256 = Math.mulDiv(sLowA, sf2A, 1000000);
              if (soloA2 > floorAdj) {
                floorAdj = soloA2;
              }
            }
          }
        }
      }
    }
  }

  // — V4 solo walks (StateView) —
  for (let qa = 0; qa < v4Factories.length; qa = qa + 1) {
    const vfa4: Tuple = v4Factories[qa];
    const stateViewA: Address = vfa4[1];
    for (let sa = 0; sa < v4Specs.length; sa = sa + 1) {
      const specA: Tuple = v4Specs[sa];
      const feeA4: Uint256 = specA[0];
      const tsA4: Uint256 = specA[1];
      const stepA4: Uint256 = specA[2];
      const idRowA: Tuple = v4PoolIds[qa * v4Specs.length + sa];
      const poolIdA: Uint256 = idRowA[0];
      const sqrtA4: Uint256 = IStateViewFull.at(stateViewA).getSlot0(poolIdA)[0];
      if (sqrtA4 > 0) {
        const liqA4: Uint256 = IStateViewFull.at(stateViewA).getLiquidity(poolIdA);
        if (liqA4 > 0) {
          const tickA4: Uint256 = IStateViewFull.at(stateViewA).getSlot0(poolIdA)[1];
          const baseA4: Uint256 = tickShiftedBase(tickA4, OFFSET, tsA4);
          let curA4: Uint256 = baseA4;
          if (zeroForOne === 0) {
            curA4 = baseA4 + tsA4;
          }
          let La4: Uint256 = liqA4;
          let nearRealA4: Uint256 = sqrtA4;
          let cumA4: Uint256 = 0;
          let doneA4: Uint256 = 0;
          const budA4: Uint256 = effTicks(tsA4, bandTicks, maxTicks);
          for (let ka4 = 0; ka4 < maxTicks; ka4 = ka4 + 1) {
            if (ka4 >= budA4) {
              doneA4 = 1;
            }
            if (doneA4 === 0) {
              const farRealA4: Uint256 = stepReal(nearRealA4, stepA4, zeroForOne);
              const nearOIa4: Uint256 = toOutIn(nearRealA4, zeroForOne);
              const farOIa4: Uint256 = toOutIn(farRealA4, zeroForOne);
              if (La4 > 0) {
                if (nearOIa4 > farOIa4) {
                  const effA4: Uint256 = Math.mulDiv(La4, Q96, farOIa4) - Math.mulDiv(La4, Q96, nearOIa4);
                  cumA4 = cumA4 + Math.mulDiv(effA4, 1000000, 1000000 - feeA4);
                }
              }
              const argA4: Uint256 = tickArg(curA4, OFFSET);
              const netA4: Uint256 = IStateViewFull.at(stateViewA).getTickLiquidity(poolIdA, argA4)[1];
              const isNegA4: Uint256 = netA4 >= HALF128 ? 1 : 0;
              if (zeroForOne === 1) {
                if (isNegA4 === 1) {
                  La4 = La4 + (MOD128 - netA4);
                } else {
                  La4 = La4 >= netA4 ? La4 - netA4 : 0;
                }
                curA4 = curA4 - tsA4;
              } else {
                if (isNegA4 === 1) {
                  const magA4: Uint256 = MOD128 - netA4;
                  La4 = La4 >= magA4 ? La4 - magA4 : 0;
                } else {
                  La4 = La4 + netA4;
                }
                curA4 = curA4 + tsA4;
              }
              nearRealA4 = farRealA4;
              if (cumA4 >= amountIn) {
                const soloA4: Uint256 = feeAdj(farOIa4, feeA4);
                if (soloA4 > floorAdj) {
                  floorAdj = soloA4;
                }
                doneA4 = 1;
              }
            }
          }
        }
      }
    }
  }

  // ════ MEASURE B: in-range (windowed) capacity to the COMMON floor ════
  // The survivor gate is IN-RANGE CAPACITY, not spot active-L: walk every alive pool
  // forward (swap direction) accumulating the gross tokenIn it absorbs from spot down
  // to the COMMON window floor `floorAdj` measured in MEASURE A (or amountIn / maxTicks
  // first), and store it per pool in capArr. The ordinal `ord` is incremented once per
  // ALIVE pool in the SAME order the EMIT pass uses — V3 (factories×feeTiers) → V2
  // (factories) → V4 (factories×specs) — with the IDENTICAL aliveness gate, so
  // capArr[ord] lines up with the survivor decision below. A narrow band of huge spot
  // active-L right at spot contributes only its in-range slice here, so it no longer
  // poses as depth. The V3/V4 capacity walks are INLINED (the compiler does not support
  // helper→helper calls, and the walk needs stepReal/toOutIn/feeAdj/tickArg) — the same
  // forward-walk body as MEASURE A / the EMIT pass, but emitting nothing and stopping
  // AT the floor (no drift). V2 has no ticks → closed-form windowed capacity to floorAdj.
  let capArr: Tuple = new Array(maxPools);
  let totalCap: Uint256 = 0;
  let ord: Uint256 = 0;

  for (let fm = 0; fm < v3Factories.length; fm = fm + 1) {
    const vfm: Tuple = v3Factories[fm];
    const factoryM: Address = vfm[0];
    const isAlgM: Uint256 = vfm[1];
    const algTsM: Uint256 = vfm[2];
    const algStepM: Uint256 = vfm[3];
    const isSlipM: Uint256 = vfm[4];
    const algSingleM: Uint256 = vfm[5]; // 1 ⇒ Algebra V1/Integral single fee (word 2); 0 ⇒ Camelot directional
    for (let tm = 0; tm < v3FeeTiers.length; tm = tm + 1) {
      const ftm: Tuple = v3FeeTiers[tm];
      let runM: Uint256 = 1;
      if (isAlgM === 1) {
        if (tm !== 0) {
          runM = 0;
        }
      }
      if (runM === 1) {
      let poolM: Address = 0;
      let sqrtM: Uint256 = 0;
      let feeM: Uint256 = ftm[0];
      let stepM: Uint256 = ftm[1];
      if (isAlgM === 1) {
        poolM = IAlgebraFactory.at(factoryM).poolByPair(tokenIn, tokenOut);
        if (poolM !== 0) {
          // Index globalState() DIRECTLY (NOT via a stored Tuple var) — the v1 engine reverts
          // INDEX on a variable-round-tripped contract-return tuple (see the discovery pass).
          sqrtM = IAlgebraPool.at(poolM).globalState()[0];
          // Per-fork fee (see the discovery pass): single word 2 for V1/Integral, directional for Camelot.
          if (algSingleM === 1) {
            feeM = IAlgebraPool.at(poolM).globalState()[2];
          } else {
            feeM = zeroForOne === 1
              ? IAlgebraPool.at(poolM).globalState()[2]
              : IAlgebraPool.at(poolM).globalState()[3];
          }
          stepM = algStepM;
        }
      } else {
        if (isSlipM === 1) {
          // Slipstream: ftm[0] is a TICKSPACING (getPool by int24), step is ftm[2], fee READ from
          // fee(). step (ftm[2], keyed on the discovery key) and the stride tsM below (the LIVE
          // tickSpacing()) agree because real Slipstream getPool(a,b,ts) returns tickSpacing()==ts;
          // the step only sizes this capacity-measure walk (no rows emitted), so it never affects the
          // survivorship value even on a hypothetical decoupled fork. See the EMIT pass note.
          poolM = ISlipstreamCLFactory.at(factoryM).getPool(tokenIn, tokenOut, feeM);
          stepM = ftm[2];
          if (poolM !== 0) {
            feeM = IUniswapV3PoolFull.at(poolM).fee();
            sqrtM = IUniswapV3PoolFull.at(poolM).slot0()[0];
          }
        } else {
          poolM = IUniswapV3Factory.at(factoryM).getPool(tokenIn, tokenOut, feeM);
          if (poolM !== 0) {
            sqrtM = IUniswapV3PoolFull.at(poolM).slot0()[0];
          }
        }
      }
      if (poolM !== 0) {
        const liqM: Uint256 = IUniswapV3PoolFull.at(poolM).liquidity();
        if (sqrtM > 0) {
          if (liqM > 0) {
            let tsM: Uint256 = IUniswapV3PoolFull.at(poolM).tickSpacing();
            if (isAlgM === 1) {
              tsM = algTsM;
            }
            // Tick from globalState (Algebra) or slot0 (standard V3) — a real Algebra pool has no
            // slot0(), so branch on isAlg (calling slot0() on Algebra would revert the lens).
            let tickM: Uint256 = 0;
            if (isAlgM === 1) {
              tickM = IAlgebraPool.at(poolM).globalState()[1];
            } else {
              tickM = IUniswapV3PoolFull.at(poolM).slot0()[1];
            }
            // IN-RANGE capacity walk — byte-for-byte the PASS-2 floor / PASS-3
            // forward walk body (same stepReal/toOutIn/feeAdj, same int128 sign
            // recovery, same L update, same mulDiv gross-in), but emits NOTHING and
            // STOPS at the cut WITHOUT drift. cumIn at the stop = windowed capacity.
            // (Inlined, not a helper: the compiler does not support helper→helper
            // calls, and the walk calls stepReal/toOutIn/feeAdj/tickArg.)
            const baseShiftM: Uint256 = tickShiftedBase(tickM, OFFSET, tsM);
            let curShiftM: Uint256 = baseShiftM;
            if (zeroForOne === 0) {
              curShiftM = baseShiftM + tsM;
            }
            let LM: Uint256 = liqM;
            let nearRealM: Uint256 = sqrtM;
            let cumInM: Uint256 = 0;
            let doneM: Uint256 = 0;
            const budM: Uint256 = effTicks(tsM, bandTicks, maxTicks);
            for (let km = 0; km < maxTicks; km = km + 1) {
              if (km >= budM) {
                doneM = 1;
              }
              if (doneM === 0) {
                const farRealM: Uint256 = stepReal(nearRealM, stepM, zeroForOne);
                const nearOIM: Uint256 = toOutIn(nearRealM, zeroForOne);
                const farOIM: Uint256 = toOutIn(farRealM, zeroForOne);
                if (LM > 0) {
                  if (nearOIM > farOIM) {
                    const effInM: Uint256 = Math.mulDiv(LM, Q96, farOIM) - Math.mulDiv(LM, Q96, nearOIM);
                    cumInM = cumInM + Math.mulDiv(effInM, 1000000, 1000000 - feeM);
                  }
                }
                const argWM: Uint256 = tickArg(curShiftM, OFFSET);
                const netM: Uint256 = IUniswapV3PoolFull.at(poolM).ticks(argWM)[1];
                const isNegM: Uint256 = netM >= HALF128 ? 1 : 0;
                if (zeroForOne === 1) {
                  if (isNegM === 1) {
                    LM = LM + (MOD128 - netM);
                  } else {
                    LM = LM >= netM ? LM - netM : 0;
                  }
                  curShiftM = curShiftM - tsM;
                } else {
                  if (isNegM === 1) {
                    const magM: Uint256 = MOD128 - netM;
                    LM = LM >= magM ? LM - magM : 0;
                  } else {
                    LM = LM + netM;
                  }
                  curShiftM = curShiftM + tsM;
                }
                nearRealM = farRealM;
                const faM: Uint256 = feeAdj(farOIM, feeM);
                let hitFloorM: Uint256 = 0;
                if (floorAdj > 0) {
                  if (faM <= floorAdj) {
                    hitFloorM = 1;
                  }
                }
                if (cumInM >= amountIn) {
                  doneM = 1;
                } else {
                  if (hitFloorM === 1) {
                    doneM = 1;
                  }
                }
              }
            }
            capArr[ord] = cumInM;
            totalCap = totalCap + cumInM;
            ord = ord + 1;
          }
        }
      }
      }
    }
  }

  for (let vm = 0; vm < v2Factories.length; vm = vm + 1) {
    const vfm2: Tuple = v2Factories[vm];
    const factoryM2: Address = vfm2[0];
    const feeV2M: Uint256 = vfm2[1];
    const pairM: Address = IUniswapV2Factory.at(factoryM2).getPair(tokenIn, tokenOut);
    if (pairM !== 0) {
      const mr0: Uint256 = IUniswapV2Pair.at(pairM).getReserves()[0];
      const mr1: Uint256 = IUniswapV2Pair.at(pairM).getReserves()[1];
      if (mr0 > 0) {
        if (mr1 > 0) {
          const t0M: Address = IUniswapV2Pair.at(pairM).token0();
          const inIsT0M: Uint256 = t0M === tokenIn ? 1 : 0;
          const rInM: Uint256 = inIsT0M === 1 ? mr0 : mr1;
          const rOutM: Uint256 = inIsT0M === 1 ? mr1 : mr0;
          const synthLM: Uint256 = Math.sqrt(rInM * rOutM);
          if (synthLM > 0) {
            // V2 windowed capacity (closed form; per-pool fee feeV2M). near = synthetic
            // out/in sqrt. Invert the fee-adjusted floor out of adjusted space, then
            // capacity = gross-in to walk near→farThr (V2 analogue of prepare.ts
            // bracketCapacity), clamped at amountIn.
            const nearM: Uint256 = Math.sqrt(Math.mulDiv(rOutM, Q192, rInM));
            const sf2: Uint256 = Math.sqrt((1000000 - feeV2M) * 1000000);
            const farThr: Uint256 = Math.mulDiv(floorAdj, 1000000, sf2);
            let capV2: Uint256 = 0;
            if (farThr > 0) {
              if (farThr < nearM) {
                const effIn2: Uint256 = Math.mulDiv(synthLM, Q96, farThr) - Math.mulDiv(synthLM, Q96, nearM);
                capV2 = Math.mulDiv(effIn2, 1000000, 1000000 - feeV2M);
              }
            }
            let capM2: Uint256 = capV2;
            if (capV2 > amountIn) {
              capM2 = amountIn;
            }
            capArr[ord] = capM2;
            totalCap = totalCap + capM2;
            ord = ord + 1;
          }
        }
      }
    }
  }

  for (let qm = 0; qm < v4Factories.length; qm = qm + 1) {
    const vfm4: Tuple = v4Factories[qm];
    const poolMgrM: Address = vfm4[0];
    const stateViewM: Address = vfm4[1];
    for (let sm = 0; sm < v4Specs.length; sm = sm + 1) {
      const specM: Tuple = v4Specs[sm];
      const v4feeM: Uint256 = specM[0];
      const v4tsM: Uint256 = specM[1];
      const v4stepM: Uint256 = specM[2];
      const idRowM: Tuple = v4PoolIds[qm * v4Specs.length + sm];
      const poolIdM: Uint256 = idRowM[0];
      const sqrtM4: Uint256 = IStateViewFull.at(stateViewM).getSlot0(poolIdM)[0];
      if (sqrtM4 > 0) {
        const liqM4: Uint256 = IStateViewFull.at(stateViewM).getLiquidity(poolIdM);
        if (liqM4 > 0) {
          const tickM4: Uint256 = IStateViewFull.at(stateViewM).getSlot0(poolIdM)[1];
          // IN-RANGE capacity walk (V4 via StateView.getTickLiquidity) — same body
          // as the V3 measure walk above; inlined (no helper→helper calls).
          const baseShiftM4: Uint256 = tickShiftedBase(tickM4, OFFSET, v4tsM);
          let curShiftM4: Uint256 = baseShiftM4;
          if (zeroForOne === 0) {
            curShiftM4 = baseShiftM4 + v4tsM;
          }
          let LM4: Uint256 = liqM4;
          let nearRealM4: Uint256 = sqrtM4;
          let cumInM4: Uint256 = 0;
          let doneM4: Uint256 = 0;
          const budM4: Uint256 = effTicks(v4tsM, bandTicks, maxTicks);
          for (let km4 = 0; km4 < maxTicks; km4 = km4 + 1) {
            if (km4 >= budM4) {
              doneM4 = 1;
            }
            if (doneM4 === 0) {
              const farRealM4: Uint256 = stepReal(nearRealM4, v4stepM, zeroForOne);
              const nearOIM4: Uint256 = toOutIn(nearRealM4, zeroForOne);
              const farOIM4: Uint256 = toOutIn(farRealM4, zeroForOne);
              if (LM4 > 0) {
                if (nearOIM4 > farOIM4) {
                  const effInM4: Uint256 = Math.mulDiv(LM4, Q96, farOIM4) - Math.mulDiv(LM4, Q96, nearOIM4);
                  cumInM4 = cumInM4 + Math.mulDiv(effInM4, 1000000, 1000000 - v4feeM);
                }
              }
              const argWM4: Uint256 = tickArg(curShiftM4, OFFSET);
              const netM4: Uint256 = IStateViewFull.at(stateViewM).getTickLiquidity(poolIdM, argWM4)[1];
              const isNegM4: Uint256 = netM4 >= HALF128 ? 1 : 0;
              if (zeroForOne === 1) {
                if (isNegM4 === 1) {
                  LM4 = LM4 + (MOD128 - netM4);
                } else {
                  LM4 = LM4 >= netM4 ? LM4 - netM4 : 0;
                }
                curShiftM4 = curShiftM4 - v4tsM;
              } else {
                if (isNegM4 === 1) {
                  const magM4: Uint256 = MOD128 - netM4;
                  LM4 = LM4 >= magM4 ? LM4 - magM4 : 0;
                } else {
                  LM4 = LM4 + netM4;
                }
                curShiftM4 = curShiftM4 + v4tsM;
              }
              nearRealM4 = farRealM4;
              const faM4: Uint256 = feeAdj(farOIM4, v4feeM);
              let hitFloorM4: Uint256 = 0;
              if (floorAdj > 0) {
                if (faM4 <= floorAdj) {
                  hitFloorM4 = 1;
                }
              }
              if (cumInM4 >= amountIn) {
                doneM4 = 1;
              } else {
                if (hitFloorM4 === 1) {
                  doneM4 = 1;
                }
              }
            }
          }
          capArr[ord] = cumInM4;
          totalCap = totalCap + cumInM4;
          ord = ord + 1;
        }
      }
    }
  }

  // In-range-capacity survivor floor (bps of Σ windowed capacity). When floorAdj is
  // 0 (NO pool solo-covered amountIn within maxTicks → trade exceeds all depth) OR
  // minRelBps is 0, the floor is 0 and every alive pool survives.
  let capFloor: Uint256 = 0;
  if (floorAdj > 0) {
    if (minRelBps > 0) {
      capFloor = Math.mulDiv(totalCap, minRelBps, 10000);
    }
  }

  // ════ EMIT PASS: per survivor, lazy-walk + emit ════
  // Survivorship is decided by in-range capacity (capArr[ord3], the SAME ordinal as
  // MEASURE B above — alive pools in V3→V2→V4 order), NOT spot active-L. The forward
  // walk stops on (feeAdj(far) <= floorAdj OR cumIn>=amountIn) then drifts, as before
  // — floorAdj is now the measured common floor from MEASURE A.
  let ord3: Uint256 = 0;
  // V3 survivors.
  for (let fi3 = 0; fi3 < v3Factories.length; fi3 = fi3 + 1) {
    const vf3: Tuple = v3Factories[fi3];
    const factory3: Address = vf3[0];
    const isAlg3: Uint256 = vf3[1];
    const algTs3: Uint256 = vf3[2];
    const algStep3: Uint256 = vf3[3];
    const isSlip3: Uint256 = vf3[4];
    const algSingle3: Uint256 = vf3[5]; // 1 ⇒ Algebra V1/Integral single fee (word 2); 0 ⇒ Camelot directional
    for (let ti3 = 0; ti3 < v3FeeTiers.length; ti3 = ti3 + 1) {
      const ft3: Tuple = v3FeeTiers[ti3];
      let runE3: Uint256 = 1;
      if (isAlg3 === 1) {
        if (ti3 !== 0) {
          runE3 = 0;
        }
      }
      if (runE3 === 1) {
      // Resolve discovery + (sqrt,tick,fee,step,ts) per family. Algebra: poolByPair +
      // globalState's DYNAMIC fee (feeZto/feeOtz by direction); Slipstream: getPool(a,b,int24 ts)
      // + fee() + the Slipstream step column ft3[2]; standard V3: getPool(a,b,fee) + slot0.
      let poolAddr3: Address = 0;
      let sqrt3: Uint256 = 0;
      let fee3: Uint256 = ft3[0];
      let step3: Uint256 = ft3[1];
      if (isAlg3 === 1) {
        poolAddr3 = IAlgebraFactory.at(factory3).poolByPair(tokenIn, tokenOut);
        if (poolAddr3 !== 0) {
          // Index globalState() DIRECTLY (NOT via a stored Tuple var) — the v1 engine reverts
          // INDEX on a variable-round-tripped contract-return tuple (see the discovery pass).
          sqrt3 = IAlgebraPool.at(poolAddr3).globalState()[0];
          // Per-fork fee (see the discovery pass): single word 2 for V1/Integral, directional for Camelot.
          if (algSingle3 === 1) {
            fee3 = IAlgebraPool.at(poolAddr3).globalState()[2];
          } else {
            fee3 = zeroForOne === 1
              ? IAlgebraPool.at(poolAddr3).globalState()[2]
              : IAlgebraPool.at(poolAddr3).globalState()[3];
          }
          step3 = algStep3;
        }
      } else {
        if (isSlip3 === 1) {
          // Slipstream: fee3 (the column value ft3[0]) is a TICKSPACING (getPool keyed by int24),
          // and step3 is the Slipstream step column ft3[2] = stepRatioForSpacing(that tickSpacing).
          // The multiplicative step (ft3[2]) is keyed on the DISCOVERY key while the tick-boundary
          // stride below (ts3) is the pool's LIVE tickSpacing() — these agree because real Slipstream
          // getPool(a,b,ts) returns a pool whose tickSpacing()==ts (only FEE is decoupled from the
          // key), so the column step is grid-correct. The step only sizes the capacity walk (how many
          // boundaries to scan); the EMITTED (tickIndex,net) rows use ts3, and prepare recomputes
          // exact sqrts — so even a hypothetical decoupled fork would only mis-size the scan COUNT,
          // never the bracket prices. The per-pool fee is READ from fee() (decoupled), replacing fee3.
          poolAddr3 = ISlipstreamCLFactory.at(factory3).getPool(tokenIn, tokenOut, fee3);
          step3 = ft3[2];
          if (poolAddr3 !== 0) {
            fee3 = IUniswapV3PoolFull.at(poolAddr3).fee();
            sqrt3 = IUniswapV3PoolFull.at(poolAddr3).slot0()[0];
          }
        } else {
          poolAddr3 = IUniswapV3Factory.at(factory3).getPool(tokenIn, tokenOut, fee3);
          if (poolAddr3 !== 0) {
            sqrt3 = IUniswapV3PoolFull.at(poolAddr3).slot0()[0];
          }
        }
      }
      if (poolAddr3 !== 0) {
        const liq3: Uint256 = IUniswapV3PoolFull.at(poolAddr3).liquidity();
        // ALIVE (sqrt>0 && L>0) is the ordinal gate — IDENTICAL to the measure
        // pass — so capArr[ord3] is THIS pool's in-range capacity. SURVIVOR iff
        // capFloor===0 (no bound / minRelBps=0) OR capArr[ord3] >= capFloor.
        let surv3: Uint256 = 0;
        if (sqrt3 > 0) {
          if (liq3 > 0) {
            if (capFloor === 0) {
              surv3 = 1;
            } else {
              if (capArr[ord3] >= capFloor) {
                surv3 = 1;
              }
            }
            ord3 = ord3 + 1;
          }
        }
        if (sqrt3 > 0) {
          if (surv3 === 1) {
            let ts3: Uint256 = IUniswapV3PoolFull.at(poolAddr3).tickSpacing();
            if (isAlg3 === 1) {
              ts3 = algTs3;
            }
            // Tick from globalState (Algebra) or slot0 (standard V3) — a real Algebra pool has no
            // slot0(), so branch on isAlg (calling slot0() on Algebra would revert the lens).
            let tick3: Uint256 = 0;
            if (isAlg3 === 1) {
              tick3 = IAlgebraPool.at(poolAddr3).globalState()[1];
            } else {
              tick3 = IUniswapV3PoolFull.at(poolAddr3).slot0()[1];
            }
            const idx3: Uint256 = poolCount;

            // ── Reverse-side drift reads (opposite direction), survivors only ──
            const baseRev3: Uint256 = tickShiftedBase(tick3, OFFSET, ts3);
            // reverse of swap dir: for zeroForOne (down) reverse is UP → start +ts.
            let revShift3: Uint256 = baseRev3;
            if (zeroForOne === 1) {
              revShift3 = baseRev3 + ts3;
            }
            let scanRev3: Uint256 = 0; // reverse boundaries walked (= count emitted)
            for (let rd3 = 0; rd3 < driftTicks; rd3 = rd3 + 1) {
              const ra3: Uint256 = tickArg(revShift3, OFFSET);
              const rn3: Uint256 = IUniswapV3PoolFull.at(poolAddr3).ticks(ra3)[1];
              tickBlob = tickBlob.concat(abi.encode(idx3, ra3, rn3));
              scanRev3 = scanRev3 + 1;
              if (zeroForOne === 1) {
                revShift3 = revShift3 + ts3; // further up
              } else {
                revShift3 = revShift3 - ts3; // further down
              }
            }

            // ── Forward lazy walk (swap direction) ──
            const baseShift3: Uint256 = tickShiftedBase(tick3, OFFSET, ts3);
            let curShift3: Uint256 = baseShift3;
            if (zeroForOne === 0) {
              curShift3 = baseShift3 + ts3;
            }
            let L3: Uint256 = liq3;
            let nearReal3: Uint256 = sqrt3;
            let cumIn3: Uint256 = 0;
            let scanned3: Uint256 = 0;
            let stop3: Uint256 = 0;    // hit cumIn>=amountIn OR feeAdj(far)<=floorAdj OR band edge
            let drift3: Uint256 = 0;   // extra ticks emitted after stop
            let done3: Uint256 = 0;
            // Per-pool forward budget = the fixed PRICE BAND for this ts (clamp(band/ts,96,maxTicks)).
            // The forward walk force-stops at the band edge (then drifts driftTicks more) so scanned3
            // and the emitted net window span the SAME band the MEASURE-B survivorship metric used.
            const bud3: Uint256 = effTicks(ts3, bandTicks, maxTicks);
            for (let k3 = 0; k3 < maxTicks; k3 = k3 + 1) {
              if (done3 === 0) {
                const argW3: Uint256 = tickArg(curShift3, OFFSET);
                const net3: Uint256 = IUniswapV3PoolFull.at(poolAddr3).ticks(argW3)[1];
                tickBlob = tickBlob.concat(abi.encode(idx3, argW3, net3));
                scanned3 = scanned3 + 1;

                const farReal3: Uint256 = stepReal(nearReal3, step3, zeroForOne);
                const nearOI3: Uint256 = toOutIn(nearReal3, zeroForOne);
                const farOI3: Uint256 = toOutIn(farReal3, zeroForOne);
                if (L3 > 0) {
                  if (nearOI3 > farOI3) {
                    const effIn3: Uint256 = Math.mulDiv(L3, Q96, farOI3) - Math.mulDiv(L3, Q96, nearOI3);
                    cumIn3 = cumIn3 + Math.mulDiv(effIn3, 1000000, 1000000 - fee3);
                  }
                }
                const isNeg3: Uint256 = net3 >= HALF128 ? 1 : 0;
                if (zeroForOne === 1) {
                  if (isNeg3 === 1) {
                    L3 = L3 + (MOD128 - net3);
                  } else {
                    L3 = L3 >= net3 ? L3 - net3 : 0;
                  }
                  curShift3 = curShift3 - ts3;
                } else {
                  if (isNeg3 === 1) {
                    const mag3: Uint256 = MOD128 - net3;
                    L3 = L3 >= mag3 ? L3 - mag3 : 0;
                  } else {
                    L3 = L3 + net3;
                  }
                  curShift3 = curShift3 + ts3;
                }
                nearReal3 = farReal3;

                // Stop test: covered amountIn OR fell to/below the floor price OR reached the
                // per-pool band edge (k3+1 forward steps taken == bud3 → stop, then drift).
                if (stop3 === 0) {
                  const fa3: Uint256 = feeAdj(farOI3, fee3);
                  let hitFloor: Uint256 = 0;
                  if (floorAdj > 0) {
                    if (fa3 <= floorAdj) {
                      hitFloor = 1;
                    }
                  }
                  if (cumIn3 >= amountIn) {
                    stop3 = 1;
                  } else {
                    if (hitFloor === 1) {
                      stop3 = 1;
                    } else {
                      if (scanned3 >= bud3) {
                        stop3 = 1;
                      }
                    }
                  }
                }
                if (stop3 === 1) {
                  drift3 = drift3 + 1;
                  if (drift3 > driftTicks) {
                    done3 = 1;
                  }
                }
              }
            }

            poolBlob = poolBlob.concat(
              abi.encode(1, poolAddr3, fee3, ts3, 0, sqrt3, liq3, tick3, 0, 0, 0, scanned3, scanRev3)
            );
            poolCount = poolCount + 1;
          }
        }
      }
      }
    }
  }

  // ── Direct V2 discovery (no ticks) ──
  for (let vi = 0; vi < v2Factories.length; vi = vi + 1) {
    const vf2: Tuple = v2Factories[vi];
    const factory2: Address = vf2[0];
    const feeV2: Uint256 = vf2[1];
    const pairAddr: Address = IUniswapV2Factory.at(factory2).getPair(tokenIn, tokenOut);
    if (pairAddr !== 0) {
      const r0: Uint256 = IUniswapV2Pair.at(pairAddr).getReserves()[0];
      const r1: Uint256 = IUniswapV2Pair.at(pairAddr).getReserves()[1];
      if (r0 > 0) {
        if (r1 > 0) {
          const t0: Address = IUniswapV2Pair.at(pairAddr).token0();
          const inIsT0: Uint256 = t0 === tokenIn ? 1 : 0;
          const reserveIn: Uint256 = inIsT0 === 1 ? r0 : r1;
          const reserveOut: Uint256 = inIsT0 === 1 ? r1 : r0;
          const synthL: Uint256 = Math.sqrt(reserveIn * reserveOut);
          // SURVIVORS ONLY: drop V2 pools below the in-range-capacity floor (matches
          // the V3/V4 gate so the lens decides V2 survivorship too). synthL>0 is the
          // ordinal gate (IDENTICAL to the measure pass); capArr[ord3] is this pool's
          // windowed capacity.
          if (synthL > 0) {
            let survV2: Uint256 = 0;
            if (capFloor === 0) {
              survV2 = 1;
            } else {
              if (capArr[ord3] >= capFloor) {
                survV2 = 1;
              }
            }
            ord3 = ord3 + 1;
            if (survV2 === 1) {
              const synthSqrt: Uint256 = Math.sqrt(Math.mulDiv(reserveOut, Q192, reserveIn));
              poolBlob = poolBlob.concat(
                abi.encode(0, pairAddr, feeV2, 0, 0, synthSqrt, synthL, 0, inIsT0, 0, 0, 0, 0)
              );
              poolCount = poolCount + 1;
            }
          }
        }
      }
    }
  }

  // ── V4 survivors (lazy walk via StateView) ──
  for (let qi3 = 0; qi3 < v4Factories.length; qi3 = qi3 + 1) {
    const vf43: Tuple = v4Factories[qi3];
    const poolManager3: Address = vf43[0];
    const stateView3: Address = vf43[1];
    for (let si3 = 0; si3 < v4Specs.length; si3 = si3 + 1) {
      const spec3: Tuple = v4Specs[si3];
      const v4fee3: Uint256 = spec3[0];
      const v4ts3: Uint256 = spec3[1];
      const v4step3: Uint256 = spec3[2];
      const idRow3: Tuple = v4PoolIds[qi3 * v4Specs.length + si3];
      const poolId3: Uint256 = idRow3[0];
      const sqrtP43: Uint256 = IStateViewFull.at(stateView3).getSlot0(poolId3)[0];
      if (sqrtP43 > 0) {
        const liq43: Uint256 = IStateViewFull.at(stateView3).getLiquidity(poolId3);
        // ALIVE (sqrt>0 && L>0) is the ordinal gate — IDENTICAL to the measure pass —
        // so capArr[ord3] is this pool's in-range capacity. SURVIVOR iff capFloor===0
        // OR capArr[ord3] >= capFloor.
        let surv4: Uint256 = 0;
        if (liq43 > 0) {
          if (capFloor === 0) {
            surv4 = 1;
          } else {
            if (capArr[ord3] >= capFloor) {
              surv4 = 1;
            }
          }
          ord3 = ord3 + 1;
        }
        if (surv4 === 1) {
          const tick43: Uint256 = IStateViewFull.at(stateView3).getSlot0(poolId3)[1];
          const idx43: Uint256 = poolCount;

          const baseRev4: Uint256 = tickShiftedBase(tick43, OFFSET, v4ts3);
          let revShift4: Uint256 = baseRev4;
          if (zeroForOne === 1) {
            revShift4 = baseRev4 + v4ts3;
          }
          let scanRev4: Uint256 = 0; // reverse boundaries walked (= count emitted)
          for (let rd4 = 0; rd4 < driftTicks; rd4 = rd4 + 1) {
            const ra4: Uint256 = tickArg(revShift4, OFFSET);
            const rn4: Uint256 = IStateViewFull.at(stateView3).getTickLiquidity(poolId3, ra4)[1];
            tickBlob = tickBlob.concat(abi.encode(idx43, ra4, rn4));
            scanRev4 = scanRev4 + 1;
            if (zeroForOne === 1) {
              revShift4 = revShift4 + v4ts3;
            } else {
              revShift4 = revShift4 - v4ts3;
            }
          }

          const baseShift4: Uint256 = tickShiftedBase(tick43, OFFSET, v4ts3);
          let curShift4: Uint256 = baseShift4;
          if (zeroForOne === 0) {
            curShift4 = baseShift4 + v4ts3;
          }
          let L4: Uint256 = liq43;
          let nearReal4: Uint256 = sqrtP43;
          let cumIn4: Uint256 = 0;
          let scanned4: Uint256 = 0;
          let stop4: Uint256 = 0;
          let drift4: Uint256 = 0;
          let done4: Uint256 = 0;
          // Per-pool forward budget = the fixed PRICE BAND for this ts (see the V3 EMIT walk).
          const bud4: Uint256 = effTicks(v4ts3, bandTicks, maxTicks);
          for (let k4 = 0; k4 < maxTicks; k4 = k4 + 1) {
            if (done4 === 0) {
              const argW4: Uint256 = tickArg(curShift4, OFFSET);
              const net4: Uint256 = IStateViewFull.at(stateView3).getTickLiquidity(poolId3, argW4)[1];
              tickBlob = tickBlob.concat(abi.encode(idx43, argW4, net4));
              scanned4 = scanned4 + 1;

              const farReal4: Uint256 = stepReal(nearReal4, v4step3, zeroForOne);
              const nearOI4: Uint256 = toOutIn(nearReal4, zeroForOne);
              const farOI4: Uint256 = toOutIn(farReal4, zeroForOne);
              if (L4 > 0) {
                if (nearOI4 > farOI4) {
                  const effIn4: Uint256 = Math.mulDiv(L4, Q96, farOI4) - Math.mulDiv(L4, Q96, nearOI4);
                  cumIn4 = cumIn4 + Math.mulDiv(effIn4, 1000000, 1000000 - v4fee3);
                }
              }
              const isNeg4: Uint256 = net4 >= HALF128 ? 1 : 0;
              if (zeroForOne === 1) {
                if (isNeg4 === 1) {
                  L4 = L4 + (MOD128 - net4);
                } else {
                  L4 = L4 >= net4 ? L4 - net4 : 0;
                }
                curShift4 = curShift4 - v4ts3;
              } else {
                if (isNeg4 === 1) {
                  const mag4: Uint256 = MOD128 - net4;
                  L4 = L4 >= mag4 ? L4 - mag4 : 0;
                } else {
                  L4 = L4 + net4;
                }
                curShift4 = curShift4 + v4ts3;
              }
              nearReal4 = farReal4;

              if (stop4 === 0) {
                const fa4: Uint256 = feeAdj(farOI4, v4fee3);
                let hitFloor4: Uint256 = 0;
                if (floorAdj > 0) {
                  if (fa4 <= floorAdj) {
                    hitFloor4 = 1;
                  }
                }
                if (cumIn4 >= amountIn) {
                  stop4 = 1;
                } else {
                  if (hitFloor4 === 1) {
                    stop4 = 1;
                  } else {
                    if (scanned4 >= bud4) {
                      stop4 = 1;
                    }
                  }
                }
              }
              if (stop4 === 1) {
                drift4 = drift4 + 1;
                if (drift4 > driftTicks) {
                  done4 = 1;
                }
              }
            }
          }

          poolBlob = poolBlob.concat(
            abi.encode(2, poolManager3, v4fee3, v4ts3, 0, sqrtP43, liq43, tick43, 0, stateView3, poolId3, scanned4, scanRev4)
          );
          poolCount = poolCount + 1;
        }
      }
    }
  }

  // Prepend the 4-word HEADER so the decoder reads survivorship straight from the
  // lens (single source of truth): discoveredCount, survivorCount (= poolCount),
  // totalCap (Σ in-range capacity), capFloor (the in-range-capacity threshold).
  // Every row after the header is a survivor.
  const header: bytes = abi.encode(discovered, poolCount, totalCap, capFloor);
  return abi.encode(header.concat(poolBlob), tickBlob);
}
