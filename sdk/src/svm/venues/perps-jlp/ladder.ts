/**
 * Jupiter Perpetuals (JLP) `swap2` adapter v2 (EcoSwapSVM ladder fragment).
 *
 * QUOTE (transcribed from the community swap-fee reference — see index.ts's
 * module doc for the three-way sourcing on why this is the swap2 fee model,
 * not the position-only price-impact-buffer):
 *
 *   swapPriceCoeff = floor(priceIn * 1e9 / priceOut)                    [live, x-invariant]
 *   amountOutBeforeFees(x) = floor(x * swapPriceCoeff * fxScaleUp / fxScaleDown)
 *
 *   initialUsd(side) = isStable
 *     ? usd(owned + debt)                                               [debt: internal-lending, ceil((debt-accrued)/1e9)]
 *     : usd(max(0, owned - locked)) + guaranteedUsd
 *   targetUsd(side) = floor(aumUsd * targetRatioBps(side) / 1e4)
 *   feeBps(side, x, increment) =
 *     targetUsd == 0 ? 0 :
 *     let initialDiff = |initialUsd - targetUsd|,
 *         v = multiplier * swapUsd(x),                                  [swapUsd always priced off the INPUT side]
 *         next = increment ? initialUsd + v : max(0, initialUsd - v),
 *         nextDiff = |next - targetUsd|
 *     nextDiff < initialDiff
 *       ? max(0, baseFeeBps - floor(taxFeeBps * initialDiff / targetUsd))          [rebalancing rebate]
 *       : baseFeeBps + floor(taxFeeBps * min((initialDiff+nextDiff)/2, targetUsd) / targetUsd)  [imbalance tax]
 *   feeBps(x) = max(feeBps(in, x, true), feeBps(out, x, false))
 *   feeBpsFinal(x) = min(1e4, floor(feeBps(x) * externalMultiplierBps / 1e4))       [conservative bake, see index.ts]
 *   out(x) = floor(amountOutBeforeFees(x) * (1e4 - feeBpsFinal(x)) / 1e4)
 *
 * Every quantity but `swapUsd(x)`/`feeBps*(x)`/`out(x)` is x-INVARIANT (fixed
 * once the live state is read), so emitSetup computes them ONCE; only the
 * fee/output chain re-runs per grid point — cheaper than re-deriving the
 * whole state per rung, and it keeps the per-rung cost roughly comparable to
 * the other CP-class families despite the two-sided fee model.
 *
 * DEBT is read live ONLY for a STABLE side: `theoreticallyOwned − totalLocked
 * = (owned+debt) − (locked+debt) = owned − locked` — debt cancels out of the
 * NON-stable branch algebraically, so a non-stable side (SOL/ETH/BTC on the
 * real mainnet pool) skips both u128 reads and the ceil-division entirely.
 * `isStable` is a compile-time (baked) flag, so this is a CODEGEN-time
 * branch, not a runtime one — zero cost for the common case.
 *
 * CAPACITY: no full window-walk saturation (unlike orca-whirlpool/
 * raydium-clmm/meteora-dlmm/manifest/meteora-damm-v2/obric-v2) — the JLP
 * pool's real depth (~$700M+ across 6 assets, 2026-07-31) is many orders of
 * magnitude past any grid point this recipe explores, so a closed-form
 * capacity clamp would be complexity without a realistic payoff. A cheap
 * defensive floor is still applied: `out(x)` is clamped to the dispensing
 * custody's live `assets.owned` (already read for the fee calc) — the
 * physical ceiling on what a swap can ever transfer out — so an adversarial
 * or pathological grid point saturates rather than overquoting.
 *
 * MONOTONICITY: `amountOutBeforeFees` is strictly increasing in x; feeBps is
 * bps-bounded ([0, 1e4] post-clamp) and empirically negligible-slope at
 * realistic sizes relative to the pool's multi-hundred-million-dollar
 * per-side target USD (a fee-bps swing of a few bps over a six-figure trade
 * cannot reverse a linear amountOut curve growing at ~1e9+ raw units per
 * dollar) — verified numerically against real mainnet state at 3 sizes (see
 * the recipe-side quote-proof script), never merely assumed.
 */
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type { AccountBytesMap, LadderSwapTemplate, PoolConfig, SvmVenueLadderV2, SwapUser, VenueAccount } from '../types.js';
import {
  bakedDecimalScale,
  DOVES_PRICE_OFFSET,
  ORACLE_PRICE_SCALE,
  PERPS_JLP_PROGRAM_ID,
  SWAP2_DISCRIMINATOR,
  eventAuthorityPda,
  perpetualsPda,
  perpsJlpConfig,
  transferAuthorityPda,
} from './index.js';
import type { PerpsJlpPoolConfig } from './index.js';

const SLUG = 'perps-jlp';

const OFF_ASSETS_OWNED = 222;
const OFF_ASSETS_LOCKED = 230;
const OFF_ASSETS_GUARANTEED_USD = 238;
const OFF_DEBT = 1004;
const OFF_BORROW_LEND_INTERESTS_ACCRUED = 1020;

const PARAM_COUNT = 12;
const ref = (slot: number, role: string): string => `s${slot}:${role}`;

function cfgOf(base: PoolConfig): PerpsJlpPoolConfig {
  return perpsJlpConfig(base);
}

// ---------------------------------------------------------------------------
// Off-chain (TS) mirror — every helper below is the lamport-exact twin of the
// emitted fragment lines with the SAME name suffix.
// ---------------------------------------------------------------------------

function ceilDivU128(raw: bigint): bigint {
  return (raw + 999_999_999n) / 1_000_000_000n;
}

interface SetupState {
  pxi: bigint;
  pxo: bigint;
  xr: bigint; // swapPriceCoeff
  iuIn: bigint;
  iuOut: bigint;
  tuIn: bigint;
  tuOut: bigint;
  diffIn0: bigint;
  diffOut0: bigint;
  ownedOut: bigint; // capacity floor
}

function liveSetup(cfg: PerpsJlpPoolConfig, state: AccountBytesMap): SetupState {
  const dovesIn = state[cfg.dovesOracleIn];
  const dovesOut = state[cfg.dovesOracleOut];
  const pool = state[cfg.pool];
  const custodyIn = state[cfg.custodyIn];
  const custodyOut = state[cfg.custodyOut];
  if (dovesIn === undefined || dovesOut === undefined) throw new Error(`${SLUG} reference is missing a Doves price feed`);
  if (pool === undefined) throw new Error(`${SLUG} reference is missing the pool account`);
  if (custodyIn === undefined || custodyOut === undefined) throw new Error(`${SLUG} reference is missing a custody account`);

  const pxi = readUintLE(dovesIn, DOVES_PRICE_OFFSET, 8);
  const pxo = readUintLE(dovesOut, DOVES_PRICE_OFFSET, 8);
  const xr = (pxi * ORACLE_PRICE_SCALE) / pxo;

  const oi = readUintLE(custodyIn, OFF_ASSETS_OWNED, 8);
  const li = readUintLE(custodyIn, OFF_ASSETS_LOCKED, 8);
  const gi = readUintLE(custodyIn, OFF_ASSETS_GUARANTEED_USD, 8);
  const oo = readUintLE(custodyOut, OFF_ASSETS_OWNED, 8);
  const lo = readUintLE(custodyOut, OFF_ASSETS_LOCKED, 8);
  const go = readUintLE(custodyOut, OFF_ASSETS_GUARANTEED_USD, 8);

  const usd = (amt: bigint, price: bigint, scaleUp: bigint, scaleDown: bigint): bigint => (amt * price * scaleUp) / scaleDown;

  let iuIn: bigint;
  if (cfg.isStableIn) {
    const dbi = readUintLE(custodyIn, OFF_DEBT, 16);
    const dai = readUintLE(custodyIn, OFF_BORROW_LEND_INTERESTS_ACCRUED, 16);
    const raw = dbi > dai ? dbi - dai : 0n;
    const deb = ceilDivU128(raw);
    iuIn = usd(oi + deb, pxi, cfg.usdScaleUpIn, cfg.usdScaleDownIn);
  } else {
    const net = oi > li ? oi - li : 0n;
    iuIn = usd(net, pxi, cfg.usdScaleUpIn, cfg.usdScaleDownIn) + gi;
  }

  let iuOut: bigint;
  if (cfg.isStableOut) {
    const dbo = readUintLE(custodyOut, OFF_DEBT, 16);
    const dao = readUintLE(custodyOut, OFF_BORROW_LEND_INTERESTS_ACCRUED, 16);
    const raw = dbo > dao ? dbo - dao : 0n;
    const deb = ceilDivU128(raw);
    iuOut = usd(oo + deb, pxo, cfg.usdScaleUpOut, cfg.usdScaleDownOut);
  } else {
    const net = oo > lo ? oo - lo : 0n;
    iuOut = usd(net, pxo, cfg.usdScaleUpOut, cfg.usdScaleDownOut) + go;
  }

  const au = readUintLE(pool, Number(cfg.poolAumUsdOffset), 16);
  const tuIn = (au * cfg.targetRatioBpsIn) / 10_000n;
  const tuOut = (au * cfg.targetRatioBpsOut) / 10_000n;
  const diffIn0 = iuIn >= tuIn ? iuIn - tuIn : tuIn - iuIn;
  const diffOut0 = iuOut >= tuOut ? iuOut - tuOut : tuOut - iuOut;

  return { pxi, pxo, xr, iuIn, iuOut, tuIn, tuOut, diffIn0, diffOut0, ownedOut: oo };
}

function sideFeeBps(
  cfg: PerpsJlpPoolConfig,
  targetUsd: bigint,
  initialUsd: bigint,
  initialDiff: bigint,
  swapUsd: bigint,
  increment: boolean,
): bigint {
  if (targetUsd === 0n) return 0n;
  const v = cfg.multiplier * swapUsd;
  const next = increment ? initialUsd + v : initialUsd > v ? initialUsd - v : 0n;
  const nextDiff = next >= targetUsd ? next - targetUsd : targetUsd - next;
  if (nextDiff < initialDiff) {
    const rebate = (cfg.taxFeeBps * initialDiff) / targetUsd;
    return cfg.baseFeeBps > rebate ? cfg.baseFeeBps - rebate : 0n;
  }
  const avg = (initialDiff + nextDiff) / 2n;
  const capped = avg < targetUsd ? avg : targetUsd;
  const tax = (cfg.taxFeeBps * capped) / targetUsd;
  return cfg.baseFeeBps + tax;
}

/** The COLD (venue-exact) quote at gross input x — the lamport-exact target for the fragment. */
function coldQuote(cfg: PerpsJlpPoolConfig, s: SetupState, x: bigint): bigint {
  if (x <= 0n) return 0n;
  const swapUsd = (x * s.pxi * cfg.usdScaleUpIn) / cfg.usdScaleDownIn;
  const feeBpsIn = sideFeeBps(cfg, s.tuIn, s.iuIn, s.diffIn0, swapUsd, true);
  const feeBpsOut = sideFeeBps(cfg, s.tuOut, s.iuOut, s.diffOut0, swapUsd, false);
  const feeBps = feeBpsIn > feeBpsOut ? feeBpsIn : feeBpsOut;
  let feeBpsFinal = (feeBps * cfg.externalMultiplierBps) / 10_000n;
  if (feeBpsFinal > 10_000n) feeBpsFinal = 10_000n;
  const outBeforeFees = (x * s.xr * cfg.fxScaleUp) / cfg.fxScaleDown;
  let out = (outBeforeFees * (10_000n - feeBpsFinal)) / 10_000n;
  if (out > s.ownedOut) out = s.ownedOut;
  return out;
}

// ---------------------------------------------------------------------------
// Fragment emission.
// ---------------------------------------------------------------------------

/** Shared per-x quote body (identical for every ladder rung and the cold final quote — no warm-start state). */
function quoteLines(p: string, xExpr: string, outVar: string): string[] {
  return [
    `    const ${p}su = (${xExpr} * ${p}pxi * ${p}uui) / ${p}udi;`,
    // feeBpsIn (increment = true)
    `    ${p}vin = ${p}mult * ${p}su;`,
    `    ${p}nin = ${p}iui + ${p}vin;`,
    `    ${p}din = 0;`,
    `    if (${p}nin >= ${p}tui) { ${p}din = ${p}nin - ${p}tui } else { ${p}din = ${p}tui - ${p}nin }`,
    `    ${p}fbi = 0;`,
    `    if (${p}tui !== 0) {`,
    `      if (${p}din < ${p}di0) {`,
    `        ${p}reb = (${p}taxf * ${p}di0) / ${p}tui;`,
    `        if (${p}basef > ${p}reb) { ${p}fbi = ${p}basef - ${p}reb } else { ${p}fbi = 0 }`,
    `      } else {`,
    `        ${p}avg = (${p}di0 + ${p}din) / 2;`,
    `        ${p}capd = ${p}avg;`,
    `        if (${p}tui < ${p}avg) { ${p}capd = ${p}tui }`,
    `        ${p}fbi = ${p}basef + (${p}taxf * ${p}capd) / ${p}tui;`,
    `      }`,
    `    }`,
    // feeBpsOut (increment = false)
    `    ${p}vout = ${p}mult * ${p}su;`,
    `    ${p}nout = 0;`,
    `    if (${p}iuo > ${p}vout) { ${p}nout = ${p}iuo - ${p}vout }`,
    `    ${p}dout = 0;`,
    `    if (${p}nout >= ${p}tuo) { ${p}dout = ${p}nout - ${p}tuo } else { ${p}dout = ${p}tuo - ${p}nout }`,
    `    ${p}fbo = 0;`,
    `    if (${p}tuo !== 0) {`,
    `      if (${p}dout < ${p}do0) {`,
    `        ${p}rebo = (${p}taxf * ${p}do0) / ${p}tuo;`,
    `        if (${p}basef > ${p}rebo) { ${p}fbo = ${p}basef - ${p}rebo } else { ${p}fbo = 0 }`,
    `      } else {`,
    `        ${p}avgo = (${p}do0 + ${p}dout) / 2;`,
    `        ${p}capdo = ${p}avgo;`,
    `        if (${p}tuo < ${p}avgo) { ${p}capdo = ${p}tuo }`,
    `        ${p}fbo = ${p}basef + (${p}taxf * ${p}capdo) / ${p}tuo;`,
    `      }`,
    `    }`,
    `    ${p}fb = ${p}fbi;`,
    `    if (${p}fbo > ${p}fb) { ${p}fb = ${p}fbo }`,
    `    ${p}fbf = (${p}fb * ${p}extm) / 10000;`,
    `    if (${p}fbf > 10000) { ${p}fbf = 10000 }`,
    `    ${p}obf = (${xExpr} * ${p}xr * ${p}fxu) / ${p}fxd;`,
    `    let ${outVar} = (${p}obf * (10000 - ${p}fbf)) / 10000;`,
    `    if (${outVar} > ${p}oo) { ${outVar} = ${p}oo }`,
    `    if (${xExpr} <= 0) { ${outVar} = 0 }`,
  ];
}

export const perpsJlpLadder = {
  slug: SLUG,

  /**
   * Heavier per-rung arithmetic than a plain CP quote (a two-sided fee
   * branch), so 2 rungs by default — matching the Newton-style stable
   * families' CU-conservative default, not because this is iterative.
   */
  defaultRungs: 2,

  shapeKey(base: PoolConfig): string {
    const c = cfgOf(base);
    // isStable drives which fields the emitted setup reads (debt vs not), so
    // it is part of the compiled SHAPE, not just a param.
    return `${SLUG}:${c.isStableIn ? 1 : 0}:${c.isStableOut ? 1 : 0}`;
  },

  helpers(): { name: string; source: string }[] {
    return [];
  },

  paramCount: PARAM_COUNT,

  paramsFor(base: PoolConfig): bigint[] {
    const c = cfgOf(base);
    return [
      c.fxScaleUp,
      c.fxScaleDown,
      c.usdScaleUpIn,
      c.usdScaleDownIn,
      c.usdScaleUpOut,
      c.usdScaleDownOut,
      c.targetRatioBpsIn,
      c.targetRatioBpsOut,
      c.baseFeeBps,
      c.taxFeeBps,
      c.multiplier,
      c.externalMultiplierBps,
    ];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const c = cfgOf(base);
    return [
      { ref: ref(slot, 'pool'), address: c.pool },
      { ref: ref(slot, 'ci'), address: c.custodyIn },
      { ref: ref(slot, 'co'), address: c.custodyOut },
      { ref: ref(slot, 'di'), address: c.dovesOracleIn },
      { ref: ref(slot, 'do'), address: c.dovesOracleOut },
    ];
  },

  emitSetup(base: PoolConfig, slot: number, params: readonly string[], enableVar?: string): string {
    const c = cfgOf(base);
    const p = `s${slot}`;
    const pool = JSON.stringify(ref(slot, 'pool'));
    const custodyIn = JSON.stringify(ref(slot, 'ci'));
    const custodyOut = JSON.stringify(ref(slot, 'co'));
    const dovesIn = JSON.stringify(ref(slot, 'di'));
    const dovesOut = JSON.stringify(ref(slot, 'do'));
    const [fxu, fxd, uui, udi, uuo, udo, trin, trout, basef, taxf, mult, extm] = params;

    const lines: string[] = [
      // Unconditional live reads.
      `  const ${p}pxi = accountUint(${dovesIn}, ${DOVES_PRICE_OFFSET}, 8);`,
      `  const ${p}pxo = accountUint(${dovesOut}, ${DOVES_PRICE_OFFSET}, 8);`,
      `  const ${p}au = accountUint(${pool}, ${c.poolAumUsdOffset.toString()}, 16);`,
      `  const ${p}oi = accountUint(${custodyIn}, ${OFF_ASSETS_OWNED}, 8);`,
      `  const ${p}li = accountUint(${custodyIn}, ${OFF_ASSETS_LOCKED}, 8);`,
      `  const ${p}gi = accountUint(${custodyIn}, ${OFF_ASSETS_GUARANTEED_USD}, 8);`,
      `  const ${p}oo = accountUint(${custodyOut}, ${OFF_ASSETS_OWNED}, 8);`,
      `  const ${p}lo = accountUint(${custodyOut}, ${OFF_ASSETS_LOCKED}, 8);`,
      `  const ${p}go = accountUint(${custodyOut}, ${OFF_ASSETS_GUARANTEED_USD}, 8);`,
      // Baked config, carried as short local aliases so the shared quote body reads uniformly.
      `  const ${p}fxu = ${fxu};`,
      `  const ${p}fxd = ${fxd};`,
      `  const ${p}uui = ${uui};`,
      `  const ${p}udi = ${udi};`,
      `  const ${p}uuo = ${uuo};`,
      `  const ${p}udo = ${udo};`,
      `  const ${p}tui = (${p}au * ${trin}) / 10000;`,
      `  const ${p}tuo = (${p}au * ${trout}) / 10000;`,
      `  const ${p}basef = ${basef};`,
      `  const ${p}taxf = ${taxf};`,
      `  const ${p}mult = ${mult};`,
      `  const ${p}extm = ${extm};`,
      // x-invariant exchange-rate coefficient.
      `  const ${p}xr = (${p}pxi * ${ORACLE_PRICE_SCALE.toString()}) / ${p}pxo;`,
    ];

    // initialUsd per side (debt only where isStable — baked/compile-time branch).
    if (c.isStableIn) {
      lines.push(
        `  const ${p}dbi = accountUint(${custodyIn}, ${OFF_DEBT}, 16);`,
        `  const ${p}dai = accountUint(${custodyIn}, ${OFF_BORROW_LEND_INTERESTS_ACCRUED}, 16);`,
        `  let ${p}drwi = 0;`,
        `  if (${p}dbi > ${p}dai) { ${p}drwi = ${p}dbi - ${p}dai }`,
        `  const ${p}debi = (${p}drwi + 999999999) / 1000000000;`,
        `  const ${p}iui = ((${p}oi + ${p}debi) * ${p}pxi * ${p}uui) / ${p}udi;`,
      );
    } else {
      lines.push(
        `  let ${p}neti = 0;`,
        `  if (${p}oi > ${p}li) { ${p}neti = ${p}oi - ${p}li }`,
        `  const ${p}iui = (${p}neti * ${p}pxi * ${p}uui) / ${p}udi + ${p}gi;`,
      );
    }
    if (c.isStableOut) {
      lines.push(
        `  const ${p}dbo = accountUint(${custodyOut}, ${OFF_DEBT}, 16);`,
        `  const ${p}dao = accountUint(${custodyOut}, ${OFF_BORROW_LEND_INTERESTS_ACCRUED}, 16);`,
        `  let ${p}drwo = 0;`,
        `  if (${p}dbo > ${p}dao) { ${p}drwo = ${p}dbo - ${p}dao }`,
        `  const ${p}debo = (${p}drwo + 999999999) / 1000000000;`,
        `  const ${p}iuo = ((${p}oo + ${p}debo) * ${p}pxo * ${p}uuo) / ${p}udo;`,
      );
    } else {
      lines.push(
        `  let ${p}neto = 0;`,
        `  if (${p}oo > ${p}lo) { ${p}neto = ${p}oo - ${p}lo }`,
        `  const ${p}iuo = (${p}neto * ${p}pxo * ${p}uuo) / ${p}udo + ${p}go;`,
      );
    }

    lines.push(
      `  let ${p}di0 = 0;`,
      `  if (${p}iui >= ${p}tui) { ${p}di0 = ${p}iui - ${p}tui } else { ${p}di0 = ${p}tui - ${p}iui }`,
      `  let ${p}do0 = 0;`,
      `  if (${p}iuo >= ${p}tuo) { ${p}do0 = ${p}iuo - ${p}tuo } else { ${p}do0 = ${p}tuo - ${p}iuo }`,
      // Per-rung scratch locals (reassigned, never redeclared — see quoteLines).
      `  let ${p}su = 0; let ${p}vin = 0; let ${p}nin = 0; let ${p}din = 0;`,
      `  let ${p}fbi = 0; let ${p}reb = 0; let ${p}avg = 0; let ${p}capd = 0;`,
      `  let ${p}vout = 0; let ${p}nout = 0; let ${p}dout = 0;`,
      `  let ${p}fbo = 0; let ${p}rebo = 0; let ${p}avgo = 0; let ${p}capdo = 0;`,
      `  let ${p}fb = 0; let ${p}fbf = 0; let ${p}obf = 0;`,
    );

    void enableVar; // every read here is cheap (no expensive setup to gate) — unconditional, like most CP-class families.
    return lines.join('\n');
  },

  /** Stateless per rung (no warm-start) — identical body to the cold final quote. */
  emitLadderQuote(base: PoolConfig, slot: number, _rung: number, x: string, outVar: string): string {
    cfgOf(base);
    return quoteLines(`s${slot}`, x, outVar).join('\n');
  },

  emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string {
    cfgOf(base);
    return quoteLines(`s${slot}`, x, outVar).join('\n');
  },

  /**
   * swap2(params: Swap2Params { amountIn: u64, minAmountOut: u64 }) —
   * disc(8) ++ amountIn u64 LE (runtime-patched) ++ minAmountOut u64 LE = 1
   * (the recipe's terminal outAta delta check owns the real bound). The
   * 17-account order below is the on-chain IDL's `swap2` accounts list
   * verbatim (decoded from the live on-chain Anchor IDL account 2026-07-31)
   * — receivingCustody/receivingCustody* = the INPUT (funding) side,
   * dispensingCustody/dispensingCustody* = the OUTPUT (receiving) side.
   */
  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const c = cfgOf(base);
    const make = (r: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
    return {
      programId: PERPS_JLP_PROGRAM_ID,
      prefix: Uint8Array.from(SWAP2_DISCRIMINATOR),
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
      patch: 'in',
      accounts: [
        { ref: user.owner, signer: true },
        { ref: user.inAta, writable: true }, // fundingAccount
        { ref: user.outAta, writable: true }, // receivingAccount
        make(ref(slot, 'ta'), c.transferAuthority),
        make(ref(slot, 'perp'), c.perpetuals),
        make(ref(slot, 'pool'), c.pool, true),
        make(ref(slot, 'ci'), c.custodyIn, true), // receivingCustody
        make(ref(slot, 'di'), c.dovesOracleIn), // receivingCustodyDovesPriceAccount
        make(ref(slot, 'pyi'), c.pythAccountIn), // receivingCustodyPythnetPriceAccount
        make(ref(slot, 'tai'), c.tokenAccountIn, true), // receivingCustodyTokenAccount
        make(ref(slot, 'co'), c.custodyOut, true), // dispensingCustody
        make(ref(slot, 'do'), c.dovesOracleOut), // dispensingCustodyDovesPriceAccount
        make(ref(slot, 'pyo'), c.pythAccountOut), // dispensingCustodyPythnetPriceAccount
        make(ref(slot, 'tao'), c.tokenAccountOut, true), // dispensingCustodyTokenAccount
        make(ref(slot, 'tp'), c.tokenProgram),
        make(ref(slot, 'ea'), c.eventAuthority),
        make(ref(slot, 'prog'), PERPS_JLP_PROGRAM_ID),
      ],
    };
  },

  referenceQuote(base: PoolConfig, state: AccountBytesMap): (x: bigint) => bigint {
    const cfg = cfgOf(base);
    const s = liveSetup(cfg, state);
    return (x: bigint): bigint => coldQuote(cfg, s, x);
  },

  referenceLadderQuotes(base: PoolConfig, state: AccountBytesMap): (grid: readonly bigint[]) => bigint[] {
    const cfg = cfgOf(base);
    const s = liveSetup(cfg, state);
    return (grid: readonly bigint[]): bigint[] => grid.map((x) => coldQuote(cfg, s, x));
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const cfg = cfgOf(base);
    const custodyIn = state[cfg.custodyIn];
    const custodyOut = state[cfg.custodyOut];
    if (custodyIn === undefined || custodyOut === undefined) throw new Error(`${SLUG} depth is missing a custody account`);
    const reserveIn = readUintLE(custodyIn, OFF_ASSETS_OWNED, 8);
    const reserveOut = readUintLE(custodyOut, OFF_ASSETS_OWNED, 8);
    return { reserveIn, reserveOut };
  },

  continuousFees(base: PoolConfig): { gammaPpm: bigint; muPpm: bigint } {
    const c = cfgOf(base);
    const feePpm = c.baseFeeBps * 100n > 1_000_000n ? 1_000_000n : c.baseFeeBps * 100n;
    return { gammaPpm: 1_000_000n, muPpm: 1_000_000n - feePpm };
  },
} satisfies SvmVenueLadderV2;
