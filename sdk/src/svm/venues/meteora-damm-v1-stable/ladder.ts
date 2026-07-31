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
 * The fix: `emitLadderQuote`/`referenceLadderQuotes` never report a collapse,
 * and never merely freeze at the last GRID checkpoint either (that shape —
 * shipped in an earlier pass of this fix — still under-serves: with only
 * `defaultRungs` grid points, the very FIRST rung can already land past the
 * idle float, in which case "the last checkpoint" is `(0, 0)` — a TOTAL,
 * not partial, loss of this venue's contribution). Instead, the first rung
 * whose candidate would reach the idle float SEARCHES for the boundary —
 * false position (regula falsi) with the Illinois anti-stall correction,
 * bounded at `MAX_SEARCH_ROUNDS` (2 — see below for why exactly 2, a
 * measured CU budget, not a precision target), looking for the largest
 * cumulative input in (`s<slot>lx`, x] whose candidate still clears the
 * idle float. This is the orca-whirlpool/raydium-clmm/meteora-dlmm
 * `coldWalkClamped` convention ("the productive input AT THE WINDOW EDGE",
 * types.ts's capacityInputVar doc) carried out by search rather than a
 * discrete tick/bin walk (this curve has no discrete window to walk).
 * `s<slot>cap` latches permanently once the search completes — even when it
 * has NOT fully converged (see below), because a later rung's own grid
 * point can only be even LARGER (rungs are non-decreasing cumulative
 * inputs), so it could never do better than this search already tried;
 * `capacityInputVar`/`referenceCapacities` report the search's result. The
 * truly STANDALONE cold quote (`emitFinalQuote`'s cache-miss branch /
 * `referenceQuote` called at an arbitrary x the ladder chain never walked)
 * still collapses past the boundary: LATENT, saved only by the
 * ladder-chain's own capacity freeze (never merge-reachable, since the
 * merge only ever asks the final quote for the cumulative fill the ladder
 * chain itself produced, or for `s<slot>lx` itself, which the cache-hit
 * branch serves straight from `s<slot>lo` — see ladder-contract.test.ts's
 * declared-gap cases for the other four families carrying the exact same
 * shape).
 *
 * WHY ONLY 2 ROUNDS, AND WHY FALSE POSITION NOT PLAIN BISECTION — both
 * measured on the real engine (LiteSVM), not assumed:
 * - Each search round costs ~280k CU FLAT, dominated by the round's OWN
 *   Newton solve (`stableYW`) — NOT by whether the round is reached via a
 *   real function call or emitted inline (an earlier draft of this fix
 *   assumed inlining made extra rounds ~free; that was an artifact of the
 *   ONE test case it was measured against converging in a single round
 *   regardless of the round cap — round 2 measurably costs another ~280k,
 *   same as round 1). Setup + the breach-triggering rung already costs
 *   ~500-580k CU on its own (this family's own module doc: "the heaviest
 *   family"). 2 rounds lands at ~1.06M CU (measured), safely inside the
 *   1.4M absolute per-tx ceiling; 3 rounds (~1.34M) leaves only ~60k of
 *   slack once anything else shares the transaction — too tight to ship.
 * - Given only 2 rounds are affordable, false position (using the
 *   candidate's OUTPUT to place the next candidate, not just its sign)
 *   matters far more than it would at 64 rounds: it is EXACT, in 2 rounds
 *   or fewer, for a marginal breach — measured wei-exact on the real engine
 *   for the actual shape of the "TOTAL collapse" trigger (a `defaultRungs`
 *   grid whose first point lands just past the idle float, the scenario
 *   this fix exists for). Plain bisection ignores the candidate's value
 *   and would only have shaved the search interval by 4x in the same 2
 *   rounds — nowhere near converged either way. For a grossly oversized
 *   trade (measured: 2x/10x/2^63 the cliff) 2 rounds — with EITHER
 *   algorithm — is not always enough to find any productive point at all
 *   before the round budget runs out, and the search reports the SAME
 *   (0, 0) the pre-fix code did: a DISCLOSED limit of the 2-round CU
 *   budget (see MAX_SEARCH_ROUNDS's doc), not a claim that false position
 *   "gets closer" in that regime — never a regression (0 either way, for
 *   inputs this budget can't reach) and never unsafe: `s<slot>lx`/
 *   `s<slot>lo` are only ever written from a REAL forward-evaluated
 *   candidate (see `bisectCapacity`'s doc), so a search that runs out of
 *   rounds without finding one simply leaves the prior checkpoint
 *   untouched — never a fabricated value, never an over-quote.
 * - The Illinois correction (halving the stale endpoint's weight after two
 *   consecutive same-side updates) costs nothing extra (pure arithmetic on
 *   values already in scope) and is what makes the marginal-breach case
 *   exact within 2 rounds rather than needing more; it stays in even
 *   though it does not rescue the grossly-oversized regime at this round
 *   budget.
 * - The search is emitted INLINE (textual, per-rung, like the rest of this
 *   file) rather than as a second helper function calling a shared
 *   `quoteAt`-style helper: a V12/svm function's params are stack-resident
 *   and SDUP-reachable to a measured depth ceiling that this body's own
 *   15-value live-state shape already exhausts calling just ONE nested
 *   function (measured: "REF position out of range" once a second helper
 *   forwards those same values on to a shared quote helper). Calling
 *   nothing keeps this a non-issue.
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

// MEASURED on the real engine (LiteSVM, the fee-aware SVM interpreter): each
// search round costs ~280k CU FLAT — dominated by the round's own Newton
// solve (stableYW), not by round count, not by inline-vs-call overhead (an
// earlier draft assumed inlining made rounds ~free; measured false — a
// converged round-1-only case looked "free" only because it never ran a
// second round). Setup + the breach-triggering rung costs ~500-580k CU on
// its own (this family's own module doc: "the heaviest family"). 2 search
// rounds (~560k more) lands at ~1.06-1.32M CU depending on the gap
// (measured across several), safely inside the 1.4M absolute per-tx
// ceiling; 3 rounds (~1.34M in the cheapest case measured) leaves as little
// as ~60k of slack once anything else shares the transaction — too tight
// to ship, so this stays at 2. 2 rounds is EXACT — measured wei-exact on
// the real engine, matching the TS reference bit-for-bit — for a marginal
// breach: the `defaultRungs` grid landing just past the idle float, the
// actual shape of the "TOTAL collapse" trigger this fix exists for. For a
// grossly oversized trade (measured: 2x/10x/2^63 the cliff, starting from
// no prior checkpoint) 2 rounds is NOT always enough to find ANY productive
// point before the round budget runs out — the search can report the SAME
// (0, 0) the pre-fix code did. This is a DISCLOSED LIMIT, not a silent one:
// it is never a regression (0 is exactly what shipped before this fix, for
// exactly the inputs where this fix's 2-round budget can't do better), and
// it is never unsafe (see bisectCapacity's doc: `lx`/`lo` are only ever
// written from a genuine forward-evaluated candidate, so a search that
// exhausts its rounds without finding one just leaves the prior checkpoint
// — 0 here, since there wasn't one — untouched, never a fabricated value).
const MAX_SEARCH_ROUNDS = 2;

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

/**
 * TS mirror of the emitted inline search (`emitQuoteAt`'s breach branch):
 * false position (regula falsi) with the Illinois anti-stall correction,
 * bounded at 64 rounds — see this file's module doc for why false position
 * (not plain bisection) and why this is emitted INLINE (not a helper
 * function call). `knownGoodX`/`knownGoodOut` may be (0, 0) (no prior
 * checkpoint — out(0) = 0 < idle whenever idle > 0, a valid trivial lower
 * bound); `knownBadX`/`knownBadOut` must already breach (the caller only
 * invokes this once a candidate has been observed to).
 *
 * Returns the GENUINE (x, out) pair at the discovered boundary — `lx`/`lo`
 * are updated ONLY from real forward evaluations (`midOv`, computed via
 * `quoteRaw`), never from the Illinois-adjusted weight (`loW`/`hiOv`, used
 * ONLY to steer the next candidate). This is the load-bearing invariant: a
 * corrupted (Illinois-weighted) value must never be reported as an actual
 * quote, or the merge could receive a value that doesn't match ANY real x —
 * an over-quote risk. Lockstep with the emitted fragment: same loop bound,
 * same false-position formula, same Illinois correction, same clamp.
 */
function bisectCapacity(
  live: D1sLive,
  knownGoodX: bigint,
  knownGoodOut: bigint,
  knownBadX: bigint,
  knownBadOut: bigint,
): { lx: bigint; lo: bigint } {
  let lx = knownGoodX;
  let lo = knownGoodOut;
  let hiX = knownBadX;
  let hiOv = knownBadOut;
  let loW = knownGoodOut;
  let stallLo = 0;
  let stallHi = 0;
  for (let it = 0; it < MAX_SEARCH_ROUNDS && hiX - lx > 1n; it++) {
    let mid = lx + ((hiX - lx) * (live.idle - loW)) / (hiOv - loW);
    if (mid <= lx) mid = lx + 1n;
    if (mid >= hiX) mid = hiX - 1n;
    const midOv = quoteRaw(live, mid, live.d).out;
    if (midOv < live.idle) {
      lx = mid;
      lo = midOv;
      loW = midOv;
      stallLo++;
      if (stallLo >= 2) {
        hiOv = hiOv / 2n;
        stallLo = 0;
      }
      stallHi = 0;
    } else {
      hiX = mid;
      hiOv = midOv;
      stallHi++;
      if (stallHi >= 2) {
        loW = loW + (live.idle - loW) / 2n;
        stallHi = 0;
      }
      stallLo = 0;
    }
  }
  return { lx, lo };
}

interface LadderWalkResult {
  outs: bigint[];
  caps: bigint[];
}

/**
 * Shared walk backing both referenceLadderQuotes and referenceCapacities:
 * warm-threads y across the grid exactly like the emitted fragment: a
 * productive candidate (`reached && out < idle`) advances the (lo, lx)
 * checkpoint; a breach (`reached && out >= idle`) bisects the EXACT boundary
 * via `bisectCapacity` and freezes there PERMANENTLY (`capped`) — never the
 * pre-breach checkpoint verbatim, so a total breach on the very first grid
 * point still reports the real, nonzero productive capacity (the
 * orca-whirlpool "productive input at the window edge" convention). A
 * non-reach (the transient fee/dust guards, `!reached`) leaves the
 * checkpoint untouched, exactly like the pre-existing fragment — it is NOT
 * an idle-float breach and must never latch the freeze.
 */
function ladderWalk(live: D1sLive, grid: readonly bigint[]): LadderWalkResult {
  let wy = live.d;
  let lo = 0n;
  let lx = 0n;
  let capped = false;
  const outs: bigint[] = [];
  const caps: bigint[] = [];
  for (const g of grid) {
    if (live.d === 0n || g === 0n || capped) {
      outs.push(lo);
      caps.push(lx);
      continue;
    }
    const r = quoteRaw(live, g, wy);
    wy = r.y;
    if (r.reached) {
      if (r.out < live.idle) {
        lo = r.out;
        lx = g;
      } else {
        const found = bisectCapacity(live, lx, lo, g, r.out);
        lx = found.lx;
        lo = found.lo;
        capped = true;
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
    ].join('\n');
  },

  emitQuoteCall: undefined,

  /**
   * Ladder rung at cumulative grid point x: skips all computation once
   * `s<slot>cap` has latched (the search below already found the EXACT
   * global boundary — permanent, and no later rung's own candidate can ever
   * exceed it, so nothing later can move it); otherwise runs the WARM
   * fee/vault/Newton chain and either records the new (lo, lx) = (output,
   * cumulative input) checkpoint (candidate clears the idle float) or, on a
   * breach, searches for the exact boundary and latches cap. Reports the
   * CURRENT checkpoint every rung — 0 dOut/dIn once frozen, exactly the
   * window-walking convention (types.ts's capacityInputVar doc).
   */
  emitLadderQuote(_base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string {
    return [
      ...(rung === 0 ? [`    let s${slot}wy = s${slot}d;`] : []),
      `    if (s${slot}cap === 0 && s${slot}d > 0 && ${x} > 0) {`,
      ...this.emitQuoteAt(slot, `${rung}`, x, `s${slot}wy`, true),
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
   * (mutated in place) and TAILS into an inline false-position SEARCH for
   * the exact idle-float boundary (never a collapse, never merely the
   * pre-breach checkpoint — see this file's module doc); cold declares a
   * fresh `y` const and TAILS into the raw idle-float COLLAPSE, assigning
   * `coldOutVar` (the declared, merge-unreachable, latent gap this family
   * shares with orca-whirlpool/raydium-clmm/meteora-dlmm/solfi-v2).
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
      // Idle-float bound tail: FREEZE via inline SEARCH (warm, ladder-chain)
      // vs COLLAPSE (cold, declared latent gap).
      ...(warm ? this.emitBoundarySearch(slot, tag, x, v('ov')) : [`          if (${v('ov')} >= s${slot}idl) { ${v('ov')} = 0 }`, `          ${coldOutVar} = ${v('ov')};`]),
      '        }',
      '      }',
    ];
  },

  /**
   * Inline false-position (regula falsi) search with the Illinois anti-
   * stall correction, bounded at 64 rounds — see this file's module doc for
   * why false position (fast convergence via the candidate's VALUE, not
   * just its sign) and why inline (a real function call is expensive on
   * this target independent of what it computes; the SAME arithmetic
   * inline costs the same regardless of round count — measured). Finds the
   * exact largest cumulative input in (`s<slot>lx`, x] whose candidate still
   * clears the idle float, given the already-computed breaching candidate
   * `ovVar` at `x`. `s<slot>lx`/`s<slot>lo` are mutated ONLY from genuine
   * forward-computed candidates (never the Illinois-adjusted weight
   * `<v>low`/`<v>bhov`, which exists purely to steer the next candidate) —
   * the load-bearing invariant that keeps every reported (lo, lx) pair a
   * real, wei-exact quote (never an over-quote).
   */
  emitBoundarySearch(slot: number, tag: string, x: string, ovVar: string): string[] {
    const v = (name: string): string => `s${slot}b${name}${tag}`;
    return [
      `          if (${ovVar} >= s${slot}idl) {`,
      `            let ${v('hx')} = ${x};`,
      `            let ${v('ho')} = ${ovVar};`,
      `            let ${v('low')} = s${slot}lo;`,
      `            let ${v('sl')} = 0;`,
      `            let ${v('sh')} = 0;`,
      `            for (let ${v('i')} = 0; ${v('i')} < ${MAX_SEARCH_ROUNDS} && ${v('hx')} - s${slot}lx > 1; ${v('i')} = ${v('i')} + 1) {`,
      `              let ${v('mid')} = s${slot}lx + (${v('hx')} - s${slot}lx) * (s${slot}idl - ${v('low')}) / (${v('ho')} - ${v('low')});`,
      `              if (${v('mid')} <= s${slot}lx) { ${v('mid')} = s${slot}lx + 1 }`,
      `              if (${v('mid')} >= ${v('hx')}) { ${v('mid')} = ${v('hx')} - 1 }`,
      `              let ${v('tf')} = ${v('mid')} * s${slot}fn / s${slot}fd;`,
      `              if (s${slot}fn > 0 && ${v('tf')} === 0) { ${v('tf')} = 1 }`,
      `              let ${v('pf')} = ${v('tf')} * s${slot}pn / s${slot}pd;`,
      `              if (s${slot}pn > 0 && ${v('tf')} > 0 && ${v('pf')} === 0) { ${v('pf')} = 1 }`,
      `              ${v('tf')} = ${v('tf')} - ${v('pf')};`,
      `              const ${v('in')} = ${v('mid')} - ${v('pf')};`,
      `              const ${v('lp')} = ${v('in')} * s${slot}asu / s${slot}au;`,
      `              const ${v('af')} = (${v('lp')} + s${slot}alp) * (s${slot}au + ${v('in')}) / (s${slot}asu + ${v('lp')});`,
      `              let ${v('mo')} = 0;`,
      `              if (${v('af')} >= s${slot}rin + ${v('tf')}) {`,
      `                const ${v('sn')} = ${v('af')} - s${slot}rin - ${v('tf')};`,
      `                const ${v('y')} = stableYW(s${slot}amp, (s${slot}rin + ${v('sn')}) * s${slot}ma, s${slot}d, s${slot}d);`,
      `                const ${v('db')} = s${slot}rout * s${slot}mb;`,
      `                if (${v('db')} > ${v('y')}) {`,
      `                  const ${v('de')} = (${v('db')} - ${v('y')} - 1) / s${slot}mb;`,
      `                  const ${v('ol')} = ${v('de')} * s${slot}bsu / s${slot}bu;`,
      `                  ${v('mo')} = ${v('ol')} * s${slot}bu / s${slot}bsu;`,
      '                }',
      '              }',
      `              if (${v('mo')} < s${slot}idl) {`,
      `                s${slot}lx = ${v('mid')}; s${slot}lo = ${v('mo')}; ${v('low')} = ${v('mo')}; ${v('sl')} = ${v('sl')} + 1;`,
      `                if (${v('sl')} >= 2) { ${v('ho')} = ${v('ho')} / 2; ${v('sl')} = 0 }`,
      `                ${v('sh')} = 0;`,
      '              } else {',
      `                ${v('hx')} = ${v('mid')}; ${v('ho')} = ${v('mo')}; ${v('sh')} = ${v('sh')} + 1;`,
      `                if (${v('sh')} >= 2) { ${v('low')} = ${v('low')} + (s${slot}idl - ${v('low')}) / 2; ${v('sh')} = 0 }`,
      `                ${v('sl')} = 0;`,
      '              }',
      '            }',
      `            s${slot}cap = 1;`,
      '          }',
      `          else { s${slot}lo = ${ovVar}; s${slot}lx = ${x}; }`,
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
   * ordered grid point — the BISECTED exact boundary once a rung's candidate
   * first breaches the idle float (never the last-observed grid checkpoint;
   * see this file's module doc), frozen forever after. Lockstep with
   * referenceLadderQuotes (same walk, same bisection).
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
  emitBoundarySearch(slot: number, tag: string, x: string, ovVar: string): string[];
};
