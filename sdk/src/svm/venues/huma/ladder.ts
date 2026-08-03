/**
 * Huma adapter v2 (SvmRoute ladder fragment) — the amount-parametric
 * sibling of ./index.ts's emitQuote. Everything mutable (ModeState.assets,
 * the mode mint's supply, the pool's idle underlying balance) is read LIVE
 * in-VM; the fee-tier schedule and the two caps (liquidity_cap,
 * instant_withdrawal_reserve_limit) are compile-time constants baked from
 * PoolConfig at fetchPoolConfig time (governance-set, not per-trade state —
 * see index.ts's module doc for the full quote-math + fee-model writeup).
 *
 * No shared cross-pool `helpers()` name: the fee-tier ladder is a different
 * SHAPE per pool (tier count varies), so it is emitted INLINE per slot in
 * emitSetup/emitQuoteCall rather than a named helper — sidesteps the
 * cross-family/cross-pool helper-dedup-by-name constraint entirely (a second
 * Huma pool with a different tier count could otherwise collide on a shared
 * helper name with a different body).
 */
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import type {
  AccountBytesMap,
  LadderSwapTemplate,
  PoolConfig,
  SvmVenueLadder,
  SwapUser,
  VenueAccount,
} from '../types.js';
import {
  HUMA_PROGRAM_ID,
  humaDepositAccounts,
  humaEncodeDepositData,
  humaEncodeInstantWithdrawData,
  humaFeeAssignLines,
  humaFeeBpsFor,
  humaInstantWithdrawAccounts,
} from './index.js';
import type { HumaPoolConfig } from './index.js';

const SLUG = 'huma';

function humaConfig(base: PoolConfig): HumaPoolConfig {
  if (base.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${base.venue}' pool config`);
  return base as HumaPoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

/**
 * Assigns (bare, no let/const) the quote at gross input `x` into `target` —
 * `target` must already be a `let` in scope, initialized to 0. Shared by
 * emitLadderQuote (assigns into a fresh per-rung temp) and emitFinalQuote
 * (assigns directly into its own `let <outVar>`). No ternaries; see
 * index.ts's emitQuote doc for why.
 */
function quoteAssignLines(cfg: HumaPoolConfig, slot: number, x: string, target: string): string[] {
  const p = `s${slot}`;
  if (cfg.direction === 'deposit') {
    return [
      `  ${p}effIn = (${x});`,
      `  if (${p}effIn > ${p}room) { ${p}effIn = ${p}room }`,
      `  if (${p}effIn >= ${cfg.minDepositAmount}) {`,
      `    ${target} = ${p}effIn;`,
      `    if (${p}supply !== 0) {`,
      `      if (${p}assets !== 0) {`,
      `        ${target} = ${p}effIn * ${p}supply / ${p}assets;`,
      `      }`,
      `    }`,
      `  }`,
    ];
  }
  return [
    `  if (${p}supply !== 0) {`,
    `    ${p}gross = (${x}) * ${p}assets / ${p}supply;`,
    `    ${target} = ${p}gross - ${p}gross * ${p}fee / 10000;`,
    `    if (${target} > ${cfg.reserveLimit}) { ${target} = ${cfg.reserveLimit} }`,
    `  }`,
  ];
}

export const humaLadder = {
  slug: SLUG,
  defaultRungs: 4,

  shapeKey(base: PoolConfig): string {
    const cfg = humaConfig(base);
    return `${SLUG}:${cfg.direction}:${cfg.feeTiers.length}`;
  },

  helpers(): { name: string; source: string }[] {
    return [];
  },

  paramCount: 0,

  paramsFor(_base: PoolConfig): bigint[] {
    return [];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const cfg = humaConfig(base);
    return [
      { ref: ref(slot, 'pool-state'), address: cfg.poolState },
      { ref: ref(slot, 'mode-mint'), address: cfg.modeMint },
      { ref: ref(slot, 'pool-underlying'), address: cfg.poolUnderlyingToken },
    ];
  },

  // STATEMENT-form ladder (emitLadderQuote + emitFinalQuote, no emitQuoteCall):
  // the fee-tier lookup is a sequence of top-level `if` reassignments (the
  // compiler rejects a nested/chained ternary — see index.ts's emitQuote
  // doc), which does not fit a single expitQuoteCall expression. All mutable
  // per-slot locals are declared ONCE here (goonfi-v2/ladder.ts's idiom) and
  // only ever REASSIGNED (bare `name = value;`, never redeclared) by
  // emitLadderQuote/emitFinalQuote below.
  emitSetup(base: PoolConfig, slot: number): string {
    const cfg = humaConfig(base);
    const poolState = JSON.stringify(ref(slot, 'pool-state'));
    const modeMint = JSON.stringify(ref(slot, 'mode-mint'));
    const poolUnderlying = JSON.stringify(ref(slot, 'pool-underlying'));

    const lines = [
      `  const s${slot}assets = accountUint(${poolState}, ${cfg.modeAssetsOffset}, 16);`,
      `  const s${slot}supply = accountUint(${modeMint}, 36, 8);`,
    ];

    if (cfg.direction === 'deposit') {
      lines.push(`  let s${slot}room = 0;`);
      lines.push(`  if (${cfg.liquidityCap} > s${slot}assets) { s${slot}room = ${cfg.liquidityCap} - s${slot}assets }`);
      lines.push(`  let s${slot}effIn = 0;`);
    } else {
      lines.push(`  const s${slot}liquid = accountUint(${poolUnderlying}, 64, 8);`);
      lines.push(`  const s${slot}deployed = accountUint(${poolState}, ${cfg.liquidAssetsDeployedOffset}, 8);`);
      lines.push(`  const s${slot}disbursed = accountUint(${poolState}, ${cfg.disbursementReserveOffset}, 16);`);
      lines.push(`  const s${slot}availRaw = s${slot}liquid + s${slot}deployed;`);
      lines.push(`  let s${slot}avail = 0;`);
      lines.push(`  if (s${slot}availRaw > s${slot}disbursed) { s${slot}avail = s${slot}availRaw - s${slot}disbursed }`);
      lines.push(`  let s${slot}ratio = 10000;`);
      lines.push(`  if (s${slot}assets !== 0) { s${slot}ratio = s${slot}avail * 10000 / s${slot}assets }`);
      lines.push(...humaFeeAssignLines(cfg, `s${slot}ratio`, `s${slot}fee`).map((l) => '  ' + l));
      lines.push(`  let s${slot}gross = 0;`);
    }
    return lines.join('\n');
  },

  /** Ladder rung at cumulative grid point `x`: assigns into a fresh per-rung `const <outVar>`. */
  emitLadderQuote(base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string {
    const cfg = humaConfig(base);
    const tmp = `s${slot}tmp${rung}`;
    return [`  let ${tmp} = 0;`, ...quoteAssignLines(cfg, slot, x, tmp), `  const ${outVar} = ${tmp};`].join('\n');
  },

  /** The COLD final quote at the elected slice — identical formula, `let <outVar>` per the interface. */
  emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string {
    const cfg = humaConfig(base);
    return [`  let ${outVar} = 0;`, ...quoteAssignLines(cfg, slot, x, outVar)].join('\n');
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const cfg = humaConfig(base);
    const roleFor = (accountRef: string): string => {
      // Rewrite the v1 adapter's `${poolRef}:role` refs onto this slot's `s<slot>:role` namespace
      // so a shape shared by several pools still gets per-slot-unique refs.
      const parts = accountRef.split(':');
      return ref(slot, parts[parts.length - 1]);
    };

    if (cfg.direction === 'deposit') {
      const accounts = humaDepositAccounts(cfg, user).map((a): VenueAccount => {
        if (a.ref === user.owner || a.ref === user.inAta || a.ref === user.outAta) return a;
        return { ...a, ref: roleFor(a.ref) };
      });
      const data = humaEncodeDepositData(0n); // amount patched at runtime; the encoded 0 just sizes the buffer
      return {
        programId: HUMA_PROGRAM_ID,
        prefix: data.subarray(0, 8),
        suffix: data.subarray(16),
        patch: 'in',
        accounts,
      };
    }

    const accounts = humaInstantWithdrawAccounts(cfg, user).map((a): VenueAccount => {
      if (a.ref === user.owner || a.ref === user.inAta || a.ref === user.outAta) return a;
      return { ...a, ref: roleFor(a.ref) };
    });
    const data = humaEncodeInstantWithdrawData(0n);
    return {
      programId: HUMA_PROGRAM_ID,
      prefix: data.subarray(0, 8),
      suffix: data.subarray(16),
      patch: 'in',
      accounts,
    };
  },

  referenceQuote(base: PoolConfig, state: AccountBytesMap): (x: bigint) => bigint {
    const cfg = humaConfig(base);
    const bytes = (addr: Address): Uint8Array => {
      const data = state[addr];
      if (data === undefined) throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
      return data;
    };
    const poolState = bytes(cfg.poolState);
    const modeMintData = bytes(cfg.modeMint);
    const assets = readUintLE(poolState, cfg.modeAssetsOffset, 16);
    const supply = readUintLE(modeMintData, 36, 8);

    if (cfg.direction === 'deposit') {
      const room = cfg.liquidityCap > assets ? cfg.liquidityCap - assets : 0n;
      return (x: bigint): bigint => {
        const effIn = x < room ? x : room;
        if (effIn < cfg.minDepositAmount) return 0n;
        return supply === 0n || assets === 0n ? effIn : (effIn * supply) / assets;
      };
    }

    const poolUnderlyingData = bytes(cfg.poolUnderlyingToken);
    const liquid = readUintLE(poolUnderlyingData, 64, 8);
    const deployed = readUintLE(poolState, cfg.liquidAssetsDeployedOffset, 8);
    const disbursed = readUintLE(poolState, cfg.disbursementReserveOffset, 16);
    const availRaw = liquid + deployed;
    const avail = availRaw > disbursed ? availRaw - disbursed : 0n;
    const ratioBps = assets === 0n ? 10000n : (avail * 10000n) / assets;
    const feeBps = humaFeeBpsFor(ratioBps, cfg.feeTiers);

    return (x: bigint): bigint => {
      if (supply === 0n) return 0n;
      const gross = (x * assets) / supply;
      const net = gross - (gross * feeBps) / 10000n;
      return net < cfg.reserveLimit ? net : cfg.reserveLimit;
    };
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const cfg = humaConfig(base);
    const bytes = (addr: Address): Uint8Array => {
      const data = state[addr];
      if (data === undefined) throw new Error(`${SLUG} ladder depth is missing account ${addr}`);
      return data;
    };
    const assets = readUintLE(bytes(cfg.poolState), cfg.modeAssetsOffset, 16);
    const supply = readUintLE(bytes(cfg.modeMint), 36, 8);
    return cfg.direction === 'deposit' ? { reserveIn: assets, reserveOut: supply } : { reserveIn: supply, reserveOut: assets };
  },

  continuousFees(base: PoolConfig, state: AccountBytesMap): { gammaPpm: bigint; muPpm: bigint } {
    const cfg = humaConfig(base);
    if (cfg.direction === 'deposit') return { gammaPpm: 1_000_000n, muPpm: 1_000_000n };
    const bytes = (addr: Address): Uint8Array => {
      const data = state[addr];
      if (data === undefined) throw new Error(`${SLUG} ladder fees are missing account ${addr}`);
      return data;
    };
    const assets = readUintLE(bytes(cfg.poolState), cfg.modeAssetsOffset, 16);
    const poolUnderlyingData = bytes(cfg.poolUnderlyingToken);
    const liquid = readUintLE(poolUnderlyingData, 64, 8);
    const deployed = readUintLE(bytes(cfg.poolState), cfg.liquidAssetsDeployedOffset, 8);
    const disbursed = readUintLE(bytes(cfg.poolState), cfg.disbursementReserveOffset, 16);
    const availRaw = liquid + deployed;
    const avail = availRaw > disbursed ? availRaw - disbursed : 0n;
    const ratioBps = assets === 0n ? 10000n : (avail * 10000n) / assets;
    const feeBps = humaFeeBpsFor(ratioBps, cfg.feeTiers);
    return { gammaPpm: 1_000_000n - feeBps * 100n, muPpm: 1_000_000n };
  },
} satisfies SvmVenueLadder;
