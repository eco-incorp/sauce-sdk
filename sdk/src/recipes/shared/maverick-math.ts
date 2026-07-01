/**
 * Maverick V2 (bin-based directional AMM) — VERBATIM bigint replay + off-chain segment sampler.
 *
 * THE SINGLE SOURCE for Maverick V2 swap math. Imported by BOTH:
 *   - the production `prepare.ts` (buildMaverickSegments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (maverickSegments),
 * so the split is exact-on-grid vs the oracle by construction (one replay), and the per-pool
 * executed dy == the on-chain quoter calculateSwap(awarded share) to the wei (one atomic engine
 * swap → _swapMaverickV2, verified in the EVM test).
 *
 * THE BIN MATH IS OFF-CHAIN ONLY (for the SPLIT). Maverick's bins do NOT map to the drift-invariant
 * liquidityNet tick walk (bin liquidity is re-derived per tick from (reserveA,reserveB) and the
 * pool has dynamic-distribution kinds), so Maverick is a SAMPLED-SEGMENT source (like DODO/Curve):
 * prepare samples the curve into monotone descending-marginal segments for the split, and execution
 * goes through the ENGINE (SwapPoolType.MaverickV2 = 7 → _swapMaverickV2 → pool.swap +
 * maverickV2SwapCallback). Maverick is a CALLBACK pool (the pool re-enters maverickV2SwapCallback
 * mid-swap to pull input), so it MUST execute through the engine Router — it can NOT be executed
 * callback-free the way Solidly/Wombat/Euler are. The on-chain solver never recomputes the bin math;
 * it consumes the STATIC segments through the existing static-segment cursor and dispatches on
 * segKind 8.
 *
 * SOURCE MIRRORED — the canonical Maverick V2 `SwapMath` + `TickMath` (maverickprotocol/v2-common
 * contracts/libraries; ported bit-for-bit from the yldfi/maverick-v2-math reference, itself a
 * ParaSwap-cross-checked port of the on-chain PoolLib.swap tick loop). The integer routines
 * reproduced here:
 *   - `tickSqrtPrice(tickSpacing, tick)`  — the 1.0001^(tick·tickSpacing) sqrt-price ladder (the
 *     Uniswap-style 128.128 pow shifted to 1e18 fixed point).
 *   - `getTickL(reserveA, reserveB, sqrtLower, sqrtUpper)` — the per-tick liquidity L from the tick's
 *     (reserveA, reserveB) and its sqrt-price bounds (the concentrated-liquidity quadratic).
 *   - `computeSwapExactIn(sqrtPrice, tickData, amountIn, tokenAIn, fee, protocolFeeD3, sqrtLower,
 *     sqrtUpper)` — the WITHIN-TICK swap (drain-or-partial, directional fee, protocol-fee net, end
 *     price + output). tokenA-in: endSqrtP = in/L + sqrtP ; tokenB-in: endSqrtP = L/(in + L/sqrtP).
 *   - `simulateSwapExactIn` — the multi-tick walk (walk one tick at a time in the swap direction,
 *     draining each tick's available output until amountIn is consumed or the tick limit hit).
 * All fixed point is 1e18 (`ONE`); the fee is 1e18-scaled DIRECTIONAL (feeAIn charged on tokenA-in,
 * feeBIn on tokenB-in); protocolFeeD3 is a 3-decimal (per-mille) protocol fee proportion.
 *
 * The replay runs purely on the read pool state (activeTick / poolSqrtPrice / protocolFeeRatioD3 +
 * the per-tick (reserveA,reserveB) around the active tick + the two directional fees + tickSpacing);
 * buildMaverickSegments makes NO extra RPC. The tick walk is BOUNDED (a fixed tick-search limit),
 * so there is no unbounded loop.
 *
 * WEI-EXACT BOUND. The SPLIT (per-pool awarded input) is EXACT-ON-GRID vs the oracle (both replay the
 * SAME buildMaverickSegments grid — one source — so the awarded share matches the oracle bit-for-bit).
 * The realized dy is EXACT: the per-pool out for the awarded slice is the ENGINE swap, which the EVM
 * test asserts == the on-chain MaverickV2Quoter.calculateSwap(awarded) to the wei (the same
 * on-chain-view-is-the-swap-math standard as DODO's querySell* / Solidly's getAmountOut). The sampler
 * drives only the SPLIT; the realized dy is the engine swap.
 *
 * Sources:
 *   https://github.com/maverickprotocol/v2-common/blob/main/contracts/libraries/TickMath.sol
 *   https://github.com/maverickprotocol/v2-common/blob/main/contracts/libraries/PoolLib.sol
 *   https://github.com/maverickprotocol/maverick-v2-examples/blob/main/solidity/src/interfaces/IMaverickV2Pool.sol
 *   https://github.com/yldfi/maverick-v2-math  (bigint reference port: swapMath.ts / tickMath.ts / pool.ts)
 */

/** 2^192 — the unified out/in sqrt fixed-point scale (matches ecoswap.math / dodo-math / curve-math Q192). */
export const Q192 = 1n << 192n;

/** Maverick fixed-point ONE — 1e18. */
export const MAV_ONE = 1_000_000_000_000_000_000n;
const ONE_SQUARED = MAV_ONE * MAV_ONE;
/** Protocol-fee fixed point (per-mille — 3 decimals). */
const ONE_D3 = 1_000n;
/** Max sub-tick magnitude (tickSpacing·|tick|) the sqrt-price ladder supports. */
const MAX_TICK = 322_378;

/** Integer square root (Babylonian) — bit-identical to dodo-math / curve-math / ecoswap.math `isqrt`. */
export function isqrt(x: bigint): bigint {
  if (x <= 0n) return 0n;
  let z = x;
  let y = (z + 1n) / 2n;
  while (y < z) {
    z = y;
    y = (x / y + y) / 2n;
  }
  return z;
}

// ── Math helpers — verbatim Maverick `Math` rounding (1e18) ──────────────────

function min(x: bigint, y: bigint): bigint {
  return x < y ? x : y;
}
/** clip(x,y) = max(x-y, 0) — Maverick's saturating subtract. */
function clip(x: bigint, y: bigint): bigint {
  return x < y ? 0n : x - y;
}
function mulDown(x: bigint, y: bigint): bigint {
  return (x * y) / MAV_ONE;
}
function divDown(x: bigint, y: bigint): bigint {
  return (x * MAV_ONE) / y;
}
function divUp(x: bigint, y: bigint): bigint {
  return (x * MAV_ONE + y - 1n) / y;
}
function mulDivDown(x: bigint, y: bigint, k: bigint): bigint {
  if (k === 0n) k = 1n;
  return (x * y) / k;
}
function mulDivCeil(x: bigint, y: bigint, k: bigint): bigint {
  if (k === 0n) k = 1n;
  const r = (x * y) / k;
  return (x * y) % k !== 0n ? r + 1n : r;
}
function mulFloor(x: bigint, y: bigint): bigint {
  return mulDivDown(x, y, MAV_ONE);
}
function invFloor(x: bigint): bigint {
  return ONE_SQUARED / x;
}
function invCeil(denominator: bigint): bigint {
  return (ONE_SQUARED - 1n) / denominator + 1n;
}

// ── TickMath — verbatim (the 1.0001^(tick·tickSpacing) sqrt-price ladder) ─────

/**
 * tickSqrtPrice(tickSpacing, tick) — the sqrt price at the LOWER edge of `tick` (1e18 fixed point),
 * mirroring Maverick TickMath.tickSqrtPrice: the Uniswap 128.128 pow of 1.0001^(|tick|·tickSpacing),
 * inverted for a positive tick, scaled to 1e18. `1.0001^tickSpacing` is the bin width.
 */
export function tickSqrtPrice(tickSpacing: number, tick: number): bigint {
  const absTick = BigInt(Math.abs(tick) * tickSpacing);
  if (absTick > BigInt(MAX_TICK)) throw new Error(`TickMaxExceeded: ${tick}`);

  let ratio: bigint =
    absTick & 0x1n ? 0xfffcb933bd6fad9d3af5f0b9f25db4d6n : 0x100000000000000000000000000000000n;
  if (absTick & 0x2n) ratio = (ratio * 0xfff97272373d41fd789c8cb37ffcaa1cn) >> 128n;
  if (absTick & 0x4n) ratio = (ratio * 0xfff2e50f5f656ac9229c67059486f389n) >> 128n;
  if (absTick & 0x8n) ratio = (ratio * 0xffe5caca7e10e81259b3cddc7a064941n) >> 128n;
  if (absTick & 0x10n) ratio = (ratio * 0xffcb9843d60f67b19e8887e0bd251eb7n) >> 128n;
  if (absTick & 0x20n) ratio = (ratio * 0xff973b41fa98cd2e57b660be99eb2c4an) >> 128n;
  if (absTick & 0x40n) ratio = (ratio * 0xff2ea16466c9838804e327cb417cafcbn) >> 128n;
  if (absTick & 0x80n) ratio = (ratio * 0xfe5dee046a99d51e2cc356c2f617dbe0n) >> 128n;
  if (absTick & 0x100n) ratio = (ratio * 0xfcbe86c7900aecf64236ab31f1f9dcb5n) >> 128n;
  if (absTick & 0x200n) ratio = (ratio * 0xf987a7253ac4d9194200696907cf2e37n) >> 128n;
  if (absTick & 0x400n) ratio = (ratio * 0xf3392b0822b88206f8abe8a3b44dd9ben) >> 128n;
  if (absTick & 0x800n) ratio = (ratio * 0xe7159475a2c578ef4f1d17b2b235d480n) >> 128n;
  if (absTick & 0x1000n) ratio = (ratio * 0xd097f3bdfd254ee83bdd3f248e7e785en) >> 128n;
  if (absTick & 0x2000n) ratio = (ratio * 0xa9f746462d8f7dd10e744d913d033333n) >> 128n;
  if (absTick & 0x4000n) ratio = (ratio * 0x70d869a156ddd32a39e257bc3f50aa9bn) >> 128n;
  if (absTick & 0x8000n) ratio = (ratio * 0x31be135f97da6e09a19dc367e3b6da40n) >> 128n;
  if (absTick & 0x10000n) ratio = (ratio * 0x9aa508b5b7e5a9780b0cc4e25d61a56n) >> 128n;
  if (absTick & 0x20000n) ratio = (ratio * 0x5d6af8dedbcb3a6ccb7ce618d14225n) >> 128n;
  if (absTick & 0x40000n) ratio = (ratio * 0x2216e584f630389b2052b8db590en) >> 128n;

  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio * MAV_ONE) >> 128n;
}

/** The sqrt-price bounds [lower, upper] of `tick` (its lower edge and the next tick's lower edge). */
export function tickSqrtPrices(
  tickSpacing: number,
  tick: number,
): { sqrtLowerPrice: bigint; sqrtUpperPrice: bigint } {
  return {
    sqrtLowerPrice: tickSqrtPrice(tickSpacing, tick),
    sqrtUpperPrice: tickSqrtPrice(tickSpacing, tick + 1),
  };
}

/**
 * getTickL(reserveA, reserveB, sqrtLower, sqrtUpper) — the tick's concentrated-liquidity L from its
 * (reserveA, reserveB) and its sqrt-price bounds, mirroring Maverick TickMath.getTickL bit-for-bit
 * (the precision-bump + quadratic root). L is the coefficient in the within-tick swap formulas.
 */
export function getTickL(
  reserveA: bigint,
  reserveB: bigint,
  sqrtLowerTickPrice: bigint,
  sqrtUpperTickPrice: bigint,
): bigint {
  const diff = sqrtUpperTickPrice - sqrtLowerTickPrice;
  if (diff <= 0n) return 0n;

  let precisionBump = 0n;
  let rA = reserveA;
  let rB = reserveB;
  if (rA >> 78n === 0n && rB >> 78n === 0n) {
    precisionBump = 57n;
    rA <<= precisionBump;
    rB <<= precisionBump;
  }

  if (rB === 0n) return divDown(rA, diff) >> precisionBump;
  if (rA === 0n) return mulDivDown(mulDown(rB, sqrtLowerTickPrice), sqrtUpperTickPrice, diff) >> precisionBump;

  const b = (divDown(rA, sqrtUpperTickPrice) + mulDown(rB, sqrtLowerTickPrice)) >> 1n;
  const bSquared = (b * b) / MAV_ONE;
  const aTimesB = mulFloor(rB, rA);
  const inner = bSquared + (aTimesB * diff) / sqrtUpperTickPrice;
  const sqrtInner = isqrt(inner) * 1_000_000_000n;
  return mulDivDown(b + sqrtInner, sqrtUpperTickPrice, diff) >> precisionBump;
}

/**
 * getSqrtPrice(reserveA, reserveB, sqrtLower, sqrtUpper, L) — the current sqrt price WITHIN a tick
 * from its reserves and L, mirroring Maverick TickMath.getSqrtPrice. Used to seed the walk's starting
 * price from the active tick's reserves (clamped to the tick bounds).
 */
export function getSqrtPrice(
  reserveA: bigint,
  reserveB: bigint,
  sqrtLowerTickPrice: bigint,
  sqrtUpperTickPrice: bigint,
  liquidity: bigint,
): bigint {
  if (reserveA === 0n) return sqrtLowerTickPrice;
  if (reserveB === 0n) return sqrtUpperTickPrice;
  const num = reserveA + mulDown(liquidity, sqrtLowerTickPrice);
  const den = reserveB + divDown(liquidity, sqrtUpperTickPrice);
  if (den === 0n) return sqrtLowerTickPrice;
  const sqrtPrice = isqrt(MAV_ONE * ((num * MAV_ONE) / den));
  if (sqrtPrice < sqrtLowerTickPrice) return sqrtLowerTickPrice;
  if (sqrtPrice > sqrtUpperTickPrice) return sqrtUpperTickPrice;
  return sqrtPrice;
}

// ── SwapMath — the WITHIN-TICK exact-in swap (verbatim) ──────────────────────

interface TickDataInput {
  currentReserveA: bigint;
  currentReserveB: bigint;
  currentLiquidity: bigint;
}
interface SwapTickResult {
  deltaInErc: bigint;
  deltaOutErc: bigint;
  excess: bigint;
  endSqrtPrice: bigint;
  swappedToMaxPrice: boolean;
}

/** amountToBinNetOfProtocolFee — clip(deltaInErc, ceil(feeBasis·protocolFeeD3/1000)); unused for out. */
function amountToBinNetOfProtocolFee(deltaInErc: bigint, feeBasis: bigint, protocolFeeD3: bigint): bigint {
  if (protocolFeeD3 === 0n) return deltaInErc;
  return clip(deltaInErc, mulDivCeil(feeBasis, protocolFeeD3, ONE_D3));
}

/**
 * computeSwapExactIn — the WITHIN-TICK swap for `amountIn` tokenIn, mirroring Maverick
 * SwapMath.computeSwapExactIn + computeEndPrice bit-for-bit. Returns the erc-scale input consumed
 * (deltaInErc, INCLUDING the fee), the output paid (deltaOutErc), the un-consumed excess (drives the
 * tick walk), the end sqrt price, and whether the tick fully drained (swappedToMaxPrice).
 *   tokenA-in : endSqrtP = sqrtP + in/L                   (price rises)
 *   tokenB-in : endSqrtP = 1/(in/L + 1/sqrtP) = L/(in + L/sqrtP)   (price falls)
 * `fee` is the DIRECTIONAL 1e18-scaled swap fee (feeAIn for tokenA-in, feeBIn for tokenB-in).
 */
export function computeSwapExactIn(
  sqrtPrice: bigint,
  tickData: TickDataInput,
  amountIn: bigint,
  tokenAIn: boolean,
  fee: bigint,
  protocolFeeD3: bigint,
  sqrtLowerTickPrice: bigint,
  sqrtUpperTickPrice: bigint,
): SwapTickResult {
  const L = tickData.currentLiquidity;
  if (L === 0n || amountIn === 0n) {
    return { deltaInErc: 0n, deltaOutErc: 0n, excess: amountIn, endSqrtPrice: sqrtPrice, swappedToMaxPrice: false };
  }

  const availableOutput = tokenAIn ? tickData.currentReserveB : tickData.currentReserveA;

  // Input (net of fee) needed to drain the tick to its far edge.
  let binAmountIn: bigint;
  if (tokenAIn) {
    binAmountIn = (L * (sqrtUpperTickPrice - sqrtPrice)) / MAV_ONE;
  } else {
    const invSqrtPrice = ONE_SQUARED / sqrtPrice;
    const invSqrtLower = ONE_SQUARED / sqrtLowerTickPrice;
    binAmountIn = clip((L * invSqrtLower) / MAV_ONE - (L * invSqrtPrice) / MAV_ONE, 0n);
  }

  let deltaInErc: bigint;
  let feeBasis: bigint;
  let excess = 0n;
  let binAmountInFinal: bigint;

  const feeBasisDrain = mulDivCeil(binAmountIn, fee, MAV_ONE - fee);
  const deltaInErcDrain = binAmountIn + feeBasisDrain;

  if (amountIn < deltaInErcDrain) {
    // Not draining — the user's whole input fits within this tick.
    const userBinAmountIn = mulDown(amountIn, MAV_ONE - fee);
    binAmountInFinal = userBinAmountIn;
    deltaInErc = amountIn;
    feeBasis = deltaInErc - userBinAmountIn;
  } else {
    // Draining — the tick is fully consumed, the remainder overflows to the next tick.
    binAmountInFinal = binAmountIn;
    feeBasis = feeBasisDrain;
    deltaInErc = deltaInErcDrain;
    excess = amountIn - deltaInErcDrain;
  }

  amountToBinNetOfProtocolFee(deltaInErc, feeBasis, protocolFeeD3); // parity (protocol-fee net; output unaffected)

  if (excess !== 0n) {
    const endSqrtPrice = tokenAIn ? sqrtUpperTickPrice : sqrtLowerTickPrice;
    return { deltaInErc, deltaOutErc: availableOutput, excess, endSqrtPrice, swappedToMaxPrice: true };
  }

  let endSqrtPrice: bigint;
  if (tokenAIn) {
    endSqrtPrice = sqrtPrice + divDown(binAmountInFinal, L);
    if (endSqrtPrice > sqrtUpperTickPrice) endSqrtPrice = sqrtUpperTickPrice;
  } else {
    const inv = divDown(binAmountInFinal, L) + invFloor(sqrtPrice);
    endSqrtPrice = inv > 0n ? invFloor(inv) : sqrtLowerTickPrice;
    if (endSqrtPrice < sqrtLowerTickPrice) endSqrtPrice = sqrtLowerTickPrice;
  }

  const inOverL = divUp(binAmountInFinal, L + 1n);
  let deltaOutErc: bigint;
  if (tokenAIn) {
    deltaOutErc = mulDivDown(binAmountInFinal, invFloor(sqrtPrice), inOverL + sqrtPrice);
  } else {
    deltaOutErc = mulDivDown(binAmountInFinal, sqrtPrice, inOverL + invCeil(sqrtPrice));
  }
  deltaOutErc = min(deltaOutErc, availableOutput);

  return {
    deltaInErc,
    deltaOutErc,
    excess,
    endSqrtPrice,
    swappedToMaxPrice: endSqrtPrice === sqrtUpperTickPrice || endSqrtPrice === sqrtLowerTickPrice,
  };
}

// ── Discovered-pool descriptor + the multi-tick walk ─────────────────────────

/** One tick's live reserves (reserveA, reserveB) for the swap walk (from pool.getTick(tick)). */
export interface MaverickTick {
  tick: number;
  reserveA: bigint;
  reserveB: bigint;
}

/**
 * One discovered Maverick V2 pool, oriented for a tokenIn → tokenOut swap.
 *
 * The engine `_swapMaverickV2` resolves the swap direction ON-CHAIN (it reads the pool's `tokenA()`
 * and sets `tokenAIn = (tokenIn == tokenA)`), and calls `pool.swap(recipient, SwapParams{amount,
 * tokenAIn, exactOutput:false, tickLimit:0}, "")`. So the on-chain SwapParams carry ONLY {pool,
 * tokenIn, tokenOut, amountSpecified, payer, recipient}. The fields here are OFF-CHAIN ONLY — they
 * feed buildMaverickSegments (the price/capacity replay). `tokenAIn` tags the direction (tokenIn ==
 * tokenA ⇒ tokenA is the input ⇒ price rises through ticks; else tokenB-in ⇒ price falls). `fee` is
 * the DIRECTIONAL fee for THIS direction (feeAIn if tokenAIn, else feeBIn). `ticks` are the live
 * per-tick reserves around the active tick, in ASCENDING tick order.
 *
 * ENGINE tickLimit CONSTRAINT. The engine hardcodes `tickLimit: 0`. Real Maverick treats tickLimit as
 * "the furthest tick the swap will execute in" (type(int32).max/min for no limit). tickLimit=0 caps a
 * tokenA-in (price-rising) swap AT tick 0 and reverts if the pool's active tick already exceeds 0
 * (PoolCurrentTickBeyondSwapLimit). So the engine path only fills correctly for a tokenA-in swap whose
 * active tick is <= 0 (walking UP toward tick 0), or a tokenB-in swap whose active tick is >= 0
 * (walking DOWN toward tick 0). buildMaverickSegments applies the SAME tickLimit=0 in its walk (so the
 * sampler and the engine agree), and prepare/discovery gate a pool OUT of the executable set when the
 * live active tick sits on the wrong side of 0 for its direction (the swap would revert / not fill).
 */
export interface MaverickPool {
  /** Always SwapPoolType.MaverickV2 (=7) — execution dispatches via swap(SwapParams{poolType:7}). */
  poolType: number;
  /** Pool address — the swap(SwapParams{poolType:7, pool}) target. */
  address: `0x${string}`;
  /** true => tokenIn == the pool's tokenA (tokenA is the input; price rises). Engine resolves on-chain. */
  tokenAIn: boolean;
  /** Live active tick (State.activeTick). Seeds the walk's starting tick. */
  activeTick: number;
  /** Live pool sqrt price (1e18) — the walk's starting price within the active tick. */
  poolSqrtPrice: bigint;
  /** Bin width exponent: 1.0001^tickSpacing is the bin width (pool.tickSpacing()). */
  tickSpacing: number;
  /** DIRECTIONAL swap fee for THIS direction (1e18-scaled; feeAIn if tokenAIn, else feeBIn). */
  fee: bigint;
  /** Protocol fee proportion (3-decimal / per-mille; State.protocolFeeRatioD3). */
  protocolFeeD3: bigint;
  /** Live per-tick reserves around the active tick, ASCENDING tick order (from getTick). */
  ticks: MaverickTick[];
  /** Rounded ppm fee (the price-ordering coordinate / diagnostic). */
  feePpm: number;
  /** Discovery source label. */
  source: string;
}

/**
 * The engine's hardcoded swap tick limit. `_swapMaverickV2` always passes `tickLimit: 0`, so a
 * tokenA-in swap stops at tick 0 (price rising toward tick 0) and a tokenB-in swap stops at tick 0
 * (price falling toward tick 0). The sampler applies the SAME limit so its output matches the engine.
 */
export const MAVERICK_ENGINE_TICK_LIMIT = 0;

/** Fixed tick-walk bound (mirrors the reference TICK_SEARCH_LIMIT). No unbounded loop. */
const TICK_SEARCH_LIMIT = 200;

/**
 * Walk the pool's live ticks in the swap direction, replaying `computeSwapExactIn` per tick, and
 * return the exact tokens-out for `amountIn` tokenIn AND the tokenIn actually consumed (which may be
 * LESS than `amountIn` when the tick limit / available liquidity binds). Mirrors Maverick
 * `Pool.swap`'s tick loop (via the yldfi `simulateSwapExactIn` reference) with the ENGINE tickLimit=0.
 *
 * Direction: tokenA-in walks tick UP (+1 per step), price rises; tokenB-in walks tick DOWN (-1),
 * price falls. The loop breaks when the tick crosses `tickLimit` (the engine's 0), matching how the
 * engine's swap terminates — so `getDy` returns exactly what the engine swap consumes/pays.
 */
export function simulateMaverickExactIn(
  pool: MaverickPool,
  amountIn: bigint,
  tickLimit: number = MAVERICK_ENGINE_TICK_LIMIT,
): { amountIn: bigint; amountOut: bigint } {
  if (amountIn <= 0n) return { amountIn: 0n, amountOut: 0n };
  const { tokenAIn, tickSpacing, fee, protocolFeeD3 } = pool;

  // Index the live ticks by tick number.
  const byTick = new Map<number, MaverickTick>();
  for (const t of pool.ticks) byTick.set(t.tick, t);

  let remainingIn = amountIn;
  let totalOut = 0n;
  let currentSqrtPrice = pool.poolSqrtPrice;
  let currentTick = pool.activeTick;
  const direction = tokenAIn ? 1 : -1;

  let iterations = 0;
  while (remainingIn > 0n && iterations < TICK_SEARCH_LIMIT) {
    // Engine tickLimit gate: a tokenA-in swap stops once the tick exceeds the limit; tokenB-in once
    // it falls below. This is the on-chain `_swapMaverickV2` tickLimit=0 behaviour.
    if (tokenAIn && currentTick > tickLimit) break;
    if (!tokenAIn && currentTick < tickLimit) break;

    const absTick = Math.abs(currentTick) * tickSpacing;
    if (absTick > MAX_TICK) break;

    const { sqrtLowerPrice, sqrtUpperPrice } = tickSqrtPrices(tickSpacing, currentTick);

    if (currentSqrtPrice < sqrtLowerPrice || currentSqrtPrice > sqrtUpperPrice) {
      currentTick += direction;
      iterations++;
      continue;
    }

    const ts = byTick.get(currentTick);
    if (!ts || (ts.reserveA === 0n && ts.reserveB === 0n)) {
      currentTick += direction;
      iterations++;
      continue;
    }

    const liquidity = getTickL(ts.reserveA, ts.reserveB, sqrtLowerPrice, sqrtUpperPrice);
    if (liquidity === 0n) {
      currentTick += direction;
      iterations++;
      continue;
    }

    const result = computeSwapExactIn(
      currentSqrtPrice,
      { currentReserveA: ts.reserveA, currentReserveB: ts.reserveB, currentLiquidity: liquidity },
      remainingIn,
      tokenAIn,
      fee,
      protocolFeeD3,
      sqrtLowerPrice,
      sqrtUpperPrice,
    );

    totalOut += result.deltaOutErc;
    remainingIn = result.excess;
    currentSqrtPrice = result.endSqrtPrice;

    if (!result.swappedToMaxPrice || remainingIn === 0n) break;
    currentTick += direction;
    iterations++;
  }

  return { amountIn: amountIn - remainingIn, amountOut: totalOut };
}

/**
 * getDy(pool, amountIn) — the EXACT tokens-out the Maverick pool pays for `amountIn` tokenIn, walking
 * the live tick book with the engine's tickLimit=0. This is the sampler's per-slice output AND the
 * value the EVM test cross-checks against the on-chain MaverickV2Quoter.calculateSwap(amountIn). The
 * realized dy from the engine swap equals this (the quoter IS the swap math).
 */
export function getDy(pool: MaverickPool, amountIn: bigint): bigint {
  return simulateMaverickExactIn(pool, amountIn).amountOut;
}

/**
 * maxInput(pool) — the largest tokenIn the pool can absorb under the engine tickLimit=0 (the point at
 * which the walk stops consuming). prepare caps the sampled range at this so no segment promises depth
 * the engine swap cannot fill (a tokenIn slice beyond it would be left unspent + terminal-refunded).
 */
export function maxInput(pool: MaverickPool, probe: bigint): bigint {
  return simulateMaverickExactIn(pool, probe).amountIn;
}

/**
 * One sampled Maverick segment in unified out/in price space — identical shape to a Curve / DODO /
 * route segment (a flat [capacity, marginalOI] slice). `capacity` is the Δinput (tokenIn) for this
 * slice, `effOut` the Δoutput, `marginalOI` the unified out/in sqrt = isqrt(effOut·2^192/capacity)
 * — the price-ordering coordinate. Segments are emitted in DESCENDING `marginalOI` order (the natural
 * order of a convex curve: the first marginal slice is the best-priced). marginalOI is computed from
 * the POST-FEE dy (getDy nets the directional fee), so it is ALREADY the fee-adjusted execution price
 * — it enters the merge's descending sort directly, exactly like Curve / DODO segments.
 */
export interface MaverickSegment {
  /** Δinput (tokenIn) to traverse this slice. */
  capacity: bigint;
  /** Δoutput (tokenOut) over this slice. */
  effOut: bigint;
  /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
  marginalOI: bigint;
}

/** Default sample count per Maverick pool (M). Tunable; M≈24 tightens the grid bound. */
export const MAVERICK_SAMPLES = Number(process.env.ECO_MAVERICK_SAMPLES ?? 24);

/**
 * Sample a Maverick V2 pool into M descending-marginal segments over [0, min(amountIn, maxInput)].
 *
 * BOUND BY THE TICK-LIMIT DEPTH: the sampled range is capped at the pool's `maxInput` (the tokenIn the
 * engine swap can consume before tickLimit=0 stops it) so no segment promises depth the engine cannot
 * fill. Geometric-ish cumulative inputs (∝ s^2 — denser near 0 where the curve is steepest), each
 * replayed through getDy on the READ tick book (NO extra RPC — pure bigint). Each increment becomes a
 * (capacity=Δin, effOut=Δout, marginalOI) segment. The samples are monotone in input so the marginals
 * are naturally descending (a convex out(in)); a non-decreasing marginal (rounding noise near
 * saturation, or past the pool's effective depth) is dropped so the merge stays strictly price-ordered.
 *
 * Exact-on-grid: the split equalizes marginals on THIS sampled grid; the per-pool dy for the awarded Σ
 * share is realized wei-exact by ONE atomic engine swap (_swapMaverickV2) at execution, cross-checked
 * against the on-chain quoter. Mirrors `buildDodoSegments` / `buildCurveSegments` (same squared-index
 * geometric grid + strictly-descending guard).
 */
export function buildMaverickSegments(
  pool: MaverickPool,
  amountIn: bigint,
  samples: number = MAVERICK_SAMPLES,
): MaverickSegment[] {
  if (amountIn <= 0n) return [];
  // Cap at the depth the engine tickLimit=0 walk can actually consume.
  const consumable = maxInput(pool, amountIn);
  const cap = consumable > 0n && consumable < amountIn ? consumable : amountIn;
  if (cap <= 0n) return [];
  const M = BigInt(samples);
  const segs: MaverickSegment[] = [];
  let prevIn = 0n;
  let prevOut = 0n;
  for (let s = 1; s <= samples; s++) {
    const ss = BigInt(s);
    const input = (cap * ss * ss) / (M * M);
    if (input <= prevIn) continue;
    const out = getDy(pool, input);
    if (out <= 0n) continue;
    const dIn = input - prevIn;
    const dOut = out - prevOut;
    if (dIn > 0n && dOut > 0n) {
      const marginalOI = isqrt((dOut * Q192) / dIn);
      if (marginalOI > 0n && (segs.length === 0 || marginalOI <= segs[segs.length - 1].marginalOI)) {
        segs.push({ capacity: dIn, effOut: dOut, marginalOI });
      }
    }
    prevIn = input;
    prevOut = out;
  }
  return segs;
}

/** Round a Maverick directional fee (1e18-scaled, e.g. 1e15 = 0.1%) to a ppm fee (price-ordering coord). */
export function maverickFeeToPpm(feeWad: bigint): number {
  return Number((feeWad * 1_000_000n + MAV_ONE / 2n) / MAV_ONE);
}
