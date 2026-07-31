/**
 * Stabble Stable Swap adapter v2 (EcoSwapSVM ladder fragment).
 *
 * COLD, not warm-started: unlike saber-stableswap/meteora-damm-v1-stable
 * (2-coin Curve-style, `stableD`/`stableYW` shared helpers threading a warm
 * y-cursor across rungs), Stabble's own invariant math is a DIFFERENT,
 * N-token Balancer-style Newton (see ../stabble-common.ts's module doc for
 * the citation trail and the bit-exact verification against
 * `stable_math.rs`'s own `#[test]` vectors) that folds ALL N balances into a
 * running product every D-Newton round — reusing this repo's existing
 * `stableD`/`stableYW` 2-coin helpers would silently compute the WRONG
 * curve (a different AMP_PRECISION convention and a different N=2-only
 * recursion), not merely a slower one, so this family gets its own,
 * N-generic helper (`stableQuoteHelperSource`) instead. Every rung and the
 * final quote call it FRESH (no cross-rung y-cursor): default 2 rungs (see
 * `defaultRungs` below) makes the CU delta small, and skipping warm-start
 * removes an entire class of "did I resume the right root" bugs for a
 * brand-new N-token Newton recursion under real time pressure. If the
 * measured CU (see recipes/ecoswap/svm/budget.ts's CU_FAMILIES entry) ever
 * pushes this family out of budget, warm-starting `stableGetBalanceGiven
 * Invariant`'s y-Newton (same trick as `stableYW`) is the next lever, not a
 * rewrite of the invariant math itself.
 *
 * No capacity cap: unlike Stabble's WEIGHTED sibling (a real, on-chain
 * MAX_IN_RATIO = 30%-of-balance hard cap — `calc_out_given_in` returns
 * `None`, i.e. panics the instruction, past it), the N-token StableMath
 * Newton has no such explicit bound; an oversized input still converges to
 * a valid (near-zero-output) quote. So this family uses the plain
 * `emitQuoteCall` (CP-style expression) contract, not the capacity-aware
 * statement form (`emitLadderQuote`/`capacityInputVar`) meteora-damm-v1-
 * stable needs.
 *
 * SCOPE: AtoB only (tokens[0] -> tokens[1]) — see stabble-stable-swap's
 * (index.ts) module doc for why, and what a future PR would need to widen
 * it to arbitrary N-token pairs.
 */
import type { Address } from '@solana/kit';
import { readUintLE } from '../math.js';
import {
  calcUnwrappedAmount,
  calcWrappedAmount,
  complement,
  mulDown,
  STABBLE_SWAP_DISCRIMINATOR,
  STABBLE_TOKEN_PROGRAM_ID,
  STABBLE_VAULT_PROGRAM_ID,
  stableCalcInvariantN,
  stableCalcOutGivenIn,
  stableGetAmplification,
  stableQuoteHelperSource,
} from '../stabble-common.js';
import type {
  AccountBytesMap,
  LadderSwapTemplate,
  PoolConfig,
  SvmVenueLadderV2,
  SwapUser,
  VenueAccount,
} from '../types.js';
import { stabbleStableSwap } from './index.js';
import type { StabbleStableSwapPoolConfig } from './index.js';

const SLUG = 'stabble-stable-swap';

const AMP_INITIAL_OFFSET = 106;
const AMP_TARGET_OFFSET = 108;
const RAMP_START_OFFSET = 110;
const RAMP_STOP_OFFSET = 118;
const SWAP_FEE_OFFSET = 126;
const TOKENS_OFFSET = 134;
const TOKEN_SIZE = 50;
const BAL_SUB_OFFSET = 42;

function stableCfg(base: PoolConfig): StabbleStableSwapPoolConfig {
  if (base.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${base.venue}' pool config`);
  return base as StabbleStableSwapPoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

function balanceOffset(index: number): number {
  return TOKENS_OFFSET + 4 + index * TOKEN_SIZE + BAL_SUB_OFFSET;
}

export const stabbleStableSwapLadder = {
  slug: SLUG,

  /** 2-rung default (stable-kind pools budget for a heavier per-rung Newton) — see recipes/ecoswap/svm/budget.ts. */
  defaultRungs: 2,

  shapeKey(base: PoolConfig): string {
    const cfg = stableCfg(base);
    return `${SLUG}:n${cfg.tokens.length}:AtoB`;
  },

  helpers(base: PoolConfig): { name: string; source: string }[] {
    const cfg = stableCfg(base);
    return [stableQuoteHelperSource(cfg.tokens.length)];
  },

  paramCount: 0,
  paramsFor(): bigint[] {
    return [];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const cfg = stableCfg(base);
    return [{ ref: ref(slot, 'pool'), address: cfg.pool }];
  },

  emitSetup(base: PoolConfig, slot: number, _params: readonly string[], enableVar?: string): string {
    void enableVar;
    const cfg = stableCfg(base);
    const pool = JSON.stringify(ref(slot, 'pool'));
    const lines: string[] = [`  let s${slot}amp = ${cfg.ampTargetFactor * 1000};`];
    const range = cfg.rampStopTs - cfg.rampStartTs;
    if (cfg.rampStopTs !== 0n && range > 0n && cfg.ampInitialFactor !== cfg.ampTargetFactor) {
      const targetUp = cfg.ampTargetFactor >= cfg.ampInitialFactor;
      const lo = targetUp ? cfg.ampInitialFactor : cfg.ampTargetFactor;
      const hi = targetUp ? cfg.ampTargetFactor : cfg.ampInitialFactor;
      const interp = targetUp
        ? `${cfg.ampInitialFactor * 1000} + Math.mulDiv(${(hi - lo) * 1000}, ((block.timestamp - ${cfg.rampStartTs}) / 60) * 60, ${range})`
        : `${cfg.ampInitialFactor * 1000} - Math.mulDiv(${(hi - lo) * 1000}, ((block.timestamp - ${cfg.rampStartTs}) / 60) * 60, ${range})`;
      lines.push(`  if (block.timestamp <= ${cfg.rampStartTs}) { s${slot}amp = ${cfg.ampInitialFactor * 1000} }`);
      lines.push(`  else if (block.timestamp < ${cfg.rampStopTs}) { s${slot}amp = ${interp} }`);
    }
    for (let i = 0; i < cfg.tokens.length; i++) {
      lines.push(`  const s${slot}bal${i} = accountUint(${pool}, ${balanceOffset(i)}, 8);`);
    }
    lines.push(`  const s${slot}fee = accountUint(${pool}, ${SWAP_FEE_OFFSET}, 8);`);
    return lines.join('\n');
  },

  emitQuoteCall(base: PoolConfig, slot: number, x: string): string {
    const cfg = stableCfg(base);
    const tokenIn = cfg.tokens[0];
    const tokenOut = cfg.tokens[1];
    const helper = stableQuoteHelperSource(cfg.tokens.length);
    const wrappedX =
      tokenIn.scalingFactor === 1n
        ? x
        : tokenIn.scalingUp
          ? `(${x}) * ${tokenIn.scalingFactor}`
          : `(${x}) / ${tokenIn.scalingFactor}`;
    const balArgs = Array.from({ length: cfg.tokens.length }, (_, i) => `s${slot}bal${i}`).join(', ');
    const rawExpr = `${helper.name}(s${slot}amp, ${balArgs}, ${wrappedX})`;
    const netExpr = `Math.mulDiv(${rawExpr}, 1000000000 - s${slot}fee, 1000000000)`;
    return tokenOut.scalingFactor === 1n
      ? netExpr
      : tokenOut.scalingUp
        ? `((${netExpr}) / ${tokenOut.scalingFactor})`
        : `((${netExpr}) * ${tokenOut.scalingFactor})`;
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const cfg = stableCfg(base);
    const tokenIn = cfg.tokens[0];
    const tokenOut = cfg.tokens[1];
    const roled = (role: string, addr: Address): VenueAccount => ({ ref: ref(slot, role), address: addr });
    return {
      programId: stabbleStableSwap.programId,
      // disc(8) | Option<u64> tag=1 | <patched u64 LE amount_in> | minimum_out u64 LE = 1.
      prefix: Uint8Array.from([...STABBLE_SWAP_DISCRIMINATOR, 1]),
      suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
      patch: 'in',
      accounts: [
        { ref: user.owner, signer: true },
        { ref: user.inAta, writable: true },
        { ref: user.outAta, writable: true },
        { ...roled('vtin', tokenIn.vaultTokenAccount), writable: true },
        { ...roled('vtout', tokenOut.vaultTokenAccount), writable: true },
        { ...roled('benout', cfg.beneficiaryTokenOut), writable: true },
        { ...roled('pool', cfg.pool), writable: true },
        roled('wauth', cfg.withdrawAuthority),
        roled('vault', cfg.vault),
        roled('vauth', cfg.vaultAuthority),
        roled('vprog', STABBLE_VAULT_PROGRAM_ID),
        roled('tprog', STABBLE_TOKEN_PROGRAM_ID),
      ],
    };
  },

  referenceQuote(base: PoolConfig, state: AccountBytesMap, _params: readonly bigint[], now?: bigint): (x: bigint) => bigint {
    const cfg = stableCfg(base);
    const poolData = state[cfg.pool];
    if (poolData === undefined) throw new Error(`${SLUG} ladder reference is missing pool ${cfg.pool}`);
    const balances = cfg.tokens.map((_, i) => readUintLE(poolData, balanceOffset(i), 8));
    const swapFee = readUintLE(poolData, SWAP_FEE_OFFSET, 8);
    const t = now ?? BigInt(Math.floor(Date.now() / 1000));
    const amp = stableGetAmplification(cfg.ampInitialFactor, cfg.ampTargetFactor, cfg.rampStartTs, cfg.rampStopTs, t);
    const invariant = stableCalcInvariantN(amp, balances);
    const [tokenIn, tokenOut] = cfg.tokens;
    return (x: bigint): bigint => {
      if (x <= 0n) return 0n;
      const wrappedX = calcWrappedAmount(x, tokenIn);
      const rawOut = stableCalcOutGivenIn(amp, balances, 0, 1, wrappedX, invariant);
      const netOut = mulDown(rawOut, complement(swapFee));
      return calcUnwrappedAmount(netOut, tokenOut);
    };
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const cfg = stableCfg(base);
    const poolData = state[cfg.pool];
    if (poolData === undefined) throw new Error(`${SLUG} ladder reference is missing pool ${cfg.pool}`);
    const reserveInWrapped = readUintLE(poolData, balanceOffset(0), 8);
    const reserveOutWrapped = readUintLE(poolData, balanceOffset(1), 8);
    return {
      reserveIn: calcUnwrappedAmount(reserveInWrapped, cfg.tokens[0]),
      reserveOut: calcUnwrappedAmount(reserveOutWrapped, cfg.tokens[1]),
    };
  },

  continuousFees(base: PoolConfig, state: AccountBytesMap): { gammaPpm: bigint; muPpm: bigint } {
    const cfg = stableCfg(base);
    const poolData = state[cfg.pool];
    if (poolData === undefined) throw new Error(`${SLUG} ladder fees are missing pool ${cfg.pool}`);
    const swapFee = readUintLE(poolData, SWAP_FEE_OFFSET, 8);
    // swap_fee is ONE(1e9)-scaled; convert to ppm (1e6-scaled) retention. The
    // CP form badly understates a stable curve's depth — measurement oracle
    // only, never a gate (same caveat as every other stable-kind family).
    return { gammaPpm: 1_000_000n - swapFee / 1_000n, muPpm: 1_000_000n };
  },
} satisfies SvmVenueLadderV2;
