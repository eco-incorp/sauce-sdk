/**
 * Orca legacy token-swap adapter v2 (EcoSwapSVM ladder fragment) — raw SPL
 * vault balances as constant-product reserves (read LIVE in-VM), the
 * SwapV1 fee fractions as per-trade PARAMS (they are immutable pool fields,
 * but shape-genericity means any orca pool must fit the slot without a
 * re-stage), and the fork's floor-min-1 fee rule plus ceiling-divided curve
 * mirrored exactly. Quote direction is token A → token B, like ./index.ts.
 *
 * Where the v1 adapter's referenceQuote THROWS on venue-rejected inputs
 * (zero quotient / zero output), the ladder helper returns 0 — a dust rung
 * never wins the merge, and the recipe skips the CPI for a slot whose
 * predicted output is 0.
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
import { orcaLegacyTokenSwap } from './index.js';
import type { OrcaLegacyPoolConfig } from './index.js';

const SLUG = 'orca-legacy-token-swap';
const VAULT_AMOUNT_OFFSET = 64;

function orcaConfig(cfg: PoolConfig): OrcaLegacyPoolConfig {
  if (cfg.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
  return cfg as OrcaLegacyPoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

export const orcaLegacyTokenSwapLadder = {
  slug: SLUG,

  shapeKey(): string {
    return `${SLUG}:AtoB`;
  },

  // fees.rs calculate_fee (floor, min 1 when rate and amount are nonzero) on
  // both fee legs, then the ceiling-divided constant-product curve rounding
  // against the trader. Venue-rejected inputs (fees swallow x, zero
  // quotient, zero output) return 0 instead of throwing.
  helpers(): { name: string; source: string }[] {
    return [
      {
        name: 'qOrca',
        source: [
          'function qOrca(x, rin, rout, tn, td, on, od) {',
          '  if (x === 0) { return 0 }',
          '  let tf = 0;',
          '  if (tn > 0) { tf = x * tn / td; if (tf === 0) { tf = 1 } }',
          '  let of = 0;',
          '  if (on > 0) { of = x * on / od; if (of === 0) { of = 1 } }',
          '  if (tf + of >= x) { return 0 }',
          '  const net = x - tf - of;',
          '  const ni = rin + net;',
          '  if (rin * rout / ni === 0) { return 0 }',
          '  const no = (rin * rout + ni - 1) / ni;',
          '  if (no >= rout) { return 0 }',
          '  return rout - no;',
          '}',
        ].join('\n'),
      },
    ];
  },

  /** Four params: trade fee numerator/denominator, owner fee numerator/denominator. */
  paramCount: 4,

  paramsFor(base: PoolConfig): bigint[] {
    const cfg = orcaConfig(base);
    // A zero numerator never divides by its denominator in the helper (the
    // `tn > 0` guard), so a 0 denominator is safe to pass through — but the
    // fetch gate already rejected nonzero-numerator/zero-denominator pools.
    return [cfg.tradeFeeNumerator, cfg.tradeFeeDenominator, cfg.ownerTradeFeeNumerator, cfg.ownerTradeFeeDenominator];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const cfg = orcaConfig(base);
    return [
      { ref: ref(slot, 'vin'), address: cfg.vaultIn },
      { ref: ref(slot, 'vout'), address: cfg.vaultOut },
    ];
  },

  emitSetup(_base: PoolConfig, slot: number, params: readonly string[]): string {
    return [
      `  const s${slot}rin = accountUint(${JSON.stringify(ref(slot, 'vin'))}, ${VAULT_AMOUNT_OFFSET}, 8);`,
      `  const s${slot}rout = accountUint(${JSON.stringify(ref(slot, 'vout'))}, ${VAULT_AMOUNT_OFFSET}, 8);`,
      `  const s${slot}tn = ${params[0]};`,
      `  const s${slot}td = ${params[1]};`,
      `  const s${slot}on = ${params[2]};`,
      `  const s${slot}od = ${params[3]};`,
    ].join('\n');
  },

  emitQuoteCall(_base: PoolConfig, slot: number, x: string): string {
    return `qOrca(${x}, s${slot}rin, s${slot}rout, s${slot}tn, s${slot}td, s${slot}on, s${slot}od)`;
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const cfg = orcaConfig(base);
    // SwapInstruction::Swap: [tag=1] ++ amount_in u64 LE (patched) ++
    // minimum_amount_out u64 LE = 1.
    const roled = (role: string, addr: Address, writable?: boolean): VenueAccount =>
      writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
    return {
      programId: orcaLegacyTokenSwap.programId,
      prefix: Uint8Array.from([1]),
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
      patch: 'in',
      accounts: [
        roled('pool', cfg.pool),
        roled('auth', cfg.swapAuthority),
        { ref: user.owner, signer: true },
        { ref: user.inAta, writable: true },
        roled('vin', cfg.vaultIn, true),
        roled('vout', cfg.vaultOut, true),
        { ref: user.outAta, writable: true },
        roled('pmint', cfg.poolMint, true),
        roled('pfee', cfg.poolFeeAccount, true),
        roled('tp', cfg.tokenProgram),
      ],
    };
  },

  referenceQuote(base: PoolConfig, state: AccountBytesMap, params: readonly bigint[]): (x: bigint) => bigint {
    const cfg = orcaConfig(base);
    const bytes = (addr: Address): Uint8Array => {
      const data = state[addr];
      if (data === undefined) throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
      return data;
    };
    const rin = readUintLE(bytes(cfg.vaultIn), VAULT_AMOUNT_OFFSET, 8);
    const rout = readUintLE(bytes(cfg.vaultOut), VAULT_AMOUNT_OFFSET, 8);
    const [tn, td, on, od] = params;

    return (x: bigint): bigint => {
      if (x === 0n) return 0n;
      let tf = 0n;
      if (tn > 0n) {
        tf = (x * tn) / td;
        if (tf === 0n) tf = 1n;
      }
      let of = 0n;
      if (on > 0n) {
        of = (x * on) / od;
        if (of === 0n) of = 1n;
      }
      if (tf + of >= x) return 0n;
      const net = x - tf - of;
      const ni = rin + net;
      if ((rin * rout) / ni === 0n) return 0n;
      const no = (rin * rout + ni - 1n) / ni;
      if (no >= rout) return 0n;
      return rout - no;
    };
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const cfg = orcaConfig(base);
    const bytes = (addr: Address): Uint8Array => {
      const data = state[addr];
      if (data === undefined) throw new Error(`${SLUG} ladder depth is missing account ${addr}`);
      return data;
    };
    return {
      reserveIn: readUintLE(bytes(cfg.vaultIn), VAULT_AMOUNT_OFFSET, 8),
      reserveOut: readUintLE(bytes(cfg.vaultOut), VAULT_AMOUNT_OFFSET, 8),
    };
  },

  continuousFees(base: PoolConfig, _state: AccountBytesMap, params: readonly bigint[]): { gammaPpm: bigint; muPpm: bigint } {
    const [tn, td, on, od] = params;
    let gamma = 1_000_000n;
    if (tn > 0n) gamma -= (tn * 1_000_000n) / td;
    if (on > 0n) gamma -= (on * 1_000_000n) / od;
    return { gammaPpm: gamma, muPpm: 1_000_000n };
  },
} satisfies SvmVenueLadderV2;
