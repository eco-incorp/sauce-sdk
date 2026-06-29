/**
 * EcoSwap UNIFIED-WALK reference (pure TypeScript bigint math, EVM-free).
 *
 * Mirrors the on-chain unified solver in `recipes/ecoswap/ecoswap.sauce.ts` bit-for-bit:
 * ONE price-ordered k-way merge where every direct pool has ONE frontier walked from its
 * LIVE spot, deeper, one tickSpacing per step. Each step picks the highest fee-adjusted
 * out/in head among {each active pool's walk head, each route segment head}, consumes its
 * segment into the pool/route, and advances ONLY that stream.
 *
 * THE UNIFIED MODEL — no two-mode cache-vs-re-anchor split. liquidityNet is drift-invariant,
 * so the walk ALWAYS computes sqrt/price on the LIVE grid (stepReal from the live spot,
 * identical to the neutral oracle ecoswap.optimal.ts v3Segments) and reuses the cached NET
 * only. This reference is CURSOR-MECHANISM-FAITHFUL: it builds the SAME per-pool netCache rows
 * the on-chain pool tuple carries ([shiftedTick, rawNet], only INITIALIZED ticks, sorted in
 * SWAP DIRECTION — exactly prepare.ts's stampPoolCache), runs the SAME SETUP drift-down skip
 * (advance the per-pool cursor past cache rows ABOVE the first boundary), and in the walk reads
 * an IN-WINDOW boundary via that cursor (matching tick ⇒ cached net + advance; in-window
 * non-match ⇒ net 0, NO map read) and an OUT-OF-WINDOW boundary via the FULL `adaptiveNet` map
 * (the TS analogue of a live ticks()/getTickLiquidity staticcall — drift-invariant, returns the
 * same value). So the reference is STRUCTURALLY identical to the solver, not just value-
 * equivalent: an off-by-one in the cursor (drift-down skip, in-window consume/advance, in-window
 * uninitialized net=0, out-of-window read) is caught here, not only in the EVM lane. Because the
 * grid is the live grid and the nets are the drift-invariant nets, this reference is wei-exact
 * with the neutral oracle BY CONSTRUCTION — same grid, same nets.
 *
 * WALK-THROUGH GAPS: a frontier deactivates only on the price limit, the per-pool budget cap,
 * or (dL==0 AND the boundary is PAST the pool's deepest initialized tick extremeShifted) — so
 * an interior dL==0 gap keeps walking and resumes when net brings L back (the Issue-2 fix).
 *
 * It takes the SAME prepared dataset the on-chain solver reads (the EcoPool unified-walk
 * fields stepRatio/windowTop/windowBot/extremeShifted/spotTickShifted/spotActiveL + the
 * off-chain adaptiveNet map + routeSegs) plus the modeled LIVE state per pool (the on-chain
 * SETUP read). In the deterministic no-drift case the modeled live == the prepare-time spot.
 *
 * The integer math (mulDiv truncation, the int128 sign recovery, stepReal, toOutIn, tickArg,
 * the sqrt fee-adjust) is the shared copies in ./ecoswap.math, so this reference is bit-for-
 * bit with both the on-chain solver and the neutral optimal oracle (ecoswap.optimal).
 */

import { EcoBracketKind, type EcoSwapPrepared } from "../shared/types";
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
  perPoolInput: bigint[];
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
   * appends `{ shifted, cursorNet, mapNet }`; a non-zero count of rows where cursorNet !=
   * mapNet is a cursor off-by-one (drift-down skip overshoot/undershoot, a missed advance, or
   * an in-window uninitialized tick that wrongly consumed a row). The reference itself asserts
   * equality inline (throws on mismatch) so any vector catches it; this list lets a dedicated
   * test assert the count and that the cursor path was actually exercised (length > 0).
   */
  cursorChecks: { shifted: bigint; cursorNet: bigint; mapNet: bigint }[];
}

/** fee-adjusted out/in head price (sqrt(1-fee) scaling) — matches the solver feeAdj. */
function feeAdj(oi: bigint, feePpm: number): bigint {
  return (oi * sqrtOneMinusFeeScaled(feePpm)) / FEE_DENOM;
}

/**
 * Per-pool frontier walk budget — MUST match the on-chain solver's PER_POOL
 * (ecoswap.sauce.ts) AND the optimal oracle's MAX_V3_STEPS (ecoswap.optimal.ts) EXACTLY, so
 * the reference and the oracle agree to the wei EVEN WHEN THE CAP BINDS (both bound the SINGLE
 * from-live-spot walk by the same cap). The outer merge bound is routeSegs.length +
 * pools.length*PER_POOL*2 (generous slack), which dominates the SUM of per-pool reaches so it
 * never itself truncates a fill the per-pool caps would complete. See the on-chain solver for
 * the gas-budget justification of 2048.
 */
const PER_POOL = 2048;

/** ts-aligned SHIFTED base tick from an int tick — mirrors the solver's tickShiftedBase. */
function tickShiftedBaseTS(tick: number, ts: bigint): bigint {
  const shifted = BigInt(tick) + OFFSET;
  return (shifted / ts) * ts;
}

/**
 * Unified-walk reference. `live[i]` is the modeled live state for pools[i]; default (omitted)
 * uses the prepare-time spot (no drift): V3/V4 from spotTickShifted/topReal/spotActiveL, V2
 * curOI from the prepared spot out/in. `priceLimit` is the swap's real-sqrt price limit.
 */
export function kwayReference(
  prepared: EcoSwapPrepared,
  amountIn: bigint,
  live?: (KwayLivePool | undefined)[],
): KwayReferenceResult {
  const { pools, routes } = prepared;
  const zeroForOne = prepared.zeroForOne;
  const priceLimit = prepared.priceLimit;
  // The flat route segments (sorted DESC sqrtAdjNear), competing via one cursor. Held as a
  // thin slice of the prepared brackets (kind === Route) to keep the existing prepared shape.
  const routeSegs = (prepared.brackets ?? []).filter((b) => b.kind === EcoBracketKind.Route);
  // Run-until-filled bound: dominate the oracle's total reach so the cap can never truncate a
  // trade the oracle fully fills.
  const SAFETY = routeSegs.length + pools.length * PER_POOL * 2;
  const perPoolInput: bigint[] = new Array(pools.length).fill(0n);
  const perRouteInput: bigint[] = new Array(routes.length).fill(0n);

  // ── SETUP: seed the single frontier from the modeled LIVE spot ──
  const lArr: bigint[] = new Array(pools.length).fill(0n);
  const dnOn: boolean[] = new Array(pools.length).fill(false);
  const dnNear: bigint[] = new Array(pools.length).fill(0n); // V3/V4 real sqrt; V2 out/in
  const dnL: bigint[] = new Array(pools.length).fill(0n);
  const dnShift: bigint[] = new Array(pools.length).fill(0n);
  const dnSteps: number[] = new Array(pools.length).fill(0);
  // Per-pool net cursor state — the on-chain netCache mechanism, mirrored EXACTLY. Each pool
  // gets its [shiftedTick, rawNet] rows (only INITIALIZED ticks, sorted SWAP DIRECTION — the
  // identical build prepare.ts's stampPoolCache flattens into the compiler netCache arg), a
  // cursor (netCur) positioned by the SETUP drift-down skip, and the window bounds.
  const netRows: { shifted: bigint; raw: bigint }[][] = new Array(pools.length);
  const netCur: number[] = new Array(pools.length).fill(0);
  const cursorChecks: { shifted: bigint; cursorNet: bigint; mapNet: bigint }[] = [];

  for (let i = 0; i < pools.length; i++) {
    const pd = pools[i];
    const lp = live?.[i];
    netRows[i] = [];
    if (pd.isV2) {
      // V2: constant-L stream from the LIVE out/in spot (no ticks, no cache). The deterministic
      // caller supplies liveV2L (+ curOI); default no-drift derives nothing (caller always sets).
      const ll = lp?.liveV2L ?? 0n;
      lArr[i] = ll;
      dnOn[i] = ll > 0n;
      dnNear[i] = lp?.curOI ?? 0n; // V2 frontier stores OUT/IN directly
      dnL[i] = ll;
      dnShift[i] = 0n;
    } else {
      const ts = BigInt(pd.tickSpacing);
      // Live near sqrt + boundary + active L: a drift override, else the prepare-time spot.
      let near: bigint;
      let sh: bigint;
      let L: bigint;
      if (lp?.liveRealSqrt !== undefined) {
        near = lp.liveRealSqrt;
        const base = tickShiftedBaseTS(lp.liveTick ?? 0, ts);
        sh = zeroForOne ? base : base + ts;
        L = lp.liveL ?? 0n;
      } else {
        near = pd.spotNearReal ?? 0n;
        sh = pd.spotTickShifted ?? 0n;
        L = pd.spotActiveL ?? 0n;
      }
      dnNear[i] = near;
      dnShift[i] = sh;
      dnL[i] = L;
      dnOn[i] = true;

      // Build this pool's netCache rows EXACTLY as prepare.ts's stampPoolCache does: every
      // INITIALIZED tick (signed net != 0), shifted (tick + OFFSET) + RAW uint128 (signed >= 0 ?
      // signed : signed + 2^128), sorted in SWAP DIRECTION (zeroForOne descending shifted tick,
      // oneForZero ascending). Prefer the pool's prepared netRows when present (the exact rows the
      // solver ships); else derive from adaptiveNet so a fixture that only sets the map still
      // exercises the cursor (the two builds are identical by construction).
      const rows: { shifted: bigint; raw: bigint }[] = [];
      if (pd.netRows && pd.netRows.length > 0) {
        for (const r of pd.netRows) rows.push({ shifted: r.shiftedTick, raw: r.rawNet });
      } else {
        const aNet = pd.adaptiveNet ?? new Map<number, bigint>();
        for (const [tick, signed] of aNet) {
          if (signed === 0n) continue;
          const raw = signed >= 0n ? signed : signed + MOD128;
          rows.push({ shifted: BigInt(tick) + OFFSET, raw });
        }
      }
      rows.sort((a, b) =>
        zeroForOne
          ? a.shifted < b.shifted ? 1 : a.shifted > b.shifted ? -1 : 0
          : a.shifted < b.shifted ? -1 : a.shifted > b.shifted ? 1 : 0,
      );
      netRows[i] = rows;

      // SETUP drift-down skip (ecoswap.sauce.ts ~224-246): advance the per-pool cursor PAST any
      // cache rows that lie ABOVE the first boundary `sh` (the live spot has already moved below
      // them, so the walk never crosses them). Swap-direction terms: zeroForOne walks DOWN, so a
      // row above is shifted > sh; oneForZero walks UP, so a row above is shifted < sh.
      let cur = 0;
      const nCount = rows.length;
      if (nCount > 0) {
        // Mirror the solver's bounded loop (it can advance at most nCount times); a row stops
        // skipping as soon as one is at/below the boundary (rows are sorted swap-direction).
        for (let q = 0; q < nCount; q++) {
          if (cur < nCount) {
            const rt = rows[cur].shifted;
            const above = zeroForOne ? rt > sh : rt < sh;
            if (above) cur += 1;
          }
        }
      }
      netCur[i] = cur;
    }
  }

  // ── MERGE ──
  let cum = 0n;
  let rc = 0; // route-segment cursor
  let cutSqrtAdj = 0n;
  for (let s = 0; s < SAFETY; s++) {
    if (cum >= amountIn) break;

    // 1. find the highest fee-adjusted head among {route cursor, dn[*]}. Ties on the near
    // (entry) price break by HIGHER far (shallower step) so a coarse segment never wins ahead
    // of a finer one — bit-identical to the optimal oracle's stable segment sort (adjNear DESC,
    // adjFar DESC). Same key the solver uses.
    let bestKind = 0; // 0=none 2=route 3=pool frontier
    let bestPool = 0;
    let bestPrice = 0n;
    let bestFar = 0n;
    if (rc < routeSegs.length) {
      const rg = routeSegs[rc];
      const rp = rg.sqrtAdjNear;
      if (rp > bestPrice) {
        bestPrice = rp;
        bestFar = rg.sqrtAdjFar;
        bestKind = 2;
      }
    }
    for (let j = 0; j < pools.length; j++) {
      const jd = pools[j];
      const jfee = jd.feePpm;
      if (dnOn[j]) {
        const doi = jd.isV2 ? dnNear[j] : toOutIn(dnNear[j], zeroForOne);
        const dadj = feeAdj(doi, jfee);
        // LAZY far-adjust (mirrors ecoswap.sauce.ts): the far price is ONLY the near-tie break,
        // so a pool whose near is strictly below the best can never win — skip its far. RESULT-
        // identical to an eager far (the winner is unchanged either way), and keeps this
        // reference structurally faithful to the solver's hot loop.
        if (dadj >= bestPrice) {
          let dfarAdj: bigint;
          if (jd.isV2) {
            const v2Far = dnNear[j] - mulDiv(dnNear[j], V2_STEP_BPS, V2_STEP_DEN);
            dfarAdj = feeAdj(v2Far, jfee);
          } else {
            const farReal = stepReal(dnNear[j], jd.stepRatio ?? 0n, zeroForOne);
            dfarAdj = feeAdj(toOutIn(farReal, zeroForOne), jfee);
          }
          if (dadj > bestPrice || (dadj === bestPrice && dfarAdj > bestFar)) {
            bestPrice = dadj;
            bestFar = dfarAdj;
            bestKind = 3;
            bestPool = j;
          }
        }
      }
    }

    if (bestKind === 0) break;

    if (bestKind === 2) {
      const rg = routeSegs[rc];
      const rdx = rg.refIdx;
      const cap = rg.capacity;
      let rtake = cap;
      if (cum + cap >= amountIn) rtake = amountIn - cum;
      perRouteInput[rdx] += rtake;
      cum += rtake;
      if (rtake > 0n) cutSqrtAdj = rg.sqrtAdjFar;
      rc++;
    } else if (bestKind === 3) {
      const dd = pools[bestPool];
      const dfee = dd.feePpm;
      if (dd.isV2) {
        const v2L = lArr[bestPool];
        const v2Near = dnNear[bestPool];
        const v2Far = v2Near - mulDiv(v2Near, V2_STEP_BPS, V2_STEP_DEN);
        if (v2L > 0n && v2Near > v2Far && v2Far > 0n) {
          const v2eff = mulDiv(v2L, Q96, v2Far) - mulDiv(v2L, Q96, v2Near);
          if (v2eff > 0n) {
            const v2g = mulDiv(v2eff, FEE_DENOM, FEE_DENOM - BigInt(dfee));
            let v2t = v2g;
            if (cum + v2g >= amountIn) v2t = amountIn - cum;
            perPoolInput[bestPool] += v2t;
            cum += v2t;
            if (v2t > 0n) cutSqrtAdj = feeAdj(v2Far, dfee);
          }
        }
        dnNear[bestPool] = v2Far;
        if (v2Far <= 0n) dnOn[bestPool] = false;
        dnSteps[bestPool] += 1;
        if (dnSteps[bestPool] >= PER_POOL) dnOn[bestPool] = false;
      } else {
        // V3/V4 frontier step — tick walk on the LIVE grid, net from the prepared per-pool map.
        let dL = dnL[bestPool];
        const dts = BigInt(dd.tickSpacing);
        const dstep = dd.stepRatio ?? 0n;
        let dnear = dnNear[bestPool];
        let dsh = dnShift[bestPool];
        const dfarReal = stepReal(dnear, dstep, zeroForOne);
        const dnearOI = toOutIn(dnear, zeroForOne);
        const dfarOI = toOutIn(dfarReal, zeroForOne);
        let dlim = false;
        if (zeroForOne) {
          if (dfarReal <= priceLimit) dlim = true;
        } else {
          if (dfarReal >= priceLimit) dlim = true;
        }
        if (dL > 0n && dnearOI > dfarOI && dfarOI > 0n) {
          const deff = mulDiv(dL, Q96, dfarOI) - mulDiv(dL, Q96, dnearOI);
          if (deff > 0n) {
            const dg = mulDiv(deff, FEE_DENOM, FEE_DENOM - BigInt(dfee));
            let dt = dg;
            if (cum + dg >= amountIn) dt = amountIn - cum;
            perPoolInput[bestPool] += dt;
            cum += dt;
            if (dt > 0n) cutSqrtAdj = feeAdj(dfarOI, dfee);
          }
        }
        // Net at the boundary — the CURSOR MECHANISM, mirrored bit-for-bit (ecoswap.sauce.ts
        // ~355-376). IN-WINDOW (windowTop > 0 AND windowBot <= dsh <= windowTop): read the
        // per-pool netCache cursor — a matching row (row.shifted === dsh) consumes its raw net
        // and advances the cursor; an in-window NON-match is net 0 (an uninitialized tick — NO
        // map read, the cursor does NOT advance). OUT-OF-WINDOW (no cache, or the boundary is
        // outside the scanned span — the drift-up region above windowTop or a deep fill below
        // windowBot): read the FULL `adaptiveNet` map (the TS analogue of a live ticks()/
        // getTickLiquidity staticcall — drift-invariant, returns the SAME raw net).
        const aNet = dd.adaptiveNet ?? new Map<number, bigint>();
        const wTop = dd.windowTopShifted ?? 0n;
        const wBot = dd.windowBotShifted ?? 0n;
        // Order-agnostic window test (mirrors the solver): the bounds are the shallowest/deepest
        // scanned boundaries in shifted-tick space, and their ORDER flips by swap direction
        // (zeroForOne wBot <= wTop; oneForZero wBot >= wTop). Accept dsh within [min, max] so the
        // cursor cache engages for BOTH directions.
        const wLo = wTop <= wBot ? wTop : wBot;
        const wHi = wTop <= wBot ? wBot : wTop;
        const inWindow = wTop > 0n && dsh >= wLo && dsh <= wHi;
        let raw: bigint;
        if (inWindow) {
          // The drift-invariant truth for THIS tick (what an out-of-window staticcall WOULD
          // return) — the cursor-path net must equal it for every crossed in-window boundary.
          const mapSigned = aNet.get(Number(tickArg(dsh))) ?? 0n;
          const mapRaw = mapSigned >= 0n ? mapSigned : mapSigned + MOD128;
          const rows = netRows[bestPool];
          const cc = netCur[bestPool];
          let cursorRaw = 0n;
          if (cc < rows.length && rows[cc].shifted === dsh) {
            cursorRaw = rows[cc].raw;
            netCur[bestPool] = cc + 1;
          }
          // Cursor fidelity: the cursor-path net for this in-window boundary MUST equal the
          // full-map net (a cached initialized row, or 0 for an in-window uninitialized tick).
          // Record + assert inline so any vector (not only the EVM lane) catches a cursor
          // off-by-one — the drift-down skip leaving the cursor on the wrong row, a missed
          // advance, or an uninitialized tick wrongly consuming a row.
          cursorChecks.push({ shifted: dsh, cursorNet: cursorRaw, mapNet: mapRaw });
          if (cursorRaw !== mapRaw) {
            throw new Error(
              `cursor net mismatch at shifted=${dsh} (signedTick=${tickArg(dsh)}): cursor=${cursorRaw} map=${mapRaw}`,
            );
          }
          raw = cursorRaw;
        } else {
          const signedNet = aNet.get(Number(tickArg(dsh))) ?? 0n;
          raw = signedNet >= 0n ? signedNet : signedNet + MOD128;
        }
        const neg = raw >= HALF128;
        if (zeroForOne) {
          if (neg) dL = dL + (MOD128 - raw);
          else dL = dL >= raw ? dL - raw : 0n;
          dsh -= dts;
        } else {
          if (neg) {
            const dm = MOD128 - raw;
            dL = dL >= dm ? dL - dm : 0n;
          } else dL = dL + raw;
          dsh += dts;
        }
        dnNear[bestPool] = dfarReal;
        dnL[bestPool] = dL;
        dnShift[bestPool] = dsh;
        // TERMINATE only on: price limit, OR budget cap, OR (dL==0 AND boundary PAST the
        // deepest initialized tick). Walk THROUGH interior dL==0 gaps. extremeShifted==0 ⇒
        // no gap gate (constant-L curve; terminates via fill / price-limit / cap).
        if (dlim) dnOn[bestPool] = false;
        const ext = dd.extremeShifted ?? 0n;
        if (dL === 0n && ext > 0n) {
          const pastExt = zeroForOne ? dsh < ext : dsh > ext;
          if (pastExt) dnOn[bestPool] = false;
        }
        dnSteps[bestPool] += 1;
        if (dnSteps[bestPool] >= PER_POOL) dnOn[bestPool] = false;
      }
    }
  }

  const totalInput =
    perPoolInput.reduce((a, b) => a + b, 0n) + perRouteInput.reduce((a, b) => a + b, 0n);
  return { perPoolInput, perRouteInput, totalInput, cutSqrtAdj, cursorChecks };
}
