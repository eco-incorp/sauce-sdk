import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";
import { IUniswapV3PoolFull } from "./IUniswapV3PoolFull.json";
import { IStateViewFull } from "./IStateViewFull.json";
import { IUniswapV2Pair } from "./IUniswapV2Pair.json";
import { IKyberPool } from "./IKyberPool.json";
import { IDODOPool } from "./IDODOPool.json";
import { ISolidlyStablePool } from "./ISolidlyStablePool.json";
import { IWombatPool } from "./IWombatPool.json";
import { IEulerSwapPool } from "./IEulerSwapPool.json";
import { ICryptoSwapPool } from "./ICryptoSwapPool.json";
import { ICryptoSwapPoolQL } from "./ICryptoSwapPoolQL.json";
import { ICurveStableSwap } from "./ICurveStableSwap.json";
import { IWooFiPool } from "./IWooFiPool.json";
import { ILBPair } from "./ILBPair.json";
import { IFermiPool } from "./IFermiPool.json";
import { IFluidDexPool } from "./IFluidDexPool.json";
import { IFluidDexResolver } from "./IFluidDexResolver.json";
import { IMentoBroker } from "./IMentoBroker.json";
import { IBalancerV3Router } from "./IBalancerV3Router.json";
import { IPermit2 } from "./IPermit2.json";

// EcoSwap on-chain solver — FLAT-UNIVERSE multihop LIVE walk (direct pools + routes).
//
// ONE price-ordered merge splits ONE swap across {direct pools} ∪ {multi-hop routes} so the
// POST-FEE MARGINAL out/in price equalizes across every venue that receives input. Every DIRECT
// pool (universe indices [0, directCount)) walks ONE frontier from its LIVE spot, deeper, one
// tickSpacing per step. A ROUTE (A→X→B) is a COMPOSITE venue: each LEG is a SET of leg pools
// (universe indices [base, base+count), appended after the direct pools), and the route head is
// the LEFT-TO-RIGHT product fold (composeStep) of the per-leg best fee-adjusted out/in heads, so
// it competes in the SAME bestPrice comparison as a direct pool. Advancing a route = the binding-
// leg event (routeEventN inlined over legCount): the binding leg's winning pool crosses one bracket
// (the existing per-pool tick step), every other leg partially fills with conservation at every
// intermediate (leg i out == leg i+1 in). N-hop (2-hop + 3-hop the same loop). The result is the
// optimal equalized split — exact (global price order), lazy (only
// reconstructs as cum needs), and wei-exact with the neutral optimal oracle (ecoswap.optimal.ts:
// pools + routeSegments in ONE descending-price merge) — see also ecoswap.solver-reference.ts.
//
// THE UNIFIED MODEL (one walk, no two-mode cache-vs-re-anchor split):
//   A tick's liquidityNet is invariant under SWAPS: a spot-price move does not change any tick's
//   net. So the solver ALWAYS computes sqrt/price on the LIVE grid (stepReal from the live spot —
//   identical to the oracle's v3Segments/legBrackets) and reuses the cached NET only: a cache
//   lookup for an in-window boundary, a ticks()/getTickLiquidity() staticcall for an out-of-window
//   boundary. Same grid, same nets ⇒ wei-exact with the oracle BY CONSTRUCTION, for any PRICE
//   drift in either direction. LIMITATION — swaps only: an LP mint/burn between prepare and cook
//   DOES change nets, and an in-window boundary is NOT re-read on-chain, so its cached net goes
//   stale until a re-prepare (out-of-window boundaries staticcall live and are immune). The cache
//   is a pure gas optimization (windowTop=0 ⇒ every boundary staticcalls ⇒ the 1-RPC quote path
//   with no prepared ticks).
//
// PER-POOL SWAP DIRECTION FROM pd[7]: a route leg's hop direction (zHop) can differ from the
//   overall swap direction, so the solver drives toOutIn/stepReal/tickArg/seed PER POOL from that
//   pool's inIsToken0 field pd[7] (== that pool's zeroForOne) — NOT a top-level zeroForOne. A leg
//   pool is therefore byte-identical to a direct pool and reuses the per-pool frontier code.
//
// WALK-THROUGH GAPS (interior L==0): a pool is NEVER deactivated while liquidity is known ahead.
//   A step deactivates ONLY on the price limit, the per-pool budget cap, or (dL==0 AND past the
//   pool's deepest initialized tick extremeShifted). Interior L==0 gaps keep walking.
//
// COMPUTE-THEN-PULL: the merge is read-only (slot0 / getReserves / ticks / getTickLiquidity
//   staticcalls only), so we first compute exactly how much tokenIn the swaps will consume (cum),
//   then transferFrom the caller EXACTLY that. Direct pools swap their inp[]; routes swap their
//   rinp[] tokenIn->X then read the REALIZED intermediate balance and swap X->tokenOut. One
//   guarded terminal refund returns the only possible leftover (the limit-price edge).
//
// Inputs (precomputed off-chain in prepare.ts; layout built by index.ts buildPoolUniverseAndRouting):
//   cfg         = [tokenIn, tokenOut, amountIn, caller, priceLimit, directCount, fluidResolver?,
//                 mentoBroker?, balancerV3Router?, minOut?] — ONE scalar tuple (the lens trick:
//                 keeps main() at 4 params so the v12 arg-prologue SDUP window stays small).
//                 directCount = number of leading universe entries that are DIRECT venues (==
//                 prepared.pools.length); entries [directCount, …) are leg-only. cfg[6..9] are
//                 OPTIONAL trailing scalars (guarded by cfg.length): the chain-wide Fluid resolver,
//                 Mento broker, Balancer-V3 router, and cfg[9] = the internal whole-trade
//                 amountOutMin FLOOR (0 ⇒ no floor ⇒ byte-identical to the pre-floor solver).
//   pools[i]    = [poolType, address, fee, tickSpacing, hooks, feePpm, isV2, inIsToken0,
//                  stateView, poolId, stepRatio, windowTopShifted, windowBotShifted,
//                  extremeShifted, netStart, netCount, isKyber] — the FLAT POOL UNIVERSE
//                 ([...prepared.pools, ...legPools], leg pools deduped). pd[7] inIsToken0 IS that
//                 pool's zeroForOne (leg pools carry the LEG's zHop). V2: [10..15]=0.
//                 [16] isKyber = 1 ⇒ KyberSwap Classic / DMM (V2-shaped on VIRTUAL reserves: SETUP
//                 reads getTradeInfo() vReserves for the curve, and the callback-free swap computes
//                 the output on the virtual reserves with the live feeInPrecision). 0 ⇒ plain UniswapV2
//                 (or, for a leg pool, a canonical 0.30% V2). A DIRECT V2 pool whose feePpm != 3000
//                 executes callback-free at its REAL fee; route-leg V2 pools stay canonical 0.30%.
//   netCache[n] = [shiftedTick, rawNet] — per-pool grouped [netStart, netStart+netCount), sorted
//                 in SWAP DIRECTION; rawNet is the raw uint128 ticks() returns.
//   routing[r]  = [legCount, base0,count0,inter0, base1,count1,inter1, …] — one flat SCALAR tuple
//                 per route, uniform 3-field stride per leg (leg L at rt[1+3L],rt[2+3L],rt[3+3L]).
//                 Leg L pools = universe indices [baseL, baseL+countL); interL = intermediate token
//                 AFTER leg L (final leg → 0). The merge head fold, the route event, and the
//                 chain-order execution all loop over legCount, so N-hop needs no shape change.
//   qlv[v]      = [poolAddr, i, j, feePpm, segKind, refIdx] — the QUOTE-LADDER (QL) venue DESCRIPTORS
//                 (Curve StableSwap segKind 1, Trader Joe LB segKind 2, DODO V2 segKind 3, Solidly STABLE
//                 segKind 4, Wombat segKind 5, Curve CryptoSwap segKind 9, WOOFi segKind 10, Fermi segKind
//                 11, Mento V2 segKind 13). DODO is DIRECTIONAL — qd[1] is isSellBase (tokenIn ==
//                 pool._BASE_TOKEN_()): the ladder quotes querySellBase(caller,xNext) or querySellQuote(
//                 caller,xNext) accordingly. NO sampled values:
//                 prepare ships only the descriptor (prepare-optional), and the solver BUILDS each venue's
//                 price ladder ON-CHAIN in setup from LIVE cook-time state. For k in 0..QL_S-1 it takes a
//                 geometric cumulative input xNext = cum*QL_RN/QL_RD + seed (seed = amountIn/QL_SEED_DIV,
//                 derived on-chain, clamped at amountIn), quotes q_k dispatched per-row on segKind (qd[4]):
//                 StableSwap get_dy(int128,int128,uint256) for kind 1, CryptoSwap get_dy(uint256,uint256,
//                 uint256) for kind 9 (a DIFFERENT selector + uint256 coin indices), Solidly getAmountOut(
//                 xIn,tokenIn) for kind 4, WOOFi tryQuery(tokenIn,tokenOut,xIn) for kind 10, Mento
//                 broker.getAmountOut(provider=qd[0],exchangeId=qd[1],tokenIn,tokenOut,xIn) for kind 13, LB
//                 pair.getSwapOut(xIn,swapForY=qd[1])→(amountInLeft,amountOut) for kind 2. The revert-class
//                 views (get_dy families on bad state / Newton non-convergence; Solidly getAmountOut on
//                 _get_y non-convergence; Mento getAmountOut on a misconfigured exchange) use
//                 PROBE-THEN-DECODE (a `.catch` flags a revert ⇒ stop; the sentinel-catch cannot capture the
//                 return VALUE); WOOFi tryQuery + LB getSwapOut NEVER revert (WOOFi returns 0 on a cap /
//                 feasibility failure ⇒ a PLAIN staticcall decoding [0], 0 ⇒ stop; LB returns amountInLeft,
//                 the UNFILLABLE remainder). It then differences (capacity = xNext-cum, sliceOut = q_k -
//                 q_{k-1}) and emits a segment row [refIdx, capacity, head, head, segKind, venue, venueAux]
//                 (head = qlSliceHead(sliceOut,capacity); every quote is post-fee ⇒ no extra fee-adjust)
//                 into the SAME merged segment stream the static `segs` feed. LB is the one venue whose
//                 slice capacity is NOT xNext-cum: the pool absorbs only effAbsorbed = xNext-amountInLeft, so
//                 its capacity is effAbsorbed-cum and cum advances to effAbsorbed (bounding the awarded LB
//                 input to the LIVE fillable bin capacity — the transfer-first exec never over-asks). Mento
//                 emits venueAux = the bytes32 exchangeId. Stops early on a sentinel-0 quote, a zeroed slice
//                 capacity (LB saturated), a non-descending head (non-convex guard), or the QL_S cap.
//                 Building all slices ONCE from one live read is exactly as live as re-quoting per merge step
//                 (pool state is frozen until EXEC), so the ladder is bounded to <=2*QL_S staticcalls per
//                 venue. Everything past obtaining q (difference/head/emit/sort) is SHARED across adapters —
//                 each later QL lane adds only one treeshake-guarded per-segKind quote branch here.
//   segs[g]     = [refIdx, capacity, sqrtAdjNear, sqrtAdjFar, segKind, venue, venueAux] — the STATIC
//                 sampled-segment venue stream (the 13 not-yet-QL-migrated venues: LB / DODO / Solidly
//                 / … interleaved), pre-sorted DESC sqrtAdjNear. In setup the solver COPIES these rows
//                 and the ON-CHAIN-BUILT qlv ladders into ONE set of parallel scalar arrays (an
//                 array-of-tuples is v12-only — SET_INDEX of a tuple reverts on v1), then BOUNDED-
//                 insertion-SORTs them DESC (sqrtAdjNear, then sqrtAdjFar, then refIdx ASC) into the
//                 single stream the bestKind===1 cursor consumes. The merge head-scan / cursor /
//                 accumulators / exec are UNCHANGED in logic — only WHERE the stream comes from (an
//                 on-chain-built parallel-array stream, not a pre-sorted compiler arg).
//                 These are STATIC venues: their curve math is OFF-CHAIN ONLY (prepare samples — LB
//                 EXACTLY enumerates — each into post-fee flat segments), so the solver does NOT
//                 recompute either curve. It consumes the rows in price order through ONE cursor
//                 (bestKind===1), accumulates the awarded Σ per venue (keyed by the row's venue
//                 address), and dispatches on segKind at execution: 1 = Curve (swap(poolType:3) →
//                 _swapCurve), 2 = LB (swap(poolType:6) → _swapTraderJoeLB), 3 = DODO (swap(poolType:5)
//                 → _swapDODOV2), 4 = Solidly STABLE (sAMM) — CALLBACK-FREE, NO engine SwapPoolType:
//                 read the EXACT out from the pool's getAmountOut view (the view IS the swap math),
//                 transfer the awarded input + pool.swap(a0Out, a1Out, to, "") (a stable pool is
//                 x3y+y3x, NOT xy=k, so it must NOT go through _swapV2). 5 = Wombat (CALLBACK-FREE:
//                 quotePotentialSwap + approve + pool.swap; Wombat PULLS via transferFrom). 6 =
//                 Balancer V2 ComposableStable (swap poolType:4 → _swapBalancerV2 → it derives poolId
//                 via getPoolId() and calls Vault.swap(GIVEN_IN); the StableMath A-invariant + BPT
//                 exclusion + scaling + fee run INSIDE the Vault). The engine resolves coin indices /
//                 swapForY / base-quote orientation / poolId on-chain for kinds 1/3/6, so the
//                 SwapParams carry NO curve data — the segment merge already used it. Curve / DODO /
//                 Solidly / Balancer are exact-on-grid; LB is EXACT (a bin is a flat constant-sum slice).
//                 7 = EulerSwap, 8 = Maverick V2, 9 = Curve CryptoSwap, 10 = WOOFi (WooPPV2 sPMM) —
//                 CALLBACK-FREE, NO engine SwapPoolType: read the EXACT out from the pool's own
//                 query(tokenIn,tokenOut,Σ) view (reads the LIVE WooracleV2 oracle ⇒ wei-exact-in-dy),
//                 TRANSFER the awarded input to the pool (WooPPV2 is transfer-first), then
//                 swap(fromToken,toToken,Σ,minTo,to,rebateTo). WOOFi is oracle-priced (NOT xy=k); the
//                 split is exact-on-grid at the SNAPSHOT oracle, the exec exact-in-dy at the live oracle.
// All sqrt values are unified out/in Q96.


// int24 STATICCALL arg (signed tick) from a shifted tick — verbatim from the lens.
function tickArg(shifted: Uint256, OFFSET: Uint256): Uint256 {
  const HIGH: Uint256 = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffff000000;
  if (shifted >= OFFSET) {
    const up: Uint256 = shifted - OFFSET;
    if (up >= 8388608) {
      return up | HIGH;
    }
    return up;
  }
  return Math.neg(OFFSET - shifted) | HIGH;
}

// ts-aligned SHIFTED base tick from a slot0/getSlot0 int24 tick READ.
//
// The engine decodes a signed intN CONTRACT-OUTPUT (slot0/getSlot0 tick, int24) by
// ZERO-extending it (not sign-extending) — a negative tick like -180 comes back as its
// raw 24-bit two's-complement 16777036 (= 2^24 - 180), NOT 2^256-180. So the naive
// `((tickRaw + OFFSET) / ts) * ts` produces a garbage (huge) shifted base for any pool
// below tick 0, and the frontier walk then reads ticks() at nonexistent boundaries (L
// never updates → mis-fill). Recover the true SHIFTED tick directly: a raw value with
// the int24 sign bit set (>= 2^23) is negative, so shift = rawTick + OFFSET - 2^24;
// otherwise shift = rawTick + OFFSET. Both are non-negative (OFFSET > max|tick|). Then
// floor to the tickSpacing lattice. Mirrors the off-chain BigInt.asIntN(24, tickRaw).
function tickShiftedBase(tickRaw: Uint256, OFFSET: Uint256, ts: Uint256): Uint256 {
  const INT24_SIGN: Uint256 = 8388608; // 2^23
  const INT24_MOD: Uint256 = 16777216; // 2^24
  let shifted: Uint256 = tickRaw + OFFSET;
  if (tickRaw >= INT24_SIGN) {
    shifted = tickRaw + OFFSET - INT24_MOD;
  }
  return (shifted / ts) * ts;
}

// KyberSwap Classic / DMM getAmountOut on the VIRTUAL reserves (the genuine on-curve output):
//   amountInWithFee = amt*(PRECISION - feeInPrecision)/PRECISION
//   amountOut       = amountInWithFee*vReserveOut / (vReserveIn + amountInWithFee)
// Extracted so the per-pool execution-dispatch branch stays under the compiler's 255-byte
// branch-body limit (the inline read + transfer + swap pushed it over).
function kyberOut(amt: Uint256, kfee: Uint256, kVin: Uint256, kVout: Uint256, PRECISION: Uint256): Uint256 {
  const inWithFee: Uint256 = Math.mulDiv(amt, PRECISION - kfee, PRECISION);
  const denom: Uint256 = kVin + inWithFee;
  if (denom > 0) {
    return Math.mulDiv(inWithFee, kVout, denom);
  }
  return 0;
}

function toOutIn(sqrtReal: Uint256, zeroForOne: Uint256): Uint256 {
  if (zeroForOne === 1) {
    return sqrtReal;
  }
  const Q192: Uint256 = 2 ** 192;
  return Q192 / sqrtReal;
}

function stepReal(sqrtReal: Uint256, stepRatio: Uint256, zeroForOne: Uint256): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  if (zeroForOne === 1) {
    return Math.mulDiv(sqrtReal, Q96, stepRatio);
  }
  return Math.mulDiv(sqrtReal, stepRatio, Q96);
}

// ── Pure-value route-composition helpers — mirror ecoswap.math.ts BIT-FOR-BIT ──
// These factor the route arithmetic out of main using ONLY Math.* intrinsics inline (so they
// never call another user helper, which the compiler forbids). The 2-hop routeEvent2/routePartial2
// LOGIC is inlined in main (it would otherwise be a helper calling these helpers), but each piece
// of its arithmetic is one of these primitives so the solver==oracle==reference to the wei.

/** Product fold of two out/in sqrt heads, rescaled by Q96: h1*h2/2^96 (mirrors composeStep). */
function composeStep(accSqrtQ96: Uint256, legSqrtQ96: Uint256): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  return Math.mulDiv(accSqrtQ96, legSqrtQ96, Q96);
}

/** Gross input to traverse a constant-L bracket [nearOI > farOI]: effIn grossed up by fee. */
function bracketGross(L: Uint256, nearOI: Uint256, farOI: Uint256, feePpm: Uint256): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  const FEE_DENOM: Uint256 = 1000000;
  const effIn: Uint256 = Math.mulDiv(L, Q96, farOI) - Math.mulDiv(L, Q96, nearOI);
  return Math.mulDiv(effIn, FEE_DENOM, FEE_DENOM - feePpm);
}

/** Output produced over a constant-L bracket [nearOI > farOI]: L*(nearOI - farOI)/2^96. */
function bracketOut(L: Uint256, nearOI: Uint256, farOI: Uint256): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  return Math.mulDiv(L, nearOI - farOI, Q96);
}

/** The far OI after absorbing grossIn (incl. fee) within a constant-L bracket (localQuote inv). */
function invertFarFromGrossIn(L: Uint256, nearOI: Uint256, grossIn: Uint256, feePpm: Uint256): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  const FEE_DENOM: Uint256 = 1000000;
  // Zero input ⇒ zero movement: far == near EXACTLY. The reciprocal round-trip does NOT recover
  // `near` (it rounds to far >= near), and far > near would UNDERFLOW the uint256 (nearOI - farOI)
  // in bracketOut/bracketGross at an interior L==0 gap event (a route feeds 0 flow through a
  // downstream leg). Special-case it so a gap event moves no downstream leg. Mirror ecoswap.math.ts.
  if (grossIn === 0) {
    return nearOI;
  }
  const effIn: Uint256 = Math.mulDiv(grossIn, FEE_DENOM - feePpm, FEE_DENOM);
  const invNear: Uint256 = Math.mulDiv(L, Q96, nearOI);
  const invLow: Uint256 = invNear + effIn;
  if (invLow > 0) {
    return Math.mulDiv(L, Q96, invLow);
  }
  return 0;
}

/** The far OI after producing outAmt within a constant-L bracket: nearOI - outAmt*2^96/L. */
function invertFarFromOut(L: Uint256, nearOI: Uint256, outAmt: Uint256): Uint256 {
  const Q96: Uint256 = 2 ** 96;
  return nearOI - Math.mulDiv(outAmt, Q96, L);
}

/**
 * QUOTE-LADDER slice head — fee-inclusive out/in sqrt-Q96 of one differenced ladder slice:
 * sqrt(sliceOut·2^192 / capacity). A Curve get_dy is already POST-FEE, so the head needs NO extra
 * fee-adjust (a QL Curve segment enters the merge with adjNear==adjFar==head). Pure-value (only
 * Math.* intrinsics — no helper-to-helper call), so it is safe to call from main()'s ladder build.
 * Bit-for-bit with curve-math.ts / ecoswap.math.ts `qlSliceHead`.
 */
function qlSliceHead(sliceOut: Uint256, capacity: Uint256): Uint256 {
  const Q192: Uint256 = 2 ** 192;
  return Math.sqrt(Math.mulDiv(sliceOut, Q192, capacity));
}

// ── Compile-time protocol-presence flags (conditional compilation) ──
// Each guards the per-protocol-SEPARABLE on-chain code below. index.ts derives each from the
// prepared universe and passes them as compiler `defines` (with treeshake on) so a cook carries
// ONLY the protocols its prepared data actually contains — an all-UniV3 swap drops the Curve /
// Solidly / DODO / LB / Kyber / route bytecode (and any helper reachable only from a dropped
// branch). A caller-provided define OVERRIDES these defaults; absent any define (the legacy /
// compile-test path) every flag stays `true` ⇒ output is byte-identical to the all-protocols cook.
// The type-agnostic k-way merge core + the live V3/V4 frontier walk are unguarded (always on).
const HAS_V2: boolean = true;
const HAS_V4: boolean = true;
const HAS_KYBER: boolean = true;
const HAS_ROUTES: boolean = true;
const HAS_CURVE: boolean = true;
const HAS_LB: boolean = true;
const HAS_DODO: boolean = true;
const HAS_SOLIDLY_STABLE: boolean = true;
const HAS_WOMBAT: boolean = true;
const HAS_BALANCER: boolean = true;
const HAS_EULER: boolean = true;
const HAS_MAVERICK: boolean = true;
const HAS_CRYPTO: boolean = true;
const HAS_WOOFI: boolean = true;
const HAS_FERMI: boolean = true;
const HAS_FLUID: boolean = true;
const HAS_MENTO: boolean = true;
const HAS_BALANCER_V3: boolean = true;

function main(
  cfg: Tuple,
  pools: Tuple, netCache: Tuple, routing: Tuple, segs: Tuple, qlv: Tuple
): Uint256 {
  // cfg = [tokenIn, tokenOut, amountIn, caller, priceLimit, directCount]
  const tokenIn: Address = cfg[0];
  const tokenOut: Address = cfg[1];
  const amountIn: Uint256 = cfg[2];
  const caller: Address = cfg[3];
  const priceLimit: Uint256 = cfg[4];
  const directCount: Uint256 = cfg[5];
  // cfg[6] = the chain-wide Fluid DEX DexReservesResolver address (0 when no Fluid venue). The Fluid
  // per-slice quote goes through this resolver's estimateSwapIn (the pool's own estimate is a revert
  // SauceScript can't try/catch); one resolver serves every Fluid pool on the chain. OPTIONAL 7th cfg
  // field — guarded by cfg.length so the many venue EVM tests that hand-build a 6-field cfg (no Fluid)
  // stay valid; production always emits it (index.ts).
  let fluidResolver: Address = 0;
  if (cfg.length > 6) { fluidResolver = cfg[6]; }
  // cfg[7] = the chain-wide Mento V2 Broker address (0 when no Mento venue). The Mento per-slice quote +
  // swap both go through this Broker's getAmountOut / swapIn; the per-venue exchangeProvider + exchangeId
  // travel in the segs row (venue = segs[5] = provider, segs[6] = exchangeId). One Broker serves every Mento
  // venue on the chain. OPTIONAL 8th cfg field — guarded by cfg.length so the many venue EVM tests that
  // hand-build a shorter cfg (no Mento) stay valid; production always emits it (index.ts).
  let mentoBroker: Address = 0;
  if (cfg.length > 7) { mentoBroker = cfg[7]; }
  // cfg[8] = the chain-wide Balancer V3 Router address (0 when no Balancer V3 venue). Balancer V3's Vault is
  // a CREATE2 singleton (same on every chain) but the Router DIFFERS per chain, so the per-chain Router is
  // threaded here — the per-slice quote (querySwapSingleTokenExactIn), the Permit2 allowance spender, and the
  // swap (swapSingleTokenExactIn) all target it; the per-venue POOL travels in the segs row (venue =
  // segs[5]). One Router serves every V3 pool on the chain. OPTIONAL 9th cfg field — guarded by cfg.length so
  // the many venue EVM tests that hand-build a shorter cfg (no Balancer V3) stay valid; production always
  // emits it (index.ts).
  let balancerV3Router: Address = 0;
  if (cfg.length > 8) { balancerV3Router = cfg[8]; }
  // cfg[9] = the internal whole-trade amountOutMin FLOOR (defense-in-depth). 0 ⇒ NO floor: the
  // solver just returns the final tokenOut balance exactly as before (this is the SPLIT / priced
  // path — unchanged, wei-exact). When > 0 a TERMINAL require (finalOut >= minOut) reverts the whole
  // cook on a shortfall; production (index.ts) sets it to expectedTotalOut*(1 - slip), which sits
  // strictly BELOW any legitimate wei-exact fill so it never false-reverts. OPTIONAL 10th cfg field —
  // guarded by cfg.length so the many venue EVM tests that hand-build a shorter cfg stay valid (minOut
  // defaults 0 ⇒ byte-identical to the pre-floor solver); production always emits it (index.ts).
  let minOut: Uint256 = 0;
  if (cfg.length > 9) { minOut = cfg[9]; }

  const router = ISauceRouter.at(address.self);
  const token = IERC20.at(tokenIn);

  const Q96: Uint256 = 2 ** 96;
  const Q192: Uint256 = 2 ** 192;
  const FEE_DENOM: Uint256 = 1000000;
  const OFFSET: Uint256 = 888000;
  const HALF128: Uint256 = 2 ** 127;
  const MOD128: Uint256 = 2 ** 128;
  const V2_STEP_BPS: Uint256 = 25;
  const V2_STEP_DEN: Uint256 = 10000;
  // Canonical UniswapV2 fee (ppm). The engine's _swapV2 hardcodes this (997/1000), so a V2
  // pool charging EXACTLY this fee executes via the unified router swap(poolType:0). A V2
  // pool at any OTHER fee can't use _swapV2 — it executes callback-free (transfer to the
  // pair + pair.swap(amount0Out, amount1Out, recipient, "")), computing the output with the
  // pool's REAL fee so the executed dy matches the fee the merge/oracle grossed by (wei-exact).
  const V2_DEFAULT_FEE: Uint256 = 3000;
  // KyberSwap Classic / DMM fee precision (feeInPrecision is 1e18-scaled). The merge prices a
  // Kyber pool on its ROUNDED ppm (pd[5], wei-exact with the oracle), but the callback-free
  // execution computes the realized output on the VIRTUAL reserves with the LIVE feeInPrecision
  // at full 1e18 precision (the genuine Kyber getAmountOut), so the swap lands + conserves.
  const KYBER_PRECISION: Uint256 = 10 ** 18;
  // Balancer V3 exec constants. The input is pulled via Permit2 (the ONE operational difference from V2):
  // ERC20.approve(PERMIT2) then Permit2.approve(tokenIn, ROUTER, uint160 amt, uint48 expiration) before the
  // Router.swapSingleTokenExactIn. PERMIT2 is the canonical Uniswap singleton — the SAME address on every
  // EVM chain (cast-verified via Router.getPermit2()). B3_DEADLINE is a large constant far in the future (the
  // swap's deadline arg); B3_EXPIRATION (uint48) caps the Permit2 allowance validity (also far future).
  const PERMIT2: Address = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
  const B3_DEADLINE: Uint256 = 2 ** 64;
  const B3_EXPIRATION: Uint256 = 2 ** 47;
  // Run-until-filled budget. PER_POOL bounds each pool's single from-live-spot walk (it MUST equal
  // the optimal oracle's MAX_V3_STEPS and the reference's PER_POOL EXACTLY, so the split is
  // wei-exact EVEN WHEN THE CAP BINDS). SAFETY dominates the SUM of all per-pool reaches plus the
  // route events (routing.length*PER_POOL extra) so the outer merge loop never itself truncates a
  // fill the per-pool caps would complete.
  const PER_POOL: Uint256 = 2048;
  // ── QUOTE-LADDER constants (MUST equal curve-math.ts QL_S / QL_RN / QL_RD / QL_SEED_DIV) ──
  // QL_S geometric slices per QL venue; xNext = cum*QL_RN/QL_RD + seed, seed = amountIn/QL_SEED_DIV
  // (clamped at amountIn). QL_SEED_DIV=16 < 19.84 guarantees the clamp engages on the final slice, so
  // the ladder covers [0, amountIn] in full (a solo QL venue can absorb the whole trade).
  const QL_S: Uint256 = 8;
  const QL_RN: Uint256 = 5;
  const QL_RD: Uint256 = 4;
  const QL_SEED_DIV: Uint256 = 16;
  // MS_CAP = the merged sampled-segment stream capacity: the static `segs` rows PLUS up to QL_S rows
  // per QL descriptor. Upper bound (a ladder may stop early); the parallel-array stream + every
  // per-venue accumulator size to it, and refIdx keys stay < MS_CAP (an index into a per-kind venue
  // list). MS_CAP=0 for an all-live universe (no sampled venues) ⇒ the segment machinery is a no-op.
  const MS_CAP: Uint256 = segs.length + qlv.length * QL_S;
  // SAFETY dominates every per-pool reach + the route events + ONE merge step per merged segment
  // (each segment is consumed in exactly one step, so + MS_CAP covers the cursor).
  const SAFETY: Uint256 = pools.length * PER_POOL * 2 + routing.length * PER_POOL + MS_CAP;

  // Per-universe-pool accumulators + the single live frontier state (walked from the live spot).
  let inp: Tuple = new Array(pools.length);
  let lArr: Tuple = new Array(pools.length); // V2 live √k
  let dnOn: Tuple = new Array(pools.length); // frontier active flag
  let dnNear: Tuple = new Array(pools.length); // real sqrt (V3/V4) or out/in (V2) near edge
  let dnL: Tuple = new Array(pools.length); // active L
  let dnShift: Tuple = new Array(pools.length); // next boundary (shifted)
  let dnSteps: Tuple = new Array(pools.length); // per-pool step budget
  let netCur: Tuple = new Array(pools.length); // cursor into this pool's netCache rows
  let sfArr: Tuple = new Array(pools.length); // per-pool sqrt fee factor (constant)
  let zArr: Tuple = new Array(pools.length); // per-pool zeroForOne (== pd[7] inIsToken0)
  // Route-leg bracket far (real sqrt for V3/V4, out/in for V2): the FIXED far edge of the leg
  // pool's CURRENT bracket. A route PARTIAL fill moves the pool's near (dnNear) WITHIN the bracket
  // while keeping this far fixed; a FULL cross re-anchors it to one stepReal past the new near.
  // This mirrors the oracle's routeSegments, which holds b[i].farOI fixed across partial events.
  let brFar: Tuple = new Array(pools.length);
  let rinp: Tuple = new Array(routing.length);

  // Per-venue input accumulators for the SAMPLED-SEGMENT venues (Curve / LB / DODO), each keyed
  // by the static-segment INDEX (multiple segments can share one venue ⇒ accumulate; the venue
  // address is stamped from the row). Sized by the segment-stream length (an upper bound on
  // distinct venues per kind). The three kinds keep SEPARATE arrays (their refIdx counters are
  // independent). cven/lven/dven stay 0 for an unused slot; a >0 input marks a venue to execute.
  let cinp: Tuple = new Array(MS_CAP); // Curve per-venue Σ input
  let cven: Tuple = new Array(MS_CAP); // Curve venue (exchange() pool) address
  let linp: Tuple = new Array(MS_CAP); // LB per-venue Σ input
  let lven: Tuple = new Array(MS_CAP); // LB venue (pair) address
  let dinp: Tuple = new Array(MS_CAP); // DODO per-venue Σ input
  let dven: Tuple = new Array(MS_CAP); // DODO venue (pool) address
  let sinp: Tuple = new Array(MS_CAP); // Solidly-stable per-venue Σ input
  let sven: Tuple = new Array(MS_CAP); // Solidly-stable venue (pool) address
  let winp: Tuple = new Array(MS_CAP); // Wombat per-venue Σ input
  let wven: Tuple = new Array(MS_CAP); // Wombat venue (pool) address
  let binp: Tuple = new Array(MS_CAP); // Balancer-stable per-venue Σ input
  let bven: Tuple = new Array(MS_CAP); // Balancer-stable venue (pool) address
  let einp: Tuple = new Array(MS_CAP); // EulerSwap per-venue Σ input
  let even: Tuple = new Array(MS_CAP); // EulerSwap venue (pool) address
  let minp: Tuple = new Array(MS_CAP); // Maverick V2 per-venue Σ input
  let mven: Tuple = new Array(MS_CAP); // Maverick V2 venue (pool) address
  let cryinp: Tuple = new Array(MS_CAP); // Curve CryptoSwap per-venue Σ input
  let cryven: Tuple = new Array(MS_CAP); // Curve CryptoSwap venue (pool) address
  let wooinp: Tuple = new Array(MS_CAP); // WOOFi per-venue Σ input
  let wooven: Tuple = new Array(MS_CAP); // WOOFi venue (pool) address
  let feinp: Tuple = new Array(MS_CAP); // Fermi/propAMM per-venue Σ input
  let feven: Tuple = new Array(MS_CAP); // Fermi/propAMM venue (pool) address
  let flinp: Tuple = new Array(MS_CAP); // Fluid DEX per-venue Σ input
  let flven: Tuple = new Array(MS_CAP); // Fluid DEX venue (DexT1 pool) address
  let mtinp: Tuple = new Array(MS_CAP); // Mento V2 per-venue Σ input
  let mtven: Tuple = new Array(MS_CAP); // Mento V2 venue exchangeProvider address (segs[5])
  let mtxid: Tuple = new Array(MS_CAP); // Mento V2 venue exchangeId (bytes32-as-uint256, segs[6])
  let b3inp: Tuple = new Array(MS_CAP); // Balancer V3 per-venue Σ input
  let b3ven: Tuple = new Array(MS_CAP); // Balancer V3 venue (Vault pool) address (segs[5])

  // ── MERGED SAMPLED-SEGMENT STREAM (parallel scalar arrays) ──
  // The bestKind===1 cursor consumes ONE globally-DESC-sorted segment stream. It is built ON-CHAIN
  // in setup from BOTH the static `segs` rows (copied) AND the qlv QUOTE-LADDERS (built live), then
  // bounded-insertion-sorted. Stored as PARALLEL SCALAR arrays (one column per array) because a
  // NEW_ARRAY of TUPLE rows reverts SET_INDEX on v1 (an array-of-tuples is v12-only). msN = the
  // actual filled row count (≤ MS_CAP). Columns mirror the old row shape:
  //   msRef=refIdx, msCap=capacity, msNear=sqrtAdjNear, msFar=sqrtAdjFar, msKind=segKind,
  //   msVen=venue, msAux=venueAux.
  let msRef: Tuple = new Array(MS_CAP);
  let msCap: Tuple = new Array(MS_CAP);
  let msNear: Tuple = new Array(MS_CAP);
  let msFar: Tuple = new Array(MS_CAP);
  let msKind: Tuple = new Array(MS_CAP);
  let msVen: Tuple = new Array(MS_CAP);
  let msAux: Tuple = new Array(MS_CAP);
  let msN: Uint256 = 0;
  // Merged-stream cursor: msNear/msFar are pre-sorted DESC (then refIdx ASC), so the cursor only ever
  // advances; a segment is consumed once. The head candidate is always the [segCur] slice (next-best).
  let segCur: Uint256 = 0;

  // Per-leg scratch for the N-leg route event (sized to the universe — legCount <= pools.length
  // since route legs are disjoint pool slices). Reused across every route + step (allocated ONCE
  // here, never inside the hot loop). lgP = leg binding pool index; lgN/lgF = the leg's current
  // bracket near/far OI; lgL/lgFee = its L/fee; lgNF = the event's new far OI per leg; lgFR = the
  // leg pool's bracket far REAL sqrt (re-anchor source for a full cross / brFar latch).
  let lgP: Tuple = new Array(pools.length);
  let lgN: Tuple = new Array(pools.length);
  let lgF: Tuple = new Array(pools.length);
  let lgL: Tuple = new Array(pools.length);
  let lgFee: Tuple = new Array(pools.length);
  let lgNF: Tuple = new Array(pools.length);
  let lgFR: Tuple = new Array(pools.length);

  let cum: Uint256 = 0;

  // ── SETUP: read live state once per universe pool, seed the single frontier from the LIVE spot ──
  for (let i = 0; i < pools.length; i = i + 1) {
    const pd: Tuple = pools[i];
    const isV2: Uint256 = pd[6];
    const pType: Uint256 = pd[0];
    const zfo: Uint256 = pd[7]; // per-pool swap direction (leg pools carry the leg's zHop)
    zArr[i] = zfo;
    let ll: Uint256 = 0;
    dnSteps[i] = 0;
    brFar[i] = 0;
    // sf = sqrt((FEE_DENOM - feePpm)*FEE_DENOM) depends only on the constant pool fee — compute the
    // integer sqrt ONCE here and reuse it in the hot merge loop (feeAdj = mulDiv(oi, sf, FEE_DENOM)).
    sfArr[i] = Math.sqrt((FEE_DENOM - pd[5]) * FEE_DENOM);
    if ((HAS_V2 || HAS_KYBER) && isV2 === 1) {
      // V2 reads getReserves; Kyber Classic (pd[16]==1) reads getTradeInfo's VIRTUAL reserves
      // (the curve geometry trades on vReserve*, NOT the real reserves). Both seed an identical
      // constant-L stream from the LIVE out/in spot — only the reserve source differs.
      let r0: Uint256 = 0;
      let r1: Uint256 = 0;
      if (HAS_KYBER && pd[16] === 1) {
        r0 = IKyberPool.at(pd[1]).getTradeInfo()[2]; // vReserve0
        r1 = IKyberPool.at(pd[1]).getTradeInfo()[3]; // vReserve1
      } else {
        r0 = IUniswapV2Pair.at(pd[1]).getReserves()[0];
        r1 = IUniswapV2Pair.at(pd[1]).getReserves()[1];
      }
      const resIn: Uint256 = zfo === 1 ? r0 : r1;
      const resOut: Uint256 = zfo === 1 ? r1 : r0;
      ll = Math.sqrt(resIn * resOut);
      dnOn[i] = 1;
      dnNear[i] = Math.sqrt(Math.mulDiv(resOut, Q192, resIn)); // live out/in spot sqrt
      dnL[i] = ll;
      dnShift[i] = 0; // unused for V2
      netCur[i] = 0;
    } else {
      // V3/V4: read live real sqrt + tick + active L; seed the frontier at the live spot.
      let srReal: Uint256 = 0;
      let liveTick: Uint256 = 0;
      let liveL: Uint256 = 0;
      if (HAS_V4 && pType === 2) {
        srReal = IStateViewFull.at(pd[8]).getSlot0(pd[9])[0];
        liveTick = IStateViewFull.at(pd[8]).getSlot0(pd[9])[1];
        liveL = IStateViewFull.at(pd[8]).getLiquidity(pd[9]);
      } else {
        srReal = IUniswapV3PoolFull.at(pd[1]).slot0()[0];
        liveTick = IUniswapV3PoolFull.at(pd[1]).slot0()[1];
        liveL = IUniswapV3PoolFull.at(pd[1]).liquidity();
      }
      const ts: Uint256 = pd[3];
      const base: Uint256 = tickShiftedBase(liveTick, OFFSET, ts);
      let sh: Uint256 = base;
      if (zfo === 0) { sh = base + ts; }
      dnOn[i] = 1;
      dnNear[i] = srReal; // V3/V4 frontier stores the live real sqrt
      dnL[i] = liveL;
      dnShift[i] = sh;

      // Position the per-pool net cursor PAST any cached rows above the first boundary (drift-down
      // skip). Rows are sorted in swap direction. netStart=[14], netCount=[15].
      const nStart: Uint256 = pd[14];
      const nCount: Uint256 = pd[15];
      let cur: Uint256 = nStart;
      const nEnd: Uint256 = nStart + nCount;
      if (nCount > 0) {
        for (let q = 0; q < nCount; q = q + 1) {
          if (cur < nEnd) {
            const row: Tuple = netCache[cur];
            const rt: Uint256 = row[0];
            let skip: Uint256 = 0;
            if (zfo === 1) { if (rt > sh) { skip = 1; } }
            else { if (rt < sh) { skip = 1; } }
            if (skip === 1) { cur = cur + 1; }
          }
        }
      }
      netCur[i] = cur;
    }
    lArr[i] = ll;
  }

  // ── BUILD THE MERGED SAMPLED-SEGMENT STREAM (static segs + live QL ladders, then DESC sort) ──
  // Consumed by the bestKind===1 cursor below. The merge body is logic-unchanged; only the stream's
  // SOURCE moved on-chain (parallel-array stream instead of a pre-sorted compiler arg).
  if ((HAS_CURVE || HAS_LB || HAS_DODO || HAS_SOLIDLY_STABLE || HAS_WOMBAT || HAS_BALANCER || HAS_EULER || HAS_MAVERICK || HAS_CRYPTO || HAS_WOOFI || HAS_FERMI || HAS_FLUID || HAS_MENTO || HAS_BALANCER_V3) &&true) {
    // 1. Copy the static (not-yet-QL-migrated) segments VERBATIM into the parallel-array stream.
    for (let k = 0; k < segs.length; k = k + 1) {
      const sr: Tuple = segs[k];
      msRef[msN] = sr[0];
      msCap[msN] = sr[1];
      msNear[msN] = sr[2];
      msFar[msN] = sr[3];
      msKind[msN] = sr[4];
      msVen[msN] = sr[5];
      msAux[msN] = sr[6];
      msN = msN + 1;
    }
    // 2. Build each QL venue's price ladder ON-CHAIN from LIVE quotes. ONE qlv loop dispatches the
    // per-row quote on the descriptor segKind (qd[4]) — Curve StableSwap (kind 1), Curve CryptoSwap
    // (kind 9), Solidly STABLE (kind 4) and WOOFi (kind 10), each adapter branch treeshake-guarded so
    // only active adapters ship. The QUOTE is PROBE-THEN-DECODE for any view that CAN revert (Curve /
    // CryptoSwap get_dy on bad state / Newton non-convergence; Solidly getAmountOut on x3y+y3x _get_y
    // non-convergence) — a `.catch` flags a revert ⇒ stop (the sentinel-catch cannot capture the return
    // VALUE: it yields the CALL flag on v1 / returndata length on v12). For a view that NEVER reverts
    // (WOOFi tryQuery returns 0 on cap/feasibility failure) it is a PLAIN staticcall + treat 0 as stop
    // (one call, no `.catch`). Everything AFTER obtaining q (the differencing / head / emit / sort below)
    // is SHARED and adapter-agnostic. All slices are built from ONE frozen live state, so this is exactly
    // as live as re-quoting per merge step; bounded to ≤ 2*QL_S staticcalls per venue.
    if (HAS_CURVE || HAS_CRYPTO || HAS_SOLIDLY_STABLE || HAS_WOOFI || HAS_MENTO || HAS_LB || HAS_WOMBAT || HAS_FERMI || HAS_DODO || HAS_EULER) {
      for (let v = 0; v < qlv.length; v = v + 1) {
        const qd: Tuple = qlv[v];
        const qPool: Address = qd[0];
        const qi: Uint256 = qd[1];
        const qj: Uint256 = qd[2];
        const qKind: Uint256 = qd[4];
        const qRef: Uint256 = qd[5];
        let seed: Uint256 = amountIn / QL_SEED_DIV;
        if (seed === 0) { seed = 1; }
        let cumL: Uint256 = 0;
        let prevOut: Uint256 = 0;
        let prevHead: Uint256 = 0;
        let nv: Uint256 = 0;
        let stop: Uint256 = 0;
        for (let k = 0; k < QL_S; k = k + 1) {
          if (stop === 0) {
            let xNext: Uint256 = Math.mulDiv(cumL, QL_RN, QL_RD) + seed;
            if (xNext > amountIn) { xNext = amountIn; }
            const cap: Uint256 = xNext - cumL;
            if (cap === 0) {
              stop = 1;
            } else {
              // QUOTE, dispatched per-row on segKind. PROBE-THEN-DECODE for the revert-class views: the
              // sentinel-catch value is unusable for capture on both engines — it ONLY flags the revert;
              // the value is the guarded second call. StableSwap uses int128 coin indices, CryptoSwap
              // uint256 (a DIFFERENT selector); both get_dy are revert-class. Solidly getAmountOut(xIn,
              // tokenIn) is a SINGLE-return view that CAN revert on _get_y non-convergence at a large
              // input, so it too probes-then-decodes. Mento broker.getAmountOut(provider, exchangeId,
              // tokenIn, tokenOut, xIn) is a plain VIEW that CAN revert (a misconfigured exchange /
              // trading-limit path), so it also probes-then-decodes; qPool is the exchangeProvider (qd[0])
              // and qi is the bytes32 exchangeId (qd[1]) — emitted as msVen=provider, msAux=exchangeId so
              // the segKind-13 accumulator/exec key correctly. WOOFi tryQuery(tokenIn,tokenOut,xIn) NEVER
              // reverts (returns 0 on a cap / feasibility failure), so it is a PLAIN staticcall decoding
              // [0] + treats 0 as stop — no `.catch`, saving a staticcall. LB getSwapOut(xIn, swapForY) is
              // ALSO graceful (a plain view returning [0]=amountInLeft, [1]=amountOut) — see the LB branch
              // below, which additionally caps the slice at the LIVE fillable bin capacity.
              //
              // sliceCapV / cumNextV are the slice capacity + the value cumL advances to. They DEFAULT to
              // the standard geometric step (cap = xNext-cumL, cumNextV = xNext) which every venue but LB
              // uses; the LB branch OVERRIDES them with the live-capacity-bounded (effAbsorbed) semantics.
              // auxV is the 7th (msAux) column — 0 for every venue but Mento (the exchangeId).
              let ok: Uint256 = 1;
              let q: Uint256 = 0;
              let sliceCapV: Uint256 = cap;
              let cumNextV: Uint256 = xNext;
              let auxV: Uint256 = 0;
              if (HAS_CURVE && qKind === 1) {
                ICurveStableSwap.at(qPool).get_dy(qi, qj, xNext).catch(() => { ok = 0; });
                if (ok === 1) { q = ICurveStableSwap.at(qPool).get_dy(qi, qj, xNext); }
              } else {
                if (HAS_CRYPTO && qKind === 9) {
                  ICryptoSwapPoolQL.at(qPool).get_dy(qi, qj, xNext).catch(() => { ok = 0; });
                  if (ok === 1) { q = ICryptoSwapPoolQL.at(qPool).get_dy(qi, qj, xNext); }
                } else {
                  if (HAS_SOLIDLY_STABLE && qKind === 4) {
                    ISolidlyStablePool.at(qPool).getAmountOut(xNext, tokenIn).catch(() => { ok = 0; });
                    if (ok === 1) { q = ISolidlyStablePool.at(qPool).getAmountOut(xNext, tokenIn); }
                  } else {
                    if (HAS_MENTO && qKind === 13) {
                      // qPool = exchangeProvider (qd[0]); qi = bytes32 exchangeId (qd[1], intact — not
                      // truncated). PROBE-THEN-DECODE. The exchangeId travels in msAux so the accumulate/
                      // exec (segKind 13) keys the venue by (provider, exchangeId).
                      IMentoBroker.at(mentoBroker).getAmountOut(qPool, qi, tokenIn, tokenOut, xNext).catch(() => { ok = 0; });
                      if (ok === 1) { q = IMentoBroker.at(mentoBroker).getAmountOut(qPool, qi, tokenIn, tokenOut, xNext); }
                      auxV = qi;
                    } else {
                      if (HAS_LB && qKind === 2) {
                        // qPool = LB pair (qd[0]); qi = swapForY (qd[1], 0/1). getSwapOut is GRACEFUL: it
                        // returns [0]=amountInLeft (the UNFILLABLE remainder) + [1]=amountOut instead of
                        // reverting. The pool absorbs effAbsorbed = xNext - amountInLeft, so the slice
                        // capacity is effAbsorbed - cumL and cumL advances to effAbsorbed — bounding the
                        // awarded LB input to the LIVE fillable bin capacity (so the transfer-first engine
                        // exec never over-asks: the OutOfLiquidity-DoS is gone). q = amountOut.
                        const lbLeft: Uint256 = ILBPair.at(qPool).getSwapOut(xNext, qi)[0];
                        q = ILBPair.at(qPool).getSwapOut(xNext, qi)[1];
                        if (xNext > lbLeft) {
                          const absorbed: Uint256 = xNext - lbLeft;
                          cumNextV = absorbed;
                          if (absorbed > cumL) { sliceCapV = absorbed - cumL; } else { sliceCapV = 0; }
                        } else {
                          sliceCapV = 0;
                        }
                      } else {
                        if (HAS_WOOFI && qKind === 10) {
                          q = IWooFiPool.at(qPool).tryQuery(tokenIn, tokenOut, xNext);
                        } else {
                          if (HAS_WOMBAT && qKind === 5) {
                            // Wombat (single-sided stableswap, callback-free): the ladder quote is
                            // quotePotentialSwap(fromToken, toToken, xNext)[0] — the post-haircut out. It is
                            // a REVERT-class view (CASH_NOT_ENOUGH / a paused asset), so PROBE-THEN-DECODE.
                            // xNext feeds the int256 fromAmount param (positive amounts < 2^255 encode as
                            // +int256). fromToken/toToken == the swap's own tokens.
                            IWombatPool.at(qPool).quotePotentialSwap(tokenIn, tokenOut, xNext).catch(() => { ok = 0; });
                            if (ok === 1) { q = IWombatPool.at(qPool).quotePotentialSwap(tokenIn, tokenOut, xNext)[0]; }
                          } else {
                            if (HAS_FERMI && qKind === 11) {
                              // Fermi / propAMM (Obric-style proactive AMM, callback-free): the ladder quote is
                              // quoteAmounts(tokenIn, tokenOut, +xNext)[1] — the SECOND return is the exact-in
                              // out (the exec uses [1] too). REVERT-class (maker pause / stale), so PROBE-THEN-
                              // DECODE. xNext feeds the int256 amountSpecified (positive ⇒ exact-in).
                              IFermiPool.at(qPool).quoteAmounts(tokenIn, tokenOut, xNext).catch(() => { ok = 0; });
                              if (ok === 1) { q = IFermiPool.at(qPool).quoteAmounts(tokenIn, tokenOut, xNext)[1]; }
                            } else {
                              if (HAS_DODO && qKind === 3) {
                                // DODO V2 PMM (engine-executed poolType 5 → _swapDODOV2): the ground-truth ladder
                                // quote is the pool's OWN querySell* view — DIRECTIONAL. qi (qd[1]) is isSellBase
                                // (prepare computes tokenIn == pool._BASE_TOKEN_()): 1 ⇒ querySellBase(trader,
                                // payBase), else ⇒ querySellQuote(trader, payQuote). Both are REVERT-class, so
                                // PROBE-THEN-DECODE and decode [0] (the receive amount, net of the LP+MT fee).
                                // The trader is `caller` (cfg[3]) — the exec's _swapDODOV2 fee-rate model keys on
                                // tx.origin == caller, so this quote's MT fee matches the realized swap's.
                                if (qi === 1) {
                                  IDODOPool.at(qPool).querySellBase(caller, xNext).catch(() => { ok = 0; });
                                  if (ok === 1) { q = IDODOPool.at(qPool).querySellBase(caller, xNext)[0]; }
                                } else {
                                  IDODOPool.at(qPool).querySellQuote(caller, xNext).catch(() => { ok = 0; });
                                  if (ok === 1) { q = IDODOPool.at(qPool).querySellQuote(caller, xNext)[0]; }
                                }
                              } else {
                                if (HAS_EULER && qKind === 7) {
                                  // EulerSwap (Euler vault-backed AMM, v1+v2; callback-free): the ladder quote is
                                  // computeQuote(tokenIn, tokenOut, xNext, true) — the exact-in dy out (the exec
                                  // re-reads the SAME view for the awarded share). REVERT-class: computeQuote
                                  // REVERTS SwapLimitExceeded/Expired when xNext exceeds the LIVE vault inLimit/
                                  // outLimit, so PROBE-THEN-DECODE catches it (ok=0 ⇒ q=0 ⇒ stop). The ladder thus
                                  // self-truncates at the LIVE vault cap with NO separate getLimits call — the
                                  // awarded Σ is bounded by live capacity, so the exec computeQuote never reverts
                                  // on the awarded amount (the cap-revert DoS is gone). qi/qj unused (Euler quotes
                                  // by tokenIn/tokenOut). A pool that returns a literal 0 at/past its cap instead
                                  // of reverting also stops, via the q===0 gate below.
                                  IEulerSwapPool.at(qPool).computeQuote(tokenIn, tokenOut, xNext, true).catch(() => { ok = 0; });
                                  if (ok === 1) { q = IEulerSwapPool.at(qPool).computeQuote(tokenIn, tokenOut, xNext, true); }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
              if (q === 0) {
                stop = 1;
              } else {
                // LB may have driven sliceCapV to 0 (pool saturated: no more live bin capacity) — stop.
                // Every other venue keeps sliceCapV == cap (> 0, already checked above), so this is a no-op.
                if (sliceCapV === 0) {
                  stop = 1;
                } else {
                  const sliceOut: Uint256 = q - prevOut;
                  if (sliceOut === 0) {
                    stop = 1;
                  } else {
                    const head: Uint256 = qlSliceHead(sliceOut, sliceCapV);
                    // Non-convex guard: a non-descending head ends this venue's ladder here.
                    if (nv > 0) { if (head >= prevHead) { stop = 1; } }
                    if (stop === 0) {
                      msRef[msN] = qRef;
                      msCap[msN] = sliceCapV;
                      msNear[msN] = head;
                      msFar[msN] = head;
                      msKind[msN] = qKind;
                      msVen[msN] = qPool;
                      msAux[msN] = auxV;
                      msN = msN + 1;
                      nv = nv + 1;
                      prevHead = head;
                      cumL = cumNextV;
                      prevOut = q;
                      if (cumNextV >= amountIn) { stop = 1; }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    // 3. Bounded insertion sort over [0, msN) DESC by (msNear, then msFar, then msRef ASC) — the SAME
    // stable order index.ts buildSegs emits so the cursor sees a global descending-price stream. All
    // seven columns shift together (parallel arrays). For a single monotone QL ladder this is a
    // near-no-op; the general sort interleaves multiple QL venues + any static segments correctly.
    for (let a = 1; a < MS_CAP; a = a + 1) {
      if (a < msN) {
        const kRef: Uint256 = msRef[a];
        const kCap: Uint256 = msCap[a];
        const kNear: Uint256 = msNear[a];
        const kFar: Uint256 = msFar[a];
        const kKind: Uint256 = msKind[a];
        const kVen: Uint256 = msVen[a];
        const kAux: Uint256 = msAux[a];
        let b: Uint256 = a;
        for (let g = 0; g < MS_CAP; g = g + 1) {
          if (b > 0) {
            const pNear: Uint256 = msNear[b - 1];
            const pFar: Uint256 = msFar[b - 1];
            const pRef: Uint256 = msRef[b - 1];
            // key outranks pv (key sorts BEFORE pv in DESC-near, DESC-far, ASC-ref order)?
            let up: Uint256 = 0;
            if (kNear > pNear) { up = 1; }
            else { if (kNear === pNear) {
              if (kFar > pFar) { up = 1; }
              else { if (kFar === pFar) { if (kRef < pRef) { up = 1; } } }
            } }
            if (up === 1) {
              msRef[b] = pRef;
              msCap[b] = msCap[b - 1];
              msNear[b] = pNear;
              msFar[b] = pFar;
              msKind[b] = msKind[b - 1];
              msVen[b] = msVen[b - 1];
              msAux[b] = msAux[b - 1];
              b = b - 1;
            } else {
              g = MS_CAP; // key's slot found — force-exit the shift loop
            }
          }
        }
        msRef[b] = kRef;
        msCap[b] = kCap;
        msNear[b] = kNear;
        msFar[b] = kFar;
        msKind[b] = kKind;
        msVen[b] = kVen;
        msAux[b] = kAux;
      }
    }
  }

  // ── MERGE: each step, pick the best-priced candidate head (direct pool OR route) and advance it ──
  for (let s = 0; s < SAFETY; s = s + 1) {
    // Terminate the run-until-filled loop the instant the trade is fully allocated. SauceScript has
    // no break — jump the counter to the bound (split-identical: the body is gated on cum<amountIn).
    if (cum >= amountIn) { s = SAFETY; }
    if (cum < amountIn) {
      // 1. find the highest fee-adjusted head among {each direct pool frontier, each route}. Ties on
      // the near (entry) price break by HIGHER far (shallower step). Bit-identical to the oracle's
      // segment sort (adjNear DESC, adjFar DESC) and the reference.
      let bestKind: Uint256 = 0; // 0=none 1=sampled segment 2=route 3=direct pool frontier
      let bestPool: Uint256 = 0;
      let bestRoute: Uint256 = 0;
      let bestPrice: Uint256 = 0;
      let bestFar: Uint256 = 0;

      // 1a. direct pools — universe indices [0, directCount).
      for (let j = 0; j < pools.length; j = j + 1) {
        if (j < directCount) {
          const jd: Tuple = pools[j];
          if (dnOn[j] === 1) {
            const jz: Uint256 = zArr[j];
            const jsf: Uint256 = sfArr[j];
            let doi: Uint256 = 0;
            if ((HAS_V2 || HAS_KYBER) && jd[6] === 1) {
              doi = dnNear[j];
            } else {
              doi = toOutIn(dnNear[j], jz);
            }
            const dadj: Uint256 = Math.mulDiv(doi, jsf, FEE_DENOM);
            // LAZY far-adjust: the far price is ONLY the near-tie break, so a pool whose near is
            // strictly below the best can never win — skip its far. Bit-identical to an eager far.
            if (dadj >= bestPrice) {
              let dfarAdj: Uint256 = 0;
              if ((HAS_V2 || HAS_KYBER) && jd[6] === 1) {
                const v2Far: Uint256 = dnNear[j] - Math.mulDiv(dnNear[j], V2_STEP_BPS, V2_STEP_DEN);
                dfarAdj = Math.mulDiv(v2Far, jsf, FEE_DENOM);
              } else {
                const farReal: Uint256 = stepReal(dnNear[j], jd[10], jz);
                dfarAdj = Math.mulDiv(toOutIn(farReal, jz), jsf, FEE_DENOM);
              }
              let win: Uint256 = 0;
              if (dadj > bestPrice) { win = 1; }
              if (dadj === bestPrice) { if (dfarAdj > bestFar) { win = 1; } }
              if (win === 1) { bestPrice = dadj; bestFar = dfarAdj; bestKind = 3; bestPool = j; }
            }
          }
        }
      }

      // 1b. routes — each route's head is the LEFT-TO-RIGHT product fold of its legs' best
      // fee-adjusted heads. For EACH leg L (slice [baseL, baseL+countL), fields at rt[1+3L],
      // rt[2+3L]) compute its internal best ACTIVE pool near/far adj, fold near→routeNear and
      // far→routeFar via composeStep. A route is dead if ANY leg has no active pool. N-leg loop
      // over legCount (rt[0]) — 2-hop and 3-hop are the same code.
      if (HAS_ROUTES) {
      for (let r = 0; r < routing.length; r = r + 1) {
        const rt: Tuple = routing[r];
        const legCount: Uint256 = rt[0];
        let rNear: Uint256 = Q96; // fold accumulator seeded at 1.0 (Q96) ⇒ first composeStep == leg0
        let rFar: Uint256 = Q96;
        let rDead: Uint256 = 0;
        let firstLeg: Uint256 = 1;
        for (let L = 0; L < legCount; L = L + 1) {
          const baseL: Uint256 = rt[1 + 3 * L];
          const countL: Uint256 = rt[2 + 3 * L];
          const eL: Uint256 = baseL + countL;
          // leg L internal best (near adj, far adj) over its active pools.
          let lAdj: Uint256 = 0;
          let lFarAdj: Uint256 = 0;
          let lLive: Uint256 = 0;
          for (let a = baseL; a < eL; a = a + 1) {
            if (dnOn[a] === 1) {
              const ad: Tuple = pools[a];
              const az: Uint256 = zArr[a];
              const asf: Uint256 = sfArr[a];
              // V2 leg pool stores dnNear as out/in directly + steps a constant-L geometric slice;
              // V3/V4 store the real sqrt + step the tick grid via stepReal. Mirror the reference's
              // frontierNearOI/frontierFarOI per type so a V2 leg competes with the right geometry.
              let aoi: Uint256 = 0;
              let afarOI: Uint256 = 0;
              if (ad[6] === 1) {
                aoi = dnNear[a];
                afarOI = dnNear[a] - Math.mulDiv(dnNear[a], V2_STEP_BPS, V2_STEP_DEN);
              } else {
                aoi = toOutIn(dnNear[a], az);
                afarOI = toOutIn(stepReal(dnNear[a], ad[10], az), az);
              }
              const aadj: Uint256 = Math.mulDiv(aoi, asf, FEE_DENOM);
              if (aadj >= lAdj) {
                const afarAdj: Uint256 = Math.mulDiv(afarOI, asf, FEE_DENOM);
                let w0: Uint256 = 0;
                if (aadj > lAdj) { w0 = 1; }
                if (aadj === lAdj) { if (afarAdj > lFarAdj) { w0 = 1; } }
                if (w0 === 1) { lAdj = aadj; lFarAdj = afarAdj; lLive = 1; }
              }
            }
          }
          if (lLive === 0) { rDead = 1; }
          // composeStep fold (rescale by Q96). Seeded at Q96 ⇒ the first fold yields leg0's head.
          if (firstLeg === 1) { rNear = lAdj; rFar = lFarAdj; firstLeg = 0; }
          else { rNear = composeStep(rNear, lAdj); rFar = composeStep(rFar, lFarAdj); }
        }
        if (rDead === 0) {
          if (rNear >= bestPrice) {
            let rw: Uint256 = 0;
            if (rNear > bestPrice) { rw = 1; }
            if (rNear === bestPrice) { if (rFar > bestFar) { rw = 1; } }
            if (rw === 1) { bestPrice = rNear; bestFar = rFar; bestKind = 2; bestRoute = r; }
          }
        }
      }
      }

      // 1c. sampled segments — ONE cursor over the on-chain-built, DESC-sorted merged stream (static
      // segs + live QL ladders). The head is the [segCur] slice (next-best); its near/far are ALREADY
      // post-fee out/in (adjNear==adjFar==the post-fee marginal), so they compare directly. Same
      // tie-break as the pools/routes (near DESC, then far DESC).
      if ((HAS_CURVE || HAS_LB || HAS_DODO || HAS_SOLIDLY_STABLE || HAS_WOMBAT || HAS_BALANCER || HAS_EULER || HAS_MAVERICK || HAS_CRYPTO || HAS_WOOFI || HAS_FERMI || HAS_FLUID || HAS_MENTO || HAS_BALANCER_V3) &&segCur < msN) {
        const sNear: Uint256 = msNear[segCur];
        const sFar: Uint256 = msFar[segCur];
        if (sNear >= bestPrice) {
          let sw: Uint256 = 0;
          if (sNear > bestPrice) { sw = 1; }
          if (sNear === bestPrice) { if (sFar > bestFar) { sw = 1; } }
          if (sw === 1) { bestPrice = sNear; bestFar = sFar; bestKind = 1; }
        }
      }

      // Early-out: no active stream produced a head with price > 0 (all exhausted).
      if (bestKind === 0) { s = SAFETY; }

      // 2. consume + advance the winner
      if (bestKind === 3) {
        // ── direct pool frontier step ──
        const dd: Tuple = pools[bestPool];
        const dfee: Uint256 = dd[5];
        const ddz: Uint256 = zArr[bestPool];
        if ((HAS_V2 || HAS_KYBER) && dd[6] === 1) {
          // V2 frontier step (constant-L geometric slice from the live spot).
          let v2L: Uint256 = lArr[bestPool];
          let v2Near: Uint256 = dnNear[bestPool];
          const v2Far: Uint256 = v2Near - Math.mulDiv(v2Near, V2_STEP_BPS, V2_STEP_DEN);
          if (v2L > 0) { if (v2Near > v2Far) { if (v2Far > 0) {
            const v2eff: Uint256 = Math.mulDiv(v2L, Q96, v2Far) - Math.mulDiv(v2L, Q96, v2Near);
            if (v2eff > 0) {
              const v2g: Uint256 = Math.mulDiv(v2eff, FEE_DENOM, FEE_DENOM - dfee);
              let v2t: Uint256 = v2g;
              if (cum + v2g >= amountIn) { v2t = amountIn - cum; }
              inp[bestPool] = inp[bestPool] + v2t;
              cum = cum + v2t;
            }
          } } }
          dnNear[bestPool] = v2Far;
          if (v2Far <= 0) { dnOn[bestPool] = 0; }
          dnSteps[bestPool] = dnSteps[bestPool] + 1;
          if (dnSteps[bestPool] >= PER_POOL) { dnOn[bestPool] = 0; }
        } else {
          // V3/V4 frontier step — tick walk on the LIVE grid, net from cache or staticcall.
          let dL: Uint256 = dnL[bestPool];
          const dts: Uint256 = dd[3];
          const dstep: Uint256 = dd[10];
          let dnear: Uint256 = dnNear[bestPool];
          let dsh: Uint256 = dnShift[bestPool];
          const dfarReal: Uint256 = stepReal(dnear, dstep, ddz);
          const dnearOI: Uint256 = toOutIn(dnear, ddz);
          const dfarOI: Uint256 = toOutIn(dfarReal, ddz);
          let dlim: Uint256 = 0;
          if (ddz === 1) { if (dfarReal <= priceLimit) { dlim = 1; } }
          else { if (dfarReal >= priceLimit) { dlim = 1; } }
          if (dL > 0) { if (dnearOI > dfarOI) { if (dfarOI > 0) {
            const deff: Uint256 = Math.mulDiv(dL, Q96, dfarOI) - Math.mulDiv(dL, Q96, dnearOI);
            if (deff > 0) {
              const dg: Uint256 = Math.mulDiv(deff, FEE_DENOM, FEE_DENOM - dfee);
              let dt: Uint256 = dg;
              if (cum + dg >= amountIn) { dt = amountIn - cum; }
              inp[bestPool] = inp[bestPool] + dt;
              cum = cum + dt;
            }
          } } }
          // Boundary net (raw uint128): cache window cursor, else ticks()/getTickLiquidity staticcall.
          const wTop: Uint256 = dd[11];
          const wBot: Uint256 = dd[12];
          let inWindow: Uint256 = 0;
          if (wTop > 0) {
            const wLo: Uint256 = wTop <= wBot ? wTop : wBot;
            const wHi: Uint256 = wTop <= wBot ? wBot : wTop;
            if (dsh >= wLo) { if (dsh <= wHi) { inWindow = 1; } }
          }
          let dnet: Uint256 = 0;
          if (inWindow === 1) {
            const nStart: Uint256 = dd[14];
            const nCount: Uint256 = dd[15];
            const nEnd: Uint256 = nStart + nCount;
            const cc: Uint256 = netCur[bestPool];
            if (cc < nEnd) {
              const row: Tuple = netCache[cc];
              if (row[0] === dsh) { dnet = row[1]; netCur[bestPool] = cc + 1; }
            }
          } else {
            const darg: Uint256 = tickArg(dsh, OFFSET);
            if (HAS_V4 && dd[0] === 2) { dnet = IStateViewFull.at(dd[8]).getTickLiquidity(dd[9], darg)[1]; }
            else { dnet = IUniswapV3PoolFull.at(dd[1]).ticks(darg)[1]; }
          }
          const dneg: Uint256 = dnet >= HALF128 ? 1 : 0;
          if (ddz === 1) {
            if (dneg === 1) { dL = dL + (MOD128 - dnet); } else { dL = dL >= dnet ? dL - dnet : 0; }
            dsh = dsh - dts;
          } else {
            if (dneg === 1) { const dm: Uint256 = MOD128 - dnet; dL = dL >= dm ? dL - dm : 0; } else { dL = dL + dnet; }
            dsh = dsh + dts;
          }
          dnNear[bestPool] = dfarReal;
          dnL[bestPool] = dL;
          dnShift[bestPool] = dsh;
          // TERMINATE only on: price limit, OR budget cap, OR (dL==0 AND boundary PAST extreme).
          if (dlim === 1) { dnOn[bestPool] = 0; }
          const ext: Uint256 = dd[13];
          if (dL === 0) { if (ext > 0) {
            let pastExt: Uint256 = 0;
            if (ddz === 1) { if (dsh < ext) { pastExt = 1; } }
            else { if (dsh > ext) { pastExt = 1; } }
            if (pastExt === 1) { dnOn[bestPool] = 0; }
          } }
          dnSteps[bestPool] = dnSteps[bestPool] + 1;
          if (dnSteps[bestPool] >= PER_POOL) { dnOn[bestPool] = 0; }
        }
      } else {
        if (HAS_ROUTES && bestKind === 2) {
          // ── route event (N-leg, routeEventN/routePartialN inlined; helpers can't call helpers) ──
          // Resolve ONE route event across legCount legs: find the BINDING leg (the one whose full
          // tick-cross maps to the SMALLEST token-A input when back-propagated through the upstream
          // legs' current constant-L brackets), advance its winning pool ONE bracket (the existing
          // per-pool tick step), and PARTIAL-fill every other leg via the constant-L inversion with
          // conservation at every intermediate. 2-hop and 3-hop are the SAME loop. The per-leg
          // scratch (lgP/lgN/lgF/lgFR/lgL/lgFee/lgNF) is reused — written fresh each event. A leg
          // pool of any type participates: V2 legs use the constant-L geometric step (out/in near,
          // no real-sqrt grid) while V3/V4 step the tick grid; a V2 leg partial-fills but is sized
          // deep enough never to be the binding (tick-crossing) leg.
          const rt: Tuple = routing[bestRoute];
          const legCount: Uint256 = rt[0];

          // Phase A: per-leg binding pool (the leg's best ACTIVE fee-adjusted near, the SAME scan as
          // the head selection) + its CURRENT bracket [near, far] OI on the fixed live grid. brFar
          // (latched on a prior partial) holds the bracket's fixed far; else one stepReal ahead.
          for (let L = 0; L < legCount; L = L + 1) {
            const baseL: Uint256 = rt[1 + 3 * L];
            const eL: Uint256 = baseL + rt[2 + 3 * L];
            let pBest: Uint256 = baseL;
            let pAdj: Uint256 = 0;
            for (let a = baseL; a < eL; a = a + 1) {
              if (dnOn[a] === 1) {
                let aoi: Uint256 = 0;
                if (pools[a][6] === 1) { aoi = dnNear[a]; }
                else { aoi = toOutIn(dnNear[a], zArr[a]); }
                const aadj: Uint256 = Math.mulDiv(aoi, sfArr[a], FEE_DENOM);
                if (aadj > pAdj) { pAdj = aadj; pBest = a; }
              }
            }
            const zb: Uint256 = zArr[pBest];
            const db: Tuple = pools[pBest];
            lgP[L] = pBest;
            lgL[L] = dnL[pBest];
            lgFee[L] = db[5];
            // V2 leg pool: near is out/in directly + the far is a constant-L geometric slice (no real
            // sqrt grid; brFar latch is unused — V2 always recomputes from the current near). V3/V4:
            // near = toOutIn(real), far = one stepReal ahead (or the latched bracket far brFar).
            if (db[6] === 1) {
              lgN[L] = dnNear[pBest];
              const v2far: Uint256 = dnNear[pBest] - Math.mulDiv(dnNear[pBest], V2_STEP_BPS, V2_STEP_DEN);
              lgF[L] = v2far;
              lgFR[L] = v2far; // unused for a non-binding V2 leg (V2 never crosses a tick)
            } else {
              lgN[L] = toOutIn(dnNear[pBest], zb);
              let fReal: Uint256 = stepReal(dnNear[pBest], db[10], zb);
              if (brFar[pBest] > 0) { fReal = brFar[pBest]; }
              lgFR[L] = fReal;
              lgF[L] = toOutIn(fReal, zb);
            }
          }

          // Phase B: binding leg = argmin over REACHABLE legs of the token-A input to FULLY cross
          // leg i (back-propagate leg i's full-cross gross through the upstream legs' brackets via
          // invertFarFromOut→bracketGross). A `-1` sentinel (here cand==0 with crossed==1) means an
          // upstream leg would cross its OWN far first ⇒ leg i not binding; skip it. Lowest index
          // wins ties (strict <). Leg 0 is always reachable.
          let bindLeg: Uint256 = 0;
          let routeIn: Uint256 = 0;
          let haveBest: Uint256 = 0;
          for (let i = 0; i < legCount; i = i + 1) {
            // need = leg i full-cross gross (token T_i), then back-propagate through legs i-1..0.
            // SauceScript is uint256-only (no `j-- >= 0` — 0-1 underflows), so walk an ASCENDING
            // counter q over [0, i) and address leg j = i-1-q (legs i-1 down to 0).
            let need: Uint256 = bracketGross(lgL[i], lgN[i], lgF[i], lgFee[i]);
            let crossed: Uint256 = 0;
            for (let q = 0; q < i; q = q + 1) {
              const j: Uint256 = i - 1 - q;
              // An upstream leg sitting at an interior L==0 gap (the walk-through-gap design leaves
              // it active with 0 liquidity) can produce NOTHING this bracket, so leg i cannot bind
              // through it — it must advance THROUGH its own gap first. Treat it as "upstream crosses
              // first" (crossed=1) and, crucially, guard BEFORE the divide: Math.mulDiv(_, _, 0)
              // Panics (division by zero) — the lowest-index gap leg is the one that actually binds
              // (routeIn 0) and it is reached with crossed==0 (its own upstream legs are all L>0).
              if (lgL[j] === 0) { crossed = 1; }
              else {
                // farj that PRODUCES `need` of the downstream input out of leg j (invertFarFromOut).
                // If it lands at/below leg j's own far, leg j crosses first ⇒ leg i not binding.
                const prodOut: Uint256 = Math.mulDiv(need, Q96, lgL[j]);
                if (prodOut >= lgN[j]) { crossed = 1; }
                else {
                  const farj: Uint256 = lgN[j] - prodOut;
                  if (farj <= lgF[j]) { crossed = 1; }
                  else { need = bracketGross(lgL[j], lgN[j], farj, lgFee[j]); }
                }
              }
            }
            if (crossed === 0) {
              if (haveBest === 0) { bindLeg = i; routeIn = need; haveBest = 1; }
              else { if (need < routeIn) { bindLeg = i; routeIn = need; } }
            }
          }

          // Phase C: resolve the event from the binding leg. The binding leg lands EXACTLY on its
          // bracket far (lgNF[bindLeg] = its far); upstream legs back-invert (invertFarFromOut) to
          // PRODUCE the binding leg's exact gross input; downstream legs forward-invert
          // (invertFarFromGrossIn) to ABSORB the upstream leg's exact output. routeIn is recomputed
          // exactly here (the back-propagated leg-0 gross).
          lgNF[bindLeg] = lgF[bindLeg];
          const bindGrossIn: Uint256 = bracketGross(lgL[bindLeg], lgN[bindLeg], lgF[bindLeg], lgFee[bindLeg]);
          const bindOut: Uint256 = bracketOut(lgL[bindLeg], lgN[bindLeg], lgF[bindLeg]);
          // Upstream (j < bindLeg): each PRODUCES the downstream leg's exact required input. Walk
          // an ASCENDING counter q over [0, bindLeg) and address j = bindLeg-1-q (uint256-only).
          let need: Uint256 = bindGrossIn;
          for (let q = 0; q < bindLeg; q = q + 1) {
            const j: Uint256 = bindLeg - 1 - q;
            const farj: Uint256 = invertFarFromOut(lgL[j], lgN[j], need);
            lgNF[j] = farj;
            need = bracketGross(lgL[j], lgN[j], farj, lgFee[j]);
          }
          routeIn = need; // token-A gross input (the merged route input this event)
          // Downstream (j > bindLeg): each ABSORBS the upstream leg's exact output as gross-in.
          let flow: Uint256 = bindOut;
          for (let j = bindLeg + 1; j < legCount; j = j + 1) {
            const farj: Uint256 = invertFarFromGrossIn(lgL[j], lgN[j], flow, lgFee[j]);
            lgNF[j] = farj;
            flow = bracketOut(lgL[j], lgN[j], farj);
          }

          // Phase D: clamp to the remaining global budget. If clamped, the route is the crossing
          // venue: forward-propagate the remainder through ALL legs (routePartialN) WITHOUT crossing
          // any tick — every leg partial-fills interior to its bracket. Otherwise the BINDING leg
          // crosses its tick (full per-pool V3 step); every other leg moves its near to lgNF[L].
          let rtake: Uint256 = routeIn;
          let clamp: Uint256 = 0;
          if (cum + routeIn >= amountIn) { rtake = amountIn - cum; clamp = 1; }

          if (clamp === 1) {
            // routePartialN: forward-propagate rtake through all legs; near → partial far (interior).
            let pflow: Uint256 = rtake;
            for (let L = 0; L < legCount; L = L + 1) {
              const pI: Uint256 = lgP[L];
              const farL: Uint256 = invertFarFromGrossIn(lgL[L], lgN[L], pflow, lgFee[L]);
              // V2 leg pool stores near as out/in directly (no real-sqrt grid, no brFar latch);
              // V3/V4 convert the out/in partial far back to a real sqrt + latch the bracket far.
              if (pools[pI][6] === 1) {
                dnNear[pI] = farL;
              } else {
                dnNear[pI] = toOutIn(farL, zArr[pI]);
                if (brFar[pI] === 0) { brFar[pI] = lgFR[L]; }
              }
              const inAmt: Uint256 = L === 0 ? rtake : pflow;
              inp[pI] = inp[pI] + inAmt; // leg L's flow-in share (tokenIn for leg0, intermediate else)
              pflow = bracketOut(lgL[L], lgN[L], farL); // this leg's output → next leg's gross-in
            }
          } else {
            // Full event: cross the binding leg's tick; partial-fill the others to lgNF[L].
            for (let L = 0; L < legCount; L = L + 1) {
              const pI: Uint256 = lgP[L];
              // leg L's flow-in this event: leg0 = routeIn; leg L>0 = the gross input it absorbs
              // (== bracketGross over its current bracket to lgNF[L]). Conservation holds by
              // construction (downstream legs were forward-inverted from the upstream output).
              const inAmt: Uint256 = L === 0 ? routeIn : bracketGross(lgL[L], lgN[L], lgNF[L], lgFee[L]);
              inp[pI] = inp[pI] + inAmt;
              if (L === bindLeg) {
                const db: Tuple = pools[pI];
                if (db[6] === 1) {
                  // V2 BINDING leg: a constant-product pool has NO tick to cross — advance the near
                  // to the geometric far at CONSTANT L (dnL/lArr untouched), exactly the direct-V2
                  // frontier step and the oracle's V2 cursor advance. NEVER run the V3 tick-cross
                  // (ticks()/getTickLiquidity + net) on a V2 pair — that staticcall reverts the whole
                  // cook (the earlier "sized deep enough never to be the binding leg" note was a
                  // hope, not a guard; a shallow V2 leg CAN be the smallest gross cross ⇒ it binds).
                  // lgNF[bindLeg] == lgF[bindLeg] == the V2 far (out/in). Mirrors the direct-V2 step.
                  dnNear[pI] = lgNF[L];
                  if (lgNF[L] <= 0) { dnOn[pI] = 0; }
                  dnSteps[pI] = dnSteps[pI] + 1;
                  if (dnSteps[pI] >= PER_POOL) { dnOn[pI] = 0; }
                } else {
                // Advance the binding pool by ONE bracket: cross the boundary tick (net), re-anchor.
                const zb: Uint256 = zArr[pI];
                let dL: Uint256 = lgL[L];
                const dts: Uint256 = db[3];
                let dsh: Uint256 = dnShift[pI];
                const wTop: Uint256 = db[11];
                const wBot: Uint256 = db[12];
                let inWindow: Uint256 = 0;
                if (wTop > 0) {
                  const wLo: Uint256 = wTop <= wBot ? wTop : wBot;
                  const wHi: Uint256 = wTop <= wBot ? wBot : wTop;
                  if (dsh >= wLo) { if (dsh <= wHi) { inWindow = 1; } }
                }
                let dnet: Uint256 = 0;
                if (inWindow === 1) {
                  const nStart: Uint256 = db[14];
                  const nEnd: Uint256 = nStart + db[15];
                  const cc: Uint256 = netCur[pI];
                  if (cc < nEnd) {
                    const row: Tuple = netCache[cc];
                    if (row[0] === dsh) { dnet = row[1]; netCur[pI] = cc + 1; }
                  }
                } else {
                  const darg: Uint256 = tickArg(dsh, OFFSET);
                  if (db[0] === 2) { dnet = IStateViewFull.at(db[8]).getTickLiquidity(db[9], darg)[1]; }
                  else { dnet = IUniswapV3PoolFull.at(db[1]).ticks(darg)[1]; }
                }
                const dneg: Uint256 = dnet >= HALF128 ? 1 : 0;
                if (zb === 1) {
                  if (dneg === 1) { dL = dL + (MOD128 - dnet); } else { dL = dL >= dnet ? dL - dnet : 0; }
                  dsh = dsh - dts;
                } else {
                  if (dneg === 1) { const dm: Uint256 = MOD128 - dnet; dL = dL >= dm ? dL - dm : 0; } else { dL = dL + dnet; }
                  dsh = dsh + dts;
                }
                dnNear[pI] = lgFR[L];
                dnL[pI] = dL;
                dnShift[pI] = dsh;
                brFar[pI] = 0; // crossed fully ⇒ next bracket re-derives its far
                dnSteps[pI] = dnSteps[pI] + 1;
                if (dnSteps[pI] >= PER_POOL) { dnOn[pI] = 0; }
                const extB: Uint256 = db[13];
                if (dL === 0) { if (extB > 0) {
                  let pastExt: Uint256 = 0;
                  if (zb === 1) { if (dsh < extB) { pastExt = 1; } }
                  else { if (dsh > extB) { pastExt = 1; } }
                  if (pastExt === 1) { dnOn[pI] = 0; }
                } }
                }
              } else {
                // Partial leg: near → lgNF[L] (interior, no cross), keep the bracket far fixed.
                // V2 leg pool stores near as out/in directly (no real-sqrt grid, no brFar latch).
                // ZERO-FLOW (interior-gap) event guard: routeIn==0 means the BINDING leg sits at an
                // L==0 gap and NO token flows this event, so a non-binding leg neither moves nor
                // absorbs — leave it UNTOUCHED (matches the oracle, which elides the gap via a cursor
                // jump inside the adjacent real event). Applying lgNF[L] here (== near) would drift a
                // oneForZero leg's near by the toOutIn round-trip + stray-latch its brFar.
                if (routeIn > 0) {
                  if (pools[pI][6] === 1) {
                    dnNear[pI] = lgNF[L];
                  } else {
                    dnNear[pI] = toOutIn(lgNF[L], zArr[pI]);
                    if (brFar[pI] === 0) { brFar[pI] = lgFR[L]; }
                  }
                }
              }
            }
          }
          rinp[bestRoute] = rinp[bestRoute] + rtake;
          cum = cum + rtake;
        } else {
          if ((HAS_CURVE || HAS_LB || HAS_DODO || HAS_SOLIDLY_STABLE || HAS_WOMBAT || HAS_BALANCER || HAS_EULER || HAS_MAVERICK || HAS_CRYPTO || HAS_WOOFI || HAS_FERMI || HAS_FLUID || HAS_MENTO || HAS_BALANCER_V3) &&bestKind === 1) {
            // ── sampled-segment slice: a fixed capacity slice at a fixed post-fee price. Consume the
            // [segCur] merged-stream row (parallel arrays), clamp to the remaining global budget, and
            // accumulate the take into the per-venue Σ keyed by segKind (1 Curve → cinp/cven,
            // 2 LB → linp/lven, 3 DODO → dinp/dven), stamping the venue address from the row. For a QL
            // Curve row this slice was BUILT on-chain from live get_dy; for a static row it came from
            // the compiler arg — either way the awarded Σ executes below via the engine swap. Advance.
            const sIdx: Uint256 = msRef[segCur];
            const sCap: Uint256 = msCap[segCur];
            const sKind: Uint256 = msKind[segCur];
            const sVenue: Address = msVen[segCur];
            let stake: Uint256 = sCap;
            if (cum + sCap >= amountIn) { stake = amountIn - cum; }
            if (HAS_CURVE && sKind === 1) {
              cinp[sIdx] = cinp[sIdx] + stake;
              cven[sIdx] = sVenue;
            } else {
              if (HAS_LB && sKind === 2) {
                linp[sIdx] = linp[sIdx] + stake;
                lven[sIdx] = sVenue;
              } else {
                if (HAS_DODO && sKind === 3) {
                  dinp[sIdx] = dinp[sIdx] + stake;
                  dven[sIdx] = sVenue;
                } else {
                  if (HAS_SOLIDLY_STABLE && sKind === 4) {
                    // segKind 4 — Solidly STABLE (sAMM): callback-free, executed below via getAmountOut.
                    sinp[sIdx] = sinp[sIdx] + stake;
                    sven[sIdx] = sVenue;
                  } else {
                    if (HAS_WOMBAT && sKind === 5) {
                      // segKind 5 — Wombat: callback-free, executed below via quotePotentialSwap + swap.
                      winp[sIdx] = winp[sIdx] + stake;
                      wven[sIdx] = sVenue;
                    } else {
                      // segKind 6 — Balancer V2 ComposableStable: executed below via the engine
                      // BalancerV2 dispatch (swap poolType:4 → _swapBalancerV2 → Vault.swap).
                      if (HAS_BALANCER && sKind === 6) {
                        binp[sIdx] = binp[sIdx] + stake;
                        bven[sIdx] = sVenue;
                      } else {
                        if (HAS_EULER && sKind === 7) {
                          // segKind 7 — EulerSwap (Euler vault-backed AMM, v1+v2): callback-free, executed
                          // below via computeQuote (the exact-in-dy out for the awarded share) + transfer
                          // + pool.swap(a0Out, a1Out, to, "") (EMPTY data ⇒ no flash callback).
                          einp[sIdx] = einp[sIdx] + stake;
                          even[sIdx] = sVenue;
                        } else {
                          // segKind 8 — Maverick V2 (bin-based directional AMM): executed below via the
                          // engine MaverickV2 dispatch (swap poolType:7 → _swapMaverickV2 → the pool's
                          // maverickV2SwapCallback pulls the input mid-swap). Maverick is a CALLBACK pool,
                          // so it MUST go through the engine (not callback-free).
                          if (HAS_MAVERICK && sKind === 8) {
                            minp[sIdx] = minp[sIdx] + stake;
                            mven[sIdx] = sVenue;
                          } else {
                            // segKind 9 — Curve CryptoSwap: callback-free, executed below via get_dy
                            // (min_dy) + approve + exchange(uint256 i, uint256 j, Σ, min_dy).
                            if (HAS_CRYPTO && sKind === 9) {
                              cryinp[sIdx] = cryinp[sIdx] + stake;
                              cryven[sIdx] = sVenue;
                            } else {
                              // segKind 10 — WOOFi (WooPPV2 sPMM): callback-free, executed below via
                              // query (minToAmount) + transfer + swap (WooPPV2 is transfer-first).
                              if (HAS_WOOFI && sKind === 10) {
                                wooinp[sIdx] = wooinp[sIdx] + stake;
                                wooven[sIdx] = sVenue;
                              } else {
                                // segKind 11 — Fermi/propAMM (Obric-style proactive AMM): callback-free,
                                // executed below via getAmountOut (minOut) + approve + swap (propAMM PULLS
                                // via transferFrom, so approve-first, unlike WOOFi's transfer-first path).
                                if (HAS_FERMI && sKind === 11) {
                                  feinp[sIdx] = feinp[sIdx] + stake;
                                  feven[sIdx] = sVenue;
                                } else {
                                  // segKind 12 — Fluid DEX (FluidDexT1 Liquidity-Layer-backed re-centering
                                  // AMM): callback-free, executed below via the resolver estimateSwapIn
                                  // (minOut) + approve + pool.swapIn (Fluid PULLS via safeTransferFrom, so
                                  // approve-first, like Fermi — NOT transfer-first like WOOFi).
                                  if (HAS_FLUID && sKind === 12) {
                                    flinp[sIdx] = flinp[sIdx] + stake;
                                    flven[sIdx] = sVenue;
                                  } else {
                                    // segKind 13 — Mento V2 (Celo Broker + BiPoolManager stablecoin
                                    // exchange): callback-free, executed below via the Broker getAmountOut
                                    // (minOut) + approve BROKER + broker.swapIn (Mento PULLS via transferFrom
                                    // into the reserve, so approve-first, like Fermi/Fluid — NOT transfer-first
                                    // like WOOFi). sVenue (segs[5]) is the exchangeProvider; sg[6] is the
                                    // bytes32 exchangeId (as uint256, kept intact — not truncated).
                                    if (HAS_MENTO && sKind === 13) {
                                      mtinp[sIdx] = mtinp[sIdx] + stake;
                                      mtven[sIdx] = sVenue;
                                      mtxid[sIdx] = msAux[segCur];
                                    } else {
                                      // segKind 14 — Balancer V3 (balancer-v3-monorepo Vault + per-chain
                                      // Router): callback-free, executed below via querySwapSingleTokenExactIn
                                      // (minAmountOut) + ERC20.approve(PERMIT2) + Permit2.approve(ROUTER) +
                                      // Router.swapSingleTokenExactIn (the V3 input is PULLED via Permit2, the
                                      // one operational difference from V2; the reentrancy is contained inside
                                      // Balancer's Router+Vault, never this cooking contract). sVenue (segs[5])
                                      // is the Vault POOL; the chain-wide Router is cfg[8].
                                      if (HAS_BALANCER_V3 && sKind === 14) {
                                        b3inp[sIdx] = b3inp[sIdx] + stake;
                                        b3ven[sIdx] = sVenue;
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
            cum = cum + stake;
            segCur = segCur + 1;
          }
        }
      }
    }
  }

  // ── COMPUTE-THEN-PULL + execution ──
  if (cum > 0) {
    token.transferFrom(caller, address.self, cum);
  }
  // Direct pools: universe indices [0, directCount). Direction per pd[7].
  for (let p = 0; p < pools.length; p = p + 1) {
    if (p < directCount) {
      const amt: Uint256 = inp[p];
      if (amt > 0) {
        const dp: Tuple = pools[p];
        const isV2: Uint256 = dp[6];
        const pType: Uint256 = dp[0];
        const pz: Uint256 = dp[7];
        if (HAS_KYBER && dp[16] === 1) {
          // KyberSwap Classic / DMM — callback-free, output computed on the VIRTUAL reserves with
          // the LIVE feeInPrecision (the genuine Kyber getAmountOut), so the realized swap lands +
          // conserves on the amplified curve. The merge already grossed by the rounded ppm, so the
          // allocated `amt` matches the oracle to the wei; the executed dy is the true on-curve out.
          //   amountInWithFee = amt*(PRECISION - feeInPrecision)/PRECISION
          //   amountOut       = amountInWithFee*vReserveOut / (vReserveIn + amountInWithFee)
          const kpool: Address = dp[1];
          const kvr0: Uint256 = IKyberPool.at(kpool).getTradeInfo()[2]; // vReserve0
          const kvr1: Uint256 = IKyberPool.at(kpool).getTradeInfo()[3]; // vReserve1
          const kfee: Uint256 = IKyberPool.at(kpool).getTradeInfo()[4]; // feeInPrecision (1e18)
          const kIsT0: Uint256 = dp[7];
          const kVin: Uint256 = kIsT0 === 1 ? kvr0 : kvr1;
          const kVout: Uint256 = kIsT0 === 1 ? kvr1 : kvr0;
          const kOut: Uint256 = kyberOut(amt, kfee, kVin, kVout, KYBER_PRECISION);
          if (kOut > 0) {
            token.transfer(kpool, amt);
            const kEmpty: bytes = abi.encode(tokenIn).slice(0, 0);
            // Output sits in the pool's OUT-token slot (mirrors the V2 callback-free path).
            if (kIsT0 === 1) {
              IKyberPool.at(kpool).swap(0, kOut, address.self, kEmpty);
            } else {
              IKyberPool.at(kpool).swap(kOut, 0, address.self, kEmpty);
            }
          }
        } else {
        if (HAS_V2 && isV2 === 1) {
          const v2fee: Uint256 = dp[5];
          if (v2fee === V2_DEFAULT_FEE) {
            // 0.30% pool — the engine's _swapV2 honors exactly this fee, so use the
            // unified router swap (it pulls input + computes output at 997/1000).
            const cc0: Address = pz === 1 ? tokenIn : tokenOut;
            const cc1: Address = pz === 1 ? tokenOut : tokenIn;
            router.swap({
              poolType: 0, pool: dp[1],
              poolKey: { currency0: cc0, currency1: cc1, fee: 0, tickSpacing: 0, hooks: 0 },
              tokenIn: tokenIn, tokenOut: tokenOut, amountSpecified: Math.neg(amt),
              sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
            });
          } else {
            // Non-0.30% V2-class pool — the engine's _swapV2 would mis-fee it, so execute
            // CALLBACK-FREE in SauceScript with the pool's REAL fee: read live reserves,
            // compute the constant-product output grossing by feePpm EXACTLY as the merge/
            // oracle did, transfer the input to the pair, then call pair.swap(...) with the
            // computed output and empty data. No router, no callback, no engine change.
            //   amountInWithFee = amt*(FEE_DENOM - feePpm)
            //   amountOut = amountInWithFee*resOut / (resIn*FEE_DENOM + amountInWithFee)
            const pair: Address = dp[1];
            const r0v: Uint256 = IUniswapV2Pair.at(pair).getReserves()[0];
            const r1v: Uint256 = IUniswapV2Pair.at(pair).getReserves()[1];
            const inIsT0: Uint256 = dp[7];
            const resIn: Uint256 = inIsT0 === 1 ? r0v : r1v;
            const resOut: Uint256 = inIsT0 === 1 ? r1v : r0v;
            const amtInWithFee: Uint256 = amt * (FEE_DENOM - v2fee);
            const denom: Uint256 = resIn * FEE_DENOM + amtInWithFee;
            let amountOut: Uint256 = 0;
            if (denom > 0) {
              amountOut = Math.mulDiv(amtInWithFee, resOut, denom);
            }
            if (amountOut > 0) {
              token.transfer(pair, amt);
              const empty: bytes = abi.encode(tokenIn).slice(0, 0);
              // Output sits in the pool's OUT-token slot: tokenIn==token0 ⇒ out is token1
              // (amount1Out); tokenIn==token1 ⇒ out is token0 (amount0Out).
              if (inIsT0 === 1) {
                IUniswapV2Pair.at(pair).swap(0, amountOut, address.self, empty);
              } else {
                IUniswapV2Pair.at(pair).swap(amountOut, 0, address.self, empty);
              }
            }
          }
        } else {
          if (HAS_V4 && pType === 2) {
            const k0: Address = pz === 1 ? tokenIn : tokenOut;
            const k1: Address = pz === 1 ? tokenOut : tokenIn;
            router.swap({
              poolType: 2, pool: dp[1],
              poolKey: { currency0: k0, currency1: k1, fee: dp[2], tickSpacing: dp[3], hooks: dp[4] },
              tokenIn: tokenIn, tokenOut: tokenOut, amountSpecified: Math.neg(amt),
              sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
            });
          } else {
            router.swapV3(dp[1], tokenIn, tokenOut, amt, priceLimit, address.self, address.self);
          }
        }
        }
      }
    }
  }
  // Routes: chain-order leg execution reading the REALIZED intermediate balance between legs.
  // N-hop, ANY leg-pool type: walk the route's legCount legs in order. Leg L's INPUT token is
  // tokenIn (L==0) else the previous intermediate (rt[3*L]); its OUTPUT token is tokenOut (final
  // leg) else this leg's intermediate (rt[3+3L]). Leg 0 swaps the route's COMPUTED tokenIn shares
  // (inp[a]); every later leg feeds the REALIZED input-token balance, distributed proportional to
  // inp[] across the leg's pools (the last funded pool takes the remainder to absorb multi-pool-leg
  // dust). Each leg pool is dispatched by type (pd[0]/pd[6]) — swapV3 for V3, swap(poolType:0) for
  // V2, swap(poolType:2) for V4 with the leg PoolKey — MIRRORING the direct-pool execution block.
  // 2-hop and 3-hop are the same loop.
  if (HAS_ROUTES) {
  for (let r = 0; r < routing.length; r = r + 1) {
    const ramt: Uint256 = rinp[r];
    if (ramt > 0) {
      const rt: Tuple = routing[r];
      const legCount: Uint256 = rt[0];
      for (let L = 0; L < legCount; L = L + 1) {
        const baseL: Uint256 = rt[1 + 3 * L];
        const eL: Uint256 = baseL + rt[2 + 3 * L];
        // leg input token: tokenIn for leg0, else the previous leg's intermediate (rt[3*L]).
        let legIn: Address = tokenIn;
        if (L > 0) { legIn = rt[3 * L]; }
        // leg output token: this leg's intermediate (rt[3+3L]) unless this is the final leg.
        let legOut: Address = tokenOut;
        if (L + 1 < legCount) { legOut = rt[3 + 3 * L]; }
        if (L === 0) {
          // leg0: split the route's computed tokenIn share across its pools (tokenIn → legOut).
          for (let a = baseL; a < eL; a = a + 1) {
            const a0: Uint256 = inp[a];
            if (a0 > 0) {
              const lp: Tuple = pools[a];
              const lIsV2: Uint256 = lp[6];
              const lType: Uint256 = lp[0];
              const lz: Uint256 = lp[7]; // leg pool's inIsToken0 (legIn-is-currency0 when 1)
              if (lIsV2 === 1) {
                const c0: Address = lz === 1 ? legIn : legOut;
                const c1: Address = lz === 1 ? legOut : legIn;
                router.swap({
                  poolType: 0, pool: lp[1],
                  poolKey: { currency0: c0, currency1: c1, fee: 0, tickSpacing: 0, hooks: 0 },
                  tokenIn: legIn, tokenOut: legOut, amountSpecified: Math.neg(a0),
                  sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
                });
              } else {
                if (lType === 2) {
                  const k0: Address = lz === 1 ? legIn : legOut;
                  const k1: Address = lz === 1 ? legOut : legIn;
                  router.swap({
                    poolType: 2, pool: lp[1],
                    poolKey: { currency0: k0, currency1: k1, fee: lp[2], tickSpacing: lp[3], hooks: lp[4] },
                    tokenIn: legIn, tokenOut: legOut, amountSpecified: Math.neg(a0),
                    sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
                  });
                } else {
                  router.swapV3(lp[1], legIn, legOut, a0, 0, address.self, address.self);
                }
              }
            }
          }
        } else {
          // leg L>0: feed the REALIZED input-token balance across the leg's pools (legIn → legOut).
          // WHOLE-BALANCE DRAIN: reads the ENTIRE balanceOf(legIn) and the last pool takes the
          // remainder. This is correct ONLY because routes run fully sequentially (the enclosing
          // `for r`), so each route produces AND consumes its intermediate within its own contiguous
          // run before the next route deposits the same token. Two admitted disjoint-POOL routes may
          // still share an intermediate TOKEN via different edges; that safety rests on THIS exec
          // order, NOT on prepare's disjoint-pool filter — do not batch legs across routes.
          const inBal: Uint256 = IERC20.at(legIn).balanceOf(address.self);
          if (inBal > 0) {
            let lTotal: Uint256 = 0;
            for (let b = baseL; b < eL; b = b + 1) { lTotal = lTotal + inp[b]; }
            if (lTotal > 0) {
              let spent: Uint256 = 0;
              let lastIdx: Uint256 = baseL;
              for (let b = baseL; b < eL; b = b + 1) {
                if (inp[b] > 0) { lastIdx = b; }
              }
              for (let b = baseL; b < eL; b = b + 1) {
                const w: Uint256 = inp[b];
                if (w > 0) {
                  let share: Uint256 = Math.mulDiv(inBal, w, lTotal);
                  if (b === lastIdx) { share = inBal - spent; }
                  if (share > 0) {
                    const lp: Tuple = pools[b];
                    const lIsV2: Uint256 = lp[6];
                    const lType: Uint256 = lp[0];
                    const lz: Uint256 = lp[7];
                    if (lIsV2 === 1) {
                      const c0: Address = lz === 1 ? legIn : legOut;
                      const c1: Address = lz === 1 ? legOut : legIn;
                      router.swap({
                        poolType: 0, pool: lp[1],
                        poolKey: { currency0: c0, currency1: c1, fee: 0, tickSpacing: 0, hooks: 0 },
                        tokenIn: legIn, tokenOut: legOut, amountSpecified: Math.neg(share),
                        sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
                      });
                    } else {
                      if (lType === 2) {
                        const k0: Address = lz === 1 ? legIn : legOut;
                        const k1: Address = lz === 1 ? legOut : legIn;
                        router.swap({
                          poolType: 2, pool: lp[1],
                          poolKey: { currency0: k0, currency1: k1, fee: lp[2], tickSpacing: lp[3], hooks: lp[4] },
                          tokenIn: legIn, tokenOut: legOut, amountSpecified: Math.neg(share),
                          sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
                        });
                      } else {
                        router.swapV3(lp[1], legIn, legOut, share, 0, address.self, address.self);
                      }
                    }
                    spent = spent + share;
                  }
                }
              }
            } else {
              router.swapV3(pools[baseL][1], legIn, legOut, inBal, 0, address.self, address.self);
            }
          }
        }
      }
    }
  }
  }
  // ── Sampled-segment venue execution (Curve / LB / DODO) ──
  // Each engaged venue executes its merged Σ share via ONE atomic engine swap. The curve math is
  // OFF-CHAIN, so the SwapParams carry NO curve data — the engine resolves everything on-chain:
  // _swapCurve iterates coins() against tokenIn/tokenOut for the int128 i/j; _swapTraderJoeLB
  // resolves swapForY from getTokenX(); _swapDODOV2 resolves base/quote from _BASE_TOKEN_().
  // amountSpecified is NEGATIVE (the unified-swap exact-in convention; each _swapX takes abs()).
  // payer == address.self because compute-then-pull already transferred `cum` (incl. every venue
  // share) above, so each _swapX pulls from this contract and forwards the out back here
  // (recipient). The realized out is wei-exact for the share (one atomic exchange / pair.swap /
  // sellBase|sellQuote); the SPLIT equalizes post-fee marginals on the sampled grid (exact-on-grid
  // for Curve/DODO, EXACT for LB). The poolKey is unused for these poolTypes (V4 only) — zeroed to
  // match the V2-path SwapParams shape. One loop per kind over the segment-stream-sized accumulator.

  // Curve StableSwap → poolType 3 (SwapPoolType.Curve) → _swapCurve → exchange(i, j, dx, 0).
  if (HAS_CURVE) {
  for (let c = 0; c < MS_CAP; c = c + 1) {
    const camt: Uint256 = cinp[c];
    if (camt > 0) {
      const cpool: Address = cven[c];
      router.swap({
        poolType: 3, pool: cpool,
        poolKey: { currency0: 0, currency1: 0, fee: 0, tickSpacing: 0, hooks: 0 },
        tokenIn: tokenIn, tokenOut: tokenOut, amountSpecified: Math.neg(camt),
        sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
      });
    }
  }
  }
  // Trader Joe LB → poolType 6 (SwapPoolType.TraderJoeLB) → _swapTraderJoeLB → pair.swap(swapForY, to).
  if (HAS_LB) {
  for (let l = 0; l < MS_CAP; l = l + 1) {
    const lamt: Uint256 = linp[l];
    if (lamt > 0) {
      const lpool: Address = lven[l];
      router.swap({
        poolType: 6, pool: lpool,
        poolKey: { currency0: 0, currency1: 0, fee: 0, tickSpacing: 0, hooks: 0 },
        tokenIn: tokenIn, tokenOut: tokenOut, amountSpecified: Math.neg(lamt),
        sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
      });
    }
  }
  }
  // DODO V2 PMM → poolType 5 (SwapPoolType.DODOV2) → _swapDODOV2 → sellBase|sellQuote(to).
  if (HAS_DODO) {
  for (let d = 0; d < MS_CAP; d = d + 1) {
    const damt: Uint256 = dinp[d];
    if (damt > 0) {
      const dpool: Address = dven[d];
      router.swap({
        poolType: 5, pool: dpool,
        poolKey: { currency0: 0, currency1: 0, fee: 0, tickSpacing: 0, hooks: 0 },
        tokenIn: tokenIn, tokenOut: tokenOut, amountSpecified: Math.neg(damt),
        sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
      });
    }
  }
  }
  // Solidly STABLE (sAMM) → CALLBACK-FREE (NO engine SwapPoolType). Solidly stable pools trade on
  // the x3y+y3x invariant (NOT xy=k), so the engine's _swapV2 would mis-price them. Execute exactly
  // as the pool's own router would: read the EXACT amountOut from the pool's getAmountOut view (the
  // view IS the swap math ⇒ wei-exact-in-dy for the awarded share), transfer the awarded input to
  // the pool, then call pool.swap(amount0Out, amount1Out, to, "") with the output in the OUT-token
  // slot (tokenIn==token0 ⇒ out is amount1Out; tokenIn==token1 ⇒ out is amount0Out). compute-then-
  // pull already transferred `cum` (incl. each stable share) into this contract above.
  if (HAS_SOLIDLY_STABLE) {
  for (let q = 0; q < MS_CAP; q = q + 1) {
    const samt: Uint256 = sinp[q];
    if (samt > 0) {
      const spool: Address = sven[q];
      const sOut: Uint256 = ISolidlyStablePool.at(spool).getAmountOut(samt, tokenIn);
      if (sOut > 0) {
        const sT0: Address = ISolidlyStablePool.at(spool).token0();
        token.transfer(spool, samt);
        const sEmpty: bytes = abi.encode(tokenIn).slice(0, 0);
        if (sT0 === tokenIn) {
          ISolidlyStablePool.at(spool).swap(0, sOut, address.self, sEmpty);
        } else {
          ISolidlyStablePool.at(spool).swap(sOut, 0, address.self, sEmpty);
        }
      }
    }
  }
  }
  // Wombat (single-sided stableswap) → CALLBACK-FREE (NO engine SwapPoolType). Wombat is a
  // coverage-ratio stableswap (NOT xy=k), so the engine's _swapV2 would mis-price it. Execute exactly
  // as the pool's own router would: read the EXACT actualToAmount from the pool's quotePotentialSwap
  // view (the view IS the swap math ⇒ wei-exact-in-dy for the awarded share), APPROVE the pool to pull
  // the awarded input (Wombat PULLS via transferFrom inside swap, unlike the transfer-first V2/Solidly
  // path), then call swap(fromToken, toToken, fromAmount, minimumToAmount, to, deadline) with
  // minimumToAmount == the quoted out (the realized out == the quote ⇒ the min never trips) and a
  // far-future deadline. compute-then-pull already transferred `cum` (incl. each Wombat share) into
  // this contract above, so the approved pull draws from this contract's balance and the out lands
  // here (to == address.self). fromToken/toToken == tokenIn/tokenOut (the swap's own tokens).
  if (HAS_WOMBAT) {
  for (let w = 0; w < MS_CAP; w = w + 1) {
    const wamt: Uint256 = winp[w];
    if (wamt > 0) {
      const wpool: Address = wven[w];
      // Index the quote tuple INLINE (mirrors the Kyber getTradeInfo()[k] pattern) — a Tuple-var
      // round-trip of a call result drops the descriptor and reverts INDEX on v1.
      const wOut: Uint256 = IWombatPool.at(wpool).quotePotentialSwap(tokenIn, tokenOut, wamt)[0];
      if (wOut > 0) {
        const wDeadline: Uint256 = 2 ** 64;
        token.approve(wpool, wamt);
        IWombatPool.at(wpool).swap(tokenIn, tokenOut, wamt, wOut, address.self, wDeadline);
      }
    }
  }
  }
  // Balancer V2 ComposableStable → poolType 4 (SwapPoolType.BalancerV2) → _swapBalancerV2 → it derives
  // poolId via pool.getPoolId() and calls Vault.swap(SingleSwap{GIVEN_IN, assetIn:tokenIn,
  // assetOut:tokenOut, amount, userData:0x}). The StableMath (A-invariant + BPT exclusion + scaling-
  // factor up/downscale + the swap fee) runs INSIDE the Vault, so the SwapParams carry NO curve data —
  // the segment merge already used it (exact-on-grid), and the realized out is wei-exact for the share
  // (one atomic Vault.swap). amountSpecified is NEGATIVE (the unified exact-in convention; _swapBalancerV2
  // takes abs()). payer == address.self (compute-then-pull transferred `cum`, incl. each Balancer share,
  // above) and recipient == address.self. The poolKey is unused for poolType 4 (V4 only) — zeroed to
  // match the V2-path SwapParams shape.
  if (HAS_BALANCER) {
  for (let b = 0; b < MS_CAP; b = b + 1) {
    const bamt: Uint256 = binp[b];
    if (bamt > 0) {
      const bpool: Address = bven[b];
      router.swap({
        poolType: 4, pool: bpool,
        poolKey: { currency0: 0, currency1: 0, fee: 0, tickSpacing: 0, hooks: 0 },
        tokenIn: tokenIn, tokenOut: tokenOut, amountSpecified: Math.neg(bamt),
        sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
      });
    }
  }
  }
  // EulerSwap (Euler vault-backed AMM, v1+v2) → CALLBACK-FREE (NO engine SwapPoolType). EulerSwap pools
  // have an ASYMMETRIC concentrated-liquidity curve (f/fInverse, NOT xy=k), so the engine's _swapV2
  // would mis-price them. Execute exactly as the EulerSwap periphery would: read the EXACT amountOut
  // from the pool's computeQuote(tokenIn, tokenOut, Σ, true) view (the periphery quoteExactInput
  // delegates to this view, and the view IS the swap math ⇒ wei-exact-in-dy for the awarded share),
  // transfer the awarded input to the pool, then call swap(amount0Out, amount1Out, to, "") with the
  // output in the OUT-token slot (tokenIn==token0 ⇒ out is amount1Out; tokenIn==token1 ⇒ out is
  // amount0Out) and EMPTY data — EulerSwap's swap is V2-shaped, so empty data skips the flash callback
  // and the pool sweeps the pre-transferred input + verifies the curve (callback-free). compute-then-
  // pull already transferred `cum` (incl. each EulerSwap share) into this contract above. Vault-cap
  // safety: the QL ladder already self-truncated at the LIVE inLimit/outLimit (the setup probe caught
  // computeQuote's SwapLimitExceeded/Expired), so the awarded `eamt` is at/below the last valid ladder
  // point ⇒ strictly within the live cap ⇒ this exec computeQuote cannot cap-revert on the awarded
  // amount (the cap-revert DoS is gone). A literal 0 quote (a pool returning 0 at its cap) falls
  // through and leaves the input un-spent for the terminal refund.
  if (HAS_EULER) {
  for (let e = 0; e < MS_CAP; e = e + 1) {
    const eamt: Uint256 = einp[e];
    if (eamt > 0) {
      const epool: Address = even[e];
      const eOut: Uint256 = IEulerSwapPool.at(epool).computeQuote(tokenIn, tokenOut, eamt, true);
      if (eOut > 0) {
        // Orient the output slot by the pool's OWN asset0 (EulerSwap's token0/token1 are vault0/vault1
        // from the LP config — NOT necessarily address-sorted), exactly as the Solidly path reads
        // token0(): tokenIn==asset0 ⇒ out is amount1Out; else out is amount0Out. The real IEulerSwap
        // exposes assets via getAssets() → (asset0, asset1), not an asset0() getter.
        const eA0: Address = IEulerSwapPool.at(epool).getAssets()[0];
        token.transfer(epool, eamt);
        const eEmpty: bytes = abi.encode(tokenIn).slice(0, 0);
        if (eA0 === tokenIn) {
          IEulerSwapPool.at(epool).swap(0, eOut, address.self, eEmpty);
        } else {
          IEulerSwapPool.at(epool).swap(eOut, 0, address.self, eEmpty);
        }
      }
    }
  }
  }
  // Maverick V2 → poolType 7 (SwapPoolType.MaverickV2) → _swapMaverickV2. Maverick is a CALLBACK pool:
  // the engine reads the pool's tokenA(), sets tokenAIn, and calls pool.swap(recipient, SwapParams{amount,
  // tokenAIn, exactOutput:false, tickLimit: full-range}, ""); the pool re-enters maverickV2SwapCallback(
  // amountToPay, …) to pull the input from the payer. So the bin math runs INSIDE the pool + engine callback,
  // and the SwapParams carry NO curve data — the segment merge already used it (exact-on-grid), and the
  // realized out is the engine swap (cross-checked wei-exact against the on-chain quoter in the EVM test).
  // amountSpecified is NEGATIVE (the unified exact-in convention; _swapMaverickV2 takes abs()). payer ==
  // address.self (compute-then-pull transferred `cum`, incl. each Maverick share, above) so the callback's
  // safeTransfer draws from this contract; recipient == address.self. The poolKey is unused for poolType 7
  // — zeroed to match the V2-path SwapParams shape. The engine passes the per-direction FULL-RANGE tickLimit
  // (type(int32).max for tokenA-in, type(int32).min for tokenB-in — ../sauce PR #193), so the swap walks the
  // whole live tick book bounded only by liquidity (it may cross tick 0); the sampler used the SAME bound
  // (buildMaverickSegments' maxInput cap) so the awarded Σ fills within the pool's depth (any un-consumed
  // input is returned by the guarded terminal refund below).
  if (HAS_MAVERICK) {
  for (let m = 0; m < MS_CAP; m = m + 1) {
    const mamt: Uint256 = minp[m];
    if (mamt > 0) {
      const mpool: Address = mven[m];
      router.swap({
        poolType: 7, pool: mpool,
        poolKey: { currency0: 0, currency1: 0, fee: 0, tickSpacing: 0, hooks: 0 },
        tokenIn: tokenIn, tokenOut: tokenOut, amountSpecified: Math.neg(mamt),
        sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
      });
    }
  }
  }
  // Curve CryptoSwap (twocrypto/tricrypto-ng volatile-asset) → CALLBACK-FREE (NO engine SwapPoolType).
  // CryptoSwap pools trade on the A-gamma invariant with a dynamic fee AND use UINT256 coin indices
  // (exchange(uint256 i, uint256 j, dx, min_dy)), so the engine's _swapCurve (exchange(int128,...))
  // does NOT match them. Execute exactly as the Curve router would: resolve the pool's uint256 coin
  // indices on-chain by reading coins(0) (2-coin pool ⇒ tokenIn is coin0 iff coins(0)==tokenIn, else
  // coin1; the other coin is 1-i), read the EXACT out from the pool's own get_dy(i, j, Σ) view (the
  // view IS the swap math ⇒ wei-exact-in-dy for the awarded share) as min_dy, APPROVE the pool for the
  // awarded input (Curve exchange PULLS via transferFrom, like Wombat — unlike the transfer-first
  // V2/Solidly path), then call exchange(i, j, Σ, min_dy) (min_dy == the quoted out ⇒ the min never
  // trips). compute-then-pull already transferred `cum` (incl. each CryptoSwap share) into this
  // contract above, so the approved pull draws from this contract's balance and the out lands here.
  if (HAS_CRYPTO) {
  for (let x = 0; x < MS_CAP; x = x + 1) {
    const cxamt: Uint256 = cryinp[x];
    if (cxamt > 0) {
      const cxpool: Address = cryven[x];
      const cxc0: Address = ICryptoSwapPool.at(cxpool).coins(0);
      let cxi: Uint256 = 1;
      let cxj: Uint256 = 0;
      if (cxc0 === tokenIn) { cxi = 0; cxj = 1; }
      const cxOut: Uint256 = ICryptoSwapPool.at(cxpool).get_dy(cxi, cxj, cxamt);
      if (cxOut > 0) {
        token.approve(cxpool, cxamt);
        ICryptoSwapPool.at(cxpool).exchange(cxi, cxj, cxamt, cxOut);
      }
    }
  }
  }
  // WOOFi (WooPPV2 synthetic proactive market maker) → CALLBACK-FREE (NO engine SwapPoolType). WOOFi is
  // an ORACLE-PRICED sPMM (it prices off its on-chain WooracleV2 feed, NOT xy=k), so the engine's _swapV2
  // would mis-price it. Execute exactly as the WooRouter would: read the EXACT toAmount from the pool's
  // query(tokenIn, tokenOut, Σ) view (which reads the LIVE oracle ⇒ wei-exact-in-dy for the awarded share)
  // as minToAmount, TRANSFER the awarded input to the pool (WooPPV2 is TRANSFER-FIRST — swap computes the
  // sold amount from balanceOf(fromToken) − reserve, unlike the approve/pull Wombat/Curve path), then call
  // swap(fromToken, toToken, Σ, minToAmount, to, rebateTo). minToAmount == the queried out (the realized
  // out == the live query ⇒ the min never trips when the oracle is unchanged; if the oracle MOVED between
  // this query and the swap the min re-reads the SAME live state atomically, so it still holds). compute-
  // then-pull already transferred `cum` (incl. each WOOFi share) into this contract above, so the transfer
  // draws from this contract's balance and the out lands here (to == address.self; rebateTo == caller).
  if (HAS_WOOFI) {
  for (let y = 0; y < MS_CAP; y = y + 1) {
    const wooamt: Uint256 = wooinp[y];
    if (wooamt > 0) {
      const woopool: Address = wooven[y];
      const wooOut: Uint256 = IWooFiPool.at(woopool).query(tokenIn, tokenOut, wooamt);
      if (wooOut > 0) {
        token.transfer(woopool, wooamt);
        IWooFiPool.at(woopool).swap(tokenIn, tokenOut, wooamt, wooOut, address.self, caller);
      }
    }
  }
  }
  // Fermi / propAMM (gattaca-com/propamm FermiSwapper — Obric-style proactive AMM) → CALLBACK-FREE (NO engine
  // SwapPoolType). propAMM prices off its OWN on-chain state, NOT xy=k, so the engine's _swapV2 would
  // mis-price it. Execute exactly as the propAMM taker would, against the REAL verified FermiSwapper surface:
  // read the LIVE amountOut from quoteAmounts(tokenIn, tokenOut, +Σ) — the real quote returns a TUPLE
  // (amountIn, amountOut); the second value ([1]) is the out for the exact-in leg (amountSpecified POSITIVE =
  // exact tokenIn per the taker convention). APPROVE the pool for the awarded input (propAMM PULLS via
  // transferFrom inside fermiSwapWithAllowances — approve-first, like Wombat/Curve, unlike the transfer-first
  // WOOFi/Solidly path), then call fermiSwapWithAllowances(tokenIn, tokenOut, +Σ, amountCheck, to) with
  // amountCheck == the just-quoted out (the exact-in slippage bound; it never trips when the state is
  // unchanged and re-reads the SAME live state atomically if the maker MOVED params between quote and swap).
  // compute-then-pull already transferred `cum` (incl. each Fermi share) into this contract above, so the
  // approved pull draws from this contract's balance and the out lands here (to == self).
  if (HAS_FERMI) {
  for (let f = 0; f < MS_CAP; f = f + 1) {
    const feamt: Uint256 = feinp[f];
    if (feamt > 0) {
      const fepool: Address = feven[f];
      // amountSpecified is a SIGNED int256; feamt is a realistic-size POSITIVE amount ⇒ encodes as +int256
      // (exact-in). The quote returns (amountIn, amountOut) — take [1] for the out.
      const feOut: Uint256 = IFermiPool.at(fepool).quoteAmounts(tokenIn, tokenOut, feamt)[1];
      if (feOut > 0) {
        token.approve(fepool, feamt);
        IFermiPool.at(fepool).fermiSwapWithAllowances(tokenIn, tokenOut, feamt, feOut, address.self);
      }
    }
  }
  }
  // Fluid DEX (Instadapp fluid-contracts-public FluidDexT1 — a Liquidity-Layer-backed re-centering AMM) →
  // CALLBACK-FREE (NO engine SwapPoolType). Fluid DEX prices off the Liquidity-Layer supply/borrow exchange
  // prices + a center price + utilization caps — canonical on-chain state, NOT xy=k — so the engine's
  // _swapV2 would mis-price it. Execute exactly as a Fluid taker would, against the REAL verified surface:
  // the DexT1 pool has NO getAmountOut view (its own estimate is a REVERT, FluidDexSwapResult, which this
  // interpreter can't try/catch), so read the LIVE amountOut from the periphery DexReservesResolver's
  // estimateSwapIn(dex, swap0to1, +Σ, 0) (it does the pool's revert-decode in Solidity and returns a plain
  // uint256 for the exact-in leg). NB this is a plain CALL, NOT a staticcall: the real FluidDexT1 pool WRITES
  // STATE on the ADDRESS_DEAD estimate path before it reverts with the result, so a STATICCALL would revert
  // and the resolver's catch would return 0 (proven by ecoswap.fluid.prodmirror.evm.test.ts) — IFluidDexResolver.json
  // marks estimateSwapIn `nonpayable` for exactly this; the internal revert rolls back any state, so the CALL
  // is side-effect-free in effect. swap0to1 is the pool's own token0()==tokenIn orientation. APPROVE the
  // pool for the awarded input (Fluid PULLS via safeTransferFrom inside swapIn — approve-first, like
  // Fermi/Wombat/Curve, unlike the transfer-first WOOFi/Solidly path), then call
  // pool.swapIn(swap0to1, +Σ, amountOutMin, to) with amountOutMin == the just-quoted out (the exact-in
  // slippage bound; it never trips when the layer state is unchanged and re-reads the SAME live state
  // atomically if the layer accrued / caps shrank between the quote and the swap). compute-then-pull
  // already transferred `cum` (incl. each Fluid share) into this contract above, so the approved pull draws
  // from this contract's balance and the out lands here (to == self). DexT1 re-enters its OWN Liquidity
  // layer via operate(), never this cooking contract, so it is callback-free — no engine change.
  if (HAS_FLUID) {
  for (let g = 0; g < MS_CAP; g = g + 1) {
    const flamt: Uint256 = flinp[g];
    if (flamt > 0) {
      const flpool: Address = flven[g];
      // swap0to1: true when tokenIn is the pool's token0. Derived on-chain via the resolver's getDexTokens
      // (the pool has NO token0()/token1() getters — token0/token1 live only inside constantsView()'s
      // struct) so the direction bit is never trusted from off-chain data. getDexTokens returns a 2-tuple
      // (token0, token1); take [0].
      const flt0: Address = IFluidDexResolver.at(fluidResolver).getDexTokens(flpool)[0];
      // swap0to1 is a uint256 0/1 — the compiler ABI-encodes it as the `bool` arg (BYTE_1). Derived
      // on-chain from the pool itself so the direction bit is never trusted from off-chain data.
      let flZ: Uint256 = 0;
      if (flt0 === tokenIn) { flZ = 1; }
      // LIVE quote via the resolver (amountOutMin 0 ⇒ pure quote) — the exact-in out for the awarded share.
      const flOut: Uint256 = IFluidDexResolver.at(fluidResolver).estimateSwapIn(flpool, flZ, flamt, 0);
      if (flOut > 0) {
        token.approve(flpool, flamt);
        IFluidDexPool.at(flpool).swapIn(flZ, flamt, flOut, address.self);
      }
    }
  }
  }
  // Mento V2 (Celo mento-protocol/mento-core Broker + BiPoolManager stablecoin exchange) → CALLBACK-FREE (NO
  // engine SwapPoolType). Mento is a BiPool oracle-priced exchange (the Broker routes to a registered
  // exchange provider that prices off oracle rates + a spread over interval-updated buckets — canonical
  // on-chain state, NOT xy=k), so the engine's _swapV2 would mis-price it. Execute exactly as a Mento taker
  // would, against the REAL verified surface: read the LIVE amountOut from the Broker's PLAIN
  // getAmountOut(exchangeProvider, exchangeId, tokenIn, tokenOut, +Σ) VIEW (no revert-decode resolver, unlike
  // Fluid) for the exact-in leg. The exchangeProvider is the accumulated venue (mtven, segs[5]) and the
  // exchangeId is the accumulated bytes32 (mtxid, segs[6]) — resolved OFF-CHAIN in discovery. APPROVE the
  // BROKER for the awarded input (Mento PULLS via transferFrom into the reserve inside swapIn —
  // approve-first, like Fermi/Fluid/Wombat/Curve, unlike the transfer-first WOOFi/Solidly path), then call
  // broker.swapIn(exchangeProvider, exchangeId, tokenIn, tokenOut, +Σ, amountOutMin) with amountOutMin ==
  // the just-quoted out (the exact-in slippage bound; it never trips when the bucket state is unchanged and
  // re-reads the SAME live state atomically if the buckets refreshed / a trading limit moved between the
  // quote and the swap). compute-then-pull already transferred `cum` (incl. each Mento share) into this
  // contract above, so the approved pull draws from this contract's balance and the out lands here (msg.sender
  // == self). swapIn re-enters only the Reserve / stable-asset mint-burn, never this cooking contract, so it
  // is callback-free — no engine change.
  if (HAS_MENTO) {
  for (let h = 0; h < MS_CAP; h = h + 1) {
    const mtamt: Uint256 = mtinp[h];
    if (mtamt > 0) {
      const mtprov: Address = mtven[h];
      const mtid: Uint256 = mtxid[h];
      // LIVE quote via the Broker (the exact-in out for the awarded share). mtid is the full bytes32
      // exchangeId (as uint256) — the compiler ABI-encodes it as the `bytes32` arg intact (not truncated).
      const mtOut: Uint256 = IMentoBroker.at(mentoBroker).getAmountOut(mtprov, mtid, tokenIn, tokenOut, mtamt);
      if (mtOut > 0) {
        token.approve(mentoBroker, mtamt);
        IMentoBroker.at(mentoBroker).swapIn(mtprov, mtid, tokenIn, tokenOut, mtamt, mtOut);
      }
    }
  }
  }
  // Balancer V3 (balancer-v3-monorepo — Vault singleton + per-chain Router) → CALLBACK-FREE (NO engine
  // SwapPoolType). A V3 pool prices off the Vault balances + rate providers + a possibly-dynamic StableSurge
  // hook fee — canonical on-chain state, NOT xy=k — so the engine's _swapV2 would mis-price it. The split is
  // priced OFF-CHAIN in prepare by sampling the Router's querySwapSingleTokenExactIn(pool, tokenIn, tokenOut,
  // +cumIn, sender, "") ladder via eth_call (it bakes in the rate providers + dynamic surge fee, so it is the
  // robust quote for both plain and surge pools). That query is eth_call-ONLY: it CANNOT be re-read on-chain
  // inside the cook (it demands a static-call context via the Vault's quote() — reverts NotStaticCall under a
  // plain CALL, and its internal unlock() state write reverts under a STATICCALL). So on-chain we execute the
  // awarded `b3amt` as a straight exact-in swap with minAmountOut = 0 (no per-leg on-chain floor — see the
  // per-leg comment below). The ONE operational difference from V2 is that the input is pulled via Permit2, so
  // approve in TWO steps: ERC20.approve(PERMIT2, +Σ) then Permit2.approve(tokenIn, ROUTER, uint160(+Σ),
  // expiration) — the allowance the Router consumes. Then call Router.swapSingleTokenExactIn(pool, tokenIn,
  // tokenOut, +Σ, 0, deadline, false, "") — exactIn, so the Vault computes the out from the awarded input.
  // wethIsEth=false keeps it pure-ERC20. compute-then-pull already transferred `cum` (incl. each Balancer V3
  // share) into this contract above, so the Permit2 pull draws from this contract's balance and the out lands
  // here (to == msg.sender == self). The V3 reentrancy is fully contained inside Balancer's own Router + Vault
  // (Vault.unlock re-enters the ROUTER, never this cooking contract; input PULLED via Permit2.transferFrom,
  // output via Vault.sendTo), so it is callback-free — no engine change (unlike the V4 unlockCallback path the
  // engine must service).
  if (HAS_BALANCER_V3) {
  // Empty `bytes` for the swap userData arg (the ABI `bytes` tail is a length-0 dynamic blob). Same idiom the
  // V2/Kyber callback-free path uses for pool.swap's empty data.
  const b3Empty: bytes = abi.encode(tokenIn).slice(0, 0);
  for (let k = 0; k < MS_CAP; k = k + 1) {
    const b3amt: Uint256 = b3inp[k];
    if (b3amt > 0) {
      const b3pool: Address = b3ven[k];
      // NO on-chain re-quote — minAmountOut is HARDCODED 0 for the Balancer V3 leg. Balancer V3's
      // `querySwapSingleTokenExactIn` CANNOT be called on-chain inside a cook: it is `nonpayable` and routes
      // through the Vault's `quote()`, which DEMANDS a static-call context — so under a plain CALL it reverts
      // NotStaticCall() 0x67f84ab2 ("a state-changing transaction was initiated in a context that only allows
      // static calls"), yet it INTERNALLY unlock()s the Vault, a state write, so under a STATICCALL it reverts
      // the static-call state-change guard. Both fire — the query is an eth_call-only surface, unusable as an
      // on-chain minAmountOut source (unlike Fluid's estimateSwapIn, which self-reverts and so runs under a
      // plain CALL). The split is ALREADY priced off the sampled ladder at prepare, so we execute the awarded
      // `b3amt` as a straight exact-in swap with minAmountOut = 0 for THIS leg: exactIn means the Vault computes
      // the out from the awarded input. There is NO per-leg on-chain floor here, but the WHOLE-TRADE cfg[9]
      // amountOutMin floor below (main()'s terminal `if (minOut > 0) require(outBal >= minOut)`) now guards this
      // Balancer V3 leg too: a shortfall on the aggregate tokenOut reverts the whole cook atomically. So a
      // Balancer V3 leg relies on the off-chain snapshot split (priced off the same live query ladder the oracle
      // segments) plus the whole-trade floor plus whatever transaction-level slippage the integrator enforces
      // around cook(). The per-leg picture still differs from Fluid/Mento, which DO re-quote on-chain (self-
      // reverting views) and pass that as a per-leg minOut; Balancer V3's query is not callable, so no per-leg
      // minOut exists (only the whole-trade floor). Permit2 two-step: ERC20.approve(PERMIT2) then Permit2.approve(token, ROUTER, uint160 amt, uint48
      // exp). wethIsEth = 0 (false — pure ERC20). The compiler ABI-encodes the uint256 0 as the
      // `bool`/`uint160`/`uint48` args (BYTE_N truncation to width).
      token.approve(PERMIT2, b3amt);
      IPermit2.at(PERMIT2).approve(tokenIn, balancerV3Router, b3amt, B3_EXPIRATION);
      IBalancerV3Router.at(balancerV3Router).swapSingleTokenExactIn(b3pool, tokenIn, tokenOut, b3amt, 0, B3_DEADLINE, 0, b3Empty);
    }
  }
  }
  const leftover: Uint256 = token.balanceOf(address.self);
  if (leftover > 0) {
    token.transfer(caller, leftover);
  }
  const outToken = IERC20.at(tokenOut);
  const outBal: Uint256 = outToken.balanceOf(address.self);
  // Internal whole-trade amountOutMin FLOOR (defense-in-depth). minOut == 0 (the default / a quote /
  // a short hand-built cfg) SKIPS this branch entirely, so the priced path is byte-identical to the
  // pre-floor solver. When set, revert the whole cook if the realized tokenOut is below the floor —
  // BEFORE transferring to the caller, so a shortfall unwinds atomically. Same conditional-revert
  // idiom the recipes use (a guarded `throw`, which compiles to a REVERT on v1 and v12).
  if (minOut > 0) {
    if (outBal < minOut) {
      throw "ecoswap: amountOut below minOut";
    }
  }
  outToken.transfer(caller, outBal);
  return outBal;
}
