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
 * - the strict idle-float bound clamps to 0 (funds deployed to lending
 *   strategies are not withdrawable inside swap).
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
 * One quote over the live state with a caller-supplied Newton start (the
 * warm chain threads y0; the cold path passes d). Returns the new y cursor
 * alongside the output so the chain can advance even on a 0-quote rung.
 */
function quoteWithStart(live: D1sLive, x: bigint, y0: bigint): { out: bigint; y: bigint } {
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
  if (after < live.rin + tf) return { out: 0n, y: y0 };
  const srcNet = after - live.rin - tf;
  const y = stableComputeYWarm(live.amp, (live.rin + srcNet) * live.ma, live.d, y0);
  const db = live.rout * live.mb;
  if (db <= y) return { out: 0n, y };
  const dest = engineDiv(db - y - 1n, live.mb);
  // Vault withdraw simulation (two more floors), then the strict idle-float bound.
  const outLp = engineDiv(dest * live.bsu, live.bu);
  let out = engineDiv(outLp * live.bu, live.bsu);
  if (out >= live.idle) out = 0n;
  return { out, y };
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
    ].join('\n');
  },

  emitQuoteCall: undefined,

  emitLadderQuote(_base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string {
    return [
      ...(rung === 0 ? [`    let s${slot}wy = s${slot}d;`] : []),
      ...this.emitQuoteBody(slot, `${rung}`, x, outVar, `s${slot}wy`, true),
    ].join('\n');
  },

  emitFinalQuote(_base: PoolConfig, slot: number, x: string, outVar: string): string {
    // COLD: y0 = D — byte-identical to the venue's own swap path.
    return this.emitQuoteBody(slot, 'f', x, outVar, `s${slot}d`, false).join('\n');
  },

  /** Shared quote body; `warm` threads the y cursor local, cold reads y0 fresh. */
  emitQuoteBody(slot: number, tag: string, x: string, outVar: string, y0: string, warm: boolean): string[] {
    const v = (name: string): string => `s${slot}${name}${tag}`;
    const yVar = warm ? `s${slot}wy` : v('y');
    return [
      `  let ${outVar} = 0;`,
      `  if (s${slot}d > 0 && ${x} > 0) {`,
      // Input-token fees with the min-1 rule; protocol fee is a cut of the trade fee.
      `    let ${v('tf')} = ${x} * s${slot}fn / s${slot}fd;`,
      `    if (s${slot}fn > 0 && ${v('tf')} === 0) { ${v('tf')} = 1 }`,
      `    let ${v('pf')} = ${v('tf')} * s${slot}pn / s${slot}pd;`,
      `    if (s${slot}pn > 0 && ${v('tf')} > 0 && ${v('pf')} === 0) { ${v('pf')} = 1 }`,
      `    ${v('tf')} = ${v('tf')} - ${v('pf')};`,
      `    const ${v('in')} = ${x} - ${v('pf')};`,
      // Vault deposit simulation (unlocked' = unlocked + inNet).
      `    const ${v('lp')} = ${v('in')} * s${slot}asu / s${slot}au;`,
      `    const ${v('af')} = (${v('lp')} + s${slot}alp) * (s${slot}au + ${v('in')}) / (s${slot}asu + ${v('lp')});`,
      // Dust guard: fees past the simulated total would wrap in-VM (and
      // revert on-chain) — quote 0, keep the warm cursor.
      `    if (${v('af')} >= s${slot}rin + ${v('tf')}) {`,
      `      const ${v('sn')} = ${v('af')} - s${slot}rin - ${v('tf')};`,
      ...(warm
        ? [`      ${yVar} = stableYW(s${slot}amp, (s${slot}rin + ${v('sn')}) * s${slot}ma, s${slot}d, ${y0});`]
        : [`      const ${yVar} = stableYW(s${slot}amp, (s${slot}rin + ${v('sn')}) * s${slot}ma, s${slot}d, ${y0});`]),
      `      const ${v('db')} = s${slot}rout * s${slot}mb;`,
      `      if (${v('db')} > ${yVar}) {`,
      `        const ${v('de')} = (${v('db')} - ${yVar} - 1) / s${slot}mb;`,
      // Vault withdraw simulation, then the strict idle-float bound.
      `        const ${v('ol')} = ${v('de')} * s${slot}bsu / s${slot}bu;`,
      `        let ${v('ov')} = ${v('ol')} * s${slot}bu / s${slot}bsu;`,
      `        if (${v('ov')} >= s${slot}idl) { ${v('ov')} = 0 }`,
      `        ${outVar} = ${v('ov')};`,
      '      }',
      '    }',
      '  }',
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
      return quoteWithStart(live, x, live.d).out; // COLD
    };
  },

  referenceLadderQuotes(
    base: PoolConfig,
    state: AccountBytesMap,
    _params: readonly bigint[],
    now?: bigint,
  ): (grid: readonly bigint[]) => bigint[] {
    const live = liveState(d1sConfig(base), state, now ?? BigInt(Math.floor(Date.now() / 1000)));
    return (grid: readonly bigint[]): bigint[] => {
      let wy = live.d;
      return grid.map((g) => {
        if (live.d === 0n || g === 0n) return 0n; // cursor unchanged, exactly like the fragment
        const { out, y } = quoteWithStart(live, g, wy);
        wy = y;
        return out;
      });
    };
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
  emitQuoteBody(slot: number, tag: string, x: string, outVar: string, y0: string, warm: boolean): string[];
};
