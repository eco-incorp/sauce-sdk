/**
 * Aldrin AMM — two sibling Anchor programs off the classic spl-token-swap-
 * style constant-product curve (input-side trade fee + owner fee, both
 * floored with the standard "min 1 raw unit if the numerator is nonzero"
 * rule, then a ceiling-divided constant-product quote). SLUG `aldrin` = V1
 * (program `AMM55ShdkoGRB5jVYPjWziwk8m5MpwyDgsMWHaMSQWH6`, CP-only — the
 * on-chain account carries no curve-selector field at all). SLUG
 * `aldrin-v2` = V2 (program `CURVGoZn8zycx6FXwwevgBTB2gVvdbGTEpvMJDbgs2t4`),
 * whose pool account additionally carries a `curveType` byte (0 = the same
 * constant product, 1 = a StableSwap curve driven by an external `curve`
 * account) — measured live 2026-07-31 via `getProgramAccounts` filtered to
 * the 474-byte pool layout: 301 of 304 live pools are curveType 0, 3 are
 * curveType 1. This adapter implements CP for both programs and
 * SELF-DROPS a curveType-1 V2 pool (fetchPoolConfig throws a named error,
 * which the recipe's per-pool discovery gate turns into a drop, exactly
 * like every other family's out-of-scope gate) rather than approximating
 * the StableSwap curve with CP math.
 *
 * LAYOUT — not reverse-engineered, lifted from the published
 * `@aldrin_exchange/sdk` npm package (`pools/layout.ts`'s
 * `POOL_LAYOUT`/`POOL_V2_LAYOUT`, borsh via `@solana/buffer-layout`). Both
 * are Anchor accounts: the leading 8 bytes are
 * `sha256("account:Pool")[0..8]` = `f19a6d0411b16dbc` — byte-identical to
 * this repo's own `pumpswap` adapter's "Pool" discriminator (an Anchor
 * account discriminator is a function of the struct NAME alone, not the
 * program, so two unrelated programs both naming their pool struct "Pool"
 * collide on purpose). V1 span 441 bytes (21 live pools, ALL
 * discriminator-valid). V2 span 474 bytes (304 live pools at the dataSize
 * filter; 26 of those are all-zero/closed accounts that still match the
 * size — `fetchPoolConfig` gates on the discriminator byte-for-byte, not
 * merely on account length, so a closed pool self-drops instead of
 * decoding garbage).
 *
 * QUOTE MATH — ground-truthed against SIX REAL SETTLED MAINNET SWAPS (three
 * on a V1 pool, three on a V2 curveType=0 pool), not derived from the
 * published SDK's own client-side estimate (which is NOT usable ground
 * truth: `tokenSwap.ts`'s `resolveSwapInputs` applies NO fee at all to its
 * `CURVE.PRODUCT` estimate, and stubs `CURVE.STABLE` as
 * `minIncomeAmount = outcomeAmount` — not a real quote either way). Each of
 * the six was read via `getTransaction`'s `preTokenBalances`/
 * `postTokenBalances` at the pool's own two vault accounts (the vault
 * delta, not the trader's external float account, which in every sampled
 * tx was shared across other unrelated instructions in the same
 * searcher-bundled transaction and carried a few raw units of unrelated
 * noise): given the pool's pre-swap reserves and its own stored fee
 * fractions, the formula below reproduced the realized output EXACTLY in
 * all six cases, at sizes from ~5.35M to ~63.4M raw units. That formula is
 * BYTE-IDENTICAL to this repo's own `orca-legacy-token-swap` adapter's
 * `qOrca` — unsurprising, Aldrin's V1 program is a documented fork of the
 * same spl-token-swap lineage Orca's V2 program forked too.
 *
 * SWAP CPI — `SWAP_INSTRUCTION_LAYOUT` is
 * `[disc(8) global:swap][tokens u64 LE][minTokens u64 LE][side u8]`;
 * disc = `sha256("global:swap")[0..8]` = `f8c69e91e17587c8` (also lifted
 * from the SDK, confirmed byte-identical against the raw instruction data
 * of the same six validation transactions). `tokens` is the exact
 * specified INPUT regardless of side (all six real txs had a pool-vault
 * delta matching `tokens`, modulo the unrelated-instruction noise above).
 * `side` selects direction over a FIXED base/quote account order: Ask (1)
 * = base in / quote out (all six validation txs used this side), Bid (0) =
 * quote in / base out (the SDK's own `side: isInverted ? SIDE.ASK :
 * SIDE.BID` mapping in `tokenSwap.ts` — the reverse direction is untested
 * against a real transaction here, but the invariant is a symmetric CP
 * curve over a fixed account list with no other source of asymmetry, so
 * flipping which vault is read as the input reserve is the only change).
 * Venue-level min_out is always 1 — the recipe's post-swap outAta delta
 * check enforces the real bound, matching every other family.
 *
 * V1 swap accounts (10): pool, poolSigner, poolMint(w), baseVault(w),
 * quoteVault(w), feePoolTokenAccount(w), owner(signer),
 * userBaseTokenAccount(w), userQuoteTokenAccount(w), TOKEN_PROGRAM.
 * V2 (11) inserts `curve` (readonly, stored on the pool account — required
 * by the V2 program's account list even for a CP pool, though this adapter
 * never reads its contents). `poolSigner` is stored directly as a pubkey
 * FIELD on the pool account (unlike orca-legacy-token-swap's stored-bump
 * `create_program_address` dance) — no PDA derivation needed, the fetch
 * just reads it.
 *
 * CU — `CU_FAMILIES` in `../budget.ts` cites the measurement method (a
 * standalone LiteSVM real-binary-CPI harness against the same two real
 * mainnet pools this file's header validated, calibrated against this
 * repo's own pinned `orca-legacy-token-swap` baseline measured the same
 * way) rather than repeating it here.
 *
 * KNOWN, MEASURED, SAFE-DIRECTION QUIRK — the real program does not always
 * debit EXACTLY `tokens` from the user: a raw hand-built instruction (no
 * ecoswap-svm engine involved) against the SAME V1 pool this file validates,
 * at seven sizes from 10M to 1B raw units, measured the ACTUAL debit
 * (verified equal to the vault's own credit — both sides agree) falling 0
 * to 12 raw units SHORT of the requested `tokens`, NEVER over, and
 * non-monotone in size (1_000_000_000 -> short 1; 100_000_000 -> short 12;
 * 123_456_789 -> short 0) — not a simple proportional rounding term this
 * adapter can reproduce bit-exactly without Aldrin's own source. It does
 * NOT affect the predicted output (a <=12-unit shift in netIn against
 * multi-billion-unit reserves cannot move the floored CP quote — confirmed:
 * the realized output matched the prediction exactly at every size tested)
 * and is economically identical to the ordinary "partial fill" case
 * EcoSwapSvm already handles structurally on SVM (the un-entered input
 * simply never leaves the user's own `inAta` — there is no pot to
 * reconcile). `test/svm/ecoswap-svm.realcpi.e2e.test.ts`'s `aldrin`/
 * `aldrin-v2` cells assert this bound explicitly (`runQuad`'s `inputSlack`
 * parameter) rather than exact-debit equality, unlike every other family.
 */
import { address, getAddressDecoder } from '@solana/kit';
import { ceilDiv, readUintLE } from '../math.js';
export const ALDRIN_V1_PROGRAM_ID = address('AMM55ShdkoGRB5jVYPjWziwk8m5MpwyDgsMWHaMSQWH6');
export const ALDRIN_V2_PROGRAM_ID = address('CURVGoZn8zycx6FXwwevgBTB2gVvdbGTEpvMJDbgs2t4');
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/** sha256("account:Pool")[0..8] — shared with this repo's pumpswap adapter; see module header. */
const POOL_DISCRIMINATOR = [0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc];
/** sha256("global:swap")[0..8]. */
const SWAP_DISCRIMINATOR = Uint8Array.from([0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]);
const POOL_V1_SIZE = 441;
const POOL_V2_SIZE = 474;
// Offsets into POOL_FIELDS_COMMON (identical prefix on both versions).
const OFF_POOL_MINT = 40;
const OFF_BASE_VAULT = 72;
const OFF_BASE_MINT = 104;
const OFF_QUOTE_VAULT = 136;
const OFF_QUOTE_MINT = 168;
const OFF_POOL_SIGNER = 200;
const OFF_FEE_POOL_TOKEN_ACCOUNT = 361;
const OFF_TRADE_FEE_NUMERATOR = 393;
const OFF_TRADE_FEE_DENOMINATOR = 401;
const OFF_OWNER_FEE_NUMERATOR = 409;
const OFF_OWNER_FEE_DENOMINATOR = 417;
// V2-only trailer.
const OFF_CURVE_TYPE = 441;
const OFF_CURVE = 442;
const CURVE_TYPE_PRODUCT = 0;
function hasDiscriminator(data, discriminator) {
    return data.length >= discriminator.length && discriminator.every((byte, i) => data[i] === byte);
}
async function fetchAldrinPoolConfig(load, pool, version) {
    const slug = version === 1 ? 'aldrin' : 'aldrin-v2';
    const data = await load(pool);
    if (data === null)
        throw new Error(`${slug} pool ${pool} account not found`);
    const expectedSize = version === 1 ? POOL_V1_SIZE : POOL_V2_SIZE;
    if (data.length !== expectedSize) {
        throw new Error(`${slug} pool ${pool} data must be ${expectedSize} bytes, got ${data.length}`);
    }
    if (!hasDiscriminator(data, POOL_DISCRIMINATOR)) {
        throw new Error(`${slug} pool ${pool} is not an initialized Aldrin Pool account (bad Anchor discriminator)`);
    }
    if (version === 2) {
        const curveType = data[OFF_CURVE_TYPE];
        if (curveType !== CURVE_TYPE_PRODUCT) {
            throw new Error(`${slug} pool ${pool} curveType must be ${CURVE_TYPE_PRODUCT} (constant product), got ${curveType} — StableSwap curves are not implemented by this adapter`);
        }
    }
    const decoder = getAddressDecoder();
    const pubkeyAt = (offset) => decoder.decode(data.subarray(offset, offset + 32));
    const u64 = (offset) => readUintLE(data, offset, 8);
    const tradeFeeNumerator = u64(OFF_TRADE_FEE_NUMERATOR);
    const tradeFeeDenominator = u64(OFF_TRADE_FEE_DENOMINATOR);
    const ownerTradeFeeNumerator = u64(OFF_OWNER_FEE_NUMERATOR);
    const ownerTradeFeeDenominator = u64(OFF_OWNER_FEE_DENOMINATOR);
    for (const [name, numerator, denominator] of [
        ['trade', tradeFeeNumerator, tradeFeeDenominator],
        ['owner trade', ownerTradeFeeNumerator, ownerTradeFeeDenominator],
    ]) {
        if (numerator !== 0n && denominator === 0n) {
            throw new Error(`${slug} pool ${pool} ${name} fee denominator is 0 with nonzero numerator ${numerator}`);
        }
    }
    return {
        venue: slug,
        pool,
        version,
        poolMint: pubkeyAt(OFF_POOL_MINT),
        baseTokenVault: pubkeyAt(OFF_BASE_VAULT),
        baseTokenMint: pubkeyAt(OFF_BASE_MINT),
        quoteTokenVault: pubkeyAt(OFF_QUOTE_VAULT),
        quoteTokenMint: pubkeyAt(OFF_QUOTE_MINT),
        poolSigner: pubkeyAt(OFF_POOL_SIGNER),
        feePoolTokenAccount: pubkeyAt(OFF_FEE_POOL_TOKEN_ACCOUNT),
        tradeFeeNumerator,
        tradeFeeDenominator,
        ownerTradeFeeNumerator,
        ownerTradeFeeDenominator,
        curve: version === 2 ? pubkeyAt(OFF_CURVE) : undefined,
        direction: 'baseToQuote',
    };
}
export const aldrin = {
    slug: 'aldrin',
    programId: ALDRIN_V1_PROGRAM_ID,
    fetchPoolConfig: (load, pool) => fetchAldrinPoolConfig(load, pool, 1),
};
export const aldrinV2 = {
    slug: 'aldrin-v2',
    programId: ALDRIN_V2_PROGRAM_ID,
    fetchPoolConfig: (load, pool) => fetchAldrinPoolConfig(load, pool, 2),
};
// ---------------------------------------------------------------------------
// Ladder (fragment emission + reference mirror) — shared between V1/V2; the
// two exported ladders differ only in `version` (account count / program id).
// ---------------------------------------------------------------------------
function aldrinConfig(slug, base) {
    if (base.venue !== slug)
        throw new Error(`${slug} ladder adapter got a '${base.venue}' pool config`);
    return base;
}
const ref = (slot, role) => `s${slot}:${role}`;
/** (rin, rout) vault addresses for the cfg's current direction. */
function reserveVaults(cfg) {
    return cfg.direction === 'quoteToBase'
        ? { vin: cfg.quoteTokenVault, vout: cfg.baseTokenVault }
        : { vin: cfg.baseTokenVault, vout: cfg.quoteTokenVault };
}
function makeAldrinLadder(slug, version, programId) {
    const helperName = version === 1 ? 'qAldrinCp' : 'qAldrinV2Cp';
    return {
        slug,
        shapeKey(base) {
            const cfg = aldrinConfig(slug, base);
            return `${slug}:${cfg.direction}`;
        },
        // Standard spl-token-swap-lineage CP quote: floor-fee (min 1 raw unit
        // when the numerator is nonzero) on both the trade and owner fee legs,
        // then a ceiling-divided constant product — byte-identical to this
        // repo's orca-legacy-token-swap `qOrca` (see module header for the
        // real-transaction validation). A venue-rejected input (fees swallow x,
        // a drained pool) returns 0 instead of throwing, matching every other
        // ladder's dust convention.
        helpers() {
            return [
                {
                    name: helperName,
                    source: [
                        `function ${helperName}(x, rin, rout, tn, td, on, od) {`,
                        '  if (x === 0) { return 0 }',
                        '  if (rin === 0 || rout === 0) { return 0 }',
                        '  let tf = 0;',
                        '  if (tn > 0) { tf = x * tn / td; if (tf === 0) { tf = 1 } }',
                        '  let of = 0;',
                        '  if (on > 0) { of = x * on / od; if (of === 0) { of = 1 } }',
                        '  if (tf + of >= x) { return 0 }',
                        '  const net = x - tf - of;',
                        '  const ni = rin + net;',
                        '  const no = (rin * rout + ni - 1) / ni;',
                        '  if (no >= rout) { return 0 }',
                        '  return rout - no;',
                        '}',
                    ].join('\n'),
                },
            ];
        },
        /** Four params: trade fee numerator/denominator, owner fee numerator/denominator. */
        paramCount: 4,
        paramsFor(base) {
            const cfg = aldrinConfig(slug, base);
            return [cfg.tradeFeeNumerator, cfg.tradeFeeDenominator, cfg.ownerTradeFeeNumerator, cfg.ownerTradeFeeDenominator];
        },
        quoteRefs(base, slot) {
            const cfg = aldrinConfig(slug, base);
            const { vin, vout } = reserveVaults(cfg);
            return [
                { ref: ref(slot, 'vin'), address: vin },
                { ref: ref(slot, 'vout'), address: vout },
            ];
        },
        emitSetup(_base, slot, params) {
            return [
                `  const s${slot}rin = accountUint(${JSON.stringify(ref(slot, 'vin'))}, 64, 8);`,
                `  const s${slot}rout = accountUint(${JSON.stringify(ref(slot, 'vout'))}, 64, 8);`,
                `  const s${slot}tn = ${params[0]};`,
                `  const s${slot}td = ${params[1]};`,
                `  const s${slot}on = ${params[2]};`,
                `  const s${slot}od = ${params[3]};`,
            ].join('\n');
        },
        emitQuoteCall(_base, slot, x) {
            return `${helperName}(${x}, s${slot}rin, s${slot}rout, s${slot}tn, s${slot}td, s${slot}on, s${slot}od)`;
        },
        buildSwapV2(base, slot, user) {
            const cfg = aldrinConfig(slug, base);
            const isQuoteToBase = cfg.direction === 'quoteToBase';
            // side: Ask(1) = base in / quote out (the six validated real txs), Bid(0)
            // = quote in / base out — see module header. userBaseTokenAccount /
            // userQuoteTokenAccount stay in this FIXED order regardless of side.
            const side = isQuoteToBase ? 0 : 1;
            const roled = (role, addr, writable) => writable ? { ref: ref(slot, role), address: addr, writable: true } : { ref: ref(slot, role), address: addr };
            const userBaseAccount = isQuoteToBase ? { ref: user.outAta, writable: true } : { ref: user.inAta, writable: true };
            const userQuoteAccount = isQuoteToBase ? { ref: user.inAta, writable: true } : { ref: user.outAta, writable: true };
            const accounts = [
                roled('pool', cfg.pool),
                roled('signer', cfg.poolSigner),
                roled('poolMint', cfg.poolMint, true),
                roled('baseVault', cfg.baseTokenVault, true),
                roled('quoteVault', cfg.quoteTokenVault, true),
                roled('feeAcct', cfg.feePoolTokenAccount, true),
                { ref: user.owner, signer: true },
                userBaseAccount,
                userQuoteAccount,
                ...(version === 2 ? [roled('curve', cfg.curve)] : []),
                roled('tokenProgram', TOKEN_PROGRAM),
            ];
            return {
                programId,
                prefix: SWAP_DISCRIMINATOR,
                // minTokens u64 LE = 1 (the recipe's own outAta delta check is the
                // real bound) ++ side u8.
                suffix: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, side]),
                patch: 'in',
                accounts,
            };
        },
        referenceQuote(base, state, params) {
            const cfg = aldrinConfig(slug, base);
            const bytes = (addr) => {
                const data = state[addr];
                if (data === undefined)
                    throw new Error(`${slug} ladder reference is missing account ${addr}`);
                return data;
            };
            const { vin, vout } = reserveVaults(cfg);
            const rin = readUintLE(bytes(vin), 64, 8);
            const rout = readUintLE(bytes(vout), 64, 8);
            const [tn, td, on, od] = params;
            return (x) => {
                if (x === 0n)
                    return 0n;
                if (rin === 0n || rout === 0n)
                    return 0n;
                let tf = 0n;
                if (tn > 0n) {
                    tf = (x * tn) / td;
                    if (tf === 0n)
                        tf = 1n;
                }
                let of = 0n;
                if (on > 0n) {
                    of = (x * on) / od;
                    if (of === 0n)
                        of = 1n;
                }
                if (tf + of >= x)
                    return 0n;
                const net = x - tf - of;
                const ni = rin + net;
                const no = ceilDiv(rin * rout, ni);
                if (no >= rout)
                    return 0n;
                return rout - no;
            };
        },
        depthReserves(base, state) {
            const cfg = aldrinConfig(slug, base);
            const bytes = (addr) => {
                const data = state[addr];
                if (data === undefined)
                    throw new Error(`${slug} ladder depth is missing account ${addr}`);
                return data;
            };
            const { vin, vout } = reserveVaults(cfg);
            return {
                reserveIn: readUintLE(bytes(vin), 64, 8),
                reserveOut: readUintLE(bytes(vout), 64, 8),
            };
        },
        continuousFees(_base, _state, params) {
            const [tn, td, on, od] = params;
            let gamma = 1000000n;
            if (tn > 0n)
                gamma -= (tn * 1000000n) / td;
            if (on > 0n)
                gamma -= (on * 1000000n) / od;
            return { gammaPpm: gamma, muPpm: 1000000n };
        },
    };
}
export const aldrinLadder = makeAldrinLadder('aldrin', 1, ALDRIN_V1_PROGRAM_ID);
export const aldrinV2Ladder = makeAldrinLadder('aldrin-v2', 2, ALDRIN_V2_PROGRAM_ID);
//# sourceMappingURL=index.js.map