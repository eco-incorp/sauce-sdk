import { ISauceRouter } from "./artifacts/ISauceRouter.json";
import { IERC20 } from "./artifacts/IERC20.json";
import { IUniswapV3PoolFull } from "./IUniswapV3PoolFull.json";
import { IAlgebraPool } from "./IAlgebraPool.json";
import { IStateViewFull } from "./IStateViewFull.json";
import { IUniswapV2Pair } from "./IUniswapV2Pair.json";
import { IKyberPool } from "./IKyberPool.json";
import { IDODOPool } from "./IDODOPool.json";
import { ISolidlyStablePool } from "./ISolidlyStablePool.json";
import { IWombatPool } from "./IWombatPool.json";
import { IEulerSwapPool } from "./IEulerSwapPool.json";
import { IMaverickV2Pool } from "./IMaverickV2Pool.json";
import { ICryptoSwapPool } from "./ICryptoSwapPool.json";
import { ICryptoSwapPoolQL } from "./ICryptoSwapPoolQL.json";
import { ICurveStableSwap } from "./ICurveStableSwap.json";
import { IWooFiPool } from "./IWooFiPool.json";
import { ILBPair } from "./ILBPair.json";
import { IFermiPool } from "./IFermiPool.json";
import { IFluidDexPool } from "./IFluidDexPool.json";
import { IFluidDexResolver } from "./IFluidDexResolver.json";
import { ITesseraSwap } from "./ITesseraSwap.json";
import { IElfomoFi } from "./IElfomoFi.json";
import { IMetricRouter } from "./IMetricRouter.json";
import { ILiquidCorePool } from "./ILiquidCorePool.json";
import { ISizeRelayer } from "./ISizeRelayer.json";
import { IMetricPool } from "./IMetricPool.json";
import { IMetricPriceProvider } from "./IMetricPriceProvider.json";
import { IMentoBroker } from "./IMentoBroker.json";
import { IBalancerV3Router } from "./IBalancerV3Router.json";
import { IBalancerV3Vault } from "./IBalancerV3Vault.json";
import { IBalancerV2Vault } from "./IBalancerV2Vault.json";
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
//   rinp[] tokenIn->X then read the REALIZED intermediate balance and split it across the leg's
//   members (pools inp[] + leg-QL venues qinp[], proportional) X->tokenOut. One guarded terminal
//   refund returns the only possible tokenIn leftover (the limit-price edge); a per-route
//   intermediate sweep returns any venue-0-quote-stranded intermediate dust (normally 0).
//
// Inputs (precomputed off-chain in prepare.ts; layout built by index.ts buildUniverseRoutingAndQlv):
//   cfg         = [tokenIn, tokenOut, amountIn, caller, priceLimit, directCount, fluidResolver?,
//                 mentoBroker?, balancerV3Router?, minOut?, balancerV3Vault?, balancerV2Vault?,
//                 directQlvCount?] — ONE scalar tuple (the lens trick: keeps main() at 6 params so
//                 the v12 arg-prologue SDUP window stays small).
//                 directCount = number of leading universe entries that are DIRECT venues (==
//                 prepared.pools.length); entries [directCount, …) are leg-only. cfg[6..12] are
//                 OPTIONAL trailing scalars (guarded by cfg.length): the chain-wide Fluid resolver,
//                 Mento broker, Balancer-V3 router, cfg[9] = the internal whole-trade amountOutMin
//                 FLOOR (0 ⇒ no floor ⇒ byte-identical to the pre-floor solver), the Balancer-V3
//                 Vault, the Balancer-V2 Vault, and cfg[12] = directQlvCount — the number of leading
//                 qlv rows that are DIRECT venues (absent ⇒ qlv.length, i.e. all rows direct — every
//                 hand-built venue-test cfg stays valid); rows [directQlvCount, …) are ROUTE-LEG
//                 venue rows (see qlv below).
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
//   routing[r]  = [legCount, {poolBase, poolCount, qlvBase, qlvCount, inter} × legCount] — one flat
//                 SCALAR tuple per route, uniform 5-field stride per leg: leg L at rt[1+5L] poolBase,
//                 rt[2+5L] poolCount, rt[3+5L] qlvBase, rt[4+5L] qlvCount, rt[5+5L] interL. Leg L
//                 pools = universe indices [poolBase, poolBase+poolCount) (poolCount MAY be 0 for an
//                 all-QL leg); leg L QL venues = GLOBAL qlv row indices [qlvBase,
//                 qlvBase+qlvCount) (0/0 for a pool-only leg). SETUP reads them for the leg-row
//                 ladder build + its sizing fold; the MERGE elects them as leg members (1b/Phase
//                 A–D); the EXEC dispatches them inline in the unified per-leg loop (venue shares
//                 ride qinp[]). interL = intermediate token AFTER leg L (final leg
//                 → 0); derived reads keep the old symmetry: legIn(L>0) = rt[5L], legOut(L<legCount−1)
//                 = rt[5+5L]. The merge head fold, the route event, and the chain-order execution
//                 all loop over legCount, so N-hop needs no shape change.
//   qlv[v]      = [poolAddr, i, j, feePpm, segKind, refIdx, c6, c7, c8, c9, routeIdx, legIdx] — the
//                 QUOTE-LADDER (QL) venue DESCRIPTORS, uniform 12-column width (Curve StableSwap segKind 1,
//                 Trader Joe LB segKind 2, DODO V2 segKind 3, Solidly STABLE segKind 4, Wombat segKind 5,
//                 Curve CryptoSwap segKind 9, WOOFi segKind 10, Fermi segKind 11, Fluid DEX segKind 12,
//                 Mento V2 segKind 13, Balancer V3 segKind 14, Tessera V segKind 15, ElfomoFi segKind
//                 16, METRIC segKind 17, LIQUIDCORE segKind 18, INTEGRAL SIZE segKind 19). Rows
//                 [0, directQlvCount) are DIRECT venues (today's family-
//                 concatenation order; qd[10]=qd[11]=0, never read); rows [directQlvCount, …) are
//                 ROUTE-LEG venues — qd[0..9] the SAME family row built for the leg's EDGE pair
//                 (legIn, legOut), qd[5] refIdx = the row's GLOBAL qlv index (informational), qd[10]/
//                 qd[11] = the routeIdx/legIdx backrefs — grouped contiguously per (route, leg),
//                 (routeIdx asc, legIdx asc), so routing's qlvBase/qlvCount point at them. index.ts
//                 ASSERTS this ordering (the msSorted machinery AND the leg-row sizing fold silently
//                 depend on it). The flat qlv pass ladders EVERY row: direct rows into the SORTED
//                 merged stream as before; leg rows (gated HAS_LEG_QLV) into per-venue regions PAST
//                 msSorted — quoted on the leg's EDGE pair (qTokIn/qTokOut from routing) and sized
//                 by the chain-order fold of amountIn through the upstream legs' LIVE setup heads;
//                 the merge consumes them via route events (1b/Phase A–D slice branches) and the
//                 unified per-leg exec loop dispatches their qinp[] shares inline. Columns c6..c9 are used ONLY by
//                 Balancer V3 (segKind 14) and are 0 for every other venue: BalV3's querySwap is eth_call-ONLY,
//                 so instead of quoting a live view it REPLAYS the amplified StableSwap invariant on-chain from
//                 the LIVE Vault state — getCurrentLiveBalances(pool)[i]/[j] (inline-indexed), amp +
//                 getStaticSwapFeePercentage(pool) (read live, no descriptor slot), and each token's
//                 rateProvider.getRate() (rpIn=qd[6]/rpOut=qd[7], scalars) — then upscales the input by
//                 decScaleIn·rateIn (qd[8]) and downscales the out by decScaleOut·computeRateRoundUp(rateOut)
//                 (qd[9]); qi/qj are the Vault token indices. The Vault is chain-wide (cfg[10]). DODO is
//                 DIRECTIONAL — qd[1] is isSellBase (tokenIn ==
//                 pool._BASE_TOKEN_()): the ladder quotes querySellBase(caller,xNext) or querySellQuote(
//                 caller,xNext) accordingly. NO sampled values:
//                 prepare ships only the descriptor (prepare-optional), and the solver BUILDS each venue's
//                 price ladder ON-CHAIN in setup from LIVE cook-time state. For k in 0..QL_S-1 it takes a
//                 geometric cumulative input xNext = cum*QL_RN/QL_RD + seed (seed = amountIn/QL_SEED_DIV,
//                 derived on-chain, clamped at amountIn), quotes q_k dispatched per-row on segKind (qd[4]):
//                 StableSwap get_dy(int128,int128,uint256) for kind 1, CryptoSwap get_dy(uint256,uint256,
//                 uint256) for kind 9 (a DIFFERENT selector + uint256 coin indices), Solidly getAmountOut(
//                 xIn,tokenIn) for kind 4, WOOFi tryQuery(tokenIn,tokenOut,xIn) for kind 10, Fluid
//                 resolver.estimateSwapIn(dex=qd[0],flQz,xIn,0) for kind 12 (a plain CALL on the chain-wide
//                 cfg[6] resolver — NOT a staticcall, see the exec block; the direction bit flQz is derived
//                 ON-CHAIN per venue via getDexTokens vs the (edge) in-token), Mento
//                 broker.getAmountOut(provider=qd[0],exchangeId=qd[1],tokenIn,tokenOut,xIn) for kind 13, LB
//                 pair.getSwapOut(xIn,swapForY=qd[1])→(amountInLeft,amountOut) for kind 2. The revert-class
//                 views (get_dy families on bad state / Newton non-convergence; Solidly getAmountOut on
//                 _get_y non-convergence; Mento getAmountOut on a misconfigured exchange) use
//                 PROBE-THEN-DECODE (a `.catch` flags a revert ⇒ stop; the sentinel-catch cannot capture the
//                 return VALUE); WOOFi tryQuery + Fluid estimateSwapIn + LB getSwapOut NEVER revert (WOOFi/
//                 Fluid return 0 on a cap / feasibility failure ⇒ a PLAIN single-return call, 0 ⇒ stop —
//                 Fluid's graceful resolver catch decodes the pool's result-revert and returns 0 for any
//                 OTHER underlying revert, so the ladder self-truncates at the LIVE utilization/borrow cap,
//                 the EulerSwap-inLimit class; LB returns amountInLeft,
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
//   segs[g]     = [refIdx, capacity, sqrtAdjNear, sqrtAdjFar, segKind, venue, venueAux] — the VESTIGIAL
//                 static sampled-segment stream, ALWAYS [] in production (Fluid, the last static
//                 holdout, is a QL family now — every venue's ladder is built ON-CHAIN from live
//                 state, so prepare ships NO sampled segments; the param is kept so the 6-arg
//                 compile shape the hand-built test universes + gas suite pin stays stable, and a
//                 hand-supplied static row still merges verbatim). In setup the solver COPIES these rows
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

// Balancer V3 (segKind 14) 2-token amplified StableSwap out — the LIVE-state replay the QL ladder is built
// from. Runs in scaled-18 space: `bIn`/`bOut` are the LIVE getCurrentLiveBalances (rate+decimal-scaled) of the
// in/out token, `dxScaled` the UPSCALED input, `amp` = A·AMP_PRECISION (getAmplificationParameter()[0]),
// `feeWad` the static swap fee (1e18). The static fee is netted on the input (mulUp); the invariant D
// (ROUND_DOWN) and the out-balance y (V3 divUpRaw rounding) are each Newton-solved with a converged-flag guard
// (no break in SauceScript). bit-for-bit with balancer-v3-math.ts `balancerV3StableOut2` (oracle) — the
// bIn-then-bOut D_P product order is load-bearing for that solver==oracle parity. (Solidity computeInvariant
// iterates D_P in the pool's REGISTERED array order balances[0..n-1]; matching THAT order exactly for a
// registered-token1 tokenIn was tried but reordering the two integer divisions diverges on the v12 engine at
// prod scale — a few wei on the reordered Newton — so BOTH sides keep the bIn-then-bOut order, wei-exact vs
// the pool on the wired large-balance pool and identical on v1+v12. A thin/low-amp inIdx=1 pool can differ by
// ≤1-2 wei from the pool's own query; documented follow-up, no fund risk.) Pure arithmetic (no helper-to-helper
// call), so main()'s qlv loop can call it. Returns the scaled-18 out (main downscales it).
function stableOut(amp: Uint256, feeWad: Uint256, bIn: Uint256, bOut: Uint256, dxScaled: Uint256): Uint256 {
  const WAD: Uint256 = 1000000000000000000;
  const AMP: Uint256 = 1000; // AMP_PRECISION
  // Top guard (mirrors the oracle balancerV3StableOut2): a zero live balance or a zero scaled input returns 0
  // rather than dividing by zero (D_P divides by bIn/bOut) or underflowing the mulUp (prod-1 on a Uint256).
  // Not reachable in practice — discovery drops a pool with no positive quote — but keeps the solver
  // bit-identical to the oracle's guard.
  if (bIn === 0 || bOut === 0 || dxScaled === 0) { return 0; }
  let fee: Uint256 = 0;
  if (feeWad > 0) { const prod: Uint256 = dxScaled * feeWad; fee = (prod - 1) / WAD + 1; } // mulUp
  const inUp: Uint256 = dxScaled - fee;

  const att: Uint256 = amp * 2; // ampTimesTotal = amp * n
  const sumB: Uint256 = bIn + bOut;

  // Newton for the invariant D (computeInvariant, ROUND_DOWN).
  let D: Uint256 = sumB;
  let doneD: Uint256 = 0;
  for (let i = 0; i < 64; i = i + 1) {
    if (doneD === 0) {
      let DP: Uint256 = D;
      DP = DP * D / (bIn * 2);
      DP = DP * D / (bOut * 2);
      const prevD: Uint256 = D;
      const numD: Uint256 = (att * sumB / AMP + DP * 2) * D;
      const denD: Uint256 = (att - AMP) * D / AMP + 3 * DP;
      D = numD / denD;
      if (D > prevD) { if (D - prevD <= 1) { doneD = 1; } }
      else { if (prevD - D <= 1) { doneD = 1; } }
    }
  }

  // Newton for the out-token balance y (computeBalance, V3 divUpRaw rounding).
  const w0: Uint256 = bIn + inUp; // in balance after adding net amountIn
  const w1: Uint256 = bOut;       // out balance
  let PD: Uint256 = 2 * w0;
  PD = PD * w1 * 2 / D;
  const inv2: Uint256 = D * D;
  const c: Uint256 = (1 + (inv2 * AMP - 1) / (att * PD)) * w1; // divUpRaw(inv2*AMP, att*PD) * bOut
  const bb: Uint256 = w0 + (D * AMP) / att;                    // sum + (D*AMP)/att
  let y: Uint256 = 1 + (inv2 + c - 1) / (D + bb);              // divUpRaw(inv2 + c, D + bb)
  let doneY: Uint256 = 0;
  for (let j = 0; j < 64; j = j + 1) {
    if (doneY === 0) {
      const prevY: Uint256 = y;
      const numY: Uint256 = y * y + c;
      const denY: Uint256 = 2 * y + bb - D;
      y = 1 + (numY - 1) / denY; // divUpRaw(numY, denY)
      if (y > prevY) { if (y - prevY <= 1) { doneY = 1; } }
      else { if (prevY - y <= 1) { doneY = 1; } }
    }
  }

  if (bOut <= y + 1) { return 0; }
  return bOut - y - 1;
}

// Balancer V2 ComposableStable (segKind 6) n-token amplified StableSwap out — the LIVE-state replay the QL
// ladder is built from. Runs in scaled-18 space over the NON-BPT balances (the BPT is excluded off-chain;
// `u0`/`u1`/`u2` are the UPSCALED non-BPT balances in the pool's REGISTERED non-BPT order, u2==0 ⇒ n=2 else
// n=3), `inUp` the UPSCALED net input (fee already netted on the RAW input + upscaled in main), `ij` packs the
// non-BPT in/out indices (i = ij&255, j = (ij/256)&255), `amp` = A·AMP_PRECISION. The invariant D iterates D_P
// in registered non-BPT order (calculateInvariant, divDown); the out-balance y uses the V2 divUpInt rounding
// (getTokenBalanceGivenInvariant). This is the V2 form — DISTINCT from the V3 `stableOut` above: V2 rounds the
// c term divUpInt(inv2, att·PD)·AMP·bOut (NOT the V3 divUpRaw(inv2·AMP, att·PD)·bOut) and the bb term
// divDown(D,att)·AMP (NOT V3's (D·AMP)/att). Bit-for-bit with balancer-stable-math.ts (the oracle) — same
// registered-order D_P product (load-bearing for solver==oracle parity AND for matching the real Vault's own
// onSwap on both engines, spike-verified wei-exact vs Vault.queryBatchSwap for n=3). Each Newton is
// converged-flag-guarded (no break in SauceScript); 64 iterations is well past StableSwap convergence, so the
// result is bit-identical to the oracle's 255-iter getDy. Pure arithmetic (no helper-to-helper call), so
// main()'s qlv loop can call it. Returns the scaled-18 out (main downscales it by the out token's scale).
function stableOutV2(amp: Uint256, u0: Uint256, u1: Uint256, u2: Uint256, ij: Uint256, inUp: Uint256): Uint256 {
  const AMP: Uint256 = 1000; // AMP_PRECISION
  // Guard (mirrors the oracle): a zero balance or zero scaled input returns 0 rather than dividing by zero.
  if (u0 === 0 || u1 === 0 || inUp === 0) { return 0; }
  const iIdx: Uint256 = ij & 255;
  const jIdx: Uint256 = (ij / 256) & 255;
  let n: Uint256 = 2;
  if (u2 > 0) { n = 3; }
  const att: Uint256 = amp * n; // ampTimesTotal = amp * numTokens
  const sum0: Uint256 = u0 + u1 + u2; // u2==0 for n=2

  // Newton for the invariant D (calculateInvariant, divDown). D_P over the ORIGINAL balances, registered order.
  let D: Uint256 = sum0;
  let doneD: Uint256 = 0;
  for (let it = 0; it < 64; it = it + 1) {
    if (doneD === 0) {
      let DP: Uint256 = D;
      DP = DP * D / (u0 * n);
      DP = DP * D / (u1 * n);
      if (n === 3) { DP = DP * D / (u2 * n); }
      const prevD: Uint256 = D;
      const numD: Uint256 = (att * sum0 / AMP + DP * n) * D;
      const denD: Uint256 = (att - AMP) * D / AMP + (n + 1) * DP;
      D = numD / denD;
      if (D > prevD) { if (D - prevD <= 1) { doneD = 1; } }
      else { if (prevD - D <= 1) { doneD = 1; } }
    }
  }

  // work balances = original + inUp added to slot i (j != i, so w[j] == u[j] == the out balance).
  let w0: Uint256 = u0; let w1: Uint256 = u1; let w2: Uint256 = u2;
  if (iIdx === 0) { w0 = w0 + inUp; }
  if (iIdx === 1) { w1 = w1 + inUp; }
  if (iIdx === 2) { w2 = w2 + inUp; }
  let bOut: Uint256 = w0;
  if (jIdx === 1) { bOut = w1; }
  if (jIdx === 2) { bOut = w2; }

  // Newton for the out-token balance y (getTokenBalanceGivenInvariant, V2 divUpInt rounding). P_D over WORK,
  // registered order; sum excludes the out index j.
  let PD: Uint256 = n * w0;
  PD = PD * w1 * n / D;
  if (n === 3) { PD = PD * w2 * n / D; }
  const s: Uint256 = w0 + w1 + w2 - bOut;
  const inv2: Uint256 = D * D;
  const c: Uint256 = (1 + (inv2 - 1) / (att * PD)) * AMP * bOut; // divUpInt(inv2, att*PD) * AMP * bOut
  const bb: Uint256 = s + (D / att) * AMP;                       // s + divDown(D, att) * AMP
  let y: Uint256 = 1 + (inv2 + c - 1) / (D + bb);                // divUpInt(inv2 + c, D + bb)
  let doneY: Uint256 = 0;
  for (let jt = 0; jt < 64; jt = jt + 1) {
    if (doneY === 0) {
      const prevY: Uint256 = y;
      y = 1 + (y * y + c - 1) / (2 * y + bb - D); // divUpInt(y^2 + c, 2y + bb - D)
      if (y > prevY) { if (y - prevY <= 1) { doneY = 1; } }
      else { if (prevY - y <= 1) { doneY = 1; } }
    }
  }

  if (bOut <= y + 1) { return 0; }
  return bOut - y - 1;
}

// ── Maverick V2 (segKind 8) LIVE bin-WALK leaf helpers — mirror shared/maverick-math.ts BIT-FOR-BIT ──
// The segKind-8 QL branch walks the pool's bin book from its LIVE active tick/price emitting one ladder
// slice per crossed tick (== buildMaverickWalkLadder ⇒ solver == oracle by construction). These are the
// per-tick arithmetic primitives; they use ONLY Math.* intrinsics inline (no helper-to-helper call, which
// the compiler forbids). All are treeshake-dropped unless HAS_MAVERICK lights the qKind===8 branch.
// Proven wei-exact vs the real MaverickV2Quoter on v1+v12 (test/harness/maverick-onchain-walk.reference).

// two's-complement int32 getTick(tick) ARG from a shifted tick (shiftTick = realTick + MAV_OFFSET). For a
// NEGATIVE real tick Math.neg yields the FULL 256-bit sign extension (all high bytes 0xff) placed VERBATIM
// as the 32-byte ABI word — a clean int32 a Solidity 0.7/0.8 callee decodes to the negative tick (the same
// full-sign-extension the V3 int24 tickArg builds via `| HIGH`). Validated across the sign boundary by the
// negative/cross-0 fixture cells in ecoswap.maverick.evm.test.ts.
function mavTickArg(shiftTick: Uint256, OFF: Uint256): Uint256 {
  if (shiftTick >= OFF) { return shiftTick - OFF; }
  return Math.neg(OFF - shiftTick);
}

// |realTick| in tick units from a shifted tick.
function mavAbs(shiftTick: Uint256, OFF: Uint256): Uint256 {
  if (shiftTick >= OFF) { return shiftTick - OFF; }
  return OFF - shiftTick;
}

// 1 when realTick > 0 (the sqrt-price ladder inverts for a positive tick).
function mavInv(shiftTick: Uint256, OFF: Uint256): Uint256 {
  if (shiftTick > OFF) { return 1; }
  return 0;
}

// tickSqrtPrice(tickSpacing, tick) — the 1.0001^(tick·tickSpacing) sqrt-price ladder (1e18). absBins =
// |tick|; invert = (tick > 0). Mirrors TickMath.tickSqrtPrice (the Uniswap 128.128 pow shifted to 1e18).
function mavTickSqrt(absBins: Uint256, tickSpacing: Uint256, invert: Uint256): Uint256 {
  const MAV_ONE: Uint256 = 1000000000000000000;
  const Q128: Uint256 = 2 ** 128;
  const MAXU: Uint256 = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
  const absTick: Uint256 = absBins * tickSpacing;
  let ratio: Uint256 = Q128;
  if ((absTick & 0x1) > 0) { ratio = 0xfffcb933bd6fad9d3af5f0b9f25db4d6; }
  if ((absTick & 0x2) > 0) { ratio = (ratio * 0xfff97272373d41fd789c8cb37ffcaa1c) >> 128; }
  if ((absTick & 0x4) > 0) { ratio = (ratio * 0xfff2e50f5f656ac9229c67059486f389) >> 128; }
  if ((absTick & 0x8) > 0) { ratio = (ratio * 0xffe5caca7e10e81259b3cddc7a064941) >> 128; }
  if ((absTick & 0x10) > 0) { ratio = (ratio * 0xffcb9843d60f67b19e8887e0bd251eb7) >> 128; }
  if ((absTick & 0x20) > 0) { ratio = (ratio * 0xff973b41fa98cd2e57b660be99eb2c4a) >> 128; }
  if ((absTick & 0x40) > 0) { ratio = (ratio * 0xff2ea16466c9838804e327cb417cafcb) >> 128; }
  if ((absTick & 0x80) > 0) { ratio = (ratio * 0xfe5dee046a99d51e2cc356c2f617dbe0) >> 128; }
  if ((absTick & 0x100) > 0) { ratio = (ratio * 0xfcbe86c7900aecf64236ab31f1f9dcb5) >> 128; }
  if ((absTick & 0x200) > 0) { ratio = (ratio * 0xf987a7253ac4d9194200696907cf2e37) >> 128; }
  if ((absTick & 0x400) > 0) { ratio = (ratio * 0xf3392b0822b88206f8abe8a3b44dd9be) >> 128; }
  if ((absTick & 0x800) > 0) { ratio = (ratio * 0xe7159475a2c578ef4f1d17b2b235d480) >> 128; }
  if ((absTick & 0x1000) > 0) { ratio = (ratio * 0xd097f3bdfd254ee83bdd3f248e7e785e) >> 128; }
  if ((absTick & 0x2000) > 0) { ratio = (ratio * 0xa9f746462d8f7dd10e744d913d033333) >> 128; }
  if ((absTick & 0x4000) > 0) { ratio = (ratio * 0x70d869a156ddd32a39e257bc3f50aa9b) >> 128; }
  if ((absTick & 0x8000) > 0) { ratio = (ratio * 0x31be135f97da6e09a19dc367e3b6da40) >> 128; }
  if ((absTick & 0x10000) > 0) { ratio = (ratio * 0x9aa508b5b7e5a9780b0cc4e25d61a56) >> 128; }
  if ((absTick & 0x20000) > 0) { ratio = (ratio * 0x5d6af8dedbcb3a6ccb7ce618d14225) >> 128; }
  if ((absTick & 0x40000) > 0) { ratio = (ratio * 0x2216e584f630389b2052b8db590e) >> 128; }
  if (invert === 1) { ratio = MAXU / ratio; }
  return (ratio * MAV_ONE) >> 128;
}

// getTickL — the tick's concentrated-liquidity L from (reserveA,reserveB) + its sqrt bounds (the precision
// bump + quadratic root). Mirrors TickMath.getTickL.
function mavGetTickL(rA0: Uint256, rB0: Uint256, lo: Uint256, hi: Uint256): Uint256 {
  const MAV_ONE: Uint256 = 1000000000000000000;
  const T78: Uint256 = 2 ** 78;
  const diff: Uint256 = hi - lo;
  if (diff === 0) { return 0; }
  let rA: Uint256 = rA0;
  let rB: Uint256 = rB0;
  let pbump: Uint256 = 0;
  if (rA < T78) { if (rB < T78) { rA = rA << 57; rB = rB << 57; pbump = 57; } }
  if (rB === 0) { return Math.mulDiv(rA, MAV_ONE, diff) >> pbump; }
  if (rA === 0) { return Math.mulDiv(Math.mulDiv(rB, lo, MAV_ONE), hi, diff) >> pbump; }
  const b: Uint256 = (Math.mulDiv(rA, MAV_ONE, hi) + Math.mulDiv(rB, lo, MAV_ONE)) >> 1;
  const bSq: Uint256 = Math.mulDiv(b, b, MAV_ONE);
  const aB: Uint256 = Math.mulDiv(rB, rA, MAV_ONE);
  const inner: Uint256 = bSq + Math.mulDiv(aB, diff, hi);
  const sqrtInner: Uint256 = Math.sqrt(inner) * 1000000000;
  return Math.mulDiv(b + sqrtInner, hi, diff) >> pbump;
}

// getSqrtPrice — seed the walk's starting price from the active tick's reserves (clamped to [lo, hi]).
function mavSeedSqrt(rA: Uint256, rB: Uint256, lo: Uint256, hi: Uint256, L: Uint256): Uint256 {
  const MAV_ONE: Uint256 = 1000000000000000000;
  if (rA === 0) { return lo; }
  if (rB === 0) { return hi; }
  const num: Uint256 = rA + Math.mulDiv(L, lo, MAV_ONE);
  const den: Uint256 = rB + Math.mulDiv(L, MAV_ONE, hi);
  if (den === 0) { return lo; }
  const inner: Uint256 = Math.mulDiv(num, MAV_ONE, den);
  let sp: Uint256 = Math.sqrt(inner * MAV_ONE);
  if (sp < lo) { sp = lo; }
  if (sp > hi) { sp = hi; }
  return sp;
}

// UNDERFLOW GUARD — 1 iff the tick's FULL output reserve can be drained (the on-chain
// _remainingBinInputSpaceGivenOutput denominator is positive). getTickL is a documented LOWER bound, so a
// degenerate tick can drive that denominator non-positive (outOverL >= invFloor(sqrtP) for tokenA-in;
// sqrtP or mulDown(sqrtP,·)==0 for tokenB-in), which the on-chain drain would REVERT on. Return 0 there so
// the walk forces the PARTIAL (non-draining) fill instead of dividing by / subtracting into a non-positive
// denominator. Mirrors computeSwapExactIn's `drainable` gate bit-for-bit (Δ=0 on every validated tick,
// where the denominator reduces to the strictly-positive tick width).
function mavDrainable(availOut: Uint256, sqrtP: Uint256, L: Uint256, tokenAIn: Uint256): Uint256 {
  const MAV_ONE: Uint256 = 1000000000000000000;
  const ONE_SQ: Uint256 = 1000000000000000000000000000000000000;
  const outOverL: Uint256 = (availOut * MAV_ONE + L - 1) / L; // divUp(availOut, L)
  if (tokenAIn === 1) {
    const invSp: Uint256 = ONE_SQ / sqrtP; // invFloor(sqrtP)
    if (invSp > outOverL) { return 1; }
    return 0;
  }
  if (sqrtP > outOverL) {
    const inner: Uint256 = sqrtP - outOverL;
    if (Math.mulDiv(sqrtP, inner, MAV_ONE) > 0) { return 1; } // mulDown(sqrtP, sqrtP-outOverL) > 0
  }
  return 0;
}

// _remainingBinInputSpaceGivenOutput — the net (pre-fee) input to extract the tick's FULL output reserve.
// ONLY call when mavDrainable===1 (else the denominator underflows / divides by zero — the guard forces the
// partial fill).
function mavDrainIn(availOut: Uint256, sqrtP: Uint256, L: Uint256, tokenAIn: Uint256): Uint256 {
  const MAV_ONE: Uint256 = 1000000000000000000;
  const ONE_SQ: Uint256 = 1000000000000000000000000000000000000;
  const outOverL: Uint256 = (availOut * MAV_ONE + L - 1) / L; // divUp(availOut, L)
  if (tokenAIn === 1) {
    const invSp: Uint256 = ONE_SQ / sqrtP; // invFloor(sqrtP)
    const denom: Uint256 = invSp - outOverL;
    const p: Uint256 = availOut * sqrtP;
    let r: Uint256 = p / denom;
    if (r * denom < p) { r = r + 1; } // mulDivCeil
    return r;
  }
  const den: Uint256 = Math.mulDiv(sqrtP, sqrtP - outOverL, MAV_ONE); // mulDown(sqrtP, sqrtP-outOverL)
  return (availOut * MAV_ONE + den - 1) / den; // divUp(availOut, den)
}

// within-tick output for a NON-draining input binAmt (deltaOutErc), min-clamped to availOut.
function mavOut(binAmt: Uint256, sqrtP: Uint256, L: Uint256, tokenAIn: Uint256, availOut: Uint256): Uint256 {
  const MAV_ONE: Uint256 = 1000000000000000000;
  const ONE_SQ: Uint256 = 1000000000000000000000000000000000000;
  const inOverL: Uint256 = (binAmt * MAV_ONE + L) / (L + 1); // divUp(binAmt, L+1)
  let out: Uint256 = 0;
  if (tokenAIn === 1) {
    const invSp: Uint256 = ONE_SQ / sqrtP; // invFloor
    out = Math.mulDiv(binAmt, invSp, inOverL + sqrtP);
  } else {
    const invCeilSp: Uint256 = (ONE_SQ - 1) / sqrtP + 1; // invCeil
    out = Math.mulDiv(binAmt, sqrtP, inOverL + invCeilSp);
  }
  if (out > availOut) { out = availOut; }
  return out;
}

// within-tick end sqrt price for a NON-draining input binAmt (clamped to the tick bounds).
function mavEndSqrt(binAmt: Uint256, sqrtP: Uint256, L: Uint256, tokenAIn: Uint256, lo: Uint256, hi: Uint256): Uint256 {
  const MAV_ONE: Uint256 = 1000000000000000000;
  const ONE_SQ: Uint256 = 1000000000000000000000000000000000000;
  if (tokenAIn === 1) {
    let end: Uint256 = sqrtP + Math.mulDiv(binAmt, MAV_ONE, L);
    if (end > hi) { end = hi; }
    return end;
  }
  const inv: Uint256 = Math.mulDiv(binAmt, MAV_ONE, L) + ONE_SQ / sqrtP;
  let end: Uint256 = lo;
  if (inv > 0) { end = ONE_SQ / inv; }
  if (end < lo) { end = lo; }
  return end;
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
// Algebra dynamic-fee CL (Camelot/QuickSwap V3, Ramses V2, THENA Fusion, SwapX): V3-shaped in
// every respect the solver touches EXCEPT the SETUP spot read — a real Algebra pool has NO slot0()
// (it exposes globalState()), so slot0() would revert the whole cook. HAS_ALGEBRA gates ONLY the
// globalState() spot-read branch; the tick walk (ticks()[1]) + swapV3 exec are shared with V3.
const HAS_ALGEBRA: boolean = true;
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
const HAS_TESSERA: boolean = true;
const HAS_ELFOMO: boolean = true;
const HAS_METRIC: boolean = true;
const HAS_LIQUIDCORE: boolean = true;
const HAS_SIZE: boolean = true;
// ROUTE-LEG QL venues (true ⇔ any route leg carries qlVenues). Gates ALL leg-QL solver branches
// — the cfg[12] directQlvCount override read, the leg-row LADDER build (the per-row edge-token/
// sizing-fold prelude, the ladderCap==0 dead-leg guards, the per-venue cursor postlude), the
// merge's leg-venue election + slice event branches (1b/Phase A–D), and the exec's venue
// dispatch + per-route intermediate sweep — so a pool-only-routes universe ships zero leg-QL
// bytecode.
const HAS_LEG_QLV: boolean = true;

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
  // QL LADDER quote, the per-venue direction read (getDexTokens) and the exec quote all go through this
  // resolver (the pool's own estimate is a revert SauceScript can't try/catch; estimateSwapIn is a plain
  // CALL — see the exec block); one resolver serves every Fluid pool on the chain. OPTIONAL 7th cfg
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
  // cfg[10] = the chain-wide Balancer V3 Vault (CREATE2 singleton, SAME on all chains; 0 when no Balancer V3
  // venue). The BalancerV3 QL branch reads its LIVE state per slice — getCurrentLiveBalances(pool) (inline-
  // indexed) + getStaticSwapFeePercentage(pool) — to replay the amplified StableSwap invariant on-chain. One
  // Vault serves every V3 pool on a chain. OPTIONAL 11th cfg field — guarded by cfg.length so the many venue
  // EVM tests that hand-build a shorter cfg (no Balancer V3) stay valid; production always emits it (index.ts).
  let balancerV3Vault: Address = 0;
  if (cfg.length > 10) { balancerV3Vault = cfg[10]; }
  // cfg[11] = the chain-wide Balancer V2 Vault (the canonical singleton 0xBA12…, SAME on every EVM chain; 0
  // when no Balancer V2 venue). The BalancerV2 QL branch (segKind 6) reads its LIVE per-token balances via
  // getPoolTokenInfo(poolId, token) SCALARS (cash+managed — the v12-safe read, unlike getPoolTokens which
  // nests a dyn array in a tuple). One Vault serves every V2 ComposableStable on a chain. OPTIONAL 12th cfg
  // field — guarded by cfg.length so venue EVM tests that hand-build a shorter cfg (no Balancer V2) stay
  // valid; production always emits it (index.ts). (Distinct from cfg[10], the Balancer V3 Vault — a universe
  // can hold BOTH.)
  let balancerV2Vault: Address = 0;
  if (cfg.length > 11) { balancerV2Vault = cfg[11]; }
  // cfg[12] = directQlvCount — the number of LEADING qlv rows that are DIRECT venues; rows
  // [directQlvCount, qlv.length) are ROUTE-LEG venue rows — laddered by the flat qlv pass below
  // into per-venue regions PAST the sorted merged stream, consumed by the merge's route events
  // and executed by the unified per-leg exec loop. OPTIONAL 13th cfg field — guarded
  // by cfg.length so the many venue EVM tests that hand-build a shorter cfg stay valid (absent ⇒
  // qlv.length: ALL rows direct, the pre-leg behavior); production always emits it (index.ts).
  // The override read is gated HAS_LEG_QLV (false ⇒ no leg rows exist ⇒ directQlvCount ==
  // qlv.length by construction, so treeshake drops the read with zero behavior change).
  let directQlvCount: Uint256 = qlv.length;
  if (HAS_LEG_QLV) {
    if (cfg.length > 12) { directQlvCount = cfg[12]; }
  }

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
  // METRIC constants: the int128 encode clamp for quoteSwap/swapExactInput amounts (the compiler
  // truncates a uint256 into a narrower ABI slot, so an unclamped >= 2^127 value would flip the
  // int128 sign), the yToX unbounded DIRECTIONAL price limit (uint128.max — the price RISES for
  // yToX so the limit must sit above; xToY uses 0), the negative-word threshold for the signed
  // out-delta decode, and the far-future swapExactInput deadline (a unix-timestamp bound).
  const MC_I128MAX: Uint256 = 2 ** 127 - 1;
  const MC_U128MAX: Uint256 = 2 ** 128 - 1;
  const MC_HALF: Uint256 = 2 ** 255;
  const MC_DEADLINE: Uint256 = 2 ** 64;
  // INTEGRAL SIZE constant: the sell() submitDeadline — uint32 max (fork-proven accepted, so the
  // exec needs no block.timestamp read; the deadline slot is uint32, so 2^32−1 is the far bound).
  const SZ_DEADLINE: Uint256 = 2 ** 32 - 1;
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
  // (each row is consumed in exactly one step — via the direct bestKind===1 cursor OR a route
  // slice-cross event — so + MS_CAP covers both consumption paths, leg rows included).
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
  let teinp: Tuple = new Array(MS_CAP); // Tessera V per-venue Σ input
  let teven: Tuple = new Array(MS_CAP); // Tessera V venue (wrapper) address
  let elinp: Tuple = new Array(MS_CAP); // ElfomoFi per-venue Σ input
  let elven: Tuple = new Array(MS_CAP); // ElfomoFi venue (wrapper) address
  let mcinp: Tuple = new Array(MS_CAP); // METRIC per-venue Σ input
  let mcven: Tuple = new Array(MS_CAP); // METRIC venue (per-pair pool) address
  let mcrtr: Tuple = new Array(MS_CAP); // METRIC venue Router address (rides msAux, like Mento's exchangeId)
  let lcinp: Tuple = new Array(MS_CAP); // LIQUIDCORE per-venue Σ input
  let lcven: Tuple = new Array(MS_CAP); // LIQUIDCORE venue (per-pair pool) address
  let szinp: Tuple = new Array(MS_CAP); // INTEGRAL SIZE per-venue Σ input
  let szven: Tuple = new Array(MS_CAP); // INTEGRAL SIZE venue (TwapRelayer) address

  // ── MERGED SAMPLED-SEGMENT STREAM (parallel scalar arrays) ──
  // The bestKind===1 cursor consumes ONE globally-DESC-sorted segment stream. It is built ON-CHAIN
  // in setup from BOTH the static `segs` rows (copied) AND the qlv QUOTE-LADDERS (built live), then
  // bounded-insertion-sorted. Stored as PARALLEL SCALAR arrays (one column per array) because a
  // NEW_ARRAY of TUPLE rows reverts SET_INDEX on v1 (an array-of-tuples is v12-only). msN = the
  // actual filled row count (≤ MS_CAP). Columns mirror the old row shape (plus the new msOut):
  //   msRef=refIdx, msCap=capacity, msNear=sqrtAdjNear, msFar=sqrtAdjFar, msKind=segKind,
  //   msVen=venue, msAux=venueAux, msOut=sliceOut.
  let msRef: Tuple = new Array(MS_CAP);
  let msCap: Tuple = new Array(MS_CAP);
  let msNear: Tuple = new Array(MS_CAP);
  let msFar: Tuple = new Array(MS_CAP);
  let msKind: Tuple = new Array(MS_CAP);
  let msVen: Tuple = new Array(MS_CAP);
  let msAux: Tuple = new Array(MS_CAP);
  // The slice's modeled OUT amount — the 8th parallel column: the static-seg copy writes 0; the
  // QL emit writes the differenced sliceOut (geometric ladder) / mOutT (Maverick walk). Carried so
  // a LEG slice's linear consumption differences its out EXACTLY (reconstructing it from head²
  // would double-round through the floor(sqrt) head); direct rows write it too (unused — harmless).
  let msOut: Tuple = new Array(MS_CAP);
  let msN: Uint256 = 0;
  // End of the globally-SORTED region [0, msSorted) of the ms arrays (the static segs + the DIRECT
  // QL ladders — the stream the bestKind===1 cursor consumes). ROUTE-LEG venue regions live PAST
  // it at [msSorted, msN) (per-venue contiguous, internally descending via the non-descending-head
  // guard), consumed ONLY via route events — the insertion sort + the cursor never touch them.
  let msSorted: Uint256 = 0;
  // Merged-stream cursor: msNear/msFar are pre-sorted DESC (then refIdx ASC), so the cursor only ever
  // advances; a segment is consumed once. The head candidate is always the [segCur] slice (next-best).
  let segCur: Uint256 = 0;

  // ── Per-LEG-VENUE scratch (one slot per GLOBAL qlv row index; direct rows' slots stay 0 forever
  // — the wasted-slot cost buys uniform global indexing). qlStart/qlCount = the venue's contiguous
  // ms-row region; qlCur = its slice cursor (a row index into the ms arrays; qlCur == qlStart +
  // qlCount ⇔ exhausted); qlRemCap/qlRemOut = the CURRENT slice's remaining input capacity /
  // remaining modeled out (seeded from the first row at build time, depleted by the route-event
  // awards, re-seeded on cursor advance); qinp = the venue's Σ awarded input in ITS LEG-INPUT
  // token — the unified per-leg exec loop's venue weight (leg venues never touch the per-family
  // direct accumulators above). All gated HAS_LEG_QLV.
  let qlStart: Tuple = new Array(qlv.length);
  let qlCount: Tuple = new Array(qlv.length);
  let qlCur: Tuple = new Array(qlv.length);
  let qlRemCap: Tuple = new Array(qlv.length);
  let qlRemOut: Tuple = new Array(qlv.length);
  let qinp: Tuple = new Array(qlv.length);

  // Per-leg scratch for the N-leg route event, sized LEG_SCRATCH = pools.length + qlv.length (a
  // leg may hold ZERO pools — QL venues only — so legCount <= pools.length no longer bounds it; a
  // nonempty leg has >= 1 pool or >= 1 venue ⇒ legCount <= LEG_SCRATCH always). Reused across
  // every route + step (allocated ONCE here, never inside the hot loop). lgP = leg binding pool
  // index; lgN/lgF = the leg's current bracket near/far OI; lgL/lgFee = its L/fee; lgNF = the
  // event's new far OI per leg; lgFR = the leg pool's bracket far REAL sqrt (re-anchor source for
  // a full cross / brFar latch). lgIsQ/lgQv (leg-QL): 1 ⇔ the leg's elected member is a QL slice
  // cursor + that member's GLOBAL qlv index — written by the Phase A election; for a QL member
  // lgN==lgF==head (flat slice), lgL=0, lgFee=0 (heads are post-fee), lgFR=0, and lgNF is REUSED
  // to carry the member's awarded INPUT.
  const LEG_SCRATCH: Uint256 = pools.length + qlv.length;
  let lgP: Tuple = new Array(LEG_SCRATCH);
  let lgN: Tuple = new Array(LEG_SCRATCH);
  let lgF: Tuple = new Array(LEG_SCRATCH);
  let lgL: Tuple = new Array(LEG_SCRATCH);
  let lgFee: Tuple = new Array(LEG_SCRATCH);
  let lgNF: Tuple = new Array(LEG_SCRATCH);
  let lgFR: Tuple = new Array(LEG_SCRATCH);
  let lgIsQ: Tuple = new Array(LEG_SCRATCH);
  let lgQv: Tuple = new Array(LEG_SCRATCH);

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
      // Algebra flag (pd[17]) — read once, LENGTH-guarded so the many venue EVM tests that
      // hand-build a 17-field pool tuple (no isAlgebra column) stay valid; production always
      // emits it (index.ts buildPoolTuple). Mirrors the cfg.length optional-scalar guards.
      let isAlg: Uint256 = 0;
      if (HAS_ALGEBRA) { if (pd.length > 17) { isAlg = pd[17]; } }
      if (HAS_V4 && pType === 2) {
        srReal = IStateViewFull.at(pd[8]).getSlot0(pd[9])[0];
        liveTick = IStateViewFull.at(pd[8]).getSlot0(pd[9])[1];
        liveL = IStateViewFull.at(pd[8]).getLiquidity(pd[9]);
      } else if (HAS_ALGEBRA && isAlg === 1) {
        // Algebra dynamic-fee CL: read the LIVE spot from globalState() ([0]=price==sqrtPriceX96,
        // [1]=int24 tick) in place of slot0() — a real Algebra pool has NO slot0() (calling it would
        // revert the cook). liquidity() shares the V3 selector, and the rest of the frontier walk
        // (ticks()[1] = liquidityDelta, same int128 layout) is byte-identical to V3. Index
        // globalState() DIRECTLY per read (NOT via a stored var): the v1 engine loses the
        // contract-return tuple descriptor on a variable round-trip (mirrors the lens's inline reads).
        srReal = IAlgebraPool.at(pd[1]).globalState()[0];
        liveTick = IAlgebraPool.at(pd[1]).globalState()[1];
        liveL = IAlgebraPool.at(pd[1]).liquidity();
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
  if ((HAS_CURVE || HAS_LB || HAS_DODO || HAS_SOLIDLY_STABLE || HAS_WOMBAT || HAS_BALANCER || HAS_EULER || HAS_MAVERICK || HAS_CRYPTO || HAS_WOOFI || HAS_FERMI || HAS_FLUID || HAS_MENTO || HAS_BALANCER_V3 || HAS_TESSERA || HAS_ELFOMO || HAS_METRIC || HAS_LIQUIDCORE || HAS_SIZE) &&true) {
    // 1. Copy any static segments VERBATIM into the parallel-array stream. VESTIGIAL: production
    // always ships segs == [] (every family is QL — the ladders below feed the whole stream); a
    // hand-built test universe may still supply static rows and they merge unchanged.
    for (let k = 0; k < segs.length; k = k + 1) {
      const sr: Tuple = segs[k];
      msRef[msN] = sr[0];
      msCap[msN] = sr[1];
      msNear[msN] = sr[2];
      msFar[msN] = sr[3];
      msKind[msN] = sr[4];
      msVen[msN] = sr[5];
      msAux[msN] = sr[6];
      msOut[msN] = 0; // static rows carry no modeled out (never a leg slice)
      msN = msN + 1;
    }
    // The static rows are ALL sorted-region rows; each DIRECT qlv row extends msSorted as it is
    // laddered below (leg rows do not), so a directQlvCount==0 universe sorts nothing extra.
    msSorted = msN;
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
    if (HAS_CURVE || HAS_CRYPTO || HAS_SOLIDLY_STABLE || HAS_WOOFI || HAS_MENTO || HAS_LB || HAS_WOMBAT || HAS_FERMI || HAS_DODO || HAS_EULER || HAS_BALANCER_V3 || HAS_BALANCER || HAS_MAVERICK || HAS_FLUID || HAS_TESSERA || HAS_ELFOMO || HAS_METRIC || HAS_LIQUIDCORE || HAS_SIZE) {
      // ONE flat pass over ALL qlv rows: DIRECT rows ([0, directQlvCount)) ladder into the SORTED
      // merged stream (the bestKind===1 cursor's feed) exactly as before; ROUTE-LEG rows
      // ([directQlvCount, qlv.length), gated HAS_LEG_QLV) ladder into per-venue regions PAST
      // msSorted — quoted on the leg's EDGE pair (qTokIn/qTokOut) and sized by the chain-order
      // fold (ladderCap) — consumed ONLY via route events (1b/Phase A–D) and executed inline in
      // the unified per-leg exec loop. index.ts orders leg
      // rows (routeIdx asc, legIdx asc), so a row's upstream-leg ladders are always already built
      // when its fold reads their first-slice heads.
      for (let v = 0; v < qlv.length; v = v + 1) {
        const qd: Tuple = qlv[v];
        const qPool: Address = qd[0];
        const qi: Uint256 = qd[1];
        const qj: Uint256 = qd[2];
        const qKind: Uint256 = qd[4];
        const qRef: Uint256 = qd[5];
        // ── ROUTE-LEG row prelude (v >= directQlvCount): the leg's EDGE tokens + the chain-order
        // sizing fold. ladderCap = amountIn folded through legs 0..legIdx-1's LIVE setup heads:
        // per upstream leg the max over (a) each leg pool's fee-adjusted out/in spot head (the
        // frontier seeded above — dnOn/dnNear; a V2 pool with a zeroed out-reserve seeds dnNear 0
        // ⇒ head 0, the oracle's V2-iff-L>0 gate) and (b) each ALREADY-BUILT upstream venue's
        // first-slice head (post-fee). Per upstream leg the fold is out ≈ in·hF²/2^192 — TWO-step
        // floor mulDiv (hF² overflows 256 bits at real scales); hF==0 (a dead upstream leg) folds
        // the cap to 0 ⇒ the walk/k-loop below builds NOTHING (a zero-row ladder — the venue is
        // born exhausted). The fold is an UPPER bound on the leg's inflow (heads are the best
        // price any member trades at), so an under-shoot only exhausts the ladder a few wei early
        // — a split-QUALITY tail effect, never a parity break: the oracle/reference compute the
        // IDENTICAL fold with identical rounding (buildLegQlVenueLadder / kwayReference setup).
        // DIRECT rows keep ladderCap == amountIn + the cfg tokens — the build body below is
        // arithmetic-identical for them.
        let ladderCap: Uint256 = amountIn;
        let qTokIn: Address = tokenIn;
        let qTokOut: Address = tokenOut;
        let isLegV: Uint256 = 0;
        if (HAS_LEG_QLV) {
          if (v >= directQlvCount) {
            isLegV = 1;
            const rIdx: Uint256 = qd[10];
            const lIdx: Uint256 = qd[11];
            const rtv: Tuple = routing[rIdx];
            // EDGE tokens from routing: legIn(L>0) = rtv[5L]; legOut(L<legCount−1) = rtv[5+5L]
            // (first leg keeps tokenIn; final leg keeps tokenOut) — the exec's derivation.
            if (lIdx > 0) { qTokIn = rtv[5 * lIdx]; }
            if (lIdx + 1 < rtv[0]) { qTokOut = rtv[5 + 5 * lIdx]; }
            for (let f = 0; f < lIdx; f = f + 1) {
              let hF: Uint256 = 0;
              const pB: Uint256 = rtv[1 + 5 * f];
              const pE: Uint256 = pB + rtv[2 + 5 * f];
              for (let a = pB; a < pE; a = a + 1) {
                if (dnOn[a] === 1) {
                  let aoi: Uint256 = 0;
                  if (pools[a][6] === 1) { aoi = dnNear[a]; }
                  else { aoi = toOutIn(dnNear[a], zArr[a]); }
                  const hc: Uint256 = Math.mulDiv(aoi, sfArr[a], FEE_DENOM);
                  if (hc > hF) { hF = hc; }
                }
              }
              const qB: Uint256 = rtv[3 + 5 * f];
              const qE: Uint256 = qB + rtv[4 + 5 * f];
              for (let u = qB; u < qE; u = u + 1) {
                if (qlCount[u] > 0) {
                  const hq: Uint256 = msNear[qlStart[u]]; // first-slice head, post-fee
                  if (hq > hF) { hF = hq; }
                }
              }
              ladderCap = Math.mulDiv(Math.mulDiv(ladderCap, hF, Q96), hF, Q96);
            }
            qlStart[v] = msN;
          }
        }
        let seed: Uint256 = ladderCap / QL_SEED_DIV;
        if (seed === 0) { seed = 1; }
        let cumL: Uint256 = 0;
        let prevOut: Uint256 = 0;
        let prevHead: Uint256 = 0;
        let nv: Uint256 = 0;
        let stop: Uint256 = 0;
        // Dead upstream leg (ladderCap==0) ⇒ build NOTHING (a zero-row ladder; mirrors the
        // oracle's buildLegQlVenueLadder cap<=0 ⇒ []). Direct rows carry ladderCap == amountIn.
        if (HAS_LEG_QLV) { if (ladderCap === 0) { stop = 1; } }
        // Balancer V3 (segKind 14): read the LIVE Vault StableMath state ONCE per venue (the querySwap view is
        // eth_call-only, so we replay the amplified StableSwap invariant on-chain instead of quoting a live view).
        // getCurrentLiveBalances is a BARE dyn array → INLINE-INDEXED [qi]/[qj], NEVER stored (v1 reverts on a
        // stored dyn array). amp + static fee are read live (no descriptor slot). rateIn/rateOut are SCALARS via
        // each token's rate provider (qd[6]/qd[7]) — the v12-safe read. decScaleIn/decScaleOut are the const
        // descriptor factors (qd[8]/qd[9]). All per-slice q are then a PURE stableOut compute + rate scaling, so
        // BalancerV3 costs ~6 staticcalls per venue TOTAL (0 per slice), cheaper than a per-slice-quote venue.
        let b3bIn: Uint256 = 0;
        let b3bOut: Uint256 = 0;
        let b3amp: Uint256 = 0;
        let b3fee: Uint256 = 0;
        let b3rateIn: Uint256 = 0;
        let b3rateOut: Uint256 = 0;
        let b3decIn: Uint256 = 0;
        let b3decOut: Uint256 = 0;
        if (HAS_BALANCER_V3 && qKind === 14) {
          // A V3 pool has exactly 2 swappable tokens. Inline-index the bare getCurrentLiveBalances array by
          // LITERAL 0/1 (a variable index on an inline array return is not exercised; literals are the proven
          // path) then select in/out by qi (inIdx). Storing the array in a var reverts on v1, so each element
          // is a separate inline-indexed staticcall.
          const b3bal0: Uint256 = IBalancerV3Vault.at(balancerV3Vault).getCurrentLiveBalances(qPool)[0];
          const b3bal1: Uint256 = IBalancerV3Vault.at(balancerV3Vault).getCurrentLiveBalances(qPool)[1];
          if (qi === 0) { b3bIn = b3bal0; b3bOut = b3bal1; }
          else { b3bIn = b3bal1; b3bOut = b3bal0; }
          b3amp = IBalancerV3Vault.at(qPool).getAmplificationParameter()[0];
          b3fee = IBalancerV3Vault.at(balancerV3Vault).getStaticSwapFeePercentage(qPool);
          b3rateIn = IBalancerV3Vault.at(qd[6]).getRate();
          b3rateOut = IBalancerV3Vault.at(qd[7]).getRate();
          b3decIn = qd[8];
          b3decOut = qd[9];
        }
        // Balancer V2 ComposableStable (segKind 6): read the LIVE Vault StableMath state ONCE per venue (the
        // pool's own quote — Vault.queryBatchSwap — is eth_call-only, so we replay the amplified StableSwap
        // invariant on-chain, V2 rounding). Balances are SCALARS via getPoolTokenInfo(poolId, token) (cash [0] +
        // managed [1]) on the Vault (cfg[11]) — the v12-safe read (getPoolTokens nests the balances dyn array in
        // a tuple ⇒ garbage on v12). The BPT is excluded off-chain: the descriptor ships poolId (qd[6]), the
        // THIRD non-BPT token address (qd[7]; 0 for a 2-token pool), the packed registered scaling positions
        // (qd[8] = regPos0 | regPos1<<8 | regPos2<<16) and the non-BPT token count (qd[9] = 2 or 3). The scaling
        // factors are a BARE array (getScalingFactors on the pool) INLINE-INDEXED by the registered position
        // (variable index, proven on both engines) — LIVE, so a rate-scaled pool re-anchors. The upscaled non-BPT
        // balances u0/u1/u2 (registered order) + the in/out scaling + amp + fee are hoisted here; each per-slice q
        // is then a PURE stableOutV2 compute + up/downscale (0 staticcalls per slice).
        let b2u0: Uint256 = 0;
        let b2u1: Uint256 = 0;
        let b2u2: Uint256 = 0;
        let b2sfIn: Uint256 = 0;
        let b2sfOut: Uint256 = 0;
        let b2amp: Uint256 = 0;
        let b2fee: Uint256 = 0;
        let b2ij: Uint256 = 0;
        if (HAS_BALANCER && qKind === 6) {
          const B2_WAD: Uint256 = 1000000000000000000;
          const b2pid: Uint256 = qd[6];
          const b2third: Address = qd[7];
          const b2packed: Uint256 = qd[8];
          const b2n: Uint256 = qd[9];
          b2amp = IBalancerV2Vault.at(qPool).getAmplificationParameter()[0];
          b2fee = IBalancerV2Vault.at(qPool).getSwapFeePercentage();
          b2ij = qi + qj * 256;
          // Non-BPT index 0: its token address (qi ⇒ qTokIn, qj ⇒ qTokOut, else the third), balance (scalar
          // cash+managed) and scaling (getScalingFactors()[regPos]). regPos travels packed in qd[8].
          let a0: Address = b2third;
          if (qi === 0) { a0 = qTokIn; }
          if (qj === 0) { a0 = qTokOut; }
          const r0p: Uint256 = b2packed & 255;
          const raw0: Uint256 =
            IBalancerV2Vault.at(balancerV2Vault).getPoolTokenInfo(b2pid, a0)[0] +
            IBalancerV2Vault.at(balancerV2Vault).getPoolTokenInfo(b2pid, a0)[1];
          const sf0: Uint256 = IBalancerV2Vault.at(qPool).getScalingFactors()[r0p];
          b2u0 = raw0 * sf0 / B2_WAD;
          // Non-BPT index 1.
          let a1: Address = b2third;
          if (qi === 1) { a1 = qTokIn; }
          if (qj === 1) { a1 = qTokOut; }
          const r1p: Uint256 = (b2packed / 256) & 255;
          const raw1: Uint256 =
            IBalancerV2Vault.at(balancerV2Vault).getPoolTokenInfo(b2pid, a1)[0] +
            IBalancerV2Vault.at(balancerV2Vault).getPoolTokenInfo(b2pid, a1)[1];
          const sf1: Uint256 = IBalancerV2Vault.at(qPool).getScalingFactors()[r1p];
          b2u1 = raw1 * sf1 / B2_WAD;
          // Non-BPT index 2 — only for a 3-token pool (n==3); a 2-token pool leaves u2/sf2 at 0.
          let sf2: Uint256 = 0;
          if (b2n === 3) {
            let a2: Address = b2third;
            if (qi === 2) { a2 = qTokIn; }
            if (qj === 2) { a2 = qTokOut; }
            const r2p: Uint256 = (b2packed / 65536) & 255;
            const raw2: Uint256 =
              IBalancerV2Vault.at(balancerV2Vault).getPoolTokenInfo(b2pid, a2)[0] +
              IBalancerV2Vault.at(balancerV2Vault).getPoolTokenInfo(b2pid, a2)[1];
            sf2 = IBalancerV2Vault.at(qPool).getScalingFactors()[r2p];
            b2u2 = raw2 * sf2 / B2_WAD;
          }
          // The in/out token scaling (for the input upscale + output downscale below), by non-BPT index.
          if (qi === 0) { b2sfIn = sf0; }
          if (qi === 1) { b2sfIn = sf1; }
          if (qi === 2) { b2sfIn = sf2; }
          if (qj === 0) { b2sfOut = sf0; }
          if (qj === 1) { b2sfOut = sf1; }
          if (qj === 2) { b2sfOut = sf2; }
        }
        // Fluid DEX (segKind 12): derive the direction bit ONCE per venue, ON-CHAIN — swap0to1 ⇔ the
        // pool's token0 == the (edge) in-token, read via the chain-wide resolver's getDexTokens (the
        // DexT1 pool has NO token0()/token1() getters; the descriptor's qd[1] swap0to1 stamp is
        // informational only, so a ROUTE-LEG venue's direction is edge-correct with zero extra leg
        // stamping — the same derive-don't-trust rule the exec block applies). One view staticcall per
        // venue; the per-slice estimateSwapIn quote below is a plain CALL (see the exec block).
        let flQz: Uint256 = 0;
        if (HAS_FLUID && qKind === 12) {
          const flqT0: Address = IFluidDexResolver.at(fluidResolver).getDexTokens(qPool)[0];
          if (flqT0 === qTokIn) { flQz = 1; }
        }
        // METRIC (segKind 17): hoist the LIVE maker anchor ONCE per venue — getBidAndAskPrice() on the
        // venue's PriceProvider (qd[6]). PROBE-THEN-DECODE: the provider REVERTS (0x9a0423af) when the
        // maker's off-chain post is older than MAX_TIME_DELTA (~10 s) or under its Chainlink
        // deviation/sequencer guards — a stale/quiet maker leaves the anchor at 0 and the qKind-17
        // slice branch below builds a ZERO ladder (the venue self-drops; never a cook DoS). The frozen
        // (bid, ask) then feeds EVERY per-slice quoteSwap — the router's quote prices DIRECTLY off the
        // caller-supplied anchor (probed: doubling both doubles the out), and the SWAP path re-reads
        // the SAME provider in-tx, so the ladder, the exec quote and the realized fill share one
        // anchor by construction (the TWO-STEP quote — the BalV2 state-hoist shape).
        let mcBidV: Uint256 = 0;
        let mcAskV: Uint256 = 0;
        if (HAS_METRIC && qKind === 17) {
          let mcPok: Uint256 = 1;
          IMetricPriceProvider.at(qd[6]).getBidAndAskPrice().catch(() => { mcPok = 0; });
          if (mcPok === 1) {
            mcBidV = IMetricPriceProvider.at(qd[6]).getBidAndAskPrice()[0];
            mcAskV = IMetricPriceProvider.at(qd[6]).getBidAndAskPrice()[1];
          }
        }
        // INTEGRAL SIZE (segKind 19): hoist the LIVE OUT-WINDOW once per venue and RAISE THE LADDER
        // SEED to the lowest quotable input. The relayer's quote domain REVERTS on BOTH ends
        // (checkLimits(tokenOut, amountOut) in the VERIFIED source: TR03 below
        // getTokenLimitMin(tokenOut), TR3A above inventory × maxMultiplier), so an unfloored grid
        // whose first slice quotes below the out-min would ZERO the whole ladder even when the full
        // trade is quotable. The floor is minIn = quoteBuy(tokenIn, tokenOut,
        // getTokenLimitMin(tokenOut)) — quoteBuy CEIL-rounds the fee gross-up, so
        // quoteSell(minIn) >= minOut ALWAYS (fork-proven: quoteSell at minIn−1 reverts TR03, at
        // minIn returns just above the min). PROBE-THEN-DECODE both reads: a quoteBuy revert (TR3A
        // — even the min out exceeds the live inventory cap; TR5A/TR17 — no enabled pair) leaves
        // the floor at 0 and the first quoteSell probe then reverts ⇒ a ZERO ladder (the venue
        // self-drops, never a cook DoS). Mirrored bit-for-bit by buildSizeQLLadder's seedFloor
        // (size-math.ts) — one recurrence, one grid, one floor.
        if (HAS_SIZE && qKind === 19) {
          let szPok: Uint256 = 1;
          ISizeRelayer.at(qPool).getTokenLimitMin(qTokOut).catch(() => { szPok = 0; });
          if (szPok === 1) {
            const szMinOut: Uint256 = ISizeRelayer.at(qPool).getTokenLimitMin(qTokOut);
            if (szMinOut > 0) {
              ISizeRelayer.at(qPool).quoteBuy(qTokIn, qTokOut, szMinOut).catch(() => { szPok = 0; });
              if (szPok === 1) {
                const szMinInV: Uint256 = ISizeRelayer.at(qPool).quoteBuy(qTokIn, qTokOut, szMinOut);
                if (szMinInV > seed) { seed = szMinInV; }
              }
            }
          }
        }
        // Maverick V2 (segKind 8) — LIVE bin-WALK. UNLIKE the geometric quote-difference ladder below (which
        // no-ops for qKind 8: no branch matches ⇒ q stays 0 ⇒ stop), Maverick has no cumulative-out view, so
        // it WALKS the pool's bin book on-chain from the LIVE active tick/price, emitting one ladder slice per
        // crossed tick (capacity = deltaInErc, effOut = deltaOutErc, head = qlSliceHead) DIRECTLY into the
        // merged stream. Reads fee(tokenAIn) + getState()[5] (activeTick) + getTick(tick)[reserveA,reserveB]
        // LIVE; qd[1]=tokenAIn, qd[2]=tickSpacing. Replays computeSwapExactIn per tick BIT-FOR-BIT (incl. the
        // drainable UNDERFLOW guard), so this == buildMaverickWalkLadder ⇒ solver == oracle by construction
        // (proven wei-exact vs the real MaverickV2Quoter on v1+v12). Emit-capped at QL_S (the merged-stream
        // per-venue reservation — MUST equal maverick-math.ts MAVERICK_WALK_MAX_SEGMENTS so oracle == solver).
        if (HAS_MAVERICK && qKind === 8) {
          const mTokenAIn: Uint256 = qi;   // qd[1] — 1 iff tokenIn == pool tokenA (price rises through ticks)
          const mTs: Uint256 = qd[2];      // tickSpacing
          const MAV_ONE: Uint256 = 1000000000000000000;
          const MAV_OFFSET: Uint256 = 8388608; // 2^23 (> any |tick| within MAX_TICK for tickSpacing>=1)
          const MAV_HALF: Uint256 = 2 ** 255;
          const MAXTICK: Uint256 = 322378;
          const MAV_STEPS: Uint256 = 200;  // walk-iteration bound (== maverick-math TICK_SEARCH_LIMIT)
          const mFee: Uint256 = IMaverickV2Pool.at(qPool).fee(mTokenAIn === 1);
          // active tick — the ABI declares getState()[5] as uint256 so the int32 activeTick's SIGN-extended
          // word passes through verbatim (>= 2^255 ⇒ negative). Recover the OFFSET-shifted tick WITHOUT ever
          // computing MAV_OFFSET + mAtWord on a negative (mAtWord ~ 2^256 there ⇒ that add overflows and the
          // engine reverts on overflow) — take the negative branch FIRST: mShift = MAV_OFFSET - |realTick|.
          const mAtWord: Uint256 = IMaverickV2Pool.at(qPool).getState()[5];
          let mShift: Uint256 = 0;
          if (mAtWord >= MAV_HALF) { mShift = MAV_OFFSET - Math.neg(mAtWord); }
          else { mShift = MAV_OFFSET + mAtWord; }
          // seed the walk price from the active tick reserves (getSqrtPrice, clamped).
          const mSeedArg: Uint256 = mavTickArg(mShift, MAV_OFFSET);
          const mSA: Uint256 = IMaverickV2Pool.at(qPool).getTick(mSeedArg)[0];
          const mSB: Uint256 = IMaverickV2Pool.at(qPool).getTick(mSeedArg)[1];
          const mSLo: Uint256 = mavTickSqrt(mavAbs(mShift, MAV_OFFSET), mTs, mavInv(mShift, MAV_OFFSET));
          const mSHi: Uint256 = mavTickSqrt(mavAbs(mShift + 1, MAV_OFFSET), mTs, mavInv(mShift + 1, MAV_OFFSET));
          const mSL: Uint256 = mavGetTickL(mSA, mSB, mSLo, mSHi);
          let mCurSqrt: Uint256 = mavSeedSqrt(mSA, mSB, mSLo, mSHi, mSL);
          let mCurShift: Uint256 = mShift;
          let mRemain: Uint256 = ladderCap;
          let mNEmit: Uint256 = 0;
          let mPrevHead: Uint256 = 0;
          let mDone: Uint256 = 0;
          // Dead upstream leg (ladderCap==0) ⇒ walk NOTHING (buildMaverickWalkLadder's cap<=0 ⇒ []).
          if (HAS_LEG_QLV) { if (ladderCap === 0) { mDone = 1; } }
          for (let mi = 0; mi < MAV_STEPS; mi = mi + 1) {
            if (mDone === 0) {
              if (mNEmit >= QL_S) { mDone = 1; }
              else {
                const mAbsB: Uint256 = mavAbs(mCurShift, MAV_OFFSET);
                if (mAbsB * mTs > MAXTICK) {
                  mDone = 1;
                } else {
                  const mLo: Uint256 = mavTickSqrt(mAbsB, mTs, mavInv(mCurShift, MAV_OFFSET));
                  const mHi: Uint256 = mavTickSqrt(mavAbs(mCurShift + 1, MAV_OFFSET), mTs, mavInv(mCurShift + 1, MAV_OFFSET));
                  let mSkip: Uint256 = 0;
                  if (mCurSqrt < mLo) { mSkip = 1; }
                  if (mCurSqrt > mHi) { mSkip = 1; }
                  if (mSkip === 1) {
                    if (mTokenAIn === 1) { mCurShift = mCurShift + 1; } else { mCurShift = mCurShift - 1; }
                  } else {
                    const mArg: Uint256 = mavTickArg(mCurShift, MAV_OFFSET);
                    const mRA: Uint256 = IMaverickV2Pool.at(qPool).getTick(mArg)[0];
                    const mRB: Uint256 = IMaverickV2Pool.at(qPool).getTick(mArg)[1];
                    let mEmpty: Uint256 = 0;
                    if (mRA === 0) { if (mRB === 0) { mEmpty = 1; } }
                    if (mEmpty === 1) {
                      if (mTokenAIn === 1) { mCurShift = mCurShift + 1; } else { mCurShift = mCurShift - 1; }
                    } else {
                      const mL: Uint256 = mavGetTickL(mRA, mRB, mLo, mHi);
                      if (mL === 0) {
                        if (mTokenAIn === 1) { mCurShift = mCurShift + 1; } else { mCurShift = mCurShift - 1; }
                      } else {
                        const mAvailOut: Uint256 = mTokenAIn === 1 ? mRB : mRA;
                        const mDrainable: Uint256 = mavDrainable(mAvailOut, mCurSqrt, mL, mTokenAIn);
                        let mDrainIn: Uint256 = 0;
                        if (mDrainable === 1) {
                          const mBinIn: Uint256 = mavDrainIn(mAvailOut, mCurSqrt, mL, mTokenAIn);
                          const mFden: Uint256 = MAV_ONE - mFee;
                          const mFp: Uint256 = mBinIn * mFee;
                          let mFbd: Uint256 = mFp / mFden;
                          if (mFbd * mFden < mFp) { mFbd = mFbd + 1; } // mulDivCeil(binIn, fee, 1-fee)
                          mDrainIn = mBinIn + mFbd;
                        }
                        let mDoPartial: Uint256 = 0;
                        if (mDrainable === 0) { mDoPartial = 1; }
                        else { if (mRemain < mDrainIn) { mDoPartial = 1; } }
                        let mCapIn: Uint256 = 0;
                        let mOutT: Uint256 = 0;
                        let mEndS: Uint256 = 0;
                        if (mDoPartial === 1) {
                          const mBinFinal: Uint256 = Math.mulDiv(mRemain, MAV_ONE - mFee, MAV_ONE); // mulDown(remaining, 1-fee)
                          mOutT = mavOut(mBinFinal, mCurSqrt, mL, mTokenAIn, mAvailOut);
                          mEndS = mavEndSqrt(mBinFinal, mCurSqrt, mL, mTokenAIn, mLo, mHi);
                          mCapIn = mRemain; // deltaInErc for a partial fill == the whole remaining input
                        } else {
                          mOutT = mAvailOut;
                          mCapIn = mDrainIn;
                          if (mTokenAIn === 1) { mEndS = mHi; } else { mEndS = mLo; }
                        }
                        let mMaxed: Uint256 = 0;
                        if (mEndS === mHi) { mMaxed = 1; }
                        if (mEndS === mLo) { mMaxed = 1; }
                        // EMIT one slice (skipped only on a zero cap/out; the walk still advances).
                        if (mCapIn > 0) { if (mOutT > 0) {
                          const mHead: Uint256 = qlSliceHead(mOutT, mCapIn);
                          if (mHead === 0) { mDone = 1; }
                          else {
                            if (mNEmit > 0) { if (mHead >= mPrevHead) { mDone = 1; } } // non-descending guard
                            if (mDone === 0) {
                              msRef[msN] = qRef; msCap[msN] = mCapIn;
                              msNear[msN] = mHead; msFar[msN] = mHead;
                              msKind[msN] = qKind; msVen[msN] = qPool; msAux[msN] = 0;
                              msOut[msN] = mOutT; // slice OUT (leg-slice linear differencing)
                              msN = msN + 1; mNEmit = mNEmit + 1; mPrevHead = mHead;
                            }
                          }
                        } }
                        // ADVANCE — skipped when the emit-guard (head==0 / non-descending) stopped the walk.
                        if (mDone === 0) {
                          if (mDoPartial === 1) { mRemain = 0; } else { mRemain = mRemain - mDrainIn; }
                          mCurSqrt = mEndS;
                          if (mMaxed === 0) { mDone = 1; }
                          if (mRemain === 0) { mDone = 1; }
                          if (mDone === 0) {
                            if (mTokenAIn === 1) { mCurShift = mCurShift + 1; } else { mCurShift = mCurShift - 1; }
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
        for (let k = 0; k < QL_S; k = k + 1) {
          if (stop === 0) {
            let xNext: Uint256 = Math.mulDiv(cumL, QL_RN, QL_RD) + seed;
            if (xNext > ladderCap) { xNext = ladderCap; }
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
                    ISolidlyStablePool.at(qPool).getAmountOut(xNext, qTokIn).catch(() => { ok = 0; });
                    if (ok === 1) { q = ISolidlyStablePool.at(qPool).getAmountOut(xNext, qTokIn); }
                  } else {
                    if (HAS_MENTO && qKind === 13) {
                      // qPool = exchangeProvider (qd[0]); qi = bytes32 exchangeId (qd[1], intact — not
                      // truncated). PROBE-THEN-DECODE. The exchangeId travels in msAux so the accumulate/
                      // exec (segKind 13) keys the venue by (provider, exchangeId).
                      IMentoBroker.at(mentoBroker).getAmountOut(qPool, qi, qTokIn, qTokOut, xNext).catch(() => { ok = 0; });
                      if (ok === 1) { q = IMentoBroker.at(mentoBroker).getAmountOut(qPool, qi, qTokIn, qTokOut, xNext); }
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
                          q = IWooFiPool.at(qPool).tryQuery(qTokIn, qTokOut, xNext);
                        } else {
                        if (HAS_FLUID && qKind === 12) {
                          // Fluid DEX (FluidDexT1, callback-free): the ladder quote is the chain-wide
                          // resolver's estimateSwapIn(dex, swap0to1, xNext, 0) — GRACEFUL like WOOFi's
                          // tryQuery (the resolver's Solidity catch decodes the pool's FluidDexSwapResult
                          // revert and returns 0 for ANY other underlying revert — utilization/borrow cap,
                          // paused, invalid amounts), so it is a PLAIN single-return call, 0 ⇒ stop, and
                          // the ladder SELF-TRUNCATES at the LIVE cap (the EulerSwap-inLimit class, no
                          // separate cap read). NB a CALL, not a staticcall (the ABI marks it nonpayable):
                          // the real pool writes state on the ADDRESS_DEAD estimate path before its
                          // result-revert (which rolls the write back), so a STATICCALL would quote 0.
                          // Each quote sees the same frozen state ⇒ the differencing is exact. flQz is the
                          // per-venue on-chain-derived direction bit (the prelude above).
                          q = IFluidDexResolver.at(fluidResolver).estimateSwapIn(qPool, flQz, xNext, 0);
                        } else {
                          if (HAS_WOMBAT && qKind === 5) {
                            // Wombat (single-sided stableswap, callback-free): the ladder quote is
                            // quotePotentialSwap(fromToken, toToken, xNext)[0] — the post-haircut out. It is
                            // a REVERT-class view (CASH_NOT_ENOUGH / a paused asset), so PROBE-THEN-DECODE.
                            // xNext feeds the int256 fromAmount param (positive amounts < 2^255 encode as
                            // +int256). fromToken/toToken == the swap's own (edge) tokens.
                            IWombatPool.at(qPool).quotePotentialSwap(qTokIn, qTokOut, xNext).catch(() => { ok = 0; });
                            if (ok === 1) { q = IWombatPool.at(qPool).quotePotentialSwap(qTokIn, qTokOut, xNext)[0]; }
                          } else {
                            if (HAS_FERMI && qKind === 11) {
                              // Fermi / propAMM (Obric-style proactive AMM, callback-free): the ladder quote is
                              // quoteAmounts(tokenIn, tokenOut, +xNext)[1] — the SECOND return is the exact-in
                              // out (the exec uses [1] too). REVERT-class (maker pause / stale), so PROBE-THEN-
                              // DECODE. xNext feeds the int256 amountSpecified (positive ⇒ exact-in).
                              IFermiPool.at(qPool).quoteAmounts(qTokIn, qTokOut, xNext).catch(() => { ok = 0; });
                              if (ok === 1) { q = IFermiPool.at(qPool).quoteAmounts(qTokIn, qTokOut, xNext)[1]; }
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
                                  IEulerSwapPool.at(qPool).computeQuote(qTokIn, qTokOut, xNext, true).catch(() => { ok = 0; });
                                  if (ok === 1) { q = IEulerSwapPool.at(qPool).computeQuote(qTokIn, qTokOut, xNext, true); }
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
              // Balancer V3 (segKind 14) — COMPUTE, not quote (its query is eth_call-only). The cumulative out
              // for total input xNext is the FULLY RATE-SCALED StableMath: upscale the input (decimal + live
              // rate, mulDown), run stableOut (which nets the static fee + solves the invariant/out-balance),
              // then downscale the out (decimal + computeRateRoundUp(rateOut)). Every read was hoisted to ONE
              // per-venue block above, so this is pure arithmetic. Bit-for-bit with balancer-v3-math.ts
              // buildBalancerV3QLLadder ⇒ solver == oracle by construction (verified wei-exact vs the real
              // querySwapSingleTokenExactIn on v1+v12). The SHARED differencing/head/emit/sort below is unchanged.
              if (HAS_BALANCER_V3 && qKind === 14) {
                const B3_WAD: Uint256 = 1000000000000000000;
                const givenScaled: Uint256 = xNext * b3decIn * b3rateIn / B3_WAD;
                const outScaled: Uint256 = stableOut(b3amp, b3fee, b3bIn, b3bOut, givenScaled);
                if (outScaled === 0) {
                  q = 0;
                } else {
                  let rateUp: Uint256 = b3rateOut + 1;
                  if (b3rateOut / B3_WAD * B3_WAD === b3rateOut) { rateUp = b3rateOut; }
                  q = outScaled * B3_WAD / (b3decOut * rateUp);
                }
              }
              // Balancer V2 ComposableStable (segKind 6) — COMPUTE, not quote (Vault.queryBatchSwap is
              // eth_call-only). The cumulative out for total input xNext is getDy: net the swap fee on the RAW
              // input (mulUp), UPSCALE the net input by the in token's scaling (mulDown), run stableOutV2 (the V2
              // rounding — solves the invariant D + out-balance y over the NON-BPT upscaled balances), then
              // DOWNSCALE the scaled-18 out by the out token's scaling (divDown). All reads were hoisted per-venue
              // above, so this is pure arithmetic. Bit-for-bit with balancer-stable-math.ts getDy ⇒ solver ==
              // oracle by construction (spike-verified wei-exact vs Vault.queryBatchSwap on v1+v12). The SHARED
              // differencing/head/emit/sort below is unchanged.
              if (HAS_BALANCER && qKind === 6) {
                const B2W: Uint256 = 1000000000000000000;
                let b2f: Uint256 = 0;
                if (b2fee > 0) { const b2p: Uint256 = xNext * b2fee; b2f = (b2p - 1) / B2W + 1; } // mulUp on RAW
                // fee >= input ⇒ zero net (mirrors the oracle getDy amountIn<=0 → 0; guards the checked-SUB underflow).
                if (b2f >= xNext) { q = 0; }
                else {
                  const b2net: Uint256 = xNext - b2f;
                  const b2inUp: Uint256 = b2net * b2sfIn / B2W; // upscale net input (mulDown)
                  const b2out: Uint256 = stableOutV2(b2amp, b2u0, b2u1, b2u2, b2ij, b2inUp);
                  if (b2out === 0) { q = 0; }
                  else { q = b2out * B2W / b2sfOut; } // downscale to out-token native decimals (divDown)
                }
              }
              // Tessera V (segKind 15) — the wrapper's signed-amount view, PROBE-THEN-DECODE (the
              // Fermi class): tesseraSwapViewAmounts REVERTS on an unsupported/deactivated pair
              // ("T33") or an engine pause, while an OVERSIZED ask returns (in, 0) gracefully —
              // either way a failed probe / zero out stops the ladder (the venue self-drops; the
              // engine's ~18.5M gas-AVAILABILITY gate also lands here: a starved probe fails ⇒ a
              // zero ladder, never a cook DoS — though the failed probe burns its forwarded gas, so
              // cook Tessera universes with generous limits; see tessera-math.ts). [1] is the
              // exact-in out (positive amountSpecified = exact tokenIn); the quote is post-fee +
              // gas-price-coherent with the exec (both read the same tx.gasprice), so the head IS
              // the execution price.
              if (HAS_TESSERA && qKind === 15) {
                ITesseraSwap.at(qPool).tesseraSwapViewAmounts(qTokIn, qTokOut, xNext).catch(() => { ok = 0; });
                if (ok === 1) { q = ITesseraSwap.at(qPool).tesseraSwapViewAmounts(qTokIn, qTokOut, xNext)[1]; }
              }
              // ElfomoFi (segKind 16) — the wrapper's GRACEFUL exact-in view (the WOOFi-tryQuery /
              // Fluid-resolver class): getAmountOut returns 0 on an unsupported pair / zero amount /
              // STALE oracle feed (never reverts — probed live on the real Base wrapper), so it is a
              // PLAIN single-return staticcall, 0 ⇒ stop (a stale venue self-truncates, no
              // probe-then-decode `.catch` needed — one call per slice).
              if (HAS_ELFOMO && qKind === 16) {
                q = IElfomoFi.at(qPool).getAmountOut(qTokIn, qTokOut, xNext);
              }
              // METRIC (segKind 17) — the router's anchor-parameterized quote at the venue's FROZEN
              // hoisted (bid, ask) (mcBidV == 0 ⇒ stale maker ⇒ q stays 0 ⇒ zero ladder). NB a plain
              // CALL, not a staticcall (the recipe ABI marks quoteSwap nonpayable): the REAL pool's
              // quote fn WRITES then REVERTS with the result (the Quoter pattern; the router catches
              // + decodes), so a static context kills the write before the result-revert and the
              // probe fails — the Fluid estimateSwapIn class; the write rolls back with the pool's
              // own revert, so the CALL is state-neutral. qi (qd[1])
              // is the xToY direction bit; the price limit is DIRECTIONAL (0 for xToY — the price
              // falls; uint128.max for yToX — it rises; the wrong side quotes (0,0) gracefully — the
              // resolved reverse-direction convention). The amount is clamped at the int128 encode
              // bound. PROBE-THEN-DECODE (the router reverts a typed error on garbage anchors), then
              // decode the OUT-side delta — NEGATIVE two's complement, Math.neg for |out| (an
              // oversized xNext PARTIAL-FILLS: the quote flatlines at capacity, the differenced
              // slice-out hits 0 and the ladder stops — at most one final slice carries capacity the
              // pool cannot absorb; the exec's partial fill + terminal refund cover it, minOut-
              // guarded). auxV = the venue's ROUTER (qd[7]) — it rides msAux into the accumulate/exec
              // (the Mento-exchangeId mechanism), since the direct exec loop sees only the ms columns.
              if (HAS_METRIC && qKind === 17) {
                if (mcBidV > 0) {
                  let mcqLim: Uint256 = 0;
                  if (qi === 0) { mcqLim = MC_U128MAX; }
                  let mcqAmt: Uint256 = xNext;
                  if (mcqAmt > MC_I128MAX) { mcqAmt = MC_I128MAX; }
                  let mcqOk: Uint256 = 1;
                  IMetricRouter.at(qd[7]).quoteSwap(qPool, qi, mcqAmt, mcqLim, mcBidV, mcAskV).catch(() => { mcqOk = 0; });
                  if (mcqOk === 1) {
                    let mcqW: Uint256 = 0;
                    if (qi === 1) { mcqW = IMetricRouter.at(qd[7]).quoteSwap(qPool, qi, mcqAmt, mcqLim, mcBidV, mcAskV)[1]; }
                    else { mcqW = IMetricRouter.at(qd[7]).quoteSwap(qPool, qi, mcqAmt, mcqLim, mcBidV, mcAskV)[0]; }
                    if (mcqW >= MC_HALF) { q = Math.neg(mcqW); }
                  }
                  auxV = qd[7];
                }
              }
              // LIQUIDCORE (segKind 18) — the pool's own exact-in view (STATICCALL-safe — verified
              // via a raw-STATICCALL probe against the live pool), keyed on the edge tokens.
              // PROBE-THEN-DECODE (the Fermi class): a zero/unsupported input REVERTS (0x1f2a2005 /
              // 0xc1ab6dc1) and a DRAINED pool returns 0 gracefully — either way q = 0 ⇒ stop. An
              // OVERSIZED xNext returns a graceful CAPPED quote (the asymptotic imbalance-fee
              // curve), so the differenced slice-out collapses and the non-descending-head guard
              // truncates the ladder where the marginal dies.
              if (HAS_LIQUIDCORE && qKind === 18) {
                ILiquidCorePool.at(qPool).estimateSwap(qTokIn, qTokOut, xNext).catch(() => { ok = 0; });
                if (ok === 1) { q = ILiquidCorePool.at(qPool).estimateSwap(qTokIn, qTokOut, xNext); }
              }
              // INTEGRAL SIZE (segKind 19) — the relayer's TWAP-priced exact-in view at the
              // WINDOW-FLOORED grid (the venue prelude raised `seed` to the live minIn, so the
              // grid's low end never sits in the TR03-reverting region). PROBE-THEN-DECODE: a TR3A
              // revert past the live inventory cap truncates the ladder at the last in-window grid
              // point (the venue's fillable capacity); TR03/TR5A/TR24 ⇒ q = 0 ⇒ stop.
              if (HAS_SIZE && qKind === 19) {
                ISizeRelayer.at(qPool).quoteSell(qTokIn, qTokOut, xNext).catch(() => { ok = 0; });
                if (ok === 1) { q = ISizeRelayer.at(qPool).quoteSell(qTokIn, qTokOut, xNext); }
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
                    let head: Uint256 = qlSliceHead(sliceOut, sliceCapV);
                    // Non-convex guard: a non-descending head ends this venue's ladder here — EXCEPT
                    // for the FLAT-LADDER family (SIZE, segKind 19): its TWAP price is genuinely
                    // CONSTANT over amount, so consecutive slice heads are EQUAL up to ±1-wei
                    // integer rounding and the strict guard would truncate the ladder at slice 1,
                    // stranding real in-window capacity. For kind 19 the head is CLAMPED at
                    // prevHead instead (the merged stream stays non-increasing — the ordering
                    // invariant the sort/cursor need) and the walk continues; the ladder then stops
                    // on the cap clamp, a TR3A window revert, or a flatlined quote. Mirrored
                    // bit-for-bit by buildQLLadder's flatLadder mode (curve-math.ts), so the ≤1-wei
                    // clamp steers solver and oracle identically (the exec re-quotes the full award
                    // live, so the realized out is always the true quote).
                    if (nv > 0) {
                      if (head >= prevHead) {
                        if (HAS_SIZE && qKind === 19) {
                          if (head > prevHead) { head = prevHead; }
                        } else {
                          stop = 1;
                        }
                      }
                    }
                    if (stop === 0) {
                      msRef[msN] = qRef;
                      msCap[msN] = sliceCapV;
                      msNear[msN] = head;
                      msFar[msN] = head;
                      msKind[msN] = qKind;
                      msVen[msN] = qPool;
                      msAux[msN] = auxV;
                      msOut[msN] = sliceOut; // slice OUT (leg-slice linear differencing)
                      msN = msN + 1;
                      nv = nv + 1;
                      prevHead = head;
                      cumL = cumNextV;
                      prevOut = q;
                      if (cumNextV >= ladderCap) { stop = 1; }
                    }
                  }
                }
              }
            }
          }
        }
        // ── ROUTE-LEG row postlude: record the venue's contiguous ms-row region + seed its slice
        // cursor (qlCur at the first row; qlRemCap/qlRemOut from that row). qlCur == qlStart +
        // qlCount ⇔ exhausted, so a zero-row ladder (dead upstream leg / no valid quote) is born
        // exhausted. A DIRECT row instead extends the SORTED region (msSorted) the bestKind===1
        // cursor + insertion sort consume — leg regions stay PAST it, per-venue contiguous +
        // internally descending (the non-descending guard above), never sorted.
        if (HAS_LEG_QLV && isLegV === 1) {
          qlCount[v] = msN - qlStart[v];
          qlCur[v] = qlStart[v];
          if (qlCount[v] > 0) {
            qlRemCap[v] = msCap[qlStart[v]];
            qlRemOut[v] = msOut[qlStart[v]];
          }
        } else {
          msSorted = msN;
        }
      }
    }
    // 3. Bounded insertion sort over [0, msSorted) — the (vestigial) static segs + DIRECT QL ladders —
    // DESC by (msNear, then msFar, then msRef ASC) — the historical stable stream order, so the
    // cursor sees a global descending-price stream. All eight columns shift together (parallel
    // arrays). Route-leg regions at [msSorted, msN) are never touched. For a single monotone QL
    // ladder this is a near-no-op; the general sort interleaves multiple QL venues + any static
    // segments correctly.
    for (let a = 1; a < MS_CAP; a = a + 1) {
      if (a < msSorted) {
        const kRef: Uint256 = msRef[a];
        const kCap: Uint256 = msCap[a];
        const kNear: Uint256 = msNear[a];
        const kFar: Uint256 = msFar[a];
        const kKind: Uint256 = msKind[a];
        const kVen: Uint256 = msVen[a];
        const kAux: Uint256 = msAux[a];
        const kOut: Uint256 = msOut[a];
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
              msOut[b] = msOut[b - 1];
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
        msOut[b] = kOut;
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
      // fee-adjusted heads. For EACH leg L (pool slice [baseL, baseL+countL), fields at rt[1+5L],
      // rt[2+5L]) compute its internal best ACTIVE member near/far adj — pools first, then the
      // leg's QL VENUE cursors (HAS_LEG_QLV; a slice head is post-fee with far == near) — fold
      // near→routeNear and far→routeFar via composeStep. A route is dead only when a leg has NO
      // active member (pools AND venues all inactive/exhausted). N-leg loop over legCount (rt[0])
      // — 2-hop and 3-hop are the same code.
      if (HAS_ROUTES) {
      for (let r = 0; r < routing.length; r = r + 1) {
        const rt: Tuple = routing[r];
        const legCount: Uint256 = rt[0];
        let rNear: Uint256 = Q96; // fold accumulator seeded at 1.0 (Q96) ⇒ first composeStep == leg0
        let rFar: Uint256 = Q96;
        let rDead: Uint256 = 0;
        let firstLeg: Uint256 = 1;
        for (let L = 0; L < legCount; L = L + 1) {
          const baseL: Uint256 = rt[1 + 5 * L];
          const countL: Uint256 = rt[2 + 5 * L];
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
          // Leg QL VENUE heads ([qB, qE) GLOBAL qlv indices from the stride-5 routing row): the
          // cursor's CURRENT slice head msNear[qlCur] is ALREADY post-fee out/in (NO extra
          // fee-adjust) and a slice is FLAT — its far IS its near — so it enters the fold with
          // far == near (beating any near-tied bracket, whose far < near). Same legMemberWins ops
          // as the pool scan above (strict-near win; near-tie by strictly higher far; the
          // incumbent keeps exact ties; pools scanned BEFORE venues, both ascending). Activity is
          // the cursor test ALONE (the qlCursorActive mirror): active ⇒ remCap > 0 (rows are
          // emitted with capacity > 0 and Phase D advances the cursor exactly when remCap hits 0),
          // so an extra remCap gate would be a third-site election-op divergence, not a guard.
          if (HAS_LEG_QLV) {
            const qB: Uint256 = rt[3 + 5 * L];
            const qE: Uint256 = qB + rt[4 + 5 * L];
            for (let u = qB; u < qE; u = u + 1) {
              if (qlCur[u] < qlStart[u] + qlCount[u]) {
                const qh: Uint256 = msNear[qlCur[u]];
                if (qh >= lAdj) {
                  let wq: Uint256 = 0;
                  if (qh > lAdj) { wq = 1; }
                  if (qh === lAdj) { if (qh > lFarAdj) { wq = 1; } }
                  if (wq === 1) { lAdj = qh; lFarAdj = qh; lLive = 1; }
                }
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
      // segs + live DIRECT QL ladders; the sorted region is [0, msSorted) — leg-venue rows past it
      // are consumed only via route events, never this cursor). The head is the [segCur] slice
      // (next-best); its near/far are ALREADY post-fee out/in (adjNear==adjFar==the post-fee
      // marginal), so they compare directly. Same tie-break as the pools/routes (near DESC, then
      // far DESC).
      if ((HAS_CURVE || HAS_LB || HAS_DODO || HAS_SOLIDLY_STABLE || HAS_WOMBAT || HAS_BALANCER || HAS_EULER || HAS_MAVERICK || HAS_CRYPTO || HAS_WOOFI || HAS_FERMI || HAS_FLUID || HAS_MENTO || HAS_BALANCER_V3 || HAS_TESSERA || HAS_ELFOMO || HAS_METRIC || HAS_LIQUIDCORE || HAS_SIZE) &&segCur < msSorted) {
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

          // Phase A: per-leg binding MEMBER — pools scanned FIRST (ascending), then the leg's QL
          // VENUE cursors (ascending — GLOBAL qlv order), with the legMemberWins ops (the ops all
          // three mirror sites share: solver / oracle legBestMember / reference routeLegBest):
          // win on a strictly higher fee-adjusted near, or a near-TIE with a strictly higher
          // fee-adjusted far (a slice's far == its near, so a slice beats any near-tied bracket);
          // the incumbent keeps all other ties. Near-ties are STRUCTURAL for slices — the far
          // tie-break is load-bearing here, so the pool scan carries its bracket far too (lazily,
          // the 1b idiom: a strictly-lower near never wins — skip its far). The elected pool's
          // CURRENT bracket [near, far] OI sits on the fixed live grid; brFar (latched on a prior
          // partial) holds the bracket's fixed far, else one stepReal ahead.
          for (let L = 0; L < legCount; L = L + 1) {
            const baseL: Uint256 = rt[1 + 5 * L];
            const eL: Uint256 = baseL + rt[2 + 5 * L];
            let pBest: Uint256 = baseL;
            let pAdj: Uint256 = 0;
            let pFarAdj: Uint256 = 0;
            if (HAS_LEG_QLV) { lgIsQ[L] = 0; }
            for (let a = baseL; a < eL; a = a + 1) {
              if (dnOn[a] === 1) {
                let aoi: Uint256 = 0;
                if (pools[a][6] === 1) { aoi = dnNear[a]; }
                else { aoi = toOutIn(dnNear[a], zArr[a]); }
                const aadj: Uint256 = Math.mulDiv(aoi, sfArr[a], FEE_DENOM);
                if (aadj >= pAdj) {
                  // The candidate's CURRENT bracket far (V2: constant-L geometric from the current
                  // near; V3/V4: the brFar latch, else one stepReal ahead) — the reference's
                  // frontierFarOI, fee-adjusted for the near-tie break.
                  let afOI: Uint256 = 0;
                  if (pools[a][6] === 1) {
                    afOI = dnNear[a] - Math.mulDiv(dnNear[a], V2_STEP_BPS, V2_STEP_DEN);
                  } else {
                    let afReal: Uint256 = stepReal(dnNear[a], pools[a][10], zArr[a]);
                    if (brFar[a] > 0) { afReal = brFar[a]; }
                    afOI = toOutIn(afReal, zArr[a]);
                  }
                  const afAdj: Uint256 = Math.mulDiv(afOI, sfArr[a], FEE_DENOM);
                  let wp: Uint256 = 0;
                  if (aadj > pAdj) { wp = 1; }
                  if (aadj === pAdj) { if (afAdj > pFarAdj) { wp = 1; } }
                  if (wp === 1) { pAdj = aadj; pFarAdj = afAdj; pBest = a; }
                }
              }
            }
            // Leg QL VENUE cursors: a slice head is ALREADY post-fee (NO extra fee-adjust) and
            // flat (far == near). lgQv records the winning venue's GLOBAL qlv index. Activity is
            // the cursor test ALONE (the qlCursorActive mirror; active ⇒ remCap > 0 — see 1b).
            if (HAS_LEG_QLV) {
              const qB: Uint256 = rt[3 + 5 * L];
              const qE: Uint256 = qB + rt[4 + 5 * L];
              for (let u = qB; u < qE; u = u + 1) {
                if (qlCur[u] < qlStart[u] + qlCount[u]) {
                  const qh: Uint256 = msNear[qlCur[u]];
                  if (qh >= pAdj) {
                    let wq: Uint256 = 0;
                    if (qh > pAdj) { wq = 1; }
                    if (qh === pAdj) { if (qh > pFarAdj) { wq = 1; } }
                    if (wq === 1) { pAdj = qh; pFarAdj = qh; lgIsQ[L] = 1; lgQv[L] = u; }
                  }
                }
              }
            }
            if (HAS_LEG_QLV && lgIsQ[L] === 1) {
              // QL slice member fill: lgN == lgF == head (a flat constant-price span), lgL = 0
              // (NOT an L==0 gap — every Phase B/C/D pool formula dispatches on lgIsQ BEFORE
              // touching lgL), lgFee = 0 (heads are post-fee), lgFR = 0; lgNF is written by
              // Phase C with the member's awarded INPUT (pools keep carrying the new far).
              const qw: Uint256 = lgQv[L];
              const hv: Uint256 = msNear[qlCur[qw]];
              lgN[L] = hv;
              lgF[L] = hv;
              lgL[L] = 0;
              lgFee[L] = 0;
              lgFR[L] = 0;
            } else {
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
            // counter q over [0, i) and address leg j = i-1-q (legs i-1 down to 0). A QL slice
            // member's full-cross gross is its remaining capacity (dispatch on lgIsQ BEFORE any
            // lgL read — a slice also carries lgL==0 but is NOT a gap).
            let need: Uint256 = 0;
            if (HAS_LEG_QLV && lgIsQ[i] === 1) { need = qlRemCap[lgQv[i]]; }
            else { need = bracketGross(lgL[i], lgN[i], lgF[i], lgFee[i]); }
            let crossed: Uint256 = 0;
            for (let q = 0; q < i; q = q + 1) {
              const j: Uint256 = i - 1 - q;
              if (HAS_LEG_QLV && lgIsQ[j] === 1) {
                // Upstream SLICE: producing `need` costs mulDiv(need, remCap, remOut) (floor —
                // the invertFarFromOut ≤-convention), valid ONLY while need < remOut; at/above it
                // the slice itself crosses first (the bracket `farj <= lgF` sentinel's slice
                // analogue, EQUALITY INCLUDED). A slice is never the L==0 gap (remCap ≥ 1 while
                // its cursor is valid), so no divide guard is needed (remOut > 0 while remCap > 0).
                const vj: Uint256 = lgQv[j];
                if (need >= qlRemOut[vj]) { crossed = 1; }
                else { need = Math.mulDiv(need, qlRemCap[vj], qlRemOut[vj]); }
              } else {
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
            }
            if (crossed === 0) {
              if (haveBest === 0) { bindLeg = i; routeIn = need; haveBest = 1; }
              else { if (need < routeIn) { bindLeg = i; routeIn = need; } }
            }
          }

          // Phase C: resolve the event from the binding leg. The binding leg lands EXACTLY on its
          // bracket far (lgNF[bindLeg] = its far) — or, for a binding SLICE, fully crosses
          // (gross = remCap, out = remOut; the flat span has no far and Phase D reads remCap
          // directly); upstream legs back-invert (invertFarFromOut; a slice back-inverts
          // x = mulDiv(need, remCap, remOut)) to PRODUCE the binding leg's exact gross input;
          // downstream legs forward-invert (invertFarFromGrossIn; a slice absorbs
          // min(flow, remCap)) to ABSORB the upstream leg's exact output. For a SLICE member
          // lgNF carries its awarded INPUT (pools keep the new far). routeIn is recomputed
          // exactly here (the back-propagated leg-0 gross).
          let bindGrossIn: Uint256 = 0;
          let bindOut: Uint256 = 0;
          if (HAS_LEG_QLV && lgIsQ[bindLeg] === 1) {
            const vb: Uint256 = lgQv[bindLeg];
            bindGrossIn = qlRemCap[vb];
            bindOut = qlRemOut[vb];
          } else {
            lgNF[bindLeg] = lgF[bindLeg];
            bindGrossIn = bracketGross(lgL[bindLeg], lgN[bindLeg], lgF[bindLeg], lgFee[bindLeg]);
            bindOut = bracketOut(lgL[bindLeg], lgN[bindLeg], lgF[bindLeg]);
          }
          // Upstream (j < bindLeg): each PRODUCES the downstream leg's exact required input. Walk
          // an ASCENDING counter q over [0, bindLeg) and address j = bindLeg-1-q (uint256-only).
          let need: Uint256 = bindGrossIn;
          for (let q = 0; q < bindLeg; q = q + 1) {
            const j: Uint256 = bindLeg - 1 - q;
            if (HAS_LEG_QLV && lgIsQ[j] === 1) {
              // Upstream SLICE back-inverts x = mulDiv(need, remCap, remOut) (floor — produced-out
              // ≤ demanded, slip absorbed downstream); lgNF carries the awarded INPUT.
              const vj: Uint256 = lgQv[j];
              const xj: Uint256 = Math.mulDiv(need, qlRemCap[vj], qlRemOut[vj]);
              lgNF[j] = xj;
              need = xj;
            } else {
              const farj: Uint256 = invertFarFromOut(lgL[j], lgN[j], need);
              lgNF[j] = farj;
              need = bracketGross(lgL[j], lgN[j], farj, lgFee[j]);
            }
          }
          routeIn = need; // token-A gross input (the merged route input this event)
          // Downstream (j > bindLeg): each ABSORBS the upstream leg's exact output as gross-in.
          let flow: Uint256 = bindOut;
          for (let j = bindLeg + 1; j < legCount; j = j + 1) {
            if (HAS_LEG_QLV && lgIsQ[j] === 1) {
              // Downstream SLICE absorbs min(flow, remCap) (defensive clamp — the argmin
              // guarantees flow < remCap up to rounding; landing exactly ON remCap is a full
              // consume at apply time) and produces the floored linear out. lgNF = its INPUT.
              const vj: Uint256 = lgQv[j];
              let xj: Uint256 = flow;
              if (xj > qlRemCap[vj]) { xj = qlRemCap[vj]; }
              lgNF[j] = xj;
              flow = Math.mulDiv(xj, qlRemOut[vj], qlRemCap[vj]);
            } else {
              const farj: Uint256 = invertFarFromGrossIn(lgL[j], lgN[j], flow, lgFee[j]);
              lgNF[j] = farj;
              flow = bracketOut(lgL[j], lgN[j], farj);
            }
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
            // A SLICE member consumes min(pflow, remCap) into its venue cursor (qinp accrual — the
            // stake-at-average slice analogue of the pools' interior partial) and produces the
            // floored linear out; remCap hitting 0 advances the cursor + re-seeds from the next
            // row (or exhausts) — the qlCursorConsume mirror.
            let pflow: Uint256 = rtake;
            for (let L = 0; L < legCount; L = L + 1) {
              if (HAS_LEG_QLV && lgIsQ[L] === 1) {
                const vv: Uint256 = lgQv[L];
                let xj: Uint256 = pflow;
                if (xj > qlRemCap[vv]) { xj = qlRemCap[vv]; }
                qinp[vv] = qinp[vv] + xj;
                const outX: Uint256 = Math.mulDiv(xj, qlRemOut[vv], qlRemCap[vv]);
                qlRemCap[vv] = qlRemCap[vv] - xj;
                qlRemOut[vv] = qlRemOut[vv] - outX;
                if (qlRemCap[vv] === 0) {
                  qlCur[vv] = qlCur[vv] + 1;
                  if (qlCur[vv] < qlStart[vv] + qlCount[vv]) {
                    qlRemCap[vv] = msCap[qlCur[vv]];
                    qlRemOut[vv] = msOut[qlCur[vv]];
                  } else { qlRemOut[vv] = 0; }
                }
                pflow = outX; // this slice's output → next leg's gross-in
              } else {
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
            }
          } else {
            // Full event: cross the binding leg's tick; partial-fill the others to lgNF[L].
            for (let L = 0; L < legCount; L = L + 1) {
              if (HAS_LEG_QLV && lgIsQ[L] === 1) {
                // SLICE member apply: the BINDING slice fully crosses (award = its remCap); a
                // non-binding slice applies its Phase C awarded input lgNF[L] ONLY on a routeIn>0
                // event (a zero-flow interior-gap event leaves it untouched — the pools' routeIn>0
                // partial guard mirrored; a slice itself is never the gap). Accrue the award into
                // qinp (the venue's Σ in ITS LEG-INPUT token — the exec's venue weight; for a
                // leg-0 slice the award == routeIn by construction, so rinp still carries the
                // route-level pull). remCap hitting 0 — the full cross AND an exact-boundary
                // partial — advances the cursor + re-seeds from the next row (or exhausts:
                // remOut = 0, the born-exhausted sentinel).
                const vv: Uint256 = lgQv[L];
                let award: Uint256 = 0;
                if (L === bindLeg) { award = qlRemCap[vv]; }
                else { if (routeIn > 0) { award = lgNF[L]; } }
                if (award > 0) {
                  qinp[vv] = qinp[vv] + award;
                  const outX: Uint256 = Math.mulDiv(award, qlRemOut[vv], qlRemCap[vv]);
                  qlRemCap[vv] = qlRemCap[vv] - award;
                  qlRemOut[vv] = qlRemOut[vv] - outX;
                }
                if (qlRemCap[vv] === 0) {
                  qlCur[vv] = qlCur[vv] + 1;
                  if (qlCur[vv] < qlStart[vv] + qlCount[vv]) {
                    qlRemCap[vv] = msCap[qlCur[vv]];
                    qlRemOut[vv] = msOut[qlCur[vv]];
                  } else { qlRemOut[vv] = 0; }
                }
              } else {
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
          }
          rinp[bestRoute] = rinp[bestRoute] + rtake;
          cum = cum + rtake;
        } else {
          if ((HAS_CURVE || HAS_LB || HAS_DODO || HAS_SOLIDLY_STABLE || HAS_WOMBAT || HAS_BALANCER || HAS_EULER || HAS_MAVERICK || HAS_CRYPTO || HAS_WOOFI || HAS_FERMI || HAS_FLUID || HAS_MENTO || HAS_BALANCER_V3 || HAS_TESSERA || HAS_ELFOMO || HAS_METRIC || HAS_LIQUIDCORE || HAS_SIZE) &&bestKind === 1) {
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
                                      } else {
                                        // segKind 15 — Tessera V (Wintermute wrapper): callback-free,
                                        // executed below via tesseraSwapViewAmounts (probe-then-decode
                                        // amountCheck) + approve + tesseraSwapWithAllowances(..., "").
                                        if (HAS_TESSERA && sKind === 15) {
                                          teinp[sIdx] = teinp[sIdx] + stake;
                                          teven[sIdx] = sVenue;
                                        } else {
                                          // segKind 16 — ElfomoFi (vault-funded PMM): callback-free,
                                          // executed below via the graceful getAmountOut (limitAmount)
                                          // + approve + swap(..., partnerId 0).
                                          if (HAS_ELFOMO && sKind === 16) {
                                            elinp[sIdx] = elinp[sIdx] + stake;
                                            elven[sIdx] = sVenue;
                                          } else {
                                            // segKind 17 — METRIC (oracle-anchored bin-curve OMM):
                                            // callback-free from this contract's perspective, executed
                                            // below via the anchor probe + quoteSwap (minAmountOut) +
                                            // approve ROUTER + swapExactInput. sVenue = the pool;
                                            // msAux = the venue's ROUTER (stamped by the QL emit).
                                            if (HAS_METRIC && sKind === 17) {
                                              mcinp[sIdx] = mcinp[sIdx] + stake;
                                              mcven[sIdx] = sVenue;
                                              mcrtr[sIdx] = msAux[segCur];
                                            } else {
                                              // segKind 18 — LIQUIDCORE: callback-free, executed
                                              // below via estimateSwap (minAmountOut) + approve
                                              // POOL + pool.swap. sVenue = the per-pair pool.
                                              if (HAS_LIQUIDCORE && sKind === 18) {
                                                lcinp[sIdx] = lcinp[sIdx] + stake;
                                                lcven[sIdx] = sVenue;
                                              } else {
                                                // segKind 19 — INTEGRAL SIZE: callback-free,
                                                // executed below via quoteSell (amountOutMin;
                                                // probe-then-decode — a sub-min award soft-skips)
                                                // + approve RELAYER + sell. sVenue = the relayer.
                                                if (HAS_SIZE && sKind === 19) {
                                                  szinp[sIdx] = szinp[sIdx] + stake;
                                                  szven[sIdx] = sVenue;
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
  // Routes: chain-order leg execution — ONE unified per-leg loop for ALL legs (N-hop, ANY member
  // mix). Leg L's INPUT token is tokenIn (L==0) else the previous intermediate (rt[5L]); its
  // OUTPUT token is tokenOut (final leg) else this leg's intermediate (rt[5+5L]). The leg's
  // members — universe pools [poolBase, poolBase+poolCount) AND (leg-QL) venues [qlvBase,
  // qlvBase+qlvCount) — split the leg's input PROPORTIONAL to their merged awards (pools inp[],
  // venues qinp[]), the LAST funded member absorbing the division dust (pools scanned first,
  // venues second, so a funded venue wins 'last'). Leg 0's input is its COMPUTED award sum
  // (inBal := lTotal ⇒ share == mulDiv(lTotal, w, lTotal) == w EXACTLY and the last-member
  // remainder is exact — the computed-share semantics through the SAME proportional path), NOT a
  // balanceOf read: the direct-QL families' tokenIn shares are still UN-executed at route time
  // (their loops run after the routes), so a whole-balance read would drain them. Legs L>0 feed
  // the REALIZED input-token balance. Pool members dispatch by type (pd[0]/pd[6]) — swapV3 for
  // V3, swap(poolType:0) for V2, swap(poolType:2) for V4 with the leg PoolKey; venue members
  // dispatch on the descriptor segKind (qd[4]) — each MIRRORING the direct execution blocks with
  // (tokenIn, tokenOut) → (legIn, legOut). 2-hop and 3-hop are the same loop.
  if (HAS_ROUTES) {
  for (let r = 0; r < routing.length; r = r + 1) {
    const ramt: Uint256 = rinp[r];
    if (ramt > 0) {
      const rt: Tuple = routing[r];
      const legCount: Uint256 = rt[0];
      for (let L = 0; L < legCount; L = L + 1) {
        const baseL: Uint256 = rt[1 + 5 * L];
        const eL: Uint256 = baseL + rt[2 + 5 * L];
        // leg input token: tokenIn for leg0, else the previous leg's intermediate (rt[5L] ==
        // leg L−1's inter slot rt[5+5(L−1)]).
        let legIn: Address = tokenIn;
        if (L > 0) { legIn = rt[5 * L]; }
        // leg output token: this leg's intermediate (rt[5+5L]) unless this is the final leg.
        let legOut: Address = tokenOut;
        if (L + 1 < legCount) { legOut = rt[5 + 5 * L]; }
        // The leg's funded member-weight sum: pools' inp[] + (leg-QL) venues' qinp[].
        let lTotal: Uint256 = 0;
        for (let b = baseL; b < eL; b = b + 1) { lTotal = lTotal + inp[b]; }
        if (HAS_LEG_QLV) {
          const qsB: Uint256 = rt[3 + 5 * L];
          const qsE: Uint256 = qsB + rt[4 + 5 * L];
          for (let u = qsB; u < qsE; u = u + 1) { lTotal = lTotal + qinp[u]; }
        }
        // WHOLE-BALANCE DRAIN (legs L>0): reads the ENTIRE balanceOf(legIn) and the last funded
        // member takes the remainder. This is correct ONLY because (a) routes run fully
        // sequentially (the enclosing `for r`), so each route produces AND consumes its
        // intermediate within its own contiguous run before the next route deposits the same
        // token, and (b) EVERY leg member — pool swap or QL venue dispatch — executes INLINE in
        // this per-leg loop with its output landing at address.self in the leg's OUT token
        // (leg-QL exec is never deferred to the per-family direct loops below, which run after
        // all routes). Two admitted disjoint-POOL routes may still share an intermediate TOKEN
        // via different edges; that safety rests on THIS exec order, NOT on prepare's
        // disjoint-pool filter — do not batch legs across routes.
        let inBal: Uint256 = lTotal;
        if (L > 0) { inBal = IERC20.at(legIn).balanceOf(address.self); }
        if (inBal > 0) {
          // Last FUNDED member (pools scanned first, venues second ⇒ a funded venue wins
          // 'last') — it absorbs the proportional-split dust so the whole inBal is spent.
          let lastIsQ: Uint256 = 0;
          let lastIdx: Uint256 = baseL;
          let spent: Uint256 = 0;
          if (lTotal > 0) {
            for (let b = baseL; b < eL; b = b + 1) {
              if (inp[b] > 0) { lastIdx = b; }
            }
            if (HAS_LEG_QLV) {
              const qsB: Uint256 = rt[3 + 5 * L];
              const qsE: Uint256 = qsB + rt[4 + 5 * L];
              for (let u = qsB; u < qsE; u = u + 1) {
                if (qinp[u] > 0) { lastIsQ = 1; lastIdx = u; }
              }
            }
            for (let b = baseL; b < eL; b = b + 1) {
              const w: Uint256 = inp[b];
              if (w > 0) {
                let share: Uint256 = Math.mulDiv(inBal, w, lTotal);
                if (lastIsQ === 0) { if (b === lastIdx) { share = inBal - spent; } }
                if (share > 0) {
                  const lp: Tuple = pools[b];
                  const lIsV2: Uint256 = lp[6];
                  const lType: Uint256 = lp[0];
                  const lz: Uint256 = lp[7]; // leg pool's inIsToken0 (legIn-is-currency0 when 1)
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
            // Funded-weight 0 but balance arrived (rounding dust): route it through the leg's
            // first POOL when it has one (rt[2+5L] > 0 — unchanged); a POOL-LESS leg routes it
            // through its FIRST venue via the shared venue dispatch below (share = inBal).
            // pools[baseL] on an empty pool slice would dereference an UNRELATED pool (an empty
            // slice emits base 0) and revert the whole cook.
            if (rt[2 + 5 * L] > 0) {
              router.swapV3(pools[baseL][1], legIn, legOut, inBal, 0, address.self, address.self);
            }
          }
          // ── Leg-QL VENUE execution — the ONE dispatch home (shared by the proportional split
          // AND the pool-less dust fallback above). Each funded venue swaps its share on ITS OWN
          // family surface with (legIn, legOut) substituted for (tokenIn, tokenOut) — the direct
          // per-family loops below, leg-parameterized. Min/limit args mirror the direct loops:
          // the engine-routed unified swap carries no per-leg floor (sqrtPriceLimitX96 0); each
          // callback-free family re-quotes ITS OWN live view and passes that quote as the
          // min/out-slot arg (never trips: same state, atomic); Balancer V3's min stays 0 (its
          // query is eth_call-only) — the whole-trade cfg[9] floor is the aggregate protection.
          // A venue whose live re-quote returns 0 at exec skips its swap (the `out > 0` guards)
          // and leaves its share in legIn for the per-route intermediate sweep below.
          if (HAS_LEG_QLV) {
            const qsB: Uint256 = rt[3 + 5 * L];
            const qsE: Uint256 = qsB + rt[4 + 5 * L];
            for (let u = qsB; u < qsE; u = u + 1) {
              let share: Uint256 = 0;
              if (lTotal > 0) {
                const w: Uint256 = qinp[u];
                if (w > 0) {
                  share = Math.mulDiv(inBal, w, lTotal);
                  if (lastIsQ === 1) { if (u === lastIdx) { share = inBal - spent; } }
                }
              } else {
                // pool-less dust fallback: the whole stray balance through the FIRST venue.
                if (rt[2 + 5 * L] === 0) { if (u === qsB) { share = inBal; } }
              }
              if (share > 0) {
                const qd: Tuple = qlv[u];
                const qk: Uint256 = qd[4];
                const qPool: Address = qd[0];
                // Engine-routed kinds (Curve 1 / LB 2 / DODO 3 / BalV2 6 / Maverick 8) collapse
                // to ONE unified router swap: the engine resolves coin indices / swapForY /
                // base-quote / poolId / tokenA on-chain from the SwapParams tokens (NONE
                // hardcodes the pair), so ONLY poolType differs — mapped below (every
                // engine-routed SwapPoolType is > 0, so ep == 0 is the not-engine-routed
                // sentinel). payer/recipient == self: the leg's input balance is already here
                // (leg0: compute-then-pull; L>0: the previous leg's realized out) and the out
                // feeds the next leg / the terminal payout.
                if (HAS_CURVE || HAS_LB || HAS_DODO || HAS_BALANCER || HAS_MAVERICK) {
                  let ep: Uint256 = 0;
                  if (HAS_CURVE && qk === 1) { ep = 3; }    // → SwapPoolType.Curve
                  if (HAS_LB && qk === 2) { ep = 6; }       // → SwapPoolType.TraderJoeLB
                  if (HAS_DODO && qk === 3) { ep = 5; }     // → SwapPoolType.DODOV2
                  if (HAS_BALANCER && qk === 6) { ep = 4; } // → SwapPoolType.BalancerV2
                  if (HAS_MAVERICK && qk === 8) { ep = 7; } // → SwapPoolType.MaverickV2
                  if (ep > 0) {
                    router.swap({
                      poolType: ep, pool: qPool,
                      poolKey: { currency0: 0, currency1: 0, fee: 0, tickSpacing: 0, hooks: 0 },
                      tokenIn: legIn, tokenOut: legOut, amountSpecified: Math.neg(share),
                      sqrtPriceLimitX96: 0, payer: address.self, recipient: address.self,
                    });
                  }
                }
                // Solidly STABLE (segKind 4) — callback-free: exact getAmountOut, transfer-first,
                // output in the OUT-token slot by the pool's own token0() (the direct loop).
                if (HAS_SOLIDLY_STABLE && qk === 4) {
                  const qsOut: Uint256 = ISolidlyStablePool.at(qPool).getAmountOut(share, legIn);
                  if (qsOut > 0) {
                    const qsT0: Address = ISolidlyStablePool.at(qPool).token0();
                    IERC20.at(legIn).transfer(qPool, share);
                    const qsEmpty: bytes = abi.encode(legIn).slice(0, 0);
                    if (qsT0 === legIn) {
                      ISolidlyStablePool.at(qPool).swap(0, qsOut, address.self, qsEmpty);
                    } else {
                      ISolidlyStablePool.at(qPool).swap(qsOut, 0, address.self, qsEmpty);
                    }
                  }
                }
                // Wombat (segKind 5) — callback-free: exact quotePotentialSwap as the min,
                // approve-first (Wombat PULLS via transferFrom inside swap).
                if (HAS_WOMBAT && qk === 5) {
                  const qwOut: Uint256 = IWombatPool.at(qPool).quotePotentialSwap(legIn, legOut, share)[0];
                  if (qwOut > 0) {
                    const qwDl: Uint256 = 2 ** 64;
                    IERC20.at(legIn).approve(qPool, share);
                    IWombatPool.at(qPool).swap(legIn, legOut, share, qwOut, address.self, qwDl);
                  }
                }
                // EulerSwap (segKind 7) — callback-free: exact computeQuote, transfer-first,
                // output slot by the pool's own getAssets()[0] (the direct loop).
                if (HAS_EULER && qk === 7) {
                  const qeOut: Uint256 = IEulerSwapPool.at(qPool).computeQuote(legIn, legOut, share, true);
                  if (qeOut > 0) {
                    const qeA0: Address = IEulerSwapPool.at(qPool).getAssets()[0];
                    IERC20.at(legIn).transfer(qPool, share);
                    const qeEmpty: bytes = abi.encode(legIn).slice(0, 0);
                    if (qeA0 === legIn) {
                      IEulerSwapPool.at(qPool).swap(0, qeOut, address.self, qeEmpty);
                    } else {
                      IEulerSwapPool.at(qPool).swap(qeOut, 0, address.self, qeEmpty);
                    }
                  }
                }
                // Curve CryptoSwap (segKind 9) — callback-free: uint256 coin indices resolved
                // on-chain via coins(0), exact get_dy as min_dy, approve-first (the direct loop).
                if (HAS_CRYPTO && qk === 9) {
                  const qxc0: Address = ICryptoSwapPool.at(qPool).coins(0);
                  let qxi: Uint256 = 1;
                  let qxj: Uint256 = 0;
                  if (qxc0 === legIn) { qxi = 0; qxj = 1; }
                  const qxOut: Uint256 = ICryptoSwapPool.at(qPool).get_dy(qxi, qxj, share);
                  if (qxOut > 0) {
                    IERC20.at(legIn).approve(qPool, share);
                    ICryptoSwapPool.at(qPool).exchange(qxi, qxj, share, qxOut);
                  }
                }
                // WOOFi (segKind 10) — callback-free: live query as minToAmount, transfer-first
                // (WooPPV2 computes the sold amount from balance − reserve); rebateTo == caller.
                if (HAS_WOOFI && qk === 10) {
                  const qwooOut: Uint256 = IWooFiPool.at(qPool).query(legIn, legOut, share);
                  if (qwooOut > 0) {
                    IERC20.at(legIn).transfer(qPool, share);
                    IWooFiPool.at(qPool).swap(legIn, legOut, share, qwooOut, address.self, caller);
                  }
                }
                // Fermi / propAMM (segKind 11) — callback-free: quoteAmounts[1] as amountCheck,
                // approve-first (propAMM PULLS via transferFrom inside fermiSwapWithAllowances).
                if (HAS_FERMI && qk === 11) {
                  const qfeOut: Uint256 = IFermiPool.at(qPool).quoteAmounts(legIn, legOut, share)[1];
                  if (qfeOut > 0) {
                    IERC20.at(legIn).approve(qPool, share);
                    IFermiPool.at(qPool).fermiSwapWithAllowances(legIn, legOut, share, qfeOut, address.self);
                  }
                }
                // Fluid DEX (segKind 12) — callback-free: the chain-wide resolver's (cfg[6]) LIVE
                // estimateSwapIn as amountOutMin (a plain CALL — the DexT1 estimate writes state
                // before its result-revert, so a staticcall would quote 0; the resolver decodes it
                // in Solidity), approve-first (Fluid PULLS via safeTransferFrom inside swapIn). The
                // direction bit is derived ON-CHAIN from getDexTokens vs the LEG's in-token — the
                // same derive-don't-trust read the direct exec block uses, made leg-correct by the
                // legIn substitution.
                if (HAS_FLUID && qk === 12) {
                  const qflT0: Address = IFluidDexResolver.at(fluidResolver).getDexTokens(qPool)[0];
                  let qflZ: Uint256 = 0;
                  if (qflT0 === legIn) { qflZ = 1; }
                  const qflOut: Uint256 = IFluidDexResolver.at(fluidResolver).estimateSwapIn(qPool, qflZ, share, 0);
                  if (qflOut > 0) {
                    IERC20.at(legIn).approve(qPool, share);
                    IFluidDexPool.at(qPool).swapIn(qflZ, share, qflOut, address.self);
                  }
                }
                // Mento V2 (segKind 13) — callback-free: qd[0] = exchangeProvider, qd[1] = the
                // bytes32 exchangeId; the approve target is the CHAIN-WIDE Broker (cfg[7]), not
                // the per-pair provider (the direct loop).
                if (HAS_MENTO && qk === 13) {
                  const qmtId: Uint256 = qd[1];
                  const qmtOut: Uint256 = IMentoBroker.at(mentoBroker).getAmountOut(qPool, qmtId, legIn, legOut, share);
                  if (qmtOut > 0) {
                    IERC20.at(legIn).approve(mentoBroker, share);
                    IMentoBroker.at(mentoBroker).swapIn(qPool, qmtId, legIn, legOut, share, qmtOut);
                  }
                }
                // Balancer V3 (segKind 14) — callback-free: Permit2 two-step on the LEG token,
                // then Router.swapSingleTokenExactIn with minAmountOut 0 (its query is
                // eth_call-ONLY — see the direct loop's rationale; the whole-trade cfg[9] floor
                // guards the aggregate). Router (cfg[8]) + PERMIT2 are chain-wide.
                if (HAS_BALANCER_V3 && qk === 14) {
                  const qbEmpty: bytes = abi.encode(legIn).slice(0, 0);
                  IERC20.at(legIn).approve(PERMIT2, share);
                  IPermit2.at(PERMIT2).approve(legIn, balancerV3Router, share, B3_EXPIRATION);
                  IBalancerV3Router.at(balancerV3Router).swapSingleTokenExactIn(qPool, legIn, legOut, share, 0, B3_DEADLINE, 0, qbEmpty);
                }
                // Tessera V (segKind 15) — callback-free: the live signed-amount view as
                // amountCheck (PROBE-THEN-DECODE — the view is revert-class, so a paused/starved
                // venue skips soft instead of bricking the cook; the share strands in legIn and the
                // per-route intermediate sweep / terminal refund returns it), approve-first
                // (Tessera PULLS via transferFrom inside tesseraSwapWithAllowances; empty swapData).
                if (HAS_TESSERA && qk === 15) {
                  let qteOk: Uint256 = 1;
                  ITesseraSwap.at(qPool).tesseraSwapViewAmounts(legIn, legOut, share).catch(() => { qteOk = 0; });
                  if (qteOk === 1) {
                    const qteOut: Uint256 = ITesseraSwap.at(qPool).tesseraSwapViewAmounts(legIn, legOut, share)[1];
                    if (qteOut > 0) {
                      const qteEmpty: bytes = abi.encode(legIn).slice(0, 0);
                      IERC20.at(legIn).approve(qPool, share);
                      ITesseraSwap.at(qPool).tesseraSwapWithAllowances(legIn, legOut, share, qteOut, address.self, qteEmpty);
                    }
                  }
                }
                // ElfomoFi (segKind 16) — callback-free: the live GRACEFUL getAmountOut as
                // limitAmount (0 ⇒ stale/unsupported ⇒ skip soft), approve-first (Elfomo PULLS via
                // transferFrom inside swap; partnerId 0).
                if (HAS_ELFOMO && qk === 16) {
                  const qelOut: Uint256 = IElfomoFi.at(qPool).getAmountOut(legIn, legOut, share);
                  if (qelOut > 0) {
                    IERC20.at(legIn).approve(qPool, share);
                    IElfomoFi.at(qPool).swap(legIn, legOut, share, qelOut, address.self, 0);
                  }
                }
                // METRIC (segKind 17) — callback-free from this contract's perspective: derive the
                // provider + direction ON-CHAIN from the pool's immutables ([1]/[2] — the Fluid
                // derive-don't-trust rule, so the arm is edge-correct for ANY leg), probe the anchor
                // (a stale maker skips soft — the share strands in legIn and the per-route
                // intermediate sweep / terminal refund returns it), probe the live quote at the
                // frozen anchor (DIRECTIONAL limit; |negative out-delta|) as minAmountOut, approve
                // the venue's ROUTER (qd[7]) and swapExactInput. The pool pays out first and
                // re-enters metricOmmSwapCallback ON THE ROUTER (never this contract).
                if (HAS_METRIC && qk === 17) {
                  const qmcRtr: Address = qd[7];
                  const qmcProv: Address = IMetricPool.at(qPool).getImmutables()[1];
                  const qmcT0: Address = IMetricPool.at(qPool).getImmutables()[2];
                  let qmcXy: Uint256 = 0;
                  if (qmcT0 === legIn) { qmcXy = 1; }
                  let qmcLim: Uint256 = 0;
                  if (qmcXy === 0) { qmcLim = MC_U128MAX; }
                  let qmcAmt: Uint256 = share;
                  if (qmcAmt > MC_I128MAX) { qmcAmt = MC_I128MAX; }
                  let qmcOk: Uint256 = 1;
                  IMetricPriceProvider.at(qmcProv).getBidAndAskPrice().catch(() => { qmcOk = 0; });
                  if (qmcOk === 1) {
                    const qmcBid: Uint256 = IMetricPriceProvider.at(qmcProv).getBidAndAskPrice()[0];
                    const qmcAsk: Uint256 = IMetricPriceProvider.at(qmcProv).getBidAndAskPrice()[1];
                    IMetricRouter.at(qmcRtr).quoteSwap(qPool, qmcXy, qmcAmt, qmcLim, qmcBid, qmcAsk).catch(() => { qmcOk = 0; });
                    if (qmcOk === 1) {
                      let qmcW: Uint256 = 0;
                      if (qmcXy === 1) { qmcW = IMetricRouter.at(qmcRtr).quoteSwap(qPool, qmcXy, qmcAmt, qmcLim, qmcBid, qmcAsk)[1]; }
                      else { qmcW = IMetricRouter.at(qmcRtr).quoteSwap(qPool, qmcXy, qmcAmt, qmcLim, qmcBid, qmcAsk)[0]; }
                      let qmcOut: Uint256 = 0;
                      if (qmcW >= MC_HALF) { qmcOut = Math.neg(qmcW); }
                      if (qmcOut > 0) {
                        IERC20.at(legIn).approve(qmcRtr, qmcAmt);
                        IMetricRouter.at(qmcRtr).swapExactInput(qPool, address.self, qmcXy, qmcAmt, qmcLim, qmcOut, MC_DEADLINE);
                        // RESET the allowance (a partial fill pulls less than approved; a USDT-class
                        // legIn would revert a later nonzero→nonzero approve — see the direct arm).
                        IERC20.at(legIn).approve(qmcRtr, 0);
                      }
                    }
                  }
                }
                // LIQUIDCORE (segKind 18) — callback-free: probe the live estimateSwap for the out
                // (a dead/drained venue skips soft — the share strands in legIn and the per-route
                // intermediate sweep / terminal refund returns it), approve the POOL and swap. The
                // pool pulls EXACTLY the share via transferFrom (pull == approve always — no
                // residue path, fork-proven).
                if (HAS_LIQUIDCORE && qk === 18) {
                  let qlcOk: Uint256 = 1;
                  ILiquidCorePool.at(qPool).estimateSwap(legIn, legOut, share).catch(() => { qlcOk = 0; });
                  if (qlcOk === 1) {
                    const qlcOut: Uint256 = ILiquidCorePool.at(qPool).estimateSwap(legIn, legOut, share);
                    if (qlcOut > 0) {
                      IERC20.at(legIn).approve(qPool, share);
                      ILiquidCorePool.at(qPool).swap(legIn, legOut, share, qlcOut);
                    }
                  }
                }
                // INTEGRAL SIZE (segKind 19) — callback-free: probe the live quoteSell (a SUB-MIN
                // award reverts TR03 / an over-cap award TR3A / a disabled pair TR5A — each skips
                // SOFT into the sweep/refund), approve the RELAYER and sell (to = this contract;
                // TR26 only bars tokenIn/tokenOut/0). Pull == approve always — no residue path.
                if (HAS_SIZE && qk === 19) {
                  let qszOk: Uint256 = 1;
                  ISizeRelayer.at(qPool).quoteSell(legIn, legOut, share).catch(() => { qszOk = 0; });
                  if (qszOk === 1) {
                    const qszOut: Uint256 = ISizeRelayer.at(qPool).quoteSell(legIn, legOut, share);
                    if (qszOut > 0) {
                      IERC20.at(legIn).approve(qPool, share);
                      ISizeRelayer.at(qPool).sell({ tokenIn: legIn, tokenOut: legOut, amountIn: share, amountOutMin: qszOut, wrapUnwrap: 0, to: address.self, submitDeadline: SZ_DEADLINE });
                    }
                  }
                }
                spent = spent + share;
              }
            }
          }
        }
      }
      // ── Per-route INTERMEDIATE-token sweep (defense-in-depth; normally 0) ── every leg
      // member's exec is guarded `out > 0`, so a venue whose live re-quote returns 0 at exec
      // (state moved adversely between the merge read and the exec / a cap shrank) skips its
      // swap and strands its share in the leg's INPUT token — an INTERMEDIATE token the
      // terminal tokenIn refund below cannot return (interL is never tokenIn or tokenOut: the
      // DFS interior tokens exclude the endpoints, so this sweep can interfere with neither
      // the terminal refund nor the tokenOut payout/minOut floor). Sweep any residual
      // intermediate balance to the caller after EACH route's contiguous run — BEFORE the next
      // route (which may share the intermediate token) whole-balance-drains it into ITS legs.
      if (HAS_LEG_QLV) {
        for (let L = 0; L + 1 < legCount; L = L + 1) {
          const interT: Address = rt[5 + 5 * L];
          const interBal: Uint256 = IERC20.at(interT).balanceOf(address.self);
          if (interBal > 0) { IERC20.at(interT).transfer(caller, interBal); }
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
  // and the SwapParams carry NO curve data — the segKind-8 LIVE bin-walk (the QL stream above) already used
  // it (the split is exact-on-grid vs the oracle), and the realized out is the engine swap (cross-checked
  // wei-exact against the on-chain quoter in the prod-mirror test). amountSpecified is NEGATIVE (the unified
  // exact-in convention; _swapMaverickV2 takes abs()). payer == address.self (compute-then-pull transferred
  // `cum`, incl. each Maverick share, above) so the callback's safeTransfer draws from this contract;
  // recipient == address.self. The poolKey is unused for poolType 7 — zeroed to match the V2-path SwapParams
  // shape. The engine passes the per-direction FULL-RANGE tickLimit (type(int32).max for tokenA-in,
  // type(int32).min for tokenB-in — ../sauce PR #193), so the swap walks the whole live tick book bounded
  // only by liquidity (it may cross tick 0); the bin-walk used the SAME bound (its MAXTICK / per-direction
  // walk) so the awarded Σ fills within the pool's depth (any un-consumed input is returned by the guarded
  // terminal refund below).
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
      // plain CALL). The split's awarded `b3amt` was priced ON-CHAIN this cook — the solver built the ladder by
      // replaying the live Vault StableMath (getCurrentLiveBalances / amp / static fee / live rates), so the
      // award already reflects cook-time state; we execute it as a straight exact-in swap with minAmountOut = 0
      // for THIS leg: exactIn means the Vault computes the out from the awarded input. There is NO per-leg
      // on-chain floor here, but the WHOLE-TRADE cfg[9] amountOutMin floor below (main()'s terminal
      // `if (minOut > 0) require(outBal >= minOut)`) now guards this Balancer V3 leg too: a shortfall on the
      // aggregate tokenOut reverts the whole cook atomically. So a Balancer V3 leg relies on the on-chain
      // live-state split (the solver's StableMath replay, mirrored bit-for-bit by the oracle) plus the
      // whole-trade floor plus whatever transaction-level slippage the integrator enforces
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
  // Tessera V (Wintermute TesseraSwap wrapper + private engine — treasury-funded prop-AMM) → CALLBACK-FREE
  // (NO engine SwapPoolType). Tessera prices off its private engine's posted state + feed, NOT xy=k, so the
  // engine's _swapV2 would mis-price it. Execute exactly as the Tessera taker would, against the REAL
  // verified wrapper surface: read the LIVE amountOut from tesseraSwapViewAmounts(tokenIn, tokenOut, +Σ)[1]
  // (the SECOND return is the exact-in out — positive amountSpecified = exact tokenIn, the propAMM/Fermi
  // taker convention) via PROBE-THEN-DECODE — the view is REVERT-class (a deactivated pair / engine pause /
  // a gas-starved call reverts), so a dead venue at exec time SKIPS SOFT: its share stays in this contract
  // and the terminal leftover refund returns it to the caller (never a bricked cook). APPROVE the wrapper
  // for the awarded input (Tessera PULLS via transferFrom inside tesseraSwapWithAllowances — approve-first,
  // like Fermi/Wombat/Curve, unlike the transfer-first WOOFi/Solidly path), then call
  // tesseraSwapWithAllowances(tokenIn, tokenOut, +Σ, amountCheck, to, "") with amountCheck == the
  // just-quoted out (the exact-in slippage bound — same-tx quote+swap is wei-exact on the real engine at
  // ANY gas price: the ~2-gwei globalPrioFeeThresholddd1337 shifts the quote sub-bp above threshold but
  // quote and exec read the SAME tx.gasprice, so the check never trips when the state is unchanged; empty
  // swapData is the verified taker path). The engine also enforces a ~18.5M gas-AVAILABILITY gate (burns
  // forwarded gas when starved) — cook Tessera universes with generous gas limits (see tessera-math.ts).
  // compute-then-pull already transferred `cum` (incl. each Tessera share) into this contract above, so the
  // approved pull draws from this contract's balance and the out lands here (to == self, paid from the
  // wrapper's treasury).
  if (HAS_TESSERA) {
  for (let te = 0; te < MS_CAP; te = te + 1) {
    const teamt: Uint256 = teinp[te];
    if (teamt > 0) {
      const tepool: Address = teven[te];
      let teOk: Uint256 = 1;
      ITesseraSwap.at(tepool).tesseraSwapViewAmounts(tokenIn, tokenOut, teamt).catch(() => { teOk = 0; });
      if (teOk === 1) {
        // amountSpecified is a SIGNED int256; teamt is a realistic-size POSITIVE amount ⇒ encodes as
        // +int256 (exact-in). The quote returns (amountIn, amountOut) — take [1] for the out.
        const teOut: Uint256 = ITesseraSwap.at(tepool).tesseraSwapViewAmounts(tokenIn, tokenOut, teamt)[1];
        if (teOut > 0) {
          const teEmpty: bytes = abi.encode(tokenIn).slice(0, 0);
          token.approve(tepool, teamt);
          ITesseraSwap.at(tepool).tesseraSwapWithAllowances(tokenIn, tokenOut, teamt, teOut, address.self, teEmpty);
        }
      }
    }
  }
  }
  // ElfomoFi (vault-funded PMM priced by an on-chain pricing module + oracle feed) → CALLBACK-FREE (NO
  // engine SwapPoolType). Elfomo prices off its pricing module's oracle feed + vault inventory, NOT xy=k,
  // so the engine's _swapV2 would mis-price it. Execute exactly as the Elfomo taker would, against the REAL
  // verified wrapper surface: read the LIVE amountOut from the GRACEFUL getAmountOut(tokenIn, tokenOut, +Σ)
  // (a plain single-return staticcall — 0 on a stale feed / unsupported pair, never a revert), used as
  // limitAmount; a 0 quote SKIPS the venue soft (its share stays here and the terminal leftover refund
  // returns it). APPROVE the wrapper for the awarded input (Elfomo PULLS via transferFrom inside swap —
  // approve-first, like Fermi/Tessera/Wombat/Curve, unlike the transfer-first WOOFi/Solidly path), then
  // call swap(tokenIn, tokenOut, +Σ, limitAmount, to, 0) (positive specifiedAmount = exact input;
  // partnerId 0) with limitAmount == the just-quoted out (the exact-in slippage bound; same-tx quote+swap
  // is wei-exact on the real Base wrapper and gas-price-insensitive — see elfomo-math.ts). compute-then-
  // pull already transferred `cum` (incl. each Elfomo share) into this contract above, so the approved pull
  // draws from this contract's balance and the out lands here (to == self, paid from the wrapper's vault).
  if (HAS_ELFOMO) {
  for (let el = 0; el < MS_CAP; el = el + 1) {
    const elamt: Uint256 = elinp[el];
    if (elamt > 0) {
      const elpool: Address = elven[el];
      const elOut: Uint256 = IElfomoFi.at(elpool).getAmountOut(tokenIn, tokenOut, elamt);
      if (elOut > 0) {
        token.approve(elpool, elamt);
        IElfomoFi.at(elpool).swap(tokenIn, tokenOut, elamt, elOut, address.self, 0);
      }
    }
  }
  }
  // METRIC (metric.xyz oracle-anchored bin-curve OMM) → CALLBACK-FREE from this contract's perspective
  // (NO engine SwapPoolType). A Metric pool prices off its maker-posted PriceProvider anchor + its bin
  // state, NOT xy=k, so the engine's _swapV2 would mis-price it. Execute exactly as the Metric taker
  // would, against the REAL router surface (fork-proven permissionless + wei-exact both directions):
  // derive the provider + direction ON-CHAIN from the pool's immutables ([1]/[2] — derive-don't-trust;
  // the accumulators carry only pool + router), PROBE the anchor (the provider REVERTS when the
  // maker's post is stale — a dead venue at exec time SKIPS SOFT: its share stays in this contract and
  // the terminal leftover refund returns it, never a bricked cook), PROBE the live
  // quoteSwap(pool, xToY, +Σ, limit, bid, ask) at the SAME anchor for the out (the DIRECTIONAL limit:
  // 0 for xToY, uint128.max for yToX), APPROVE the venue's ROUTER (mcrtr — it rides msAux from the QL
  // emit) for the awarded input, then swapExactInput(pool, self, xToY, +Σ, limit, minAmountOut,
  // deadline) with minAmountOut == the just-quoted out — the swap re-reads the SAME provider in-tx, so
  // the pair never trips when the state is unchanged (same-block quote+swap fork-proven wei-exact).
  // The pool pays the out to this contract FIRST, then re-enters metricOmmSwapCallback ON THE ROUTER
  // (the router implements it itself — the engine services nothing); the router pulls exactly the
  // CONSUMED input (an oversized share partial-fills; the remainder stays here for the terminal
  // refund). compute-then-pull already transferred `cum` (incl. each Metric share) into this contract
  // above, so the approved pull draws from this contract's balance.
  if (HAS_METRIC) {
  for (let mc = 0; mc < MS_CAP; mc = mc + 1) {
    const mcamt: Uint256 = mcinp[mc];
    if (mcamt > 0) {
      const mcpool: Address = mcven[mc];
      const mcrtrA: Address = mcrtr[mc];
      const mcprov: Address = IMetricPool.at(mcpool).getImmutables()[1];
      const mct0: Address = IMetricPool.at(mcpool).getImmutables()[2];
      let mcxy: Uint256 = 0;
      if (mct0 === tokenIn) { mcxy = 1; }
      let mcLim: Uint256 = 0;
      if (mcxy === 0) { mcLim = MC_U128MAX; }
      let mcAmt: Uint256 = mcamt;
      if (mcAmt > MC_I128MAX) { mcAmt = MC_I128MAX; }
      let mcOk: Uint256 = 1;
      IMetricPriceProvider.at(mcprov).getBidAndAskPrice().catch(() => { mcOk = 0; });
      if (mcOk === 1) {
        const mcBid: Uint256 = IMetricPriceProvider.at(mcprov).getBidAndAskPrice()[0];
        const mcAsk: Uint256 = IMetricPriceProvider.at(mcprov).getBidAndAskPrice()[1];
        IMetricRouter.at(mcrtrA).quoteSwap(mcpool, mcxy, mcAmt, mcLim, mcBid, mcAsk).catch(() => { mcOk = 0; });
        if (mcOk === 1) {
          let mcW: Uint256 = 0;
          if (mcxy === 1) { mcW = IMetricRouter.at(mcrtrA).quoteSwap(mcpool, mcxy, mcAmt, mcLim, mcBid, mcAsk)[1]; }
          else { mcW = IMetricRouter.at(mcrtrA).quoteSwap(mcpool, mcxy, mcAmt, mcLim, mcBid, mcAsk)[0]; }
          let mcOut: Uint256 = 0;
          if (mcW >= MC_HALF) { mcOut = Math.neg(mcW); }
          if (mcOut > 0) {
            token.approve(mcrtrA, mcAmt);
            IMetricRouter.at(mcrtrA).swapExactInput(mcpool, address.self, mcxy, mcAmt, mcLim, mcOut, MC_DEADLINE);
            // RESET the allowance: a PARTIAL FILL pulls only the consumed input (< mcAmt), leaving a
            // residue approval on this SHARED cooking contract — a USDT-class tokenIn (the wired
            // Ethereum venue's token0) reverts a later nonzero→nonzero approve, so a residue would
            // DoS every subsequent cook touching the venue. approve(0) is always allowed; on the
            // common exact-consume fill the allowance is already 0 and this is a no-op write. Metric
            // is the ONLY family whose exec can by design pull less than it approves (every other
            // QL exec is exact-consume), so only Metric needs the reset.
            token.approve(mcrtrA, 0);
          }
        }
      }
    }
  }
  }
  // LIQUIDCORE (Liquid Labs, HyperEVM) → CALLBACK-FREE (NO engine SwapPoolType). A LiquidCore pool
  // prices off the Hyperliquid BBO read precompile + its own inventory (adaptive imbalance fee),
  // NOT xy=k, so the engine's _swapV2 would mis-price it. Execute exactly as the LiquidCore taker
  // would, against the REAL pool surface (fork-proven permissionless + wei-exact same-block): PROBE
  // the live estimateSwap(tokenIn, tokenOut, Σ) for the out (a dead/drained venue at exec time
  // SKIPS SOFT — its share stays in this contract for the terminal refund, never a bricked cook),
  // APPROVE the POOL for the awarded input, then swap(tokenIn, tokenOut, Σ, minAmountOut) with
  // minAmountOut == the just-quoted out — the swap recomputes the SAME quote in-tx, so the pair
  // never trips (the adaptive fee makes quote == exec same-block ONLY, and this pairing IS
  // same-block). The pool pulls EXACTLY Σ via transferFrom (pull == approve ALWAYS — fork-proven
  // even on a capped-output oversize, so NO allowance-residue path exists; the residue==0 test
  // cells pin it) and pays the out to this contract. compute-then-pull already transferred `cum`
  // (incl. each LiquidCore share) above, so the approved pull draws from this contract's balance.
  if (HAS_LIQUIDCORE) {
  for (let lc = 0; lc < MS_CAP; lc = lc + 1) {
    const lcamt: Uint256 = lcinp[lc];
    if (lcamt > 0) {
      const lcpool: Address = lcven[lc];
      let lcOk: Uint256 = 1;
      ILiquidCorePool.at(lcpool).estimateSwap(tokenIn, tokenOut, lcamt).catch(() => { lcOk = 0; });
      if (lcOk === 1) {
        const lcOut: Uint256 = ILiquidCorePool.at(lcpool).estimateSwap(tokenIn, tokenOut, lcamt);
        if (lcOut > 0) {
          token.approve(lcpool, lcamt);
          ILiquidCorePool.at(lcpool).swap(tokenIn, tokenOut, lcamt, lcOut);
        }
      }
    }
  }
  }
  // INTEGRAL SIZE (TwapRelayer) → CALLBACK-FREE (NO engine SwapPoolType). The relayer sells from
  // ITS OWN inventory at the Uniswap-V3-TWAP price inside an OUT-amount [min, cap] window that
  // binds AT EXEC TOO (transferOut re-runs checkLimits in the VERIFIED source): PROBE the live
  // quoteSell(tokenIn, tokenOut, Σ) — a SUB-MIN AWARD (the merge can award a PARTIAL first slice
  // below the venue's minIn when the global budget exhausts mid-slice) reverts TR03 and SKIPS SOFT
  // (the share strands for the terminal refund — funds preserved, never a cook DoS; the
  // seed-floored ladder makes this the rare partial-slice edge), as does an over-cap TR3A or a
  // disabled-pair TR5A. Then APPROVE the RELAYER and sell({tokenIn, tokenOut, amountIn: Σ,
  // amountOutMin: quote, wrapUnwrap: false, to: self, submitDeadline: 2^32−1}) — `to` = this
  // contract (allowed: TR26 only bars tokenIn/tokenOut/0); msg.value 0 (TR58 — the relayer pays
  // its own hedge prepay from its ETH balance); the sell re-prices at the SAME in-tx TWAP state,
  // so received == the probe quote WEI-EXACT and amountOutMin never trips. The relayer pulls
  // EXACTLY Σ via transferFrom (pull == approve ALWAYS, fork-proven — no residue path; the
  // residue==0 test cells pin it). compute-then-pull already transferred `cum` above.
  if (HAS_SIZE) {
  for (let sz = 0; sz < MS_CAP; sz = sz + 1) {
    const szamt: Uint256 = szinp[sz];
    if (szamt > 0) {
      const szrel: Address = szven[sz];
      let szOk: Uint256 = 1;
      ISizeRelayer.at(szrel).quoteSell(tokenIn, tokenOut, szamt).catch(() => { szOk = 0; });
      if (szOk === 1) {
        const szOut: Uint256 = ISizeRelayer.at(szrel).quoteSell(tokenIn, tokenOut, szamt);
        if (szOut > 0) {
          token.approve(szrel, szamt);
          ISizeRelayer.at(szrel).sell({ tokenIn: tokenIn, tokenOut: tokenOut, amountIn: szamt, amountOutMin: szOut, wrapUnwrap: 0, to: address.self, submitDeadline: SZ_DEADLINE });
        }
      }
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
