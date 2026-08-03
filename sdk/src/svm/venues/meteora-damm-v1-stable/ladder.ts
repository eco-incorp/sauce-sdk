/**
 * Meteora DAMM v1 stable adapter v2 (EcoSwapSVM ladder fragment) — the
 * heaviest family: vault share math (locked-profit decay at the cluster
 * clock, LP-supply share floors) rebuilds the reserves live, input-token
 * fees carry the min-1 rule, the curve is 2-coin stableswap on
 * multiplier-upscaled reserves, and each side adds a vault deposit/withdraw
 * simulation. Everything is a LIVE read (fees, amp, multipliers, vault decay
 * fields, LP amounts, mint supplies, the out-side idle float); zero
 * per-trade params; direction A → B is the whole shape.
 *
 * Newton economics mirror saber's (see ../saber-stableswap/ladder.ts): D
 * once per trade in enable-gated setup, WARM-START y per ladder rung, COLD y
 * for the final predicted output — the venue-exact value.
 *
 * Engine-mirroring conventions (both sides compute IDENTICALLY, so the
 * lamport-exact gate holds even on degenerate pools):
 * - a division by zero yields 0 (the engine's DIV rule; the TS mirror
 *   branches explicitly);
 * - a clock behind last_report wraps the decay ratio past 1e12 in-VM, which
 *   falls back to total_amount — the mirror branches on t < last_report to
 *   the same fallback (except degradation == 0, where the wrapped huge
 *   multiplies to ratio 0 in-VM and BOTH sides take the full-lock decay
 *   branch — engine-verified);
 * - a dust trade whose fees exceed the deposit-simulated total quotes 0
 *   (the venue's checked math would revert), guarded BEFORE the subtraction
 *   can wrap;
 * - the strict idle-float bound (funds deployed to lending strategies are
 *   not withdrawable inside swap) is a GENUINE FINITE CAPACITY, not an
 *   arithmetic accident.
 *
 * CAPACITY (idle-float bound): a raw pointwise quote COLLAPSES to 0 rather
 * than saturating once the vault-withdraw candidate reaches the out-side
 * idle float — non-decreasing up to the largest productive cumulative input,
 * then a cliff. With the checked-in fixture's idle float (which happens to
 * exceed the curve's own asymptotic max) the cliff is never reached, so the
 * collapse was undetected: an ordinary idle float of 500,000,000,000 puts it
 * at x=499,992,225,659, well below u64::MAX — a REACHABLE, ordinary trade
 * size on the live k-way-merge ladder-chain path, not merely the standalone
 * cold quote. Differencing that pointwise curve across a ladder rung that
 * straddles the cliff manufactures a NEGATIVE dOut: the off-chain
 * plain-bigint mirror and the on-chain u256-wrapping merge read that delta
 * DIFFERENTLY (a real negative bigint vs. a colossal wrapped unsigned word),
 * so the two elect DIFFERENT rungs from the SAME ladder.
 *
 * The fix: `emitLadderQuote`/`referenceLadderQuotes` never report a
 * collapse, and never merely freeze at the last GRID checkpoint either
 * (that shape, and a follow-up 2-round bracketed-search shape, both shipped
 * in earlier passes of this fix — both still under-serve for a
 * grid/amountIn far above the cliff: a fixed round budget simply fails to
 * bracket the boundary once the search's starting interval is wide, so a
 * `defaultRungs` grid whose first point lands far past the idle float still
 * reports `(0, 0)` — a TOTAL, not partial, loss of this venue's
 * contribution, exactly the failure mode this fix closes). Instead, the
 * boundary is computed ANALYTICALLY, once per trade, in `emitSetup`
 * (`s<slot>xc`) — no search, no extra Newton solve, one integer square
 * root: the 2-coin stableswap invariant `4·x·y·(ann·(x+y) + d − ann·d) = d³`
 * is SYMMETRIC in x and y, so the engine's own y-quadratic (the one
 * `stableYW` iterates to a fixed point) inverts to give x from a target y
 * with the identical floored b/c recipe. Working backwards from the
 * out-side idle float through the exact double-floor vault-withdraw
 * inverse (`s<slot>zdt`/`s<slot>zy`) to that quadratic, then forward again
 * through the fee inverse, yields the largest cumulative input `s<slot>xc`
 * whose forward quote is PROVABLY still below the idle float — one lamport
 * of output (`destMargin` in the TS mirror's `analyticCapacity`) surrendered
 * as headroom against the ±1 wobble a floored inverse can accumulate versus
 * the forward Newton iteration. `s<slot>xc` is state-only (independent of
 * any rung's own x), so every rung just clamps its cumulative input to
 * `min(x, xc)` before running the ordinary warm fee/vault/Newton chain
 * (`emitQuoteAt`) — this is the orca-whirlpool/raydium-clmm/meteora-dlmm
 * `coldWalkClamped` convention ("the productive input AT THE WINDOW EDGE",
 * types.ts's capacityInputVar doc) carried out by a closed-form clamp
 * rather than a discrete tick/bin walk (this curve has no discrete window)
 * or a search (no round budget to exhaust). `s<slot>cap` latches
 * permanently the rung whose grid point first exceeds `s<slot>xc` — a
 * later rung's own grid point can only be even LARGER (rungs are
 * non-decreasing cumulative inputs), so nothing later can ever do better;
 * `capacityInputVar`/`referenceCapacities` report the clamp's result. A
 * ONE-COMPARE pre-gate (`s<slot>idl <= s<slot>rout`) skips the whole
 * computation when the idle float sits at/above the curve's own reach
 * (`out <= dest <= rout` always) — the checked-in fixture's own shape, and
 * what keeps the common (never-clamped) path cheap. The per-rung
 * `if (ov < idl) { lo = ov; lx = x }` guard on the warm chain's tail stays
 * as a residual, never-over-quote backstop: `s<slot>lo`/`s<slot>lx` are
 * updated ONLY from a genuine forward-evaluated candidate, so even if the
 * analytic clamp were ever off by more than its margin, the checkpoint
 * simply would not advance rather than reporting a value no real x
 * produced — see ladder-contract.test.ts's density sweep, which proves this
 * residual guard never fires across the full idle/multiplier/rung matrix.
 * The truly STANDALONE cold quote (`emitFinalQuote`'s cache-miss branch /
 * `referenceQuote` called at an arbitrary x the ladder chain never walked)
 * still collapses past the boundary: LATENT, saved only by the
 * ladder-chain's own capacity clamp (never merge-reachable, since the
 * merge only ever asks the final quote for the cumulative fill the ladder
 * chain itself produced, or for `s<slot>lx` itself, which the cache-hit
 * branch serves straight from `s<slot>lo` — see ladder-contract.test.ts's
 * declared-gap cases for the other four families carrying the exact same
 * shape).
 *
 * WHY ANALYTIC, NOT MORE SEARCH ROUNDS — measured on the real engine
 * (LiteSVM), not assumed: a 2-round false-position search is EXACT for a
 * marginal breach (a grid landing just past the idle float) but fails to
 * bracket the boundary once the amountIn is far above the cliff — measured
 * ZERO capacity at multiples from 2x to 10,000x the cliff, across ordinary
 * (not extreme) idle floats, i.e. an everyday trade size can lose this
 * venue ENTIRELY. Buying more rounds does not fix this cheaply: each round
 * costs ~250-280k CU FLAT (dominated by the round's own Newton solve,
 * `stableYW`) regardless of inline-vs-call or round count, so a search deep
 * enough to bracket a grossly oversized trade blows through the 1.4M
 * absolute per-tx CU ceiling by round 5-8. The analytic clamp instead costs
 * ONE integer sqrt and a handful of muldivs, ONCE per trade (not once per
 * rung, not once per round): measured ~535-800k CU total depending on the
 * idle float, comfortably under the ceiling and INDEPENDENT of how far the
 * amountIn sits past the cliff (no round budget to exhaust, so nothing to
 * measure "far" against). The inert path (an idle float at/above the
 * curve's own reach, e.g. the checked-in fixture) costs only ~8.6k CU more
 * than emitting no clamp at all, thanks to the one-compare pre-gate.
 */
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import { STABLE_D_HELPER, STABLE_YW_HELPER, stableComputeD, stableComputeYWarm } from '../stable-helpers.js';
import type {
  AccountBytesMap,
  LadderSwapTemplate,
  PoolConfig,
  SvmVenueLadderV2,
  SwapUser,
  VenueAccount,
} from '../types.js';
import { meteoraDammV1Stable } from './index.js';
import type { MeteoraDammV1StablePoolConfig } from './index.js';

const SLUG = 'meteora-damm-v1-stable';
const VAULT_PROGRAM_ID = '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi' as Address;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;

// sha256("global:swap")[..8].
const SWAP_DISCRIMINATOR = [0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8];

const DEG = 1_000_000_000_000n;

// u64::MAX — an SPL amount can never exceed it, so `x > xc` is false for every
// reachable cumulative input: the sentinel meaning "the curve's own asymptote
// never reaches this idle float, no clamp needed".
const NOCLAMP = 18_446_744_073_709_551_615n;

// Pool / vault / SPL offsets (docs/svm-venues.md layout tables).
const POOL = {
  tradeFeeNumerator: 330,
  tradeFeeDenominator: 338,
  protocolTradeFeeNumerator: 346,
  protocolTradeFeeDenominator: 354,
  amp: 875,
  tokenAMultiplier: 883,
  tokenBMultiplier: 891,
} as const;
const VAULT = { totalAmount: 11, lastUpdatedLockedProfit: 1203, lastReport: 1211, lockedProfitDegradation: 1219 } as const;
const TOKEN_AMOUNT = 64;
const MINT_SUPPLY = 36;

function d1sConfig(cfg: PoolConfig): MeteoraDammV1StablePoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as MeteoraDammV1StablePoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

/** The engine's DIV rule: a zero divisor yields 0 (never throws). */
const engineDiv = (a: bigint, b: bigint): bigint => (b === 0n ? 0n : a / b);

/** TS mirror of the emitted `Math.mulDiv(a, b, c)`: floor(a*b/c), 0 on a zero denominator (the engine's DIV rule, applied to the full-precision product). */
const mulDivFloor = (a: bigint, b: bigint, c: bigint): bigint => (c === 0n ? 0n : (a * b) / c);

/** Floor integer square root (mirrors the engine's SQRT op — same convention as obric-v2/ladder.ts's isqrt). */
function isqrt(value: bigint): bigint {
  if (value < 0n) throw new Error(`isqrt needs a non-negative value, got ${value}`);
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

interface D1sLive {
  rin: bigint;
  rout: bigint;
  au: bigint;
  bu: bigint;
  alp: bigint;
  asu: bigint;
  bsu: bigint;
  fn: bigint;
  fd: bigint;
  pn: bigint;
  pd: bigint;
  amp: bigint;
  ma: bigint;
  mb: bigint;
  idle: bigint;
  /** 0 when the slot is unquotable — the master validity flag. */
  d: bigint;
}

/** Live state exactly as the fragment computes it. */
function liveState(cfg: MeteoraDammV1StablePoolConfig, state: AccountBytesMap, now: bigint): D1sLive {
  const bytes = (addr: Address, what: string): Uint8Array => {
    const data = state[addr];
    if (data === undefined) throw new Error(`${SLUG} ladder reference is missing ${what} account ${addr}`);
    return data;
  };
  const pool = bytes(cfg.pool, 'pool');
  const unlocked = (vaultAddr: Address, what: string): bigint => {
    const vault = bytes(vaultAddr, what);
    const total = readUintLE(vault, VAULT.totalAmount, 8);
    const locked = readUintLE(vault, VAULT.lastUpdatedLockedProfit, 8);
    const lastReport = readUintLE(vault, VAULT.lastReport, 8);
    const degradation = readUintLE(vault, VAULT.lockedProfitDegradation, 8);
    // Fragment: ratio = (t − last_report)·degradation wraps huge when t <
    // last_report → the `<= 1e12` branch is not taken → total_amount — EXCEPT
    // when degradation == 0, where the wrapped huge multiplies to 0 and the
    // fragment DOES take the decay branch (ratio 0 → full lock). Mirror both:
    // the engine-verified corner cell pins the wrapped-clock zero-degradation
    // fragment behavior.
    if (now < lastReport) return degradation === 0n ? total - locked : total;
    const ratio = (now - lastReport) * degradation;
    if (ratio > DEG) return total;
    return total - (locked * (DEG - ratio)) / DEG;
  };
  const au = unlocked(cfg.aVault, 'vault a');
  const bu = unlocked(cfg.bVault, 'vault b');
  const alp = readUintLE(bytes(cfg.aVaultLp, 'a_vault_lp'), TOKEN_AMOUNT, 8);
  const blp = readUintLE(bytes(cfg.bVaultLp, 'b_vault_lp'), TOKEN_AMOUNT, 8);
  const asu = readUintLE(bytes(cfg.aLpMint, 'a lp mint'), MINT_SUPPLY, 8);
  const bsu = readUintLE(bytes(cfg.bLpMint, 'b lp mint'), MINT_SUPPLY, 8);
  const rin = engineDiv(alp * au, asu);
  const rout = engineDiv(blp * bu, bsu);
  const fn = readUintLE(pool, POOL.tradeFeeNumerator, 8);
  const fd = readUintLE(pool, POOL.tradeFeeDenominator, 8);
  const pn = readUintLE(pool, POOL.protocolTradeFeeNumerator, 8);
  const pd = readUintLE(pool, POOL.protocolTradeFeeDenominator, 8);
  const amp = readUintLE(pool, POOL.amp, 8);
  const ma = readUintLE(pool, POOL.tokenAMultiplier, 8);
  const mb = readUintLE(pool, POOL.tokenBMultiplier, 8);
  const idle = readUintLE(bytes(cfg.bTokenVault, 'b token vault'), TOKEN_AMOUNT, 8);
  const d = rin > 0n && rout > 0n ? stableComputeD(amp, rin * ma, rout * mb) : 0n;
  return { rin, rout, au, bu, alp, asu, bsu, fn, fd, pn, pd, amp, ma, mb, idle, d };
}

/**
 * THE ANALYTIC CAPACITY CLAMP — TS mirror of `emitSetup`'s `s<slot>xc`.
 * State-only (independent of any rung's x), computed once. Returns the
 * largest cumulative input whose forward quote is provably still below the
 * out-side idle float, or NOCLAMP when the idle float sits at/above the
 * curve's own reach (see this file's module doc for the derivation:
 * inverting the double-floor vault-withdraw simulation to a target y, then
 * the Newton y-quadratic to an x via the invariant's x/y symmetry, then the
 * fee simulation back to a source amount). Lockstep with `emitSetup`'s
 * emitted fragment: same branches, same floored intermediates, same
 * `destMargin` of 1 lamport surrendered as headroom against a ±1 wobble
 * versus the forward Newton iteration (measured: never over-quotes across
 * the acceptance sweep in ladder-contract.test.ts).
 */
function analyticCapacity(live: D1sLive): bigint {
  if (live.idle === 0n) return 0n;
  if (live.idle > live.rout) return NOCLAMP;
  const db = live.rout * live.mb;
  const lp = engineDiv(live.idle * live.bsu - 1n, live.bu);
  let dth = engineDiv((lp + 1n) * live.bu - 1n, live.bsu);
  if (dth > 0n) dth = dth - 1n;
  if ((dth + 1n) * live.mb >= db) return NOCLAMP;
  let xc = 0n;
  const yth = db - (dth + 1n) * live.mb;
  const ann = live.amp * 2n;
  const b = engineDiv(live.d, ann) + yth;
  const c = mulDivFloor(mulDivFloor(live.d, live.d, yth * 2n), live.d, live.amp * 4n);
  const m = live.d >= b ? live.d - b : b - live.d;
  const q = isqrt(m * m + 4n * c);
  let x = 0n;
  if (live.d >= b) x = (m + q) / 2n;
  else if (q > m) x = (q - m) / 2n;
  const xUp = engineDiv(x, live.ma);
  if (xUp > live.rin && live.fd > live.fn) {
    xc = mulDivFloor(xUp - live.rin, live.fd, live.fd - live.fn);
  }
  return xc;
}

/**
 * One RAW pointwise quote over the live state with a caller-supplied Newton
 * start (the warm chain threads y0; the cold path passes d). Returns the new
 * y cursor alongside the output so the chain can advance even on a 0-quote
 * rung. Does NOT apply the idle-float capacity bound — `reached` is false
 * for the two fee/dust guards (transient: true only for the smallest inputs,
 * and — unlike the idle bound — never re-trips once it has cleared, so a
 * caller must not latch on it); the idle bound itself is the caller's
 * responsibility (a permanent, monotonic cliff once reached — the cold path
 * collapses on it, the ladder-chain path freezes on it).
 */
function quoteRaw(live: D1sLive, x: bigint, y0: bigint): { out: bigint; y: bigint; reached: boolean } {
  // Input-token fees, min-1 (calculate_fee); protocol fee is a cut of the trade fee.
  let tf = engineDiv(x * live.fn, live.fd);
  if (live.fn > 0n && tf === 0n) tf = 1n;
  let pf = engineDiv(tf * live.pn, live.pd);
  if (live.pn > 0n && tf > 0n && pf === 0n) pf = 1n;
  tf -= pf;
  const inNet = x - pf;
  // Vault deposit simulation; unlocked' = unlocked + inNet (locked profit unchanged).
  const inLp = engineDiv(inNet * live.asu, live.au);
  const after = engineDiv((inLp + live.alp) * (live.au + inNet), live.asu + inLp);
  // Dust guard: fees exceeding the simulated total would wrap in-VM and
  // revert on-chain — quote 0, keep the cursor.
  if (after < live.rin + tf) return { out: 0n, y: y0, reached: false };
  const srcNet = after - live.rin - tf;
  const y = stableComputeYWarm(live.amp, (live.rin + srcNet) * live.ma, live.d, y0);
  const db = live.rout * live.mb;
  if (db <= y) return { out: 0n, y, reached: false };
  const dest = engineDiv(db - y - 1n, live.mb);
  // Vault withdraw simulation (two more floors).
  const outLp = engineDiv(dest * live.bsu, live.bu);
  const out = engineDiv(outLp * live.bu, live.bsu);
  return { out, y, reached: true };
}

/** COLD collapsing quote: quoteRaw plus the idle-float collapse (the declared, merge-unreachable, latent gap — see capacityInputVar/referenceCapacities). */
function quoteColdCollapsing(live: D1sLive, x: bigint, y0: bigint): { out: bigint; y: bigint } {
  const r = quoteRaw(live, x, y0);
  return { out: r.reached && r.out >= live.idle ? 0n : r.out, y: r.y };
}

interface LadderWalkResult {
  outs: bigint[];
  caps: bigint[];
}

/**
 * Shared walk backing both referenceLadderQuotes and referenceCapacities:
 * mirrors the emitted fragment exactly — computes the state-only
 * `analyticCapacity` ONCE, then per grid point clamps the cumulative input
 * to `min(x, xc)` (latching `capped` permanently the rung that needed the
 * clamp — a later rung's own grid point can only be even larger, so nothing
 * later can ever do better) and warm-threads y across the (possibly
 * clamped) grid exactly like the pre-existing fragment. The residual
 * `out < idle` guard on the forward-evaluated candidate is a never-over-
 * quote backstop (see this file's module doc) — `lo`/`lx` are updated ONLY
 * from a genuine forward evaluation, never fabricated.
 */
function ladderWalk(live: D1sLive, grid: readonly bigint[]): LadderWalkResult {
  let wy = live.d;
  let lo = 0n;
  let lx = 0n;
  let capped = false;
  const xc = analyticCapacity(live);
  const outs: bigint[] = [];
  const caps: bigint[] = [];
  for (const g of grid) {
    if (live.d === 0n || g === 0n || capped) {
      outs.push(lo);
      caps.push(lx);
      continue;
    }
    let x = g;
    if (x > xc) {
      x = xc;
      capped = true;
    }
    if (x > 0n) {
      const r = quoteRaw(live, x, wy);
      wy = r.y;
      if (r.reached && r.out < live.idle) {
        lo = r.out;
        lx = x;
      }
    }
    outs.push(lo);
    caps.push(lx);
  }
  return { outs, caps };
}

export const meteoraDammV1StableLadder = {
  slug: SLUG,

  /** Stable slots default to 2 rungs (cap 4) — see recipes/ecoswap/svm/budget.ts. */
  defaultRungs: 2,

  shapeKey(): string {
    return `${SLUG}:AtoB`;
  },

  helpers(): { name: string; source: string }[] {
    return [STABLE_D_HELPER, STABLE_YW_HELPER];
  },

  /** Everything is a live read — no per-trade params. */
  paramCount: 0,

  paramsFor(_base: PoolConfig): bigint[] {
    return [];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const cfg = d1sConfig(base);
    return [
      { ref: ref(slot, 'pool'), address: cfg.pool },
      { ref: ref(slot, 'av'), address: cfg.aVault },
      { ref: ref(slot, 'bv'), address: cfg.bVault },
      { ref: ref(slot, 'avlp'), address: cfg.aVaultLp },
      { ref: ref(slot, 'bvlp'), address: cfg.bVaultLp },
      { ref: ref(slot, 'alpm'), address: cfg.aLpMint },
      { ref: ref(slot, 'blpm'), address: cfg.bLpMint },
      { ref: ref(slot, 'btv'), address: cfg.bTokenVault },
    ];
  },

  emitSetup(base: PoolConfig, slot: number, _params: readonly string[], enableVar?: string): string {
    void base;
    const enabled = enableVar ?? `s${slot}en`;
    const pool = JSON.stringify(ref(slot, 'pool'));
    const av = JSON.stringify(ref(slot, 'av'));
    const bv = JSON.stringify(ref(slot, 'bv'));
    return [
      // Vault unlocked amounts at the cluster clock (locked-profit decay,
      // denominator 1e12; a wrapped ratio falls back to total_amount).
      `  const s${slot}at = accountUint(${av}, ${VAULT.totalAmount}, 8);`,
      `  const s${slot}ak = accountUint(${av}, ${VAULT.lastUpdatedLockedProfit}, 8);`,
      `  const s${slot}arr = (block.timestamp - accountUint(${av}, ${VAULT.lastReport}, 8)) * accountUint(${av}, ${VAULT.lockedProfitDegradation}, 8);`,
      `  let s${slot}au = s${slot}at;`,
      `  if (s${slot}arr <= ${DEG}) { s${slot}au = s${slot}at - s${slot}ak * (${DEG} - s${slot}arr) / ${DEG} }`,
      `  const s${slot}bt = accountUint(${bv}, ${VAULT.totalAmount}, 8);`,
      `  const s${slot}bk = accountUint(${bv}, ${VAULT.lastUpdatedLockedProfit}, 8);`,
      `  const s${slot}brr = (block.timestamp - accountUint(${bv}, ${VAULT.lastReport}, 8)) * accountUint(${bv}, ${VAULT.lockedProfitDegradation}, 8);`,
      `  let s${slot}bu = s${slot}bt;`,
      `  if (s${slot}brr <= ${DEG}) { s${slot}bu = s${slot}bt - s${slot}bk * (${DEG} - s${slot}brr) / ${DEG} }`,
      // Reserves via vault share math (never raw balances).
      `  const s${slot}alp = accountUint(${JSON.stringify(ref(slot, 'avlp'))}, ${TOKEN_AMOUNT}, 8);`,
      `  const s${slot}blp = accountUint(${JSON.stringify(ref(slot, 'bvlp'))}, ${TOKEN_AMOUNT}, 8);`,
      `  const s${slot}asu = accountUint(${JSON.stringify(ref(slot, 'alpm'))}, ${MINT_SUPPLY}, 8);`,
      `  const s${slot}bsu = accountUint(${JSON.stringify(ref(slot, 'blpm'))}, ${MINT_SUPPLY}, 8);`,
      `  const s${slot}rin = s${slot}alp * s${slot}au / s${slot}asu;`,
      `  const s${slot}rout = s${slot}blp * s${slot}bu / s${slot}bsu;`,
      // Fees, amp, multipliers — all admin-mutable or pool constants, all live.
      `  const s${slot}fn = accountUint(${pool}, ${POOL.tradeFeeNumerator}, 8);`,
      `  const s${slot}fd = accountUint(${pool}, ${POOL.tradeFeeDenominator}, 8);`,
      `  const s${slot}pn = accountUint(${pool}, ${POOL.protocolTradeFeeNumerator}, 8);`,
      `  const s${slot}pd = accountUint(${pool}, ${POOL.protocolTradeFeeDenominator}, 8);`,
      `  const s${slot}amp = accountUint(${pool}, ${POOL.amp}, 8);`,
      `  const s${slot}ma = accountUint(${pool}, ${POOL.tokenAMultiplier}, 8);`,
      `  const s${slot}mb = accountUint(${pool}, ${POOL.tokenBMultiplier}, 8);`,
      `  const s${slot}idl = accountUint(${JSON.stringify(ref(slot, 'btv'))}, ${TOKEN_AMOUNT}, 8);`,
      // Newton D — ONCE per trade, only for an enabled, funded slot.
      `  let s${slot}d = 0;`,
      `  if (${enabled} !== 0 && s${slot}rin > 0 && s${slot}rout > 0) { s${slot}d = stableD(s${slot}amp, s${slot}rin * s${slot}ma, s${slot}rout * s${slot}mb) }`,
      // Capacity freeze state (idle-float bound): cap latches PERMANENTLY the
      // first rung whose candidate reaches the idle float; lo/lx hold the
      // last productive (output, cumulative input) pair — see
      // emitLadderQuote/capacityInputVar.
      `  let s${slot}cap = 0;`,
      `  let s${slot}lo = 0;`,
      `  let s${slot}lx = 0;`,
      // ANALYTIC CAPACITY CLAMP (state-only, one integer sqrt, NO Newton).
      // Every intermediate is BLOCK-scoped so the compiler's scope free-list
      // reuses its value slots across slots (context.ts's slot reuse) — only
      // s<slot>xc itself is long-lived.
      `  let s${slot}xc = ${NOCLAMP};`,
      `  if (s${slot}idl === 0) { s${slot}xc = 0 }`,
      // ONE-COMPARE SOUND PRE-GATE: out <= dest <= floor((rout*mb-1)/mb) <= rout,
      // so an idle float above rout can NEVER be reached — skip the whole
      // computation (the checked-in fixture's own shape: idle 959e9 > rout
      // 861.4e9). MEASURED: this keeps the inert path at ~5k CU instead of ~42k.
      `  else if (s${slot}idl <= s${slot}rout) {`,
      `    const s${slot}zdb = s${slot}rout * s${slot}mb;`,
      `    let s${slot}zdt = ((s${slot}idl * s${slot}bsu - 1) / s${slot}bu + 1) * s${slot}bu - 1;`,
      `    s${slot}zdt = s${slot}zdt / s${slot}bsu;`,
      `    if (s${slot}zdt > 0) { s${slot}zdt = s${slot}zdt - 1 }`,
      `    if ((s${slot}zdt + 1) * s${slot}mb < s${slot}zdb) {`,
      `      s${slot}xc = 0;`,
      `      const s${slot}zy = s${slot}zdb - (s${slot}zdt + 1) * s${slot}mb;`,
      `      const s${slot}zb = s${slot}d / (s${slot}amp * 2) + s${slot}zy;`,
      `      const s${slot}zc = Math.mulDiv(Math.mulDiv(s${slot}d, s${slot}d, s${slot}zy * 2), s${slot}d, s${slot}amp * 4);`,
      `      let s${slot}zm = 0;`,
      `      if (s${slot}d >= s${slot}zb) { s${slot}zm = s${slot}d - s${slot}zb } else { s${slot}zm = s${slot}zb - s${slot}d }`,
      `      const s${slot}zq = Math.sqrt(s${slot}zm * s${slot}zm + 4 * s${slot}zc);`,
      `      let s${slot}zx = 0;`,
      `      if (s${slot}d >= s${slot}zb) { s${slot}zx = (s${slot}zm + s${slot}zq) / 2 }`,
      `      else { if (s${slot}zq > s${slot}zm) { s${slot}zx = (s${slot}zq - s${slot}zm) / 2 } }`,
      `      const s${slot}zu = s${slot}zx / s${slot}ma;`,
      `      if (s${slot}zu > s${slot}rin && s${slot}fd > s${slot}fn) {`,
      `        s${slot}xc = Math.mulDiv(s${slot}zu - s${slot}rin, s${slot}fd, s${slot}fd - s${slot}fn);`,
      '      }',
      '    }',
      '  }',
    ].join('\n');
  },

  emitQuoteCall: undefined,

  /**
   * Ladder rung at cumulative grid point x: skips all computation once
   * `s<slot>cap` has latched (a prior rung's own grid point already exceeded
   * the analytic clamp `s<slot>xc` — permanent, since rungs are
   * non-decreasing cumulative inputs, so nothing later can ever be
   * smaller); otherwise clamps this rung's input to `min(x, xc)` (latching
   * `cap` if the clamp bound) and runs the WARM fee/vault/Newton chain,
   * which records the new (lo, lx) = (output, cumulative input) checkpoint
   * whenever the forward-evaluated candidate genuinely clears the idle
   * float. Reports the CURRENT checkpoint every rung — 0 dOut/dIn once
   * frozen, exactly the window-walking convention (types.ts's
   * capacityInputVar doc).
   */
  emitLadderQuote(_base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string {
    return [
      ...(rung === 0 ? [`    let s${slot}wy = s${slot}d;`] : []),
      `    if (s${slot}cap === 0 && s${slot}d > 0 && ${x} > 0) {`,
      `      let s${slot}xr${rung} = ${x};`,
      `      if (s${slot}xr${rung} > s${slot}xc) { s${slot}xr${rung} = s${slot}xc; s${slot}cap = 1 }`,
      `      if (s${slot}xr${rung} > 0) {`,
      ...this.emitQuoteAt(slot, `${rung}`, `s${slot}xr${rung}`, `s${slot}wy`, true),
      '      }',
      '    }',
      `    const ${outVar} = s${slot}lo;`,
    ].join('\n');
  },

  capacityInputVar(slot: number): string {
    return `s${slot}lx`;
  },

  /** Cold final quote: reuse the ladder's last-good value if x lands exactly there, else recompute fresh from D (byte-identical to the venue's own swap path) — the DECLARED, merge-unreachable, latent collapse past the idle float (see this file's module doc). */
  emitFinalQuote(_base: PoolConfig, slot: number, x: string, outVar: string): string {
    return [
      `  let ${outVar} = 0;`,
      `  if (s${slot}d > 0 && ${x} > 0) {`,
      `    if (s${slot}lx === ${x}) { ${outVar} = s${slot}lo }`,
      '    else {',
      ...this.emitQuoteAt(slot, 'f', x, `s${slot}d`, false, outVar),
      '    }',
      '  }',
    ].join('\n');
  },

  /**
   * Shared fee/vault/Newton computation up to the post-vault-withdraw
   * candidate `<v>ov`; `warm` threads the shared `s<slot>wy` cursor
   * (mutated in place) and TAILS into a residual never-over-quote guard
   * (the caller already clamped `x` to the analytic capacity, so `<v>ov` is
   * PROVEN to clear the idle float — this guard only ever fails to fire,
   * see this file's module doc); cold declares a fresh `y` const and TAILS
   * into the raw idle-float COLLAPSE, assigning `coldOutVar` — the declared,
   * merge-unreachable, latent idle-float cliff (see this file's module doc and
   * `emitFinalQuote`). It sits in the same GENERAL class of merge-unreachable
   * cold-quote gap as orca-whirlpool/raydium-clmm/meteora-dlmm/solfi-v2 — a
   * standalone cold `referenceQuote` that collapses past a bound the caller's
   * analytic-capacity clamp keeps off the merge path — but NOT the same
   * MECHANISM: the three CL families' cliff is a tick/bin cold-walk window
   * exhaustion (their `coldWalkClamped` convention, see this file's module doc)
   * and solfi-v2's is a closed-form output-vault saturation, whereas this
   * family's is the idle-float / double-floor vault-withdraw collapse. And of
   * the five, only THIS family's cold quote still collapses: the other four
   * were saturated by the five-family correctness batch, leaving this the sole
   * `declaredCliffs` entry (see sdk/test/svm/venues/ladder-contract.test.ts).
   */
  emitQuoteAt(slot: number, tag: string, x: string, y0: string, warm: boolean, coldOutVar?: string): string[] {
    const v = (name: string): string => `s${slot}${name}${tag}`;
    const yVar = warm ? `s${slot}wy` : v('y');
    return [
      // Input-token fees with the min-1 rule; protocol fee is a cut of the trade fee.
      `      let ${v('tf')} = ${x} * s${slot}fn / s${slot}fd;`,
      `      if (s${slot}fn > 0 && ${v('tf')} === 0) { ${v('tf')} = 1 }`,
      `      let ${v('pf')} = ${v('tf')} * s${slot}pn / s${slot}pd;`,
      `      if (s${slot}pn > 0 && ${v('tf')} > 0 && ${v('pf')} === 0) { ${v('pf')} = 1 }`,
      `      ${v('tf')} = ${v('tf')} - ${v('pf')};`,
      `      const ${v('in')} = ${x} - ${v('pf')};`,
      // Vault deposit simulation (unlocked' = unlocked + inNet).
      `      const ${v('lp')} = ${v('in')} * s${slot}asu / s${slot}au;`,
      `      const ${v('af')} = (${v('lp')} + s${slot}alp) * (s${slot}au + ${v('in')}) / (s${slot}asu + ${v('lp')});`,
      // Dust guard: fees past the simulated total would wrap in-VM (and
      // revert on-chain) — quote 0, keep the warm cursor untouched.
      `      if (${v('af')} >= s${slot}rin + ${v('tf')}) {`,
      `        const ${v('sn')} = ${v('af')} - s${slot}rin - ${v('tf')};`,
      ...(warm
        ? [`        ${yVar} = stableYW(s${slot}amp, (s${slot}rin + ${v('sn')}) * s${slot}ma, s${slot}d, ${y0});`]
        : [`        const ${yVar} = stableYW(s${slot}amp, (s${slot}rin + ${v('sn')}) * s${slot}ma, s${slot}d, ${y0});`]),
      `        const ${v('db')} = s${slot}rout * s${slot}mb;`,
      `        if (${v('db')} > ${yVar}) {`,
      `          const ${v('de')} = (${v('db')} - ${yVar} - 1) / s${slot}mb;`,
      // Vault withdraw simulation (two more floors).
      `          const ${v('ol')} = ${v('de')} * s${slot}bsu / s${slot}bu;`,
      `          const ${v('ov')} = ${v('ol')} * s${slot}bu / s${slot}bsu;`,
      // Idle-float bound tail: residual never-over-quote guard (warm,
      // ladder-chain — the caller already clamped x) vs COLLAPSE (cold,
      // declared latent gap).
      ...(warm
        ? [`          if (${v('ov')} < s${slot}idl) { s${slot}lo = ${v('ov')}; s${slot}lx = ${x}; }`]
        : [`          if (${v('ov')} >= s${slot}idl) { ${v('ov')} = 0 }`, `          ${coldOutVar} = ${v('ov')};`]),
      '        }',
      '      }',
    ];
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const cfg = d1sConfig(base);
    // disc(8) ++ in_amount u64 LE (runtime-patched) ++ minimum_out_amount
    // u64 LE = 1. Same 15-account list for both directions; A → B puts inAta
    // on the source side and the A-side protocol fee account at index 11.
    const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
    return {
      programId: meteoraDammV1Stable.programId,
      prefix: Uint8Array.from(SWAP_DISCRIMINATOR),
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
      patch: 'in',
      accounts: [
        roled('pool', cfg.pool, true),
        { ref: user.inAta, writable: true },
        { ref: user.outAta, writable: true },
        roled('av', cfg.aVault, true),
        roled('bv', cfg.bVault, true),
        roled('atv', cfg.aTokenVault, true),
        roled('btv', cfg.bTokenVault, true),
        roled('alpm', cfg.aLpMint, true),
        roled('blpm', cfg.bLpMint, true),
        roled('avlp', cfg.aVaultLp, true),
        roled('bvlp', cfg.bVaultLp, true),
        roled('pfa', cfg.protocolTokenAFee, true),
        { ref: user.owner, signer: true },
        roled('vprog', VAULT_PROGRAM_ID),
        roled('tp', TOKEN_PROGRAM),
      ],
    };
  },

  referenceQuote(
    base: PoolConfig,
    state: AccountBytesMap,
    _params: readonly bigint[],
    now?: bigint,
  ): (x: bigint) => bigint {
    const live = liveState(d1sConfig(base), state, now ?? BigInt(Math.floor(Date.now() / 1000)));
    return (x: bigint): bigint => {
      if (live.d === 0n || x === 0n) return 0n;
      // COLD — the DECLARED, merge-unreachable, latent idle-float collapse
      // (see this file's module doc; capacityInputVar/referenceCapacities
      // keep the ladder-chain path itself from ever reaching it).
      return quoteColdCollapsing(live, x, live.d).out;
    };
  },

  referenceLadderQuotes(
    base: PoolConfig,
    state: AccountBytesMap,
    _params: readonly bigint[],
    now?: bigint,
  ): (grid: readonly bigint[]) => bigint[] {
    const live = liveState(d1sConfig(base), state, now ?? BigInt(Math.floor(Date.now() / 1000)));
    return (grid: readonly bigint[]): bigint[] => ladderWalk(live, grid).outs;
  },

  /**
   * Mirror of capacityInputVar: the cumulative PRODUCTIVE input at each
   * ordered grid point — clamped to the analytic capacity `xc` once a
   * rung's own grid point would exceed it (never the raw grid point past
   * that; see this file's module doc), frozen forever after. Lockstep with
   * referenceLadderQuotes (same walk, same clamp).
   */
  referenceCapacities(
    base: PoolConfig,
    state: AccountBytesMap,
    _params: readonly bigint[],
    now?: bigint,
  ): (grid: readonly bigint[]) => bigint[] {
    const live = liveState(d1sConfig(base), state, now ?? BigInt(Math.floor(Date.now() / 1000)));
    return (grid: readonly bigint[]): bigint[] => ladderWalk(live, grid).caps;
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap, now?: bigint): { reserveIn: bigint; reserveOut: bigint } {
    const live = liveState(d1sConfig(base), state, now ?? BigInt(Math.floor(Date.now() / 1000)));
    return { reserveIn: live.rin, reserveOut: live.rout };
  },

  continuousFees(base: PoolConfig, state: AccountBytesMap): { gammaPpm: bigint; muPpm: bigint } {
    const cfg = d1sConfig(base);
    const pool = state[cfg.pool];
    if (pool === undefined) throw new Error(`${SLUG} ladder fees are missing account ${cfg.pool}`);
    const fn = readUintLE(pool, POOL.tradeFeeNumerator, 8);
    const fd = readUintLE(pool, POOL.tradeFeeDenominator, 8);
    // Input-side fee retention; the CP form badly understates a stable
    // curve's depth — measurement oracle only, never a gate.
    return { gammaPpm: fd === 0n ? 1_000_000n : 1_000_000n - (fn * 1_000_000n) / fd, muPpm: 1_000_000n };
  },
} satisfies SvmVenueLadderV2 & {
  emitQuoteAt(slot: number, tag: string, x: string, y0: string, warm: boolean, coldOutVar?: string): string[];
};
