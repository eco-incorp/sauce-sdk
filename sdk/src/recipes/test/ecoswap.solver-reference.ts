/**
 * EcoSwap UNIFIED-WALK reference (pure TypeScript bigint math, EVM-free).
 *
 * Mirrors the on-chain unified solver in `recipes/ecoswap/ecoswap.sauce.ts` bit-for-bit:
 * ONE price-ordered k-way merge where every DIRECT pool has ONE frontier walked from its
 * LIVE spot, deeper, one tickSpacing per step, AND every multi-hop ROUTE is a first-class
 * live-walk venue (NO static segments). Each step picks the highest fee-adjusted out/in head
 * among {each active direct pool's walk head, each active route's composed product head},
 * consumes its segment into the pool/route, and advances ONLY that stream.
 *
 * THE UNIFIED MODEL — no two-mode cache-vs-re-anchor split, NO static route segments.
 * liquidityNet is drift-invariant, so the walk ALWAYS computes sqrt/price on the LIVE grid
 * (stepReal from the live spot, identical to the neutral oracle ecoswap.optimal.ts v3Segments/
 * legBrackets) and reuses the cached NET only. This reference is CURSOR-MECHANISM-FAITHFUL: it
 * builds the SAME per-pool netCache rows the on-chain pool tuple carries ([shiftedTick, rawNet],
 * only INITIALIZED ticks, sorted in SWAP DIRECTION — exactly prepare.ts's stampPoolCache), runs
 * the SAME SETUP drift-down skip, and reads an in-window boundary via that cursor (matching tick ⇒
 * cached net + advance; in-window non-match ⇒ net 0, NO map read) and an out-of-window boundary
 * via the FULL `adaptiveNet` map (the TS analogue of a live ticks()/getTickLiquidity staticcall).
 * Because the grid is the live grid and the nets are the drift-invariant nets, this reference is
 * wei-exact with the neutral oracle BY CONSTRUCTION — same grid, same nets.
 *
 * PER-POOL DIRECTION (flat universe). Direction is NOT a top-level constant: every pool — direct
 * or leg — drives toOutIn/stepReal/tickArg/SETUP from ITS OWN `inIsToken0` field (== that pool's
 * `zeroForOne`). A route's leg can swap in the opposite direction from the overall trade; its leg
 * pools carry the LEG's zHop in `inIsToken0`, so the per-pool walk code is reused unchanged. The
 * direct pools' `inIsToken0` equals the overall swap direction (token0 is the lower address).
 *
 * ROUTES = LIVE WALK (this branch). A route is a composite venue: an ordered list of LEGS, each a
 * SET of leg pools. Each leg pool gets its OWN live frontier (the same dn* state + net cursor a
 * direct pool gets, seeded by the same SETUP using the leg's zHop). A leg's CURRENT bracket is the
 * leg-internal best (the highest fee-adjusted out/in near among the leg's active pools — a
 * leg-internal price-ordered merge). The route's HEAD is the LEFT-TO-RIGHT product fold
 * (routeHeadFold) of the per-leg internal-best fee-adjusted heads — directly comparable to a direct
 * pool's head, so the route competes in the SAME global merge. Advancing a route resolves ONE event
 * via routeEventN / routePartialN (IMPORTED from ecoswap.math.ts, the single source the oracle uses
 * too — so the reference agrees with the oracle BY CONSTRUCTION): the BINDING leg's binding pool
 * crosses its tick (advances its frontier), every other leg partially fills (conservation at every
 * intermediate: leg i out == leg i+1 in). N-hop (k >= 2), V3 legs; the leg loop spans `legCount`
 * (3-hop concrete, 2-hop bit-identical).
 *
 * NO route price limit. The swap's REAL-sqrt priceLimit gates the DIRECT pools only (it is a bound
 * in the OVERALL swap direction). A route's legs are NOT individually limited by it — the on-chain
 * solver's route advance (ecoswap.sauce.ts Phase D) crosses a binding leg's tick with NO dlim
 * check; a route is bounded only by conservation + its participation in the global merge cut. This
 * also avoids comparing an opposite-direction leg's far against an overall-direction limit value.
 *
 * INLINE INVARIANTS (throw on violation): per-leg-pool cursor fidelity (cursorNet == mapNet for
 * every crossed in-window boundary), conservation ≤ 1 wei per route event (|leg i out − leg i+1
 * in|), strictly-descending route head (each consumed route segment's near ≤ the previous), and the
 * binding-leg partial landing within its current bracket. Any vector — not only the EVM lane —
 * catches a cursor off-by-one, a conservation slip, a non-monotone head, or an out-of-bracket
 * partial.
 *
 * The integer math (mulDiv truncation, the int128 sign recovery, stepReal, toOutIn, tickArg, the
 * sqrt fee-adjust, the route event/partial helpers) is the shared copies in ./ecoswap.math, so this
 * reference is bit-for-bit with both the on-chain solver and the neutral optimal oracle.
 */

import type { EcoPool, EcoRoute, EcoSwapPrepared } from "../shared/types";
import {
  Q96,
  FEE_DENOM,
  OFFSET,
  mulDiv,
  stepReal,
  toOutIn,
  HALF128,
  MOD128,
  tickArg,
  sqrtOneMinusFeeScaled,
  V2_STEP_BPS,
  V2_STEP_DEN,
  type RouteLeg,
  routeHeadFold,
  routeEventN,
  routePartialN,
  bracketGross,
  bracketOut,
} from "./ecoswap.math";

/** Modeled LIVE state for one pool (what the on-chain SETUP reads). */
export interface KwayLivePool {
  /** Live out/in spot sqrt. V2 frontier seed (sqrt(resOut*Q192/resIn)); unused for V3/V4. */
  curOI?: bigint;
  // V3/V4 live state (the frontier seed):
  liveRealSqrt?: bigint;
  liveTick?: number;
  liveL?: bigint;
  // V2 live state:
  liveV2L?: bigint; // sqrt(reserveIn*reserveOut)
}

export interface KwayReferenceResult {
  /** Gross input per DIRECT pool — indexed by prepared.pools (the universe's direct prefix). */
  perPoolInput: bigint[];
  /** Gross token-A input per route — indexed by prepared.routes. */
  perRouteInput: bigint[];
  totalInput: bigint;
  /**
   * The fee-adjusted out/in marginal price at the cut — the fee-adjusted FAR edge of the
   * last segment the merge consumed (the deepest reached). Diagnostic only: the on-chain
   * solver carries no cut, but a price-ordered merge's last consumed far edge IS the common
   * marginal every engaged pool equalizes to. Used by the prod-mirror equalization asserts.
   */
  cutSqrtAdj: bigint;
  /**
   * CURSOR-FIDELITY diagnostic: for EVERY in-window boundary the walk crossed, the net the
   * per-pool cursor produced MUST equal the net the full `adaptiveNet` map carries for that
   * tick (a cached initialized row, or 0 for an in-window uninitialized tick). Each crossing
   * appends `{ shifted, cursorNet, mapNet }`; the reference asserts equality inline (throws on
   * mismatch) so any vector catches it; this list lets a dedicated test assert the count and
   * that the cursor path was actually exercised (length > 0).
   */
  cursorChecks: { shifted: bigint; cursorNet: bigint; mapNet: bigint }[];
}

/** fee-adjusted out/in head price (sqrt(1-fee) scaling) — matches the solver feeAdj. */
function feeAdj(oi: bigint, feePpm: number): bigint {
  return (oi * sqrtOneMinusFeeScaled(feePpm)) / FEE_DENOM;
}

/**
 * Per-pool frontier walk budget — MUST match the on-chain solver's PER_POOL (ecoswap.sauce.ts)
 * AND the optimal oracle's MAX_V3_STEPS (ecoswap.optimal.ts) EXACTLY, so the reference and the
 * oracle agree to the wei EVEN WHEN THE CAP BINDS. See the on-chain solver for the gas-budget
 * justification of 2048.
 */
const PER_POOL = 2048;

/** ts-aligned SHIFTED base tick from an int tick — mirrors the solver's tickShiftedBase. */
function tickShiftedBaseTS(tick: number, ts: bigint): bigint {
  const shifted = BigInt(tick) + OFFSET;
  return (shifted / ts) * ts;
}

/** Per-universe-pool live frontier state (the on-chain dn/lArr/netCur/zArr/brFar bundle). */
interface Frontier {
  isV2: boolean;
  pType: number; // 1=V2 2=V4 else V3
  zeroForOne: boolean; // == the pool's inIsToken0 (the leg's zHop for a leg pool)
  feePpm: number;
  ts: bigint;
  stepRatio: bigint;
  on: boolean;
  near: bigint; // V3/V4 real sqrt; V2 out/in
  farReal: bigint; // V3/V4 bracket far real sqrt (re-anchored each cross / partial-latched)
  L: bigint;
  v2L: bigint; // V2 sqrt(resIn*resOut)
  shift: bigint; // next boundary (shifted tick)
  tsShift: bigint; // signed-magnitude tick step (== ts; advance is shift -= ts / += ts by dir)
  steps: number;
  // net cursor (the on-chain netCache mechanism):
  netRows: { shifted: bigint; raw: bigint }[];
  netCur: number;
  adaptiveNet: Map<number, bigint>;
  windowTop: bigint;
  windowBot: bigint;
  extreme: bigint;
  // route partial latch: the FIXED bracket far real sqrt while a leg partial-fills (0 ⇒ derive
  // one stepReal ahead). Mirrors the solver's brFar.
  brFar: bigint;
}

/** Seed one universe pool's frontier from its modeled LIVE spot (drift override or prepared spot). */
function seedFrontier(pd: EcoPool, lp: KwayLivePool | undefined): Frontier {
  const z = pd.inIsToken0;
  const f: Frontier = {
    isV2: pd.isV2,
    pType: pd.poolType,
    zeroForOne: z,
    feePpm: pd.feePpm,
    ts: BigInt(pd.tickSpacing),
    stepRatio: pd.stepRatio ?? 0n,
    on: false,
    near: 0n,
    farReal: 0n,
    L: 0n,
    v2L: 0n,
    shift: 0n,
    tsShift: BigInt(pd.tickSpacing),
    steps: 0,
    netRows: [],
    netCur: 0,
    adaptiveNet: pd.adaptiveNet ?? new Map<number, bigint>(),
    windowTop: pd.windowTopShifted ?? 0n,
    windowBot: pd.windowBotShifted ?? 0n,
    extreme: pd.extremeShifted ?? 0n,
    brFar: 0n,
  };

  if (pd.isV2) {
    // V2 frontier seed: a drift override (liveV2L/curOI), else the prepare-time spot the pool ships
    // (spotActiveL = √k, spotNearReal = out/in spot) — symmetric with the V3/V4 fallback below, and
    // matching the on-chain SETUP, which reads live reserves for EVERY V2 pool (direct or leg).
    const ll = lp?.liveV2L ?? pd.spotActiveL ?? 0n;
    f.v2L = ll;
    f.L = ll;
    f.on = ll > 0n;
    f.near = lp?.curOI ?? pd.spotNearReal ?? 0n; // V2 frontier stores out/in directly
    return f;
  }

  // V3/V4: live near sqrt + boundary + active L (a drift override, else the prepare-time spot).
  let near: bigint;
  let sh: bigint;
  let L: bigint;
  if (lp?.liveRealSqrt !== undefined) {
    near = lp.liveRealSqrt;
    const base = tickShiftedBaseTS(lp.liveTick ?? 0, f.ts);
    sh = z ? base : base + f.ts;
    L = lp.liveL ?? 0n;
  } else {
    near = pd.spotNearReal ?? 0n;
    sh = pd.spotTickShifted ?? 0n;
    L = pd.spotActiveL ?? 0n;
  }
  f.near = near;
  f.shift = sh;
  f.L = L;
  f.on = true;

  // netCache rows EXACTLY as prepare.ts's stampPoolCache: every INITIALIZED tick (signed net != 0),
  // shifted (tick + OFFSET) + RAW uint128, sorted in SWAP DIRECTION (zeroForOne descending shifted,
  // oneForZero ascending). Prefer the pool's prepared netRows; else derive from adaptiveNet.
  const rows: { shifted: bigint; raw: bigint }[] = [];
  if (pd.netRows && pd.netRows.length > 0) {
    for (const r of pd.netRows) rows.push({ shifted: r.shiftedTick, raw: r.rawNet });
  } else {
    for (const [tick, signed] of f.adaptiveNet) {
      if (signed === 0n) continue;
      const raw = signed >= 0n ? signed : signed + MOD128;
      rows.push({ shifted: BigInt(tick) + OFFSET, raw });
    }
  }
  rows.sort((a, b) =>
    z
      ? a.shifted < b.shifted ? 1 : a.shifted > b.shifted ? -1 : 0
      : a.shifted < b.shifted ? -1 : a.shifted > b.shifted ? 1 : 0,
  );
  f.netRows = rows;

  // SETUP drift-down skip: advance the cursor PAST any cache rows ABOVE the first boundary `sh`
  // (zeroForOne walks DOWN ⇒ a row above is shifted > sh; oneForZero walks UP ⇒ shifted < sh).
  let cur = 0;
  const nCount = rows.length;
  for (let q = 0; q < nCount; q++) {
    if (cur < nCount) {
      const rt = rows[cur].shifted;
      const above = z ? rt > sh : rt < sh;
      if (above) cur += 1;
    }
  }
  f.netCur = cur;
  return f;
}

/** This frontier's current out/in NEAR head (V3/V4 toOutIn; V2 stores out/in directly). */
function frontierNearOI(f: Frontier): bigint {
  return f.isV2 ? f.near : toOutIn(f.near, f.zeroForOne);
}

/** This frontier's current out/in FAR head (one stepReal ahead, or the latched bracket far). */
function frontierFarOI(f: Frontier): bigint {
  if (f.isV2) return f.near - mulDiv(f.near, V2_STEP_BPS, V2_STEP_DEN);
  const far = f.brFar > 0n ? f.brFar : stepReal(f.near, f.stepRatio, f.zeroForOne);
  return toOutIn(far, f.zeroForOne);
}

/** Build a RouteLeg [near, far, L, fee] for a leg pool's CURRENT bracket on the fixed live grid. */
function frontierBracket(f: Frontier): RouteLeg {
  return {
    nearOI: frontierNearOI(f),
    farOI: frontierFarOI(f),
    L: f.L,
    feePpm: BigInt(f.feePpm),
  };
}

/**
 * Cross ONE boundary on a V3/V4 frontier (update L by ±net, advance near/shift) reusing the cursor
 * mechanism + the gap-terminate gate. `cursorChecks` records every in-window crossing for the
 * cursor-fidelity invariant; `priceLimit > 0` deactivates the frontier on a binding limit (direct
 * pools only — a route binding cross passes 0n). Used by a direct-pool advance and a route bind.
 */
function crossV3Boundary(
  f: Frontier,
  priceLimit: bigint,
  cursorChecks: { shifted: bigint; cursorNet: bigint; mapNet: bigint }[],
): void {
  const z = f.zeroForOne;
  // The bracket far is the anchored boundary on the fixed live grid (the price the cross lands at).
  const farReal = f.brFar > 0n ? f.brFar : stepReal(f.near, f.stepRatio, z);
  let dlim = false;
  if (priceLimit > 0n) {
    if (z) {
      if (farReal <= priceLimit) dlim = true;
    } else {
      if (farReal >= priceLimit) dlim = true;
    }
  }

  // Net at the boundary — the CURSOR MECHANISM (in-window cursor / out-of-window map).
  const aNet = f.adaptiveNet;
  const wTop = f.windowTop;
  const wBot = f.windowBot;
  const wLo = wTop <= wBot ? wTop : wBot;
  const wHi = wTop <= wBot ? wBot : wTop;
  const inWindow = wTop > 0n && f.shift >= wLo && f.shift <= wHi;
  let raw: bigint;
  if (inWindow) {
    const mapSigned = aNet.get(Number(tickArg(f.shift))) ?? 0n;
    const mapRaw = mapSigned >= 0n ? mapSigned : mapSigned + MOD128;
    const rows = f.netRows;
    const cc = f.netCur;
    let cursorRaw = 0n;
    if (cc < rows.length && rows[cc].shifted === f.shift) {
      cursorRaw = rows[cc].raw;
      f.netCur = cc + 1;
    }
    cursorChecks.push({ shifted: f.shift, cursorNet: cursorRaw, mapNet: mapRaw });
    if (cursorRaw !== mapRaw) {
      throw new Error(
        `cursor net mismatch at shifted=${f.shift} (signedTick=${tickArg(f.shift)}): cursor=${cursorRaw} map=${mapRaw}`,
      );
    }
    raw = cursorRaw;
  } else {
    const signedNet = aNet.get(Number(tickArg(f.shift))) ?? 0n;
    raw = signedNet >= 0n ? signedNet : signedNet + MOD128;
  }

  const ts = f.tsShift;
  const neg = raw >= HALF128;
  let L = f.L;
  if (z) {
    if (neg) L = L + (MOD128 - raw);
    else L = L >= raw ? L - raw : 0n;
    f.shift -= ts;
  } else {
    if (neg) {
      const dm = MOD128 - raw;
      L = L >= dm ? L - dm : 0n;
    } else L = L + raw;
    f.shift += ts;
  }
  f.near = farReal;
  f.L = L;
  f.brFar = 0n; // crossed fully ⇒ next bracket re-derives its far one stepReal ahead

  if (dlim) f.on = false;
  if (L === 0n && f.extreme > 0n) {
    const pastExt = z ? f.shift < f.extreme : f.shift > f.extreme;
    if (pastExt) f.on = false;
  }
  f.steps += 1;
  if (f.steps >= PER_POOL) f.on = false;
}

/**
 * Move a V3/V4 frontier's NEAR to a partial far OI WITHOUT crossing a tick (the cut/partial-fill
 * lands interior to the current bracket). Convert the out/in far back to a real sqrt so the next
 * stepReal continues from the partial price (toOutIn is an involution). Latch the bracket far so a
 * later step measures the SAME fixed bracket (mirrors the solver's brFar). V2 stores out/in.
 */
function advanceFrontierNearTo(f: Frontier, partialFarOI: bigint): void {
  const farReal = f.brFar > 0n ? f.brFar : stepReal(f.near, f.stepRatio, f.zeroForOne);
  if (f.isV2) {
    f.near = partialFarOI;
  } else {
    f.near = toOutIn(partialFarOI, f.zeroForOne);
    if (f.brFar === 0n) f.brFar = farReal;
  }
}

interface LegSlice {
  idxs: number[]; // universe pool indices of this leg's pools
  zeroForOne: boolean; // the leg's hop direction
}

/**
 * The leg-internal best per leg: for each leg, the active pool with the HIGHEST fee-adjusted out/in
 * near (the leg-internal price-ordered merge — ties broken by higher far, mirroring the global
 * merge). Returns the binding-pool index per leg + the per-leg fee-adjusted near/far heads (the fold
 * inputs). null if any leg has no usable active pool (the route is inactive this step).
 */
function routeLegBest(
  legs: LegSlice[],
  fr: Frontier[],
): { poolIdx: number[]; nearAdjs: bigint[]; farAdjs: bigint[] } | null {
  const poolIdx: number[] = [];
  const nearAdjs: bigint[] = [];
  const farAdjs: bigint[] = [];
  for (const leg of legs) {
    let best = -1;
    let bestAdj = 0n;
    let bestFarAdj = 0n;
    for (const idx of leg.idxs) {
      const f = fr[idx];
      if (!f.on) continue;
      const oi = frontierNearOI(f);
      const adj = feeAdj(oi, f.feePpm);
      if (adj >= bestAdj) {
        const farAdj = feeAdj(frontierFarOI(f), f.feePpm);
        if (best < 0 || adj > bestAdj || (adj === bestAdj && farAdj > bestFarAdj)) {
          bestAdj = adj;
          bestFarAdj = farAdj;
          best = idx;
        }
      }
    }
    if (best < 0) return null;
    poolIdx.push(best);
    nearAdjs.push(bestAdj);
    farAdjs.push(bestFarAdj);
  }
  return { poolIdx, nearAdjs, farAdjs };
}

/**
 * Advance one ROUTE by ONE event (or partial fill if it is the crossing venue). Mirrors the solver's
 * route Phase A–D: per-leg binding pool + current bracket; routeEventN; conservation assert at every
 * intermediate; if the remaining budget caps the event, routePartialN fills interior (no cross);
 * else the binding leg crosses its bracket and its frontier steps, every other leg's near advances
 * to the event's new far. NO priceLimit on a route cross (see file header). Returns route token-A in.
 */
function advanceRoute(
  legs: LegSlice[],
  fr: Frontier[],
  cap: bigint,
  cursorChecks: { shifted: bigint; cursorNet: bigint; mapNet: bigint }[],
  head: bigint,
  prevRouteHead: bigint[],
  routeIdx: number,
): { routeIn: bigint } {
  // Strictly-descending route head invariant: each consumed route segment's near must be <= the
  // previous (a price-ordered merge emits descending segments). Allow the first (prev 0).
  if (prevRouteHead[routeIdx] !== 0n && head > prevRouteHead[routeIdx]) {
    throw new Error(
      `route ${routeIdx} head not descending: ${head} > prev ${prevRouteHead[routeIdx]}`,
    );
  }
  prevRouteHead[routeIdx] = head;

  const best = routeLegBest(legs, fr);
  if (best === null) return { routeIn: 0n };
  const k = best.poolIdx.length;
  const iLeg = best.poolIdx;
  const legBr: RouteLeg[] = iLeg.map((idx) => frontierBracket(fr[idx]));

  const ev = routeEventN(legBr);

  // Conservation at EVERY intermediate: token X_i leg i PRODUCES == gross X_i leg i+1 PULLS for the
  // bound event (leg i out == leg i+1 in). Compute both from the event's new fars and bound the
  // residue. The forward/back inversion round-trips an integer truncation per leg boundary (the fee
  // divide in invertFarFromGrossIn then the multiply in bracketGross), so a k-leg chain accumulates
  // at most ~1 wei per upstream boundary of leg i+1 — bound it by `k` wei (slack-bounded, NOT a
  // wei-exact gate; the wei-exact gate is reference == oracle, asserted by the caller).
  const consTol = BigInt(k);
  for (let i = 0; i + 1 < k; i++) {
    const xOut = bracketOut(legBr[i].L, legBr[i].nearOI, ev.newFars[i]);
    const xIn = bracketGross(legBr[i + 1].L, legBr[i + 1].nearOI, ev.newFars[i + 1], legBr[i + 1].feePpm);
    const cons = xOut > xIn ? xOut - xIn : xIn - xOut;
    if (cons > consTol) {
      throw new Error(
        `route ${routeIdx} conservation slip at intermediate ${i}: |${xOut} - ${xIn}| = ${cons} > ${consTol}`,
      );
    }
  }

  if (cap < ev.routeIn) {
    // The route is the crossing venue: take exactly the remainder via a forward partial fill, NOT
    // advancing past the cut. The binding test guarantees each leg's partial lands within its
    // bracket; assert it per leg, then advance every leg's near to its partial far (interior).
    const part = routePartialN(legBr, cap);
    for (let i = 0; i < k; i++) {
      const f = part.newFars[i];
      if (f < legBr[i].farOI || f > legBr[i].nearOI) {
        throw new Error(
          `route ${routeIdx} leg ${i} partial out of bracket: f=${f} not in [${legBr[i].farOI}, ${legBr[i].nearOI}]`,
        );
      }
      advanceFrontierNearTo(fr[iLeg[i]], f);
    }
    return { routeIn: cap };
  }

  // Full event: the BINDING leg crosses its bracket (its frontier steps the tick); every OTHER leg's
  // near advances to the event's new far (interior — no cross). NO priceLimit on the binding cross.
  for (let i = 0; i < k; i++) {
    if (i === ev.bindLeg) {
      crossV3Boundary(fr[iLeg[i]], 0n, cursorChecks);
    } else {
      advanceFrontierNearTo(fr[iLeg[i]], ev.newFars[i]);
    }
  }
  return { routeIn: ev.routeIn };
}

/**
 * Unified-walk reference. `live[i]` is the modeled live state for the i-th UNIVERSE pool (the flat
 * `[...directPools, ...legPools]` order index.ts builds); default (omitted) uses the prepare-time
 * spot (no drift). `directCount` = prepared.pools.length leading entries are DIRECT venues; the rest
 * are leg pools reached solely via `prepared.routes`. Per-pool direction comes from each pool's
 * `inIsToken0`. `priceLimit` is the swap's real-sqrt price limit (DIRECT pools only).
 */
export function kwayReference(
  prepared: EcoSwapPrepared,
  amountIn: bigint,
  live?: (KwayLivePool | undefined)[],
): KwayReferenceResult {
  const { pools, routes } = prepared;
  const priceLimit = prepared.priceLimit;

  // ── Build the FLAT POOL UNIVERSE exactly as index.ts buildPoolUniverseAndRouting: the direct
  // pools, then each route leg's pools appended contiguously, DEDUPED by lowercased address. The
  // routing metadata records, per route, the per-leg universe-index slices + the leg direction. ──
  const directCount = pools.length;
  const universe: EcoPool[] = [...pools];
  const indexByAddr = new Map<string, number>();
  pools.forEach((p, i) => indexByAddr.set(p.address.toLowerCase(), i));

  const routeLegs: LegSlice[][] = [];
  for (const route of routes as EcoRoute[]) {
    const legs: LegSlice[] = [];
    for (const leg of route.legs) {
      const idxs: number[] = [];
      for (const lp of leg.pools) {
        const key = lp.address.toLowerCase();
        let idx = indexByAddr.get(key);
        if (idx === undefined) {
          idx = universe.length;
          universe.push(lp);
          indexByAddr.set(key, idx);
        }
        idxs.push(idx);
      }
      legs.push({ idxs, zeroForOne: leg.zeroForOne });
    }
    routeLegs.push(legs);
  }

  const perPoolInput: bigint[] = new Array(directCount).fill(0n);
  const perRouteInput: bigint[] = new Array(routes.length).fill(0n);
  const cursorChecks: { shifted: bigint; cursorNet: bigint; mapNet: bigint }[] = [];

  // Outer bound: dominate the SUM of every frontier's reach + the route events so the cap never
  // truncates a fill the per-pool / per-route caps would complete (mirrors the solver's SAFETY).
  const SAFETY = universe.length * PER_POOL * 2 + routes.length * PER_POOL + 16;

  // ── SETUP: seed every universe pool's single frontier from its modeled LIVE spot ──
  const fr: Frontier[] = new Array(universe.length);
  for (let i = 0; i < universe.length; i++) {
    fr[i] = seedFrontier(universe[i], live?.[i]);
  }

  // ── MERGE ──
  let cum = 0n;
  let cutSqrtAdj = 0n;
  const prevRouteHead: bigint[] = new Array(routes.length).fill(0n);

  for (let s = 0; s < SAFETY; s++) {
    if (cum >= amountIn) break;

    // 1. Find the highest fee-adjusted head among {each active direct pool, each active route}. Ties
    // on the near (entry) price break by HIGHER far (shallower step) — bit-identical to the oracle's
    // segment sort (adjNear DESC, adjFar DESC) and the solver's hot loop.
    let bestKind = 0; // 0=none 2=route 3=direct pool frontier
    let bestRef = 0; // route index OR direct-pool index
    let bestPrice = 0n;
    let bestFar = 0n;

    // 1a. direct pools (universe [0, directCount)).
    for (let j = 0; j < directCount; j++) {
      const f = fr[j];
      if (!f.on) continue;
      const doi = frontierNearOI(f);
      const dadj = feeAdj(doi, f.feePpm);
      // LAZY far-adjust (mirrors the solver): the far is only the near-tie break, so a pool whose
      // near is strictly below the best can never win — skip its far. Result-identical to eager.
      if (dadj >= bestPrice) {
        const dfarAdj = feeAdj(frontierFarOI(f), f.feePpm);
        if (dadj > bestPrice || (dadj === bestPrice && dfarAdj > bestFar)) {
          bestPrice = dadj;
          bestFar = dfarAdj;
          bestKind = 3;
          bestRef = j;
        }
      }
    }

    // 1b. routes: head = product fold of each leg's internal-best fee-adjusted near. A route is
    // active only if EVERY leg has at least one active pool with a usable bracket.
    for (let r = 0; r < routes.length; r++) {
      const legBest = routeLegBest(routeLegs[r], fr);
      if (legBest === null) continue;
      const head = routeHeadFold(legBest.nearAdjs);
      if (head >= bestPrice) {
        const farHead = routeHeadFold(legBest.farAdjs);
        if (head > bestPrice || (head === bestPrice && farHead > bestFar)) {
          bestPrice = head;
          bestFar = farHead;
          bestKind = 2;
          bestRef = r;
        }
      }
    }

    if (bestKind === 0) break;

    if (bestKind === 3) {
      // ── advance a DIRECT pool by one bracket ──
      const f = fr[bestRef];
      const dfee = f.feePpm;
      if (f.isV2) {
        const v2Near = f.near;
        const v2Far = v2Near - mulDiv(v2Near, V2_STEP_BPS, V2_STEP_DEN);
        if (f.v2L > 0n && v2Near > v2Far && v2Far > 0n) {
          const v2eff = mulDiv(f.v2L, Q96, v2Far) - mulDiv(f.v2L, Q96, v2Near);
          if (v2eff > 0n) {
            const v2g = mulDiv(v2eff, FEE_DENOM, FEE_DENOM - BigInt(dfee));
            let v2t = v2g;
            if (cum + v2g >= amountIn) v2t = amountIn - cum;
            perPoolInput[bestRef] += v2t;
            cum += v2t;
            if (v2t > 0n) cutSqrtAdj = feeAdj(v2Far, dfee);
          }
        }
        f.near = v2Far;
        if (v2Far <= 0n) f.on = false;
        f.steps += 1;
        if (f.steps >= PER_POOL) f.on = false;
      } else {
        const dnearOI = frontierNearOI(f);
        const dfarOI = frontierFarOI(f);
        if (f.L > 0n && dnearOI > dfarOI && dfarOI > 0n) {
          const deff = mulDiv(f.L, Q96, dfarOI) - mulDiv(f.L, Q96, dnearOI);
          if (deff > 0n) {
            const dg = mulDiv(deff, FEE_DENOM, FEE_DENOM - BigInt(dfee));
            let dt = dg;
            if (cum + dg >= amountIn) dt = amountIn - cum;
            perPoolInput[bestRef] += dt;
            cum += dt;
            if (dt > 0n) cutSqrtAdj = feeAdj(dfarOI, dfee);
          }
        }
        crossV3Boundary(f, priceLimit, cursorChecks);
      }
    } else {
      // ── advance a ROUTE by one event ──
      const r = bestRef;
      const cap = amountIn - cum;
      const taken = advanceRoute(routeLegs[r], fr, cap, cursorChecks, bestPrice, prevRouteHead, r);
      perRouteInput[r] += taken.routeIn;
      cum += taken.routeIn;
      if (taken.routeIn > 0n) cutSqrtAdj = bestFar;
    }
  }

  const totalInput =
    perPoolInput.reduce((a, b) => a + b, 0n) + perRouteInput.reduce((a, b) => a + b, 0n);
  return { perPoolInput, perRouteInput, totalInput, cutSqrtAdj, cursorChecks };
}
