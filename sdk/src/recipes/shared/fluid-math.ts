/**
 * Fluid DEX (Instadapp fluid-contracts-public FluidDexT1 — a Liquidity-Layer-backed re-centering AMM) —
 * off-chain segment builder over a LIVE on-chain quote ladder.
 *
 * THE SINGLE SOURCE for how a Fluid DEX pool is turned into split segments. Imported by BOTH:
 *   - the production `prepare.ts` (buildFluidSegments), and
 *   - the neutral oracle `ecoswap.optimal.ts` (fluidSegments),
 * so the split is exact-on-grid vs the oracle by construction (one shared ladder → one segmentation).
 *
 * REAL ON-CHAIN SURFACE (VERIFIED, not fabricated). A Fluid DexT1 pool prices off the Liquidity-Layer
 * supply/borrow exchange prices + a re-centering center price + utilization/borrow caps — ALL canonical
 * on-chain state — so there is NO closed form to replay off-chain and NO getAmountOut view on the pool. The
 * verified surface is:
 *   FluidDexT1 pool:
 *     swapIn(bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_, address to_)
 *         payable returns (uint256 amountOut_)
 *       — pulls tokenIn via SafeTransfer.safeTransferFrom(msg.sender, LIQUIDITY, amountIn) (APPROVE-FIRST,
 *         like Fermi/Wombat/Curve — NOT transfer-first like WOOFi), sends amountOut to `to_`. When
 *         to_ == ADDRESS_DEAD (0x…dEaD) the pool `revert FluidDexSwapResult(amountOut_)` BEFORE touching
 *         the Liquidity layer — the protocol's own estimate hook.
 *     swapOut(bool, uint256 amountOut_, uint256 amountInMax_, address to_) payable returns (uint256 amountIn_)
 *   FluidDexReservesResolver (periphery, DexReservesResolver):
 *     getDexTokens(address dex_) view returns (address token0_, address token1_)
 *       — orients the pair. The DexT1 POOL has NO standalone token0()/token1() getters (token0/token1 are
 *         immutables exposed only inside constantsView()'s struct), so both discovery and the on-chain
 *         solver read getDexTokens off the resolver, never the pool.
 *     estimateSwapIn(address dex_, bool swap0to1_, uint256 amountIn_, uint256 amountOutMin_)
 *         payable returns (uint256 amountOut_)
 *       — implemented by `try IFluidDexT1(dex_).swapIn(swap0to1_, amountIn_, amountOutMin_, ADDRESS_DEAD)
 *         catch (bytes lowLevelData_) { amountOut_ = _decodeLowLevelUint1x(lowLevelData_,
 *         IFluidDexT1.FluidDexSwapResult.selector); }`. It reads the LIVE layer state + caps, so it is the
 *         canonical exact-in quote. This is a REVERT-WITH-DATA estimate wrapped by the resolver into a
 *         plain return value.
 * `swap0to1_` is a BOOL: true ⇒ token0→token1, false ⇒ token1→token0.
 *
 * WHY THE RECIPE QUOTES VIA THE RESOLVER, NOT THE POOL. The pool's own estimate is a REVERT
 * (FluidDexSwapResult), and SauceScript has no try/catch — a staticcall that reverts propagates. The
 * RESOLVER's `estimateSwapIn` does the try/catch in Solidity and returns a plain uint256, so the on-chain
 * solver staticcalls the RESOLVER for both the split ladder (prepare) and the per-slice exec quote (the
 * amountOutMin). Discovery samples that resolver view; buildFluidSegments differences the ladder into
 * descending-marginal slices with NO further RPC (so the oracle shares them).
 *
 * ON-CHAIN EXECUTION is CALLBACK-FREE (Fluid DexT1 re-enters ITS OWN Liquidity layer via operate(), never
 * the cooking contract — the non-callback swapIn pulls via safeTransferFrom, so it needs NO engine
 * dispatch): the solver re-reads the out for the awarded share LIVE via the resolver
 * `estimateSwapIn(dex, swap0to1, +share, 0)` (reading the live layer state, used as amountOutMin),
 * APPROVES the pool for the input (Fluid PULLS via transferFrom), then calls
 * `pool.swapIn(swap0to1, share, amountOutMin, self)`.
 *
 * WEI-EXACTNESS CLASS — SNAPSHOTTED-QUOTE (exogenous residual). The split is priced off the LIVE
 * `estimateSwapIn` ladder sampled at prepare time (a SNAPSHOT of the layer's exchange prices + center price
 * + caps), so:
 *   - the SPLIT is EXACT-ON-GRID-AT-SNAPSHOT — the oracle segments the SAME sampled ladder, so solver ==
 *     oracle bit-for-bit on that grid;
 *   - per-pool EXECUTION re-reads the out via the LIVE `estimateSwapIn` view and passes it as
 *     `amountOutMin`, so the realized out equals the live estimate for the awarded share and a bad fill is
 *     bounded by amountOutMin (per pool) + the whole-trade amountOutMin + the solver's guarded terminal
 *     refund.
 * The residual is MORE EXOGENOUS than a fee snapshot: the Liquidity-Layer supply/borrow exchange prices
 * accrue EVERY BLOCK and the utilization/borrow caps can shrink between prepare and cook. The split is
 * optimal at the snapshot; the exec stays exact-in-dy at the live layer state (proven by the state-moves
 * cell). The UTILIZATION/BORROW CAP is modeled like EulerSwap's inLimit: the sampler stops at the first
 * slice the resolver quotes 0 (past the tradeable cap), and the guarded terminal refund returns any
 * un-consumed input if the cap shrinks before cook.
 *
 * Sources (VERIFIED):
 *   https://github.com/Instadapp/fluid-contracts-public/blob/f8a93859822cbe7ca7b9bac076c5e81fe1fcadaf/contracts/protocols/dex/poolT1/coreModule/core/main.sol  (swapIn / FluidDexSwapResult / ADDRESS_DEAD estimate hook)
 *   https://github.com/Instadapp/fluid-contracts-public/blob/main/contracts/periphery/resolvers/dex/main.sol  (estimateSwapIn revert-decode)
 *   https://docs.fluid.instadapp.io/integrate/dex-swaps.html  (integration guide — swapIn + resolver estimate())
 *   FluidDexT1 0x6d83f60eEac0e50A1250760151E81Db2a278e03a (Etherscan verified)
 */

import { pushMonotoneSegment } from "./segment-merge.js";

/** 2^192 — the unified out/in sqrt fixed-point scale (matches the other *-math modules' Q192). */
export const Q192 = 1n << 192n;

/** Integer square root (Babylonian) — bit-identical to the other *-math modules' `isqrt`. */
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

/**
 * One discovered Fluid DEX pool (a FluidDexT1 pool + a direct tokenIn→tokenOut leg), oriented for the swap.
 * The DexT1 pool exposes NO closed-form curve state (it prices off the Liquidity layer), so this descriptor
 * carries a LIVE QUOTE LADDER sampled at discovery — cumulative (cumIn, cumOut) points from the resolver
 * `estimateSwapIn(dex, swap0to1, +cumIn, 0)`, ascending in cumIn. `buildFluidSegments` differences the
 * ladder into descending-marginal segments with NO further RPC (so the oracle shares them). All fields are
 * OFF-CHAIN ONLY (the split); the on-chain execution re-reads the exact out LIVE via the resolver.
 */
export interface FluidPool {
  /** DexT1 pool address — the swapIn / approve target AND the resolver `dex_` arg. */
  address: `0x${string}`;
  /** DexReservesResolver address — the estimateSwapIn target (staticcalled for the live quote). */
  resolver: `0x${string}`;
  /** true ⇒ tokenIn is the pool's token0 (swap0to1 = true); false ⇒ tokenIn is token1 (swap0to1 = false). */
  swap0to1: boolean;
  /** The pool's tokenIn (the from-token the swap call needs) == the EcoSwap tokenIn. */
  tokenIn: `0x${string}`;
  /** The pool's tokenOut (the to-token the swap call needs) == the EcoSwap tokenOut. */
  tokenOut: `0x${string}`;
  /** LIVE quote ladder: ascending cumulative input samples (native tokenIn decimals). */
  cumIn: bigint[];
  /** LIVE quote ladder: the `estimateSwapIn(dex, swap0to1, +cumIn[i], 0)` output for each cumIn[i]. */
  cumOut: bigint[];
  /**
   * Effective per-pool fee in ppm, DERIVED from the sampled ladder for price-ordering / diagnostics only
   * (the pool folds its fee into the resolver quote — there is no fee() getter on the surface path). 0
   * when unknown.
   */
  feePpm: number;
  /** Discovery source label. */
  source: string;
}

/** Fluid fee scale — feePpm is 1e6-scaled (0.01% = 100). */
export const FLUID_FEE_SCALE = 10n ** 6n;

/**
 * Default sample count per Fluid pool (M) — the number of `estimateSwapIn` eth_calls the discovery sampler
 * issues per pool. Tunable; M≈24 tightens the grid bound at the cost of M RPCs. Also the segment count cap.
 */
export const FLUID_SAMPLES = Number(process.env.ECO_FLUID_SAMPLES ?? 24);

/**
 * Geometric-ish cumulative sample inputs over [0, amountIn] (∝ s^2 — denser near 0 where the curve is
 * flattest). These are the ladder points prepare's discovery sampler feeds to `estimateSwapIn`; sharing
 * this grid keeps the oracle and prepare on the SAME cumIn points. Strictly ascending, ≤ amountIn.
 */
export function fluidSampleInputs(amountIn: bigint, samples: number = FLUID_SAMPLES): bigint[] {
  if (amountIn <= 0n) return [];
  const M = BigInt(samples);
  const inputs: bigint[] = [];
  let prev = 0n;
  for (let s = 1; s <= samples; s++) {
    const ss = BigInt(s);
    const input = (amountIn * ss * ss) / (M * M);
    if (input > prev) {
      inputs.push(input);
      prev = input;
    }
  }
  return inputs;
}

/**
 * getAmountOut(pool, dx) — the sampled out for cumulative input `dx` by LINEAR INTERPOLATION on the pool's
 * live quote ladder (the ladder is the only Fluid state we have off-chain — the DexT1 pool exposes no
 * closed form). Exact at a ladder point; interpolated between points. Returns 0 for dx<=0 or an empty
 * ladder. This is a diagnostic / segment-partition helper, NOT a wei-exact swap-math replay — the realized
 * out is the LIVE resolver `estimateSwapIn` at execution.
 */
export function getAmountOut(pool: FluidPool, dx: bigint): bigint {
  if (dx <= 0n) return 0n;
  const n = pool.cumIn.length;
  if (n === 0) return 0n;
  if (dx <= pool.cumIn[0]) {
    // Linear from origin to the first ladder point.
    return (pool.cumOut[0] * dx) / pool.cumIn[0];
  }
  for (let i = 1; i < n; i++) {
    if (dx <= pool.cumIn[i]) {
      const inLo = pool.cumIn[i - 1];
      const inHi = pool.cumIn[i];
      const outLo = pool.cumOut[i - 1];
      const outHi = pool.cumOut[i];
      const span = inHi - inLo;
      if (span <= 0n) return outHi;
      return outLo + ((outHi - outLo) * (dx - inLo)) / span;
    }
  }
  // Beyond the sampled range — clamp to the last (marginal flattens / the cap binds; the split never awards
  // past amountIn).
  return pool.cumOut[n - 1];
}

/**
 * One sampled Fluid segment in unified out/in price space — identical shape to a Curve / DODO / WOOFi /
 * Fermi segment (a flat [capacity, marginalOI] slice). `capacity` is the Δinput (tokenIn) for this slice,
 * `effOut` the Δoutput, and `marginalOI` the unified out/in sqrt = isqrt(effOut·2^192/capacity) — the
 * price-ordering coordinate. Segments are emitted DESCENDING in `marginalOI` (a re-centering AMM's price
 * worsens with size, so the first slice is best-priced).
 *
 * fee-adjust: marginalOI is computed from the ladder dy, which is the resolver's POST-FEE + POST-CAP quote
 * (the pool folds fee + utilization into the estimate), so it is ALREADY the fee-adjusted execution price
 * — it enters the merge's descending-price sort directly, exactly like Curve / DODO / WOOFi / Fermi /
 * Wombat / Solidly segments.
 */
export interface FluidSegment {
  /** Δinput (tokenIn) to traverse this slice. */
  capacity: bigint;
  /** Δoutput (tokenOut) over this slice. */
  effOut: bigint;
  /** Unified out/in marginal price for this slice = isqrt(effOut * 2^192 / capacity). */
  marginalOI: bigint;
}

/**
 * Build Fluid segments by DIFFERENCING the pool's pre-sampled live quote ladder (cumIn, cumOut) into
 * descending-marginal (capacity=Δin, effOut=Δout, marginalOI) slices. NO RPC (the ladder was sampled at
 * discovery) — a pure function over the descriptor, so prepare and the oracle produce identical segments
 * from the same ladder. `amountIn` caps the range (the ladder is already sampled over [0, amountIn]). A
 * non-descending slice (rounding noise, or past where the cap collapses the quote) is FOLDED into the
 * last segment (isotonic backward-merge — capacity + effOut conserved, blended marginal recomputed) so
 * the merge stays monotone price-ordered without discarding liquidity. Mirrors `buildFermiSegments` /
 * `buildWooFiSegments` (same isotonic backward-merge). See shared/segment-merge.ts.
 */
export function buildFluidSegments(
  pool: FluidPool,
  amountIn: bigint,
  _samples: number = FLUID_SAMPLES,
): FluidSegment[] {
  if (amountIn <= 0n) return [];
  const n = pool.cumIn.length;
  if (n === 0) return [];
  const segs: FluidSegment[] = [];
  let prevIn = 0n;
  let prevOut = 0n;
  for (let i = 0; i < n; i++) {
    const input = pool.cumIn[i] < amountIn ? pool.cumIn[i] : amountIn;
    if (input <= prevIn) continue;
    const out = getAmountOut(pool, input);
    if (out <= 0n) continue;
    const dIn = input - prevIn;
    const dOut = out - prevOut;
    if (dIn > 0n && dOut > 0n) {
      const marginalOI = isqrt((dOut * Q192) / dIn);
      // Isotonic backward-merge (liquidity-preserving) — a non-descending slice is FOLDED into the
      // last segment, not dropped, so no liquidity is discarded. See shared/segment-merge.ts.
      pushMonotoneSegment(segs, dIn, dOut, marginalOI);
    }
    prevIn = input;
    prevOut = out;
    if (pool.cumIn[i] >= amountIn) break;
  }
  return segs;
}
