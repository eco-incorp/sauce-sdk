/**
 * Meteora DAMM v1 constant-product adapter v2 (EcoSwapSVM ladder fragment) —
 * the sibling of ../meteora-damm-v1-stable/ladder.ts for CurveType::ConstantProduct
 * pools. Vault share math (locked-profit decay, LP-supply share floors) and
 * the vault deposit/withdraw simulations are IDENTICAL to the stable sibling;
 * the only difference is the curve step, which is the SAME ceiling-divided
 * constant-product form as ../orca-legacy-token-swap/ladder.ts's `qOrca`
 * helper (spl-token-swap lineage) instead of Newton stableswap. Unlike the
 * stable sibling, a CP quote is POINTWISE (no warm-start chain across ladder
 * rungs), so this family uses emitQuoteCall (one helper-function expression)
 * rather than the statement-form emitLadderQuote/emitFinalQuote pair.
 *
 * Direction is A -> B only (token_a -> token_b), matching the stable
 * sibling's single-direction convention.
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
import { meteoraDammV1Cp } from './index.js';
import type { MeteoraDammV1CpPoolConfig } from './index.js';

const SLUG = 'meteora-damm-v1-cp';
const VAULT_PROGRAM_ID = '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi' as Address;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;

// sha256("global:swap")[..8].
const SWAP_DISCRIMINATOR = [0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8];

const DEG = 1_000_000_000_000n;

const POOL = {
  tradeFeeNumerator: 330,
  tradeFeeDenominator: 338,
  protocolTradeFeeNumerator: 346,
  protocolTradeFeeDenominator: 354,
} as const;
const VAULT = { totalAmount: 11, lastUpdatedLockedProfit: 1203, lastReport: 1211, lockedProfitDegradation: 1219 } as const;
const TOKEN_AMOUNT = 64;
const MINT_SUPPLY = 36;

function d1cpConfig(cfg: PoolConfig): MeteoraDammV1CpPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as MeteoraDammV1CpPoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

/** The engine's DIV rule: a zero divisor yields 0 (never throws). */
const engineDiv = (a: bigint, b: bigint): bigint => (b === 0n ? 0n : a / b);

interface D1cpLive {
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
  idle: bigint;
}

function liveState(cfg: MeteoraDammV1CpPoolConfig, state: AccountBytesMap, now: bigint): D1cpLive {
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
    // Same wrapped-clock mirroring as the stable sibling (docs/svm-venues.md).
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
  const idle = readUintLE(bytes(cfg.bTokenVault, 'b token vault'), TOKEN_AMOUNT, 8);
  return { rin, rout, au, bu, alp, asu, bsu, fn, fd, pn, pd, idle };
}

/** Pointwise CP quote over the live state — no warm-start needed (TS mirror of qDammCp). */
function quoteAt(live: D1cpLive, x: bigint): bigint {
  if (x === 0n) return 0n;
  let tf = engineDiv(x * live.fn, live.fd);
  if (live.fn > 0n && tf === 0n) tf = 1n;
  let pf = engineDiv(tf * live.pn, live.pd);
  if (live.pn > 0n && tf > 0n && pf === 0n) pf = 1n;
  tf -= pf;
  const inNet = x - pf;
  const inLp = engineDiv(inNet * live.asu, live.au);
  const after = engineDiv((inLp + live.alp) * (live.au + inNet), live.asu + inLp);
  if (after < live.rin + tf) return 0n;
  const srcNet = after - live.rin - tf;
  const ni = live.rin + srcNet;
  if (ni === 0n) return 0n;
  if (engineDiv(live.rin * live.rout, ni) === 0n) return 0n;
  const no = engineDiv(live.rin * live.rout + ni - 1n, ni);
  if (no >= live.rout) return 0n;
  const dest = live.rout - no;
  const outLp = engineDiv(dest * live.bsu, live.bu);
  let out = engineDiv(outLp * live.bu, live.bsu);
  if (out >= live.idle) out = 0n;
  return out;
}

export const meteoraDammV1CpLadder = {
  slug: SLUG,

  /** CP default — no explicit defaultRungs (the codegen falls back to 4). */

  shapeKey(): string {
    return `${SLUG}:AtoB`;
  },

  helpers(): { name: string; source: string }[] {
    return [
      {
        name: 'qDammCp',
        source: [
          'function qDammCp(x, rin, rout, au, bu, alp, asu, bsu, fn, fd, pn, pd, idle) {',
          '  if (x === 0) { return 0 }',
          '  let tf = x * fn / fd;',
          '  if (fn > 0 && tf === 0) { tf = 1 }',
          '  let pf = tf * pn / pd;',
          '  if (pn > 0 && tf > 0 && pf === 0) { pf = 1 }',
          '  tf = tf - pf;',
          '  const inNet = x - pf;',
          '  const inLp = inNet * asu / au;',
          '  const after = (inLp + alp) * (au + inNet) / (asu + inLp);',
          '  if (after < rin + tf) { return 0 }',
          '  const srcNet = after - rin - tf;',
          '  const ni = rin + srcNet;',
          '  if (ni === 0) { return 0 }',
          '  if (rin * rout / ni === 0) { return 0 }',
          '  const no = (rin * rout + ni - 1) / ni;',
          '  if (no >= rout) { return 0 }',
          '  const dest = rout - no;',
          '  const outLp = dest * bsu / bu;',
          '  let out = outLp * bu / bsu;',
          '  if (out >= idle) { out = 0 }',
          '  return out;',
          '}',
        ].join('\n'),
      },
    ];
  },

  /** Everything is a live read — no per-trade params (matches the stable sibling). */
  paramCount: 0,

  paramsFor(_base: PoolConfig): bigint[] {
    return [];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const cfg = d1cpConfig(base);
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

  emitSetup(base: PoolConfig, slot: number): string {
    void base;
    const av = JSON.stringify(ref(slot, 'av'));
    const bv = JSON.stringify(ref(slot, 'bv'));
    const pool = JSON.stringify(ref(slot, 'pool'));
    return [
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
      `  const s${slot}alp = accountUint(${JSON.stringify(ref(slot, 'avlp'))}, ${TOKEN_AMOUNT}, 8);`,
      `  const s${slot}blp = accountUint(${JSON.stringify(ref(slot, 'bvlp'))}, ${TOKEN_AMOUNT}, 8);`,
      `  const s${slot}asu = accountUint(${JSON.stringify(ref(slot, 'alpm'))}, ${MINT_SUPPLY}, 8);`,
      `  const s${slot}bsu = accountUint(${JSON.stringify(ref(slot, 'blpm'))}, ${MINT_SUPPLY}, 8);`,
      `  const s${slot}rin = s${slot}alp * s${slot}au / s${slot}asu;`,
      `  const s${slot}rout = s${slot}blp * s${slot}bu / s${slot}bsu;`,
      `  const s${slot}fn = accountUint(${pool}, ${POOL.tradeFeeNumerator}, 8);`,
      `  const s${slot}fd = accountUint(${pool}, ${POOL.tradeFeeDenominator}, 8);`,
      `  const s${slot}pn = accountUint(${pool}, ${POOL.protocolTradeFeeNumerator}, 8);`,
      `  const s${slot}pd = accountUint(${pool}, ${POOL.protocolTradeFeeDenominator}, 8);`,
      `  const s${slot}idl = accountUint(${JSON.stringify(ref(slot, 'btv'))}, ${TOKEN_AMOUNT}, 8);`,
    ].join('\n');
  },

  emitQuoteCall(_base: PoolConfig, slot: number, x: string): string {
    return `qDammCp(${x}, s${slot}rin, s${slot}rout, s${slot}au, s${slot}bu, s${slot}alp, s${slot}asu, s${slot}bsu, s${slot}fn, s${slot}fd, s${slot}pn, s${slot}pd, s${slot}idl)`;
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const cfg = d1cpConfig(base);
    const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
    return {
      programId: meteoraDammV1Cp.programId,
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
    const live = liveState(d1cpConfig(base), state, now ?? BigInt(Math.floor(Date.now() / 1000)));
    return (x: bigint): bigint => quoteAt(live, x);
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap, now?: bigint): { reserveIn: bigint; reserveOut: bigint } {
    const live = liveState(d1cpConfig(base), state, now ?? BigInt(Math.floor(Date.now() / 1000)));
    return { reserveIn: live.rin, reserveOut: live.rout };
  },

  continuousFees(base: PoolConfig, state: AccountBytesMap): { gammaPpm: bigint; muPpm: bigint } {
    const cfg = d1cpConfig(base);
    const pool = state[cfg.pool];
    if (pool === undefined) throw new Error(`${SLUG} ladder fees are missing account ${cfg.pool}`);
    const fn = readUintLE(pool, POOL.tradeFeeNumerator, 8);
    const fd = readUintLE(pool, POOL.tradeFeeDenominator, 8);
    return { gammaPpm: fd === 0n ? 1_000_000n : 1_000_000n - (fn * 1_000_000n) / fd, muPpm: 1_000_000n };
  },
} satisfies SvmVenueLadderV2;
