/**
 * Stabble Weighted Swap adapter v2 (SvmRoute ladder fragment).
 *
 * CAPACITY-AWARE: `weightedCalcOutGivenIn`'s real, on-chain MAX_IN_RATIO
 * (30%-of-balance) hard cap means an oversized rung must be CLAMPED to the
 * cap's cumulative input rather than allowed to imply "more input, same
 * (nonexistent) output" — the exact "coarse ladder gets allocated ZERO by
 * the merge" hazard this repo's other capacity-aware families
 * (orca-whirlpool/raydium-clmm/meteora-dlmm/manifest/meteora-damm-v1-stable)
 * already guard against via `capacityInputVar`/`referenceCapacities`. Unlike
 * meteora-damm-v1-stable's idle-float bound (needing an inverse-Newton
 * derivation because the bound sits behind a vault-share transform), THIS
 * cap is already a closed-form linear function of the LIVE balance
 * (`xcap = mulDown(balanceIn, MAX_IN_RATIO)`), so no analytic inversion is
 * needed — one `Math.mulDiv`, done once in `emitSetup`, latched permanently
 * once a rung's own grid point first exceeds it (rungs are non-decreasing
 * cumulative inputs, so nothing later can ever do better). emitLadderQuote/
 * emitFinalQuote/referenceQuote all clamp `wrapped` to `xcap` before
 * computing the output, so they saturate correctly by construction;
 * referenceCapacities' OWN latch used to freeze `lx` at whatever smaller
 * grid point last succeeded instead of bumping up to xcap's unwrapped
 * equivalent -- see its doc for the fix.
 *
 * The fractional-exponent `pow` itself is NOT bit-exact to the real
 * program's own `fixed_exp`-crate powf (see ../stabble-common.ts's
 * `weightedPowUp` doc for the conservative-approximation proof and its
 * measured accuracy at realistic trade sizes) — this is a disclosed,
 * measured property of the approximation, not an unexamined gap.
 *
 * SCOPE: AtoB only (tokens[0] -> tokens[1]) — see the stable-swap sibling's
 * module doc.
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
  WEIGHTED_MAX_IN_RATIO,
  weightedCalcOutGivenIn,
  weightedCoreQuoteLines,
} from '../stabble-common.js';
import type {
  AccountBytesMap,
  LadderSwapTemplate,
  PoolConfig,
  SvmVenueLadder,
  SwapUser,
  VenueAccount,
} from '../types.js';
import { stabbleWeightedSwap } from './index.js';
import type { StabbleWeightedSwapPoolConfig } from './index.js';

const SLUG = 'stabble-weighted-swap';
const SWAP_FEE_OFFSET = 114;
const TOKENS_OFFSET = 122;
const TOKEN_SIZE = 58;
const BAL_SUB_OFFSET = 42;

function weightedCfg(base: PoolConfig): StabbleWeightedSwapPoolConfig {
  if (base.venue !== SLUG) throw new Error(`${SLUG} ladder adapter got a '${base.venue}' pool config`);
  return base as StabbleWeightedSwapPoolConfig;
}

const ref = (slot: number, role: string): string => `s${slot}:${role}`;

function balanceOffset(index: number): number {
  return TOKENS_OFFSET + 4 + index * TOKEN_SIZE + BAL_SUB_OFFSET;
}

export const stabbleWeightedSwapLadder = {
  slug: SLUG,

  shapeKey(base: PoolConfig): string {
    const cfg = weightedCfg(base);
    return `${SLUG}:AtoB:wi${cfg.tokens[0].weight}:wo${cfg.tokens[1].weight}`;
  },

  helpers(): { name: string; source: string }[] {
    return []; // the pow schedule is unrolled per-slot (shape-keyed on the weight pair) — no shared named function
  },

  paramCount: 0,
  paramsFor(): bigint[] {
    return [];
  },

  quoteRefs(base: PoolConfig, slot: number): VenueAccount[] {
    const cfg = weightedCfg(base);
    return [{ ref: ref(slot, 'pool'), address: cfg.pool }];
  },

  emitSetup(base: PoolConfig, slot: number, _params: readonly string[], enableVar?: string): string {
    void enableVar;
    const cfg = weightedCfg(base);
    const pool = JSON.stringify(ref(slot, 'pool'));
    return [
      `  const s${slot}bal0 = accountUint(${pool}, ${balanceOffset(0)}, 8);`,
      `  const s${slot}bal1 = accountUint(${pool}, ${balanceOffset(1)}, 8);`,
      `  const s${slot}fee = accountUint(${pool}, ${SWAP_FEE_OFFSET}, 8);`,
      `  const s${slot}xcap = Math.mulDiv(s${slot}bal0, ${WEIGHTED_MAX_IN_RATIO}, 1000000000);`,
      `  let s${slot}cap = 0;`,
      `  let s${slot}lo = 0;`,
      `  let s${slot}lx = 0;`,
    ].join('\n');
  },

  /** Wraps + clamps `x` to the (live) MAX_IN_RATIO cap, latching permanently once exceeded, then evaluates the core weighted quote + swap fee. */
  emitLadderQuote(base: PoolConfig, slot: number, rung: number, x: string, outVar: string): string {
    const cfg = weightedCfg(base);
    const tokenIn = cfg.tokens[0];
    const tokenOut = cfg.tokens[1];
    const tag = `s${slot}r${rung}`;
    const wrappedExpr =
      tokenIn.scalingFactor === 1n
        ? x
        : tokenIn.scalingUp
          ? `(${x}) * ${tokenIn.scalingFactor}`
          : `(${x}) / ${tokenIn.scalingFactor}`;
    const lines: string[] = [
      `    if (s${slot}cap === 0) {`,
      `      let ${tag}w = ${wrappedExpr};`,
      `      if (${tag}w > s${slot}xcap) { ${tag}w = s${slot}xcap; s${slot}cap = 1 }`,
    ];
    const core = weightedCoreQuoteLines(`${tag}_`, `s${slot}bal0`, `s${slot}bal1`, tokenIn.weight, tokenOut.weight, `${tag}w`, `${tag}raw`);
    lines.push(...core.map((l) => `      ${l}`));
    lines.push(`      if (${tag}raw > 0) {`);
    lines.push(`        const ${tag}net = Math.mulDiv(${tag}raw, 1000000000 - s${slot}fee, 1000000000);`);
    const unwrapExpr =
      tokenOut.scalingFactor === 1n
        ? `${tag}net`
        : tokenOut.scalingUp
          ? `${tag}net / ${tokenOut.scalingFactor}`
          : `${tag}net * ${tokenOut.scalingFactor}`;
    lines.push(`        s${slot}lo = ${unwrapExpr};`);
    lines.push(`        s${slot}lx = ${x};`);
    lines.push(`      }`);
    lines.push(`    }`);
    lines.push(`    const ${outVar} = s${slot}lo;`);
    return lines.join('\n');
  },

  capacityInputVar(slot: number): string {
    return `s${slot}lx`;
  },

  /** Cold final quote: cache-hit when x lands exactly on the ladder's last checkpoint, else a fresh (clamped) recompute — never a stale value. */
  emitFinalQuote(base: PoolConfig, slot: number, x: string, outVar: string): string {
    const cfg = weightedCfg(base);
    const tokenIn = cfg.tokens[0];
    const tokenOut = cfg.tokens[1];
    const tag = `s${slot}f`;
    const wrappedExpr =
      tokenIn.scalingFactor === 1n
        ? x
        : tokenIn.scalingUp
          ? `(${x}) * ${tokenIn.scalingFactor}`
          : `(${x}) / ${tokenIn.scalingFactor}`;
    const lines: string[] = [`  let ${outVar} = 0;`, `  if (s${slot}lx === ${x}) { ${outVar} = s${slot}lo }`, `  else {`];
    lines.push(`    let ${tag}w = ${wrappedExpr};`);
    lines.push(`    if (${tag}w > s${slot}xcap) { ${tag}w = s${slot}xcap }`);
    const core = weightedCoreQuoteLines(`${tag}_`, `s${slot}bal0`, `s${slot}bal1`, tokenIn.weight, tokenOut.weight, `${tag}w`, `${tag}raw`);
    lines.push(...core.map((l) => `    ${l}`));
    lines.push(`    if (${tag}raw > 0) {`);
    lines.push(`      const ${tag}net = Math.mulDiv(${tag}raw, 1000000000 - s${slot}fee, 1000000000);`);
    const unwrapExpr =
      tokenOut.scalingFactor === 1n
        ? `${tag}net`
        : tokenOut.scalingUp
          ? `${tag}net / ${tokenOut.scalingFactor}`
          : `${tag}net * ${tokenOut.scalingFactor}`;
    lines.push(`      ${outVar} = ${unwrapExpr};`);
    lines.push(`    }`);
    lines.push(`  }`);
    return lines.join('\n');
  },

  buildSwapV2(base: PoolConfig, slot: number, user: SwapUser): LadderSwapTemplate {
    const cfg = weightedCfg(base);
    const tokenIn = cfg.tokens[0];
    const tokenOut = cfg.tokens[1];
    const roled = (role: string, addr: Address): VenueAccount => ({ ref: ref(slot, role), address: addr });
    return {
      programId: stabbleWeightedSwap.programId,
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

  referenceQuote(base: PoolConfig, state: AccountBytesMap): (x: bigint) => bigint {
    const cfg = weightedCfg(base);
    const poolData = state[cfg.pool];
    if (poolData === undefined) throw new Error(`${SLUG} ladder reference is missing pool ${cfg.pool}`);
    const bal0 = readUintLE(poolData, balanceOffset(0), 8);
    const bal1 = readUintLE(poolData, balanceOffset(1), 8);
    const swapFee = readUintLE(poolData, SWAP_FEE_OFFSET, 8);
    const [tokenIn, tokenOut] = cfg.tokens;
    const xcap = mulDown(bal0, WEIGHTED_MAX_IN_RATIO);
    return (x: bigint): bigint => {
      if (x <= 0n) return 0n;
      let wrapped = calcWrappedAmount(x, tokenIn);
      if (wrapped > xcap) wrapped = xcap;
      const rawOut = weightedCalcOutGivenIn(bal0, tokenIn.weight, bal1, tokenOut.weight, wrapped) ?? 0n;
      const netOut = mulDown(rawOut, complement(swapFee));
      return calcUnwrappedAmount(netOut, tokenOut);
    };
  },

  /**
   * THE CAPACITY COLLAPSE — FIXED. Unlike emitLadderQuote/emitFinalQuote/
   * referenceQuote (which all clamp `wrapped` to `xcap` BEFORE computing the
   * output, so they already saturate correctly and never collapse), this
   * function used to freeze `lx` at whatever smaller grid point last
   * succeeded the moment a grid point's wrapped input first exceeded `xcap`
   * — under-reporting the true capacity whenever the grid skips the narrow
   * boundary. Fixed: bump `lx` up to `calcUnwrappedAmount(xcap, tokenIn)` —
   * the exact inverse of calcWrappedAmount, so re-wrapping it is guaranteed
   * <= xcap (safe, never over-promising; exact when NOT scalingUp, floor-
   * safe when scalingUp) — before latching.
   */
  referenceCapacities(base: PoolConfig, state: AccountBytesMap): (grid: readonly bigint[]) => bigint[] {
    const cfg = weightedCfg(base);
    const poolData = state[cfg.pool];
    if (poolData === undefined) throw new Error(`${SLUG} ladder reference is missing pool ${cfg.pool}`);
    const bal0 = readUintLE(poolData, balanceOffset(0), 8);
    const tokenIn = cfg.tokens[0];
    const xcap = mulDown(bal0, WEIGHTED_MAX_IN_RATIO);
    const unwrappedCap = calcUnwrappedAmount(xcap, tokenIn);
    return (grid: readonly bigint[]): bigint[] => {
      let capped = false;
      let lx = 0n;
      const out: bigint[] = [];
      for (const g of grid) {
        if (!capped && g > 0n) {
          const wrapped = calcWrappedAmount(g, tokenIn);
          if (wrapped > xcap) {
            if (unwrappedCap > lx) lx = unwrappedCap;
            capped = true;
          } else lx = g;
        }
        out.push(lx);
      }
      return out;
    };
  },

  depthReserves(base: PoolConfig, state: AccountBytesMap): { reserveIn: bigint; reserveOut: bigint } {
    const cfg = weightedCfg(base);
    const poolData = state[cfg.pool];
    if (poolData === undefined) throw new Error(`${SLUG} ladder reference is missing pool ${cfg.pool}`);
    return {
      reserveIn: calcUnwrappedAmount(readUintLE(poolData, balanceOffset(0), 8), cfg.tokens[0]),
      reserveOut: calcUnwrappedAmount(readUintLE(poolData, balanceOffset(1), 8), cfg.tokens[1]),
    };
  },

  continuousFees(base: PoolConfig, state: AccountBytesMap): { gammaPpm: bigint; muPpm: bigint } {
    const cfg = weightedCfg(base);
    const poolData = state[cfg.pool];
    if (poolData === undefined) throw new Error(`${SLUG} ladder fees are missing pool ${cfg.pool}`);
    const swapFee = readUintLE(poolData, SWAP_FEE_OFFSET, 8);
    return { gammaPpm: 1_000_000n - swapFee / 1_000n, muPpm: 1_000_000n };
  },
} satisfies SvmVenueLadder;
