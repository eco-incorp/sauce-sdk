/**
 * EcoSwapSVM solver reference — the TS mirror of the QUANTIZED on-chain
 * solver (codegen.ts), transcribed bit-for-bit: the same geometric grid, the
 * same rung construction, the same k-way cheapest-rung-first merge with the
 * same candidate scan order, cross-multiplied price compare, clamp and
 * pointer advance, in the same integer ops and truncation order. This is THE
 * lamport-exact gate target for the engine-executed bytecode AND the
 * user-facing quote (quoteEcoSwapSvm evaluates it over fetched account
 * bytes — no simulation, no chain-side execution).
 *
 * The only inputs are per-slot exact quote closures (the ladder adapters'
 * referenceQuote over the SAME live account bytes the fragment reads), the
 * per-slot RUNG COUNTS (fixed per SHAPE at codegen time by the CU budgeter —
 * see budget.ts; the mirror never reads GasLeft, so rung counts being a pure
 * function of (shape, args) is what keeps this gate deterministic), and the
 * trade amount — so the mirror is family-agnostic; venue math lives in one
 * place per family (the adapter) on each side of the mirror.
 *
 * Stable-curve slots quote their ladder through a WARM-START CHAIN
 * (`ladderQuotes`: each rung's Newton-y starts from the previous rung's
 * result — the adapter's referenceLadderQuotes, mirroring the fragment's
 * threaded locals), while the final predicted output is always the COLD
 * `quote` closure — identical to the venue program's own from-scratch
 * iteration.
 *
 * Every quote closure is nondecreasing in x with quote(0) == 0 (the adapter
 * contract), so rung dOut values are non-negative and all products stay far
 * below 2^256 for u64 amounts — plain bigint arithmetic matches the engine's
 * wrapping ops exactly on this domain.
 */

/** Default rungs per slot ladder (CP families; stable slots default to 2 — see budget.ts). */
export const QL_S = 4;
/** Structural rung bounds a slot may carry (the budgeter degrades within them). */
export const MIN_RUNGS = 2;
export const MAX_RUNGS = 4;

export interface LadderRung {
  /** Gross-input capacity of this rung (may be 0 for dust grid points). */
  dIn: bigint;
  /** Venue output produced across the rung — the merge price is dOut/dIn. */
  dOut: bigint;
}

export interface SolverSlotInput {
  /** Exact COLD integer venue quote for gross input x over the live account bytes. */
  quote: (x: bigint) => bigint;
  /**
   * Warm-start chain over the ORDERED cumulative grid (stable slots). Absent
   * = pointwise `quote` (CP slots, where chain == pointwise by construction).
   */
  ladderQuotes?: (grid: readonly bigint[]) => bigint[];
  /** Ladder rungs for this slot (default QL_S) — must match the compiled shape. */
  rungs?: number;
  /** Disabled slots are born exhausted (never quoted, never filled). */
  enabled?: boolean;
}

export interface SolverReferenceResult {
  /** Per-slot gross-input slices; sums to amountIn exactly. */
  slices: bigint[];
  /** Per-slot predicted outputs: quote(slice). */
  predictedOuts: bigint[];
  /** Sum of predicted outputs — what the pre-CPI minOut check sees. */
  totalPredicted: bigint;
}

/** The cumulative geometric grid: G_j = amountIn >> (rungs − j), j = 1..rungs. */
export function ladderGrid(amountIn: bigint, rungs: number = QL_S): bigint[] {
  const grid: bigint[] = [];
  for (let j = 1; j <= rungs; j++) grid.push(amountIn >> BigInt(rungs - j));
  return grid;
}

/**
 * The per-slot geometric ladder: cumulative grid points G_j = amountIn >>
 * (rungs − j) for j = 1..rungs (so G_rungs == amountIn — one slot can always
 * absorb the whole trade), rung j spanning (G_{j−1}, G_j] with dOut =
 * quote(G_j) − quote(G_{j−1}). Fine rungs near zero, coarse near the full
 * amount: the merge's partial-fill of the marginal rung recovers exact
 * resolution at the cut for the slot that binds there.
 */
export function buildLadder(
  quote: (x: bigint) => bigint,
  amountIn: bigint,
  rungs: number = QL_S,
  ladderQuotes?: (grid: readonly bigint[]) => bigint[],
): LadderRung[] {
  const grid = ladderGrid(amountIn, rungs);
  const outs = ladderQuotes === undefined ? grid.map(quote) : ladderQuotes(grid);
  if (outs.length !== grid.length) {
    throw new Error(`buildLadder chain returned ${outs.length} quotes for ${grid.length} grid points`);
  }
  const result: LadderRung[] = [];
  let gPrev = 0n;
  let oPrev = 0n;
  grid.forEach((g, i) => {
    result.push({ dIn: g - gPrev, dOut: outs[i] - oPrev });
    gPrev = g;
    oPrev = outs[i];
  });
  return result;
}

function slotRungs(slot: SolverSlotInput): number {
  const rungs = slot.rungs ?? QL_S;
  if (!Number.isInteger(rungs) || rungs < MIN_RUNGS || rungs > MAX_RUNGS) {
    throw new Error(`solver slot rungs must be an integer in ${MIN_RUNGS}..${MAX_RUNGS}, got ${rungs}`);
  }
  return rungs;
}

/**
 * The quantized water-fill: greedy cheapest-rung-first k-way merge over the
 * per-slot ladders. Each step elects the best next rung by average execution
 * price (cross-multiplied, integer-exact: dOut_c·dIn_b > dOut_b·dIn_c;
 * ties keep the earliest-scanned slot, so slot order encodes preference),
 * consumes it up to the remaining amount, and advances only that slot's
 * pointer. Transcribes the generated bytecode's merge loop 1:1 — do not
 * "optimize" either side independently.
 */
export function solveReference(slots: readonly SolverSlotInput[], amountIn: bigint): SolverReferenceResult {
  const k = slots.length;
  if (k === 0) throw new Error('solveReference needs at least one slot');
  if (amountIn <= 0n) throw new Error(`solveReference amountIn must be positive, got ${amountIn}`);

  const rungs = slots.map(slotRungs);
  const base: number[] = [];
  let total = 0;
  for (const r of rungs) {
    base.push(total);
    total += r;
  }

  const din: bigint[] = new Array(total).fill(0n);
  const dout: bigint[] = new Array(total).fill(0n);
  const ptr: number[] = new Array(k).fill(0);
  const fill: bigint[] = new Array(k).fill(0n);

  slots.forEach((slot, i) => {
    if (slot.enabled === false) {
      ptr[i] = rungs[i]; // born exhausted, mirroring the in-VM enable gate
      return;
    }
    buildLadder(slot.quote, amountIn, rungs[i], slot.ladderQuotes).forEach((rung, j) => {
      din[base[i] + j] = rung.dIn;
      dout[base[i] + j] = rung.dOut;
    });
  });

  let remaining = amountIn;
  for (let it = 0; it < total && remaining > 0n; it++) {
    let best = k;
    for (let s = 0; s < k; s++) {
      if (ptr[s] < rungs[s]) {
        if (best === k) best = s;
        if (best !== s) {
          const c = base[s] + ptr[s];
          const b = base[best] + ptr[best];
          if (dout[c] * din[b] > dout[b] * din[c]) best = s;
        }
      }
    }
    if (best === k) throw new Error('solveReference: no enabled capacity left (mirrors the on-chain "fill" revert)');
    const r = base[best] + ptr[best];
    let take = din[r];
    if (take > remaining) take = remaining;
    fill[best] += take;
    remaining -= take;
    if (take === din[r]) ptr[best] += 1;
  }
  if (remaining > 0n) throw new Error('solveReference: amountIn not fully assigned (mirrors the on-chain "fill" revert)');

  const predictedOuts = slots.map((slot, i) => (slot.enabled === false ? 0n : slot.quote(fill[i])));
  return {
    slices: fill,
    predictedOuts,
    totalPredicted: predictedOuts.reduce((sum, out) => sum + out, 0n),
  };
}
