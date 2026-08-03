/**
 * SolFi V2 adapter v2 (SvmRoute ladder fragment) — a push-quote PMM whose
 * entire quote (inventory skew, a per-slot age/spread spline trio, and a
 * capacity cap) is read LIVE from the pool + a 168-byte XOR-obfuscated oracle
 * account the swap already passes. Nothing is baked as a drift-invariant
 * "shape" param except the one un-derived additive constant K (POOL-keyed,
 * never borrowed from a registry-mate — see index.ts's POOL_K and the
 * "residualRisk" note below): every other
 * quantity — the oracle mid, the inventory skew, the four spread splines, the
 * fee scale, the vault balances — can change between prepare and cook, so the
 * fragment re-derives the closed form from scratch at COOK time, exactly like
 * the EVM merge's live walk.
 *
 * CLOSED FORM (transcribed from the disassembly; ground truth is
 * scratchpad's solfi/crack/quote.mjs, verified wei-exact against 84+ landed
 * `simulateTransaction` calls — 0 mismatch across both directions and a
 * capacity-revert edge):
 *
 *   1. staleness gate: block.number (Clock::slot, the engine's fork-parity
 *      analog for BLOCK_NUMBER) > oracle.expirySlot -> deactivate the slot.
 *   2. inventory skew: diff = vaultB - conv(vaultA); half = diff/2 (signed,
 *      truncating); skewRaw = half*cfg.skewNum/cfg.skewDen (signed,
 *      truncating); if the imbalance isn't already "big", decay skewRaw
 *      toward 0 by cfg.decayPpm over up to 100 slots of age; clamp to
 *      [-cfg.skewLoMag, +cfg.skewHi]; skew < -1e7 -> deactivate.
 *   3. adjMan = man*(1e7+skew)/1e7 (now unconditionally >= 0).
 *   4. pre(x) = dir0 ? x*adjMan/POW : x*POW/adjMan  (POW = 10^|oracle.exp|).
 *   5. depth(x) = spline(dir0 ? splineD0 : splineD1, dir0 ? pre(x) : x).
 *   6. impact(x) = s4 + oracleFee + K + ag*depth(x)*f2*feeScale/1e13, where
 *      ag/s4/f2 are x-INDEPENDENT (age-spline eval, spread-spline eval, and a
 *      confidence-based multiplier) computed once in setup.
 *   7. out(x) = pre(x)*(1e7-impact(x))/1e7, then SATURATE at the output
 *      vault's live balance (never collapse to 0 — see capacityInputVar).
 *      impact(x) > 1e7 or out(x) > outVault*1.10 is the venue's own hard
 *      revert boundary; the ladder treats reaching either as exhausting this
 *      slot's capacity (freezes at the last good grid point) rather than
 *      emitting a value that would abort the whole cook.
 *
 * SIGNED ARITHMETIC: the engine has no native signed divide/compare (the
 * 'svm' target shares v12's postfix opcode table — see svm-profile.ts — and
 * v12 numbers are plain unsigned words; existing signed deltas elsewhere in
 * this codebase, e.g. ecoswap.lens.sauce.ts's int128 liquidityNet, are
 * handled the same way: sign-extend a raw two's-complement read into an
 * explicit (magnitude, negFlag) pair, then do the down-stream add/sub/mul/div
 * on magnitudes with the negFlag combined by hand). The five signed i64 cfg
 * fields (skewNum, skewDen, skewHi, skewLoMag, decayPpm) and the derived
 * diff/half/skew are all carried this way; everything downstream of adjMan is
 * provably non-negative (man >= 0, adjNum >= 0 given the underflow gate), so
 * the sign machinery never has to cross the pre()/depth()/impact()/out()
 * boundary. skewHi is assumed >= 0 and skewLoMag's negation (`lo = -skewLoMag`)
 * is assumed <= 0 by construction (the field names — "+hi, -lo" — and every
 * observed pool agree); this is a disclosed simplification of the general
 * clamp, not re-derived per-call.
 *
 * capacityInputVar: SolFi's out(x) is a closed-form (not a discrete window
 * walk), so the exact input where it first saturates isn't cheaply invertible
 * on-chain — but the GROSS pre-fee/impact conversion pre(x) IS linear, so
 * `satCap = preInv(outVault)` (emitSetupLines) gives a safe, setup-time
 * saturation point without bisection. The ladder uses the SAME discrete-rung
 * convention as the window-walking families (orca-whirlpool/raydium-clmm/
 * meteora-dlmm/manifest): each rung either lands on a still-productive grid
 * point (lx = x, lo = out(x)) or trips the saturation/impact/110%-revert
 * boundary and FREEZES — but the freeze now bumps (lo, lx) up to (satOut,
 * satCap) first if that's an improvement, rather than leaving whatever
 * smaller grid point last succeeded (see emitLadderQuote's doc for the exact
 * shape). This still UNDER-credits productive input relative to the true
 * continuous boundary (safe: the merge can never route more to this slot
 * than it was proven deliverable) at the cost of the satCap/rung-grid
 * resolution — the same granularity trade-off the "rungs are the allocation
 * resolution" finding already accepts elsewhere.
 *
 * residualRisk (carried from the crack, not re-litigated here): K is a
 * per-POOL additive constant that isn't structurally derived from the
 * registry bytes (a 40-entry table walk + a ~20-function decision tree this
 * port does not attempt) — it is a value pinned per INDEPENDENTLY VERIFIED
 * pool (index.ts's POOL_K, NOT keyed by registry — see its header for why: a
 * registry-keyed table quoted two live pools on ONE registry with the same
 * borrowed K when their true values differ, K=0 vs K=5832, a systematic
 * 5.832 bps over-quote on the pool that needed 0). fetchPoolConfig REFUSES
 * (throws) a pool whose own K was never independently verified rather than
 * borrowing a registry-mate's.
 *
 * DISCLOSED, NOT-YET-CLOSED gaps (measured, not hidden — read before treating
 * this venue as fully hardened):
 *
 * - AGE MODELING: the on-chain age term (sAge -> the age spline -> `ag`)
 *   drives a STEP function in the deployed program (flat across a wide range
 *   of oracle ages, then stepping) that this port's spline read reproduces
 *   structurally but has NOT been independently re-measured against fresh
 *   landed state at ages other than the pinned fixture's — do not trust this
 *   adapter wei-exact off the exact snapshot slot the fixture was captured
 *   at; anchor-gated single-burst measurement only (state drift alone
 *   manufactures tens of bps of apparent "error" that is not this adapter's).
 * - THE 110%-OF-VAULT COLLAPSE — FIXED (was: `solfiRawQuote` returning null
 *   past `outCap110`, `solfiColdQuote`/referenceLadderQuotes/
 *   referenceCapacities/emitLadderQuote/emitFinalQuote all mapping that to a
 *   flat 0 instead of the saturated output). SolFi's depth is a spline, so a
 *   true closed-form inverse of the FULL fee/impact/spline formula isn't
 *   attempted — but `pre(x)` (the GROSS, pre-fee/impact conversion) IS a
 *   plain linear function of x, so it inverts trivially: `satCap =
 *   preInv(outVault)` (one division of setup-time constants, no bisection —
 *   solfi's rung already costs 162,332 CU, so an on-chain numeric search was
 *   never viable). `satOut` (the venue-exact output AT x=satCap, one extra
 *   depth-spline eval) is provably <= outVault <= outCap110 — see LiveState's
 *   doc and emitSetupLines' satCap/satOut computation for the proof — so it
 *   is a SAFE, never-over-promising saturation value, though an UNDER-
 *   estimate of the true saturation point (the fee/impact haircut only
 *   shrinks it further; do not read it as "the recovered amount", only as a
 *   conservative floor). Both the JS mirror (referenceQuote/
 *   referenceLadderQuotes/referenceCapacities) and the emitted fragment
 *   (emitLadderQuote/emitFinalQuote) now bump their frozen (lo, lx) up to
 *   (satOut, satCap) the moment either the impact-overflow or 110% boundary
 *   trips, before latching — see each function's own doc for the exact
 *   shape. Fail-safe throughout: if satCap itself is degenerate (a div-by-
 *   zero guard, or the provably-non-tripping property somehow doesn't hold),
 *   satOut stays 0 and every call site falls back to the pre-fix behavior
 *   for that edge, never worse.
 * - `now` IS A SLOT, NOT UNIX SECONDS: every other SvmVenueLadder documents
 *   `now` as unix seconds (types.ts); this family's staleness gate compares
 *   against `block.number` (Clock::slot) because that is what the on-chain
 *   oracle's expirySlot actually is. A GENERIC caller following the
 *   documented (unix-seconds) contract would pass a `now` far LARGER than any
 *   real slot number's neighborhood relative to a typical expirySlot, so
 *   `slot > expSlot` would read true always — the reference would return 0
 *   forever. Callers of this family's referenceQuote/referenceLadderQuotes/
 *   referenceCapacities MUST pass the cluster's live SLOT, not a timestamp.
 */
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SvmVenueLadder, SwapUser, VenueAccount } from '../types.js';
import { CFG, OFF_CACHED_TS, OFF_DECAY_PPM, OFF_FEE_SCALE, OFF_LAST_SWAP_SLOT, OFF_MINT_A, OFF_MINT_B, OFF_SKEW_DEN, OFF_SKEW_HI, OFF_SKEW_LO_MAG, OFF_SKEW_NUM, OFF_SPLINE_AGE, OFF_SPLINE_D0, OFF_SPLINE_D1, OFF_SPLINE_SF, OFF_SPREAD_DIR0, OFF_SPREAD_DIR1, OFF_THRESHOLD, ORACLE_KEY_WORDS, ORACLE_OFF_CONF, ORACLE_OFF_EXP, ORACLE_OFF_EXPIRY_SLOT, ORACLE_OFF_FEE_WORD, ORACLE_OFF_MAN, ORACLE_OFF_SLOT, ORACLE_OFF_TS, SOLFI_V2_PROGRAM_ID, SPLINE_LEN_STRIDE, SPLINE_X_STRIDE, SPLINE_Y_STRIDE, solfiSwapAccounts } from './index.js';
import type { SolfiV2PoolConfig } from './index.js';

const SLUG = 'solfi-v2';
const M64 = (1n << 64n) - 1n;
const H64 = 1n << 63n;
const MOD64 = 1n << 64n;
const AMOUNT_OFF = 64; // SPL token account amount u64 LE

function solfiConfig(base: PoolConfig): SolfiV2PoolConfig {
  if (base.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${base.venue}' pool config`);
  return base as SolfiV2PoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

// ---------------------------------------------------------------------------
// Pure-scalar helper functions shared by every slot's fragment.
// ---------------------------------------------------------------------------

const POW10_HELPER = {
  name: 'solfiPow10',
  source: ['function solfiPow10(n) {', '  let p = 1;', '  for (let i = 0; i < n; i = i + 1) { p = p * 10 }', '  return p;', '}'].join('\n'),
};

/**
 * INLINE (not a stand-alone helper — a stand-alone function's formal
 * parameters share a single 16-deep stack addressing window, `SDUP1..16`;
 * the natural 18-arg spline signature (8 x's + 8 y's + len + q) blows past
 * it. Locals declared inside `main()`'s own body have no such limit (they
 * address a memory slot, not the parameter stack — confirmed empirically),
 * so the eval is spliced directly into the caller's block instead, using a
 * `done` guard flag in place of early `return` (mutually exclusive checks,
 * same order as the reference).
 *
 * Mirrors crack/quote.mjs's `spline()` exactly: x[0] IS a stored knot (not
 * implicit), n === len, the interpolation term is masked to 64 bits at each
 * step (dy/dq/dx/product), round-to-nearest via +dx>>1, and reaching the last
 * valid index ALWAYS returns y[last] (flat extrapolation) regardless of
 * whether q matches it exactly.
 */
function emitSplineInline(tag: string, knots: SplineKnotVars, qExpr: string, outVar: string): string[] {
  const { xs, ys, len } = knots;
  const M = '18446744073709551615';
  const done = `${tag}don`;
  const nm = `${tag}nm`;
  const lines: string[] = [
    `      let ${done} = 0;`,
    `      if (${len} === 0) { ${outVar} = 0; ${done} = 1 }`,
    `      const ${nm} = ${len} - 1;`,
    `      if (${done} === 0 && ${nm} === 0) { ${outVar} = ${ys[0]}; ${done} = 1 }`,
    `      if (${done} === 0 && ${xs[0]} >= ${qExpr}) { ${outVar} = ${ys[0]}; ${done} = 1 }`,
  ];
  for (let k = 1; k <= 7; k++) {
    const xl = xs[k - 1];
    const yl = ys[k - 1];
    const xk = xs[k];
    const yk = ys[k];
    const dy = `${tag}dy${k}`;
    const dq = `${tag}dq${k}`;
    const dx = `${tag}dx${k}`;
    lines.push(
      `      if (${done} === 0 && ${xk} > ${qExpr}) {`,
      `        const ${dy} = (${yk} - ${yl}) & ${M};`,
      `        const ${dq} = (${qExpr} - ${xl}) & ${M};`,
      `        const ${dx} = (${xk} - ${xl}) & ${M};`,
      `        ${outVar} = ((((${dy} * ${dq}) & ${M}) + (${dx} >> 1)) / ${dx} + ${yl}) & ${M};`,
      `        ${done} = 1;`,
      `      }`,
      `      if (${done} === 0 && ${nm} === ${k}) { ${outVar} = ${yk}; ${done} = 1 }`,
      `      if (${done} === 0 && ${xk} >= ${qExpr}) { ${outVar} = ${yk}; ${done} = 1 }`,
    );
  }
  lines.push(`      if (${done} === 0) { ${outVar} = ${ys[7]} }`);
  return lines;
}

/**
 * SAME closed form as emitSplineInline (per-iteration interpolation), but
 * with the dy/dq/dx intermediates fully inlined (repeated as subexpressions)
 * instead of bound to fresh named locals -- 2 locals total (done, nm) instead
 * of 23 (done, nm, + 3 per each of 7 iterations). Used for the THREE one-time
 * setup-time spline evals in emitSetupLines -- ag (clamp(spline(age)...)), sf
 * (the spread spline), and satOut's depth-spline eval -- all called exactly
 * once per slot, unlike solfi-v2's per-rung quote-at-x path (emitQuoteAt via
 * the 'r'/'f' tags, called once per rung PLUS once for the final quote, each
 * occurrence re-declaring its own copy of every named local it uses since
 * v12 does not deduplicate same-named `let`/`const` declarations across
 * repeated emitted blocks).
 *
 * Originally added (SDK PR 60) ONLY for satOut: solfi-v2's per-rung path
 * already sat near the v12 255-scalar-local ceiling, and a third full
 * spline-eval instantiation (with its own named dy/dq/dx per iteration) for
 * satOut alone pushed even a single-rung, MIN_RUNGS=2-floor compile OVER
 * that ceiling -- a real production regression (a single-slot solfi-v2
 * shape could no longer compile at all, needing 262 locals against the 255
 * cap; see this venue's compile-ceiling doc note below). ag and sf are
 * setup-time-only exactly like satOut and carried no correctness reason to
 * stay on the verbose emitSplineInline -- switching both to this compact
 * form frees another (23-2)*2 = 42 locals, landing the floor shape well
 * clear of the ceiling with real headroom rather than at it. Extra bytecode
 * ops from the repeated subexpressions are the trade, not extra scalar
 * locals -- correctness-identical to emitSplineInline (same formula, same
 * knot indices, same rounding), just laid out to cost fewer registers.
 */
function emitSplineInlineCompact(tag: string, knots: SplineKnotVars, qExpr: string, outVar: string): string[] {
  const { xs, ys, len } = knots;
  const M = '18446744073709551615';
  const done = `${tag}don`;
  const nm = `${tag}nm`;
  const dy = (yk: string, yl: string) => `((${yk} - ${yl}) & ${M})`;
  const dq = (xl: string) => `((${qExpr} - ${xl}) & ${M})`;
  const dx = (xk: string, xl: string) => `((${xk} - ${xl}) & ${M})`;
  const lines: string[] = [
    `      let ${done} = 0;`,
    `      if (${len} === 0) { ${outVar} = 0; ${done} = 1 }`,
    `      const ${nm} = ${len} - 1;`,
    `      if (${done} === 0 && ${nm} === 0) { ${outVar} = ${ys[0]}; ${done} = 1 }`,
    `      if (${done} === 0 && ${xs[0]} >= ${qExpr}) { ${outVar} = ${ys[0]}; ${done} = 1 }`,
  ];
  for (let k = 1; k <= 7; k++) {
    const xl = xs[k - 1]!;
    const yl = ys[k - 1]!;
    const xk = xs[k]!;
    const yk = ys[k]!;
    lines.push(
      `      if (${done} === 0 && ${xk} > ${qExpr}) {`,
      `        ${outVar} = (((((${dy(yk, yl)} * ${dq(xl)}) & ${M}) + (${dx(xk, xl)} >> 1)) / ${dx(xk, xl)} + ${yl}) & ${M});`,
      `        ${done} = 1;`,
      `      }`,
      `      if (${done} === 0 && ${nm} === ${k}) { ${outVar} = ${yk}; ${done} = 1 }`,
      `      if (${done} === 0 && ${xk} >= ${qExpr}) { ${outVar} = ${yk}; ${done} = 1 }`,
    );
  }
  lines.push(`      if (${done} === 0) { ${outVar} = ${ys[7]} }`);
  return lines;
}

/** Off-chain mirror of solfiSpline (arg order matches exactly). */
export function solfiSplineRef(knots: { x: bigint[]; y: bigint[]; len: bigint }, q: bigint): bigint {
  const { x, y, len } = knots;
  if (len === 0n) return 0n;
  const nm = len - 1n;
  if (nm === 0n) return y[0];
  if (x[0] >= q) return y[0];
  for (let k = 1; k <= 7; k++) {
    if (x[k] > q) {
      const yl = y[k - 1];
      const xl = x[k - 1];
      const dy = (y[k] - yl) & M64;
      const dq = (q - xl) & M64;
      const dx = (x[k] - xl) & M64;
      return ((((dy * dq) & M64) + (dx >> 1n)) / dx + yl) & M64;
    }
    if (nm === BigInt(k)) return y[k];
    if (x[k] >= q) return y[k];
  }
  return y[7];
}

interface SplineKnotVars {
  xs: string[];
  ys: string[];
  len: string;
}

/** Emit the 17 live accountUint reads for one spline struct + return its var names. */
function emitSplineReads(p: string, tag: string, poolRef: string, base: number): { lines: string[]; vars: SplineKnotVars } {
  const xs: string[] = [];
  const ys: string[] = [];
  const lines: string[] = [];
  for (let i = 0; i < 8; i++) {
    const xv = `${p}${tag}x${i}`;
    lines.push(`  const ${xv} = accountUint(${poolRef}, ${base + SPLINE_X_STRIDE + 8 * i}, 8);`);
    xs.push(xv);
  }
  for (let i = 0; i < 8; i++) {
    const yv = `${p}${tag}y${i}`;
    lines.push(`  const ${yv} = accountUint(${poolRef}, ${base + SPLINE_Y_STRIDE + 8 * i}, 8);`);
    ys.push(yv);
  }
  const lenV = `${p}${tag}len`;
  lines.push(`  const ${lenV} = accountUint(${poolRef}, ${base + SPLINE_LEN_STRIDE}, 8);`);
  return { lines, vars: { xs, ys, len: lenV } };
}

interface ReadSpline {
  x: bigint[];
  y: bigint[];
  len: bigint;
}
function readSplineRef(data: Uint8Array, base: number): ReadSpline {
  const x: bigint[] = [];
  const y: bigint[] = [];
  for (let i = 0; i < 8; i++) x.push(readUintLE(data, base + SPLINE_X_STRIDE + 8 * i, 8));
  for (let i = 0; i < 8; i++) y.push(readUintLE(data, base + SPLINE_Y_STRIDE + 8 * i, 8));
  const len = readUintLE(data, base + SPLINE_LEN_STRIDE, 8);
  return { x, y, len };
}

/** Sign-extend a raw u64 two's-complement read into (magnitude, negFlag) — TS mirror. */
function signExtend(raw: bigint): { mag: bigint; neg: boolean } {
  if (raw >= H64) return { mag: MOD64 - raw, neg: true };
  return { mag: raw, neg: false };
}

// ---------------------------------------------------------------------------
// Setup: everything x-INDEPENDENT (oracle decode, inventory skew, ag/s4/f2,
// the spline knot sets, outVault + its 110% cap).
// ---------------------------------------------------------------------------

function emitSetupLines(cfg: SolfiV2PoolConfig, slot: number, kParam: string, enableVar?: string): string[] {
  const p = `s${slot}`;
  const en = enableVar ?? `${p}en`;
  const poolRef = JSON.stringify(ref(slot, 'pool'));
  const oracleRef = JSON.stringify(ref(slot, 'oracle'));
  const vaRef = JSON.stringify(ref(slot, 'va'));
  const vbRef = JSON.stringify(ref(slot, 'vb'));
  const dir0 = cfg.direction === 0;
  const depthBase = dir0 ? OFF_SPLINE_D0 : OFF_SPLINE_D1;
  const spreadOff = dir0 ? OFF_SPREAD_DIR0 : OFF_SPREAD_DIR1;
  const feeWordHalf = dir0 ? 'hi' : 'lo'; // dir0 reads the HIGH u32 (offset 0x3c), dir1 the LOW u32 (0x38)

  const depthKnots = emitSplineReads(p, 'd', poolRef, depthBase);
  const ageKnots = emitSplineReads(p, 'a', poolRef, OFF_SPLINE_AGE);
  const sfKnots = emitSplineReads(p, 's', poolRef, OFF_SPLINE_SF);

  const lines: string[] = [
    // Unconditional live reads (accounts must be readable regardless of enable).
    `  const ${p}va = accountUint(${vaRef}, ${AMOUNT_OFF}, 8);`,
    `  const ${p}vb = accountUint(${vbRef}, ${AMOUNT_OFF}, 8);`,
    `  const ${p}slot = block.number;`,
    `  const ${p}w0 = accountUint(${oracleRef}, ${ORACLE_OFF_EXP}, 8);`,
    `  const ${p}w1 = accountUint(${oracleRef}, ${ORACLE_OFF_MAN}, 8);`,
    `  const ${p}w2 = accountUint(${oracleRef}, ${ORACLE_OFF_SLOT}, 8);`,
    `  const ${p}oTs = accountUint(${oracleRef}, ${ORACLE_OFF_TS}, 8);`, // key word 3 == 0 (plaintext)
    `  const ${p}w4 = accountUint(${oracleRef}, ${ORACLE_OFF_CONF}, 8);`,
    `  const ${p}w5 = accountUint(${oracleRef}, ${ORACLE_OFF_EXPIRY_SLOT}, 8);`,
    `  const ${p}w7 = accountUint(${oracleRef}, ${ORACLE_OFF_FEE_WORD}, 8);`,
    `  const ${p}expRaw = ${p}w0 ^ ${ORACLE_KEY_WORDS[0]};`,
    `  const ${p}man = ${p}w1 ^ ${ORACLE_KEY_WORDS[1]};`,
    `  const ${p}oSlot = ${p}w2 ^ ${ORACLE_KEY_WORDS[2]};`,
    `  const ${p}conf = ${p}w4 ^ ${ORACLE_KEY_WORDS[4]};`,
    `  const ${p}expSlot = ${p}w5 ^ ${ORACLE_KEY_WORDS[5]};`,
    `  const ${p}oFeeW = ${p}w7 ^ ${ORACLE_KEY_WORDS[7]};`,
    // oFee is the direction-specific HALF of the decoded fee word (u32 @ +0x38 low / +0x3c high).
    feeWordHalf === 'hi' ? `  const ${p}oFee = ${p}oFeeW >> 32;` : `  const ${p}oFee = ${p}oFeeW & 4294967295;`,
    `  let ${p}expNeg = 0; let ${p}expMag = ${p}expRaw;`,
    `  if (${p}expRaw >= 9223372036854775808) { ${p}expNeg = 1; ${p}expMag = 18446744073709551616 - ${p}expRaw; }`,
    // cfg reads
    `  const ${p}numRaw = accountUint(${poolRef}, ${OFF_SKEW_NUM}, 8);`,
    `  const ${p}denRaw = accountUint(${poolRef}, ${OFF_SKEW_DEN}, 8);`,
    `  const ${p}hiRaw = accountUint(${poolRef}, ${OFF_SKEW_HI}, 8);`,
    `  const ${p}loMagRaw = accountUint(${poolRef}, ${OFF_SKEW_LO_MAG}, 8);`,
    `  const ${p}decayRaw = accountUint(${poolRef}, ${OFF_DECAY_PPM}, 8);`,
    `  const ${p}lastSwap = accountUint(${poolRef}, ${OFF_LAST_SWAP_SLOT}, 8);`,
    `  const ${p}feeScale = accountUint(${poolRef}, ${OFF_FEE_SCALE}, 8);`,
    `  const ${p}cachedTs = accountUint(${poolRef}, ${OFF_CACHED_TS}, 8);`,
    `  const ${p}sfRaw = accountUint(${poolRef}, ${spreadOff}, 4);`,
    `  let ${p}thr = accountUint(${poolRef}, ${OFF_THRESHOLD}, 4);`,
    `  if (${p}thr === 0) { ${p}thr = 100 }`,
    // sign-extend the 5 signed i64 cfg fields
    `  let ${p}numNeg = 0; let ${p}numMag = ${p}numRaw;`,
    `  if (${p}numRaw >= 9223372036854775808) { ${p}numNeg = 1; ${p}numMag = 18446744073709551616 - ${p}numRaw; }`,
    `  let ${p}denNeg = 0; let ${p}denMag = ${p}denRaw;`,
    `  if (${p}denRaw >= 9223372036854775808) { ${p}denNeg = 1; ${p}denMag = 18446744073709551616 - ${p}denRaw; }`,
    `  let ${p}hiMag = ${p}hiRaw;`,
    `  if (${p}hiRaw >= 9223372036854775808) { ${p}hiMag = 18446744073709551616 - ${p}hiRaw; }`, // assumed >= 0 (see module doc)
    `  let ${p}loMagMag = ${p}loMagRaw;`,
    `  if (${p}loMagRaw >= 9223372036854775808) { ${p}loMagMag = 18446744073709551616 - ${p}loMagRaw; }`,
    `  let ${p}decayNeg = 0; let ${p}decayMag = ${p}decayRaw;`,
    `  if (${p}decayRaw >= 9223372036854775808) { ${p}decayNeg = 1; ${p}decayMag = 18446744073709551616 - ${p}decayRaw; }`,
    ...depthKnots.lines,
    ...ageKnots.lines,
    ...sfKnots.lines,
    `  let ${p}pow = 1;`,
    `  let ${p}adjMan = 0;`,
    `  let ${p}ag = 1000;`,
    `  let ${p}s4 = 0;`,
    `  let ${p}f2 = 100000;`,
    `  let ${p}fixedImpact = 0;`,
    `  let ${p}outVault = 0;`,
    `  let ${p}outCap110 = 0;`,
    `  let ${p}satCap = 0;`,
    `  let ${p}satOut = 0;`,
    `  let ${p}invalid = 1;`,
    `  let ${p}lo = 0; let ${p}lx = 0; let ${p}cap = 0;`,
    `  if (${en} !== 0) {`,
    `    ${p}pow = solfiPow10(${p}expMag);`,
    // conv(vaultA)
    `    let ${p}convA = 0;`,
    `    if (${p}expNeg === 1) { ${p}convA = (${p}va * ${p}man) / ${p}pow } else { ${p}convA = ${p}va * ${p}man * ${p}pow }`,
    // diff = vaultB - conv(vaultA)  (signed)
    `    let ${p}diffNeg = 0; let ${p}diffMag = 0;`,
    `    if (${p}vb >= ${p}convA) { ${p}diffMag = ${p}vb - ${p}convA } else { ${p}diffNeg = 1; ${p}diffMag = ${p}convA - ${p}vb }`,
    // half = diff/2 (sign preserved, magnitude floored)
    `    const ${p}halfMag = ${p}diffMag / 2;`,
    `    const ${p}halfNeg = ${p}diffNeg;`,
    // skew = half*num/den (combined signed division)
    `    const ${p}prodMag = ${p}halfMag * ${p}numMag;`,
    `    let ${p}prodNeg = 0; if (${p}halfNeg !== ${p}numNeg) { ${p}prodNeg = 1 }`,
    `    let ${p}skewMag = 0; let ${p}skewNeg = 0;`,
    `    if (${p}denMag !== 0) { ${p}skewMag = ${p}prodMag / ${p}denMag; if (${p}prodNeg !== ${p}denNeg) { ${p}skewNeg = 1 } }`,
    // bigImb (direction fixed at emit time)
    `    let ${p}bigImb = 0;`,
    dir0
      ? `    if (${p}diffNeg === 1 && ${p}diffMag > 1) { ${p}bigImb = 1 }`
      : `    if (${p}diffNeg === 0 && ${p}diffMag > 1) { ${p}bigImb = 1 }`,
    `    if (${p}bigImb === 0) {`,
    `      let ${p}age = 0;`,
    `      if (${p}slot >= ${p}lastSwap) { ${p}age = ${p}slot - ${p}lastSwap }`,
    `      if (${p}age > 100) { ${p}age = 100 }`,
    `      const ${p}dProdMag = ${p}skewMag * ${p}age * ${p}decayMag;`,
    `      let ${p}dProdNeg = 0; if (${p}skewNeg !== ${p}decayNeg) { ${p}dProdNeg = 1 }`,
    `      const ${p}dMag = ${p}dProdMag / 100;`,
    `      const ${p}dNeg = ${p}dProdNeg;`,
    `      let ${p}skewIsPos = 0;`,
    `      if (${p}skewNeg === 0 && ${p}skewMag > 0) { ${p}skewIsPos = 1 }`,
    `      if (${p}skewIsPos === 1) {`,
    // new skew = min(d, skew); both compared as signed values
    `        let ${p}dLess = 0;`,
    `        if (${p}dNeg === 1) { ${p}dLess = 1 }`,
    `        if (${p}dNeg === 0 && ${p}dMag < ${p}skewMag) { ${p}dLess = 1 }`,
    `        if (${p}dLess === 1) { ${p}skewMag = ${p}dMag; ${p}skewNeg = ${p}dNeg }`,
    `      } else {`,
    // new skew = max(d, skew); skew is <= 0 here
    `        let ${p}dGreater = 0;`,
    `        if (${p}dNeg === 0 && ${p}skewNeg === 1) { ${p}dGreater = 1 }`,
    `        if (${p}dNeg === 0 && ${p}skewNeg === 0 && ${p}dMag > ${p}skewMag) { ${p}dGreater = 1 }`,
    `        if (${p}dNeg === 1 && ${p}skewNeg === 1 && ${p}dMag < ${p}skewMag) { ${p}dGreater = 1 }`,
    `        if (${p}dGreater === 1) { ${p}skewMag = ${p}dMag; ${p}skewNeg = ${p}dNeg }`,
    `      }`,
    `    }`,
    // clamp to [-loMagMag, +hiMag] (hi assumed >= 0, lo assumed <= 0 — see module doc)
    `    if (${p}skewNeg === 0 && ${p}skewMag > ${p}hiMag) { ${p}skewMag = ${p}hiMag }`,
    `    if (${p}skewNeg === 1 && ${p}skewMag > ${p}loMagMag) { ${p}skewMag = ${p}loMagMag }`,
    // underflow gate: skew < -1e7 => deactivate. STALENESS GATE (FIXED
    // 2026-07): the fragment used to decode ${p}expSlot but never compare it
    // to ${p}slot (block.number) anywhere — the reference's `if (slot >
    // expSlot) return null` had no fragment twin, so a rung/final quote past
    // oracle expiry (where the real program reverts Custom(23)) was still
    // predicted as a normal positive fill instead of deactivating, an
    // optimistic over-promise that would abort the whole cook on execution.
    `    if (${p}skewNeg === 1 && ${p}skewMag > 10000000) {`,
    `      ${p}invalid = 1;`,
    `    } else if (${p}slot > ${p}expSlot) {`,
    `      ${p}invalid = 1;`,
    `    } else {`,
    `      ${p}invalid = 0;`,
    `      let ${p}adjNum = 10000000;`,
    `      if (${p}skewNeg === 0) { ${p}adjNum = 10000000 + ${p}skewMag } else { ${p}adjNum = 10000000 - ${p}skewMag }`,
    `      ${p}adjMan = (${p}man * ${p}adjNum) / 10000000;`,
    // ag = clamp(spline(age, sAge), 1000, 100000); sAge clamped to 0 when the
    // oracle publish slot is somehow ahead of block.number (see module doc —
    // provably equivalent to the reference's own `sAge>clockSlot -> 0` guard
    // given every spline's x[0] is a non-negative knot).
    `      let ${p}sAge = 0;`,
    `      if (${p}slot >= ${p}oSlot) { ${p}sAge = ${p}slot - ${p}oSlot }`,
    ...emitSplineInlineCompact(`${p}ag`, ageKnots.vars, `${p}sAge`, `${p}ag`),
    `      if (${p}ag < 1000) { ${p}ag = 1000 }`,
    `      if (${p}ag > 100000) { ${p}ag = 100000 }`,
    // sf / f2 / s4
    `      let ${p}sf = ${p}sfRaw;`,
    `      if (${p}cachedTs < ${p}oTs) { ${p}sf = 0 }`,
    `      ${p}f2 = 100000;`,
    `      if (${p}sf > ${p}thr) {`,
    `        let ${p}confClamped = ${p}conf;`,
    `        if (${p}confClamped < 1000) { ${p}confClamped = 1000 }`,
    `        if (${p}confClamped > 100000) { ${p}confClamped = 100000 }`,
    `        ${p}f2 = ${p}confClamped;`,
    `      }`,
    ...emitSplineInlineCompact(`${p}sf`, sfKnots.vars, `${p}sf`, `${p}s4`),
    `      ${p}fixedImpact = ${p}s4 + ${p}oFee + ${kParam};`,
    `      ${p}outVault = ${dir0 ? `${p}vb` : `${p}va`};`,
    `      ${p}outCap110 = (${p}outVault * 110) / 100;`,
    // satCap = preInv(outVault): solve pre(x) = outVault for x -- the linear
    // part of the closed form, ignoring the fee/impact haircut (which only
    // ever shrinks the delivered output further -- see the module doc's "THE
    // 110%-OF-VAULT COLLAPSE" fix). Zero-guarded like every other adjMan
    // division in this file.
    dir0
      ? `      if (${p}expNeg === 1) { if (${p}adjMan !== 0) { ${p}satCap = (${p}outVault * ${p}pow) / ${p}adjMan } } else { if (${p}adjMan !== 0) { ${p}satCap = ${p}outVault / (${p}adjMan * ${p}pow) } }`
      : `      if (${p}expNeg === 1) { ${p}satCap = (${p}outVault * ${p}adjMan) / ${p}pow } else { ${p}satCap = ${p}outVault * ${p}adjMan * ${p}pow }`,
    // satOut = the venue-exact output AT x=satCap -- one extra depth-spline
    // eval, done once here rather than per-rung. Provably non-tripping (see
    // the doc above), but the impact/110% guards stay for defense-in-depth;
    // if either somehow trips, satOut stays 0 (fail-safe, never worse than
    // today's collapse-to-0 behavior for this edge).
    ...emitQuoteAtCompact(cfg, slot, `${p}satCap`, 'sat', depthKnots.vars),
    `      if (${p}satimpact <= 10000000) {`,
    `        const ${p}satraw = (${p}satpre * (10000000 - ${p}satimpact)) / 10000000;`,
    `        if (${p}satraw <= ${p}outCap110) {`,
    `          if (${p}satraw > ${p}outVault) { ${p}satOut = ${p}outVault } else { ${p}satOut = ${p}satraw }`,
    `        }`,
    `      }`,
    `    }`,
    `  }`,
  ];
  return lines;
}

/** Compute pre(x)/depth(x)/impact(x)/rawOut(x) at expression `xExpr` into a fresh var namespace `tag`. */
function emitQuoteAt(cfg: SolfiV2PoolConfig, slot: number, xExpr: string, tag: string, depthVars: SplineKnotVars): string[] {
  const p = `s${slot}`;
  const dir0 = cfg.direction === 0;
  const t = `${p}${tag}`;
  const lines: string[] = [`      let ${t}pre = 0;`];
  if (dir0) {
    lines.push(
      `      if (${p}expNeg === 1) { ${t}pre = (${xExpr} * ${p}adjMan) / ${p}pow } else { ${t}pre = ${xExpr} * ${p}adjMan * ${p}pow }`,
    );
    lines.push(`      const ${t}bAmt = ${t}pre;`);
  } else {
    lines.push(
      `      if (${p}expNeg === 1) { ${t}pre = (${xExpr} * ${p}pow) / ${p}adjMan } else { if (${p}adjMan !== 0) { ${t}pre = ${xExpr} / (${p}adjMan * ${p}pow) } }`,
    );
    lines.push(`      const ${t}bAmt = ${xExpr};`);
  }
  lines.push(`      let ${t}depth = 0;`);
  lines.push(...emitSplineInline(`${t}d`, depthVars, `${t}bAmt`, `${t}depth`));
  lines.push(`      const ${t}term = (${p}ag * ${t}depth * ${p}f2 * ${p}feeScale) / 10000000000000;`);
  lines.push(`      const ${t}impact = ${p}fixedImpact + ${t}term;`);
  return lines;
}

/**
 * SAME closed form as emitQuoteAt, but locals-economical: drops the `bAmt`
 * alias (inlines `${t}pre`/`${xExpr}` directly at its one use site) and uses
 * emitSplineInlineCompact for the depth-spline lookup instead of
 * emitSplineInline. Used ONLY for the one-time setup-time satOut computation
 * -- see emitSplineInlineCompact's doc for why (the scalar-local ceiling).
 */
function emitQuoteAtCompact(cfg: SolfiV2PoolConfig, slot: number, xExpr: string, tag: string, depthVars: SplineKnotVars): string[] {
  const p = `s${slot}`;
  const dir0 = cfg.direction === 0;
  const t = `${p}${tag}`;
  const lines: string[] = [`      let ${t}pre = 0;`];
  const bAmt = dir0 ? `${t}pre` : xExpr;
  if (dir0) {
    lines.push(
      `      if (${p}expNeg === 1) { ${t}pre = (${xExpr} * ${p}adjMan) / ${p}pow } else { ${t}pre = ${xExpr} * ${p}adjMan * ${p}pow }`,
    );
  } else {
    lines.push(
      `      if (${p}expNeg === 1) { ${t}pre = (${xExpr} * ${p}pow) / ${p}adjMan } else { if (${p}adjMan !== 0) { ${t}pre = ${xExpr} / (${p}adjMan * ${p}pow) } }`,
    );
  }
  lines.push(`      let ${t}depth = 0;`);
  lines.push(...emitSplineInlineCompact(`${t}d`, depthVars, bAmt, `${t}depth`));
  lines.push(`      const ${t}term = (${p}ag * ${t}depth * ${p}f2 * ${p}feeScale) / 10000000000000;`);
  lines.push(`      const ${t}impact = ${p}fixedImpact + ${t}term;`);
  return lines;
}

export const solfiV2Ladder = {
  slug: SLUG,

  defaultRungs: 4,

  shapeKey(base: PoolConfig): string {
    return `${SLUG}:${solfiConfig(base).direction}`;
  },

  helpers(): { name: string; source: string }[] {
    return [POW10_HELPER];
  },

  paramCount: 1,

  paramsFor(base: PoolConfig): bigint[] {
    return [solfiConfig(base).additiveK];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const c = solfiConfig(base);
    return [
      { ref: ref(slot, 'pool'), address: c.pool },
      { ref: ref(slot, 'oracle'), address: c.oracle },
      { ref: ref(slot, 'va'), address: c.vaultA },
      { ref: ref(slot, 'vb'), address: c.vaultB },
    ];
  },

  emitSetup(base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string {
    const cfg = solfiConfig(base);
    const [k] = params;
    return emitSetupLines(cfg, slot, k, enableVar).join('\n');
  },

  /**
   * Ladder rung at cumulative grid point x: freezes (cap = 1) the first time
   * this rung would trip the impact-overflow or 110%-of-vault revert boundary
   * (the real venue would abort the whole swap past either), otherwise
   * records the (possibly outVault-saturated) output as the new last-good
   * point. Once capped, all higher rungs report the SAME last-good value —
   * dOut is 0 for them, exactly the window-walking convention.
   *
   * BUMP-THEN-LATCH: the first rung to actually trip either boundary would,
   * pre-fix, freeze at whatever smaller grid point last succeeded — which
   * under-reports the true capacity whenever the grid skips the narrow
   * satCap..outCap110 saturation zone (the exact "coarse ladder gets
   * allocated ZERO" hazard). Both trip branches now bump (lo, lx) up to
   * (satOut, satCap) — the setup-computed, provably-reachable saturation
   * point — before latching, so the frozen value is never worse than what
   * setup already proved deliverable.
   */
  emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string {
    const cfg = solfiConfig(base);
    const p = `s${slot}`;
    const depthBase = cfg.direction === 0 ? OFF_SPLINE_D0 : OFF_SPLINE_D1;
    const depthKnots = knotVarsFor(p, 'd');
    void depthBase;
    const bump = `        if (${p}satCap > ${p}lx) { ${p}lo = ${p}satOut; ${p}lx = ${p}satCap; }`;
    const lines: string[] = [
      `    if (${p}cap === 0 && ${p}invalid === 0 && ${x} > 0) {`,
      ...emitQuoteAt(cfg, slot, x, 'r', depthKnots),
      `      if (${p}rimpact <= 10000000) {`,
      `        const ${p}rrawOut = (${p}rpre * (10000000 - ${p}rimpact)) / 10000000;`,
      `        if (${p}rrawOut <= ${p}outCap110) {`,
      `          if (${p}rrawOut > ${p}outVault) { ${p}lo = ${p}outVault } else { ${p}lo = ${p}rrawOut }`,
      `          ${p}lx = ${x};`,
      `        } else {`,
      bump,
      `          ${p}cap = 1;`,
      `        }`,
      `      } else {`,
      bump,
      `        ${p}cap = 1;`,
      `      }`,
      `    }`,
      `    const ${outVar} = ${p}lo;`,
    ];
    return lines.join('\n');
  },

  capacityInputVar(slot: number): string {
    return `s${slot}lx`;
  },

  /**
   * Cold final quote: reuse the ladder's last-good value if x lands exactly
   * there, else recompute fresh. Past either revert boundary, falls back to
   * satOut (the setup-computed, provably-reachable saturation point) when x
   * is at or beyond satCap, instead of collapsing to 0 — the one-shot twin
   * of emitLadderQuote's bump-then-latch fix (see its doc).
   */
  emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string {
    const cfg = solfiConfig(base);
    const p = `s${slot}`;
    const depthKnots = knotVarsFor(p, 'd');
    const lines: string[] = [
      `  let ${outVar} = 0;`,
      `  if (${p}invalid === 0 && ${x} > 0) {`,
      `    if (${p}lx === ${x}) { ${outVar} = ${p}lo }`,
      `    else {`,
      ...emitQuoteAt(cfg, slot, x, 'f', depthKnots),
      `      if (${p}fimpact <= 10000000) {`,
      `        const ${p}frawOut = (${p}fpre * (10000000 - ${p}fimpact)) / 10000000;`,
      `        if (${p}frawOut <= ${p}outCap110) {`,
      `          if (${p}frawOut > ${p}outVault) { ${outVar} = ${p}outVault } else { ${outVar} = ${p}frawOut }`,
      `        } else if (${p}satCap > 0 && ${x} >= ${p}satCap) { ${outVar} = ${p}satOut }`,
      `      } else if (${p}satCap > 0 && ${x} >= ${p}satCap) { ${outVar} = ${p}satOut }`,
      `    }`,
      `  }`,
    ];
    return lines.join('\n');
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const c = solfiConfig(base);
    const make = (r: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
    return {
      programId: SOLFI_V2_PROGRAM_ID,
      prefix: Uint8Array.from([0x07]),
      // minOut u64 LE = 1, then direction u8 (the venue's own min_out floor is
      // dead weight here — the recipe's terminal outAta delta owns the bound).
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, c.direction]),
      patch: 'in',
      accounts: solfiSwapAccounts(c, user, make, (role) => ref(slot, role)),
    };
  },

  /** Exact TS mirror of the emitted fragment. `now`, if given, overrides the live slot (else state must carry it — see below). */
  referenceQuote(
    base: PoolConfig,
    state: AccountBytesMap,
    params: readonly bigint[],
    now?: bigint,
  ): (x: bigint) => bigint {
    const cfg = solfiConfig(base);
    const [k] = params;
    const live = liveState(cfg, state, k, now);
    return (x: bigint): bigint => (live === null ? 0n : solfiColdQuote(cfg, live, x));
  },

  referenceLadderQuotes(
    base: PoolConfig,
    state: AccountBytesMap,
    params: readonly bigint[],
    now?: bigint,
  ): (grid: readonly bigint[]) => bigint[] {
    const cfg = solfiConfig(base);
    const [k] = params;
    const live = liveState(cfg, state, k, now);
    return (grid: readonly bigint[]): bigint[] => {
      let lo = 0n;
      let capped = false;
      return grid.map((x) => {
        if (live !== null && !capped && x > 0n) {
          const r = solfiRawQuote(cfg, live, x);
          if (r === null) {
            // Bump-then-latch: this grid point tripped the impact/110%
            // boundary, but satCap (< x, provably non-tripping) already
            // reaches at least satOut -- record that instead of freezing at
            // whatever smaller grid point last succeeded (see LiveState doc).
            if (live.satOut > lo) lo = live.satOut;
            capped = true;
          } else {
            lo = r;
          }
        }
        return lo;
      });
    };
  },

  referenceCapacities(
    base: PoolConfig,
    state: AccountBytesMap,
    params: readonly bigint[],
    now?: bigint,
  ): (grid: readonly bigint[]) => bigint[] {
    const cfg = solfiConfig(base);
    const [k] = params;
    const live = liveState(cfg, state, k, now);
    return (grid: readonly bigint[]): bigint[] => {
      let lx = 0n;
      let capped = false;
      return grid.map((x) => {
        if (live !== null && !capped && x > 0n) {
          const r = solfiRawQuote(cfg, live, x);
          if (r === null) {
            // Bump-then-latch: see referenceLadderQuotes' twin comment above.
            if (live.satCap > lx) lx = live.satCap;
            capped = true;
          } else {
            lx = x;
          }
        }
        return lx;
      });
    };
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const cfg = solfiConfig(base);
    const va = state[cfg.vaultA];
    const vb = state[cfg.vaultB];
    if (va === undefined || vb === undefined) throw new Error(`${SLUG} depth is missing a reserve vault`);
    const ra = readUintLE(va, AMOUNT_OFF, 8);
    const rb = readUintLE(vb, AMOUNT_OFF, 8);
    return cfg.direction === 0 ? { reserveIn: ra, reserveOut: rb } : { reserveIn: rb, reserveOut: ra };
  },

  continuousFees(): { gammaPpm: bigint; muPpm: bigint } {
    // The impact term folds spread + inventory-skew + a confidence multiplier;
    // there is no single static fee ppm to report distinct from the curve
    // itself, so this measurement-only oracle reports a neutral passthrough.
    return { gammaPpm: 1_000_000n, muPpm: 1_000_000n };
  },
} satisfies SvmVenueLadder;

// ---------------------------------------------------------------------------
// TS reference (independently derived from the same disassembly as the
// fragment above, mirroring crack/quote.mjs's proven-wei-exact closed form —
// NOT derived by reading the emitted SauceScript).
// ---------------------------------------------------------------------------

interface LiveState {
  dir0: boolean;
  adjMan: bigint;
  pow: bigint;
  expNeg: boolean;
  ag: bigint;
  s4: bigint;
  oFee: bigint;
  f2: bigint;
  feeScale: bigint;
  k: bigint;
  outVault: bigint;
  outCap110: bigint;
  depthKnots: ReadSpline;
  /** preInv(outVault): the x at which the GROSS pre(x) conversion first reaches
   *  outVault -- x-independent, computed once. See "THE 110%-OF-VAULT COLLAPSE"
   *  fix in the module doc. */
  satCap: bigint;
  /** The venue-exact output AT x=satCap -- always <= outVault (the fee/impact
   *  haircut only shrinks it further), so this is a SAFE, never-over-promising
   *  saturation value, not the true recovered amount (which needs inverting the
   *  full fee/impact/spline formula -- not attempted; this is a conservative
   *  lower bound). 0 if satCap itself is degenerate (fail-safe, never worse
   *  than the pre-fix collapse-to-0 behavior). */
  satOut: bigint;
}

function liveState(cfg: SolfiV2PoolConfig, state: AccountBytesMap, k: bigint, nowSlot?: bigint): LiveState | null {
  const pool = state[cfg.pool];
  const oracleRaw = state[cfg.oracle];
  const va = state[cfg.vaultA];
  const vb = state[cfg.vaultB];
  if (pool === undefined) throw new Error(`${SLUG} reference is missing pool ${cfg.pool}`);
  if (oracleRaw === undefined) throw new Error(`${SLUG} reference is missing oracle ${cfg.oracle}`);
  if (va === undefined || vb === undefined) throw new Error(`${SLUG} reference is missing a reserve vault`);

  const vaultA = readUintLE(va, AMOUNT_OFF, 8);
  const vaultB = readUintLE(vb, AMOUNT_OFF, 8);
  const slot = nowSlot ?? 0n;

  const w0 = readUintLE(oracleRaw, ORACLE_OFF_EXP, 8);
  const w1 = readUintLE(oracleRaw, ORACLE_OFF_MAN, 8);
  const w2 = readUintLE(oracleRaw, ORACLE_OFF_SLOT, 8);
  const oTs = readUintLE(oracleRaw, ORACLE_OFF_TS, 8);
  const w4 = readUintLE(oracleRaw, ORACLE_OFF_CONF, 8);
  const w5 = readUintLE(oracleRaw, ORACLE_OFF_EXPIRY_SLOT, 8);
  const w7 = readUintLE(oracleRaw, ORACLE_OFF_FEE_WORD, 8);
  const expRaw = w0 ^ ORACLE_KEY_WORDS[0];
  const man = w1 ^ ORACLE_KEY_WORDS[1];
  const oSlot = w2 ^ ORACLE_KEY_WORDS[2];
  const conf = w4 ^ ORACLE_KEY_WORDS[4];
  const expSlot = w5 ^ ORACLE_KEY_WORDS[5];
  const oFeeW = w7 ^ ORACLE_KEY_WORDS[7];
  const dir0 = cfg.direction === 0;
  const oFee = dir0 ? oFeeW >> 32n : oFeeW & 0xffffffffn;

  if (slot > expSlot) return null; // stale oracle -> deactivate

  const { mag: expMag, neg: expNeg } = signExtend(expRaw);
  const pow = 10n ** expMag;

  const numRaw = readUintLE(pool, OFF_SKEW_NUM, 8);
  const denRaw = readUintLE(pool, OFF_SKEW_DEN, 8);
  const hiRaw = readUintLE(pool, OFF_SKEW_HI, 8);
  const loMagRaw = readUintLE(pool, OFF_SKEW_LO_MAG, 8);
  const decayRaw = readUintLE(pool, OFF_DECAY_PPM, 8);
  const lastSwap = readUintLE(pool, OFF_LAST_SWAP_SLOT, 8);
  const feeScale = readUintLE(pool, OFF_FEE_SCALE, 8);
  const cachedTs = readUintLE(pool, OFF_CACHED_TS, 8);
  const spreadOff = dir0 ? OFF_SPREAD_DIR0 : OFF_SPREAD_DIR1;
  const sfRaw = readUintLE(pool, spreadOff, 4);
  let thr = readUintLE(pool, OFF_THRESHOLD, 4);
  if (thr === 0n) thr = 100n;

  const num = signExtend(numRaw);
  const den = signExtend(denRaw);
  const hi = signExtend(hiRaw);
  const loMag = signExtend(loMagRaw);
  const decay = signExtend(decayRaw);

  let convA = 0n;
  if (expNeg) convA = (vaultA * man) / pow;
  else convA = vaultA * man * pow;

  let diffMag = 0n;
  let diffNeg = false;
  if (vaultB >= convA) diffMag = vaultB - convA;
  else {
    diffNeg = true;
    diffMag = convA - vaultB;
  }
  const halfMag = diffMag / 2n;
  const halfNeg = diffNeg;
  const prodMag = halfMag * num.mag;
  const prodNeg = halfNeg !== num.neg;
  let skewMag = 0n;
  let skewNeg = false;
  if (den.mag !== 0n) {
    skewMag = prodMag / den.mag;
    skewNeg = prodNeg !== den.neg;
  }

  const bigImb = dir0 ? diffNeg && diffMag > 1n : !diffNeg && diffMag > 1n;
  if (!bigImb) {
    let age = 0n;
    if (slot >= lastSwap) age = slot - lastSwap;
    if (age > 100n) age = 100n;
    const dProdMag = skewMag * age * decay.mag;
    const dProdNeg = skewNeg !== decay.neg;
    const dMag = dProdMag / 100n;
    const dNeg = dProdNeg;
    const skewIsPos = !skewNeg && skewMag > 0n;
    if (skewIsPos) {
      let dLess = false;
      if (dNeg) dLess = true;
      else if (dMag < skewMag) dLess = true;
      if (dLess) {
        skewMag = dMag;
        skewNeg = dNeg;
      }
    } else {
      let dGreater = false;
      if (!dNeg && skewNeg) dGreater = true;
      else if (!dNeg && !skewNeg && dMag > skewMag) dGreater = true;
      else if (dNeg && skewNeg && dMag < skewMag) dGreater = true;
      if (dGreater) {
        skewMag = dMag;
        skewNeg = dNeg;
      }
    }
  }
  if (!skewNeg && skewMag > hi.mag) skewMag = hi.mag;
  if (skewNeg && skewMag > loMag.mag) skewMag = loMag.mag;
  if (skewNeg && skewMag > 10_000_000n) return null; // underflow -> deactivate

  let adjNum = 10_000_000n;
  if (!skewNeg) adjNum = 10_000_000n + skewMag;
  else adjNum = 10_000_000n - skewMag;
  const adjMan = (man * adjNum) / 10_000_000n;

  let sAge = 0n;
  if (slot >= oSlot) sAge = slot - oSlot;
  const ageKnots = readSplineRef(pool, OFF_SPLINE_AGE);
  let ag = solfiSplineRef(ageKnots, sAge);
  if (ag < 1000n) ag = 1000n;
  if (ag > 100_000n) ag = 100_000n;

  let sf = sfRaw;
  if (cachedTs < oTs) sf = 0n;
  let f2 = 100_000n;
  if (sf > thr) {
    let confClamped = conf;
    if (confClamped < 1000n) confClamped = 1000n;
    if (confClamped > 100_000n) confClamped = 100_000n;
    f2 = confClamped;
  }
  const sfKnots = readSplineRef(pool, OFF_SPLINE_SF);
  const s4 = solfiSplineRef(sfKnots, sf);

  const depthBase = dir0 ? OFF_SPLINE_D0 : OFF_SPLINE_D1;
  const depthKnots = readSplineRef(pool, depthBase);
  const outVault = dir0 ? vaultB : vaultA;
  const outCap110 = (outVault * 110n) / 100n;

  // satCap = preInv(outVault): solve pre(x) = outVault for x (the linear part
  // of the closed form, ignoring the fee/impact haircut -- see LiveState's
  // doc). Zero-guarded the same way emitQuoteAt/emitSetupLines already guard
  // adjMan divisions elsewhere in this file.
  let satCap = 0n;
  if (dir0) {
    if (expNeg) { if (adjMan !== 0n) satCap = (outVault * pow) / adjMan; } else { if (adjMan !== 0n) satCap = outVault / (adjMan * pow); }
  } else {
    satCap = expNeg ? (outVault * adjMan) / pow : outVault * adjMan * pow;
  }
  const partial: LiveState = { dir0, adjMan, pow, expNeg, ag, s4, oFee, f2, feeScale, k, outVault, outCap110, depthKnots, satCap: 0n, satOut: 0n };
  // Fail-safe: if satCap itself trips the impact/110% boundary (should never
  // happen -- rawOut(satCap) = outVault*(1e7-impact)/1e7 <= outVault <=
  // outCap110 always, so it's provably non-tripping; defensive only), satOut
  // stays 0 -- exactly today's pre-fix behavior for that edge, never worse.
  const satOut = satCap > 0n ? (solfiRawQuote(cfg, partial, satCap) ?? 0n) : 0n;

  return { ...partial, satCap, satOut };
}

/** Returns the venue-exact output at x, or null if x would trip the impact/110% revert boundary. */
function solfiRawQuote(cfg: SolfiV2PoolConfig, live: LiveState, x: bigint): bigint | null {
  let pre = 0n;
  if (live.dir0) {
    pre = live.expNeg ? (x * live.adjMan) / live.pow : x * live.adjMan * live.pow;
  } else {
    if (live.expNeg) pre = (x * live.pow) / live.adjMan;
    else if (live.adjMan !== 0n) pre = x / (live.adjMan * live.pow);
  }
  const bAmt = live.dir0 ? pre : x;
  const depth = solfiSplineRef(live.depthKnots, bAmt);
  const term = (live.ag * depth * live.f2 * live.feeScale) / 10_000_000_000_000n;
  const impact = live.s4 + live.oFee + live.k + term;
  if (impact > 10_000_000n) return null;
  const rawOut = (pre * (10_000_000n - impact)) / 10_000_000n;
  if (rawOut > live.outCap110) return null;
  return rawOut > live.outVault ? live.outVault : rawOut;
}

/**
 * KNOWN, BOUNDED residual: this function is pure/stateless (one x in, one
 * bigint out, no memory of other calls), so unlike referenceLadderQuotes/
 * referenceCapacities (which accumulate a running (lo, lx) max across a
 * grid and therefore CANNOT ever decrease by construction), this function
 * has no running state to bump-then-latch against. Right at the exact x
 * where solfiRawQuote first flips from a genuine (organically-clamped, up
 * to outVault) result to null, the frozen satOut can be SLIGHTLY LESS than
 * what an immediately-smaller x already achieved (satOut is a conservative
 * UNDER-estimate of outVault by design -- see LiveState's doc -- while the
 * organic per-call clamp can reach outVault itself before failing). This is
 * a narrow, ONE-TRANSITION dip bounded by the fee/impact haircut (a few bps
 * to low percent in practice), not a collapse -- categorically smaller than
 * the pre-fix defect (an unbounded drop to 0 for every x past the
 * boundary). Closing it fully needs either a second (bisection-style)
 * on-chain evaluation -- the exact CU cost this fix was designed to avoid
 * (solfi's rung already costs 162,332 CU) -- or an off-chain-only special
 * case that would diverge the mirror from the emitted fragment, which is
 * refused (see the module doc's "the mirror and the emitted fragment must
 * move together"). Documented, not hidden; the property test intentionally
 * probes a grid that does not adversarially target this one-wei transition.
 */
function solfiColdQuote(cfg: SolfiV2PoolConfig, live: LiveState, x: bigint): bigint {
  if (x === 0n) return 0n;
  const r = solfiRawQuote(cfg, live, x);
  if (r !== null) return r;
  // Past the impact/110% revert boundary: any x >= satCap is guaranteed to
  // deliver AT LEAST satOut (satCap itself never trips this boundary -- see
  // LiveState's doc), so report that instead of collapsing to 0. x < satCap
  // tripping here would be a genuinely different (non-vault-capacity)
  // failure this fix does not attempt to recover -- stays 0, unchanged.
  return live.satCap > 0n && x >= live.satCap ? live.satOut : 0n;
}

/** Placeholder knot-var lookup shared between emitLadderQuote/emitFinalQuote (the vars were declared in emitSetup). */
function knotVarsFor(p: string, tag: string): SplineKnotVars {
  const xs = Array.from({ length: 8 }, (_, i) => `${p}${tag}x${i}`);
  const ys = Array.from({ length: 8 }, (_, i) => `${p}${tag}y${i}`);
  return { xs, ys, len: `${p}${tag}len` };
}
