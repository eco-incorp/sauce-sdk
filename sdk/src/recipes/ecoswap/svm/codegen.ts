/**
 * EcoSwapSVM codegen — assembles the shape-generic staged solver from the
 * adapter-v2 ladder fragments and compiles it `{ target: 'svm', staged:
 * true }`.
 *
 * ONE compiled blob per SHAPE (the ordered list of family slots — venue,
 * direction, optional-account layout) serves any matching pool set:
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
import { QL_S } from './solver-reference.js';

export interface EcoSwapSvmSlot {
  adapter: SvmVenueLadderV2;
  cfg: PoolConfig;
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
  /** Byte length of the packed cfg arg (encodeEcoSwapSvmTrade must match). */
  cfgByteLength: number;
  warnings: string[];
}

const U64_MAX = (1n << 64n) - 1n;

const hexLiteral = (bytes: Uint8Array): string =>
  '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const progRef = (slot: number): string => `s${slot}:prog`;

/** 64-bit byte swap: the LE image of a u64 amount, MSTORE'd big-endian by abi.encode. */
const LE8_HELPER = [
  'function le8(x) {',
  '  return ((x & 255) << 56) | ((x & 65280) << 40) | ((x & 16711680) << 24) | ((x & 4278190080) << 8)' +
    ' | ((x >> 8) & 4278190080) | ((x >> 24) & 16711680) | ((x >> 40) & 65280) | (x >> 56);',
  '}',
].join('\n');

function accountEntry(account: VenueAccount): string {
  const flags = [
    ...(account.writable ? ['writable: true'] : []),
    ...(account.signer ? ['signer: true'] : []),
  ];
  if (flags.length === 0) return JSON.stringify(account.ref);
  return `{ ref: ${JSON.stringify(account.ref)}, ${flags.join(', ')} }`;
}

/** Records ref → address; a ref claiming two different addresses is a config error. */
function bindAddress(addressByRef: Map<string, string>, ref: string, address: Address | undefined): void {
  if (address === undefined) return;
  const bound = addressByRef.get(ref);
  if (bound !== undefined && bound !== address) {
    throw new Error(`ecoSwapSvm account ref '${ref}' is bound to two different addresses (${bound}, ${address})`);
  }
  addressByRef.set(ref, address);
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

function generateSource(input: GenerateEcoSwapSvmInput): { source: string; cfgByteLength: number } {
  const { slots, user } = input;
  const k = slots.length;
  const codec = getAddressCodec();

  // ── helpers: le8 + one quote helper per family/direction (deduped) ──
  const helpers = new Map<string, string>();
  for (const { adapter, cfg } of slots) {
    const name = adapter.helperName(cfg);
    if (!helpers.has(name)) helpers.set(name, adapter.helperSource(cfg));
  }

  const lines: string[] = [LE8_HELPER, ...helpers.values()];
  lines.push('function main(cfg) {');

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
    lines.push(`  const s${i}on = ${slice()};`);
    enables.push(`s${i}on`);
    const params: string[] = [];
    for (let p = 0; p < adapter.paramCount; p++) {
      lines.push(`  const s${i}p${p} = ${slice()};`);
      params.push(`s${i}p${p}`);
    }
    slotParams.push(params);
  });
  const cfgByteLength = word * 8;

  // ── setup: LIVE reserve/fee reads into slot locals (unconditional — a
  //    disabled slot still needs readable accounts attached; see README) ──
  slots.forEach(({ adapter, cfg }, i) => lines.push(adapter.emitSetup(cfg, i, slotParams[i])));

  // Zero-length reads intern each slot's CPI target program account: the
  // engine resolves a CALL target by scanning the attached user accounts for
  // the program's pubkey, so it must ride along.
  for (let i = 0; i < k; i++) lines.push(`  accountData(${JSON.stringify(progRef(i))}, 0, 0);`);

  // ── ladders: QL_S rungs per enabled slot on the geometric grid
  //    G_j = amountIn >> (QL_S − j); a disabled slot is born exhausted ──
  lines.push(
    `  const din = new Array(${k * QL_S});`,
    `  const dout = new Array(${k * QL_S});`,
    `  const ptr = new Array(${k});`,
    `  const fill = new Array(${k});`,
  );
  slots.forEach(({ adapter, cfg }, i) => {
    const call = (x: string) => adapter.emitQuoteCall(cfg, i, x);
    lines.push(`  if (${enables[i]} !== 0) {`);
    for (let j = 1; j <= QL_S; j++) {
      const rung = i * QL_S + (j - 1);
      const g = j === QL_S ? 'amountIn' : `s${i}g${j}`;
      if (j < QL_S) lines.push(`    const ${g} = amountIn >> ${QL_S - j};`);
      lines.push(`    const s${i}o${j} = ${call(g)};`);
      if (j === 1) {
        lines.push(`    din[${rung}] = ${g}; dout[${rung}] = s${i}o${j};`);
      } else {
        lines.push(`    din[${rung}] = ${g} - s${i}g${j - 1}; dout[${rung}] = s${i}o${j} - s${i}o${j - 1};`);
      }
    }
    lines.push('  }');
    lines.push(`  if (${enables[i]} === 0) { ptr[${i}] = ${QL_S} }`);
  });

  // ── merge: greedy cheapest-rung-first, ONE pointer advance per step;
  //    election by cross-multiplied average price, first-scanned slot keeps
  //    ties. Mirrored 1:1 by solver-reference.ts — change together. ──
  lines.push(
    '  let remaining = amountIn;',
    `  for (let it = 0; it < ${k * QL_S} && remaining > 0; it++) {`,
    `    let best = ${k};`,
    `    for (let s = 0; s < ${k}; s++) {`,
    `      if (ptr[s] < ${QL_S}) {`,
    `        if (best === ${k}) { best = s }`,
    '        if (best !== s) {',
    `          const c = s * ${QL_S} + ptr[s];`,
    `          const b = best * ${QL_S} + ptr[best];`,
    '          if (dout[c] * din[b] > dout[b] * din[c]) { best = s }',
    '        }',
    '      }',
    '    }',
    `    if (best === ${k}) { throw "fill" }`,
    `    const r = best * ${QL_S} + ptr[best];`,
    '    let take = din[r];',
    '    if (take > remaining) { take = remaining }',
    '    fill[best] += take;',
    '    remaining -= take;',
    '    if (take === din[r]) { ptr[best] = ptr[best] + 1 }',
    '  }',
    '  if (remaining > 0) { throw "fill" }',
  );

  // ── predicted outputs + the pre-CPI bound (compute BEFORE the first CPI:
  //    once invoke() launches, a callee failure aborts the transaction) ──
  slots.forEach(({ adapter, cfg }, i) => {
    lines.push(`  const p${i} = ${adapter.emitQuoteCall(cfg, i, `fill[${i}]`)};`);
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

  return { source: lines.join('\n'), cfgByteLength };
}

/** Shape discriminant for blob reuse: family slots + any swap overrides. */
export function ecoSwapSvmShapeKey(slots: readonly EcoSwapSvmSlot[]): string {
  return slots
    .map(({ adapter, cfg, swapOverride }) => {
      const base = adapter.shapeKey(cfg);
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

  const { source, cfgByteLength } = generateSource(input);
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
    cfgByteLength,
    warnings,
  };
}
