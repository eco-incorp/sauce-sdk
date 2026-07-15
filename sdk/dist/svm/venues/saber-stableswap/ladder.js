import { readUintLE } from '../math.js';
import { STABLE_D_HELPER, STABLE_YW_HELPER, stableComputeD, stableComputeYWarm } from '../stable-helpers.js';
import { SABER_STABLESWAP_PROGRAM_ID } from './index.js';
const SLUG = 'saber-stableswap';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
// SwapInfo offsets (docs/svm-venues.md layout table).
const OFF_IS_PAUSED = 1;
const OFF_INITIAL_AMP = 3;
const OFF_TARGET_AMP = 11;
const OFF_START_RAMP_TS = 19;
const OFF_STOP_RAMP_TS = 27;
const OFF_TRADE_FEE_NUM = 363;
const OFF_TRADE_FEE_DEN = 371;
const OFF_SPL_AMOUNT = 64;
function saberConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
const ref = (slot, role) => `s${slot}:${role}`;
/** Live state exactly as the fragment computes it (amp ramp branches included). */
function liveState(cfg, state, now) {
    const bytes = (addr) => {
        const data = state[addr];
        if (data === undefined)
            throw new Error(`${SLUG} ladder reference is missing account ${addr}`);
        return data;
    };
    const pool = bytes(cfg.pool);
    const paused = pool[OFF_IS_PAUSED] !== 0;
    const src = readUintLE(bytes(cfg.vaultA), OFF_SPL_AMOUNT, 8);
    const dst = readUintLE(bytes(cfg.vaultB), OFF_SPL_AMOUNT, 8);
    const ini = readUintLE(pool, OFF_INITIAL_AMP, 8);
    const tgt = readUintLE(pool, OFF_TARGET_AMP, 8);
    const start = readUintLE(pool, OFF_START_RAMP_TS, 8);
    const stop = readUintLE(pool, OFF_STOP_RAMP_TS, 8);
    let amp = tgt;
    if (now < stop && stop > start && now >= start) {
        amp = tgt >= ini
            ? ini + ((tgt - ini) * (now - start)) / (stop - start)
            : ini - ((ini - tgt) * (now - start)) / (stop - start);
    }
    const fn = readUintLE(pool, OFF_TRADE_FEE_NUM, 8);
    const fd = readUintLE(pool, OFF_TRADE_FEE_DEN, 8);
    const d = !paused && src > 0n && dst > 0n ? stableComputeD(amp, src, dst) : 0n;
    return { paused, src, dst, amp, fn, fd, d };
}
/**
 * out from a converged y: dy = dst − y − 1, fee floors off the OUTPUT.
 * A zero fee denominator mirrors the engine's Math.mulDiv rule (small
 * product, d == 0 → 0); the fetch gate rejects such pools anyway.
 */
function outFromY(live, y) {
    if (live.dst <= y)
        return 0n;
    const dy = live.dst - y - 1n;
    return dy - (live.fd === 0n ? 0n : (dy * live.fn) / live.fd);
}
export const saberStableswapLadder = {
    slug: SLUG,
    /** Stable slots default to 2 rungs (cap 4) — a Newton quote is ~2 orders costlier than a CP one. */
    defaultRungs: 2,
    shapeKey() {
        return `${SLUG}:AtoB`;
    },
    helpers() {
        return [STABLE_D_HELPER, STABLE_YW_HELPER];
    },
    /** Everything is a live read — no per-trade params. */
    paramCount: 0,
    paramsFor(_base) {
        return [];
    },
    quoteRefs(base, slot) {
        const cfg = saberConfig(base);
        return [
            { ref: ref(slot, 'pool'), address: cfg.pool },
            { ref: ref(slot, 'va'), address: cfg.vaultA },
            { ref: ref(slot, 'vb'), address: cfg.vaultB },
        ];
    },
    emitSetup(base, slot, _params, enableVar) {
        void base;
        const pool = JSON.stringify(ref(slot, 'pool'));
        const enabled = enableVar ?? `s${slot}en`;
        return [
            `  const s${slot}ps = accountUint(${pool}, ${OFF_IS_PAUSED}, 1);`,
            `  const s${slot}src = accountUint(${JSON.stringify(ref(slot, 'va'))}, ${OFF_SPL_AMOUNT}, 8);`,
            `  const s${slot}dst = accountUint(${JSON.stringify(ref(slot, 'vb'))}, ${OFF_SPL_AMOUNT}, 8);`,
            `  const s${slot}ini = accountUint(${pool}, ${OFF_INITIAL_AMP}, 8);`,
            `  const s${slot}tgt = accountUint(${pool}, ${OFF_TARGET_AMP}, 8);`,
            `  const s${slot}srt = accountUint(${pool}, ${OFF_START_RAMP_TS}, 8);`,
            `  const s${slot}stp = accountUint(${pool}, ${OFF_STOP_RAMP_TS}, 8);`,
            `  let s${slot}amp = s${slot}tgt;`,
            `  if (block.timestamp < s${slot}stp && s${slot}stp > s${slot}srt && block.timestamp >= s${slot}srt) {`,
            `    if (s${slot}tgt >= s${slot}ini) { s${slot}amp = s${slot}ini + Math.mulDiv(s${slot}tgt - s${slot}ini, block.timestamp - s${slot}srt, s${slot}stp - s${slot}srt) }`,
            `    else { s${slot}amp = s${slot}ini - Math.mulDiv(s${slot}ini - s${slot}tgt, block.timestamp - s${slot}srt, s${slot}stp - s${slot}srt) }`,
            '  }',
            `  const s${slot}fn = accountUint(${pool}, ${OFF_TRADE_FEE_NUM}, 8);`,
            `  const s${slot}fd = accountUint(${pool}, ${OFF_TRADE_FEE_DEN}, 8);`,
            // Newton D — ONCE per trade, only for an enabled, unpaused, funded slot.
            // d == 0 is the master validity flag every quote checks.
            `  let s${slot}d = 0;`,
            `  if (${enabled} !== 0 && s${slot}ps === 0 && s${slot}src > 0 && s${slot}dst > 0) { s${slot}d = stableD(s${slot}amp, s${slot}src, s${slot}dst) }`,
        ].join('\n');
    },
    emitLadderQuote(_base, slot, rung, x, outVar) {
        const lines = [];
        // The warm cursor: rung 0 seeds from D (the venue's own cold start).
        if (rung === 0)
            lines.push(`    let s${slot}wy = s${slot}d;`);
        lines.push(`    let ${outVar} = 0;`, `    if (s${slot}d > 0 && ${x} > 0) {`, `      s${slot}wy = stableYW(s${slot}amp, s${slot}src + ${x}, s${slot}d, s${slot}wy);`, `      if (s${slot}dst > s${slot}wy) {`, `        const s${slot}dy${rung} = s${slot}dst - s${slot}wy - 1;`, `        ${outVar} = s${slot}dy${rung} - Math.mulDiv(s${slot}dy${rung}, s${slot}fn, s${slot}fd);`, '      }', '    }');
        return lines.join('\n');
    },
    emitFinalQuote(_base, slot, x, outVar) {
        // COLD: y0 = D — byte-identical to the venue's swap_to compute_y.
        return [
            `  let ${outVar} = 0;`,
            `  if (s${slot}d > 0 && ${x} > 0) {`,
            `    const s${slot}fy = stableYW(s${slot}amp, s${slot}src + ${x}, s${slot}d, s${slot}d);`,
            `    if (s${slot}dst > s${slot}fy) {`,
            `      const s${slot}fdy = s${slot}dst - s${slot}fy - 1;`,
            `      ${outVar} = s${slot}fdy - Math.mulDiv(s${slot}fdy, s${slot}fn, s${slot}fd);`,
            '    }',
            '  }',
        ].join('\n');
    },
    buildSwapV2(base, slot, user) {
        const cfg = saberConfig(base);
        // tag 0x01 ++ amount_in u64 LE (runtime-patched) ++ minimum_amount_out
        // u64 LE = 1 (the recipe's terminal delta check enforces the real bound).
        const roled = (role, addr, writable) => writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
        return {
            programId: SABER_STABLESWAP_PROGRAM_ID,
            prefix: Uint8Array.from([0x01]),
            suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
            patch: 'in',
            accounts: [
                roled('pool', cfg.pool),
                roled('auth', cfg.swapAuthority),
                { ref: user.owner, signer: true },
                { ref: user.inAta, writable: true },
                roled('va', cfg.vaultA, true),
                roled('vb', cfg.vaultB, true),
                { ref: user.outAta, writable: true },
                roled('afb', cfg.adminFeeB, true),
                roled('tp', TOKEN_PROGRAM),
            ],
        };
    },
    referenceQuote(base, state, _params, now) {
        const live = liveState(saberConfig(base), state, now ?? BigInt(Math.floor(Date.now() / 1000)));
        return (x) => {
            if (live.d === 0n || x === 0n)
                return 0n;
            const y = stableComputeYWarm(live.amp, live.src + x, live.d, live.d); // COLD
            return outFromY(live, y);
        };
    },
    referenceLadderQuotes(base, state, _params, now) {
        const live = liveState(saberConfig(base), state, now ?? BigInt(Math.floor(Date.now() / 1000)));
        return (grid) => {
            let wy = live.d;
            return grid.map((g) => {
                if (live.d === 0n || g === 0n)
                    return 0n; // wy unchanged, exactly like the fragment
                wy = stableComputeYWarm(live.amp, live.src + g, live.d, wy);
                return outFromY(live, wy);
            });
        };
    },
    depthReserves(base, state) {
        const cfg = saberConfig(base);
        const bytes = (addr) => {
            const data = state[addr];
            if (data === undefined)
                throw new Error(`${SLUG} ladder depth is missing account ${addr}`);
            return data;
        };
        return {
            reserveIn: readUintLE(bytes(cfg.vaultA), OFF_SPL_AMOUNT, 8),
            reserveOut: readUintLE(bytes(cfg.vaultB), OFF_SPL_AMOUNT, 8),
        };
    },
    continuousFees(base, state) {
        const cfg = saberConfig(base);
        const pool = state[cfg.pool];
        if (pool === undefined)
            throw new Error(`${SLUG} ladder fees are missing account ${cfg.pool}`);
        const fn = readUintLE(pool, OFF_TRADE_FEE_NUM, 8);
        const fd = readUintLE(pool, OFF_TRADE_FEE_DEN, 8);
        // Output-side fee retention; the CP form badly understates a stable
        // curve's depth — measurement oracle only, never a gate.
        return { gammaPpm: 1000000n, muPpm: 1000000n - (fn * 1000000n) / fd };
    },
};
//# sourceMappingURL=ladder.js.map