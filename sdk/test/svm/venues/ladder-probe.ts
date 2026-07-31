/**
 * ABSOLUTE, bottom-anchored probe engine shared by ladder-contract.test.ts.
 *
 * REPLACES the depth-anchored sweep this file used to feed the contract
 * guard (`domainMax >> e` for e<=62, `depthReserves().reserveIn * 4096`).
 * Every measured venue cliff sits at a fixed-WIDTH-INTEGER boundary,
 * addressed in ABSOLUTE units — never as a multiple of a pool's own depth:
 * meteora-damm-v2 aToB collapses exactly at 2^41 (the old smallest probe,
 * domainMax >> 62, sat at 3.98e17 — five orders ABOVE that); the manifest
 * quoteIn overflow cliff sits at mfCap(firstAskPrice), ~1.48e18, in
 * (2^60,2^61) (the old sweep's TOP was 1.23e13 for that fixture — five
 * orders SHORT); orca-legacy-token-swap's pre-fix collapse sits at
 * rin*rout ~ 2.09e25, in (2^84,2^85) — ABOVE u64::MAX entirely, which a
 * depth-scaled *or* u64-capped domain would both miss. depthReserves()
 * feeds NOTHING here.
 *
 * The lattice: coarse anchors 2^e for e = 0..256 (the engine's own u256
 * word — not u64; reachability is a separate axis, see below), each
 * refined with a 2-bit mantissa (2^e*(4+m)/4, m=1..3) — ~1028 points,
 * dense enough to bisect any of the measured cliffs to the exact integer
 * boundary without ever depending on a pool's reserves.
 */

export const WORD_BITS = 256;
export const U64_MAX = (1n << 64n) - 1n;

/** Ascending absolute lattice over [0, 2^maxBits) — dense, geometric, pool-independent. */
export function absoluteProbePoints(maxBits: number = WORD_BITS): bigint[] {
  const points = new Set<bigint>([0n, 1n]);
  for (let e = 0; e <= maxBits; e++) {
    const base = 1n << BigInt(e);
    points.add(base);
    for (const m of [1n, 2n, 3n] as const) {
      points.add((base * (4n + m)) / 4n);
    }
  }
  points.add((1n << BigInt(maxBits)) - 1n);
  return [...points].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface Sample {
  x: bigint;
  /** null = quote(x) threw — its own failure class, never silently a 0. */
  out: bigint | null;
  error?: string;
}

/** Evaluates `quote` ascending over `points`, stopping (and recording) at the first throw. */
export function sampleAscending(quote: (x: bigint) => bigint, points: readonly bigint[]): Sample[] {
  const samples: Sample[] = [];
  for (const x of points) {
    try {
      samples.push({ x, out: quote(x) });
    } catch (err) {
      samples.push({ x, out: null, error: err instanceof Error ? err.message : String(err) });
      break;
    }
  }
  return samples;
}

export type ShapeVerdict =
  | { kind: 'none' }
  | { kind: 'cliff'; x: bigint; peak: bigint }
  | { kind: 'resurrection'; x: bigint; detail: string }
  | { kind: 'throw'; x: bigint; detail: string };

/** Bisects the exact (last positive x, quote(x)) boundary inside a coarse [loPositive, hiZero) bracket. */
function bisectCliff(quote: (x: bigint) => bigint, loPositive: bigint, hiZero: bigint): { x: bigint; peak: bigint } {
  let lo = loPositive;
  let hi = hiZero;
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    if (quote(mid) > 0n) lo = mid;
    else hi = mid;
  }
  return { x: lo, peak: quote(lo) };
}

/**
 * Classifies the SUPPORT SHAPE of a quote closure: legally it either never
 * collapses (`none` — a plateau/asymptote is fine, it just never returns to
 * a permanent 0), or it rises then collapses to a permanent 0 at a finite
 * boundary (`cliff`, bisected exact). A zero that later resurrects positive,
 * or an uncaught throw, are their OWN distinct failure classes — never
 * silently folded into either of the above.
 *
 * A DUST zero at the low end (quote(1)==0, quote(14)==1, ... — an ordinary
 * minimum-tradeable-size rounding floor almost every family has) is NOT a
 * cliff and NOT a resurrection: the state machine only starts caring about a
 * zero once it has seen a POSITIVE value first (entering `positive`); a zero
 * from there enters `post-cliff` (everything after MUST stay 0 — see
 * evaluateQuoteContract's dead-above check); a positive value seen again
 * from `post-cliff` is the genuine resurrection this exists to catch.
 */
export function classifyShape(samples: readonly Sample[], quote: (x: bigint) => bigint): ShapeVerdict {
  let state: 'before' | 'positive' | 'post-cliff' = 'before';
  let lastPositiveIdx = -1;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.out === null) return { kind: 'throw', x: s.x, detail: s.error ?? 'threw' };
    if (s.out > 0n) {
      if (state === 'post-cliff') {
        return {
          kind: 'resurrection',
          x: s.x,
          detail: `quote(${s.x})=${s.out} > 0 after quote had already collapsed to 0 at a smaller x — a second, undeclared transition`,
        };
      }
      state = 'positive';
      lastPositiveIdx = i;
    } else if (state === 'positive') {
      state = 'post-cliff';
    }
    // state === 'before': a dust zero before any positive value — ignore.
  }
  if (state !== 'post-cliff' || lastPositiveIdx === -1) return { kind: 'none' };
  const hiSample = samples[lastPositiveIdx + 1];
  if (hiSample === undefined) return { kind: 'none' };
  const { x, peak } = bisectCliff(quote, samples[lastPositiveIdx].x, hiSample.x);
  return { kind: 'cliff', x, peak };
}

/**
 * A decrease check DISTINCT from the zero-transition scan above: catches a
 * nonzero-to-smaller-nonzero drop (the zero-transition scan only looks for a
 * permanent collapse to 0). Restricted to [0, ceiling] — the cliff boundary,
 * or the whole sweep when there is none — since past a declared cliff
 * everything is 0 (non-decreasing trivially). A family's own genuine,
 * BOUNDED rounding dip (e.g. a real-fee twin-floor dip) is covered by that
 * family's dedicated per-venue unit test at the exact integer pair, not by
 * this coarse lattice — this only fires on a drop the coarse lattice itself
 * lands on, which for a real per-unit rounding dip it structurally cannot
 * (see ladder-contract.test.ts's header for why).
 */
export function findNonzeroDecrease(
  samples: readonly Sample[],
  ceiling: bigint,
): { loX: bigint; loOut: bigint; hiX: bigint; hiOut: bigint } | null {
  let prev: Sample | undefined;
  for (const s of samples) {
    if (s.x > ceiling) break;
    if (s.out === null) {
      prev = s;
      continue;
    }
    if (prev !== undefined && prev.out !== null && s.out < prev.out && s.out > 0n) {
      return { loX: prev.x, loOut: prev.out, hiX: s.x, hiOut: s.out };
    }
    prev = s;
  }
  return null;
}

/** Distinct-value census over [0, ceiling] — MECHANISM A as a measurement. */
export function distinctCensus(samples: readonly Sample[], ceiling: bigint): { distinct: number; distinctNonzero: number } {
  const within = samples.filter((s) => s.out !== null && s.x <= ceiling);
  const distinct = new Set(within.map((s) => String(s.out)));
  const distinctNonzero = new Set(within.filter((s) => s.out !== 0n).map((s) => String(s.out)));
  return { distinct: distinct.size, distinctNonzero: distinctNonzero.size };
}

export interface DeclaredCliff {
  x: bigint;
  peak: bigint;
}

export interface ContractCheckInput {
  /** Used only to prefix violation messages — pass "<family>:<variant>". */
  label: string;
  quote: (x: bigint) => bigint;
  /** The family's pinned declaration for this variant, if any. */
  declared?: DeclaredCliff;
  /** capacityInputVar !== undefined (assumed === referenceCapacities !== undefined — checked separately). */
  hasCapacityPair: boolean;
  /** Override for the negative-control self-tests (keeps them cheap); real families use the full 256-bit sweep. */
  maxBits?: number;
  /** Override for the negative-control self-tests; real families use the shipped floor. */
  distinctFloor?: number;
}

export interface ContractCheckResult {
  violations: string[];
  shape: ShapeVerdict;
  distinct: number;
  distinctNonzero: number;
}

/**
 * THE STRONG STRUCTURAL FORM: a family whose cold quote has a finite cliff
 * MUST declare it (exact pinned x/peak) and, when the cliff sits at or below
 * u64::MAX (merge-reachable — any larger boundary can never be addressed by
 * a real u64 amountIn), must wire BOTH capacityInputVar and
 * referenceCapacities. An UNDECLARED cliff fails regardless of reachability
 * — a cliff above u64::MAX (like orca-legacy-token-swap's pre-fix ~2^84
 * collapse) is exactly as loud as one below it. Also runs the
 * nondecreasing/distinct-value checks over the same sweep, one call per
 * family/variant/direction.
 */
export function evaluateQuoteContract(input: ContractCheckInput): ContractCheckResult {
  const maxBits = input.maxBits ?? WORD_BITS;
  const distinctFloor = input.distinctFloor ?? 16;
  const points = absoluteProbePoints(maxBits);
  const samples = sampleAscending(input.quote, points);
  const violations: string[] = [];
  const shape = classifyShape(samples, input.quote);

  if (shape.kind === 'throw') {
    violations.push(`[${input.label}] quote threw at x=${shape.x}: ${shape.detail}`);
    return { violations, shape, distinct: 0, distinctNonzero: 0 };
  }
  if (shape.kind === 'resurrection') {
    violations.push(`[${input.label}] ${shape.detail}`);
  }

  let quoteAtZero: bigint;
  try {
    quoteAtZero = input.quote(0n);
  } catch (err) {
    violations.push(`[${input.label}] quote(0) threw: ${err instanceof Error ? err.message : String(err)}`);
    return { violations, shape, distinct: 0, distinctNonzero: 0 };
  }
  if (quoteAtZero !== 0n) {
    violations.push(`[${input.label}] quote(0)=${quoteAtZero} !== 0`);
  }

  const ceiling = shape.kind === 'cliff' ? shape.x : (samples[samples.length - 1]?.x ?? 0n);

  const decrease = findNonzeroDecrease(samples, ceiling);
  if (decrease !== null) {
    violations.push(
      `[${input.label}] quote is not nondecreasing: quote(${decrease.loX})=${decrease.loOut} > quote(${decrease.hiX})=${decrease.hiOut}`,
    );
  }

  if (shape.kind === 'cliff') {
    if (input.declared === undefined) {
      violations.push(
        `[${input.label}] UNDECLARED cliff: quote collapses to 0 past x=${shape.x} (peak quote(${shape.x})=${shape.peak}) — declare it (declaredCliffs) and, if merge-reachable (x <= u64::MAX), wire capacityInputVar + referenceCapacities`,
      );
    } else if (String(input.declared.x) !== String(shape.x) || String(input.declared.peak) !== String(shape.peak)) {
      violations.push(
        `[${input.label}] STALE declared cliff: declared x=${input.declared.x}/peak=${input.declared.peak}, measured x=${shape.x}/peak=${shape.peak}`,
      );
    }
    if (shape.x <= U64_MAX && !input.hasCapacityPair) {
      violations.push(
        `[${input.label}] merge-reachable cliff (x=${shape.x} <= u64::MAX=${U64_MAX}) without capacityInputVar/referenceCapacities wired`,
      );
    }
    for (const s of samples) {
      if (s.x > shape.x && s.out !== 0n) {
        violations.push(`[${input.label}] resurrection past the declared cliff: quote(${s.x})=${s.out} !== 0`);
        break;
      }
    }
  } else if (shape.kind === 'none' && input.declared !== undefined) {
    violations.push(
      `[${input.label}] STALE declaration: a cliff is declared (x=${input.declared.x}) but the quote never collapses across the full swept domain — remove the declaration or the fix regressed`,
    );
  }

  const { distinct, distinctNonzero } = distinctCensus(samples, ceiling);
  if (distinct < distinctFloor) {
    violations.push(
      `[${input.label}] VACUOUS sweep: only ${distinct} distinct quote value(s) across the reachable domain (floor ${distinctFloor}) — the probe lattice is not resolving this family's curve`,
    );
  }

  return { violations, shape, distinct, distinctNonzero };
}

/**
 * MECHANISM B — the absolute amountIn lattice for the MERGE-ALTITUDE
 * property (buildLadder never yields a negative dIn/dOut). 2^e for e=0..64
 * (the merge's amountIn always rides a u64 cfg word) plus {c-1,c,c+1,2c}
 * around a declared cliff (the exact neighbourhood a rung is most likely to
 * straddle it) plus the legacy {2*reserveIn} point for continuity with the
 * old depth-scaled sweep.
 */
export function mergeAltitudeAmounts(reserveIn: bigint, declared?: DeclaredCliff): bigint[] {
  const amounts = new Set<bigint>();
  amounts.add(reserveIn > 0n ? reserveIn * 2n : 1_000_000_000n);
  for (let e = 0; e <= 64; e++) amounts.add(1n << BigInt(e));
  if (declared !== undefined && declared.x > 0n) {
    const c = declared.x;
    if (c > 1n) amounts.add(c - 1n);
    amounts.add(c);
    amounts.add(c + 1n);
    amounts.add(c * 2n);
  }
  return [...amounts].filter((a) => a > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
