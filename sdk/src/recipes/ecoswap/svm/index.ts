/**
 * EcoSwapSVM — the Solana EcoSwap: split ONE swap across multiple venues so
 * post-fee marginal prices equalize, computed LIVE in one atomic engine
 * instruction. See README.md for the thesis, the shape-blob model and the
 * honest limits.
 *
 * Orchestration (this module): pool universe in → per-family fetchPoolConfig
 * gates (reused from the v1 adapters, plus the prepare-time activation/fee
 * gates the ladder fragments do not re-check) → relative-depth filter → the
 * CU BUDGETER (budget.ts: per-family measured coefficients fix each slot's
 * ladder rungs and the admitted slot count DETERMINISTICALLY — never from
 * runtime CU) → slot assignment → codegen + staged compile (codegen.ts,
 * GasLeft floor baked) → { blob, argsLayout, plan, sha256 } plus the
 * per-trade encodings; stageEcoSwapSvm / executeEcoSwapSvm are thin wrappers
 * over the /svm client's stageBuffer/executeStaged (stage once, trade many —
 * every trade is ONE execute_from_account instruction).
 *
 * Account loading: pass `load` (single-account, e.g. fixtures) or `loadMany`
 * (a BatchAccountLoader, e.g. kitBatchAccountLoader(rpc)) — with `loadMany`
 * the whole prepare coalesces into getMultipleAccounts sweeps (chunked at
 * 100) and every POOL account's owner is verified against its family's
 * program id before decoding.
 *
 * Read-only and offline against the loader: nothing is sent from here.
 */
import { createHash } from 'node:crypto';
import type { Address } from '@solana/kit';
import type { SauceSvmClient, StagedBuffer } from '../../../svm/client.js';
import type { SendExecuteResult } from '../../../svm/send.js';
import type { AccountResolution } from '../../../svm/resolve.js';
import { coalescingAccountLoader } from '../../../svm/loader.js';
import type { BatchAccountLoader } from '../../../svm/loader.js';
import { meteoraDammV1Stable } from '../../../svm/venues/meteora-damm-v1-stable/index.js';
import type { MeteoraDammV1StablePoolConfig } from '../../../svm/venues/meteora-damm-v1-stable/index.js';
import { meteoraDammV1StableLadder } from '../../../svm/venues/meteora-damm-v1-stable/ladder.js';
import { meteoraDammV2 } from '../../../svm/venues/meteora-damm-v2/index.js';
import type { MeteoraDammV2PoolConfig } from '../../../svm/venues/meteora-damm-v2/index.js';
import { meteoraDammV2Ladder } from '../../../svm/venues/meteora-damm-v2/ladder.js';
import { orcaLegacyTokenSwap } from '../../../svm/venues/orca-legacy-token-swap/index.js';
import { orcaLegacyTokenSwapLadder } from '../../../svm/venues/orca-legacy-token-swap/ladder.js';
import { pumpswapAdapter } from '../../../svm/venues/pumpswap/index.js';
import type { PumpswapPoolConfig } from '../../../svm/venues/pumpswap/index.js';
import { pumpswapLadder } from '../../../svm/venues/pumpswap/ladder.js';
import { raydiumAmmV4 } from '../../../svm/venues/raydium-amm-v4/index.js';
import type { RaydiumAmmV4PoolConfig } from '../../../svm/venues/raydium-amm-v4/index.js';
import { raydiumAmmV4Ladder } from '../../../svm/venues/raydium-amm-v4/ladder.js';
import { raydiumCpSwap } from '../../../svm/venues/raydium-cp-swap/index.js';
import type { RaydiumCpSwapPoolConfig } from '../../../svm/venues/raydium-cp-swap/index.js';
import { raydiumCpSwapLadder } from '../../../svm/venues/raydium-cp-swap/ladder.js';
import { saberStableswap } from '../../../svm/venues/saber-stableswap/index.js';
import { saberStableswapLadder } from '../../../svm/venues/saber-stableswap/ladder.js';
import type {
  AccountBytesMap,
  AccountLoader,
  LadderSwapTemplate,
  PoolConfig,
  SvmVenueLadderV2,
  SwapUser,
} from '../../../svm/venues/types.js';
import { planLadders } from './budget.js';
import type { LadderPlan } from './budget.js';
import { encodeEcoSwapSvmTrade, generateEcoSwapSvm } from './codegen.js';
import type { EcoSwapSvmSlot, GeneratedEcoSwapSvm } from './codegen.js';
import { solveReference } from './solver-reference.js';
import type { SolverReferenceResult, SolverSlotInput } from './solver-reference.js';

export { encodeEcoSwapSvmTrade, ecoSwapSvmShapeKey, generateEcoSwapSvm, resolveSlotRungs } from './codegen.js';
export type { EcoSwapSvmSlot, GenerateEcoSwapSvmInput, GeneratedEcoSwapSvm } from './codegen.js';
export { buildLadder, ladderGrid, solveReference, MAX_RUNGS, MIN_RUNGS, QL_S } from './solver-reference.js';
export type { LadderRung, SolverReferenceResult, SolverSlotInput } from './solver-reference.js';
export { efficiencyLoss, solveOptimal } from './optimal.js';
export type { ContinuousVenue, OptimalSplitResult } from './optimal.js';
export {
  CU_ADMISSION_BUDGET,
  CU_BASE,
  CU_FAMILIES,
  CU_TRANSACTION_CAP,
  defaultRungsFor,
  estimateShapeCu,
  familyCuCoefficients,
  planLadders,
} from './budget.js';
export type { BudgetSlotInput, FamilyCuCoefficients, LadderPlan } from './budget.js';

/** Default relative-depth floor: drop pools below 1% of the summed depth. */
export const ECO_SVM_MIN_REL_BPS = 100;
/**
 * Structural slot cap — the codegen template width. The EFFECTIVE slot count
 * is CU-budgeter-driven (budget.ts): the deepest ECO_SVM_MAX_SLOTS
 * depth-survivors enter admission, and the budgeter degrades ladder rungs /
 * drops tail slots until the shape's modeled cost fits the compute budget.
 */
export const ECO_SVM_MAX_SLOTS = 4;

type LadderVenueSlug =
  | 'raydium-cp-swap'
  | 'raydium-amm-v4'
  | 'pumpswap'
  | 'orca-legacy-token-swap'
  | 'meteora-damm-v2'
  | 'saber-stableswap'
  | 'meteora-damm-v1-stable';

interface FamilyEntry {
  ladder: SvmVenueLadderV2;
  /** The family's on-chain program — the pool account's expected owner. */
  programId: Address;
  fetch: (load: AccountLoader, pool: Address) => Promise<PoolConfig>;
  applyDirection: (cfg: PoolConfig, direction: string | undefined) => PoolConfig;
  /** Prepare-time gates the ladder fragment does not re-check (named errors). */
  gate?: (cfg: PoolConfig, now: bigint) => void;
}

const FAMILIES: Record<LadderVenueSlug, FamilyEntry> = {
  'raydium-cp-swap': {
    ladder: raydiumCpSwapLadder,
    programId: raydiumCpSwap.programId,
    fetch: (load, pool) => raydiumCpSwap.fetchPoolConfig(load, pool),
    applyDirection: (cfg, direction) => {
      if (direction === undefined || direction === '0to1') return cfg;
      if (direction === '1to0') return { ...(cfg as RaydiumCpSwapPoolConfig), inputIsToken0: false };
      throw new Error(`raydium-cp-swap direction must be '0to1' or '1to0', got '${direction}'`);
    },
  },
  'raydium-amm-v4': {
    ladder: raydiumAmmV4Ladder,
    programId: raydiumAmmV4.programId,
    fetch: (load, pool) => raydiumAmmV4.fetchPoolConfig(load, pool),
    applyDirection: (cfg, direction) => {
      if (direction === undefined || direction === 'coinToPc') return cfg;
      if (direction === 'pcToCoin') return { ...(cfg as RaydiumAmmV4PoolConfig), inputIsCoin: false };
      throw new Error(`raydium-amm-v4 direction must be 'coinToPc' or 'pcToCoin', got '${direction}'`);
    },
  },
  pumpswap: {
    ladder: pumpswapLadder,
    programId: pumpswapAdapter.programId,
    fetch: (load, pool) => pumpswapAdapter.fetchPoolConfig(load, pool),
    applyDirection: (cfg, direction) => {
      if (direction === undefined || direction === 'quoteToBase') return cfg;
      if (direction === 'baseToQuote') return { ...(cfg as PumpswapPoolConfig), direction: 'baseToQuote' };
      throw new Error(`pumpswap direction must be 'quoteToBase' or 'baseToQuote', got '${direction}'`);
    },
  },
  'orca-legacy-token-swap': {
    ladder: orcaLegacyTokenSwapLadder,
    programId: orcaLegacyTokenSwap.programId,
    fetch: (load, pool) => orcaLegacyTokenSwap.fetchPoolConfig(load, pool),
    applyDirection: (cfg, direction) => {
      if (direction === undefined || direction === 'AtoB') return cfg;
      throw new Error(`orca-legacy-token-swap only quotes A -> B, got direction '${direction}'`);
    },
  },
  'meteora-damm-v2': {
    ladder: meteoraDammV2Ladder,
    programId: meteoraDammV2.programId,
    fetch: (load, pool) => meteoraDammV2.fetchPoolConfig(load, pool),
    applyDirection: (cfg, direction) => {
      if (direction === undefined || direction === 'aToB') return cfg;
      if (direction === 'bToA') return { ...(cfg as MeteoraDammV2PoolConfig), direction: 'bToA' };
      throw new Error(`meteora-damm-v2 direction must be 'aToB' or 'bToA', got '${direction}'`);
    },
    gate: (cfg, now) => {
      // The ladder fragment carries no clock check (fetch gates slot-typed
      // points already) — reject not-yet-activated timestamp pools here.
      const c = cfg as MeteoraDammV2PoolConfig;
      if (c.activationType === 1 && c.activationPoint > now) {
        throw new Error(`meteora-damm-v2 pool ${c.pool} is not activated until ${c.activationPoint} (now ${now})`);
      }
    },
  },
  'saber-stableswap': {
    ladder: saberStableswapLadder,
    programId: saberStableswap.programId,
    fetch: (load, pool) => saberStableswap.fetchPoolConfig(load, pool),
    applyDirection: (cfg, direction) => {
      if (direction === undefined || direction === 'AtoB') return cfg;
      throw new Error(`saber-stableswap only quotes A -> B, got direction '${direction}'`);
    },
  },
  'meteora-damm-v1-stable': {
    ladder: meteoraDammV1StableLadder,
    programId: meteoraDammV1Stable.programId,
    fetch: (load, pool) => meteoraDammV1Stable.fetchPoolConfig(load, pool),
    applyDirection: (cfg, direction) => {
      if (direction === undefined || direction === 'AtoB') return cfg;
      throw new Error(`meteora-damm-v1-stable only quotes A -> B, got direction '${direction}'`);
    },
    gate: (cfg, now) => {
      const c = cfg as MeteoraDammV1StablePoolConfig;
      if (c.activationType === 1 && c.activationPoint > now) {
        throw new Error(`meteora-damm-v1-stable pool ${c.pool} is not activated until ${c.activationPoint} (now ${now})`);
      }
      // The fragment divides by these live (engine div-by-zero yields 0 ==
      // quote 0), but a zero denominator is a broken pool — gate it loudly.
      if (c.tradeFeeDenominator === 0n || c.protocolTradeFeeDenominator === 0n) {
        throw new Error(`meteora-damm-v1-stable pool ${c.pool} has a zero fee denominator`);
      }
    },
  },
};

export interface EcoSwapSvmPoolSpec {
  venue: LadderVenueSlug;
  pool: Address;
  /**
   * exactIn side, per family: raydium-cp-swap '0to1' (default) | '1to0';
   * raydium-amm-v4 'coinToPc' (default) | 'pcToCoin'; pumpswap 'quoteToBase'
   * (default) | 'baseToQuote'; meteora-damm-v2 'aToB' (default) | 'bToA';
   * saber-stableswap and meteora-damm-v1-stable only 'AtoB'.
   */
  direction?: string;
  /** Test/integration hook: replace the venue swap CPI (the quote stays live). */
  swapOverride?: LadderSwapTemplate;
}

export interface QuoteEcoSwapSvmConfig {
  amountIn: bigint;
  /** Candidate pools in preference order (merge ties keep the earliest slot). 1..4 after filtering. */
  pools: EcoSwapSvmPoolSpec[];
  /** Single-account source (fixtures / custom RPC binding). One of load/loadMany is required. */
  load?: AccountLoader;
  /**
   * Batched source (e.g. kitBatchAccountLoader(rpc)): the prepare coalesces
   * into getMultipleAccounts sweeps chunked at 100, and pool-account owners
   * are verified against each family's program id.
   */
  loadMany?: BatchAccountLoader;
  /** Relative-depth floor in bps of ΣL (default 100 = 1%; 0 disables). */
  minRelBps?: number;
  /**
   * CU admission budget for the budgeter (default CU_ADMISSION_BUDGET =
   * the 1.4M cap minus 15% model headroom). Raising it past the cap forces
   * heavier shapes through — the codegen GasLeft floor still guards them.
   */
  cuBudget?: number;
  /**
   * Unix seconds the time-dependent reference quotes evaluate at (amp ramps,
   * locked-profit decay). Defaults to the wall clock; the lamport-exact e2e
   * gate pins it to the harness cluster clock. The fragments always read the
   * REAL Clock sysvar — a stale `now` only staleness-shifts the off-chain
   * quote, covered by minOut like any other drift.
   */
  now?: bigint;
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
  /** Budgeter-assigned ladder rungs — part of the shape. */
  rungs: number;
}

export interface EcoSwapSvmDroppedPool {
  pool: Address;
  venue: LadderVenueSlug;
  depth: bigint;
  /** What dropped it: the relative-depth filter, the structural slot cap, or the CU budget. */
  reason: 'depth' | 'slots' | 'budget';
}

export interface EcoSwapSvmQuote extends SolverReferenceResult {
  /** Post-filter slot assignment (slots[i] backs slice i). */
  slots: EcoSwapSvmPreparedSlot[];
  /** Pools dropped by the depth filter / slot cap / CU budget. */
  dropped: EcoSwapSvmDroppedPool[];
  /** Modeled CU of the admitted shape (the codegen GasLeft floor). */
  estimatedCu: number;
  /** Budgeter degradations/drops, packet-budgeter style. */
  warnings: string[];
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
  /** COLD exact quote (predicted outputs, the user-facing numbers). */
  quote: (x: bigint) => bigint;
  /** Warm-start ladder chain (stable slots); undefined = pointwise quote. */
  ladderQuotes?: (grid: readonly bigint[]) => bigint[];
  depth: bigint;
}

/** The effective loader: `load` as given, or a coalescing wrapper over `loadMany` with pool-owner checks. */
function effectiveLoader(config: QuoteEcoSwapSvmConfig): AccountLoader {
  if (config.load !== undefined && config.loadMany !== undefined) {
    throw new Error('ecoSwapSvm takes load OR loadMany, not both');
  }
  if (config.load !== undefined) return config.load;
  if (config.loadMany === undefined) throw new Error('ecoSwapSvm needs an account source: pass load or loadMany');

  const expectedOwner = new Map<Address, { owner: Address; venue: string }>();
  for (const spec of config.pools) {
    const entry = FAMILIES[spec.venue];
    if (entry !== undefined) expectedOwner.set(spec.pool, { owner: entry.programId, venue: spec.venue });
  }
  return coalescingAccountLoader(config.loadMany, {
    expectOwner: (address, owner) => {
      const expected = expectedOwner.get(address);
      if (expected !== undefined && expected.owner !== owner) {
        throw new Error(
          `ecoSwapSvm pool ${address} is owned by ${owner}, expected the ${expected.venue} program ${expected.owner}`,
        );
      }
    },
  });
}

/**
 * Fetch + gate every candidate (the v1 adapters' fetchPoolConfig — status
 * bits, transfer-fee mints, curve types — plus the family prepare gates),
 * snapshot the quote accounts, apply the relative-depth filter over
 * L = isqrt(rIn·rOut), the structural slot cap, and the CU budgeter.
 */
async function resolveCandidates(
  config: QuoteEcoSwapSvmConfig,
): Promise<{ survivors: ResolvedCandidate[]; dropped: EcoSwapSvmDroppedPool[]; plan: LadderPlan }> {
  const { pools, amountIn } = config;
  requireU64('amountIn', amountIn, true);
  if (pools.length === 0) throw new Error('ecoSwapSvm needs at least one candidate pool');
  const load = effectiveLoader(config);
  const now = config.now ?? BigInt(Math.floor(Date.now() / 1000));

  // Parallel fetch: with a coalescing loader every dependency LEVEL becomes
  // one getMultipleAccounts sweep across all candidates.
  const candidates: ResolvedCandidate[] = await Promise.all(
    pools.map(async (spec) => {
      const entry = FAMILIES[spec.venue];
      if (entry === undefined) {
        throw new Error(`ecoSwapSvm unknown venue '${spec.venue}' (known: ${Object.keys(FAMILIES).join(', ')})`);
      }
      const cfg = entry.applyDirection(await entry.fetch(load, spec.pool), spec.direction);
      entry.gate?.(cfg, now);

      const refs = entry.ladder.quoteRefs(cfg, 0).filter((account) => account.address !== undefined);
      const unique = [...new Set(refs.map((account) => account.address!))];
      const state: AccountBytesMap = {};
      await Promise.all(
        unique.map(async (address) => {
          const data = await load(address);
          if (data === null) throw new Error(`ecoSwapSvm quote account ${address} of pool ${spec.pool} not found`);
          state[address] = data;
        }),
      );

      const params = entry.ladder.paramsFor(cfg);
      const { reserveIn, reserveOut } = entry.ladder.depthReserves(cfg, state, now);
      if (reserveIn < 0n || reserveOut < 0n) {
        throw new Error(`ecoSwapSvm pool ${spec.pool} has negative effective reserves (vault below accrued fees)`);
      }
      return {
        spec,
        entry,
        cfg,
        params,
        quote: entry.ladder.referenceQuote(cfg, state, params, now),
        ladderQuotes: entry.ladder.referenceLadderQuotes?.(cfg, state, params, now),
        depth: bigintSqrt(reserveIn * reserveOut),
      };
    }),
  );

  const droppedAs = (c: ResolvedCandidate, reason: EcoSwapSvmDroppedPool['reason']): EcoSwapSvmDroppedPool => ({
    pool: c.spec.pool,
    venue: c.spec.venue,
    depth: c.depth,
    reason,
  });

  // Relative-depth filter (aliveness + minRelBps of ΣL), then the structural
  // cap — keep the deepest ECO_SVM_MAX_SLOTS, preserving caller preference
  // order — then the CU budgeter fixes rungs and may drop tail slots.
  const minRelBps = BigInt(config.minRelBps ?? ECO_SVM_MIN_REL_BPS);
  const totalDepth = candidates.reduce((sum, c) => sum + c.depth, 0n);
  let survivors = candidates.filter((c) => c.depth > 0n && c.depth * 10_000n >= minRelBps * totalDepth);
  const dropped = candidates.filter((c) => !survivors.includes(c)).map((c) => droppedAs(c, 'depth'));
  if (survivors.length > ECO_SVM_MAX_SLOTS) {
    const deepest = [...survivors]
      .sort((a, b) => (b.depth > a.depth ? 1 : b.depth < a.depth ? -1 : 0))
      .slice(0, ECO_SVM_MAX_SLOTS);
    dropped.push(...survivors.filter((c) => !deepest.includes(c)).map((c) => droppedAs(c, 'slots')));
    survivors = survivors.filter((c) => deepest.includes(c));
  }
  if (survivors.length === 0) {
    throw new Error('ecoSwapSvm: no pool survived the relative-depth filter (pass minRelBps: 0 to disable)');
  }

  const plan = planLadders(
    survivors.map((c) => ({ slug: c.spec.venue })),
    config.cuBudget,
  );
  dropped.push(...survivors.slice(plan.admitted).map((c) => droppedAs(c, 'budget')));
  survivors = survivors.slice(0, plan.admitted);

  return { survivors, dropped, plan };
}

const preparedSlot = (c: ResolvedCandidate, rungs: number): EcoSwapSvmPreparedSlot => ({
  venue: c.spec.venue,
  pool: c.spec.pool,
  params: c.params,
  depth: c.depth,
  rungs,
});

const solverInputs = (survivors: readonly ResolvedCandidate[], plan: LadderPlan): SolverSlotInput[] =>
  survivors.map((c, i) => ({
    quote: c.quote,
    ...(c.ladderQuotes !== undefined ? { ladderQuotes: c.ladderQuotes } : {}),
    rungs: plan.rungs[i],
  }));

/**
 * The user-facing quote: fetch the candidates' account bytes once through
 * the loader, run the exact solver mirror — zero simulation, zero execution.
 * Lamport-identical to what the staged blob would compute on the same bytes.
 */
export async function quoteEcoSwapSvm(config: QuoteEcoSwapSvmConfig): Promise<EcoSwapSvmQuote> {
  const { survivors, dropped, plan } = await resolveCandidates(config);
  const result = solveReference(solverInputs(survivors, plan), config.amountIn);
  return {
    ...result,
    slots: survivors.map((c, i) => preparedSlot(c, plan.rungs[i])),
    dropped,
    estimatedCu: plan.estimatedCu,
    warnings: plan.warnings,
  };
}

/**
 * Prepare + compile: candidate gates → depth filter → CU budgeter → slot
 * assignment → shape codegen → staged compile. The blob serves ANY pool set
 * matching its shapeKey — per-trade values ride the payload args, pool
 * accounts rebind through the resolution map.
 */
export async function ecoSwapSvm(config: EcoSwapSvmConfig): Promise<EcoSwapSvmOutput> {
  requireU64('minOut', config.minOut, false);
  const { survivors, dropped, plan } = await resolveCandidates(config);

  const slots: EcoSwapSvmSlot[] = survivors.map((c, i) => ({
    adapter: c.entry.ladder,
    cfg: c.cfg,
    rungs: plan.rungs[i],
    swapOverride: c.spec.swapOverride,
  }));
  const generated = generateEcoSwapSvm({ slots, user: config.user, cuFloor: plan.estimatedCu });

  const tradeSlots = survivors.map((c) => ({ params: c.params }));
  const encodeTrade = (amountIn: bigint, minOut: bigint): [`0x${string}`] => {
    requireU64('amountIn', amountIn, true);
    requireU64('minOut', minOut, false);
    return [encodeEcoSwapSvmTrade(tradeSlots, amountIn, minOut)];
  };

  const quote = solveReference(solverInputs(survivors, plan), config.amountIn);

  return {
    ...generated,
    warnings: [...generated.warnings, ...plan.warnings],
    sha256: new Uint8Array(createHash('sha256').update(generated.bytecode).digest()),
    slots: survivors.map((c, i) => preparedSlot(c, plan.rungs[i])),
    argValues: encodeTrade(config.amountIn, config.minOut),
    quote: {
      ...quote,
      slots: survivors.map((c, i) => preparedSlot(c, plan.rungs[i])),
      dropped,
      estimatedCu: plan.estimatedCu,
      warnings: plan.warnings,
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
