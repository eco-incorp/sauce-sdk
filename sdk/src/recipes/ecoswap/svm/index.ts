/**
 * EcoSwapSVM — Phase 0 walking skeleton of the Solana EcoSwap: split ONE
 * swap across multiple constant-product venues so post-fee marginal prices
 * equalize, computed LIVE in one atomic engine instruction. See README.md
 * for the thesis, the shape-blob model and the honest limits.
 *
 * Orchestration (this module): pool universe in → per-family fetchPoolConfig
 * gates (reused from the v1 adapters) → relative-depth filter → slot
 * assignment → codegen + staged compile (codegen.ts) → { blob, argsLayout,
 * plan, sha256 } plus the per-trade encodings; stageEcoSwapSvm /
 * executeEcoSwapSvm are thin wrappers over the /svm client's
 * stageBuffer/executeStaged (stage once, trade many — every trade is ONE
 * execute_from_account instruction).
 *
 * Read-only and offline against `load`: nothing is sent from here.
 */
import { createHash } from 'node:crypto';
import type { Address } from '@solana/kit';
import type { SauceSvmClient, StagedBuffer } from '../../../svm/client.js';
import type { SendExecuteResult } from '../../../svm/send.js';
import type { AccountResolution } from '../../../svm/resolve.js';
import { orcaLegacyTokenSwap } from '../../../svm/venues/orca-legacy-token-swap/index.js';
import { orcaLegacyTokenSwapLadder } from '../../../svm/venues/orca-legacy-token-swap/ladder.js';
import { pumpswapAdapter } from '../../../svm/venues/pumpswap/index.js';
import type { PumpswapPoolConfig } from '../../../svm/venues/pumpswap/index.js';
import { pumpswapLadder } from '../../../svm/venues/pumpswap/ladder.js';
import { raydiumCpSwap } from '../../../svm/venues/raydium-cp-swap/index.js';
import type { RaydiumCpSwapPoolConfig } from '../../../svm/venues/raydium-cp-swap/index.js';
import { raydiumCpSwapLadder } from '../../../svm/venues/raydium-cp-swap/ladder.js';
import type {
  AccountBytesMap,
  AccountLoader,
  LadderSwapTemplate,
  PoolConfig,
  SvmVenueLadderV2,
  SwapUser,
} from '../../../svm/venues/types.js';
import { encodeEcoSwapSvmTrade, generateEcoSwapSvm } from './codegen.js';
import type { EcoSwapSvmSlot, GeneratedEcoSwapSvm } from './codegen.js';
import { solveReference } from './solver-reference.js';
import type { SolverReferenceResult } from './solver-reference.js';

export { encodeEcoSwapSvmTrade, ecoSwapSvmShapeKey, generateEcoSwapSvm } from './codegen.js';
export type { EcoSwapSvmSlot, GenerateEcoSwapSvmInput, GeneratedEcoSwapSvm } from './codegen.js';
export { buildLadder, solveReference, QL_S } from './solver-reference.js';
export type { LadderRung, SolverReferenceResult, SolverSlotInput } from './solver-reference.js';
export { efficiencyLoss, solveOptimal } from './optimal.js';
export type { ContinuousVenue, OptimalSplitResult } from './optimal.js';

/** Default relative-depth floor: drop pools below 1% of the summed CP depth. */
export const ECO_SVM_MIN_REL_BPS = 100;
/**
 * Slot cap the orchestrator admits. The codegen template is structurally
 * 4-wide, but the interpreter's measured per-op cost walls a 4-slot trade
 * above the 1.4M CU transaction cap (measured: 2 slots ≈ 842k, 3 ≈ 1.31M,
 * 4 fails ProgramFailedToComplete) — so prepare keeps the deepest 3 until
 * the Phase 1 CU budgeter / leaner codegen lands. See README, honest limits.
 */
export const ECO_SVM_MAX_SLOTS = 3;

type LadderVenueSlug = 'raydium-cp-swap' | 'pumpswap' | 'orca-legacy-token-swap';

interface FamilyEntry {
  ladder: SvmVenueLadderV2;
  fetch: (load: AccountLoader, pool: Address) => Promise<PoolConfig>;
  applyDirection: (cfg: PoolConfig, direction: string | undefined) => PoolConfig;
}

const FAMILIES: Record<LadderVenueSlug, FamilyEntry> = {
  'raydium-cp-swap': {
    ladder: raydiumCpSwapLadder,
    fetch: (load, pool) => raydiumCpSwap.fetchPoolConfig(load, pool),
    applyDirection: (cfg, direction) => {
      if (direction === undefined || direction === '0to1') return cfg;
      if (direction === '1to0') return { ...(cfg as RaydiumCpSwapPoolConfig), inputIsToken0: false };
      throw new Error(`raydium-cp-swap direction must be '0to1' or '1to0', got '${direction}'`);
    },
  },
  pumpswap: {
    ladder: pumpswapLadder,
    fetch: (load, pool) => pumpswapAdapter.fetchPoolConfig(load, pool),
    applyDirection: (cfg, direction) => {
      if (direction === undefined || direction === 'quoteToBase') return cfg;
      if (direction === 'baseToQuote') return { ...(cfg as PumpswapPoolConfig), direction: 'baseToQuote' };
      throw new Error(`pumpswap direction must be 'quoteToBase' or 'baseToQuote', got '${direction}'`);
    },
  },
  'orca-legacy-token-swap': {
    ladder: orcaLegacyTokenSwapLadder,
    fetch: (load, pool) => orcaLegacyTokenSwap.fetchPoolConfig(load, pool),
    applyDirection: (cfg, direction) => {
      if (direction === undefined || direction === 'AtoB') return cfg;
      throw new Error(`orca-legacy-token-swap only quotes A -> B, got direction '${direction}'`);
    },
  },
};

export interface EcoSwapSvmPoolSpec {
  venue: LadderVenueSlug;
  pool: Address;
  /**
   * exactIn side, per family: raydium-cp-swap '0to1' (default) | '1to0';
   * pumpswap 'quoteToBase' (default) | 'baseToQuote'; orca only 'AtoB'.
   */
  direction?: string;
  /** Test/integration hook: replace the venue swap CPI (the quote stays live). */
  swapOverride?: LadderSwapTemplate;
}

export interface QuoteEcoSwapSvmConfig {
  amountIn: bigint;
  /** Candidate pools in preference order (merge ties keep the earliest slot). 1..4 after filtering. */
  pools: EcoSwapSvmPoolSpec[];
  /** RPC-or-fixture account source; e.g. wrap @solana/kit getMultipleAccounts. */
  load: AccountLoader;
  /** Relative-depth floor in bps of ΣL (default 100 = 1%; 0 disables). */
  minRelBps?: number;
}

export interface EcoSwapSvmConfig extends QuoteEcoSwapSvmConfig {
  /** Minimum realized outAta delta, inclusive — enforced pre-CPI on the prediction and post-CPI on the delta. */
  minOut: bigint;
  /** User-side account refs, resolved by the caller when sending. */
  user: SwapUser;
}

export interface EcoSwapSvmPreparedSlot {
  venue: LadderVenueSlug;
  pool: Address;
  /** Per-trade param words (encodeEcoSwapSvmTrade order). */
  params: bigint[];
  /** Depth metric used by the relative filter: isqrt(reserveIn * reserveOut). */
  depth: bigint;
}

export interface EcoSwapSvmQuote extends SolverReferenceResult {
  /** Post-filter slot assignment (slots[i] backs slice i). */
  slots: EcoSwapSvmPreparedSlot[];
  /** Pools dropped by the relative-depth filter. */
  dropped: { pool: Address; venue: LadderVenueSlug; depth: bigint }[];
}

export interface EcoSwapSvmOutput extends GeneratedEcoSwapSvm {
  /** sha256 of the staged blob — the execute pin (stageBuffer recomputes and verifies on-chain). */
  sha256: Uint8Array;
  /** Post-filter slots, in blob order. */
  slots: EcoSwapSvmPreparedSlot[];
  /** Encoded cfg arg for THIS trade (amountIn/minOut baked); re-encode via encodeTrade for others. */
  argValues: [`0x${string}`];
  /** Reference solve on the fetch-time account bytes (the user-facing quote). */
  quote: EcoSwapSvmQuote;
  /** Re-encodes the cfg arg for a new trade on the SAME staged blob (stage once, trade many). */
  encodeTrade: (amountIn: bigint, minOut: bigint) => [`0x${string}`];
}

const U64_MAX = (1n << 64n) - 1n;

function requireU64(name: string, value: bigint, positive: boolean): void {
  if ((positive ? value <= 0n : value < 0n) || value > U64_MAX) {
    throw new Error(`ecoSwapSvm ${name} must be a ${positive ? 'positive' : 'non-negative'} u64, got ${value}`);
  }
}

/** Floor integer square root (Newton), for the CP depth metric L = isqrt(rIn·rOut). */
export function bigintSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error(`bigintSqrt needs a non-negative value, got ${value}`);
  if (value < 2n) return value;
  let x = 1n << (BigInt(value.toString(2).length + 1) / 2n);
  let y = (x + value / x) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

interface ResolvedCandidate {
  spec: EcoSwapSvmPoolSpec;
  entry: FamilyEntry;
  cfg: PoolConfig;
  params: bigint[];
  quote: (x: bigint) => bigint;
  depth: bigint;
}

/**
 * Fetch + gate every candidate (the v1 adapters' fetchPoolConfig — status
 * bits, transfer-fee mints, curve types), snapshot the quote accounts, and
 * apply the relative-depth filter over L = isqrt(rIn·rOut).
 */
async function resolveCandidates(
  config: QuoteEcoSwapSvmConfig,
): Promise<{ survivors: ResolvedCandidate[]; dropped: ResolvedCandidate[] }> {
  const { pools, load, amountIn } = config;
  requireU64('amountIn', amountIn, true);
  if (pools.length === 0) throw new Error('ecoSwapSvm needs at least one candidate pool');

  const candidates: ResolvedCandidate[] = [];
  for (const spec of pools) {
    const entry = FAMILIES[spec.venue];
    if (entry === undefined) {
      throw new Error(`ecoSwapSvm unknown venue '${spec.venue}' (known: ${Object.keys(FAMILIES).join(', ')})`);
    }
    const cfg = entry.applyDirection(await entry.fetch(load, spec.pool), spec.direction);

    const state: AccountBytesMap = {};
    for (const account of entry.ladder.quoteRefs(cfg, 0)) {
      if (account.address === undefined || state[account.address] !== undefined) continue;
      const data = await load(account.address);
      if (data === null) throw new Error(`ecoSwapSvm quote account ${account.address} of pool ${spec.pool} not found`);
      state[account.address] = data;
    }

    const params = entry.ladder.paramsFor(cfg);
    const { reserveIn, reserveOut } = entry.ladder.depthReserves(cfg, state);
    if (reserveIn < 0n || reserveOut < 0n) {
      throw new Error(`ecoSwapSvm pool ${spec.pool} has negative effective reserves (vault below accrued fees)`);
    }
    candidates.push({
      spec,
      entry,
      cfg,
      params,
      quote: entry.ladder.referenceQuote(cfg, state, params),
      depth: bigintSqrt(reserveIn * reserveOut),
    });
  }

  // Relative-depth filter (aliveness + minRelBps of ΣL), then the slot cap —
  // keep the deepest ECO_SVM_MAX_SLOTS, preserving caller preference order.
  const minRelBps = BigInt(config.minRelBps ?? ECO_SVM_MIN_REL_BPS);
  const totalDepth = candidates.reduce((sum, c) => sum + c.depth, 0n);
  let survivors = candidates.filter((c) => c.depth > 0n && c.depth * 10_000n >= minRelBps * totalDepth);
  const dropped = candidates.filter((c) => !survivors.includes(c));
  if (survivors.length > ECO_SVM_MAX_SLOTS) {
    const deepest = [...survivors].sort((a, b) => (b.depth > a.depth ? 1 : b.depth < a.depth ? -1 : 0)).slice(0, ECO_SVM_MAX_SLOTS);
    survivors = survivors.filter((c) => deepest.includes(c));
  }
  if (survivors.length === 0) {
    throw new Error('ecoSwapSvm: no pool survived the relative-depth filter (pass minRelBps: 0 to disable)');
  }
  return { survivors, dropped };
}

const preparedSlot = (c: ResolvedCandidate): EcoSwapSvmPreparedSlot => ({
  venue: c.spec.venue,
  pool: c.spec.pool,
  params: c.params,
  depth: c.depth,
});

/**
 * The user-facing quote: fetch the candidates' account bytes once through
 * `load`, run the exact solver mirror — zero simulation, zero execution.
 * Lamport-identical to what the staged blob would compute on the same bytes.
 */
export async function quoteEcoSwapSvm(config: QuoteEcoSwapSvmConfig): Promise<EcoSwapSvmQuote> {
  const { survivors, dropped } = await resolveCandidates(config);
  const result = solveReference(
    survivors.map((c) => ({ quote: c.quote })),
    config.amountIn,
  );
  return {
    ...result,
    slots: survivors.map(preparedSlot),
    dropped: dropped.map((c) => ({ pool: c.spec.pool, venue: c.spec.venue, depth: c.depth })),
  };
}

/**
 * Prepare + compile: candidate gates → depth filter → slot assignment →
 * shape codegen → staged compile. The blob serves ANY pool set matching its
 * shapeKey — per-trade values ride the payload args, pool accounts rebind
 * through the resolution map.
 */
export async function ecoSwapSvm(config: EcoSwapSvmConfig): Promise<EcoSwapSvmOutput> {
  requireU64('minOut', config.minOut, false);
  const { survivors, dropped } = await resolveCandidates(config);

  const slots: EcoSwapSvmSlot[] = survivors.map((c) => ({
    adapter: c.entry.ladder,
    cfg: c.cfg,
    swapOverride: c.spec.swapOverride,
  }));
  const generated = generateEcoSwapSvm({ slots, user: config.user });

  const tradeSlots = survivors.map((c) => ({ params: c.params }));
  const encodeTrade = (amountIn: bigint, minOut: bigint): [`0x${string}`] => {
    requireU64('amountIn', amountIn, true);
    requireU64('minOut', minOut, false);
    return [encodeEcoSwapSvmTrade(tradeSlots, amountIn, minOut)];
  };

  const quote = solveReference(
    survivors.map((c) => ({ quote: c.quote })),
    config.amountIn,
  );

  return {
    ...generated,
    sha256: new Uint8Array(createHash('sha256').update(generated.bytecode).digest()),
    slots: survivors.map(preparedSlot),
    argValues: encodeTrade(config.amountIn, config.minOut),
    quote: {
      ...quote,
      slots: survivors.map(preparedSlot),
      dropped: dropped.map((c) => ({ pool: c.spec.pool, venue: c.spec.venue, depth: c.depth })),
    },
    encodeTrade,
  };
}

/**
 * Stage the blob once into buffer `index` (init → chunked writes → the
 * on-chain sha256-gated finalize). The returned StagedBuffer carries the
 * content-hash pin every execute uses.
 */
export async function stageEcoSwapSvm(
  client: SauceSvmClient,
  index: number,
  output: Pick<EcoSwapSvmOutput, 'bytecode'>,
): Promise<StagedBuffer> {
  return client.stageBuffer(index, output.bytecode);
}

/**
 * One trade = ONE execute_from_account instruction: the staged blob,
 * hash-pinned, with this trade's cfg bytes as payload args. `resolution`
 * binds the user refs (outAta/inAta/owner — plus, for pumpswap buy slots,
 * the caller-derived user volume accumulator PDA); adapter-resolved refs are
 * already stamped on the plan.
 */
export async function executeEcoSwapSvm(
  client: SauceSvmClient,
  staged: StagedBuffer | Address,
  output: EcoSwapSvmOutput,
  resolution: AccountResolution,
  trade?: { amountIn: bigint; minOut: bigint },
): Promise<SendExecuteResult> {
  const values = trade === undefined ? output.argValues : output.encodeTrade(trade.amountIn, trade.minOut);
  return client.executeStaged(staged, output.accountPlan, resolution, {
    args: { layout: output.argsLayout, values },
    computeUnitLimit: 'auto',
    ...(typeof staged === 'string' ? { expectedSha256: output.sha256 } : {}),
  });
}
