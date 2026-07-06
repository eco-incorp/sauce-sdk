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
import { isSignerRole } from '@solana/kit';
import type { Address, Commitment, Instruction, TransactionSigner } from '@solana/kit';
import { estimatePacket } from '@eco-incorp/sauce-compiler';
import type { PacketBudget } from '@eco-incorp/sauce-compiler';
import type { EnsuredLookupTable, SauceSvmClient, StagedBuffer } from '../../../svm/client.js';
import type { SendExecuteResult } from '../../../svm/send.js';
import { resolveAccounts } from '../../../svm/resolve.js';
import type { AccountResolution } from '../../../svm/resolve.js';
import { selectAltAddresses } from '../../../svm/alt.js';
import { coalescingAccountLoader } from '../../../svm/loader.js';
import type { BatchAccountLoader } from '../../../svm/loader.js';
import { buildAtaPrepend } from '../../../svm/prepends.js';
import { meteoraDammV1Stable } from '../../../svm/venues/meteora-damm-v1-stable/index.js';
import type { MeteoraDammV1StablePoolConfig } from '../../../svm/venues/meteora-damm-v1-stable/index.js';
import { meteoraDammV1StableLadder } from '../../../svm/venues/meteora-damm-v1-stable/ladder.js';
import { meteoraDammV2 } from '../../../svm/venues/meteora-damm-v2/index.js';
import type { MeteoraDammV2PoolConfig } from '../../../svm/venues/meteora-damm-v2/index.js';
import { meteoraDammV2Ladder } from '../../../svm/venues/meteora-damm-v2/ladder.js';
import { orcaLegacyTokenSwap } from '../../../svm/venues/orca-legacy-token-swap/index.js';
import { orcaLegacyTokenSwapLadder } from '../../../svm/venues/orca-legacy-token-swap/ladder.js';
import { orcaWhirlpool, windowFor } from '../../../svm/venues/orca-whirlpool/index.js';
import type { OrcaWhirlpoolPoolConfig } from '../../../svm/venues/orca-whirlpool/index.js';
import { orcaWhirlpoolLadder } from '../../../svm/venues/orca-whirlpool/ladder.js';
import { raydiumClmm, windowFor as raydiumClmmWindowFor } from '../../../svm/venues/raydium-clmm/index.js';
import type { RaydiumClmmPoolConfig } from '../../../svm/venues/raydium-clmm/index.js';
import { raydiumClmmLadder } from '../../../svm/venues/raydium-clmm/ladder.js';
import { meteoraDlmm, windowFor as meteoraDlmmWindowFor } from '../../../svm/venues/meteora-dlmm/index.js';
import type { MeteoraDlmmPoolConfig } from '../../../svm/venues/meteora-dlmm/index.js';
import { meteoraDlmmLadder } from '../../../svm/venues/meteora-dlmm/ladder.js';
import { manifest, manifestWindowFor } from '../../../svm/venues/manifest/index.js';
import type { ManifestPoolConfig } from '../../../svm/venues/manifest/index.js';
import { manifestLadder } from '../../../svm/venues/manifest/ladder.js';
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
import { obricV2 } from '../../../svm/venues/obric-v2/index.js';
import type { ObricV2PoolConfig } from '../../../svm/venues/obric-v2/index.js';
import { obricV2Ladder } from '../../../svm/venues/obric-v2/ladder.js';
import type {
  AccountBytesMap,
  AccountLoader,
  LadderSwapTemplate,
  PoolConfig,
  SvmVenueLadderV2,
  SwapUser,
} from '../../../svm/venues/types.js';
import { planLadders, planRouteLadders } from './budget.js';
import type { LadderPlan, RouteLadderPlan } from './budget.js';
import { encodeEcoSwapSvmTrade, generateEcoSwapSvm } from './codegen.js';
import type { EcoSwapSvmSlot, GeneratedEcoSwapSvm } from './codegen.js';
import { DEFAULT_INTER_REF, generateEcoSwapSvmRoute } from './route.js';
import type { GeneratedEcoSwapSvmRoute } from './route.js';
import { routeReference, solveReference } from './solver-reference.js';
import type { RouteReferenceResult, SolverReferenceResult, SolverSlotInput } from './solver-reference.js';

export { encodeEcoSwapSvmTrade, ecoSwapSvmShapeKey, generateEcoSwapSvm, resolveSlotRungs } from './codegen.js';
export type { EcoSwapSvmSlot, GenerateEcoSwapSvmInput, GeneratedEcoSwapSvm } from './codegen.js';
export {
  DEFAULT_INTER_REF,
  ecoSwapSvmRouteShapeKey,
  generateEcoSwapSvmRoute,
  MAX_LEG_SLOTS,
  MAX_ROUTE_SLOTS,
} from './route.js';
export type { GenerateEcoSwapSvmRouteInput, GeneratedEcoSwapSvmRoute } from './route.js';
export { buildLadder, ladderGrid, routeReference, solveReference, MAX_RUNGS, MIN_RUNGS, QL_S } from './solver-reference.js';
export type { LadderRung, RouteReferenceResult, SolverReferenceResult, SolverSlotInput } from './solver-reference.js';
export { efficiencyLoss, solveOptimal } from './optimal.js';
export type { ContinuousVenue, OptimalSplitResult } from './optimal.js';
export {
  CU_ADMISSION_BUDGET,
  CU_BASE,
  CU_FAMILIES,
  CU_TRANSACTION_CAP,
  CU_TWO_HOP,
  defaultRungsFor,
  estimateRouteCu,
  estimateShapeCu,
  familyCuCoefficients,
  planLadders,
  planRouteLadders,
} from './budget.js';
export type { BudgetSlotInput, FamilyCuCoefficients, LadderPlan, RouteLadderPlan } from './budget.js';

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
  | 'orca-whirlpool'
  | 'raydium-clmm'
  | 'meteora-dlmm'
  | 'manifest'
  | 'meteora-damm-v2'
  | 'saber-stableswap'
  | 'meteora-damm-v1-stable'
  | 'obric-v2';

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
  'orca-whirlpool': {
    ladder: orcaWhirlpoolLadder,
    programId: orcaWhirlpool.programId,
    fetch: (load, pool) => orcaWhirlpool.fetchPoolConfig(load, pool),
    applyDirection: (cfg, direction) => {
      if (direction === undefined || direction === 'aToB') return cfg;
      if (direction === 'bToA') return { ...(cfg as OrcaWhirlpoolPoolConfig), direction: 'bToA' };
      throw new Error(`orca-whirlpool direction must be 'aToB' or 'bToA', got '${direction}'`);
    },
    gate: (cfg) => {
      // The fragment walks the prepare-shipped boundary window; readable == 0
      // (the array holding the live tick is missing or non-fixed) means no
      // boundaries and no edge were shippable — nothing to walk in-VM, the
      // pool is unquotable for this direction.
      const c = cfg as OrcaWhirlpoolPoolConfig;
      if (windowFor(c).readable === 0) {
        throw new Error(
          `orca-whirlpool pool ${c.pool} has no initialized fixed tick array covering the live tick for ${c.direction}`,
        );
      }
    },
  },
  'raydium-clmm': {
    ladder: raydiumClmmLadder,
    programId: raydiumClmm.programId,
    fetch: (load, pool) => raydiumClmm.fetchPoolConfig(load, pool),
    applyDirection: (cfg, direction) => {
      if (direction === undefined || direction === '0to1') return cfg;
      if (direction === '1to0') return { ...(cfg as RaydiumClmmPoolConfig), direction: '1to0' };
      throw new Error(`raydium-clmm direction must be '0to1' or '1to0', got '${direction}'`);
    },
    gate: (cfg) => {
      // Like whirlpool: no shipped boundaries + no edge for the direction means
      // nothing to walk in-VM (the live-tick array is missing or non-CLMM).
      const c = cfg as RaydiumClmmPoolConfig;
      if (raydiumClmmWindowFor(c).readable === 0) {
        throw new Error(
          `raydium-clmm pool ${c.pool} has no initialized tick array covering the live tick for ${c.direction}`,
        );
      }
    },
  },
  'meteora-dlmm': {
    ladder: meteoraDlmmLadder,
    programId: meteoraDlmm.programId,
    fetch: (load, pool) => meteoraDlmm.fetchPoolConfig(load, pool),
    applyDirection: (cfg, direction) => {
      if (direction === undefined || direction === 'xToY') return cfg;
      if (direction === 'yToX') return { ...(cfg as MeteoraDlmmPoolConfig), direction: 'yToX' };
      throw new Error(`meteora-dlmm direction must be 'xToY' or 'yToX', got '${direction}'`);
    },
    gate: (cfg) => {
      const c = cfg as MeteoraDlmmPoolConfig;
      if (meteoraDlmmWindowFor(c).bins.length === 0) {
        throw new Error(`meteora-dlmm pair ${c.pool} has no shippable liquid bins for ${c.direction}`);
      }
    },
  },
  manifest: {
    ladder: manifestLadder,
    programId: manifest.programId,
    fetch: (load, pool) => manifest.fetchPoolConfig(load, pool),
    applyDirection: (cfg, direction) => {
      if (direction === undefined || direction === 'baseIn') return cfg;
      if (direction === 'quoteIn') return { ...(cfg as ManifestPoolConfig), direction: 'quoteIn' };
      throw new Error(`manifest direction must be 'baseIn' or 'quoteIn', got '${direction}'`);
    },
    gate: (cfg) => {
      // The fragment walks the prepare-shipped order window; an empty side (no
      // resting orders, or the first order is global/expiring) is unquotable.
      const c = cfg as ManifestPoolConfig;
      if (manifestWindowFor(c).orders.length === 0) {
        throw new Error(`manifest market ${c.pool} has no shippable resting orders on the ${c.direction} side`);
      }
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
  'obric-v2': {
    ladder: obricV2Ladder,
    programId: obricV2.programId,
    fetch: (load, pool) => obricV2.fetchPoolConfig(load, pool),
    applyDirection: (cfg, direction) => {
      if (direction === undefined || direction === 'xToY') return cfg;
      if (direction === 'yToX') return { ...(cfg as ObricV2PoolConfig), direction: 'yToX' };
      throw new Error(`obric-v2 direction must be 'xToY' or 'yToX', got '${direction}'`);
    },
    // The CPI-acceptance gate (introspection / non-Pyth feed / drained bigK)
    // lives in fetchPoolConfig; the fragment reads the oracle + reserves live,
    // so no extra prepare gate is needed. A pool with empty inventory drops
    // out of the relative-depth filter (depth == 0).
  },
};

export interface EcoSwapSvmPoolSpec {
  venue: LadderVenueSlug;
  pool: Address;
  /**
   * exactIn side, per family: raydium-cp-swap '0to1' (default) | '1to0';
   * raydium-amm-v4 'coinToPc' (default) | 'pcToCoin'; pumpswap 'quoteToBase'
   * (default) | 'baseToQuote'; meteora-damm-v2 and orca-whirlpool 'aToB'
   * (default) | 'bToA'; raydium-clmm '0to1' (default) | '1to0'; meteora-dlmm 'xToY' (default, swap_for_y) | 'yToX'; manifest 'baseIn' (default, sell base) | 'quoteIn'
   * (buy base); saber-stableswap and meteora-damm-v1-stable only 'AtoB';
   * obric-v2 'xToY' (default, mintX in) | 'yToX'.
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
function effectiveLoader(config: {
  load?: AccountLoader;
  loadMany?: BatchAccountLoader;
  pools: readonly EcoSwapSvmPoolSpec[];
}): AccountLoader {
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

const droppedAs = (c: ResolvedCandidate, reason: EcoSwapSvmDroppedPool['reason']): EcoSwapSvmDroppedPool => ({
  pool: c.spec.pool,
  venue: c.spec.venue,
  depth: c.depth,
  reason,
});

/**
 * Fetch + gate every candidate (the v1 adapters' fetchPoolConfig — status
 * bits, transfer-fee mints, curve types — plus the family prepare gates),
 * snapshot the quote accounts, and apply the relative-depth filter over
 * L = isqrt(rIn·rOut) plus the structural slot cap. The CU budgeter runs
 * AFTER this (single-hop: resolveCandidates; route: planRouteLadders over both
 * legs' survivors) — so a route can reuse this per directed edge and share ONE
 * combined budget.
 */
async function filterCandidates(
  load: AccountLoader,
  pools: readonly EcoSwapSvmPoolSpec[],
  now: bigint,
  minRelBpsOpt: number | undefined,
  maxSlots: number = ECO_SVM_MAX_SLOTS,
): Promise<{ survivors: ResolvedCandidate[]; dropped: EcoSwapSvmDroppedPool[] }> {
  if (pools.length === 0) throw new Error('ecoSwapSvm needs at least one candidate pool');

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
      // An address is optional only if EVERY ref claiming it is optional
      // (whirlpool tick arrays beyond the readable window may not exist).
      const required = new Set(refs.filter((account) => account.optional !== true).map((account) => account.address!));
      const unique = [...new Set(refs.map((account) => account.address!))];
      const state: AccountBytesMap = {};
      await Promise.all(
        unique.map(async (address) => {
          const data = await load(address);
          if (data === null) {
            if (required.has(address)) {
              throw new Error(`ecoSwapSvm quote account ${address} of pool ${spec.pool} not found`);
            }
            return;
          }
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

  // Relative-depth filter (aliveness + minRelBps of ΣL), then the structural
  // cap — keep the deepest `maxSlots`, preserving caller preference order.
  const minRelBps = BigInt(minRelBpsOpt ?? ECO_SVM_MIN_REL_BPS);
  const totalDepth = candidates.reduce((sum, c) => sum + c.depth, 0n);
  let survivors = candidates.filter((c) => c.depth > 0n && c.depth * 10_000n >= minRelBps * totalDepth);
  const dropped = candidates.filter((c) => !survivors.includes(c)).map((c) => droppedAs(c, 'depth'));
  if (survivors.length > maxSlots) {
    const deepest = [...survivors]
      .sort((a, b) => (b.depth > a.depth ? 1 : b.depth < a.depth ? -1 : 0))
      .slice(0, maxSlots);
    dropped.push(...survivors.filter((c) => !deepest.includes(c)).map((c) => droppedAs(c, 'slots')));
    survivors = survivors.filter((c) => deepest.includes(c));
  }
  if (survivors.length === 0) {
    throw new Error('ecoSwapSvm: no pool survived the relative-depth filter (pass minRelBps: 0 to disable)');
  }

  return { survivors, dropped };
}

/** filterCandidates + the single-hop CU budgeter (rung fit + tail-slot drops). */
async function resolveCandidates(
  config: QuoteEcoSwapSvmConfig,
): Promise<{ survivors: ResolvedCandidate[]; dropped: EcoSwapSvmDroppedPool[]; plan: LadderPlan }> {
  requireU64('amountIn', config.amountIn, true);
  const load = effectiveLoader(config);
  const now = config.now ?? BigInt(Math.floor(Date.now() / 1000));
  const { survivors: filtered, dropped } = await filterCandidates(load, config.pools, now, config.minRelBps);

  const plan = planLadders(
    filtered.map((c) => ({ slug: c.spec.venue })),
    config.cuBudget,
  );
  dropped.push(...filtered.slice(plan.admitted).map((c) => droppedAs(c, 'budget')));

  return { survivors: filtered.slice(0, plan.admitted), dropped, plan };
}

const preparedSlot = (c: ResolvedCandidate, rungs: number): EcoSwapSvmPreparedSlot => ({
  venue: c.spec.venue,
  pool: c.spec.pool,
  params: c.params,
  depth: c.depth,
  rungs,
});

const solverInputsRungs = (survivors: readonly ResolvedCandidate[], rungs: readonly number[]): SolverSlotInput[] =>
  survivors.map((c, i) => ({
    quote: c.quote,
    ...(c.ladderQuotes !== undefined ? { ladderQuotes: c.ladderQuotes } : {}),
    rungs: rungs[i],
  }));

const solverInputs = (survivors: readonly ResolvedCandidate[], plan: LadderPlan): SolverSlotInput[] =>
  solverInputsRungs(survivors, plan.rungs);

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
 * A prepared address lookup table for one EcoSwapSVM universe (shape + pool
 * set + user). Returned by prepareAltForUniverse and handed to
 * executeEcoSwapSvm's `alt` option; reusable across every trade on that
 * universe, like the staged blob.
 */
export type EcoSwapSvmAlt = EnsuredLookupTable;

/** The 'auto' compute-unit-limit prepend the execute path adds beyond RequestHeapFrame — ~8 wire bytes. */
const AUTO_CU_PREPEND_BYTES = 8;

/**
 * The lookup-table address set for a staged trade: the buffer plus every
 * NON-SIGNER account in the resolved plan (venue pools/vaults/programs + the
 * user's token accounts), deduped. Signers (the owner / fee payer) MUST stay
 * static message accounts — they cannot be looked up. These keys are stable
 * across trades on a given (shape, pool set, user), so the ALT built over them
 * is reusable per universe like the staged blob.
 */
export function selectEcoSwapSvmAltAddresses(
  output: Pick<EcoSwapSvmOutput, 'accountPlan'>,
  staged: StagedBuffer | Address,
  resolution: AccountResolution,
  payerAddress: Address,
): Address[] {
  const buffer = typeof staged === 'string' ? staged : staged.address;
  const metas = resolveAccounts(output.accountPlan, resolution, payerAddress);
  return [...new Set<Address>([buffer, ...selectAltAddresses(metas)])];
}

export interface EcoSwapSvmPacketOptions {
  /**
   * Resolution + payer to ALSO model the ALT-compressed estimate (the plan's
   * non-signer metas move to the table). Without them only `raw` is returned.
   */
  resolution?: AccountResolution;
  payerAddress?: Address;
  /** Prepend bytes beyond RequestHeapFrame (the 'auto' CU-limit prepend ≈ 8). Default 8. */
  prependBytes?: number;
}

export interface EcoSwapSvmPacketBudget {
  /** Raw (no-ALT) staged v0 packet estimate — check `raw.overflowBytes > 0`. */
  raw: PacketBudget;
  /** ALT-compressed estimate (only when resolution + payerAddress are given). */
  withAlt?: PacketBudget;
}

/**
 * Models the staged execute_from_account v0 packet for a compiled shape (the
 * compiler's estimatePacket over the shape's argsLayout byte length). With a
 * resolution + payer it also models the ALT-compressed packet, moving the
 * non-signer metas to one lookup table. This estimate counts plan METAS (not
 * deduped addresses), so it is CONSERVATIVE — the real message dedups repeated
 * addresses (shared token/venue programs, mints), so a shape it flags near the
 * limit may still fit raw; building an ALT is always safe. The account-LOCK
 * count is invariant to the ALT (locks = static keys + resolved addresses):
 * the table shrinks BYTES, never the 64-lock cap.
 */
export function ecoSwapSvmPacketBudget(
  output: Pick<EcoSwapSvmOutput, 'accountPlan' | 'bytecode' | 'argsLayout'>,
  opts: EcoSwapSvmPacketOptions = {},
): EcoSwapSvmPacketBudget {
  const argsBytes = output.argsLayout.byteLength;
  const prependBytes = opts.prependBytes ?? AUTO_CU_PREPEND_BYTES;
  const raw = estimatePacket(output.accountPlan, output.bytecode.length, { mode: 'staged', argsBytes, prependBytes });
  if (opts.resolution === undefined || opts.payerAddress === undefined) return { raw };

  const metas = resolveAccounts(output.accountPlan, opts.resolution, opts.payerAddress);
  const lookupAddresses = metas.filter((meta) => !isSignerRole(meta.role)).length;
  const withAlt =
    lookupAddresses === 0
      ? raw
      : estimatePacket(output.accountPlan, output.bytecode.length, {
          mode: 'staged',
          argsBytes,
          prependBytes,
          lookupTables: 1,
          lookupAddresses,
        });
  return { raw, withAlt };
}

export interface PrepareAltOptions {
  /**
   * Reuse and EXTEND this table (idempotent) instead of creating a fresh one —
   * only the addresses it does not already hold are appended. Pass the
   * lookupTableAddress a previous prepareAltForUniverse returned to grow one
   * table across universes that share a payer.
   */
  existingTable?: Address;
  commitment?: Commitment;
}

/**
 * Idempotent create-(or-extend)-and-warm-up of the lookup table for a staged
 * EcoSwapSVM universe. Selects the buffer + non-signer plan accounts
 * (selectEcoSwapSvmAltAddresses), builds/extends the table through the client
 * (waiting for it to activate), and returns it in the shape executeEcoSwapSvm's
 * `alt` option consumes. Call it ONCE per universe and reuse the result across
 * every trade — the account set is as stable as the staged blob. Only worth
 * doing when the raw packet would overflow (ecoSwapSvmPacketBudget); a
 * within-budget shape needs no ALT.
 */
export async function prepareAltForUniverse(
  client: SauceSvmClient,
  staged: StagedBuffer | Address,
  output: Pick<EcoSwapSvmOutput, 'accountPlan'>,
  resolution: AccountResolution,
  opts: PrepareAltOptions = {},
): Promise<EcoSwapSvmAlt> {
  const addresses = selectEcoSwapSvmAltAddresses(output, staged, resolution, client.payerAddress);
  return client.ensureLookupTable(addresses, { existing: opts.existingTable, commitment: opts.commitment });
}

export interface ExecuteEcoSwapSvmOpts {
  /**
   * A prepared lookup table (prepareAltForUniverse) — the execute goes out as a
   * v0 transaction compressed against it, shrinking the packet below the
   * 1,232-byte limit for shapes whose account list would otherwise overflow.
   * Absent = a plain v0 transaction (the account keys ride the message inline).
   * The staged blob, hash pin and payload-args path are identical either way;
   * only the transaction assembly changes.
   */
  alt?: EcoSwapSvmAlt;
}

/**
 * One trade = ONE execute_from_account instruction: the staged blob,
 * hash-pinned, with this trade's cfg bytes as payload args. `resolution`
 * binds the user refs (outAta/inAta/owner — plus, for pumpswap buy slots,
 * the caller-derived user volume accumulator PDA); adapter-resolved refs are
 * already stamped on the plan. Pass `opts.alt` (from prepareAltForUniverse) to
 * send the transaction compressed against an address lookup table when the raw
 * account list would overflow the 1,232-byte packet — RequestHeapFrame stays
 * add-once and signerless simulate is unaffected (the ALT only reshapes the
 * account KEYS section, never the signer set or the 64-lock cap).
 */
export async function executeEcoSwapSvm(
  client: SauceSvmClient,
  staged: StagedBuffer | Address,
  output: EcoSwapSvmOutput,
  resolution: AccountResolution,
  trade?: { amountIn: bigint; minOut: bigint },
  opts: ExecuteEcoSwapSvmOpts = {},
): Promise<SendExecuteResult> {
  const values = trade === undefined ? output.argValues : output.encodeTrade(trade.amountIn, trade.minOut);
  return client.executeStaged(staged, output.accountPlan, resolution, {
    args: { layout: output.argsLayout, values },
    computeUnitLimit: 'auto',
    ...(opts.alt !== undefined ? { lookupTables: opts.alt.lookupTables } : {}),
    ...(typeof staged === 'string' ? { expectedSha256: output.sha256 } : {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 2-hop routes (A → X → B): a composite venue solved as its own instruction.
// A route is EITHER the direct-venue merge above OR one 2-hop route — not both
// in one instruction (Phase 3b: standalone-route-first; direct+route mixing is
// the documented Phase 3c follow-up, deferred on CU + merge-integration
// grounds). To pick the better of the two off-chain, quote BOTH quoteEcoSwapSvm
// and quoteRouteEcoSwapSvm and stage whichever `totalOut`/`totalPredicted`
// wins — a pure off-chain selection, one shape staged.
// ─────────────────────────────────────────────────────────────────────────

export interface QuoteRouteEcoSwapSvmConfig {
  amountIn: bigint;
  /** leg-0 candidate pools (A → X), preference order — 1..MAX_LEG_SLOTS after filtering. */
  leg0Pools: EcoSwapSvmPoolSpec[];
  /** leg-1 candidate pools (X → B), preference order. */
  leg1Pools: EcoSwapSvmPoolSpec[];
  /** Single-account source (fixtures / custom RPC binding). One of load/loadMany is required. */
  load?: AccountLoader;
  /** Batched source (e.g. kitBatchAccountLoader(rpc)) — the prepare coalesces into getMultipleAccounts sweeps. */
  loadMany?: BatchAccountLoader;
  /** Relative-depth floor in bps of ΣL, applied PER LEG (default 100 = 1%; 0 disables). */
  minRelBps?: number;
  /** Combined-route CU admission budget (default CU_ADMISSION_BUDGET); raising it forces heavier routes. */
  cuBudget?: number;
  /** Unix seconds the time-dependent reference quotes evaluate at (default wall clock). */
  now?: bigint;
  /** Intermediate-token (X) ATA ref, resolved by the caller (default 'user:inter'). */
  interRef?: string;
}

export interface RouteEcoSwapSvmConfig extends QuoteRouteEcoSwapSvmConfig {
  /** Minimum realized outAta (B) delta, inclusive — enforced pre-CPI on the leg-1 prediction and post-CPI on the delta. */
  minOut: bigint;
  /** User-side account refs (inAta = token A, outAta = token B, owner). */
  user: SwapUser;
}

export interface EcoSwapSvmRouteQuote extends RouteReferenceResult {
  /** Post-filter leg-0 slot assignment (slots back leg0.slices in order). */
  leg0Slots: EcoSwapSvmPreparedSlot[];
  /** Post-filter leg-1 slot assignment. */
  leg1Slots: EcoSwapSvmPreparedSlot[];
  /** Pools dropped by the per-leg depth filter / slot cap / route CU budget. */
  dropped: EcoSwapSvmDroppedPool[];
  /** Modeled route CU of the admitted shape (the codegen GasLeft floor). */
  estimatedCu: number;
  /** Budgeter degradations/drops, packet-budgeter style. */
  warnings: string[];
}

export interface EcoSwapSvmRouteOutput extends GeneratedEcoSwapSvmRoute {
  /** sha256 of the staged blob — the execute pin. */
  sha256: Uint8Array;
  /** The intermediate-token ATA ref this blob's leg-0 out / leg-1 in resolve to. */
  interRef: string;
  /** Post-filter leg-0 prepared slots, in blob order. */
  leg0Slots: EcoSwapSvmPreparedSlot[];
  /** Post-filter leg-1 prepared slots. */
  leg1Slots: EcoSwapSvmPreparedSlot[];
  /** Flat prepared slots (leg-0, then leg-1) — the cfg / returndata order. */
  slots: EcoSwapSvmPreparedSlot[];
  /** Encoded cfg arg for THIS trade; re-encode via encodeTrade for others. */
  argValues: [`0x${string}`];
  /** Composed route reference over the fetch-time bytes (the user-facing quote). */
  quote: EcoSwapSvmRouteQuote;
  /** Re-encodes the cfg arg for a new trade on the SAME staged route blob. */
  encodeTrade: (amountIn: bigint, minOut: bigint) => [`0x${string}`];
}

/**
 * Per-leg filter (fetch + gate + relative-depth + slot cap) under ONE combined
 * loader, then the leg-aware route budgeter (planRouteLadders: degrade rungs
 * across both legs, drop only tail slots, never empty a leg). Discovers each
 * leg's pool SET for the directed edge the caller supplies — leg-0 pools trade
 * A → X, leg-1 pools trade X → B.
 */
async function resolveRouteCandidates(config: QuoteRouteEcoSwapSvmConfig): Promise<{
  leg0: ResolvedCandidate[];
  leg1: ResolvedCandidate[];
  dropped: EcoSwapSvmDroppedPool[];
  plan: RouteLadderPlan;
}> {
  requireU64('amountIn', config.amountIn, true);
  if (config.leg0Pools.length === 0 || config.leg1Pools.length === 0) {
    throw new Error('ecoSwapSvm route needs at least one candidate pool per leg');
  }
  const load = effectiveLoader({
    load: config.load,
    loadMany: config.loadMany,
    pools: [...config.leg0Pools, ...config.leg1Pools],
  });
  const now = config.now ?? BigInt(Math.floor(Date.now() / 1000));

  // MAX_LEG_SLOTS is the per-leg structural cap (route.ts); the combined route
  // budgeter (planRouteLadders) then fixes rungs and may drop tail slots.
  const f0 = await filterCandidates(load, config.leg0Pools, now, config.minRelBps, 3);
  const f1 = await filterCandidates(load, config.leg1Pools, now, config.minRelBps, 3);

  const plan = planRouteLadders(
    f0.survivors.map((c) => ({ slug: c.spec.venue })),
    f1.survivors.map((c) => ({ slug: c.spec.venue })),
    config.cuBudget,
  );
  const leg0 = f0.survivors.slice(0, plan.leg0Admitted);
  const leg1 = f1.survivors.slice(0, plan.leg1Admitted);
  const dropped = [
    ...f0.dropped,
    ...f0.survivors.slice(plan.leg0Admitted).map((c) => droppedAs(c, 'budget')),
    ...f1.dropped,
    ...f1.survivors.slice(plan.leg1Admitted).map((c) => droppedAs(c, 'budget')),
  ];
  return { leg0, leg1, dropped, plan };
}

/**
 * The user-facing ROUTE quote: fetch both legs' candidate bytes once through
 * the loader, run the composed lamport-exact mirror (routeReference) — zero
 * simulation. `intermediate` == the on-chain realizedX, `totalOut` == realizedB
 * (absent drift). Lamport-identical to what the staged route blob computes on
 * the same bytes.
 */
export async function quoteRouteEcoSwapSvm(config: QuoteRouteEcoSwapSvmConfig): Promise<EcoSwapSvmRouteQuote> {
  const { leg0, leg1, dropped, plan } = await resolveRouteCandidates(config);
  const ref = routeReference(
    solverInputsRungs(leg0, plan.leg0Rungs),
    solverInputsRungs(leg1, plan.leg1Rungs),
    config.amountIn,
  );
  return {
    ...ref,
    leg0Slots: leg0.map((c, i) => preparedSlot(c, plan.leg0Rungs[i])),
    leg1Slots: leg1.map((c, i) => preparedSlot(c, plan.leg1Rungs[i])),
    dropped,
    estimatedCu: plan.estimatedCu,
    warnings: plan.warnings,
  };
}

/**
 * Prepare + compile a 2-hop route: per-leg candidate gates → per-leg depth
 * filter → route CU budgeter → leg slot assignment → route codegen (the
 * compute-exec-compute-exec solver) → staged compile. The blob serves ANY pool
 * set matching its route shapeKey; per-trade values ride the payload args, pool
 * accounts (both legs) + the intermediate ATA rebind through the resolution map.
 */
export async function routeEcoSwapSvm(config: RouteEcoSwapSvmConfig): Promise<EcoSwapSvmRouteOutput> {
  requireU64('minOut', config.minOut, false);
  const interRef = config.interRef ?? DEFAULT_INTER_REF;
  const { leg0, leg1, dropped, plan } = await resolveRouteCandidates(config);

  const asSlots = (survivors: ResolvedCandidate[], rungs: number[]): EcoSwapSvmSlot[] =>
    survivors.map((c, i) => ({ adapter: c.entry.ladder, cfg: c.cfg, rungs: rungs[i], swapOverride: c.spec.swapOverride }));
  const generated = generateEcoSwapSvmRoute({
    leg0: asSlots(leg0, plan.leg0Rungs),
    leg1: asSlots(leg1, plan.leg1Rungs),
    user: config.user,
    interRef,
    cuFloor: plan.estimatedCu,
  });

  const tradeSlots = [...leg0, ...leg1].map((c) => ({ params: c.params }));
  const encodeTrade = (amountIn: bigint, minOut: bigint): [`0x${string}`] => {
    requireU64('amountIn', amountIn, true);
    requireU64('minOut', minOut, false);
    return [encodeEcoSwapSvmTrade(tradeSlots, amountIn, minOut)];
  };

  const ref = routeReference(
    solverInputsRungs(leg0, plan.leg0Rungs),
    solverInputsRungs(leg1, plan.leg1Rungs),
    config.amountIn,
  );
  const preparedLeg0 = leg0.map((c, i) => preparedSlot(c, plan.leg0Rungs[i]));
  const preparedLeg1 = leg1.map((c, i) => preparedSlot(c, plan.leg1Rungs[i]));

  return {
    ...generated,
    warnings: [...generated.warnings, ...plan.warnings],
    sha256: new Uint8Array(createHash('sha256').update(generated.bytecode).digest()),
    interRef,
    leg0Slots: preparedLeg0,
    leg1Slots: preparedLeg1,
    slots: [...preparedLeg0, ...preparedLeg1],
    argValues: encodeTrade(config.amountIn, config.minOut),
    quote: {
      ...ref,
      leg0Slots: preparedLeg0,
      leg1Slots: preparedLeg1,
      dropped,
      estimatedCu: plan.estimatedCu,
      warnings: plan.warnings,
    },
    encodeTrade,
  };
}

/** Stage a route blob once (init → chunked writes → sha256-gated finalize). */
export async function stageRouteEcoSwapSvm(
  client: SauceSvmClient,
  index: number,
  output: Pick<EcoSwapSvmRouteOutput, 'bytecode'>,
): Promise<StagedBuffer> {
  return client.stageBuffer(index, output.bytecode);
}

/**
 * Idempotent create of the intermediate-token (X) ATA for `owner` — the sole
 * intermediate custody (the engine never signs). Prepend it beside the
 * heap-frame + CU-limit prepends on the route execute, exactly like the
 * wSOL-wrap prepend, and resolve the blob's `interRef` to the returned `ata`.
 */
export async function buildRouteInterAtaPrepend(input: {
  payer: TransactionSigner;
  owner: Address;
  mint: Address;
  tokenProgram?: Address;
}): Promise<{ ata: Address; instruction: Instruction }> {
  return buildAtaPrepend(input);
}

export interface ExecuteRouteEcoSwapSvmOpts extends ExecuteEcoSwapSvmOpts {
  /**
   * Extra prepends (add-once, beside the client's heap-frame + CU-limit) — the
   * idempotent intermediate-ATA create belongs here (buildRouteInterAtaPrepend).
   */
  prepends?: readonly Instruction[];
}

/**
 * One route trade = ONE execute_from_account instruction: the staged route
 * blob, hash-pinned, with this trade's cfg bytes as payload args. `resolution`
 * binds the user refs (inAta = A, outAta = B, owner, and the interRef = the
 * intermediate ATA). Pass `opts.alt` (routes ~double the account list — an ALT
 * is effectively mandatory) and `opts.prepends` (the intermediate-ATA create).
 */
export async function executeRouteEcoSwapSvm(
  client: SauceSvmClient,
  staged: StagedBuffer | Address,
  output: EcoSwapSvmRouteOutput,
  resolution: AccountResolution,
  trade?: { amountIn: bigint; minOut: bigint },
  opts: ExecuteRouteEcoSwapSvmOpts = {},
): Promise<SendExecuteResult> {
  const values = trade === undefined ? output.argValues : output.encodeTrade(trade.amountIn, trade.minOut);
  return client.executeStaged(staged, output.accountPlan, resolution, {
    args: { layout: output.argsLayout, values },
    computeUnitLimit: 'auto',
    ...(opts.prepends !== undefined ? { prepends: opts.prepends } : {}),
    ...(opts.alt !== undefined ? { lookupTables: opts.alt.lookupTables } : {}),
    ...(typeof staged === 'string' ? { expectedSha256: output.sha256 } : {}),
  });
}
