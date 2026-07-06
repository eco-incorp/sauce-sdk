/**
 * EcoSwapSVM codegen — assembles the shape-generic staged solver from the
 * adapter-v2 ladder fragments and compiles it `{ target: 'svm', staged:
 * true }`.
 *
 * ONE compiled blob per SHAPE (the ordered list of family slots — venue,
 * direction, RUNG COUNT, optional-account layout) serves any matching pool
 * set:
 * - pool ACCOUNTS ride the transaction account list at fixed per-slot
 *   positions (slot-role refs `s<i>:*`, rebound per trade through the
 *   resolution map);
 * - per-trade VALUES ride the payload args as ONE packed bytes arg
 *   (`cfg`: u64 LE words — amountIn, minOut, then per slot the enable flag
 *   and the adapter's params), so main() takes a single parameter and the
 *   arg prologue stays flat;
 * - the whole split is computed BEFORE the first CPI (platform law: a
 *   launched CPI failure aborts the transaction — nothing to catch), then
 *   each engaged slot's venue swap executes with its instruction-data u64
 *   patched at RUNTIME from the merge result (prefix ++ le8(amount) ++
 *   suffix, venue min_out = 1), and ONE terminal realized-delta check on the
 *   user's outAta enforces minOut across all slots at once.
 *
 * DETERMINISM RULE (the SVM place where the EVM analog does not transfer):
 * per-slot ladder DEPTH is fixed at CODEGEN time by the CU budgeter
 * (budget.ts) — a pure function of the shape — never adapted from GasLeft at
 * runtime. The solver-reference mirror cannot read GasLeft, so any
 * CU-dependent branching would break the lamport-exact gate. GasLeft (0x62)
 * appears exactly once, as a HARD SAFETY THROW (`"cu"`) before any work when
 * the transaction's compute budget cannot cover the shape's modeled cost —
 * an all-or-nothing abort that can never change a landed split.
 *
 * The generated merge is transcribed 1:1 by solver-reference.ts — change
 * them together or the lamport-exact gate breaks.
 */
import { getAddressCodec } from '@solana/kit';
import type { Address } from '@solana/kit';
import { compile } from '@eco-incorp/sauce-compiler';
import type { AccountPlan, ArgsLayout } from '@eco-incorp/sauce-compiler';
import type {
  LadderSwapTemplate,
  PoolConfig,
  SvmVenueLadderV2,
  SwapUser,
  VenueAccount,
} from '../../../svm/venues/types.js';
import { MAX_RUNGS, MIN_RUNGS, QL_S } from './solver-reference.js';

export interface EcoSwapSvmSlot {
  adapter: SvmVenueLadderV2;
  cfg: PoolConfig;
  /**
   * Ladder rungs for this slot (default: the adapter's defaultRungs, else
   * QL_S). Fixed into the SHAPE — the budgeter picks it, the mirror
   * replicates it from the prepared slots, never from runtime CU.
   */
  rungs?: number;
  /**
   * Test/integration hook: replaces the venue swap CPI while the quote stays
   * live (e.g. an SPL-transfer stand-in paying the predicted output when no
   * venue binary is deployed). Changes the shape key.
   */
  swapOverride?: LadderSwapTemplate;
}

export interface GenerateEcoSwapSvmInput {
  slots: EcoSwapSvmSlot[];
  user: SwapUser;
  /**
   * The GasLeft safety floor (CU): when set, the program throws `"cu"`
   * before any work if the remaining compute budget is below it. A pure
   * function of the shape (the budgeter's modeled cost) — see the
   * determinism rule above.
   */
  cuFloor?: number;
}

export interface GeneratedEcoSwapSvm {
  source: string;
  /** The staged blob — stage once (hash-pinned), execute per trade with fresh args. */
  bytecode: Uint8Array;
  argsLayout: ArgsLayout;
  /** Ordered plan; adapter-resolved refs carry their pubkey, user refs stay open. */
  accountPlan: AccountPlan;
  /** Shape discriminant: pool sets sharing it reuse the identical blob. */
  shapeKey: string;
  /** Resolved per-slot ladder rungs (slot order) — feed solver-reference. */
  rungs: number[];
  /** Byte length of the packed cfg arg (encodeEcoSwapSvmTrade must match). */
  cfgByteLength: number;
  warnings: string[];
}

const U64_MAX = (1n << 64n) - 1n;

export const hexLiteral = (bytes: Uint8Array): string =>
  '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const progRef = (slot: number): string => `s${slot}:prog`;

/** 64-bit byte swap: the LE image of a u64 amount, MSTORE'd big-endian by abi.encode. */
export const LE8_HELPER = [
  'function le8(x) {',
  '  return ((x & 255) << 56) | ((x & 65280) << 40) | ((x & 16711680) << 24) | ((x & 4278190080) << 8)' +
    ' | ((x >> 8) & 4278190080) | ((x >> 24) & 16711680) | ((x >> 40) & 65280) | (x >> 56);',
  '}',
].join('\n');

export function accountEntry(account: VenueAccount): string {
  const flags = [
    ...(account.writable ? ['writable: true'] : []),
    ...(account.signer ? ['signer: true'] : []),
  ];
  if (flags.length === 0) return JSON.stringify(account.ref);
  return `{ ref: ${JSON.stringify(account.ref)}, ${flags.join(', ')} }`;
}

/** Records ref → address; a ref claiming two different addresses is a config error. */
export function bindAddress(addressByRef: Map<string, string>, ref: string, address: Address | undefined): void {
  if (address === undefined) return;
  const bound = addressByRef.get(ref);
  if (bound !== undefined && bound !== address) {
    throw new Error(`ecoSwapSvm account ref '${ref}' is bound to two different addresses (${bound}, ${address})`);
  }
  addressByRef.set(ref, address);
}

/** Resolves a slot's ladder depth: explicit > adapter default > QL_S; bounds-checked. */
export function resolveSlotRungs(slot: Pick<EcoSwapSvmSlot, 'adapter' | 'rungs'>): number {
  const rungs = slot.rungs ?? slot.adapter.defaultRungs ?? QL_S;
  if (!Number.isInteger(rungs) || rungs < MIN_RUNGS || rungs > MAX_RUNGS) {
    throw new Error(`ecoSwapSvm slot rungs must be an integer in ${MIN_RUNGS}..${MAX_RUNGS}, got ${rungs}`);
  }
  return rungs;
}

/**
 * Encodes the per-trade cfg bytes for a shape: u64 LE words
 * [amountIn][minOut] then per slot [enable][...params]. Slot order and
 * param counts must match the generate() call that produced the blob —
 * cfgByteLength pins the total.
 */
export function encodeEcoSwapSvmTrade(
  slots: readonly { params: readonly bigint[]; enabled?: boolean }[],
  amountIn: bigint,
  minOut: bigint,
): `0x${string}` {
  const words: bigint[] = [amountIn, minOut];
  for (const slot of slots) {
    words.push(slot.enabled === false ? 0n : 1n);
    words.push(...slot.params);
  }
  const bytes = new Uint8Array(words.length * 8);
  const view = new DataView(bytes.buffer);
  words.forEach((word, i) => {
    if (word < 0n || word > U64_MAX) throw new Error(`ecoSwapSvm trade word ${i} out of u64 range: ${word}`);
    view.setBigUint64(i * 8, word, true);
  });
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

/** Collects and dedupes the slots' helper functions; one name = one source. */
export function collectHelpers(slots: readonly EcoSwapSvmSlot[]): string[] {
  const byName = new Map<string, string>();
  for (const { adapter, cfg } of slots) {
    for (const helper of adapter.helpers(cfg)) {
      const known = byName.get(helper.name);
      if (known !== undefined && known !== helper.source) {
        throw new Error(`ecoSwapSvm helper '${helper.name}' is declared with two different sources`);
      }
      byName.set(helper.name, helper.source);
    }
  }
  return [...byName.values()];
}

export function quoteMode(adapter: SvmVenueLadderV2): 'expression' | 'statements' {
  if (adapter.emitQuoteCall !== undefined) return 'expression';
  if (adapter.emitLadderQuote !== undefined && adapter.emitFinalQuote !== undefined) return 'statements';
  throw new Error(
    `ecoSwapSvm adapter '${adapter.slug}' must implement emitQuoteCall or (emitLadderQuote + emitFinalQuote)`,
  );
}

function generateSource(input: GenerateEcoSwapSvmInput): { source: string; cfgByteLength: number; rungs: number[] } {
  const { slots, user, cuFloor } = input;
  const k = slots.length;
  const codec = getAddressCodec();

  const rungs = slots.map(resolveSlotRungs);
  const rungBase: number[] = [];
  let totalRungs = 0;
  for (const r of rungs) {
    rungBase.push(totalRungs);
    totalRungs += r;
  }

  const lines: string[] = [LE8_HELPER, ...collectHelpers(slots)];
  lines.push('function main(cfg) {');

  // ── the GasLeft hard safety throw (never a split input — see header) ──
  if (cuFloor !== undefined) {
    if (!Number.isInteger(cuFloor) || cuFloor <= 0) {
      throw new Error(`ecoSwapSvm cuFloor must be a positive integer, got ${cuFloor}`);
    }
    lines.push(`  if (gasLeft() < ${cuFloor}) { throw "cu" }`);
  }

  // ── cfg words: [amountIn][minOut] then per slot [enable][...params] ──
  let word = 0;
  const slice = (): string => {
    const at = word * 8;
    word += 1;
    return `uint(cfg.slice(${at}, ${at + 8}))`;
  };
  lines.push(`  const amountIn = ${slice()};`);
  lines.push(`  const minOut = ${slice()};`);
  const enables: string[] = [];
  const slotParams: string[][] = [];
  slots.forEach(({ adapter }, i) => {
    // `s<i>en` — the enable flag; the name is part of the adapter contract's
    // reserved-local surface (adapters must not declare it; orca's owner-fee
    // numerator local made `s<i>on` unavailable).
    lines.push(`  const s${i}en = ${slice()};`);
    enables.push(`s${i}en`);
    const params: string[] = [];
    for (let p = 0; p < adapter.paramCount; p++) {
      lines.push(`  const s${i}p${p} = ${slice()};`);
      params.push(`s${i}p${p}`);
    }
    slotParams.push(params);
  });
  const cfgByteLength = word * 8;

  // ── setup: LIVE reserve/fee reads into slot locals (unconditional — a
  //    disabled slot still needs readable accounts attached; adapters gate
  //    EXPENSIVE setup work, e.g. a stable slot's Newton D, on the enable
  //    var themselves) ──
  slots.forEach(({ adapter, cfg }, i) => lines.push(adapter.emitSetup(cfg, i, slotParams[i], enables[i])));

  // Zero-length reads intern each slot's CPI target program account: the
  // engine resolves a CALL target by scanning the attached user accounts for
  // the program's pubkey, so it must ride along.
  for (let i = 0; i < k; i++) lines.push(`  accountData(${JSON.stringify(progRef(i))}, 0, 0);`);

  // ── ladders: rungs[i] rungs per enabled slot on the geometric grid
  //    G_j = amountIn >> (rungs[i] − j); a disabled slot is born exhausted.
  //    Per-slot rung counts/bases ride the rl/rb runtime arrays so the merge
  //    scan stays a flat loop (mirrored 1:1 by solver-reference). ──
  lines.push(
    `  const din = new Array(${totalRungs});`,
    `  const dout = new Array(${totalRungs});`,
    `  const rl = new Array(${k});`,
    `  const rb = new Array(${k});`,
    `  const ptr = new Array(${k});`,
    `  const fill = new Array(${k});`,
  );
  slots.forEach((_, i) => lines.push(`  rl[${i}] = ${rungs[i]}; rb[${i}] = ${rungBase[i]};`));
  slots.forEach(({ adapter, cfg }, i) => {
    const mode = quoteMode(adapter);
    const r = rungs[i];
    lines.push(`  if (${enables[i]} !== 0) {`);
    for (let j = 1; j <= r; j++) {
      const rung = rungBase[i] + (j - 1);
      const g = j === r ? 'amountIn' : `s${i}g${j}`;
      if (j < r) lines.push(`    const ${g} = amountIn >> ${r - j};`);
      if (mode === 'expression') {
        lines.push(`    const s${i}o${j} = ${adapter.emitQuoteCall!(cfg, i, g)};`);
      } else {
        lines.push(adapter.emitLadderQuote!(cfg, i, j - 1, g, `s${i}o${j}`));
      }
      if (j === 1) {
        lines.push(`    din[${rung}] = ${g}; dout[${rung}] = s${i}o${j};`);
      } else {
        lines.push(`    din[${rung}] = ${g} - s${i}g${j - 1}; dout[${rung}] = s${i}o${j} - s${i}o${j - 1};`);
      }
    }
    lines.push('  }');
    lines.push(`  if (${enables[i]} === 0) { ptr[${i}] = ${r} }`);
  });

  // ── merge: greedy cheapest-rung-first, ONE pointer advance per step;
  //    election by cross-multiplied average price, first-scanned slot keeps
  //    ties. Mirrored 1:1 by solver-reference.ts — change together. ──
  lines.push(
    '  let remaining = amountIn;',
    `  for (let it = 0; it < ${totalRungs} && remaining > 0; it++) {`,
    `    let best = ${k};`,
    `    for (let s = 0; s < ${k}; s++) {`,
    '      if (ptr[s] < rl[s]) {',
    `        if (best === ${k}) { best = s }`,
    '        if (best !== s) {',
    '          const c = rb[s] + ptr[s];',
    '          const b = rb[best] + ptr[best];',
    '          if (dout[c] * din[b] > dout[b] * din[c]) { best = s }',
    '        }',
    '      }',
    '    }',
    `    if (best === ${k}) { throw "fill" }`,
    '    const r = rb[best] + ptr[best];',
    '    let take = din[r];',
    '    if (take > remaining) { take = remaining }',
    '    fill[best] += take;',
    '    remaining -= take;',
    '    if (take === din[r]) { ptr[best] = ptr[best] + 1 }',
    '  }',
    '  if (remaining > 0) { throw "fill" }',
  );

  // ── predicted outputs + the pre-CPI bound (compute BEFORE the first CPI:
  //    once invoke() launches, a callee failure aborts the transaction).
  //    ALWAYS the COLD quote — venue-exact at the elected slice. ──
  slots.forEach(({ adapter, cfg }, i) => {
    if (quoteMode(adapter) === 'expression') {
      lines.push(`  const p${i} = ${adapter.emitQuoteCall!(cfg, i, `fill[${i}]`)};`);
    } else {
      lines.push(adapter.emitFinalQuote!(cfg, i, `fill[${i}]`, `p${i}`));
    }
  });
  lines.push(`  const predicted = ${slots.map((_, i) => `p${i}`).join(' + ')};`);
  lines.push('  if (predicted < minOut) { throw "minOut" }');

  // ── execution: one patched CPI per engaged slot, then the single terminal
  //    realized-delta check on the user's outAta ──
  const outAta = JSON.stringify(user.outAta);
  lines.push(`  const before = accountUint(${outAta}, 64, 8);`);
  slots.forEach(({ adapter, cfg, swapOverride }, i) => {
    const template = swapOverride ?? adapter.buildSwapV2(cfg, i, user);
    const target = hexLiteral(new Uint8Array(codec.encode(template.programId)));
    const patched = template.patch === 'out' ? `p${i}` : `fill[${i}]`;
    const accounts = template.accounts.map(accountEntry).join(', ');
    const parts = [`s${i}pfx`, `s${i}amt.slice(24, 32)`, ...(template.suffix.length > 0 ? [`s${i}sfx`] : [])];
    lines.push(
      `  if (fill[${i}] > 0 && p${i} > 0) {`,
      `    const s${i}pfx = Uint8Array.from([${Array.from(template.prefix).join(', ')}]);`,
      ...(template.suffix.length > 0
        ? [`    const s${i}sfx = Uint8Array.from([${Array.from(template.suffix).join(', ')}]);`]
        : []),
      `    const s${i}amt = abi.encode(le8(${patched}));`,
      `    const s${i}cd = ${parts[0]}.concat(${parts.slice(1).join(', ')});`,
      `    contract.call(${target}, s${i}cd, [${accounts}]);`,
      '  }',
    );
  });
  lines.push(
    `  const after = accountUint(${outAta}, 64, 8);`,
    '  const realized = after - before;',
    '  if (realized < minOut) { throw "out" }',
  );

  // ── returndata: [fills…][predicted…][realized] as 32-byte BE words ──
  const returns = [...slots.map((_, i) => `fill[${i}]`), ...slots.map((_, i) => `p${i}`), 'realized'];
  lines.push(`  return abi.encode(${returns.join(', ')});`, '}');

  return { source: lines.join('\n'), cfgByteLength, rungs };
}

/**
 * Shape discriminant for blob reuse: family slots (rung-count-suffixed when
 * off the Phase-0 default QL_S) + any swap overrides.
 */
export function ecoSwapSvmShapeKey(slots: readonly EcoSwapSvmSlot[]): string {
  return slots
    .map((slot) => {
      const { adapter, cfg, swapOverride } = slot;
      const rungs = resolveSlotRungs(slot);
      let base = adapter.shapeKey(cfg);
      if (rungs !== QL_S) base += `~r${rungs}`;
      if (swapOverride === undefined) return base;
      return `${base}#ov:${swapOverride.patch}:${swapOverride.programId}:${swapOverride.accounts.length}`;
    })
    .join('|');
}

/** Generates and compiles the staged solver blob for one shape. */
export function generateEcoSwapSvm(input: GenerateEcoSwapSvmInput): GeneratedEcoSwapSvm {
  const { slots, user } = input;
  if (slots.length < 1 || slots.length > 4) {
    throw new Error(`ecoSwapSvm expects 1 to 4 slots, got ${slots.length}`);
  }
  for (const key of ['outAta', 'inAta', 'owner'] as const) {
    if (user[key].length === 0) throw new Error(`ecoSwapSvm user.${key} ref must not be empty`);
  }

  const { source, cfgByteLength, rungs } = generateSource(input);
  const { bytecode, warnings, accountPlan, argsLayout } = compile(source, {
    target: 'svm',
    staged: true,
    args: ['0x' + '00'.repeat(cfgByteLength)],
  });
  if (!accountPlan) throw new Error('svm compile produced no account plan');
  if (!argsLayout) throw new Error('staged svm compile produced no args layout');

  // Stamp adapter-resolved refs with their addresses so resolveAccounts binds
  // them without resolution entries — callers resolve only their own refs
  // (outAta/inAta/owner plus anything a swap override declares bare).
  const addressByRef = new Map<string, string>();
  slots.forEach(({ adapter, cfg, swapOverride }, i) => {
    for (const account of adapter.quoteRefs(cfg, i)) bindAddress(addressByRef, account.ref, account.address);
    const template = swapOverride ?? adapter.buildSwapV2(cfg, i, user);
    for (const account of template.accounts) bindAddress(addressByRef, account.ref, account.address);
    bindAddress(addressByRef, progRef(i), template.programId);
  });
  const metas = accountPlan.metas.map((meta) => {
    const pubkey = addressByRef.get(meta.ref);
    return pubkey === undefined ? meta : { ...meta, pubkey };
  });

  return {
    source,
    bytecode: bytecode[0],
    argsLayout,
    accountPlan: { ...accountPlan, metas },
    shapeKey: ecoSwapSvmShapeKey(slots),
    rungs,
    cfgByteLength,
    warnings,
  };
}
