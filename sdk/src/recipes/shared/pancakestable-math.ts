/**
 * PANCAKESWAP STABLESWAP (pancake-smart-contracts/projects/stable-swap — the BSC Solidity port of
 * the LEGACY Curve StableSwap 2-pool) — QUOTE-LADDER (QL) model over each pool's LIVE
 * `get_dy(uint256,uint256,uint256)` view.
 *
 * THE SINGLE SOURCE for how a PancakeStableSwap venue is modeled off-chain. PancakeStableSwap is a
 * QUOTE-LADDER family (segKind 20): prepare ships ONLY a descriptor (pool, uint256 coin indices
 * i/j, fee) — NO sampled segments — and the on-chain solver builds each venue's price ladder in
 * setup from LIVE cook-time `get_dy(i, j, xNext)` quote-differencing (the SAME curve-agnostic
 * `buildQLLadder` recurrence every other QL family runs). The neutral oracle (ecoswap.optimal.ts)
 * mirrors it via `buildPancakeStableQLLadder` below, driven by a caller-supplied `getDy` quote
 * model — locally the BIT-EXACT `pancakeStableGetDy` replay (curve-math.ts `getDy` at
 * A_PRECISION = 1, the legacy variant this Solidity port compiles), against real state in the
 * prod-mirror — so solver == oracle by construction: one recurrence, one grid.
 *
 * REAL ON-CHAIN SURFACE (probed live on BSC chainId 56, 2026-07-04, factory
 * 0x25a55f9f2279A54951133D503490342b50E5cd15 — pairLength()=31; VERIFIED source in
 * pancakeswap/pancake-smart-contracts):
 *
 *   Factory:
 *     getPairInfo(address tokenA, address tokenB) view returns
 *       (address swapContract, address token0, address token1, address LPContract)
 *       — ORDER-INDEPENDENT (sortTokens internally; probed both orders → same struct). token0/
 *       token1 are the SORTED pair == the pool's coins(0)/coins(1) (createSwapPair deploys with
 *       sorted tokens), so the descriptor's i/j fall straight out: i = (tokenIn == token0 ? 0 : 1).
 *       A NON-EXISTENT pair returns the ZERO struct (probed — no revert), so discovery just gates
 *       on swapContract != 0. getThreePoolPairInfo(tokenA, tokenB) returned the zero struct for
 *       every probed stable pair (NO 3-pools registered) — the 2-pool surface is the whole factory.
 *     pairLength() / swapPairContract(uint256) — enumeration (diagnostics; discovery is pair-keyed).
 *
 *   Pool (e.g. USDT/USDC 0x3EFebC418efB585248A0D2140cfb87afcc2c63dd — bal ≈ 162.9k USDT + 91.2k
 *   USDC, A=1000, fee=1e6 (0.01% of 1e10); the deepest probed pools: USDT/BUSD ≈ $1.96M combined,
 *   lisUSD/USDT ≈ $13.8M):
 *     get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)
 *       — UINT256 coin indices (the int128 get_dy REVERTED on probe ⇒ the engine `_swapCurve`
 *       int128 dispatch does NOT fit; execution is CALLBACK-FREE, the CryptoSwap segKind-9 class).
 *       Post-fee. GRACEFUL on zero (0→0) and on OVERSIZE (1e30 in → asymptotically the whole out
 *       balance — the A-invariant saturates, no revert; the non-descending-head guard truncates the
 *       ladder where the marginal collapses). REVERT-class on an EMPTY pool (balances 0,0 ⇒ get_D's
 *       `D_P·D/(xp[k]·N)` divides by zero — probed on 6 drained pools) and when `is_killed` — so
 *       the per-slice quote is PROBE-THEN-DECODE (a dead venue self-drops, never a cook DoS).
 *     exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) — pulls EXACTLY dx via
 *       `safeTransferFrom(msg.sender, this, dx)` (VERIFIED source) and transfers the post-fee dy
 *       out to msg.sender ⇒ approve-first, pull == approve ALWAYS (residue == 0 by construction —
 *       the residue==0 test cells pin it). NO return value (unlike CryptoSwap — the family ships
 *       its own IPancakeStablePool ABI). The newer TwoPool variant is `payable` with a
 *       `msg.value == 0` guard for non-BNB pools; the recipe sends no value, so both variants land.
 *     coins(uint256) / balances(uint256) / A() / fee() — the invariant state. A() is RAW
 *       (A_PRECISION = 1: `Ann = A·N_COINS`, `D/(Ann)` — the LEGACY Curve variant, verified in
 *       source get_D/get_y); fee() is 1e10-scaled (FEE_DENOMINATOR = 1e10 ⇒ ppm = fee/1e4).
 *       RATES[k] = 1e18·10^(18−decimals[k]) normalizes decimals inside get_dy (PRECISION_MUL).
 *
 * WEI-EXACTNESS CLASS — LIVE-WALK (the strongest): the ladder is built from LIVE cook-time get_dy
 * (no prepare-time snapshot survives into the split), so the split re-anchors to any drift between
 * prepare and cook, like every other QL family.
 *
 * PER-PAIR INVENTORY (the claims shape): each pool holds its OWN two-coin inventory (one pool per
 * sorted pair via getPairInfo), so the claim key is the POOL ADDRESS — the qlVenueClaimKey default
 * (the Metric/LiquidCore class, NOT the Tessera/Elfomo single-wrapper class).
 *
 * RESIDUAL RISK — the is_killed quote/exec split (documented, accepted): `is_killed` gates
 * `exchange` but NOT `get_dy`, so a pool killed between the ladder quote and the exec would revert
 * the cook (the exec's get_dy min-probe still answers). The window is STRUCTURALLY closed for
 * every live pool: `kill_me()` requires `kill_deadline > block.timestamp` with kill_deadline =
 * initialize-time + 60 days (VERIFIED source) — a pool older than 60 days can NEVER be killed
 * (unkill_me exists, kill_me is one-way expired). Only a sub-60-day-old pool carries the race, and
 * the owner-only kill inside one cook's lifetime is not a griefing surface worth an exec-side
 * catch that no other family's swap call carries.
 */

import type { Hex } from "viem";
import { buildQLLadder, getY } from "./curve-math.js";
import type { MergeSegment } from "./segment-merge.js";

/** Pancake StableSwap fee scale — pool `fee()` is 1e10-scaled (FEE_DENOMINATOR = 1e10), like Curve. */
export const PANCAKE_STABLE_FEE_DENOMINATOR = 10_000_000_000n;

/**
 * The LEGACY A precision this Solidity port compiles: `Ann = A·N_COINS` and `D/Ann` directly —
 * NO A_PRECISION multiply (verified in the pool source get_D/get_y). The curve-math replay takes
 * it as `aPrecision: 1n`.
 */
export const PANCAKE_STABLE_A_PRECISION = 1n;

/**
 * One PancakeStableSwap venue DESCRIPTOR (a per-pair 2-coin pool, oriented for the swap). This is
 * ALL prepare ships (the QL family contract: descriptor-only, zero sampled values) — the on-chain
 * solver builds the ladder LIVE from get_dy at cook and executes approve-POOL +
 * exchange(uint256 i, uint256 j, Σ, min_dy).
 */
export interface PancakeStableVenue {
  /** Pool address — the get_dy/exchange/approve target + the claim key. */
  address: Hex;
  /** The factory that resolved this pool (getPairInfo) — diagnostics only. */
  factory: Hex;
  /** uint256 coin index of tokenIn (0 iff tokenIn == the factory-sorted token0 == coins(0)). */
  i: number;
  /** uint256 coin index of tokenOut (the 2-coin complement, 1 − i). */
  j: number;
  /** The venue's tokenIn (the edge from-token; diagnostics — the quote keys on i/j). */
  tokenIn: Hex;
  /** The venue's tokenOut (the edge to-token; diagnostics). */
  tokenOut: Hex;
  /** Rounded ppm swap fee (pool fee()/1e4 — price-ordering diagnostics; the quote is post-fee). */
  feePpm: number;
  /** Discovery source label. */
  source: string;
}

/**
 * The ORACLE/REFERENCE model of one PancakeStableSwap venue: the descriptor plus a `getDy` QUOTE
 * model — the cumulative out `pool.get_dy(i, j, dx)` returns for total input `dx`. The pool source
 * is VERIFIED, so the canonical model is the closed-form `pancakeStableGetDy` replay over read
 * state (bit-exact at ANY input — no grid prefetch needed); the callback shape (the LiquidCore
 * class) keeps the fixture tests and the prod-mirror on one type. `getDy` must return 0 where the
 * real view reverts (an empty/killed pool) — the ladder then self-truncates in lockstep with the
 * on-chain probe-then-decode build.
 */
export interface PancakeStablePool extends PancakeStableVenue {
  /** Cumulative quote model: out for TOTAL input dx (post-fee; 0 ⇒ not fillable). */
  getDy: (dx: bigint) => bigint;
}

/** The live invariant state a `pancakeStableGetDy` replay runs on (all read off the pool). */
export interface PancakeStableState {
  /** Raw A() (LEGACY precision — the replay multiplies by nothing; aPrecision = 1). */
  A: bigint;
  /** Pool fee() — 1e10-scaled. */
  fee: bigint;
  /** Native-order coin balances [balances(0), balances(1)]. */
  balances: bigint[];
  /** rates[k] = 1e18 · 10^(18 − decimals[k]) (the pool's RATES — PRECISION_MUL·PRECISION). */
  rates: bigint[];
}

const PRECISION = 10n ** 18n;

/**
 * The two dy ROUNDING FORMS in the VERIFIED Pancake source — they differ on MIXED-DECIMAL pools:
 *
 *   VIEW (`get_dy`):      dyRaw = xp[j]−y−1;  dy_g = floor(dyRaw·P/R[j]);
 *                         return dy_g − floor(fee·dy_g/FEE)                 (SCALE, then fee)
 *   EXCHANGE (`exchange`): dyRaw = xp[j]−y−1;  dyFee = floor(fee·dyRaw/FEE);
 *                         dy_e = floor((dyRaw − dyFee)·P/R[j])              (fee, then SCALE)
 *
 * For an 18-decimal pair (RATES = 1e18, PRECISION_MUL = 1 — every deep live BSC pool) the forms
 * are IDENTICAL. For PRECISION_MUL > 1 the realized exchange dy can land ONE WEI BELOW the view
 * (dy_e >= dy_g − 1, PROVEN: with a = floor(dyRaw/m), dy_e >= floor((1−f)·a) = a − ceil(f·a) >=
 * dy_g − 1), so the exec arm passes `min_dy = get_dy(Σ) − 1` — atomically un-trippable on ANY
 * pool — instead of the raw view quote (which would revert the whole cook on a mixed-decimal
 * pool). The LADDER/oracle model is the VIEW form (`pancakeStableGetDy` — what the solver quotes
 * on-chain); the realized-output model is the EXCHANGE form (`pancakeStableExchangeDy` — what the
 * caller receives, asserted by the tests).
 */
function pancakeStableDyRaw(
  state: PancakeStableState,
  i: number,
  j: number,
  dx: bigint,
): bigint {
  const xp = state.balances.map((b, k) => (b * state.rates[k]) / PRECISION);
  const x = xp[i] + (dx * state.rates[i]) / PRECISION;
  // amp = A·aPrecision = A·1 (the legacy variant this Solidity port compiles).
  const y = getY(i, j, x, xp, state.A * PANCAKE_STABLE_A_PRECISION, PANCAKE_STABLE_A_PRECISION);
  if (xp[j] <= y + 1n) return 0n;
  return xp[j] - y - 1n; // the −1 round-in-pool-favor (both source forms share it)
}

/**
 * BIT-EXACT replay of the Pancake StableSwap `get_dy(i, j, dx)` VIEW (the on-chain ladder quote):
 * the canonical Curve get_D/get_y Newton (curve-math.ts, 255 iterations, ±1 convergence) at
 * `aPrecision = 1` (the legacy `Ann = A·N` variant — verified in source), RATES scaling, then the
 * view's SCALE-then-fee rounding. Returns 0 for a non-positive dx or an empty pool (where the
 * real view REVERTS — get_D divides by a zero xp; probe-then-decode lockstep).
 */
export function pancakeStableGetDy(
  state: PancakeStableState,
  i: number,
  j: number,
  dx: bigint,
): bigint {
  if (dx <= 0n) return 0n;
  // The REAL get_dy REVERTS on an empty pool (get_D divides by a zero xp) — model it as 0.
  if (state.balances.some((b) => b <= 0n)) return 0n;
  const dyRaw = pancakeStableDyRaw(state, i, j, dx);
  if (dyRaw <= 0n) return 0n;
  const dyScaled = (dyRaw * PRECISION) / state.rates[j];
  const feeAmt = (state.fee * dyScaled) / PANCAKE_STABLE_FEE_DENOMINATOR;
  return dyScaled - feeAmt;
}

/**
 * BIT-EXACT replay of the dy `exchange(i, j, dx, min_dy)` actually PAYS OUT (the fee-then-SCALE
 * rounding — see the form note above). == `pancakeStableGetDy` on any 18-decimal pair; can differ
 * by ±1 wei on a mixed-decimal pool (never more than 1 BELOW the view — proven bound). The tests
 * assert the caller-received amount against THIS form.
 */
export function pancakeStableExchangeDy(
  state: PancakeStableState,
  i: number,
  j: number,
  dx: bigint,
): bigint {
  if (dx <= 0n) return 0n;
  if (state.balances.some((b) => b <= 0n)) return 0n;
  const dyRaw = pancakeStableDyRaw(state, i, j, dx);
  if (dyRaw <= 0n) return 0n;
  const dyFee = (dyRaw * state.fee) / PANCAKE_STABLE_FEE_DENOMINATOR;
  return ((dyRaw - dyFee) * PRECISION) / state.rates[j];
}

/**
 * Build one PancakeStableSwap venue's QUOTE-LADDER — the SHARED curve-agnostic `buildQLLadder`
 * recurrence (curve-math.ts) driven by the venue's `getDy` quote model, so the oracle stays
 * wei-exact with the on-chain solver by construction. The solver builds the IDENTICAL geometric
 * ladder live from `get_dy(i, j, xNext)` (PROBE-THEN-DECODE — an empty/killed pool reverts ⇒ q = 0
 * ⇒ the ladder self-truncates; zero/oversize quote gracefully). The quote is post-fee, so
 * marginalOI IS the execution price. Emits the same {capacity, effOut, marginalOI} slices the
 * merged sampled-segment stream consumes.
 */
export function buildPancakeStableQLLadder(
  pool: PancakeStablePool,
  amountIn: bigint,
): MergeSegment[] {
  return buildQLLadder((dx) => pool.getDy(dx), amountIn);
}
