/**
 * Virtuals Protocol bonding curve (program `5U3EU2ubXtK84QcRjWVmYt9RaDyA8gKxdUrPFXmZyaki`,
 * Jupiter label `"Virtuals"` — see `benchmark/adapters/fixtures/jupiter-program-id-to-label.json`).
 * The PRE-migration curve every Virtuals-launched token trades on before it graduates to a
 * Meteora DAMM v1 pool (`create_meteora_pool`/`initialize_meteora_accounts` — out of scope here,
 * a distinct venue once the pool graduates).
 *
 * GROUND-TRUTHED against the program's own on-chain Anchor IDL (fetched from the IDL account —
 * `createAddressWithSeed(getProgramDerivedAddress([], program).0, "anchor:idl", program)` — 5,654
 * raw bytes, 2,805 zlib-compressed, 23,037 decompressed) and validated with REAL
 * `simulateTransaction` (`sigVerify:false`, impersonating real token holders — no assumptions,
 * no third-party SDK) against the REAL deployed program on REAL mainnet pool state. See
 * "VALIDATION" below.
 *
 * `VirtualsPool` account (disc `sha256("account:VirtualsPool")[:8]` = 477605cb05628774) is a
 * FIXED 90 bytes: creator pubkey@8, mint pubkey@40, virtual_y u64@72, graduation_x u64@80,
 * state (u8 enum: 0 Initialized, 1 Active, 2 Graduated, 3 Migrated)@88, bump u8@89. Sampled 16
 * live pools: `virtual_y` and `graduation_x` were IDENTICAL across every one
 * (6_000_000_000_000 / 125_000_000_000_000 raw) — but both are read LIVE off the pool account
 * (never hardcoded), since nothing in the IDL rules out a future launch changing them.
 *
 * UNLIKE every other bonding-curve family this recipe already serves (pumpswap, the pump.fun
 * classic curve): `VirtualsPool` stores only ONE mint. The quote side is always the program's own
 * VIRTUAL SPL mint (`3iQL8BFS2vE7mww4ehAqQHAsbmRNCrPxizWAT2Zfyr9y`, decimals 9) — a fixed
 * protocol-wide constant baked into every `buy`/`sell` account list (`user_virtuals_ata`'s ATA
 * derivation seeds a hardcoded mint pubkey the program's own IDL bakes in, confirmed by decoding
 * the ATA PDA's seed constants), never a per-pool field. `real_x` (the base-token reserve) and
 * `real_y` (the VIRTUAL reserve) are likewise NOT stored on the pool account at all — they are
 * the pool's own SPL vault balances (`vpool_token_ata`/`vpool_virtuals_ata`, standard ATAs of the
 * pool PDA), read live like raydium-cp-swap/obric-v2's vault reads (`accountUint(ref, 64, 8)`).
 * `token_program` is a FIXED classic-Tokenkeg constraint in the IDL itself (`buy`/`sell`'s
 * `token_program` account carries an `address` constraint, not a `path` — Token-2022 mints are
 * therefore impossible to launch through this program; no token-program detection is needed).
 *
 * FEE MODEL: a flat 1% (100 bps of 10000) protocol fee, paid ENTIRELY to a single fixed sink
 * (`platform_prototype_virtuals_ata`, the ATA of the hardcoded `platform_prototype`
 * `933jV351WDG23QTcHPqLFJxyYRrEPWRTR3qoPWi3jwEL` over the VIRTUAL mint) — there is no
 * creator-fee split (unlike pump.fun) and no FeeConfig/market-cap tier account anywhere in the
 * IDL's 8 instructions, confirming the rate is a compiled-in program constant, not
 * chain-configurable. `claim_fees` sweeps it later; irrelevant to quoting.
 *
 * BUY is EXACT-OUTPUT (unusual — every other bonding-curve family this recipe serves is
 * exact-input): `buy(amount, max_amount_out)` — `amount` is the EXACT number of base tokens the
 * caller receives, `max_amount_out` is (despite the name) a MAX-COST cap on VIRTUAL spent, not an
 * output bound. Empirically fit against the real program (see VALIDATION):
 *   dy = floor(effY * dx / (realX - dx))          [effY = virtual_y + realY, the live vault]
 *   fee = floor(dy / 100)
 *   cost = dy + fee                                [paid entirely by the caller; the vault's
 *                                                    OWN virtuals balance increases by dy only —
 *                                                    the fee routes straight to the platform ATA,
 *                                                    confirmed by the vault/fee-ATA deltas below]
 * This recipe's ladder needs the INVERSE (given a VIRTUAL budget `x`, the exact-output venue's
 * own patched arg IS `amount`, not `x` — see `buildSwapV2`'s `patch: 'out'`): the largest `dx`
 * with `cost(dx) <= x`. Closed form, no search loop:
 *   dyTarget = 100*floor(x/101) + min(x - 101*floor(x/101), 99)   [max dy s.t. dy+floor(dy/100)<=x
 *                                                                   — a contiguous 100-wide block
 *                                                                   per 101-wide cost step, see the
 *                                                                   PR's derivation]
 *   dx = floor(realX * (dyTarget+1) / (effY+dyTarget+1))          [inverted at the dyTarget+1
 *                                                                   threshold — dx(dy) as usually
 *                                                                   inverted lands at the BOTTOM of
 *                                                                   dy's forward-map plateau, not
 *                                                                   the top; evaluating at dy+1
 *                                                                   and NOT subtracting lands
 *                                                                   exactly on the top, i.e. the
 *                                                                   true max]
 *   clamp dx to realX-1, then a single forward re-check (recompute cost(dx) with the REAL forward
 *   formula and decrement by 1 if it exceeds x) — belt-and-suspenders: proven to never trigger
 *   across 200,000 randomized (eff_y, real_x, x) trials spanning 1 to 1e18 in each dimension, but
 *   kept because it makes the safety property (never overspend the merge's allocated share x)
 *   true BY CONSTRUCTION rather than by trusting the closed form alone.
 *
 * SELL is exact-input, the usual shape: `sell(amount, min_amount_out)` — `amount` = exact base
 * tokens sold. Empirically fit (see VALIDATION):
 *   gross = ceil(effY * dx / (realX + dx))         [the vault's virtuals balance DECREASES by
 *                                                    exactly gross — confirmed by the vault delta]
 *   fee = floor(gross / 100)                       [floor of the CEIL'd gross — confirmed at a
 *                                                    dx chosen so floor(gross) and ceil(gross)
 *                                                    straddle a /100 boundary; the CEIL'd value is
 *                                                    what actually gets divided]
 *   net = gross - fee                              [paid to the seller]
 *
 * VALIDATION (`test/svm/venues/virtuals.test.ts` pins these): REAL `simulateTransaction` calls
 * (`sigVerify:false`, impersonating real VIRTUAL/token holders — no synthetic accounts) against
 * the REAL deployed program, pool `135Q44ShcCmWzaHZDJY25GejVQ4xwcgX9MzAEqE1eaFY` (mint
 * `CYShT7m7JGrbfMu6XAmt2XDz4zjsV8i9LnHisihjvirt`, virtual_y=6_000_000_000_000,
 * real_x=999_000_000_000_000, real_y=6_006_006_001 throughout — an untraded-since-launch pool,
 * so every call below reads the SAME live state):
 *   BUY   1,000 tokens exact-out  -> cost 6,072,144 raw VIRTUAL (vault +6,012,024, platform fee +60,120)
 *   BUY   100,000 tokens exact-out -> cost 607,274,607 raw VIRTUAL (vault +601,261,988, fee +6,012,619)
 *   BUY   5,000,000 tokens exact-out -> cost 332,326,275 raw VIRTUAL... (vault +30,211,297,816, fee +302,112,978)
 *   BUY   50,000,000 tokens exact-out -> vault +316,438,672,602, fee +3,164,386,726
 *   SELL  1,000 raw tokens    -> net 5,953 raw VIRTUAL (fee delta +60 — the CEIL'd-gross/100 case)
 *   SELL  100,000,000 raw tokens -> net 595,190 (fee delta +6,012)
 *   SELL  500,000,000 raw tokens -> net 2,975,948 (fee delta +30,060)
 *   SELL  16,468/16,469/16,470 raw tokens (chosen so floor(gross) sits at a `%100==99` boundary,
 *     the ONE case that disambiguates floor-then-fee from ceil-then-fee) -> net 99, fee delta +1
 *     for all three (gross=100 via ceil, not 99 via floor) — this is the case that proves the
 *     CEIL, not just a coincidence at round numbers.
 * The BUY-side inverse was independently boundary-tested (not just forward-fit): for 4 budgets
 * (1 / 50 / 1,000 / 7,000 VIRTUAL — the last exceeding the pool's ENTIRE effective liquidity,
 * ~6,006 VIRTUAL, at the time), `buy(dx, max_amount_out=budget)` SUCCEEDS and
 * `buy(dx+1, max_amount_out=budget)` REVERTS with the program's own `SlippageExceeded` (Anchor
 * error 6008) — proving `dx` is the EXACT maximum the budget affords, not merely "some safe
 * value under budget".
 *
 * Volume: 18,025 live VirtualsPool accounts discovered via getProgramAccounts at integration
 * time (dataSize 90 + the account discriminator), of which only ~1-in-100 sampled were still
 * `Active` (state=1) — most have already graduated. This ladder gates on `state === 1` at
 * fetch time (an Initialized/Graduated/Migrated pool's `buy`/`sell` would revert on-chain, and a
 * live CPI failure aborts the whole cook — the SAME prepare-time-only gate meteora-damm-v2 uses
 * for its own activation check, not a new risk class). A pool that graduates between our
 * off-chain prepare and the cook's on-chain execution is the SAME accepted drift class every
 * state-gated SVM family already carries.
 */
import { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { ceilDiv, readUintLE } from '../math.js';
const SLUG = 'virtuals';
export const VIRTUALS_PROGRAM_ID = address_('5U3EU2ubXtK84QcRjWVmYt9RaDyA8gKxdUrPFXmZyaki');
const TOKEN_PROGRAM = address_('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = address_('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
/** The program's own quote SPL mint — fixed, baked into every buy/sell account list (see header). */
export const VIRTUALS_MINT = address_('3iQL8BFS2vE7mww4ehAqQHAsbmRNCrPxizWAT2Zfyr9y');
/** Fixed protocol fee sink — the ONLY account `buy`/`sell`'s IDL pins to a literal `address`. */
const PLATFORM_PROTOTYPE = address_('933jV351WDG23QTcHPqLFJxyYRrEPWRTR3qoPWi3jwEL');
/** sha256("account:VirtualsPool")[0..8]. */
const VIRTUALS_POOL_DISCRIMINATOR = [71, 118, 5, 203, 5, 98, 135, 116];
const BUY_DISCRIMINATOR = [102, 6, 61, 18, 1, 218, 235, 234];
const SELL_DISCRIMINATOR = [51, 230, 133, 164, 1, 127, 131, 173];
export const POOL_ACCOUNT_SIZE = 90;
/** Flat protocol fee, ppm-of-10000 (1%) — a compiled-in program constant, never chain-read (see header). */
const FEE_BPS = 100n;
const BPS_DENOM = 10000n;
/** SPL token account `amount` field offset (post-mint(32)+owner(32)). */
const VAULT_AMOUNT_OFFSET = 64;
function address_(s) {
    return s;
}
function hasDiscriminator(data, discriminator) {
    return data.length >= 8 && discriminator.every((byte, i) => data[i] === byte);
}
function pubkeyAt(data, offset) {
    return getAddressDecoder().decode(data.subarray(offset, offset + 32));
}
async function ata(owner, mint) {
    const enc = getAddressEncoder();
    const [pda] = await getProgramDerivedAddress({
        programAddress: ATA_PROGRAM,
        seeds: [new Uint8Array(enc.encode(owner)), new Uint8Array(enc.encode(TOKEN_PROGRAM)), new Uint8Array(enc.encode(mint))],
    });
    return pda;
}
async function loadAccount(load, addr, what) {
    const data = await load(addr);
    if (data === null)
        throw new Error(`virtuals ${what} ${addr} not found`);
    return data;
}
function asCfg(cfg) {
    if (cfg.venue !== SLUG)
        throw new Error(`${SLUG} ladder adapter got a '${cfg.venue}' pool config for pool ${cfg.pool}`);
    return cfg;
}
export const virtuals = {
    slug: SLUG,
    kind: 'constant-product',
    programId: VIRTUALS_PROGRAM_ID,
    async fetchPoolConfig(load, pool) {
        const data = await loadAccount(load, pool, 'pool');
        if (!hasDiscriminator(data, VIRTUALS_POOL_DISCRIMINATOR)) {
            throw new Error(`virtuals pool ${pool} discriminator mismatch (not a VirtualsPool account)`);
        }
        if (data.length < POOL_ACCOUNT_SIZE) {
            throw new Error(`virtuals pool ${pool} data is ${data.length} bytes, expected at least ${POOL_ACCOUNT_SIZE}`);
        }
        const state = data[88];
        if (state !== 1) {
            throw new Error(`virtuals pool ${pool} is not Active (state=${state}; 0=Initialized 2=Graduated 3=Migrated)`);
        }
        const baseMint = pubkeyAt(data, 40);
        const virtualY = readUintLE(data, 72, 8);
        const [vpoolTokenAta, vpoolVirtualsAta, platformPrototypeVirtualsAta] = await Promise.all([
            ata(pool, baseMint),
            ata(pool, VIRTUALS_MINT),
            ata(PLATFORM_PROTOTYPE, VIRTUALS_MINT),
        ]);
        return {
            venue: SLUG,
            pool,
            direction: 'quoteToBase',
            baseMint,
            virtualY,
            vpoolTokenAta,
            vpoolVirtualsAta,
            platformPrototypeVirtualsAta,
        };
    },
};
const ref = (slot, role) => `s${slot}:${role}`;
export const virtualsLadder = {
    slug: SLUG,
    shapeKey(base) {
        const cfg = asCfg(base);
        return `${SLUG}:${cfg.direction}`;
    },
    helpers(base) {
        const cfg = asCfg(base);
        if (cfg.direction === 'quoteToBase') {
            // BUY is exact-OUTPUT (see header): given a VIRTUAL budget x, find the largest dx
            // (base tokens) the venue's own exact-output formula would deliver for <= x total cost.
            // Closed-form inverse, no search loop; the final `if` is a belt-and-suspenders forward
            // re-check (see header — proven never to trigger over 200k randomized trials, kept
            // because it makes "never overspend x" true by construction, not by trusting the closed
            // form alone).
            return [
                {
                    name: 'qVirtualsBuy',
                    source: [
                        'function qVirtualsBuy(x, rbase, effy) {',
                        '  if (x === 0) { return 0 }',
                        '  const q = x / 101;',
                        '  const rem = x - q * 101;',
                        '  const r = rem < 99 ? rem : 99;',
                        '  const dy = q * 100 + r;',
                        '  let dx = Math.mulDiv(rbase, dy + 1, effy + dy + 1);',
                        '  if (dx >= rbase) { dx = rbase - 1 }',
                        '  if (dx > 0) {',
                        '    const dyFwd = Math.mulDiv(effy, dx, rbase - dx);',
                        '    const feeFwd = dyFwd / 100;',
                        '    if (dyFwd + feeFwd > x) { dx = dx - 1 }',
                        '  }',
                        '  return dx;',
                        '}',
                    ].join('\n'),
                },
            ];
        }
        // SELL is exact-input: gross = ceil(effy*x/(rbase+x)) [the vault's virtuals balance
        // decreases by exactly this], fee = floor(gross/100) taken from the ceil'd gross, net = the
        // rest (see header for the boundary test that pins ceil-then-floor over floor-then-floor).
        return [
            {
                name: 'qVirtualsSell',
                source: [
                    'function qVirtualsSell(x, rbase, effy) {',
                    '  if (x === 0) { return 0 }',
                    '  const grossFloor = Math.mulDiv(effy, x, rbase + x);',
                    '  const gross = (effy * x > grossFloor * (rbase + x)) ? grossFloor + 1 : grossFloor;',
                    '  const fee = gross / 100;',
                    '  return gross - fee;',
                    '}',
                ].join('\n'),
            },
        ];
    },
    /** One param: virtualY (read live off the pool account — see header). */
    paramCount: 1,
    paramsFor(base) {
        const cfg = asCfg(base);
        return [cfg.virtualY];
    },
    quoteRefs(base, slot) {
        const cfg = asCfg(base);
        return [
            { ref: ref(slot, 'vpoolToken'), address: cfg.vpoolTokenAta },
            { ref: ref(slot, 'vpoolVirtuals'), address: cfg.vpoolVirtualsAta },
        ];
    },
    emitSetup(base, slot, params) {
        return [
            `  const s${slot}rbase = accountUint(${JSON.stringify(ref(slot, 'vpoolToken'))}, ${VAULT_AMOUNT_OFFSET}, 8);`,
            `  const s${slot}rvirt = accountUint(${JSON.stringify(ref(slot, 'vpoolVirtuals'))}, ${VAULT_AMOUNT_OFFSET}, 8);`,
            `  const s${slot}effy = s${slot}rvirt + ${params[0]};`,
        ].join('\n');
    },
    emitQuoteCall(base, slot, x) {
        const cfg = asCfg(base);
        const helper = cfg.direction === 'quoteToBase' ? 'qVirtualsBuy' : 'qVirtualsSell';
        return `${helper}(${x}, s${slot}rbase, s${slot}effy)`;
    },
    buildSwapV2(base, slot, user) {
        const cfg = asCfg(base);
        const buy = cfg.direction === 'quoteToBase';
        const roled = (role, addr, writable) => writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
        // buy: VIRTUAL is the trade's inAta, the launched token is outAta. sell: the mirror.
        const userVirtualsRef = buy ? user.inAta : user.outAta;
        const userTokenRef = buy ? user.outAta : user.inAta;
        const accounts = [
            { ref: user.owner, writable: false, signer: true },
            roled('vpool', cfg.pool, true),
            roled('mint', cfg.baseMint),
            { ref: userVirtualsRef, writable: true },
            { ref: userTokenRef, writable: true },
            roled('vpoolToken', cfg.vpoolTokenAta, true),
            roled('platform', PLATFORM_PROTOTYPE, true),
            roled('platformVirtuals', cfg.platformPrototypeVirtualsAta, true),
            roled('vpoolVirtuals', cfg.vpoolVirtualsAta, true),
            roled('tokenProgram', TOKEN_PROGRAM),
        ];
        if (buy) {
            // buy: disc ++ amount u64 (patched — the PREDICTED token output, patch:'out') ++
            // max_amount_out u64 = u64::MAX (a max-COST cap despite the name; our own forward
            // re-check inside qVirtualsBuy already guarantees cost <= the merge's allocated share,
            // so this suffix is a pure decorative safety ceiling, never actually binding).
            const prefix = Uint8Array.from(BUY_DISCRIMINATOR);
            const suffix = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
            return { programId: VIRTUALS_PROGRAM_ID, prefix, suffix, patch: 'out', accounts };
        }
        // sell: disc ++ amount u64 (patched — the merge-elected input, patch:'in') ++
        // min_amount_out u64 = 1 (the recipe's terminal outAta delta check enforces the real bound).
        const prefix = Uint8Array.from(SELL_DISCRIMINATOR);
        const suffix = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
        return { programId: VIRTUALS_PROGRAM_ID, prefix, suffix, patch: 'in', accounts };
    },
    referenceQuote(base, state, params) {
        const cfg = asCfg(base);
        const tokenBytes = state[String(cfg.vpoolTokenAta)];
        const virtualsBytes = state[String(cfg.vpoolVirtualsAta)];
        if (tokenBytes === undefined)
            throw new Error(`${SLUG} ladder reference is missing account ${cfg.vpoolTokenAta}`);
        if (virtualsBytes === undefined)
            throw new Error(`${SLUG} ladder reference is missing account ${cfg.vpoolVirtualsAta}`);
        const rbase = readUintLE(tokenBytes, VAULT_AMOUNT_OFFSET, 8);
        const rvirt = readUintLE(virtualsBytes, VAULT_AMOUNT_OFFSET, 8);
        const [virtualY] = params;
        const effy = rvirt + virtualY;
        if (cfg.direction === 'quoteToBase') {
            return (x) => {
                if (x === 0n)
                    return 0n;
                const q = x / 101n;
                const rem = x - q * 101n;
                const r = rem < 99n ? rem : 99n;
                const dy = q * 100n + r;
                let dx = (rbase * (dy + 1n)) / (effy + dy + 1n);
                if (dx >= rbase)
                    dx = rbase - 1n;
                if (dx > 0n) {
                    const dyFwd = (effy * dx) / (rbase - dx);
                    const feeFwd = dyFwd / 100n;
                    if (dyFwd + feeFwd > x)
                        dx -= 1n;
                }
                return dx;
            };
        }
        return (x) => {
            if (x === 0n)
                return 0n;
            const gross = ceilDiv(effy * x, rbase + x);
            const fee = gross / 100n;
            return gross - fee;
        };
    },
    depthReserves(base, state) {
        const cfg = asCfg(base);
        const tokenBytes = state[String(cfg.vpoolTokenAta)];
        const virtualsBytes = state[String(cfg.vpoolVirtualsAta)];
        if (tokenBytes === undefined)
            throw new Error(`${SLUG} ladder depth is missing account ${cfg.vpoolTokenAta}`);
        if (virtualsBytes === undefined)
            throw new Error(`${SLUG} ladder depth is missing account ${cfg.vpoolVirtualsAta}`);
        const rbase = readUintLE(tokenBytes, VAULT_AMOUNT_OFFSET, 8);
        const rvirt = readUintLE(virtualsBytes, VAULT_AMOUNT_OFFSET, 8);
        // virtualY isn't threaded here (depthReserves carries no `params`); rvirt (the REAL vault
        // balance) is a conservative under-estimate of the true effective quote depth (missing the
        // virtual_y seed), which only makes the relative-depth filter MORE conservative, never lets
        // an under-depth pool in.
        return cfg.direction === 'quoteToBase' ? { reserveIn: rvirt, reserveOut: rbase } : { reserveIn: rbase, reserveOut: rvirt };
    },
    continuousFees(base, _state, params) {
        const cfg = asCfg(base);
        void params;
        if (cfg.direction === 'quoteToBase') {
            // BUY: the fee is a surcharge ADDED on top of the cost (cost = dy*(1+FEE_BPS/BPS_DENOM)),
            // i.e. only a BPS_DENOM/(BPS_DENOM+FEE_BPS) fraction of the input budget is "productive".
            return { gammaPpm: (BPS_DENOM * 1000000n) / (BPS_DENOM + FEE_BPS), muPpm: 1000000n };
        }
        // SELL: the fee is deducted from the gross OUTPUT.
        return { gammaPpm: 1000000n, muPpm: ((BPS_DENOM - FEE_BPS) * 1000000n) / BPS_DENOM };
    },
};
//# sourceMappingURL=index.js.map