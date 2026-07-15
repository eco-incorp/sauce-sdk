/**
 * Shared stable-curve Newton helpers for the LADDER (adapter v2) families —
 * saber-stableswap and meteora-damm-v1-stable declare these through their
 * `helpers()` and the EcoSwapSVM codegen dedupes them by name.
 *
 * stableD is byte-identical math to the solswap generator's helper (ann =
 * amp·2 inside, ≤ 256 iterations, converged when successive estimates differ
 * by ≤ 1, floor division; Math.mulDiv carries the d³-scale products). The
 * `break`-less sentinel-loop convention is the repo's compiler-surface rule:
 * `diff` starts at 2 (> 1, guaranteeing the first pass) and the convergence
 * check rides in the loop condition.
 *
 * stableYW is the warm-startable Newton y: identical to the venues' own
 * compute_y EXCEPT the iteration starts from a caller-provided y0 instead of
 * the hardcoded d. Passing y0 = d IS the venue's cold iteration, so the
 * FINAL (predicted-output) quote always calls it with y0 = d — venue-exact
 * by construction. Ladder rungs pass the previous rung's y: the fixed point
 * is approached from above either way (larger cumulative input ⇒ smaller y,
 * so y_prev ≥ y*), which cuts the Newton iterations to ~1-2 per rung — the
 * difference between a stable slot fitting the CU budget or not (see
 * recipes/ecoswap/svm/budget.ts). The warm-vs-cold oracle unit asserts the
 * chain reproduces the cold values on the fixture universe; even where an
 * exotic pool might wobble a rung by a lamport, both sides of the
 * lamport-exact gate (fragment and TS mirror) compute the SAME chain, so
 * exactness is unconditional — only rung-election quality could shift, never
 * the venue-exact final quotes.
 */

export interface SvmHelperFn {
  name: string;
  source: string;
}

export const STABLE_D_HELPER: SvmHelperFn = {
  name: 'stableD',
  source: [
    'function stableD(amp, xa, xb) {',
    '  const s = xa + xb;',
    '  if (s === 0) { return 0 }',
    '  const ann = amp * 2;',
    '  let d = s;',
    '  let diff = 2;',
    '  for (let r = 0; r < 256 && diff > 1; r++) {',
    '    let dp = Math.mulDiv(d, d, xa * 2);',
    '    dp = Math.mulDiv(dp, d, xb * 2);',
    '    const prev = d;',
    '    d = Math.mulDiv(d, dp * 2 + s * ann, d * (ann - 1) + dp * 3);',
    '    diff = d - prev;',
    '    if (prev > d) { diff = prev - d }',
    '  }',
    '  return d;',
    '}',
  ].join('\n'),
};

export const STABLE_YW_HELPER: SvmHelperFn = {
  name: 'stableYW',
  source: [
    'function stableYW(amp, x, d, y0) {',
    '  const ann = amp * 2;',
    '  const c = Math.mulDiv(Math.mulDiv(d, d, x * 2), d, ann * 2);',
    '  const b = d / ann + x;',
    '  let y = y0;',
    '  let diff = 2;',
    '  for (let r = 0; r < 256 && diff > 1; r++) {',
    '    const prev = y;',
    '    y = (y * y + c) / (2 * y + b - d);',
    '    diff = y - prev;',
    '    if (prev > y) { diff = prev - y }',
    '  }',
    '  return y;',
    '}',
  ].join('\n'),
};

/** TS mirror of stableD — Newton invariant, floor division, ≤ 256 rounds, |Δ| ≤ 1 convergence. */
export function stableComputeD(amp: bigint, xa: bigint, xb: bigint): bigint {
  const s = xa + xb;
  if (s === 0n) return 0n;
  const ann = amp * 2n;
  let d = s;
  for (let round = 0; round < 256; round++) {
    let dp = (d * d) / (xa * 2n);
    dp = (dp * d) / (xb * 2n);
    const prev = d;
    d = (d * (dp * 2n + s * ann)) / (d * (ann - 1n) + dp * 3n);
    const diff = d > prev ? d - prev : prev - d;
    if (diff <= 1n) break;
  }
  return d;
}

/** TS mirror of stableYW — Newton y from y0 (y0 = d is the venues' cold compute_y). */
export function stableComputeYWarm(amp: bigint, x: bigint, d: bigint, y0: bigint): bigint {
  const ann = amp * 2n;
  const c = (((d * d) / (x * 2n)) * d) / (ann * 2n);
  const b = d / ann + x;
  let y = y0;
  for (let round = 0; round < 256; round++) {
    const prev = y;
    y = (y * y + c) / (2n * y + b - d);
    const diff = y > prev ? y - prev : prev - y;
    if (diff <= 1n) break;
  }
  return y;
}
