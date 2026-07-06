/**
 * Raydium CP-Swap adapter v2 (EcoSwapSVM ladder fragment) — the
 * amount-parametric sibling of ./index.ts's emitQuote: reserves (vault
 * balances minus the PoolState protocol/fund/creator fee accumulators) and
 * the admin-mutable AmmConfig fee rates are read LIVE in-VM, and the gross
 * input arrives at runtime, so nothing about the trade is folded into the
 * bytecode. The only per-pool compile-time residue is the swap DIRECTION
 * (input side's accumulator offsets) — part of the shape key.
 *
 * The creator-fee side is a per-trade param (crMode: 0 none, 1 on input,
 * 2 on output) because creator_fee_on/enable_creator_fee are pool-creation
 * constants that vary per pool within one shape. The unified helper applies
 * `trin` (trade rate + creator rate when on input) on the input and `crout`
 * (creator rate when on output) on the output; a zero rate is a no-op, so the
 * one formula serves all three modes.
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
import type { RaydiumCpSwapPoolConfig } from './index.js';

const SLUG = 'raydium-cp-swap';
const PROGRAM_ID = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
/** PDA ["vault_and_lp_mint_auth_seed"] — vault and lp-mint authority. */
const AUTHORITY = 'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL';

// sha256("global:swap_base_input")[0..8].
const SWAP_BASE_INPUT_DISCRIMINATOR = [143, 190, 90, 218, 196, 30, 51, 222];

const FEE_RATE_DENOMINATOR = 1_000_000n;

// PoolState / AmmConfig offsets (see ./index.ts POOL_OFFSETS / CONFIG_OFFSETS).
const PROTOCOL_FEES = [341, 349] as const; // token0, token1
const FUND_FEES = [357, 365] as const;
const CREATOR_FEES = [397, 405] as const;
const TRADE_FEE_RATE = 12;
const CREATOR_FEE_RATE = 108;
const VAULT_AMOUNT_OFFSET = 64;

function cpConfig(cfg: PoolConfig): RaydiumCpSwapPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as RaydiumCpSwapPoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

/** creator_fee_on semantics: 0 = both tokens (always on input), 1 = only token_0, 2 = only token_1. */
function creatorFeeOnInput(cfg: RaydiumCpSwapPoolConfig): boolean {
  return (
    cfg.creatorFeeOn === 0 ||
    (cfg.creatorFeeOn === 1 && cfg.inputIsToken0) ||
    (cfg.creatorFeeOn === 2 && !cfg.inputIsToken0)
  );
}

export const raydiumCpSwapLadder = {
  slug: SLUG,

  shapeKey(base: PoolConfig): string {
    const cfg = cpConfig(base);
    return `${SLUG}:${cfg.inputIsToken0 ? '0to1' : '1to0'}`;
  },

  helperName(): string {
    return 'qRayCp';
  },

  // Unified over the three creator-fee modes: trin carries the input-side
  // rate sum, crout the output-side creator rate; zero rates are no-ops.
  // Rounding mirrors the program: ceil on every fee, floor on the curve.
  helperSource(): string {
    return [
      'function qRayCp(x, rin, rout, trin, crout) {',
      '  if (x === 0) { return 0 }',
      `  const fee = (x * trin + ${FEE_RATE_DENOMINATOR - 1n}) / ${FEE_RATE_DENOMINATOR};`,
      '  const net = x - fee;',
      '  const os = Math.mulDiv(net, rout, rin + net);',
      `  return os - (os * crout + ${FEE_RATE_DENOMINATOR - 1n}) / ${FEE_RATE_DENOMINATOR};`,
      '}',
    ].join('\n');
  },

  /** One param: crMode (0 = none, 1 = creator fee on input, 2 = on output). */
  paramCount: 1,

  paramsFor(base: PoolConfig): bigint[] {
    const cfg = cpConfig(base);
    if (!cfg.enableCreatorFee) return [0n];
    return [creatorFeeOnInput(cfg) ? 1n : 2n];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const cfg = cpConfig(base);
    const [vin, vout] = cfg.inputIsToken0 ? [cfg.token0Vault, cfg.token1Vault] : [cfg.token1Vault, cfg.token0Vault];
    return [
      { ref: ref(slot, 'pool'), address: cfg.pool },
      { ref: ref(slot, 'cfg'), address: cfg.ammConfig },
      { ref: ref(slot, 'vin'), address: vin },
      { ref: ref(slot, 'vout'), address: vout },
    ];
  },

  emitSetup(base: PoolConfig, slot: number, params: readonly string[]): string {
    const cfg = cpConfig(base);
    const inSide = cfg.inputIsToken0 ? 0 : 1;
    const outSide = 1 - inSide;
    const pool = JSON.stringify(ref(slot, 'pool'));
    const config = JSON.stringify(ref(slot, 'cfg'));
    const reserve = (side: 0 | 1, vaultRef: string) =>
      `accountUint(${JSON.stringify(ref(slot, vaultRef))}, ${VAULT_AMOUNT_OFFSET}, 8)` +
      ` - accountUint(${pool}, ${PROTOCOL_FEES[side]}, 8)` +
      ` - accountUint(${pool}, ${FUND_FEES[side]}, 8)` +
      ` - accountUint(${pool}, ${CREATOR_FEES[side]}, 8)`;
    return [
      `  const s${slot}rin = ${reserve(inSide as 0 | 1, 'vin')};`,
      `  const s${slot}rout = ${reserve(outSide as 0 | 1, 'vout')};`,
      `  const s${slot}tr = accountUint(${config}, ${TRADE_FEE_RATE}, 8);`,
      `  const s${slot}cr = accountUint(${config}, ${CREATOR_FEE_RATE}, 8);`,
      `  let s${slot}trin = s${slot}tr;`,
      `  let s${slot}crout = 0;`,
      `  if (${params[0]} === 1) { s${slot}trin = s${slot}tr + s${slot}cr }`,
      `  if (${params[0]} === 2) { s${slot}crout = s${slot}cr }`,
    ].join('\n');
  },

  emitQuoteCall(_base: PoolConfig, slot: number, x: string): string {
    return `qRayCp(${x}, s${slot}rin, s${slot}rout, s${slot}trin, s${slot}crout)`;
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const cfg = cpConfig(base);
    const [inMint, outMint] = cfg.inputIsToken0 ? [cfg.token0Mint, cfg.token1Mint] : [cfg.token1Mint, cfg.token0Mint];
    const [inProg, outProg] = cfg.inputIsToken0
      ? [cfg.token0Program, cfg.token1Program]
      : [cfg.token1Program, cfg.token0Program];

    // swap_base_input: disc(8) ++ amount_in u64 LE (runtime-patched) ++
    // minimum_amount_out u64 LE = 1 (the recipe's terminal delta check
    // enforces the real bound).
    const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
    return {
      programId: address(PROGRAM_ID),
      prefix: Uint8Array.from(SWAP_BASE_INPUT_DISCRIMINATOR),
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
      patch: 'in',
      accounts: [
        { ref: user.owner, signer: true },
        roled('auth', address(AUTHORITY)),
        roled('cfg', cfg.ammConfig),
        roled('pool', cfg.pool, true),
        { ref: user.inAta, writable: true },
        { ref: user.outAta, writable: true },
        roled('vin', cfg.inputIsToken0 ? cfg.token0Vault : cfg.token1Vault, true),
        roled('vout', cfg.inputIsToken0 ? cfg.token1Vault : cfg.token0Vault, true),
        roled('tpin', inProg),
        roled('tpout', outProg),
        roled('min', inMint),
        roled('mout', outMint),
        roled('obs', cfg.observation, true),
      ],
    };
  },

  referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint {
    const cfg = cpConfig(base);
    const bytes = (addr: Address): Uint8Array => {
      const data = state[addr];
      if (data === undefined) throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
      return data;
    };
    const pool = bytes(cfg.pool);
    const config = bytes(cfg.ammConfig);
    const inSide = cfg.inputIsToken0 ? 0 : 1;
    const outSide = 1 - inSide;
    const reserve = (side: number, vault: Address): bigint =>
      readUintLE(bytes(vault), VAULT_AMOUNT_OFFSET, 8) -
      readUintLE(pool, PROTOCOL_FEES[side], 8) -
      readUintLE(pool, FUND_FEES[side], 8) -
      readUintLE(pool, CREATOR_FEES[side], 8);
    const rin = reserve(inSide, cfg.inputIsToken0 ? cfg.token0Vault : cfg.token1Vault);
    const rout = reserve(outSide, cfg.inputIsToken0 ? cfg.token1Vault : cfg.token0Vault);
    const tr = readUintLE(config, TRADE_FEE_RATE, 8);
    const cr = readUintLE(config, CREATOR_FEE_RATE, 8);
    const crMode = params[0];
    const trin = crMode === 1n ? tr + cr : tr;
    const crout = crMode === 2n ? cr : 0n;

    return (x: bigint): bigint => {
      if (x === 0n) return 0n;
      const fee = (x * trin + FEE_RATE_DENOMINATOR - 1n) / FEE_RATE_DENOMINATOR;
      const net = x - fee;
      const os = (net * rout) / (rin + net);
      return os - (os * crout + FEE_RATE_DENOMINATOR - 1n) / FEE_RATE_DENOMINATOR;
    };
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const cfg = cpConfig(base);
    const bytes = (addr: Address): Uint8Array => {
      const data = state[addr];
      if (data === undefined) throw new Error(`${SLUG} ladder depth is missing account ${addr}`);
      return data;
    };
    const pool = bytes(cfg.pool);
    const reserve = (side: number, vault: Address): bigint =>
      readUintLE(bytes(vault), VAULT_AMOUNT_OFFSET, 8) -
      readUintLE(pool, PROTOCOL_FEES[side], 8) -
      readUintLE(pool, FUND_FEES[side], 8) -
      readUintLE(pool, CREATOR_FEES[side], 8);
    const r0 = reserve(0, cfg.token0Vault);
    const r1 = reserve(1, cfg.token1Vault);
    return cfg.inputIsToken0 ? { reserveIn: r0, reserveOut: r1 } : { reserveIn: r1, reserveOut: r0 };
  },

  continuousFees(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): { gammaPpm: bigint; muPpm: bigint } {
    const cfg = cpConfig(base);
    const config = state[cfg.ammConfig];
    if (config === undefined) throw new Error(`${SLUG} ladder fees are missing account ${cfg.ammConfig}`);
    const tr = readUintLE(config, TRADE_FEE_RATE, 8);
    const cr = readUintLE(config, CREATOR_FEE_RATE, 8);
    const crMode = params[0];
    return {
      gammaPpm: FEE_RATE_DENOMINATOR - (crMode === 1n ? tr + cr : tr),
      muPpm: FEE_RATE_DENOMINATOR - (crMode === 2n ? cr : 0n),
    };
  },
} satisfies SvmVenueLadderV2;
