/**
 * GoonFi V2 adapter v2 (EcoSwapSVM ladder fragment). See ./index.ts for the
 * full reverse-engineering provenance (program id, instruction format,
 * account order/writability, oracle-relay layout, fee-tier table — all from
 * real mainnet transactions, not documentation).
 *
 * MODEL ("bake the tiers, read the level" — the same shape as obric-v2's
 * "bake the shape, read the level", adapted for a fee-tiered rather than
 * shifted-CP venue): the pool's admin-configured fee/size-tier schedule is
 * read once at prepare time (fetchPoolConfig) and rides as params — it is
 * slow-changing, pool-creation-time configuration, not fast-moving market
 * data. The two-sided oracle-relay price IS fast-moving and is read LIVE
 * in-VM every execution, using whichever of the two quotes is LESS
 * favourable to the trader (min for xToY, max for yToX) — a one-sided-safe
 * choice independent of which quote is actually "bid" vs "ask". The live
 * vaultOut balance is ALSO read live, as a hard capacity clamp: the quote can
 * never claim more than the vault currently holds, regardless of what the
 * price+fee model predicts.
 *
 *   xToY (mintA in, mintB out): raw = mulDiv(x, min(p1,p2), denomAdjusted)
 *   yToX (mintB in, mintA out): raw = mulDiv(x, denomAdjusted, max(p1,p2))
 *   fee  = feeTiersPpm[i] where i is the tier x falls into (ascending
 *          cumulative-size thresholds; x past the LAST tier deactivates —
 *          the venue's own capacity ceiling, empirically confirmed against a
 *          real Jupiter "No routes found" at exactly that size)
 *   net  = raw - raw*fee/1e6, clamped to 0 if net > live vaultOut balance
 *
 * denomAdjusted (`da`) folds the oracle's assumed 1,000,000 denominator with
 * the two mints' decimals into ONE compile-time constant (see
 * denomAdjustedFor in index.ts); the live oracle's OWN denominator field is
 * still read and compared against the assumption every execution — a
 * mismatch deactivates the slot rather than silently mispricing (self-drop
 * on live failure, not a silent wrong quote).
 *
 * LAST-GOOD LADDER (why the statement-form split from emitQuoteCall):
 * both deactivation edges (the size ceiling, the vaultOut clamp) are
 * DISCONTINUOUS — a naive pointwise quote would jump straight to 0 past
 * either edge, which is non-monotone and would zero-fill the venue's merge
 * election (see module docs elsewhere in this package on why a coarse/
 * non-monotone ladder is a liveness hazard, not an accuracy nit). The ladder
 * fragment therefore holds the LAST-GOOD value once capped (mirrors
 * obric-v2's `${p}lo`/`${p}cap` shape) and the COLD final quote (used once,
 * at the merge's actually-elected amount) saturates at the SAME boundary
 * values rather than collapsing to 0 — see emitLadderQuote's "THE
 * TIER-CEILING + VAULT-CLAMP COLLAPSE" doc for the closed-form fix (both
 * edges used to latch/return without recording anything at all, which is
 * the defect that doc fixes, not the intended design).
 */
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type {
  AccountBytesMap,
  LadderSwapTemplate,
  PoolConfig,
  SvmVenueLadderV2,
  SwapUser,
  VenueAccount,
} from '../types.js';
import {
  denomAdjustedFor,
  GOONFI_ASSUMED_DENOM,
  GOONFI_V2_PROGRAM_ID,
  GOONFI_SWAP_TAG,
  goonfiSwapAccounts,
  OFF_ORACLE_DENOM,
  OFF_ORACLE_P1,
  OFF_ORACLE_P2,
} from './index.js';
import type { GoonfiV2PoolConfig } from './index.js';

const SLUG = 'goonfi-v2';
const AMOUNT_OFF = 64; // SPL token account amount field.
const FEE_DEN = 1_000_000n;
/** 1 (da) + 9 (size thresholds) + 9 (fee-ppm tiers). */
const PARAM_COUNT = 19;
const TIER_COUNT = 9;

function goonfiConfig(cfg: PoolConfig): GoonfiV2PoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as GoonfiV2PoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

function rawExpr(c: GoonfiV2PoolConfig, p: string, x: string): string {
  return c.direction === 'xToY' ? `Math.mulDiv(${x}, ${p}pr, ${p}da)` : `Math.mulDiv(${x}, ${p}da, ${p}pr)`;
}

/** Fee-tier lookup: assigns the slot's `${p}fee` local by walking the 9 ascending thresholds. */
function feeAssignLines(p: string, x: string): string[] {
  return [
    `      ${p}fee = ${p}f1;`,
    `      if (${x} > ${p}t1) { ${p}fee = ${p}f2 }`,
    `      if (${x} > ${p}t2) { ${p}fee = ${p}f3 }`,
    `      if (${x} > ${p}t3) { ${p}fee = ${p}f4 }`,
    `      if (${x} > ${p}t4) { ${p}fee = ${p}f5 }`,
    `      if (${x} > ${p}t5) { ${p}fee = ${p}f6 }`,
    `      if (${x} > ${p}t6) { ${p}fee = ${p}f7 }`,
    `      if (${x} > ${p}t7) { ${p}fee = ${p}f8 }`,
    `      if (${x} > ${p}t8) { ${p}fee = ${p}f9 }`,
  ];
}

interface LiveState {
  pr: bigint;
  da: bigint;
  rout: bigint;
  active: boolean;
  thresholds: readonly bigint[]; // 9
  fees: readonly bigint[]; // 9
  /** The price+fee-tier output AT x=thresholds[8] (the tier ceiling itself,
   *  using the last/fees[8] tier), vault-clamped -- x-independent, computed
   *  once. See goonfiColdQuote's "THE TIER-CEILING + VAULT-CLAMP COLLAPSE"
   *  fix. */
  tierCeilOut: bigint;
}

/** The reference twin of emitSetup: derive the live price/gate + baked params from account bytes. */
function liveState(cfg: GoonfiV2PoolConfig, state: AccountBytesMap, params: readonly bigint[]): LiveState {
  const oracle = state[cfg.oracle];
  if (oracle === undefined) throw new Error(`${SLUG} reference is missing oracle-relay ${cfg.oracle}`);
  const voutAddr = cfg.direction === 'yToX' ? cfg.vaultA : cfg.vaultB;
  const vout = state[voutAddr];
  if (vout === undefined) throw new Error(`${SLUG} reference is missing vault ${voutAddr}`);

  const p1 = readUintLE(oracle, OFF_ORACLE_P1, 8);
  const p2 = readUintLE(oracle, OFF_ORACLE_P2, 8);
  const dn = readUintLE(oracle, OFF_ORACLE_DENOM, 4);
  const rout = readUintLE(vout, AMOUNT_OFF, 8);
  const pr = cfg.direction === 'xToY' ? (p2 !== 0n && p2 < p1 ? p2 : p1) : p2 > p1 ? p2 : p1;
  const active = p1 !== 0n && p2 !== 0n && dn === GOONFI_ASSUMED_DENOM;

  const [da, ...rest] = params;
  const thresholds = rest.slice(0, TIER_COUNT);
  const fees = rest.slice(TIER_COUNT, 2 * TIER_COUNT);

  const tierCeilX = thresholds[8]!;
  const tierCeilRaw = cfg.direction === 'xToY' ? (tierCeilX * pr) / da! : (tierCeilX * da!) / pr;
  const tierCeilNetRaw = tierCeilRaw - (tierCeilRaw * fees[8]!) / FEE_DEN;
  const tierCeilOut = tierCeilNetRaw > rout ? rout : tierCeilNetRaw;

  return { pr, da: da!, rout, active, thresholds, fees, tierCeilOut };
}

/**
 * The COLD (final, venue-approximating) quote: price+fee model for gross
 * input x -- the lamport-exact target for emitFinalQuote.
 *
 * THE TIER-CEILING + VAULT-CLAMP COLLAPSE -- FIXED (was: 0 past either
 * deactivation edge, violating "nondecreasing in x, quote(0)=0"). x beyond
 * the tier ceiling now reports tierCeilOut (the setup-computed output AT the
 * ceiling itself -- the fee schedule has no tier past it, so nothing larger
 * is ever deliverable); the vault clamp now saturates at rout (this venue's
 * live balance) instead of collapsing, mirroring the on-chain fragment's own
 * per-call behavior (see emitLadderQuote's doc for the on-chain twin).
 */
export function goonfiColdQuote(cfg: GoonfiV2PoolConfig, x: bigint, live: LiveState): bigint {
  if (x === 0n || !live.active) return 0n;
  if (x > live.thresholds[8]!) return live.tierCeilOut;
  let fee = live.fees[0]!;
  for (let i = 0; i < TIER_COUNT - 1; i++) {
    if (x > live.thresholds[i]!) fee = live.fees[i + 1]!;
  }
  const raw = cfg.direction === 'xToY' ? (x * live.pr) / live.da : (x * live.da) / live.pr;
  const net = raw - (raw * fee) / FEE_DEN;
  return net > live.rout ? live.rout : net;
}

/**
 * Shared walk backing both referenceLadderQuotes and referenceCapacities —
 * mirrors emitLadderQuote exactly (monotone, flat past either deactivation
 * edge). Both edges bump-then-latch instead of freezing at whatever smaller
 * grid point last succeeded — see emitLadderQuote's "THE TIER-CEILING +
 * VAULT-CLAMP COLLAPSE" doc for the fix shape.
 */
function referenceWalk(
  cfg: GoonfiV2PoolConfig,
  live: LiveState,
  grid: readonly bigint[],
): { outs: bigint[]; caps: bigint[] } {
  let lo = 0n;
  let lx = 0n;
  let capped = false;
  const outs: bigint[] = [];
  const caps: bigint[] = [];
  for (const x of grid) {
    if (!capped && x > 0n && live.active) {
      if (x > live.thresholds[8]!) {
        if (live.tierCeilOut > lo) lo = live.tierCeilOut;
        if (live.thresholds[8]! > lx) lx = live.thresholds[8]!;
        capped = true;
      } else {
        let fee = live.fees[0]!;
        for (let i = 0; i < TIER_COUNT - 1; i++) {
          if (x > live.thresholds[i]!) fee = live.fees[i + 1]!;
        }
        const raw = cfg.direction === 'xToY' ? (x * live.pr) / live.da : (x * live.da) / live.pr;
        const net = raw - (raw * fee) / FEE_DEN;
        if (net > live.rout) {
          lo = live.rout;
          lx = x;
          capped = true;
        } else {
          lo = net;
          lx = x;
        }
      }
    }
    outs.push(lo);
    caps.push(lx);
  }
  return { outs, caps };
}

export const goonfiV2Ladder = {
  slug: SLUG,

  /** CP-class: a closed-form quote (one mulDiv + a tier lookup per rung), 4 rungs. */
  defaultRungs: 4,

  shapeKey(base: PoolConfig): string {
    return `${SLUG}:${goonfiConfig(base).direction}`;
  },

  /** The quote is inline statement-form (last-good ladder / cold final) — no shared helper,
   *  mirroring obric-v2 (both deactivation edges must reuse the setup-declared slot locals, not a
   *  standalone pure-scalar helper — see module doc). */
  helpers(): { name: string; source: string }[] {
    return [];
  },

  paramCount: PARAM_COUNT,

  paramsFor(base: PoolConfig): bigint[] {
    const c = goonfiConfig(base);
    const da = denomAdjustedFor(c.decimalsA, c.decimalsB);
    return [da, ...c.feeSchedule.sizeTiers, ...c.feeSchedule.feeTiersPpm];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const c = goonfiConfig(base);
    return [
      { ref: ref(slot, 'pool'), address: c.pool },
      { ref: ref(slot, 'oracle'), address: c.oracle },
      { ref: ref(slot, 'va'), address: c.vaultA },
      { ref: ref(slot, 'vb'), address: c.vaultB },
    ];
  },

  emitSetup(base: PoolConfig, slot: number, params: readonly string[]): string {
    const c = goonfiConfig(base);
    const p = `s${slot}`;
    const oracle = JSON.stringify(ref(slot, 'oracle'));
    const voutRole = c.direction === 'yToX' ? 'va' : 'vb';
    const vout = JSON.stringify(ref(slot, voutRole));
    const [da, t1, t2, t3, t4, t5, t6, t7, t8, t9, f1, f2, f3, f4, f5, f6, f7, f8, f9] = params;
    return [
      `  const ${p}ov1 = accountUint(${oracle}, ${OFF_ORACLE_P1}, 8);`,
      `  const ${p}ov2 = accountUint(${oracle}, ${OFF_ORACLE_P2}, 8);`,
      `  const ${p}dn = accountUint(${oracle}, ${OFF_ORACLE_DENOM}, 4);`,
      `  const ${p}rout = accountUint(${vout}, ${AMOUNT_OFF}, 8);`,
      `  let ${p}pr = ${p}ov1;`,
      c.direction === 'xToY'
        ? `  if (${p}ov2 !== 0 && ${p}ov2 < ${p}pr) { ${p}pr = ${p}ov2 }`
        : `  if (${p}ov2 > ${p}pr) { ${p}pr = ${p}ov2 }`,
      `  let ${p}kq = 1;`,
      `  if (${p}ov1 === 0) { ${p}kq = 0 }`,
      `  if (${p}ov2 === 0) { ${p}kq = 0 }`,
      `  if (${p}dn !== ${GOONFI_ASSUMED_DENOM.toString()}) { ${p}kq = 0 }`,
      `  const ${p}da = ${da};`,
      `  const ${p}t1 = ${t1}; const ${p}t2 = ${t2}; const ${p}t3 = ${t3}; const ${p}t4 = ${t4}; const ${p}t5 = ${t5};`,
      `  const ${p}t6 = ${t6}; const ${p}t7 = ${t7}; const ${p}t8 = ${t8}; const ${p}t9 = ${t9};`,
      `  const ${p}f1 = ${f1}; const ${p}f2 = ${f2}; const ${p}f3 = ${f3}; const ${p}f4 = ${f4}; const ${p}f5 = ${f5};`,
      `  const ${p}f6 = ${f6}; const ${p}f7 = ${f7}; const ${p}f8 = ${f8}; const ${p}f9 = ${f9};`,
      `  let ${p}raw = 0; let ${p}fee = 0; let ${p}net = 0;`,
      `  let ${p}lo = 0; let ${p}lx = 0; let ${p}cap = 0;`,
      // tierCeilOut = the price+fee-tier output AT x=t9 (the tier ceiling
      // itself, using the LAST/f9 tier -- always the applicable fee there),
      // vault-clamped -- x-independent, computed once. See "THE TIER-CEILING
      // + VAULT-CLAMP COLLAPSE" fix in emitLadderQuote's doc.
      `  const ${p}tcRaw = ${rawExpr(c, p, `${p}t9`)};`,
      `  let ${p}tierCeilOut = ${p}tcRaw - Math.mulDiv(${p}tcRaw, ${p}f9, ${FEE_DEN});`,
      `  if (${p}tierCeilOut > ${p}rout) { ${p}tierCeilOut = ${p}rout }`,
    ].join('\n');
  },

  /**
   * Ladder rung at cumulative grid point `x`: the price+fee-tier output, reported as the LAST-GOOD
   * value once the walk passes either deactivation edge (the tier ceiling or the live vaultOut
   * clamp) — a capped rung's dOut is 0 and the merge never over-fills goonfi-v2 past what the
   * venue's own configured capacity or its live vault can pay. Monotone nondecreasing; quote(0)=0.
   * `${p}lx` (capacityInputVar) freezes alongside `${p}lo` at the last genuinely-productive
   * cumulative input, so a rung past either edge reports zero PRODUCTIVE input too (not the raw,
   * over-capacity grid point) — the merge-reachable half of the ladder-contract guard's required
   * capacityInputVar/referenceCapacities pair. Mirrored by referenceLadderQuotes/referenceCapacities.
   *
   * THE TIER-CEILING + VAULT-CLAMP COLLAPSE — FIXED. Both edges used to
   * latch WITHOUT recording anything, collapsing to whatever smaller grid
   * point last succeeded (measured non-monotone: maxCap/maxOut both flip to
   * 0 once the grid steps past either edge). Fixed distinctly per edge:
   * (a) the tier-ceiling edge (`x > t9`) bumps (lo, lx) up to the
   * setup-computed (tierCeilOut, t9) -- the price+fee-tier output AT the
   * ceiling itself, vault-clamped -- since ANY x beyond t9 can never exceed
   * what the ceiling itself delivers (the fee schedule has no tier past t9).
   * (b) the vault-clamp edge (`net > rout`) saturates net AT THIS x directly
   * (no inversion needed -- raw/fee are already computed for x) and records
   * (rout, x), mirroring solfi-v2/the window-walking families' own
   * saturate-in-place convention.
   */
  emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string {
    const c = goonfiConfig(base);
    const p = `s${slot}`;
    return [
      `    if (${p}cap === 0 && ${x} > 0 && ${p}kq !== 0) {`,
      `      if (${x} > ${p}t9) {`,
      `        if (${p}tierCeilOut > ${p}lo) { ${p}lo = ${p}tierCeilOut; ${p}lx = ${p}t9 }`,
      `        ${p}cap = 1;`,
      `      } else {`,
      `        ${p}raw = ${rawExpr(c, p, x)};`,
      ...feeAssignLines(p, x).map((l) => '  ' + l),
      `        ${p}net = ${p}raw - Math.mulDiv(${p}raw, ${p}fee, ${FEE_DEN});`,
      `        if (${p}net > ${p}rout) { ${p}lo = ${p}rout; ${p}lx = ${x}; ${p}cap = 1 } else { ${p}lo = ${p}net; ${p}lx = ${x} }`,
      `      }`,
      `    }`,
      `    const ${outVar} = ${p}lo;`,
    ].join('\n');
  },

  /** Names the slot-local capacityInputVar freezes (see emitLadderQuote's doc). */
  capacityInputVar(slot: number): string {
    return `s${slot}lx`;
  },

  /**
   * Cold final quote at the elected slice: price+fee model, or the same
   * tier-ceiling/vault-clamp fallback emitLadderQuote uses (see its doc) --
   * never collapses to 0 past either edge.
   */
  emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string {
    const c = goonfiConfig(base);
    const p = `s${slot}`;
    return [
      `  let ${outVar} = 0;`,
      `  if (${x} > 0 && ${p}kq !== 0) {`,
      `    if (${x} > ${p}t9) { ${outVar} = ${p}tierCeilOut }`,
      `    else {`,
      `      ${p}raw = ${rawExpr(c, p, x)};`,
      ...feeAssignLines(p, x).map((l) => '  ' + l),
      `      ${p}net = ${p}raw - Math.mulDiv(${p}raw, ${p}fee, ${FEE_DEN});`,
      `      if (${p}net <= ${p}rout) { ${outVar} = ${p}net } else { ${outVar} = ${p}rout }`,
      `    }`,
      `  }`,
    ].join('\n');
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const c = goonfiConfig(base);
    const yToX = c.direction === 'yToX';
    const make = (r: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
    // swap: tag(1)=1 ++ direction(1) ++ input u64 LE (runtime-patched) ++ minOut u64 LE = 1 ++
    // trailing byte = 0 (matches the real captured 19-byte instruction exactly).
    return {
      programId: GOONFI_V2_PROGRAM_ID,
      prefix: Uint8Array.from([GOONFI_SWAP_TAG, yToX ? 1 : 0]),
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0]),
      patch: 'in',
      accounts: goonfiSwapAccounts(c, user, make, (role) => ref(slot, role)),
    };
  },

  /** The COLD final quote (0 past either deactivation edge) — the lamport-exact target for
   *  emitFinalQuote. */
  referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint {
    const cfg = goonfiConfig(base);
    const live = liveState(cfg, state, params);
    return (x: bigint): bigint => goonfiColdQuote(cfg, x, live);
  },

  /** The LAST-GOOD ladder chain — mirrors emitLadderQuote (monotone, flat past either
   *  deactivation edge). */
  referenceLadderQuotes(
    base: PoolConfig,
    state: AccountBytesMap,
    params: readonly bigint[],
  ): (grid: readonly bigint[]) => bigint[] {
    const cfg = goonfiConfig(base);
    const live = liveState(cfg, state, params);
    return (grid: readonly bigint[]): bigint[] => referenceWalk(cfg, live, grid).outs;
  },

  /** Mirror of capacityInputVar: the cumulative PRODUCTIVE input at each grid point — freezes at
   *  the same rung referenceLadderQuotes freezes its output at (both derive from the same walk). */
  referenceCapacities(
    base: PoolConfig,
    state: AccountBytesMap,
    params: readonly bigint[],
  ): (grid: readonly bigint[]) => bigint[] {
    const cfg = goonfiConfig(base);
    const live = liveState(cfg, state, params);
    return (grid: readonly bigint[]): bigint[] => referenceWalk(cfg, live, grid).caps;
  },

  /** Depth = the actual VAULT balances (matches every other CP-family adapter). A vault drained on
   *  either side reads 0 depth and drops out of the relative-depth filter. */
  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const cfg = goonfiConfig(base);
    const va = state[cfg.vaultA];
    const vb = state[cfg.vaultB];
    if (va === undefined || vb === undefined) throw new Error(`${SLUG} depth is missing a vault`);
    const ra = readUintLE(va, AMOUNT_OFF, 8);
    const rb = readUintLE(vb, AMOUNT_OFF, 8);
    return cfg.direction === 'xToY' ? { reserveIn: ra, reserveOut: rb } : { reserveIn: rb, reserveOut: ra };
  },

  /** Measurement-only oracle (never a gate): the smallest tier's fee is the near-zero-size
   *  marginal rate, the honest representative continuous fee for this venue. */
  continuousFees(base: PoolConfig): { gammaPpm: bigint; muPpm: bigint } {
    const c = goonfiConfig(base);
    const fee0 = c.feeSchedule.feeTiersPpm[0] ?? 0n;
    const feePpm = fee0 > FEE_DEN ? FEE_DEN : fee0;
    return { gammaPpm: FEE_DEN, muPpm: FEE_DEN - feePpm };
  },
} satisfies SvmVenueLadderV2;
