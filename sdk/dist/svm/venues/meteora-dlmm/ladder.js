import { readUintLE } from '../math.js';
import { BIN_LEN, METEORA_DLMM_MAX_BINS, METEORA_DLMM_PROGRAM_ID, OFF_ACTIVE_ID, OFF_BA_BINS, OFF_BIN_AMOUNT_X, OFF_BIN_AMOUNT_Y, OFF_INDEX_REF, OFF_LAST_UPDATE, OFF_VOLATILITY_ACC, OFF_VOLATILITY_REF, windowFor, } from './index.js';
import { amountIn as binAmountIn, amountOut as binAmountOut, priceFromId } from './bin-math.js';
export { priceFromId, METEORA_DLMM_MAX_BINS };
const SLUG = 'meteora-dlmm';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** ['__event_authority'] under the DLMM program. */
const EVENT_AUTHORITY = 'D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6';
/** sha256('global:swap')[0..8]. */
const SWAP_DISCRIMINATOR = [248, 198, 158, 145, 225, 117, 135, 200];
const BIAS = 2147483648n; // 2^31
const M32 = 4294967295n;
const U64_MAX = (1n << 64n) - 1n;
const ONE = 1n << 64n;
const BPS = 10000n;
const FEE_PRECISION = 1000000000n;
const MAX_FEE_RATE = 100000000n;
const VFEE_DEN = 100000000000n; // 1e11
/** "Exceeds u64" sentinel (2^65) — above any valid amount, below any wrap hazard. */
const SENT = 1n << 65n;
/** cfg words per slot: [baseFee, binStep, vfc, maxVfa, reductionFactor, filterPeriod, decayPeriod, nb] + (meta,priceHi,priceLo) per bin. */
const FEE_PARAM_COUNT = 7;
const PARAM_COUNT = FEE_PARAM_COUNT + 1 + 3 * METEORA_DLMM_MAX_BINS;
function dlmmConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
const ref = (slot, role) => `s${slot}:${role}`;
/** base_fee = base_factor * bin_step * 10 * 10^base_fee_power_factor (immutable). */
function baseFeeRate(baseFactor, binStep, baseFeePowerFactor) {
    return baseFactor * binStep * 10n * 10n ** BigInt(baseFeePowerFactor);
}
function feeParamsFromCfg(cfg, params) {
    return {
        baseFee: params[0],
        binStep: params[1],
        vfc: params[2],
        maxVfa: params[3],
        reductionFactor: params[4],
        filterPeriod: params[5],
        decayPeriod: params[6],
    };
}
/** update_references(now) over live v_parameters (lb_pair.rs). */
function liveFromState(cfg, state, fee, now) {
    const pair = state[cfg.pool];
    if (pair === undefined)
        throw new Error(`${SLUG} ladder reference is missing pair ${cfg.pool}`);
    const rawActive = Number(BigInt.asIntN(32, readUintLE(pair, OFF_ACTIVE_ID, 4)));
    const bActive = (BigInt(rawActive) + BIAS) & M32;
    const vacc = readUintLE(pair, OFF_VOLATILITY_ACC, 4);
    const vref = readUintLE(pair, OFF_VOLATILITY_REF, 4);
    const rawIref = Number(BigInt.asIntN(32, readUintLE(pair, OFF_INDEX_REF, 4)));
    const biref = (BigInt(rawIref) + BIAS) & M32;
    const lastUpdate = readUintLE(pair, OFF_LAST_UPDATE, 8);
    let irefEff = biref;
    let vrefEff = vref;
    const elapsed = now >= lastUpdate ? now - lastUpdate : 0n;
    if (elapsed >= fee.filterPeriod) {
        irefEff = bActive;
        vrefEff = elapsed < fee.decayPeriod ? (vacc * fee.reductionFactor) / BPS : 0n;
    }
    return { bActive, vacc, vref, biref, lastUpdate, irefEff, vrefEff };
}
/** The per-bin total fee (base + volatility), matching compute_variable_fee. */
function totalFeeForBin(fee, live, bid) {
    const delta = live.irefEff >= bid ? live.irefEff - bid : bid - live.irefEff;
    let vacc = live.vrefEff + delta * BPS;
    if (vacc > fee.maxVfa)
        vacc = fee.maxVfa;
    let vfee = 0n;
    if (fee.vfc > 0n) {
        const crossed = vacc * fee.binStep;
        vfee = (fee.vfc * crossed * crossed + VFEE_DEN - 1n) / VFEE_DEN;
    }
    const total = fee.baseFee + vfee;
    return total > MAX_FEE_RATE ? MAX_FEE_RATE : total;
}
function effectiveBins(cfg, state, live, params) {
    const swapForY = cfg.direction === 'xToY';
    const window = windowFor(cfg);
    const kept = [];
    const nb = Number(params[FEE_PARAM_COUNT]);
    const amountOffset = swapForY ? OFF_BIN_AMOUNT_Y : OFF_BIN_AMOUNT_X;
    for (let k = 0; k < METEORA_DLMM_MAX_BINS && k < nb; k++) {
        const meta = params[FEE_PARAM_COUNT + 1 + 3 * k];
        const bid = meta & M32;
        // Re-anchor: swap_for_y keeps bin_id <= live active; !swap_for_y keeps >=.
        if (swapForY ? bid > live.bActive : bid < live.bActive)
            continue;
        const offset = Number((meta >> 32n) & 127n);
        const arrayIndex = Number(meta >> 39n);
        const data = state[window.binArrays[arrayIndex]];
        if (data === undefined)
            throw new Error(`${SLUG} ladder reference is missing account ${window.binArrays[arrayIndex]}`);
        const amount = readUintLE(data, OFF_BA_BINS + offset * BIN_LEN + amountOffset, 8);
        if (amount === 0n)
            continue;
        const price = (params[FEE_PARAM_COUNT + 2 + 3 * k] << 64n) | params[FEE_PARAM_COUNT + 3 + 3 * k];
        kept.push({ bid, price, amount });
    }
    return kept;
}
/** Cold bin walk; null when x exceeds the shipped-window capacity. */
function coldWalk(kept, fee, live, swapForY, x) {
    if (x === 0n)
        return 0n;
    if (kept.length === 0)
        return null;
    let remaining = x;
    let out = 0n;
    for (let k = 0; k < kept.length && remaining > 0n; k++) {
        const { bid, price, amount } = kept[k];
        const tfee = totalFeeForBin(fee, live, bid);
        const feeIn = (remaining * tfee + FEE_PRECISION - 1n) / FEE_PRECISION;
        const excluded = remaining - feeIn;
        const maxIn = binAmountIn(amount, price, swapForY, 'up');
        if (maxIn >= SENT)
            return null;
        if (excluded >= maxIn) {
            const fee2 = (maxIn * tfee + (FEE_PRECISION - tfee) - 1n) / (FEE_PRECISION - tfee);
            const consumed = maxIn + fee2;
            if (consumed > remaining)
                return null; // safety clamp (venue would checked_sub-underflow)
            remaining -= consumed;
            out += amount;
        }
        else {
            const o = binAmountOut(excluded, price, swapForY, 'down');
            if (o >= SENT)
                return null;
            out += o;
            remaining = 0n;
        }
    }
    return remaining > 0n ? null : out;
}
/**
 * Capacity-clamped cold bin walk: the same loop, never null — reports the
 * PRODUCTIVE gross input consumed (`cap = x − remaining`) and the output at
 * that point. cap === x when x is fully absorbed; cap < x once the walk runs
 * out of shipped bins (or hits a deactivating bin). The lamport twin of the
 * emitted rung's `lx`/`lo` capped booking.
 */
function coldWalkClamped(kept, fee, live, swapForY, x) {
    if (x <= 0n || kept.length === 0)
        return { out: 0n, cap: 0n };
    let remaining = x;
    let out = 0n;
    for (let k = 0; k < kept.length && remaining > 0n; k++) {
        const { bid, price, amount } = kept[k];
        const tfee = totalFeeForBin(fee, live, bid);
        const feeIn = (remaining * tfee + FEE_PRECISION - 1n) / FEE_PRECISION;
        const excluded = remaining - feeIn;
        const maxIn = binAmountIn(amount, price, swapForY, 'up');
        if (maxIn >= SENT)
            break;
        if (excluded >= maxIn) {
            const fee2 = (maxIn * tfee + (FEE_PRECISION - tfee) - 1n) / (FEE_PRECISION - tfee);
            const consumed = maxIn + fee2;
            if (consumed > remaining)
                break;
            remaining -= consumed;
            out += amount;
        }
        else {
            const o = binAmountOut(excluded, price, swapForY, 'down');
            if (o >= SENT)
                break;
            out += o;
            remaining = 0n;
        }
    }
    return { out, cap: x - remaining };
}
/** The per-rung bin walk over the kept arrays (kbid/kpr/kam, count knb). */
function emitBinWalk(p, swapForY, x, v, loopVar) {
    const maxIn = swapForY ? `((${p}mo << 64) + ${p}pr - 1) / ${p}pr` : `(${p}mo * ${p}pr + ${U64_MAX}) / ${ONE}`;
    const outPartial = swapForY ? `(${p}pr * ${p}ex2) / ${ONE}` : `(${p}ex2 << 64) / ${p}pr`;
    return [
        `      ${v.rm} = ${x}; ${v.out} = 0; ${v.ex} = 0;`,
        `      for (let ${loopVar} = 0; ${loopVar} < ${p}knb && ${v.rm} > 0 && ${v.ex} === 0; ${loopVar}++) {`,
        `        ${p}bid = ${p}kbid[${loopVar}]; ${p}pr = ${p}kpr[${loopVar}]; ${p}mo = ${p}kam[${loopVar}];`,
        // total fee for this bin
        `        ${p}dl = ${p}iref; if (${p}iref < ${p}bid) { ${p}dl = ${p}bid - ${p}iref } else { ${p}dl = ${p}iref - ${p}bid }`,
        `        ${p}va = ${p}vref + ${p}dl * ${BPS}; if (${p}va > ${p}mvfa) { ${p}va = ${p}mvfa }`,
        `        ${p}vf = 0;`,
        `        if (${p}vfc > 0) { ${p}cr = ${p}va * ${p}bs; ${p}vf = (${p}vfc * ${p}cr * ${p}cr + ${VFEE_DEN} - 1) / ${VFEE_DEN} }`,
        `        ${p}tf = ${p}bfee + ${p}vf; if (${p}tf > ${MAX_FEE_RATE}) { ${p}tf = ${MAX_FEE_RATE} }`,
        // fill
        `        ${p}fi = (${v.rm} * ${p}tf + ${FEE_PRECISION} - 1) / ${FEE_PRECISION};`,
        `        ${p}ex2 = ${v.rm} - ${p}fi;`,
        `        ${p}mi = ${maxIn};`,
        // A bin whose max input can't be represented in u64 (>= 2^65) is deactivated,
        // matching the mirror's null-return so fragment and reference agree at pathological deep bins.
        `        if (${p}mi >= ${SENT}) { ${v.ex} = 1 }`,
        `        else if (${p}ex2 >= ${p}mi) {`,
        `          ${p}f2 = (${p}mi * ${p}tf + ${FEE_PRECISION} - ${p}tf - 1) / (${FEE_PRECISION} - ${p}tf);`,
        `          ${p}cs = ${p}mi + ${p}f2;`,
        `          if (${p}cs > ${v.rm}) { ${v.ex} = 1 }`,
        `          else { ${v.rm} = ${v.rm} - ${p}cs; ${v.out} = ${v.out} + ${p}mo }`,
        `        } else {`,
        `          ${v.out} = ${v.out} + ${outPartial};`,
        `          ${v.rm} = 0;`,
        `        }`,
        `      }`,
    ];
}
/** The per-bin live verification/unpack (unrolled; account refs compile-time). */
function emitBinUnpack(p, slot, k, swapForY, params) {
    const keep = swapForY ? `${p}u2 <= ${p}bactive` : `${p}u2 >= ${p}bactive`;
    const amountOffset = swapForY ? OFF_BIN_AMOUNT_Y : OFF_BIN_AMOUNT_X;
    const readArm = (a) => `${p}u5 = accountUint(${JSON.stringify(ref(slot, `ba${a}`))}, ${OFF_BA_BINS} + ${p}u3 * ${BIN_LEN} + ${amountOffset}, 8);`;
    return [
        `    if (${params[FEE_PARAM_COUNT]} > ${k}) {`,
        `      ${p}u1 = ${params[FEE_PARAM_COUNT + 1 + 3 * k]};`,
        `      ${p}u2 = ${p}u1 & ${M32};`,
        `      if (${keep}) {`,
        `        ${p}u3 = (${p}u1 >> 32) & 127;`,
        `        ${p}u4 = ${p}u1 >> 39;`,
        `        ${p}u5 = 0;`,
        `        if (${p}u4 === 0) { ${readArm(0)} } else { if (${p}u4 === 1) { ${readArm(1)} } else { ${readArm(2)} } }`,
        `        if (${p}u5 > 0) {`,
        `          ${p}kbid[${p}knb] = ${p}u2;`,
        `          ${p}kpr[${p}knb] = (${params[FEE_PARAM_COUNT + 2 + 3 * k]} << 64) | ${params[FEE_PARAM_COUNT + 3 + 3 * k]};`,
        `          ${p}kam[${p}knb] = ${p}u5;`,
        `          ${p}knb = ${p}knb + 1;`,
        `        }`,
        `      }`,
        `    }`,
    ];
}
export const meteoraDlmmLadder = {
    slug: SLUG,
    /** 2 rungs by default: a rung is a full cold bin walk (degrade-first class, like the CLMMs). */
    defaultRungs: 2,
    shapeKey(base) {
        const cfg = dlmmConfig(base);
        // The swap ix ships only the bin arrays that EXIST on-chain (the readable
        // prefix), so the CPI account layout — hence the compiled bytecode — varies
        // with that count; it MUST be part of the shape discriminant (the contract:
        // one shapeKey => byte-identical slot fragments).
        return `${SLUG}:${cfg.direction}:ba${windowFor(cfg).readable}`;
    },
    helpers() {
        return [];
    },
    /** [baseFee, binStep, vfc, maxVfa, reductionFactor, filterPeriod, decayPeriod, nb, (meta,priceHi,priceLo) x MAX_BINS]. */
    paramCount: PARAM_COUNT,
    paramsFor(base) {
        const cfg = dlmmConfig(base);
        const window = windowFor(cfg);
        const pairData = undefined;
        // Fee params come from the config snapshot (immutable venue params).
        const words = [
            baseFeeRate(BigInt(cfg.baseFactor), BigInt(cfg.binStep), cfg.baseFeePowerFactor ?? 0),
            BigInt(cfg.binStep),
            BigInt(cfg.variableFeeControl),
            BigInt(cfg.maxVolatilityAccumulator),
            BigInt(cfg.reductionFactor),
            BigInt(cfg.filterPeriod),
            BigInt(cfg.decayPeriod),
            BigInt(window.bins.length),
        ];
        void pairData;
        for (let k = 0; k < METEORA_DLMM_MAX_BINS; k++) {
            const bin = window.bins[k];
            if (bin === undefined) {
                words.push(0n, 0n, 0n);
                continue;
            }
            words.push((BigInt(bin.binId) + BIAS) | (BigInt(bin.offset) << 32n) | (BigInt(bin.arrayIndex) << 39n), bin.price >> 64n, bin.price & U64_MAX);
        }
        return words;
    },
    quoteRefs(base, slot) {
        const cfg = dlmmConfig(base);
        const window = windowFor(cfg);
        const referenced = new Set(window.bins.map((bin) => bin.arrayIndex));
        return [
            { ref: ref(slot, 'pair'), address: cfg.pool },
            ...window.binArrays.map((address, i) => ({
                ref: ref(slot, `ba${i}`),
                address,
                ...(referenced.has(i) ? {} : { optional: true }),
            })),
        ];
    },
    emitSetup(base, slot, params, enableVar) {
        const cfg = dlmmConfig(base);
        const swapForY = cfg.direction === 'xToY';
        const p = `s${slot}`;
        const pair = JSON.stringify(ref(slot, 'pair'));
        const enabled = enableVar ?? `${p}en`;
        const lines = [
            // immutable fee params (drift-invariant venue constants)
            `  const ${p}bfee = ${params[0]};`,
            `  const ${p}bs = ${params[1]};`,
            `  const ${p}vfc = ${params[2]};`,
            `  const ${p}mvfa = ${params[3]};`,
            `  const ${p}rf = ${params[4]};`,
            `  const ${p}fp = ${params[5]};`,
            `  const ${p}dp = ${params[6]};`,
            // live volatility state + active id
            `  const ${p}bactive = (accountUint(${pair}, ${OFF_ACTIVE_ID}, 4) + ${BIAS}) & ${M32};`,
            `  const ${p}vacc = accountUint(${pair}, ${OFF_VOLATILITY_ACC}, 4);`,
            `  const ${p}vrefS = accountUint(${pair}, ${OFF_VOLATILITY_REF}, 4);`,
            `  const ${p}birefS = (accountUint(${pair}, ${OFF_INDEX_REF}, 4) + ${BIAS}) & ${M32};`,
            `  const ${p}lu = accountUint(${pair}, ${OFF_LAST_UPDATE}, 8);`,
            // update_references(now)
            `  let ${p}elapsed = 0;`,
            `  if (block.timestamp >= ${p}lu) { ${p}elapsed = block.timestamp - ${p}lu }`,
            `  let ${p}iref = ${p}birefS;`,
            `  let ${p}vref = ${p}vrefS;`,
            `  if (${p}elapsed >= ${p}fp) {`,
            `    ${p}iref = ${p}bactive;`,
            `    if (${p}elapsed < ${p}dp) { ${p}vref = (${p}vacc * ${p}rf) / ${BPS} } else { ${p}vref = 0 }`,
            `  }`,
            // kept-bin arrays + walk scratch
            `  let ${p}knb = 0;`,
            `  const ${p}kbid = new Array(${METEORA_DLMM_MAX_BINS});`,
            `  const ${p}kpr = new Array(${METEORA_DLMM_MAX_BINS});`,
            `  const ${p}kam = new Array(${METEORA_DLMM_MAX_BINS});`,
            `  let ${p}u1 = 0; let ${p}u2 = 0; let ${p}u3 = 0; let ${p}u4 = 0; let ${p}u5 = 0;`,
            `  let ${p}bid = 0; let ${p}pr = 0; let ${p}mo = 0; let ${p}dl = 0; let ${p}va = 0; let ${p}vf = 0; let ${p}tf = 0;`,
            `  let ${p}fi = 0; let ${p}ex2 = 0; let ${p}mi = 0; let ${p}f2 = 0; let ${p}cs = 0; let ${p}cr = 0;`,
            `  let ${p}wrm = 0; let ${p}wout = 0; let ${p}wex = 0;`,
            `  let ${p}lo = 0; let ${p}lx = 0; let ${p}wcx = 0;`,
            `  if (${enabled} !== 0) {`,
            ...Array.from({ length: METEORA_DLMM_MAX_BINS }, (_, k) => emitBinUnpack(p, slot, k, swapForY, params)).flat(),
            `  }`,
            `  let ${p}vld = 0;`,
            `  if (${p}knb > 0) { ${p}vld = 1 }`,
        ];
        return lines.join('\n');
    },
    emitLadderQuote(base, slot, rung, x, outVar) {
        const cfg = dlmmConfig(base);
        const swapForY = cfg.direction === 'xToY';
        const p = `s${slot}`;
        const v = { rm: `${p}wrm`, out: `${p}wout`, ex: `${p}wex` };
        return [
            `    if (${p}vld !== 0 && ${p}wcx === 0 && ${x} > 0) {`,
            ...emitBinWalk(p, swapForY, x, v, `${p}w${rung}`),
            // Capacity-aware booking: a fully-absorbed rung records (grid point,
            // output); an exhausted rung records the PRODUCTIVE input consumed
            // (x − remaining, the window cap) and the output at the cap, then
            // latches wcx so higher rungs reuse the cap (their dIn folds to 0). lx
            // holds the cumulative productive input the codegen books dIn from.
            `      if (${p}wex === 0 && ${p}wrm === 0) { ${p}lo = ${p}wout; ${p}lx = ${x} }`,
            `      else { ${p}lo = ${p}wout; ${p}lx = ${x} - ${p}wrm; ${p}wcx = 1 }`,
            `    }`,
            `    const ${outVar} = ${p}lo;`,
        ].join('\n');
    },
    capacityInputVar(slot) {
        return `s${slot}lx`;
    },
    emitFinalQuote(base, slot, x, outVar) {
        const cfg = dlmmConfig(base);
        const swapForY = cfg.direction === 'xToY';
        const p = `s${slot}`;
        const v = { rm: `${p}frm`, out: `${p}fout`, ex: `${p}fex` };
        return [
            `  let ${outVar} = 0;`,
            `  if (${p}vld !== 0 && ${x} > 0) {`,
            `    if (${p}lx === ${x}) { ${outVar} = ${p}lo }`,
            `    else {`,
            `      let ${p}frm = 0; let ${p}fout = 0; let ${p}fex = 0;`,
            ...emitBinWalk(p, swapForY, x, v, `${p}wf`),
            `      if (${p}fex === 0 && ${p}frm === 0) { ${outVar} = ${p}fout }`,
            `    }`,
            `  }`,
        ].join('\n');
    },
    buildSwapV2(base, slot, user) {
        const cfg = dlmmConfig(base);
        const swapForY = cfg.direction === 'xToY';
        const window = windowFor(cfg);
        // swap: disc(8) ++ amount_in u64 LE (runtime-patched) ++ min_amount_out u64 LE = 1.
        const roled = (role, addr, writable) => writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
        return {
            programId: METEORA_DLMM_PROGRAM_ID,
            prefix: Uint8Array.from(SWAP_DISCRIMINATOR),
            suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
            patch: 'in',
            accounts: [
                roled('pair', cfg.pool, true),
                // bin_array_bitmap_extension is an Option<AccountLoader>: pass the real
                // account only when it exists on-chain, else the DLMM program-id None
                // sentinel (mirrors host_fee_in below). A derived-but-uninitialized PDA
                // makes Anchor try Some(deserialize) and revert every real swap.
                roled('bmx', cfg.bitmapExtensionExists ? cfg.bitmapExtension : METEORA_DLMM_PROGRAM_ID),
                roled('rx', cfg.reserveX, true),
                roled('ry', cfg.reserveY, true),
                { ref: swapForY ? user.inAta : user.outAta, writable: true }, // user_token_in (x-side)
                { ref: swapForY ? user.outAta : user.inAta, writable: true }, // user_token_out (y-side)
                roled('mx', cfg.tokenXMint),
                roled('my', cfg.tokenYMint),
                roled('orc', cfg.oracle, true),
                roled('prog', METEORA_DLMM_PROGRAM_ID), // host_fee_in (optional -> program placeholder)
                { ref: user.owner, signer: true },
                roled('tpx', TOKEN_PROGRAM),
                roled('tpy', TOKEN_PROGRAM),
                roled('evt', EVENT_AUTHORITY),
                roled('prog', METEORA_DLMM_PROGRAM_ID),
                // remaining accounts: only the bin arrays that ACTUALLY EXIST on-chain
                // (the contiguous readable prefix — every shipped liquid bin lives in
                // it). Shipping a derived-but-uninitialized bin-array PDA reverts the
                // swap, and the capacity clamp already keeps the walk inside this set.
                ...window.binArrays.slice(0, window.readable).map((addr, i) => roled(`ba${i}`, addr, true)),
            ],
        };
    },
    referenceQuote(base, state, params, now) {
        const cfg = dlmmConfig(base);
        const swapForY = cfg.direction === 'xToY';
        const fee = feeParamsFromCfg(cfg, params);
        const live = liveFromState(cfg, state, fee, now ?? BigInt(Math.floor(Date.now() / 1000)));
        const kept = effectiveBins(cfg, state, live, params);
        return (x) => coldWalk(kept, fee, live, swapForY, x) ?? 0n;
    },
    referenceLadderQuotes(base, state, params, now) {
        const cfg = dlmmConfig(base);
        const swapForY = cfg.direction === 'xToY';
        const fee = feeParamsFromCfg(cfg, params);
        const live = liveFromState(cfg, state, fee, now ?? BigInt(Math.floor(Date.now() / 1000)));
        const kept = effectiveBins(cfg, state, live, params);
        return (grid) => {
            let lo = 0n;
            let capped = false;
            return grid.map((g) => {
                if (!capped && g > 0n) {
                    const { out, cap } = coldWalkClamped(kept, fee, live, swapForY, g);
                    lo = out; // fully absorbed: q(g); exhausted: q(cap) at the last shipped bin
                    if (cap < g)
                        capped = true;
                }
                return lo;
            });
        };
    },
    referenceCapacities(base, state, params, now) {
        const cfg = dlmmConfig(base);
        const swapForY = cfg.direction === 'xToY';
        const fee = feeParamsFromCfg(cfg, params);
        const live = liveFromState(cfg, state, fee, now ?? BigInt(Math.floor(Date.now() / 1000)));
        const kept = effectiveBins(cfg, state, live, params);
        return (grid) => {
            let cap = 0n;
            let capped = false;
            return grid.map((g) => {
                if (!capped && g > 0n) {
                    const clamped = coldWalkClamped(kept, fee, live, swapForY, g);
                    cap = clamped.cap; // grid point when absorbed; productive input at the window edge
                    if (clamped.cap < g)
                        capped = true;
                }
                return cap;
            });
        };
    },
    /** Depth proxy: the shipped window's out-side liquidity + the input to drain it. */
    depthReserves(base, state, now) {
        const cfg = dlmmConfig(base);
        const swapForY = cfg.direction === 'xToY';
        const params = this.paramsFor(cfg);
        const fee = feeParamsFromCfg(cfg, params);
        const live = liveFromState(cfg, state, fee, now ?? BigInt(Math.floor(Date.now() / 1000)));
        const kept = effectiveBins(cfg, state, live, params);
        let reserveOut = 0n;
        let reserveIn = 0n;
        for (const bin of kept) {
            reserveOut += bin.amount;
            reserveIn += binAmountIn(bin.amount, bin.price, swapForY, 'up');
        }
        return { reserveIn, reserveOut };
    },
    continuousFees(base, state, params) {
        const cfg = dlmmConfig(base);
        const fee = feeParamsFromCfg(cfg, params.length >= FEE_PARAM_COUNT ? params : this.paramsFor(cfg));
        const live = liveFromState(cfg, state, fee, BigInt(Math.floor(Date.now() / 1000)));
        // Base + active-bin volatility fee, in ppm (FEE_PRECISION 1e9 -> ppm /1e3).
        const tfee = totalFeeForBin(fee, live, live.bActive);
        return { gammaPpm: 1000000n - tfee / 1000n, muPpm: 1000000n };
    },
};
//# sourceMappingURL=ladder.js.map