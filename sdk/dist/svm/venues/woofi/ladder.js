import { readUintLE } from '../math.js';
import { OFF_ORACLE_PRICE, OFF_ORACLE_SPREAD, OFF_ORACLE_UPDATED_AT, OFF_PYTH_PRICE, OFF_PYTH_PUBLISH_TIME, OFF_PYTH_VERIFICATION_TAG, ONE_E18, ONE_E5, PYTH_VERIFICATION_FULL, WOOFI_PROGRAM_ID, WOOFI_SWAP_DISCRIMINATOR, woofiSwapAccounts, } from './index.js';
const SLUG = 'woofi';
const U64_MAX = (1n << 64n) - 1n;
/** SPL token account `amount` u64 LE offset. */
const AMOUNT_OFF = 64;
/** WooConfig.paused: disc(8) + authority(32) = 40. */
const WOOCONFIG_PAUSED_OFF = 40;
/** cfg words per slot: 9 single u64 params + 5 hi/lo u128 pairs. */
const PARAM_COUNT = 19;
function woofiConfig(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config`);
    return cfg;
}
const ref = (slot, role) => `s${slot}:${role}`;
/** `get_price_impl`, mirrored bit-for-bit (see file header). Returns 0 on any self-drop condition. */
export function woofiPriceOut(i) {
    if (i.paused)
        return 0n;
    if (!i.basePythVerified || !i.quotePythVerified)
        return 0n;
    if (i.basePythPublishTime + i.maximumAge < i.now)
        return 0n;
    if (i.quotePythPublishTime + i.maximumAge < i.now)
        return 0n;
    if (i.quotePythPrice <= 0n)
        return 0n;
    const cloPrice = (i.basePythPrice * i.pythQuoteDecPow) / i.quotePythPrice;
    if (cloPrice === 0n)
        return 0n;
    if (i.now > i.updatedAt + i.staleDuration)
        return 0n;
    const lo = (cloPrice * (ONE_E18 - i.bound)) / ONE_E18;
    const hi = (cloPrice * (ONE_E18 + i.bound)) / ONE_E18;
    if (i.wooraclePrice < lo || i.wooraclePrice > hi)
        return 0n;
    if (i.wooraclePrice < i.rangeMin || i.wooraclePrice > i.rangeMax)
        return 0n;
    return i.wooraclePrice;
}
/** `calc_quote_amount_sell_base` (swap_math.rs), mirrored bit-for-bit. 0 on any of its own requires failing. */
export function woofiCalcQuoteAmountSellBase(x, priceOut, coeff, spread, priceDec, quoteDec, baseDec, maxGamma, maxNotionalSwap) {
    if (priceOut <= 0n || x <= 0n)
        return 0n;
    const calcA = (x * priceOut) / priceDec;
    const notional = (calcA * quoteDec) / baseDec;
    if (notional > maxNotionalSwap)
        return 0n;
    const gamma = (calcA * coeff) / baseDec;
    if (gamma > maxGamma)
        return 0n;
    const calcB = ONE_E18 - gamma - spread;
    if (calcB <= 0n)
        return 0n;
    const calcC = (calcA * calcB) / ONE_E18;
    return (calcC * quoteDec) / baseDec;
}
/** `calc_base_amount_sell_quote` (swap_math.rs), mirrored bit-for-bit. */
export function woofiCalcBaseAmountSellQuote(q, priceOut, coeff, spread, priceDec, quoteDec, baseDec, maxGamma, maxNotionalSwap) {
    if (priceOut <= 0n || q <= 0n)
        return 0n;
    if (q > maxNotionalSwap)
        return 0n;
    const gamma = (q * coeff) / quoteDec;
    if (gamma > maxGamma)
        return 0n;
    const calcA = q * baseDec;
    const calcB = (calcA * priceDec) / priceOut;
    const calcC = ONE_E18 - gamma - spread;
    if (calcC <= 0n)
        return 0n;
    const calcD = (calcB * calcC) / ONE_E18;
    return calcD / quoteDec;
}
/** ceil(a*b/c), non-negative operands only. */
function mulCeilDiv(a, b, c) {
    return (a * b + (c - 1n)) / c;
}
/** The fee both directions charge once, ROUNDING UP (see file header). Returns the NET quote amount (never negative). */
export function woofiApplyFee(quoteAmount, feeRate) {
    const fee = mulCeilDiv(quoteAmount, feeRate, ONE_E5);
    return fee > quoteAmount ? 0n : quoteAmount - fee;
}
/** sellBase capacity: the largest x (base units) that keeps every closed-form cap satisfied (0 if priceOut deactivated). */
export function woofiSellBaseCapacity(priceOut, priceDec, quoteDec, baseDec, coeff, maxGamma, maxNotionalSwap, capBal, minSwapAmount, quoteVaultAvailable) {
    if (priceOut <= 0n)
        return 0n;
    const calcACapNotional = (maxNotionalSwap * baseDec) / quoteDec;
    const calcACapGamma = coeff > 0n ? (maxGamma * baseDec) / coeff : U64_MAX;
    const calcACapVault = (quoteVaultAvailable * baseDec) / quoteDec;
    let calcACap = calcACapNotional < calcACapGamma ? calcACapNotional : calcACapGamma;
    if (calcACapVault < calcACap)
        calcACap = calcACapVault;
    let cap = (calcACap * priceDec) / priceOut;
    if (capBal < cap)
        cap = capBal;
    if (minSwapAmount > 0n && cap < minSwapAmount)
        cap = 0n;
    return cap < 0n ? 0n : cap;
}
/** sellQuote capacity: the largest x (quote units) that keeps every closed-form cap satisfied. */
export function woofiSellQuoteCapacity(priceOut, priceDec, quoteDec, baseDec, coeff, maxGamma, maxNotionalSwap, capBal, baseVaultAvailable) {
    if (priceOut <= 0n)
        return 0n;
    const capGamma = coeff > 0n ? (maxGamma * quoteDec) / coeff : U64_MAX;
    const capBalX = (capBal * priceOut * quoteDec) / (baseDec * priceDec);
    const capVaultX = (baseVaultAvailable * priceOut * quoteDec) / (baseDec * priceDec);
    let cap = maxNotionalSwap < capGamma ? maxNotionalSwap : capGamma;
    if (capBalX < cap)
        cap = capBalX;
    if (capVaultX < cap)
        cap = capVaultX;
    return cap < 0n ? 0n : cap;
}
function liveState(cfg, state, now) {
    const wooconfigData = state[cfg.wooconfig];
    const oracleData = state[cfg.wooracleBase];
    const basePyth = state[cfg.priceUpdateBase];
    const quotePyth = state[cfg.priceUpdateQuote];
    const vaultData = state[cfg.direction === 'sellBase' ? cfg.quoteTokenVault : cfg.tokenVaultBase];
    if (wooconfigData === undefined)
        throw new Error(`${SLUG} reference is missing wooconfig ${cfg.wooconfig}`);
    if (oracleData === undefined)
        throw new Error(`${SLUG} reference is missing wooracle ${cfg.wooracleBase}`);
    if (basePyth === undefined)
        throw new Error(`${SLUG} reference is missing price-update ${cfg.priceUpdateBase}`);
    if (quotePyth === undefined)
        throw new Error(`${SLUG} reference is missing price-update ${cfg.priceUpdateQuote}`);
    if (vaultData === undefined)
        throw new Error(`${SLUG} reference is missing a capacity vault`);
    const paused = wooconfigData[WOOCONFIG_PAUSED_OFF] !== 0;
    const wooraclePrice = readUintLE(oracleData, OFF_ORACLE_PRICE, 8) | (readUintLE(oracleData, OFF_ORACLE_PRICE + 8, 8) << 64n);
    const updatedAt = readUintLE(oracleData, OFF_ORACLE_UPDATED_AT, 8);
    const spread = readUintLE(oracleData, OFF_ORACLE_SPREAD, 8);
    const basePythVerified = readUintLE(basePyth, OFF_PYTH_VERIFICATION_TAG, 1) === BigInt(PYTH_VERIFICATION_FULL);
    const basePythPrice = readUintLE(basePyth, OFF_PYTH_PRICE, 8);
    const basePythPublishTime = readUintLE(basePyth, OFF_PYTH_PUBLISH_TIME, 8);
    const quotePythVerified = readUintLE(quotePyth, OFF_PYTH_VERIFICATION_TAG, 1) === BigInt(PYTH_VERIFICATION_FULL);
    const quotePythPrice = readUintLE(quotePyth, OFF_PYTH_PRICE, 8);
    const quotePythPublishTime = readUintLE(quotePyth, OFF_PYTH_PUBLISH_TIME, 8);
    const vaultAvailable = readUintLE(vaultData, AMOUNT_OFF, 8);
    const priceOut = woofiPriceOut({
        now,
        wooraclePrice,
        updatedAt,
        staleDuration: cfg.staleDuration,
        bound: cfg.bound,
        rangeMin: cfg.rangeMin,
        rangeMax: cfg.rangeMax,
        maximumAge: cfg.maximumAge,
        basePythPrice,
        basePythPublishTime,
        basePythVerified,
        quotePythPrice,
        quotePythPublishTime,
        quotePythVerified,
        pythQuoteDecPow: cfg.pythQuoteDecPow,
        paused,
    });
    const capacity = cfg.direction === 'sellBase'
        ? woofiSellBaseCapacity(priceOut, cfg.priceDec, cfg.quoteDec, cfg.baseDec, cfg.coeff, cfg.maxGamma, cfg.maxNotionalSwap, cfg.capBal, cfg.minSwapAmount, vaultAvailable)
        : woofiSellQuoteCapacity(priceOut, cfg.priceDec, cfg.quoteDec, cfg.baseDec, cfg.coeff, cfg.maxGamma, cfg.maxNotionalSwap, cfg.capBal, vaultAvailable);
    return { priceOut, capacity, spread };
}
function referenceQuoteOf(cfg, x, live) {
    if (x <= 0n || live.priceOut <= 0n)
        return 0n;
    const cx = x > live.capacity ? live.capacity : x;
    if (cx <= 0n)
        return 0n;
    if (cfg.direction === 'sellBase') {
        const quoteAmount = woofiCalcQuoteAmountSellBase(cx, live.priceOut, cfg.coeff, live.spread, cfg.priceDec, cfg.quoteDec, cfg.baseDec, cfg.maxGamma, cfg.maxNotionalSwap);
        return woofiApplyFee(quoteAmount, cfg.feeRate);
    }
    const net = woofiApplyFee(cx, cfg.feeRate);
    return woofiCalcBaseAmountSellQuote(net, live.priceOut, cfg.coeff, live.spread, cfg.priceDec, cfg.quoteDec, cfg.baseDec, cfg.maxGamma, cfg.maxNotionalSwap);
}
function paramExprs(params) {
    const [priceDec, quoteDec, baseDec, coeff, feeRate, bound, staleDuration, maximumAge, pythQuoteDecPow, maxGammaHi, maxGammaLo, maxNotionalHi, maxNotionalLo, capBalHi, capBalLo, rangeMinHi, rangeMinLo, rangeMaxHi, rangeMaxLo,] = params;
    return {
        priceDec, quoteDec, baseDec, coeff, feeRate, bound, staleDuration, maximumAge, pythQuoteDecPow,
        maxGammaHi, maxGammaLo, maxNotionalHi, maxNotionalLo, capBalHi, capBalLo, rangeMinHi, rangeMinLo, rangeMaxHi, rangeMaxLo,
    };
}
export const woofiLadder = {
    slug: SLUG,
    defaultRungs: 4,
    shapeKey(base) {
        return `${SLUG}:${woofiConfig(base).direction}`;
    },
    helpers() {
        return [];
    },
    paramCount: PARAM_COUNT,
    paramsFor(base) {
        const c = woofiConfig(base);
        return [
            c.priceDec,
            c.quoteDec,
            c.baseDec,
            c.coeff,
            c.feeRate,
            c.bound,
            c.staleDuration,
            c.maximumAge,
            c.pythQuoteDecPow,
            c.maxGamma >> 64n,
            c.maxGamma & U64_MAX,
            c.maxNotionalSwap >> 64n,
            c.maxNotionalSwap & U64_MAX,
            c.capBal >> 64n,
            c.capBal & U64_MAX,
            c.rangeMin >> 64n,
            c.rangeMin & U64_MAX,
            c.rangeMax >> 64n,
            c.rangeMax & U64_MAX,
        ];
    },
    quoteRefs(base, slot) {
        const c = woofiConfig(base);
        const vault = c.direction === 'sellBase' ? c.quoteTokenVault : c.tokenVaultBase;
        // Both vaults ride the state map: `vc` is the ONLY one the fragment itself
        // reads (the capacity clamp, direction-selected); `vo` (the OTHER side's
        // vault) is never read on-chain but depthReserves (the off-chain
        // relative-depth filter) needs BOTH reserveIn and reserveOut — it is
        // already part of the swap CPI's 17-account list either way (buildSwapV2
        // attaches both unconditionally), so this adds no new on-chain account.
        const otherVault = c.direction === 'sellBase' ? c.tokenVaultBase : c.quoteTokenVault;
        return [
            { ref: ref(slot, 'wc'), address: c.wooconfig },
            { ref: ref(slot, 'or'), address: c.wooracleBase },
            { ref: ref(slot, 'pb'), address: c.priceUpdateBase },
            { ref: ref(slot, 'pq'), address: c.priceUpdateQuote },
            { ref: ref(slot, 'vc'), address: vault },
            { ref: ref(slot, 'vo'), address: otherVault },
        ];
    },
    emitSetup(base, slot, params, enableVar) {
        const c = woofiConfig(base);
        const p = `s${slot}`;
        const en = enableVar ?? `${p}en`;
        const wc = JSON.stringify(ref(slot, 'wc'));
        const or = JSON.stringify(ref(slot, 'or'));
        const pb = JSON.stringify(ref(slot, 'pb'));
        const pq = JSON.stringify(ref(slot, 'pq'));
        const vc = JSON.stringify(ref(slot, 'vc'));
        const pe = paramExprs(params);
        const sellBase = c.direction === 'sellBase';
        const lines = [];
        // Unconditional live reads (must be readable regardless of enable) + the
        // named locals emitLadderQuote/emitFinalQuote reference (they receive no
        // params of their own — only slot-scoped locals set up here).
        lines.push(`  const ${p}paused = accountUint(${wc}, ${WOOCONFIG_PAUSED_OFF}, 1);`);
        lines.push(`  const ${p}oplo = accountUint(${or}, ${OFF_ORACLE_PRICE}, 8);`);
        lines.push(`  const ${p}ophi = accountUint(${or}, ${OFF_ORACLE_PRICE + 8}, 8);`);
        lines.push(`  const ${p}op = (${p}ophi << 64) | ${p}oplo;`);
        lines.push(`  const ${p}upd = accountUint(${or}, ${OFF_ORACLE_UPDATED_AT}, 8);`);
        lines.push(`  const ${p}spr = accountUint(${or}, ${OFF_ORACLE_SPREAD}, 8);`);
        lines.push(`  const ${p}bvt = accountUint(${pb}, ${OFF_PYTH_VERIFICATION_TAG}, 1);`);
        lines.push(`  const ${p}bpx = accountUint(${pb}, ${OFF_PYTH_PRICE}, 8);`);
        lines.push(`  const ${p}bpt = accountUint(${pb}, ${OFF_PYTH_PUBLISH_TIME}, 8);`);
        lines.push(`  const ${p}qvt = accountUint(${pq}, ${OFF_PYTH_VERIFICATION_TAG}, 1);`);
        lines.push(`  const ${p}qpx = accountUint(${pq}, ${OFF_PYTH_PRICE}, 8);`);
        lines.push(`  const ${p}qpt = accountUint(${pq}, ${OFF_PYTH_PUBLISH_TIME}, 8);`);
        lines.push(`  const ${p}vav = accountUint(${vc}, ${AMOUNT_OFF}, 8);`);
        lines.push(`  const ${p}maxg = (${pe.maxGammaHi} << 64) | ${pe.maxGammaLo};`);
        lines.push(`  const ${p}maxn = (${pe.maxNotionalHi} << 64) | ${pe.maxNotionalLo};`);
        lines.push(`  const ${p}cbal = (${pe.capBalHi} << 64) | ${pe.capBalLo};`);
        lines.push(`  const ${p}rmin = (${pe.rangeMinHi} << 64) | ${pe.rangeMinLo};`);
        lines.push(`  const ${p}rmax = (${pe.rangeMaxHi} << 64) | ${pe.rangeMaxLo};`);
        lines.push(`  const ${p}pdec = ${pe.priceDec};`);
        lines.push(`  const ${p}qdec = ${pe.quoteDec};`);
        lines.push(`  const ${p}bdec = ${pe.baseDec};`);
        lines.push(`  const ${p}coef = ${pe.coeff};`);
        lines.push(`  const ${p}feer = ${pe.feeRate};`);
        // Gated (pointless work when the slot is disabled): price_out + capacity.
        lines.push(`  let ${p}po = 0;`);
        lines.push(`  let ${p}icap = 0;`);
        lines.push(`  if (${en} !== 0) {`);
        lines.push(`    let ${p}ok = 1;`);
        lines.push(`    if (${p}paused !== 0) { ${p}ok = 0 }`);
        lines.push(`    if (${p}bvt !== ${PYTH_VERIFICATION_FULL}) { ${p}ok = 0 }`);
        lines.push(`    if (${p}qvt !== ${PYTH_VERIFICATION_FULL}) { ${p}ok = 0 }`);
        lines.push(`    if (${p}bpt + ${pe.maximumAge} < block.timestamp) { ${p}ok = 0 }`);
        lines.push(`    if (${p}qpt + ${pe.maximumAge} < block.timestamp) { ${p}ok = 0 }`);
        lines.push(`    if (${p}qpx <= 0) { ${p}ok = 0 }`);
        lines.push(`    if (${p}ok !== 0) {`);
        lines.push(`      const ${p}clo = (${p}bpx * ${pe.pythQuoteDecPow}) / ${p}qpx;`);
        lines.push(`      if (${p}clo === 0) { ${p}ok = 0 }`);
        lines.push(`      else {`);
        lines.push(`        if (block.timestamp > ${p}upd + ${pe.staleDuration}) { ${p}ok = 0 }`);
        lines.push(`        const ${p}lo = (${p}clo * (${ONE_E18} - ${pe.bound})) / ${ONE_E18};`);
        lines.push(`        const ${p}hi = (${p}clo * (${ONE_E18} + ${pe.bound})) / ${ONE_E18};`);
        lines.push(`        if (${p}op < ${p}lo) { ${p}ok = 0 }`);
        lines.push(`        if (${p}op > ${p}hi) { ${p}ok = 0 }`);
        lines.push(`        if (${p}op < ${p}rmin) { ${p}ok = 0 }`);
        lines.push(`        if (${p}op > ${p}rmax) { ${p}ok = 0 }`);
        lines.push(`      }`);
        lines.push(`    }`);
        lines.push(`    if (${p}ok !== 0) { ${p}po = ${p}op }`);
        lines.push(`    if (${p}po > 0) {`);
        if (sellBase) {
            lines.push(`      const ${p}ca1 = (${p}maxn * ${p}bdec) / ${p}qdec;`);
            lines.push(`      let ${p}ca2 = ${U64_MAX};`);
            lines.push(`      if (${p}coef > 0) { ${p}ca2 = (${p}maxg * ${p}bdec) / ${p}coef }`);
            lines.push(`      const ${p}ca3 = (${p}vav * ${p}bdec) / ${p}qdec;`);
            lines.push(`      let ${p}cac = ${p}ca1;`);
            lines.push(`      if (${p}ca2 < ${p}cac) { ${p}cac = ${p}ca2 }`);
            lines.push(`      if (${p}ca3 < ${p}cac) { ${p}cac = ${p}ca3 }`);
            lines.push(`      ${p}icap = (${p}cac * ${p}pdec) / ${p}po;`);
            lines.push(`      if (${p}cbal < ${p}icap) { ${p}icap = ${p}cbal }`);
            lines.push(`      if (${p}icap < 0) { ${p}icap = 0 }`);
        }
        else {
            lines.push(`      let ${p}cg = ${U64_MAX};`);
            lines.push(`      if (${p}coef > 0) { ${p}cg = (${p}maxg * ${p}qdec) / ${p}coef }`);
            lines.push(`      const ${p}cbx = (${p}cbal * ${p}po * ${p}qdec) / (${p}bdec * ${p}pdec);`);
            lines.push(`      const ${p}cvx = (${p}vav * ${p}po * ${p}qdec) / (${p}bdec * ${p}pdec);`);
            lines.push(`      ${p}icap = ${p}maxn;`);
            lines.push(`      if (${p}cg < ${p}icap) { ${p}icap = ${p}cg }`);
            lines.push(`      if (${p}cbx < ${p}icap) { ${p}icap = ${p}cbx }`);
            lines.push(`      if (${p}cvx < ${p}icap) { ${p}icap = ${p}cvx }`);
            lines.push(`      if (${p}icap < 0) { ${p}icap = 0 }`);
        }
        lines.push(`    }`);
        lines.push(`  }`);
        // capacityInputVar slot-scoped local (reassigned per rung by emitLadderQuote) +
        // quoteBody's scratch locals — pre-declared ONCE here (not per rung: emitLadderQuote
        // is called once per rung and must only ASSIGN, never re-`let`/`const`, a name that
        // would then be declared at multiple program points — see quoteBody's doc comment).
        lines.push(`  let ${p}cx = 0;`);
        lines.push(`  let ${p}ca = 0; let ${p}not = 0; let ${p}gok = 0; let ${p}gam = 0;`);
        lines.push(`  let ${p}cb = 0; let ${p}cc = 0; let ${p}qa = 0; let ${p}swf = 0;`);
        lines.push(`  let ${p}net = 0; let ${p}cd = 0;`);
        return lines.join('\n');
    },
    capacityInputVar(slot) {
        return `s${slot}cx`;
    },
    emitLadderQuote(base, slot, _rung, x, outVar) {
        const c = woofiConfig(base);
        const p = `s${slot}`;
        return [
            `    ${p}cx = ${x};`,
            `    if (${p}cx > ${p}icap) { ${p}cx = ${p}icap }`,
            quoteBody(c, p, `${p}cx`, outVar),
        ].join('\n');
    },
    emitFinalQuote(base, slot, x, outVar) {
        const c = woofiConfig(base);
        const p = `s${slot}`;
        return [
            `  let ${p}fcx = ${x};`,
            `  if (${p}fcx > ${p}icap) { ${p}fcx = ${p}icap }`,
            quoteBody(c, p, `${p}fcx`, outVar),
        ].join('\n');
    },
    buildSwapV2(base, slot, user) {
        const c = woofiConfig(base);
        const make = (r, addr, writable) => writable ? { ref: r, address: addr, writable: true } : { ref: r, address: addr };
        return {
            programId: WOOFI_PROGRAM_ID,
            prefix: Uint8Array.from(WOOFI_SWAP_DISCRIMINATOR),
            // min_to_amount u128 LE = 1 (the recipe's terminal delta owns the bound).
            suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            patch: 'in',
            accounts: woofiSwapAccounts(c, user, make, (role) => ref(slot, role)),
        };
    },
    referenceQuote(base, state, params, now) {
        const cfg = woofiConfig(base);
        const live = liveState(cfg, state, now ?? 0n);
        return (x) => referenceQuoteOf(cfg, x, live);
    },
    /** Stateless per-rung (every grid point is its own closed-form evaluation) — mirrors the `min(x, icap)` clamp. */
    referenceLadderQuotes(base, state, params, now) {
        const cfg = woofiConfig(base);
        const live = liveState(cfg, state, now ?? 0n);
        return (grid) => grid.map((x) => referenceQuoteOf(cfg, x, live));
    },
    referenceCapacities(base, state, params, now) {
        const cfg = woofiConfig(base);
        const live = liveState(cfg, state, now ?? 0n);
        return (grid) => grid.map((g) => (g > live.capacity ? live.capacity : g));
    },
    depthReserves(base, state) {
        const cfg = woofiConfig(base);
        const inVaultAddr = cfg.direction === 'sellBase' ? cfg.tokenVaultBase : cfg.quoteTokenVault;
        const outVaultAddr = cfg.direction === 'sellBase' ? cfg.quoteTokenVault : cfg.tokenVaultBase;
        const inData = state[inVaultAddr];
        const outData = state[outVaultAddr];
        if (inData === undefined || outData === undefined)
            throw new Error(`${SLUG} depth is missing a vault`);
        return { reserveIn: readUintLE(inData, AMOUNT_OFF, 8), reserveOut: readUintLE(outData, AMOUNT_OFF, 8) };
    },
    continuousFees(base) {
        // feeRate is 1e5-scaled (parts per 100,000); rescale to ppm (parts per 1e6).
        const c = woofiConfig(base);
        let feePpm = c.feeRate * 10n;
        if (feePpm > 1000000n)
            feePpm = 1000000n;
        return { gammaPpm: 1000000n, muPpm: 1000000n - feePpm };
    },
};
/**
 * Shared per-rung/final quote statement lines, over the already-clamped local
 * `cxVar` — sellBase and sellQuote diverge in formula ORDER (convert-then-fee
 * vs fee-then-convert), see swap_math.rs / the file header.
 *
 * NO `let`/`const` on the scratch locals here (only plain reassignment) —
 * `emitLadderQuote` calls this ONCE PER RUNG, so a fresh declaration would be
 * emitted at multiple program points for the same name. Every scratch local
 * this function touches (${p}ca/not/gok/gam/cb/cc/qa/swf/net/cd) is
 * pre-declared exactly once, unconditionally, in emitSetup. `outVar` alone is
 * `let`-fresh here because the caller (the codegen framework) supplies a
 * distinct name per call site.
 */
function quoteBody(c, p, cxVar, outVar) {
    const sellBase = c.direction === 'sellBase';
    const lines = [];
    lines.push(`    let ${outVar} = 0;`);
    lines.push(`    if (${cxVar} > 0 && ${p}po > 0) {`);
    if (sellBase) {
        lines.push(`      ${p}ca = (${cxVar} * ${p}po) / ${p}pdec;`);
        lines.push(`      ${p}not = (${p}ca * ${p}qdec) / ${p}bdec;`);
        lines.push(`      ${p}gok = 1;`);
        lines.push(`      if (${p}not > ${p}maxn) { ${p}gok = 0 }`);
        lines.push(`      ${p}gam = (${p}ca * ${p}coef) / ${p}bdec;`);
        lines.push(`      if (${p}gam > ${p}maxg) { ${p}gok = 0 }`);
        lines.push(`      if (${p}gok !== 0) {`);
        lines.push(`        ${p}cb = ${ONE_E18} - ${p}gam - ${p}spr;`);
        lines.push(`        if (${p}cb > 0) {`);
        lines.push(`          ${p}cc = (${p}ca * ${p}cb) / ${ONE_E18};`);
        lines.push(`          ${p}qa = (${p}cc * ${p}qdec) / ${p}bdec;`);
        lines.push(`          ${p}swf = (${p}qa * ${p}feer + ${ONE_E5} - 1) / ${ONE_E5};`);
        lines.push(`          if (${p}swf <= ${p}qa) { ${outVar} = ${p}qa - ${p}swf }`);
        lines.push(`        }`);
        lines.push(`      }`);
    }
    else {
        lines.push(`      ${p}swf = (${cxVar} * ${p}feer + ${ONE_E5} - 1) / ${ONE_E5};`);
        lines.push(`      ${p}net = 0;`);
        lines.push(`      if (${p}swf <= ${cxVar}) { ${p}net = ${cxVar} - ${p}swf }`);
        lines.push(`      if (${p}net > 0) {`);
        lines.push(`        ${p}gok = 1;`);
        lines.push(`        if (${p}net > ${p}maxn) { ${p}gok = 0 }`);
        lines.push(`        ${p}gam = (${p}net * ${p}coef) / ${p}qdec;`);
        lines.push(`        if (${p}gam > ${p}maxg) { ${p}gok = 0 }`);
        lines.push(`        if (${p}gok !== 0) {`);
        lines.push(`          ${p}ca = ${p}net * ${p}bdec;`);
        lines.push(`          ${p}cb = (${p}ca * ${p}pdec) / ${p}po;`);
        lines.push(`          ${p}cc = ${ONE_E18} - ${p}gam - ${p}spr;`);
        lines.push(`          if (${p}cc > 0) {`);
        lines.push(`            ${p}cd = (${p}cb * ${p}cc) / ${ONE_E18};`);
        lines.push(`            ${outVar} = ${p}cd / ${p}qdec;`);
        lines.push(`          }`);
        lines.push(`        }`);
        lines.push(`      }`);
    }
    lines.push(`    }`);
    return lines.join('\n');
}
//# sourceMappingURL=ladder.js.map