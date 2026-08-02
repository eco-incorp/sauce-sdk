import { readUintLE } from '../math.js';
import { calcUnwrappedAmount, calcWrappedAmount, complement, mulDown, STABBLE_SWAP_DISCRIMINATOR, STABBLE_TOKEN_PROGRAM_ID, STABBLE_VAULT_PROGRAM_ID, WEIGHTED_MAX_IN_RATIO, weightedCalcOutGivenIn, weightedCoreQuoteLines, } from '../stabble-common.js';
import { stabbleWeightedSwap } from './index.js';
const SLUG = 'stabble-weighted-swap';
const SWAP_FEE_OFFSET = 114;
const TOKENS_OFFSET = 122;
const TOKEN_SIZE = 58;
const BAL_SUB_OFFSET = 42;
function weightedCfg(base) {
    if (base.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${base.venue}' pool config`);
    return base;
}
const ref = (slot, role) => `s${slot}:${role}`;
function balanceOffset(index) {
    return TOKENS_OFFSET + 4 + index * TOKEN_SIZE + BAL_SUB_OFFSET;
}
export const stabbleWeightedSwapLadder = {
    slug: SLUG,
    shapeKey(base) {
        const cfg = weightedCfg(base);
        return `${SLUG}:AtoB:wi${cfg.tokens[0].weight}:wo${cfg.tokens[1].weight}`;
    },
    helpers() {
        return []; // the pow schedule is unrolled per-slot (shape-keyed on the weight pair) — no shared named function
    },
    paramCount: 0,
    paramsFor() {
        return [];
    },
    quoteRefs(base, slot) {
        const cfg = weightedCfg(base);
        return [{ ref: ref(slot, 'pool'), address: cfg.pool }];
    },
    emitSetup(base, slot, _params, enableVar) {
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
    emitLadderQuote(base, slot, rung, x, outVar) {
        const cfg = weightedCfg(base);
        const tokenIn = cfg.tokens[0];
        const tokenOut = cfg.tokens[1];
        const tag = `s${slot}r${rung}`;
        const wrappedExpr = tokenIn.scalingFactor === 1n
            ? x
            : tokenIn.scalingUp
                ? `(${x}) * ${tokenIn.scalingFactor}`
                : `(${x}) / ${tokenIn.scalingFactor}`;
        const lines = [
            `    if (s${slot}cap === 0) {`,
            `      let ${tag}w = ${wrappedExpr};`,
            `      if (${tag}w > s${slot}xcap) { ${tag}w = s${slot}xcap; s${slot}cap = 1 }`,
        ];
        const core = weightedCoreQuoteLines(`${tag}_`, `s${slot}bal0`, `s${slot}bal1`, tokenIn.weight, tokenOut.weight, `${tag}w`, `${tag}raw`);
        lines.push(...core.map((l) => `      ${l}`));
        lines.push(`      if (${tag}raw > 0) {`);
        lines.push(`        const ${tag}net = Math.mulDiv(${tag}raw, 1000000000 - s${slot}fee, 1000000000);`);
        const unwrapExpr = tokenOut.scalingFactor === 1n
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
    capacityInputVar(slot) {
        return `s${slot}lx`;
    },
    /** Cold final quote: cache-hit when x lands exactly on the ladder's last checkpoint, else a fresh (clamped) recompute — never a stale value. */
    emitFinalQuote(base, slot, x, outVar) {
        const cfg = weightedCfg(base);
        const tokenIn = cfg.tokens[0];
        const tokenOut = cfg.tokens[1];
        const tag = `s${slot}f`;
        const wrappedExpr = tokenIn.scalingFactor === 1n
            ? x
            : tokenIn.scalingUp
                ? `(${x}) * ${tokenIn.scalingFactor}`
                : `(${x}) / ${tokenIn.scalingFactor}`;
        const lines = [`  let ${outVar} = 0;`, `  if (s${slot}lx === ${x}) { ${outVar} = s${slot}lo }`, `  else {`];
        lines.push(`    let ${tag}w = ${wrappedExpr};`);
        lines.push(`    if (${tag}w > s${slot}xcap) { ${tag}w = s${slot}xcap }`);
        const core = weightedCoreQuoteLines(`${tag}_`, `s${slot}bal0`, `s${slot}bal1`, tokenIn.weight, tokenOut.weight, `${tag}w`, `${tag}raw`);
        lines.push(...core.map((l) => `    ${l}`));
        lines.push(`    if (${tag}raw > 0) {`);
        lines.push(`      const ${tag}net = Math.mulDiv(${tag}raw, 1000000000 - s${slot}fee, 1000000000);`);
        const unwrapExpr = tokenOut.scalingFactor === 1n
            ? `${tag}net`
            : tokenOut.scalingUp
                ? `${tag}net / ${tokenOut.scalingFactor}`
                : `${tag}net * ${tokenOut.scalingFactor}`;
        lines.push(`      ${outVar} = ${unwrapExpr};`);
        lines.push(`    }`);
        lines.push(`  }`);
        return lines.join('\n');
    },
    buildSwapV2(base, slot, user) {
        const cfg = weightedCfg(base);
        const tokenIn = cfg.tokens[0];
        const tokenOut = cfg.tokens[1];
        const roled = (role, addr) => ({ ref: ref(slot, role), address: addr });
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
    referenceQuote(base, state) {
        const cfg = weightedCfg(base);
        const poolData = state[cfg.pool];
        if (poolData === undefined)
            throw new Error(`${SLUG} ladder reference is missing pool ${cfg.pool}`);
        const bal0 = readUintLE(poolData, balanceOffset(0), 8);
        const bal1 = readUintLE(poolData, balanceOffset(1), 8);
        const swapFee = readUintLE(poolData, SWAP_FEE_OFFSET, 8);
        const [tokenIn, tokenOut] = cfg.tokens;
        const xcap = mulDown(bal0, WEIGHTED_MAX_IN_RATIO);
        return (x) => {
            if (x <= 0n)
                return 0n;
            let wrapped = calcWrappedAmount(x, tokenIn);
            if (wrapped > xcap)
                wrapped = xcap;
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
    referenceCapacities(base, state) {
        const cfg = weightedCfg(base);
        const poolData = state[cfg.pool];
        if (poolData === undefined)
            throw new Error(`${SLUG} ladder reference is missing pool ${cfg.pool}`);
        const bal0 = readUintLE(poolData, balanceOffset(0), 8);
        const tokenIn = cfg.tokens[0];
        const xcap = mulDown(bal0, WEIGHTED_MAX_IN_RATIO);
        const unwrappedCap = calcUnwrappedAmount(xcap, tokenIn);
        return (grid) => {
            let capped = false;
            let lx = 0n;
            const out = [];
            for (const g of grid) {
                if (!capped && g > 0n) {
                    const wrapped = calcWrappedAmount(g, tokenIn);
                    if (wrapped > xcap) {
                        if (unwrappedCap > lx)
                            lx = unwrappedCap;
                        capped = true;
                    }
                    else
                        lx = g;
                }
                out.push(lx);
            }
            return out;
        };
    },
    depthReserves(base, state) {
        const cfg = weightedCfg(base);
        const poolData = state[cfg.pool];
        if (poolData === undefined)
            throw new Error(`${SLUG} ladder reference is missing pool ${cfg.pool}`);
        return {
            reserveIn: calcUnwrappedAmount(readUintLE(poolData, balanceOffset(0), 8), cfg.tokens[0]),
            reserveOut: calcUnwrappedAmount(readUintLE(poolData, balanceOffset(1), 8), cfg.tokens[1]),
        };
    },
    continuousFees(base, state) {
        const cfg = weightedCfg(base);
        const poolData = state[cfg.pool];
        if (poolData === undefined)
            throw new Error(`${SLUG} ladder fees are missing pool ${cfg.pool}`);
        const swapFee = readUintLE(poolData, SWAP_FEE_OFFSET, 8);
        return { gammaPpm: 1000000n - swapFee / 1000n, muPpm: 1000000n };
    },
};
//# sourceMappingURL=ladder.js.map