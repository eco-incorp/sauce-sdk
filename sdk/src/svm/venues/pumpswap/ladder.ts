/**
 * PumpSwap adapter v2 (EcoSwapSVM ladder fragment) — constant product over
 * raw SPL vault balances, read LIVE in-VM; the gross input arrives at
 * runtime. The fee bps (lp/protocol/creator, flat or the market-cap tier
 * selected at fetch time) ride as per-trade PARAMS, not compile-time
 * constants — a fee change re-encodes 24 payload bytes instead of
 * re-staging the blob. Staleness across an admin fee change or a canonical
 * tier boundary is covered by the recipe's terminal outAta delta check
 * (same contract as ./index.ts's baked tier).
 *
 * Direction is part of the shape: 'quoteToBase' compiles the buy helper
 * (buy_exact_quote_in — pre-swap fee strip off the spendable budget, the
 * program's own eff−1 adjustment), 'baseToQuote' the sell helper (fees
 * per-component ceil'd off the output). Both mirror docs/svm-venues.md
 * byte-exactly.
 */
import { address } from '@solana/kit';
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
import { PUMPSWAP_PROGRAM_ID, USER_VOLUME_ACCUMULATOR_REF } from './index.js';
import type { PumpswapPoolConfig } from './index.js';

const SLUG = 'pumpswap';
const FEE_PROGRAM = address('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const GLOBAL_CONFIG = address('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
const FEE_CONFIG = address('5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx');
const EVENT_AUTHORITY = address('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
const GLOBAL_VOLUME_ACCUMULATOR = address('C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw');
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
const ASSOCIATED_TOKEN_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const BUY_EXACT_QUOTE_IN_DISCRIMINATOR = [198, 46, 21, 82, 180, 217, 232, 112];
const SELL_DISCRIMINATOR = [51, 230, 133, 164, 1, 127, 131, 173];

const BPS = 10_000n;
const VAULT_AMOUNT_OFFSET = 64;

function psConfig(cfg: PoolConfig): PumpswapPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as PumpswapPoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

export const pumpswapLadder = {
  slug: SLUG,

  shapeKey(base: PoolConfig): string {
    const cfg = psConfig(base);
    // The pool-v2 remaining account is present only when coin_creator is set,
    // so its presence changes the baked CPI account list — part of the shape.
    return `${SLUG}:${cfg.direction}${cfg.poolV2 !== undefined ? ':v2' : ''}`;
  },

  helperName(base: PoolConfig): string {
    return psConfig(base).direction === 'quoteToBase' ? 'qPumpBuy' : 'qPumpSell';
  },

  helperSource(base: PoolConfig): string {
    if (psConfig(base).direction === 'quoteToBase') {
      // buy_exact_quote_in: strip the fee share off the spendable budget
      // (each component ceil'd separately, over-budget corrected), then the
      // invariant swap runs on eff − 1. eff < 2 returns 0 — the venue-side
      // throw guard, kept out of the ladder so dust rungs just never win.
      return [
        'function qPumpBuy(x, rb, rq, lp, prot, cr) {',
        '  if (x === 0) { return 0 }',
        '  let eff = (x * 10000) / (10000 + lp + prot + cr);',
        '  const fees = (eff * lp + 9999) / 10000 + (eff * prot + 9999) / 10000 + (eff * cr + 9999) / 10000;',
        '  if (eff + fees > x) { eff = eff - (eff + fees - x) }',
        '  if (eff < 2) { return 0 }',
        '  const ia = eff - 1;',
        '  return Math.mulDiv(rb, ia, rq + ia);',
        '}',
      ].join('\n');
    }
    // sell: fees are per-component ceilDiv on the OUTPUT.
    return [
      'function qPumpSell(x, rb, rq, lp, prot, cr) {',
      '  if (x === 0) { return 0 }',
      '  const qo = Math.mulDiv(rq, x, rb + x);',
      '  return qo - (qo * lp + 9999) / 10000 - (qo * prot + 9999) / 10000 - (qo * cr + 9999) / 10000;',
      '}',
    ].join('\n');
  },

  /** Three params: lpFeeBps, protocolFeeBps, creatorFeeBps. */
  paramCount: 3,

  paramsFor(base: PoolConfig): bigint[] {
    const cfg = psConfig(base);
    return [cfg.lpFeeBps, cfg.protocolFeeBps, cfg.creatorFeeBps];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const cfg = psConfig(base);
    return [
      { ref: ref(slot, 'bvault'), address: cfg.baseVault },
      { ref: ref(slot, 'qvault'), address: cfg.quoteVault },
    ];
  },

  emitSetup(base: PoolConfig, slot: number, params: readonly string[]): string {
    return [
      `  const s${slot}rb = accountUint(${JSON.stringify(ref(slot, 'bvault'))}, ${VAULT_AMOUNT_OFFSET}, 8);`,
      `  const s${slot}rq = accountUint(${JSON.stringify(ref(slot, 'qvault'))}, ${VAULT_AMOUNT_OFFSET}, 8);`,
      `  const s${slot}lp = ${params[0]};`,
      `  const s${slot}pr = ${params[1]};`,
      `  const s${slot}crf = ${params[2]};`,
    ].join('\n');
  },

  emitQuoteCall(base: PoolConfig, slot: number, x: string): string {
    const helper = psConfig(base).direction === 'quoteToBase' ? 'qPumpBuy' : 'qPumpSell';
    return `${helper}(${x}, s${slot}rb, s${slot}rq, s${slot}lp, s${slot}pr, s${slot}crf)`;
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const cfg = psConfig(base);
    const sell = cfg.direction === 'baseToQuote';
    if (sell && (cfg.disableFlags & (1 << 4)) !== 0) {
      throw new Error(`${SLUG} gate: sells are disabled (global config disable_flags ${cfg.disableFlags})`);
    }

    // buy_exact_quote_in: disc ++ spendable_quote_in u64 (patched) ++
    // min_base_amount_out u64 = 1 ++ track_volume OptionBool 0x00.
    // sell: disc ++ base_amount_in u64 (patched) ++ min_quote_amount_out = 1.
    const prefix = Uint8Array.from(sell ? SELL_DISCRIMINATOR : BUY_EXACT_QUOTE_IN_DISCRIMINATOR);
    const suffix = Uint8Array.from(sell ? [1, 0, 0, 0, 0, 0, 0, 0] : [1, 0, 0, 0, 0, 0, 0, 0, 0]);

    const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
    const userBaseAta = sell ? user.inAta : user.outAta;
    const userQuoteAta = sell ? user.outAta : user.inAta;
    const accounts: VenueAccount[] = [
      roled('pool', cfg.pool, true),
      { ref: user.owner, writable: true, signer: true },
      roled('gcfg', GLOBAL_CONFIG),
      roled('bmint', cfg.baseMint),
      roled('qmint', cfg.quoteMint),
      { ref: userBaseAta, writable: true },
      { ref: userQuoteAta, writable: true },
      roled('bvault', cfg.baseVault, true),
      roled('qvault', cfg.quoteVault, true),
      roled('pfr', cfg.protocolFeeRecipient),
      roled('pfrata', cfg.protocolFeeRecipientTokenAccount, true),
      roled('tpb', cfg.baseTokenProgram),
      roled('tpq', cfg.quoteTokenProgram),
      roled('sys', SYSTEM_PROGRAM),
      roled('atp', ASSOCIATED_TOKEN_PROGRAM),
      roled('evt', EVENT_AUTHORITY),
      roled('amm', PUMPSWAP_PROGRAM_ID),
      roled('ccva', cfg.coinCreatorVaultAta, true),
      roled('ccauth', cfg.coinCreatorVaultAuthority),
    ];
    if (!sell) {
      accounts.push(roled('gvol', GLOBAL_VOLUME_ACCUMULATOR));
      accounts.push({ ref: USER_VOLUME_ACCUMULATOR_REF, writable: true });
    }
    accounts.push(roled('fcfg', FEE_CONFIG), roled('fprog', FEE_PROGRAM));
    if (cfg.poolV2 !== undefined) accounts.push(roled('pv2', cfg.poolV2));
    accounts.push(roled('bbr', cfg.buybackFeeRecipient), roled('bbrata', cfg.buybackFeeRecipientTokenAccount, true));

    return { programId: PUMPSWAP_PROGRAM_ID, prefix, suffix, patch: 'in', accounts };
  },

  referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint {
    const cfg = psConfig(base);
    const bytes = (addr: Address): Uint8Array => {
      const data = state[addr];
      if (data === undefined) throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
      return data;
    };
    const rb = readUintLE(bytes(cfg.baseVault), VAULT_AMOUNT_OFFSET, 8);
    const rq = readUintLE(bytes(cfg.quoteVault), VAULT_AMOUNT_OFFSET, 8);
    const [lp, prot, cr] = params;

    if (cfg.direction === 'quoteToBase') {
      return (x: bigint): bigint => {
        if (x === 0n) return 0n;
        let eff = (x * BPS) / (BPS + lp + prot + cr);
        const fees = (eff * lp + 9999n) / BPS + (eff * prot + 9999n) / BPS + (eff * cr + 9999n) / BPS;
        if (eff + fees > x) eff -= eff + fees - x;
        if (eff < 2n) return 0n;
        const ia = eff - 1n;
        return (rb * ia) / (rq + ia);
      };
    }
    return (x: bigint): bigint => {
      if (x === 0n) return 0n;
      const qo = (rq * x) / (rb + x);
      return qo - (qo * lp + 9999n) / BPS - (qo * prot + 9999n) / BPS - (qo * cr + 9999n) / BPS;
    };
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const cfg = psConfig(base);
    const bytes = (addr: Address): Uint8Array => {
      const data = state[addr];
      if (data === undefined) throw new Error(`${SLUG} ladder depth is missing account ${addr}`);
      return data;
    };
    const rb = readUintLE(bytes(cfg.baseVault), VAULT_AMOUNT_OFFSET, 8);
    const rq = readUintLE(bytes(cfg.quoteVault), VAULT_AMOUNT_OFFSET, 8);
    return cfg.direction === 'quoteToBase' ? { reserveIn: rq, reserveOut: rb } : { reserveIn: rb, reserveOut: rq };
  },

  continuousFees(base: PoolConfig, _state: AccountBytesMap, params: readonly bigint[]): { gammaPpm: bigint; muPpm: bigint } {
    const cfg = psConfig(base);
    const [lp, prot, cr] = params;
    if (cfg.direction === 'quoteToBase') {
      // eff ~= x * BPS / (BPS + fees): an input-side multiplicative fee.
      return { gammaPpm: (BPS * 1_000_000n) / (BPS + lp + prot + cr), muPpm: 1_000_000n };
    }
    // sell: fees come off the output.
    return { gammaPpm: 1_000_000n, muPpm: ((BPS - lp - prot - cr) * 1_000_000n) / BPS };
  },
} satisfies SvmVenueLadderV2;
