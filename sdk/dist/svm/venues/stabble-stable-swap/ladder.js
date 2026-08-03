import { readUintLE } from '../math.js';
import { calcUnwrappedAmount, calcWrappedAmount, complement, mulDown, STABBLE_SWAP_DISCRIMINATOR, STABBLE_TOKEN_PROGRAM_ID, STABBLE_VAULT_PROGRAM_ID, stableCalcInvariantN, stableDHelperSource, stableGetAmplification, stableGetBalanceGivenInvariantWarm, stableYWarmHelperSource, } from '../stabble-common.js';
import { stabbleStableSwap } from './index.js';
const SLUG = 'stabble-stable-swap';
const AMP_INITIAL_OFFSET = 106;
const AMP_TARGET_OFFSET = 108;
const RAMP_START_OFFSET = 110;
const RAMP_STOP_OFFSET = 118;
const SWAP_FEE_OFFSET = 126;
const TOKENS_OFFSET = 134;
const TOKEN_SIZE = 50;
const BAL_SUB_OFFSET = 42;
function stableCfg(base) {
    if (base.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${base.venue}' pool config`);
    return base;
}
const ref = (slot, role) => `s${slot}:${role}`;
function balanceOffset(index) {
    return TOKENS_OFFSET + 4 + index * TOKEN_SIZE + BAL_SUB_OFFSET;
}
function ampRampLines(cfg, slot) {
    const lines = [`  let s${slot}amp = ${cfg.ampTargetFactor * 1000};`];
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
    return lines;
}
export const stabbleStableSwapLadder = {
    slug: SLUG,
    /** 2-rung default (stable-kind pools budget for a heavier per-rung Newton) — see the consuming app SVM CU-budget module. */
    defaultRungs: 2,
    shapeKey(base) {
        const cfg = stableCfg(base);
        return `${SLUG}:n${cfg.tokens.length}:AtoB`;
    },
    helpers(base) {
        const cfg = stableCfg(base);
        const n = cfg.tokens.length;
        return [stableDHelperSource(n), stableYWarmHelperSource(n)];
    },
    paramCount: 0,
    paramsFor() {
        return [];
    },
    quoteRefs(base, slot) {
        const cfg = stableCfg(base);
        return [{ ref: ref(slot, 'pool'), address: cfg.pool }];
    },
    emitSetup(base, slot, _params, enableVar) {
        const cfg = stableCfg(base);
        const enabled = enableVar ?? `s${slot}en`;
        const pool = JSON.stringify(ref(slot, 'pool'));
        const n = cfg.tokens.length;
        const lines = [...ampRampLines(cfg, slot)];
        for (let i = 0; i < n; i++) {
            lines.push(`  const s${slot}bal${i} = accountUint(${pool}, ${balanceOffset(i)}, 8);`);
        }
        lines.push(`  const s${slot}fee = accountUint(${pool}, ${SWAP_FEE_OFFSET}, 8);`);
        // Newton D — ONCE per trade, only for an enabled slot with nonzero reserves.
        const dArgs = Array.from({ length: n }, (_, i) => `s${slot}bal${i}`).join(', ');
        const dHelper = stableDHelperSource(n).name;
        lines.push(`  let s${slot}d = 0;`);
        lines.push(`  if (${enabled} !== 0) { s${slot}d = ${dHelper}(s${slot}amp, ${dArgs}) }`);
        return lines.join('\n');
    },
    emitLadderQuote(base, slot, rung, x, outVar) {
        const cfg = stableCfg(base);
        const tokenIn = cfg.tokens[0];
        const tokenOut = cfg.tokens[1];
        const n = cfg.tokens.length;
        const yHelper = stableYWarmHelperSource(n).name;
        const balArgs = Array.from({ length: n }, (_, i) => `s${slot}bal${i}`).join(', ');
        const wrappedExpr = tokenIn.scalingFactor === 1n
            ? x
            : tokenIn.scalingUp
                ? `(${x}) * ${tokenIn.scalingFactor}`
                : `(${x}) / ${tokenIn.scalingFactor}`;
        const lines = [];
        if (rung === 0)
            lines.push(`    let s${slot}wy = s${slot}d;`);
        lines.push(`    let ${outVar} = 0;`);
        lines.push(`    if (s${slot}d > 0 && (${x}) > 0) {`);
        lines.push(`      s${slot}wy = ${yHelper}(s${slot}amp, ${balArgs}, ${wrappedExpr}, s${slot}d, s${slot}wy);`);
        lines.push(`      if (s${slot}bal1 > s${slot}wy) {`);
        lines.push(`        const s${slot}dy${rung} = s${slot}bal1 - s${slot}wy - 1;`);
        lines.push(`        const s${slot}net${rung} = Math.mulDiv(s${slot}dy${rung}, 1000000000 - s${slot}fee, 1000000000);`);
        const unwrapExpr = tokenOut.scalingFactor === 1n
            ? `s${slot}net${rung}`
            : tokenOut.scalingUp
                ? `s${slot}net${rung} / ${tokenOut.scalingFactor}`
                : `s${slot}net${rung} * ${tokenOut.scalingFactor}`;
        lines.push(`        ${outVar} = ${unwrapExpr};`);
        lines.push(`      }`);
        lines.push(`    }`);
        return lines.join('\n');
    },
    emitFinalQuote(base, slot, x, outVar) {
        const cfg = stableCfg(base);
        const tokenIn = cfg.tokens[0];
        const tokenOut = cfg.tokens[1];
        const n = cfg.tokens.length;
        const yHelper = stableYWarmHelperSource(n).name;
        const balArgs = Array.from({ length: n }, (_, i) => `s${slot}bal${i}`).join(', ');
        const wrappedExpr = tokenIn.scalingFactor === 1n
            ? x
            : tokenIn.scalingUp
                ? `(${x}) * ${tokenIn.scalingFactor}`
                : `(${x}) / ${tokenIn.scalingFactor}`;
        const lines = [`  let ${outVar} = 0;`, `  if (s${slot}d > 0 && (${x}) > 0) {`];
        // COLD: y0 = D — byte-identical to the venue's own from-scratch iteration.
        lines.push(`    const s${slot}fy = ${yHelper}(s${slot}amp, ${balArgs}, ${wrappedExpr}, s${slot}d, s${slot}d);`);
        lines.push(`    if (s${slot}bal1 > s${slot}fy) {`);
        lines.push(`      const s${slot}fdy = s${slot}bal1 - s${slot}fy - 1;`);
        lines.push(`      const s${slot}fnet = Math.mulDiv(s${slot}fdy, 1000000000 - s${slot}fee, 1000000000);`);
        const unwrapExpr = tokenOut.scalingFactor === 1n
            ? `s${slot}fnet`
            : tokenOut.scalingUp
                ? `s${slot}fnet / ${tokenOut.scalingFactor}`
                : `s${slot}fnet * ${tokenOut.scalingFactor}`;
        lines.push(`      ${outVar} = ${unwrapExpr};`);
        lines.push(`    }`);
        lines.push(`  }`);
        return lines.join('\n');
    },
    buildSwapV2(base, slot, user) {
        const cfg = stableCfg(base);
        const tokenIn = cfg.tokens[0];
        const tokenOut = cfg.tokens[1];
        const roled = (role, addr) => ({ ref: ref(slot, role), address: addr });
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
    referenceQuote(base, state, _params, now) {
        const cfg = stableCfg(base);
        const poolData = state[cfg.pool];
        if (poolData === undefined)
            throw new Error(`${SLUG} ladder reference is missing pool ${cfg.pool}`);
        const balances = cfg.tokens.map((_, i) => readUintLE(poolData, balanceOffset(i), 8));
        const swapFee = readUintLE(poolData, SWAP_FEE_OFFSET, 8);
        const t = now ?? BigInt(Math.floor(Date.now() / 1000));
        const amp = stableGetAmplification(cfg.ampInitialFactor, cfg.ampTargetFactor, cfg.rampStartTs, cfg.rampStopTs, t);
        const invariant = stableCalcInvariantN(amp, balances);
        const [tokenIn, tokenOut] = cfg.tokens;
        return (x) => {
            if (invariant <= 0n || x <= 0n)
                return 0n;
            const wrappedX = calcWrappedAmount(x, tokenIn);
            const newBalances = balances.map((b, i) => (i === 0 ? b + wrappedX : b));
            // COLD: y0 = invariant, exactly like emitFinalQuote.
            const y = stableGetBalanceGivenInvariantWarm(amp, newBalances, invariant, balances[1], invariant);
            if (balances[1] <= y)
                return 0n;
            const dy = balances[1] - y - 1n;
            const netOut = mulDown(dy, complement(swapFee));
            return calcUnwrappedAmount(netOut, tokenOut);
        };
    },
    referenceLadderQuotes(base, state, _params, now) {
        const cfg = stableCfg(base);
        const poolData = state[cfg.pool];
        if (poolData === undefined)
            throw new Error(`${SLUG} ladder reference is missing pool ${cfg.pool}`);
        const balances = cfg.tokens.map((_, i) => readUintLE(poolData, balanceOffset(i), 8));
        const swapFee = readUintLE(poolData, SWAP_FEE_OFFSET, 8);
        const t = now ?? BigInt(Math.floor(Date.now() / 1000));
        const amp = stableGetAmplification(cfg.ampInitialFactor, cfg.ampTargetFactor, cfg.rampStartTs, cfg.rampStopTs, t);
        const invariant = stableCalcInvariantN(amp, balances);
        const [tokenIn, tokenOut] = cfg.tokens;
        return (grid) => {
            let wy = invariant;
            return grid.map((g) => {
                if (invariant <= 0n || g <= 0n)
                    return 0n; // wy unchanged, exactly like the fragment
                const wrappedG = calcWrappedAmount(g, tokenIn);
                const newBalances = balances.map((b, i) => (i === 0 ? b + wrappedG : b));
                wy = stableGetBalanceGivenInvariantWarm(amp, newBalances, invariant, balances[1], wy);
                if (balances[1] <= wy)
                    return 0n;
                const dy = balances[1] - wy - 1n;
                const netOut = mulDown(dy, complement(swapFee));
                return calcUnwrappedAmount(netOut, tokenOut);
            });
        };
    },
    depthReserves(base, state) {
        const cfg = stableCfg(base);
        const poolData = state[cfg.pool];
        if (poolData === undefined)
            throw new Error(`${SLUG} ladder reference is missing pool ${cfg.pool}`);
        const reserveInWrapped = readUintLE(poolData, balanceOffset(0), 8);
        const reserveOutWrapped = readUintLE(poolData, balanceOffset(1), 8);
        return {
            reserveIn: calcUnwrappedAmount(reserveInWrapped, cfg.tokens[0]),
            reserveOut: calcUnwrappedAmount(reserveOutWrapped, cfg.tokens[1]),
        };
    },
    continuousFees(base, state) {
        const cfg = stableCfg(base);
        const poolData = state[cfg.pool];
        if (poolData === undefined)
            throw new Error(`${SLUG} ladder fees are missing pool ${cfg.pool}`);
        const swapFee = readUintLE(poolData, SWAP_FEE_OFFSET, 8);
        // swap_fee is ONE(1e9)-scaled; convert to ppm (1e6-scaled) retention. The
        // CP form badly understates a stable curve's depth — measurement oracle
        // only, never a gate (same caveat as every other stable-kind family).
        return { gammaPpm: 1000000n - swapFee / 1000n, muPpm: 1000000n };
    },
};
//# sourceMappingURL=ladder.js.map