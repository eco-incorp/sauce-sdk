/**
 * EcoSwapSVM continuous water-fill oracle — the closed-form CP marginal
 * equalization used ONLY to measure the quantized ladder's efficiency loss
 * (a report, never a gate; the exactness gate is solver-reference.ts).
 *
 * Every CP-class venue reduces to the fee-scaled constant-product form
 *   out(x) ≈ mu · (gamma·x · rOut) / (rIn + gamma·x)
 * (gamma = input-side fee retention, mu = output-side retention — the
 * adapters' continuousFees, ppm-scaled). Its post-fee marginal price is
 *   m(x) = mu·gamma·rIn·rOut / (rIn + gamma·x)²
 * and equalizing m across venues under Σx_i = A has the closed form
 *   x_i(λ) = (sqrt(mu_i·gamma_i·rIn_i·rOut_i / λ) − rIn_i) / gamma_i
 *   sqrt(1/λ) = (A + Σ rIn_i/gamma_i) / Σ sqrt(mu_i·gamma_i·rIn_i·rOut_i)/gamma_i
 * over the ACTIVE set (venues whose spot marginal clears the water level);
 * inactive venues are dropped iteratively (their x_i would go negative).
 *
 * The split solve runs in floating point (measurement precision is ample for
 * u64 magnitudes); the resulting slices are floored to lamports, topped up to
 * Σ = A on the deepest active venue, and the TOTAL is evaluated through the
 * EXACT integer quote closures — so the reported optimum is a realizable
 * integer allocation, not a real-analysis fiction.
 */

export interface ContinuousVenue {
  /** Effective input-side reserve (the adapters' depthReserves). */
  reserveIn: bigint;
  /** Effective output-side reserve. */
  reserveOut: bigint;
  /** Input-side fee retention, ppm (continuousFees.gammaPpm). */
  gammaPpm: bigint;
  /** Output-side fee retention, ppm (continuousFees.muPpm). */
  muPpm: bigint;
  /** Exact integer venue quote — evaluates the final slices. */
  quote: (x: bigint) => bigint;
}

export interface OptimalSplitResult {
  /** Continuous-optimal slices, floored to integers, summing to amountIn. */
  slices: bigint[];
  /** Σ quote(slice) through the exact integer venue math. */
  totalOut: bigint;
}

/** Continuous marginal-equalization split across the venues. */
export function solveOptimal(venues: readonly ContinuousVenue[], amountIn: bigint): OptimalSplitResult {
  if (venues.length === 0) throw new Error('solveOptimal needs at least one venue');
  if (amountIn <= 0n) throw new Error(`solveOptimal amountIn must be positive, got ${amountIn}`);

  const a = Number(amountIn);
  const parameters = venues.map((venue) => {
    const rIn = Number(venue.reserveIn);
    const rOut = Number(venue.reserveOut);
    const gamma = Number(venue.gammaPpm) / 1e6;
    const mu = Number(venue.muPpm) / 1e6;
    return { rIn, rOut, gamma, s: Math.sqrt(mu * gamma * rIn * rOut) / gamma, b: rIn / gamma };
  });

  // Iteratively drop venues whose water-level allocation is negative — at
  // most venues.length − 1 passes, each recomputing λ over the survivors.
  const active = new Set(parameters.map((_, i) => i));
  let shares: number[] = [];
  for (;;) {
    const sSum = [...active].reduce((sum, i) => sum + parameters[i].s, 0);
    const bSum = [...active].reduce((sum, i) => sum + parameters[i].b, 0);
    const sqrtInvLambda = (a + bSum) / sSum;
    shares = parameters.map((p, i) => (active.has(i) ? p.s * sqrtInvLambda - p.b : 0));
    const dropped = shares.findIndex((x, i) => active.has(i) && x < 0);
    if (dropped === -1 || active.size === 1) break;
    active.delete(dropped);
  }

  // Floor to integers, then top the rounding residue up on the largest slice
  // so Σ slices == amountIn exactly.
  const slices = shares.map((x) => (x > 0 ? BigInt(Math.floor(x)) : 0n));
  let assigned = slices.reduce((sum, x) => sum + x, 0n);
  if (assigned > amountIn) {
    // Floating-point overshoot: shave the largest slice.
    const largest = slices.indexOf(slices.reduce((m, x) => (x > m ? x : m), 0n));
    slices[largest] -= assigned - amountIn;
    assigned = amountIn;
  }
  if (assigned < amountIn) {
    const largest = slices.indexOf(slices.reduce((m, x) => (x > m ? x : m), 0n));
    slices[largest] += amountIn - assigned;
  }

  const totalOut = venues.reduce((sum, venue, i) => sum + venue.quote(slices[i]), 0n);
  return { slices, totalOut };
}

/**
 * Quantization efficiency loss of the ladder result vs the continuous
 * optimum, as a fraction of the optimal output (e.g. 0.001 = 0.1%). May be
 * slightly negative when integer rounding favors the quantized split.
 */
export function efficiencyLoss(optimalOut: bigint, quantizedOut: bigint): number {
  if (optimalOut <= 0n) throw new Error('efficiencyLoss needs a positive optimal output');
  return Number(optimalOut - quantizedOut) / Number(optimalOut);
}
