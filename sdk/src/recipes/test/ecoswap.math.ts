/**
 * Pure-bigint math helpers used by the EcoSwap unit tests and reference oracle.
 *
 * These are FAITHFUL COPIES of the (non-exported) helpers in
 * `recipes/ecoswap/prepare.ts`. They are duplicated here only so the
 * tests can exercise them directly without modifying prepare.ts. Any change to
 * the prepare.ts originals must be mirrored here. The integer operations and
 * truncation order are preserved EXACTLY so this module is a trustworthy oracle.
 */

export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;
export const FEE_DENOM = 1_000_000n; // ppm

/** Integer square root (Babylonian). Mirrors prepare.ts `isqrt`. */
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

/** (a*b)/c with bigint truncation — matches Solidity/Sauce Math.mulDiv semantics. */
export function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  return (a * b) / c;
}

/** sqrt(1 - fee) scaled by 1e6, i.e. round(sqrt((1e6 - feePpm)/1e6) * 1e6). */
export function sqrtOneMinusFeeScaled(feePpm: number): bigint {
  return isqrt(BigInt(1_000_000 - feePpm) * FEE_DENOM);
}

/** Apply the fee-adjustment to a spot out/in sqrt price. */
export function feeAdjust(sqrtSpot: bigint, feePpm: number): bigint {
  return (sqrtSpot * sqrtOneMinusFeeScaled(feePpm)) / FEE_DENOM;
}

/**
 * Gross input (tokenIn units incl. fee) to traverse a bracket [sqrtFar, sqrtNear]
 * of constant liquidity L, in unified out/in space:
 *   effIn = L * 2^96 * (1/sqrtFar - 1/sqrtNear);  grossIn = effIn / (1 - fee)
 */
export function bracketCapacity(L: bigint, sqrtNear: bigint, sqrtFar: bigint, feePpm: number): bigint {
  if (L <= 0n || sqrtFar <= 0n || sqrtNear <= sqrtFar) return 0n;
  const effIn = (L * Q96) / sqrtFar - (L * Q96) / sqrtNear;
  if (effIn <= 0n) return 0n;
  return (effIn * FEE_DENOM) / BigInt(1_000_000 - feePpm);
}

/** Exact Uniswap V3 TickMath.getSqrtRatioAtTick (real token1/token0 sqrt, Q96). */
export function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = BigInt(tick < 0 ? -tick : tick);
  let ratio =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  const mul = (m: bigint) => {
    ratio = (ratio * m) >> 128n;
  };
  if (absTick & 0x2n) mul(0xfff97272373d413259a46990580e213an);
  if (absTick & 0x4n) mul(0xfff2e50f5f656932ef12357cf3c7fdccn);
  if (absTick & 0x8n) mul(0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if (absTick & 0x10n) mul(0xffcb9843d60f6159c9db58835c926644n);
  if (absTick & 0x20n) mul(0xff973b41fa98c081472e6896dfb254c0n);
  if (absTick & 0x40n) mul(0xff2ea16466c96a3843ec78b326b52861n);
  if (absTick & 0x80n) mul(0xfe5dee046a99a2a811c461f1969c3053n);
  if (absTick & 0x100n) mul(0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if (absTick & 0x200n) mul(0xf987a7253ac413176f2b074cf7815e54n);
  if (absTick & 0x400n) mul(0xf3392b0822b70005940c7a398e4b70f3n);
  if (absTick & 0x800n) mul(0xe7159475a2c29b7443b29c7fa6e889d9n);
  if (absTick & 0x1000n) mul(0xd097f3bdfd2022b8845ad8f792aa5825n);
  if (absTick & 0x2000n) mul(0xa9f746462d870fdf8a65dc1f90e061e5n);
  if (absTick & 0x4000n) mul(0x70d869a156d2a1b890bb3df62baf32f7n);
  if (absTick & 0x8000n) mul(0x31be135f97d08fd981231505542fcfa6n);
  if (absTick & 0x10000n) mul(0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if (absTick & 0x20000n) mul(0x5d6af8dedb81196699c329225ee604n);
  if (absTick & 0x40000n) mul(0x2216e584f5fa1ea926041bedfe98n);
  if (absTick & 0x80000n) mul(0x48a170391f7dc42444e8fa2n);
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  // sqrtPriceX96 = ratio >> 32, rounding up
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Convert a real pool sqrt (token1/token0) into unified out/in sqrt. */
export function toOutIn(sqrtReal: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? sqrtReal : Q192 / sqrtReal;
}

// ── Adaptive (WS4) streaming-walk helpers ────────────────────
// Faithful copies of the lens helpers (ecoswap.lens.sauce.ts) + constants, shared
// by the on-chain solver port and the oracle so both walk the frontier identically.

/** Tick shift (multiple of LCM(spacings)=3000, > max|tick| 887272 so shifted stays ≥0). */
export const OFFSET = 888000n;
/**
 * V2 constant-L geometric step (out/in space): far = near - near*V2_STEP_BPS/V2_STEP_DEN.
 * MUST equal prepare.ts's buildV2Brackets step (V2_SQRT_STEP_BPS=25/10000) AND the
 * solver's V2_STEP_BPS/V2_STEP_DEN bit-for-bit so the V2 forward-walk mirror is exact.
 */
export const V2_STEP_BPS = 25n;
export const V2_STEP_DEN = 10000n;
/** int128 sign bit. */
export const HALF128 = 1n << 127n;
/** int128 modulus. */
export const MOD128 = 1n << 128n;

/** int24 STATICCALL arg (signed tick) from a shifted tick. Mirrors lens `tickArg`. */
export function tickArg(shifted: bigint): bigint {
  return shifted >= OFFSET ? shifted - OFFSET : -(OFFSET - shifted);
}

/**
 * Next REAL sqrt one tickSpacing step in the swap direction (multiplicative).
 * Mirrors lens `stepReal` EXACTLY (NOT getSqrtRatioAtTick) so the oracle matches
 * the on-chain walk bit-for-bit as multiplicative drift accrues over many steps.
 *   zeroForOne (price down): sqrt' = mulDiv(sqrt, 2^96, stepRatio)
 *   oneForZero (price up):   sqrt' = mulDiv(sqrt, stepRatio, 2^96)
 */
export function stepReal(sqrtReal: bigint, stepRatio: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? mulDiv(sqrtReal, Q96, stepRatio) : mulDiv(sqrtReal, stepRatio, Q96);
}

/** One V2 constant-L geometric slice's gross input, in the solver's exact integer math.
 *  effIn = L*Q96/far - L*Q96/near (telescopes across a contiguous chain), grossed up by
 *  FEE_DENOM/(FEE_DENOM-feePpm). Mirrors ecoswap.sauce.ts's V2 forward branch and the
 *  oracle's V2 stream mirror bit-for-bit (per-slice mulDiv, so per-slice gross-up rounds
 *  independently — NOT one big mulDiv). */
export function v2SliceGross(L: bigint, near: bigint, far: bigint, feePpm: bigint): bigint {
  const effIn = mulDiv(L, Q96, far) - mulDiv(L, Q96, near);
  return mulDiv(effIn, FEE_DENOM, FEE_DENOM - feePpm);
}

/**
 * Analytic replay of the V2 constant-L forward walk (window brackets + WS2 #104 stream)
 * the oracle/solver performs: starting at out/in `spotNear`, take geometric slices
 * (`far = near - near*V2_STEP_BPS/V2_STEP_DEN`) at constant L, summing per-slice gross,
 * stopping when the running gross would cover `amountIn` (taking the exact remainder) or
 * after `maxSlices` (a >0 capacity floor). Returns the total gross spent and the running
 * out/in price reached. This is the KNOWN-ANSWER the V2-stream vector asserts against,
 * exact to the wei (same per-slice integer math as the oracle). With no `amountIn` cap
 * it sums the full `maxSlices` window+stream; the underlying effIn telescopes to one
 * L*Q96/farFinal - L*Q96/spotNear (interior boundaries cancel) — the constant-product
 * integral identity that justifies why the stream is path-additive past the window.
 */
export function v2WalkGross(
  L: bigint,
  spotNear: bigint,
  feePpm: bigint,
  maxSlices: number,
  amountIn?: bigint,
): { gross: bigint; near: bigint; slices: number } {
  let near = spotNear;
  let gross = 0n;
  let slices = 0;
  for (let i = 0; i < maxSlices; i++) {
    const far = near - mulDiv(near, V2_STEP_BPS, V2_STEP_DEN);
    if (far <= 0n || far >= near) break;
    const sliceGross = v2SliceGross(L, near, far, feePpm);
    if (sliceGross > 0n) {
      if (amountIn !== undefined && gross + sliceGross >= amountIn) {
        gross = amountIn; // take the exact remainder; the slice is partially consumed
        slices++;
        near = far;
        return { gross, near, slices };
      }
      gross += sliceGross;
    }
    slices++;
    near = far;
  }
  return { gross, near, slices };
}
